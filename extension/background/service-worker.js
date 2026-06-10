import { VaultAPI } from './api.js';
import { SessionManager } from './session.js';
import {
  STORAGE_KEY_AUTOFILL_ENABLED,
  STORAGE_KEY_EMAIL_SUGGESTIONS,
  STORAGE_KEY_LAST_SELECTED_CREDENTIALS,
  STORAGE_KEY_PENDING_CREDENTIALS,
  STORAGE_KEY_PENDING_USERNAMES,
  STORAGE_KEY_SERVER_URL,
} from '../lib/constants.js';

const api = new VaultAPI();
const session = new SessionManager(api);
const faviconCache = new Map();
let pendingCredentials = null;
const PENDING_CREDENTIALS_TTL_MS = 5 * 60 * 1000;
const PENDING_USERNAME_TTL_MS = 10 * 60 * 1000;
const LAST_SELECTED_CREDENTIALS_MAX_RECORDS = 100;
const MAX_VISIBLE_EMAIL_SUGGESTIONS = 8;
const CONTENT_SCRIPT_FILES = [
  'content/heuristics.js',
  'content/overlay.js',
  'content/detector.js',
];
const CONTENT_STYLE_FILES = ['content/overlay.css'];
const AUTH_REQUIRED_TYPES = new Set([
  'LIST_ENTRIES',
  'GET_ENTRY',
  'CREATE_ENTRY',
  'UPDATE_ENTRY',
  'DELETE_ENTRY',
  'LIST_VAULT_ITEMS',
  'CREATE_VAULT_ITEM',
  'UPDATE_VAULT_ITEM',
  'DELETE_VAULT_ITEM',
  'EXPORT_VAULT',
  'GENERATE_PASSWORD',
  'CHECK_CREDENTIALS',
  'GET_CREDENTIAL_FOR_FILL',
  'GET_CREDENTIAL_FOR_AUTOFILL',
  'REMEMBER_SELECTED_CREDENTIAL',
  'FORM_SUBMITTED',
  'CHECK_PENDING_CREDENTIALS',
  'GET_FAVICON',
  'BULK_IMPORT',
  'CHANGE_PASSWORD',
]);
const CONTENT_SAFE_MESSAGE_TYPES = new Set([
  'CHECK_CREDENTIALS',
  'GET_CREDENTIAL_FOR_FILL',
  'GET_CREDENTIAL_FOR_AUTOFILL',
  'GET_EMAIL_SUGGESTIONS',
  'PENDING_USERNAME',
  'GET_PENDING_USERNAME',
  'CLEAR_PENDING_USERNAME',
  'REMEMBER_SELECTED_CREDENTIAL',
  'PENDING_CREDENTIALS',
  'CHECK_PENDING_CREDENTIALS',
  'CLEAR_PENDING_CREDENTIALS',
  'FORM_SUBMITTED',
  'GENERATE_PASSWORD',
]);

const startupReady = initializeServiceWorker();

async function initializeServiceWorker() {
  try {
    await restrictLocalStorageAccess();
    const token = await session.loadToken();
    if (!token) {
      await clearAllPendingState();
    }
  } finally {
    session.setupIdleDetection();
  }
}

async function restrictLocalStorageAccess() {
  try {
    if (typeof chrome.storage.local.setAccessLevel === 'function') {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
    if (typeof chrome.storage.session?.setAccessLevel === 'function') {
      await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    }
  } catch {
    // Older browsers may not support storage access levels.
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY_SERVER_URL]) {
    return;
  }

  handleServerUrlChange().catch(() => {
    api.clearToken();
  });
});

async function handleServerUrlChange() {
  api.invalidateServerUrlCache();
  faviconCache.clear();
  session.clearCache();
  await session.clearToken();
  await clearAllPendingState();
}

// Auto-lock alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-lock') {
    await session.lock();
    faviconCache.clear();
    await clearAllPendingState();
  }
});

// Message handler for popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const response = await handleMessage(message, sender);
      sendResponse(response);
    } catch (err) {
      const handled = await normalizeAndHandleError(message?.type, err);
      sendResponse({ error: handled.message, code: handled.code });
    }
  })();
  return true; // Keep channel open for async response
});

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function parseEmailSuggestions(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,;]+/)
      : [];
  const seen = new Set();
  const suggestions = [];

  for (const item of raw) {
    const email = normalizeEmail(item);
    if (!email || !isValidEmail(email) || seen.has(email)) continue;
    seen.add(email);
    suggestions.push(email);
  }

  return suggestions;
}

function mergeEmailLists(...lists) {
  const merged = [];
  const seen = new Set();

  for (const list of lists) {
    for (const email of list) {
      const normalized = normalizeEmail(email);
      if (!normalized || !isValidEmail(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
  }

  return merged;
}

async function getKnownEmailUsernamesFromVault() {
  if (!(await session.isUnlocked())) {
    return [];
  }

  try {
    const entries = await api.listEntries();
    return mergeEmailLists(entries.map((entry) => entry.username));
  } catch (err) {
    if (err?.code === 'AUTH_ERROR') {
      await session.forceLocalLock();
      faviconCache.clear();
      await clearAllPendingState();
    }
    return [];
  }
}

async function hasSavedCredentialsForPage(pageUrl) {
  if (!isCredentialPageAllowed(pageUrl)) {
    return false;
  }

  if (!(await session.isUnlocked())) {
    return true;
  }

  const domain = getDomainFromUrl(pageUrl);
  if (!domain) {
    return false;
  }

  try {
    const entries = await session.getCredentialsForDomain(domain);
    return entries.some((entry) => isCredentialAllowedForPage(entry, pageUrl));
  } catch (err) {
    if (err?.code === 'AUTH_ERROR') {
      await session.forceLocalLock();
      faviconCache.clear();
      await clearAllPendingState();
    }
    return true;
  }
}

async function getEmailSuggestionsForPage(pageUrl) {
  if (!isCredentialPageAllowed(pageUrl)) {
    return [];
  }

  if (await hasSavedCredentialsForPage(pageUrl)) {
    return [];
  }

  const result = await chrome.storage.local.get(STORAGE_KEY_EMAIL_SUGGESTIONS);
  const manualSuggestions = parseEmailSuggestions(result[STORAGE_KEY_EMAIL_SUGGESTIONS]);
  const vaultSuggestions = await getKnownEmailUsernamesFromVault();

  return mergeEmailLists(manualSuggestions, vaultSuggestions)
    .slice(0, MAX_VISIBLE_EMAIL_SUGGESTIONS);
}

async function isAutofillEnabled() {
  const result = await chrome.storage.local.get(STORAGE_KEY_AUTOFILL_ENABLED);
  return result[STORAGE_KEY_AUTOFILL_ENABLED] === true;
}

async function readLastSelectedCredentials() {
  const result = await chrome.storage.local.get(STORAGE_KEY_LAST_SELECTED_CREDENTIALS);
  const raw = result[STORAGE_KEY_LAST_SELECTED_CREDENTIALS];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

async function writeLastSelectedCredentials(records) {
  const entries = Object.entries(records)
    .filter(([domain, record]) => (
      normalizeDomain(domain) &&
      record &&
      typeof record === 'object' &&
      String(record.id || '').trim()
    ))
    .sort(([, a], [, b]) => (Number(b.selectedAt) || 0) - (Number(a.selectedAt) || 0))
    .slice(0, LAST_SELECTED_CREDENTIALS_MAX_RECORDS);

  await chrome.storage.local.set({
    [STORAGE_KEY_LAST_SELECTED_CREDENTIALS]: Object.fromEntries(entries),
  });
}

async function getLastSelectedCredential(domain) {
  const cleanDomain = stripCommonWwwPrefix(domain);
  if (!cleanDomain) return null;

  const records = await readLastSelectedCredentials();
  const record = records[cleanDomain];
  if (!record || typeof record !== 'object' || !String(record.id || '').trim()) {
    return null;
  }

  return {
    id: String(record.id),
    username: String(record.username || ''),
    selectedAt: Number(record.selectedAt) || 0,
  };
}

async function rememberSelectedCredentialForPage(payload, sender) {
  if (!(await session.isUnlocked())) {
    return false;
  }

  const pageUrl = getMessagePageUrl(payload, sender);
  if (!isCredentialPageAllowed(pageUrl)) {
    return false;
  }

  const domain = getDomainFromUrl(pageUrl);
  const selectionDomain = stripCommonWwwPrefix(domain);
  const selectedId = String(payload?.id || '').trim();
  if (!domain || !selectionDomain || !selectedId) {
    return false;
  }

  const entries = await session.getCredentialsForDomain(domain);
  const entry = entries.find((item) => String(item.id) === selectedId);
  if (!entry || !isCredentialAllowedForPage(entry, pageUrl)) {
    return false;
  }

  const records = await readLastSelectedCredentials();
  records[selectionDomain] = {
    id: String(entry.id),
    username: String(entry.username || ''),
    website_url: String(entry.website_url || ''),
    selectedAt: Date.now(),
  };
  await writeLastSelectedCredentials(records);
  return true;
}

function rankCredentialForFill(credential, preferredUsername, lastSelectedCredential) {
  if (preferredUsername && normalizeUsername(credential.username) === preferredUsername) {
    return 0;
  }

  if (!preferredUsername && lastSelectedCredential?.id && String(credential.id) === lastSelectedCredential.id) {
    return 0;
  }

  return 1;
}

function sortCredentialsForFill(credentials, preferredUsername, lastSelectedCredential) {
  return credentials
    .map((credential, index) => ({ credential, index }))
    .sort((a, b) => {
      const aRank = rankCredentialForFill(a.credential, preferredUsername, lastSelectedCredential);
      const bRank = rankCredentialForFill(b.credential, preferredUsername, lastSelectedCredential);
      return (aRank - bRank) || (a.index - b.index);
    })
    .map((item) => item.credential);
}

async function getCredentialForPageById(id, pageUrl) {
  const domain = getDomainFromUrl(pageUrl);
  if (!domain || !id) {
    return null;
  }

  const entries = await session.getCredentialsForDomain(domain);
  const entry = entries.find((item) => String(item.id) === String(id));
  if (!entry || !isCredentialAllowedForPage(entry, pageUrl)) {
    return null;
  }

  const detail = await api.getEntry(entry.id);
  if (!isCredentialAllowedForPage(detail, pageUrl)) {
    return null;
  }

  return {
    id: detail.id,
    username: detail.username,
    password: detail.password,
    website_url: detail.website_url,
  };
}

async function sendTabMessage(tabId, message) {
  return await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, { frameId: 0 }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

async function runDetectorRefreshInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        if (typeof YurrrDetector !== 'undefined' && YurrrDetector?.refresh) {
          YurrrDetector.refresh();
          return true;
        }
        if (
          typeof YurrrDetector !== 'undefined' &&
          YurrrDetector?.tryAutoFill &&
          typeof YurrrHeuristics !== 'undefined'
        ) {
          const fillChecks = [];
          const passwordFields = document.querySelectorAll('input[type="password"]');
          for (const passwordField of passwordFields) {
            const form = passwordField.closest('form');
            if (YurrrHeuristics.isRegistrationForm?.(form)) continue;
            if (YurrrHeuristics.isPasswordChangeForm?.(form)) {
              const currentPasswordField = YurrrHeuristics.findCurrentPasswordField?.(form);
              if (currentPasswordField && passwordField !== currentPasswordField) continue;
            }
            fillChecks.push(
              YurrrDetector.tryAutoFill(
                YurrrHeuristics.findUsernameField?.(passwordField) || null,
                passwordField,
                { allowAutofill: true },
              )
            );
          }

          await Promise.allSettled(fillChecks);
          return fillChecks.length > 0;
        }
        return false;
      },
    });
    return results.some((result) => result?.result === true);
  } catch {
    return false;
  }
}

async function injectContentScriptsIntoTab(tabId) {
  for (const file of CONTENT_STYLE_FILES) {
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: [file],
      });
    } catch {
      // CSS may already be present or the frame may reject injection.
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES,
  });
}

async function refreshActiveTabContentScripts() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !isCredentialPageAllowed(tab.url || '')) {
    return { refreshed: false, reason: 'unsupported_url' };
  }

  const ping = await sendTabMessage(tab.id, { type: 'YURRR_REFRESH_FORMS' });
  if (ping?.ok) {
    return { refreshed: true, injected: false };
  }

  if (await runDetectorRefreshInTab(tab.id)) {
    return { refreshed: true, injected: false };
  }

  try {
    await injectContentScriptsIntoTab(tab.id);
  } catch (err) {
    return {
      refreshed: false,
      injected: false,
      reason: err?.message || 'content_script_injection_failed',
    };
  }

  const refreshed = await sendTabMessage(tab.id, { type: 'YURRR_REFRESH_FORMS' });
  return { refreshed: Boolean(refreshed?.ok), injected: true };
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeVaultItemType(value) {
  const itemType = String(value || '').trim().toLowerCase();
  if (itemType !== 'card' && itemType !== 'address' && itemType !== 'passkey') {
    throw new Error('Invalid vault item type');
  }
  return itemType;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseUrlWithDefaultScheme(value) {
  const direct = parseUrl(value);
  if (direct) return direct;

  const normalized = String(value || '').trim();
  if (!normalized) return null;
  return parseUrl(`https://${normalized}`);
}

function normalizeHostname(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function isPrivateIPv4(hostname) {
  const parts = normalizeHostname(hostname).split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number.parseInt(part, 10));
  if (nums.some((num, idx) => !Number.isInteger(num) || String(num) !== parts[idx] || num < 0 || num > 255)) {
    return false;
  }

  return (
    nums[0] === 10 ||
    nums[0] === 127 ||
    (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) ||
    (nums[0] === 192 && nums[1] === 168) ||
    (nums[0] === 169 && nums[1] === 254)
  );
}

function isPrivateIPv6(hostname) {
  const host = normalizeHostname(hostname);
  return (
    host === '::1' ||
    /^f[cd][0-9a-f]*:/i.test(host) ||
    /^fe80:/i.test(host)
  );
}

function isHttpDevHost(hostname) {
  const host = normalizeHostname(hostname);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isPrivateIPv4(host) ||
    isPrivateIPv6(host)
  );
}

function isCredentialPageAllowed(pageUrl) {
  const url = parseUrl(pageUrl);
  if (!url) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isHttpDevHost(url.hostname);
  return false;
}

function stripCommonWwwPrefix(hostname) {
  const host = normalizeHostname(hostname);
  return host.startsWith('www.') ? host.slice(4) : host;
}

function isSameCredentialHost(pageHost, credentialHost) {
  const page = normalizeHostname(pageHost);
  const credential = normalizeHostname(credentialHost);
  if (!page || !credential) return false;
  return page === credential || stripCommonWwwPrefix(page) === stripCommonWwwPrefix(credential);
}

function getCredentialHost(credential) {
  const credentialUrl = parseUrlWithDefaultScheme(credential?.website_url);
  return normalizeHostname(credentialUrl?.hostname || credential?.website_domain || '');
}

function isCredentialAllowedForPage(credential, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page || !isCredentialPageAllowed(page.href)) return false;

  const credentialHost = getCredentialHost(credential);
  if (!isSameCredentialHost(page.hostname, credentialHost)) {
    return false;
  }

  const credentialUrl = parseUrlWithDefaultScheme(credential?.website_url);
  if (page.protocol === 'http:' && credentialUrl?.protocol === 'https:') {
    return false;
  }

  return true;
}

function getExtensionOrigin() {
  return parseUrl(chrome.runtime.getURL(''))?.origin || '';
}

function isExtensionPageSender(sender) {
  if (sender?.id === chrome.runtime.id && !sender?.tab) {
    return true;
  }

  const senderUrl = parseUrl(sender?.url || sender?.origin || '');
  return Boolean(senderUrl && senderUrl.origin === getExtensionOrigin());
}

function isContentScriptSender(sender) {
  if (isExtensionPageSender(sender)) return false;
  const senderUrl = parseUrl(sender?.url || '');
  return Boolean(sender?.tab && senderUrl && (senderUrl.protocol === 'http:' || senderUrl.protocol === 'https:'));
}

function assertMessageAllowed(type, sender) {
  if (!type || typeof type !== 'string') {
    throw new Error('Missing message type');
  }

  if (isExtensionPageSender(sender)) {
    return;
  }

  if (isContentScriptSender(sender) && CONTENT_SAFE_MESSAGE_TYPES.has(type)) {
    return;
  }

  const error = new Error('Message type not allowed from this sender');
  error.code = 'FORBIDDEN';
  throw error;
}

function getMessagePageUrl(payload, sender) {
  if (isContentScriptSender(sender)) {
    return sender?.url || '';
  }

  return sender?.url || sender?.tab?.url || payload?.pageUrl || payload?.url || '';
}

function getDomainFromUrl(url, fallback = '') {
  const parsed = parseUrl(url);
  return normalizeDomain(parsed?.hostname || fallback);
}

function getSenderFrameKey(sender) {
  const tabId = sender?.tab?.id;
  const frameId = Number.isInteger(sender?.frameId) ? sender.frameId : 0;
  if (!Number.isInteger(tabId)) {
    return null;
  }

  return `${tabId}:${frameId}`;
}

function getSafeCredentialUrlForPage(candidateUrl, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page || !isCredentialPageAllowed(page.href)) {
    return '';
  }

  const candidate = parseUrl(candidateUrl);
  if (
    candidate &&
    isCredentialPageAllowed(candidate.href) &&
    isSameCredentialHost(page.hostname, candidate.hostname)
  ) {
    return candidate.href;
  }

  return page.href;
}

async function writePendingUsernames(usernames) {
  if (Object.keys(usernames).length === 0) {
    await chrome.storage.session.remove(STORAGE_KEY_PENDING_USERNAMES);
    return;
  }

  await chrome.storage.session.set({ [STORAGE_KEY_PENDING_USERNAMES]: usernames });
}

async function readPendingUsernames() {
  const result = await chrome.storage.session.get(STORAGE_KEY_PENDING_USERNAMES);
  const raw = result[STORAGE_KEY_PENDING_USERNAMES];
  const rawIsObject = raw && typeof raw === 'object' && !Array.isArray(raw);
  const usernames = rawIsObject ? { ...raw } : {};
  const now = Date.now();
  let changed = Boolean(raw) && !rawIsObject;

  for (const [domain, value] of Object.entries(usernames)) {
    if (
      !value ||
      typeof value !== 'object' ||
      typeof value.expiresAt !== 'number' ||
      value.expiresAt <= now ||
      !String(value.username || '').trim()
    ) {
      delete usernames[domain];
      changed = true;
    }
  }

  if (changed) {
    await writePendingUsernames(usernames);
  }

  return usernames;
}

async function setPendingUsername(domain, url, username) {
  const cleanDomain = normalizeDomain(domain);
  const cleanUsername = String(username || '').trim();
  if (!cleanDomain || !cleanUsername) return false;

  const usernames = await readPendingUsernames();
  usernames[cleanDomain] = {
    username: cleanUsername,
    url: url || null,
    expiresAt: Date.now() + PENDING_USERNAME_TTL_MS,
  };
  await writePendingUsernames(usernames);
  return true;
}

async function getPendingUsername(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return '';

  const usernames = await readPendingUsernames();
  return usernames[cleanDomain]?.username || '';
}

async function clearPendingUsername(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return;

  const usernames = await readPendingUsernames();
  if (!usernames[cleanDomain]) return;
  delete usernames[cleanDomain];
  await writePendingUsernames(usernames);
}

async function setPendingCredentials(payload, sender) {
  const domain = getDomainFromUrl(payload?.url);
  const password = String(payload?.password || '');
  if (!domain || !password) return false;

  pendingCredentials = {
    url: payload.url,
    domain,
    username: String(payload.username || '').trim(),
    password,
    pageUrl: payload.pageUrl || payload.url || '',
    promptReady: payload.promptReady === true,
    frameKey: getSenderFrameKey(sender),
    expiresAt: Date.now() + PENDING_CREDENTIALS_TTL_MS,
  };
  return true;
}

async function getPendingCredentials(domain, sender = null) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return null;

  const pending = pendingCredentials;
  if (!pending || typeof pending !== 'object') return null;

  if (typeof pending.expiresAt !== 'number' || pending.expiresAt <= Date.now()) {
    pendingCredentials = null;
    return null;
  }

  if (normalizeDomain(pending.domain) !== cleanDomain) {
    return null;
  }

  const frameKey = getSenderFrameKey(sender);
  if (pending.frameKey && frameKey && pending.frameKey !== frameKey) {
    return null;
  }

  return pending;
}

function pendingCredentialMatchesSubmission(pending, pageUrl, password) {
  if (!pending || !password) return false;
  if (!isCredentialAllowedForPage({ website_url: pending.url }, pageUrl)) return false;
  return String(pending.password || '') === String(password || '');
}

async function compareExistingCredentialPassword(entry, pageUrl, password) {
  const detail = await api.getEntry(entry.id);
  if (!isCredentialAllowedForPage(detail, pageUrl)) {
    return { action: 'missing_username' };
  }

  if (String(detail.password || '') === String(password || '')) {
    return {
      action: 'unchanged',
      entryId: detail.id,
      username: detail.username || entry.username || '',
    };
  }

  return {
    action: 'update',
    entryId: detail.id,
    username: detail.username || entry.username || '',
  };
}

async function getCredentialSaveDecision(existing, pageUrl, username, password) {
  const normalizedUsername = normalizeUsername(username);
  const candidates = existing.filter((entry) => isCredentialAllowedForPage(entry, pageUrl));

  if (normalizedUsername) {
    const match = candidates.find((entry) => normalizeUsername(entry.username) === normalizedUsername);
    if (!match) {
      return { action: 'create' };
    }

    return await compareExistingCredentialPassword(match, pageUrl, password);
  }

  if (candidates.length === 1) {
    return await compareExistingCredentialPassword(candidates[0], pageUrl, password);
  }

  return { action: 'missing_username' };
}

function buildSavePromptMessage(decision, domain, username) {
  if (decision.action === 'update') {
    return `Update saved password for ${username || domain}?`;
  }

  return `Save password for ${domain}?`;
}

async function clearPendingCredentials() {
  pendingCredentials = null;
  await chrome.storage.session.remove(STORAGE_KEY_PENDING_CREDENTIALS);
}

async function clearAllPendingState() {
  pendingCredentials = null;
  await chrome.storage.session.remove([
    STORAGE_KEY_PENDING_CREDENTIALS,
    STORAGE_KEY_PENDING_USERNAMES,
  ]);
}

async function normalizeAndHandleError(messageType, err) {
  const error = err instanceof Error ? err : new Error(String(err || 'Unknown error'));
  const code = error.code || '';
  const isAuthRequired = AUTH_REQUIRED_TYPES.has(messageType);

  if (isAuthRequired && code === 'AUTH_ERROR') {
    await session.forceLocalLock();
    faviconCache.clear();
    await clearAllPendingState();
    return {
      code: 'SESSION_LOST',
      message: 'Session expired. Please log in again.',
    };
  }

  if (isAuthRequired && code === 'NETWORK_ERROR') {
    return {
      code: 'NETWORK_ERROR',
      message: 'Network disconnected. Try again when the server is reachable.',
    };
  }

  return {
    code: code || 'UNKNOWN_ERROR',
    message: error.message || 'Unknown error',
  };
}

async function handleMessage(message, sender) {
  await startupReady;

  const { type, payload = {} } = message || {};
  assertMessageAllowed(type, sender);

  switch (type) {
    case 'GET_STATUS':
      return await api.getStatus();

    case 'SETUP': {
      const result = await api.setup(payload.masterPassword);
      return result;
    }

    case 'LOGIN': {
      const data = await api.login(payload.masterPassword, {
        neverAutoLock: await session.isNeverAutoLockMode(),
      });
      await session.saveToken(data.token);
      await session.resetAutoLock();
      return { success: true };
    }

    case 'LOGOUT':
      await session.lock();
      faviconCache.clear();
      await clearAllPendingState();
      return { success: true };

    case 'IS_UNLOCKED': {
      if (!(await session.isUnlocked())) {
        await clearAllPendingState();
        return { unlocked: false };
      }

      try {
        await api.validateSession();
        await session.resetAutoLock();
        return { unlocked: true, reachable: true };
      } catch (err) {
        if (err?.code === 'AUTH_ERROR') {
          await session.forceLocalLock();
          faviconCache.clear();
          await clearAllPendingState();
          return { unlocked: false, reason: 'session_invalid' };
        }

        if (err?.code === 'NETWORK_ERROR') {
          return { unlocked: true, reachable: false, reason: 'network' };
        }

        throw err;
      }
    }

    case 'REFRESH_ACTIVE_TAB':
      return await refreshActiveTabContentScripts();

    case 'LIST_ENTRIES': {
      await session.resetAutoLock();
      return await api.listEntries(payload?.domain);
    }

    case 'GET_ENTRY': {
      await session.resetAutoLock();
      return await api.getEntry(payload.id);
    }

    case 'CREATE_ENTRY': {
      await session.resetAutoLock();
      session.clearCache();
      return await api.createEntry(payload);
    }

    case 'UPDATE_ENTRY': {
      await session.resetAutoLock();
      session.clearCache();
      return await api.updateEntry(payload.id, payload.data);
    }

    case 'DELETE_ENTRY': {
      await session.resetAutoLock();
      session.clearCache();
      return await api.deleteEntry(payload.id);
    }

    case 'LIST_VAULT_ITEMS': {
      await session.resetAutoLock();
      return await api.listVaultItems(normalizeVaultItemType(payload.itemType || payload.type));
    }

    case 'CREATE_VAULT_ITEM': {
      await session.resetAutoLock();
      return await api.createVaultItem(
        normalizeVaultItemType(payload.itemType || payload.item_type || payload.type),
        payload.payload || {}
      );
    }

    case 'UPDATE_VAULT_ITEM': {
      if (!payload.id) {
        throw new Error('Missing vault item id');
      }
      await session.resetAutoLock();
      return await api.updateVaultItem(payload.id, payload.payload || {});
    }

    case 'DELETE_VAULT_ITEM': {
      if (!payload.id) {
        throw new Error('Missing vault item id');
      }
      await session.resetAutoLock();
      return await api.deleteVaultItem(payload.id);
    }

    case 'EXPORT_VAULT': {
      if (!payload.masterPassword) {
        throw new Error('Master password is required for decrypted export');
      }
      await session.resetAutoLock();
      return await api.exportVault(payload.masterPassword);
    }

    case 'GENERATE_PASSWORD': {
      await session.resetAutoLock();
      return await api.generatePassword(payload);
    }

    case 'CHECK_CREDENTIALS': {
      if (!(await session.isUnlocked())) {
        return { credentials: [] };
      }

      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { credentials: [] };
      }

      const domain = getDomainFromUrl(pageUrl);
      if (!domain) {
        return { credentials: [] };
      }

      const entries = await session.getCredentialsForDomain(domain);
      const credentials = entries
        .filter((entry) => isCredentialAllowedForPage(entry, pageUrl))
        .map((entry) => ({
          id: entry.id,
          username: entry.username,
          website_url: entry.website_url,
        }));

      const preferredUsername = normalizeUsername(payload?.preferredUsername || await getPendingUsername(domain));
      const lastSelectedCredential = await getLastSelectedCredential(domain);
      return {
        credentials: sortCredentialsForFill(credentials, preferredUsername, lastSelectedCredential),
        lastSelectedCredentialId: lastSelectedCredential?.id || null,
      };
    }

    case 'GET_CREDENTIAL_FOR_FILL': {
      if (!(await session.isUnlocked())) {
        return { credential: null };
      }

      const pageUrl = getMessagePageUrl(payload, sender);
      if (payload?.userGesture !== true || !isCredentialPageAllowed(pageUrl)) {
        return { credential: null };
      }

      const domain = getDomainFromUrl(pageUrl);
      if (!domain || !payload.id) {
        return { credential: null };
      }

      await session.resetAutoLock();
      return { credential: await getCredentialForPageById(payload.id, pageUrl) };
    }

    case 'GET_CREDENTIAL_FOR_AUTOFILL': {
      if (!(await session.isUnlocked()) || !(await isAutofillEnabled())) {
        return { credential: null };
      }

      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl) || !payload.id) {
        return { credential: null };
      }

      return { credential: await getCredentialForPageById(payload.id, pageUrl) };
    }

    case 'GET_EMAIL_SUGGESTIONS': {
      const pageUrl = getMessagePageUrl(payload, sender);
      const emails = await getEmailSuggestionsForPage(pageUrl);
      return { emails };
    }

    case 'REMEMBER_SELECTED_CREDENTIAL':
      return { stored: await rememberSelectedCredentialForPage(payload, sender) };

    case 'PENDING_USERNAME': {
      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { stored: false };
      }
      const domain = getDomainFromUrl(pageUrl);
      const url = getSafeCredentialUrlForPage(payload.url, pageUrl);
      return { stored: await setPendingUsername(domain, url, payload.username) };
    }

    case 'GET_PENDING_USERNAME': {
      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { username: '' };
      }
      const domain = getDomainFromUrl(pageUrl);
      return { username: await getPendingUsername(domain) };
    }

    case 'CLEAR_PENDING_USERNAME': {
      const pageUrl = getMessagePageUrl(payload, sender);
      if (isContentScriptSender(sender)) {
        if (!isCredentialPageAllowed(pageUrl)) {
          return { cleared: false };
        }
        await clearPendingUsername(getDomainFromUrl(pageUrl));
        return { cleared: true };
      }

      const domain = normalizeDomain(payload?.domain);
      await clearPendingUsername(domain);
      return { cleared: true };
    }

    case 'PENDING_CREDENTIALS': {
      if (!(await session.isUnlocked())) {
        return { stored: false };
      }

      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { stored: false };
      }

      const credentialUrl = getSafeCredentialUrlForPage(payload.url, pageUrl);
      const domain = getDomainFromUrl(pageUrl);
      const username = payload.username || await getPendingUsername(domain) || '';
      return {
        stored: await setPendingCredentials(
          {
            ...payload,
            url: credentialUrl,
            domain,
            username,
          },
          sender
        ),
      };
    }

    case 'CHECK_PENDING_CREDENTIALS': {
      if (!(await session.isUnlocked())) {
        return { hasPending: false };
      }

      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { hasPending: false };
      }

      const domain = getDomainFromUrl(pageUrl);
      const pending = await getPendingCredentials(domain, sender);
      if (!pending || !isCredentialAllowedForPage({ website_url: pending.url }, pageUrl)) {
        return { hasPending: false };
      }

      if (pending.promptReady !== true && pending.pageUrl === pageUrl) {
        return { hasPending: false };
      }

      await session.resetAutoLock();
      const username = pending.username || await getPendingUsername(domain) || '';
      const existing = await api.listEntries(domain);
      const decision = await getCredentialSaveDecision(existing, pageUrl, username, pending.password);

      if (decision.action === 'unchanged' || decision.action === 'missing_username') {
        await clearPendingUsername(domain);
        await clearPendingCredentials();
        return {
          hasPending: false,
          reason: decision.action,
        };
      }

      return {
        hasPending: true,
        credentials: {
          url: pending.url,
          domain: pending.domain,
          username,
          password: pending.password,
          action: decision.action === 'update' ? 'update' : 'save',
          entryId: decision.entryId || null,
          message: buildSavePromptMessage(decision, pending.domain || domain, decision.username || username),
        },
      };
    }

    case 'CLEAR_PENDING_CREDENTIALS': {
      await clearPendingCredentials();
      return { cleared: true };
    }

    case 'FORM_SUBMITTED': {
      if (!(await session.isUnlocked())) {
        return { saved: false };
      }

      const { username } = payload;
      const password = String(payload.password || '');
      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { saved: false };
      }
      if (!password) {
        return {
          saved: false,
          reason: 'missing_password',
          message: 'No password was detected to save.',
        };
      }

      await session.resetAutoLock();
      const url = getSafeCredentialUrlForPage(payload.url, pageUrl);
      const domain = getDomainFromUrl(pageUrl);
      if (!domain) {
        return { saved: false };
      }

      const existing = (await api.listEntries(domain))
        .filter((entry) => isCredentialAllowedForPage(entry, pageUrl));
      const pending = isContentScriptSender(sender)
        ? await getPendingCredentials(domain, sender)
        : null;
      if (isContentScriptSender(sender) && !pendingCredentialMatchesSubmission(pending, pageUrl, password)) {
        return {
          saved: false,
          reason: 'missing_pending_credential',
          message: 'No matching pending password save was found.',
        };
      }
      const rememberedUsername = await getPendingUsername(domain);
      const effectiveUsername = String(username || rememberedUsername || '').trim();
      const confirmUpdate = payload.confirmUpdate === true;
      const requestedEntryId = String(payload.entryId || '');

      if (confirmUpdate && requestedEntryId) {
        const match = existing.find((entry) => String(entry.id) === requestedEntryId);
        if (!match) {
          return {
            saved: false,
            reason: 'entry_not_found',
            message: 'Could not find the selected saved login.',
          };
        }

        const decision = await compareExistingCredentialPassword(match, pageUrl, password);
        if (decision.action === 'unchanged') {
          await clearPendingUsername(domain);
          await clearPendingCredentials();
          return { saved: true, unchanged: true };
        }

        await api.updateEntry(match.id, { password });
        session.clearCache();
        await clearPendingUsername(domain);
        await clearPendingCredentials();
        return { saved: true, updated: true };
      }

      const decision = await getCredentialSaveDecision(existing, pageUrl, effectiveUsername, password);
      if (decision.action === 'unchanged') {
        await clearPendingUsername(domain);
        await clearPendingCredentials();
        return { saved: true, unchanged: true };
      }

      if (effectiveUsername) {
        if (decision.action === 'update' && decision.entryId) {
          await api.updateEntry(decision.entryId, { password });
          session.clearCache();
          await clearPendingUsername(domain);
          await clearPendingCredentials();
          return { saved: true, updated: true };
        }

        await api.createEntry({ website_url: url, username: effectiveUsername, password });
        session.clearCache();
        await clearPendingUsername(domain);
        await clearPendingCredentials();
        return { saved: true, updated: false };
      } else {
        if (decision.action === 'update' && decision.entryId) {
          return {
            saved: false,
            reason: 'confirm_update',
            entryId: decision.entryId,
            username: decision.username,
            message: buildSavePromptMessage(decision, domain, decision.username),
          };
        }

        if (existing.length === 1) {
          const entry = existing[0];
          return {
            saved: false,
            reason: 'confirm_update',
            entryId: entry.id,
            username: entry.username,
            message: `Update saved password for ${entry.username || entry.website_domain}?`,
          };
        }

        if (existing.length > 1) {
          return {
            saved: false,
            reason: 'missing_username',
            message: 'Multiple saved logins match this site. Enter or select the account before saving.',
          };
        }

        return {
          saved: false,
          reason: 'missing_username',
          message: 'No account username was detected for this password.',
        };
      }
    }

    case 'GET_FAVICON': {
      const { domain } = payload;
      if (faviconCache.has(domain)) return { dataUrl: faviconCache.get(domain) };
      const dataUrl = await api.getFavicon(domain);
      if (dataUrl) faviconCache.set(domain, dataUrl);
      return { dataUrl };
    }

    case 'BULK_IMPORT': {
      await session.resetAutoLock();
      session.clearCache();
      return await api.bulkImport(payload.entries, payload.skipDuplicates);
    }

    case 'CHANGE_PASSWORD': {
      await session.resetAutoLock();
      const result = await api.changePassword(payload.currentPassword, payload.newPassword);
      await session.clearToken();
      return result;
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
