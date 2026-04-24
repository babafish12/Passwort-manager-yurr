import { VaultAPI } from './api.js';
import { SessionManager } from './session.js';
import {
  STORAGE_KEY_AUTO_EMAIL_SELECTED,
  STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS,
  STORAGE_KEY_EMAIL_SUGGESTIONS,
  STORAGE_KEY_PENDING_CREDENTIALS,
  STORAGE_KEY_PENDING_USERNAMES,
  STORAGE_KEY_SERVER_URL,
} from '../lib/constants.js';

const api = new VaultAPI();
const session = new SessionManager(api);
const faviconCache = new Map();
const PENDING_CREDENTIALS_TTL_MS = 30 * 1000;
const PENDING_USERNAME_TTL_MS = 10 * 60 * 1000;
const MAX_AUTO_EMAIL_SUGGESTIONS = 100;
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
  'FORM_SUBMITTED',
  'GET_FAVICON',
  'BULK_IMPORT',
  'CHANGE_PASSWORD',
  'GET_KNOWN_EMAIL_USERNAMES',
]);

const startupReady = initializeServiceWorker();

async function initializeServiceWorker() {
  try {
    await restrictLocalStorageAccess();
    await session.loadToken();
  } finally {
    session.setupIdleDetection();
  }
}

async function restrictLocalStorageAccess() {
  if (typeof chrome.storage.local.setAccessLevel !== 'function') {
    return;
  }

  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older browsers may not support storage access levels.
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY_SERVER_URL]) {
    return;
  }

  api.invalidateServerUrlCache();
  faviconCache.clear();
  session.clearCache();
});

// Auto-lock alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-lock') {
    await session.lock();
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
  } catch {
    return [];
  }
}

async function getEmailSuggestionsForPage(pageUrl) {
  if (!isCredentialPageAllowed(pageUrl)) {
    return [];
  }

  const result = await chrome.storage.local.get([
    STORAGE_KEY_EMAIL_SUGGESTIONS,
    STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS,
    STORAGE_KEY_AUTO_EMAIL_SELECTED,
  ]);
  const manualSuggestions = parseEmailSuggestions(result[STORAGE_KEY_EMAIL_SUGGESTIONS]);
  const allAutoSuggestions = parseEmailSuggestions(result[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]);
  const hasSelectedAutoEmails = Array.isArray(result[STORAGE_KEY_AUTO_EMAIL_SELECTED]);
  const selectedAutoEmails = parseEmailSuggestions(result[STORAGE_KEY_AUTO_EMAIL_SELECTED]);
  const selectedSet = new Set(selectedAutoEmails.map(normalizeEmail));
  const autoSuggestions = hasSelectedAutoEmails
    ? allAutoSuggestions.filter((email) => selectedSet.has(normalizeEmail(email)))
    : allAutoSuggestions;
  const vaultSuggestions = await getKnownEmailUsernamesFromVault();

  return mergeEmailLists(manualSuggestions, autoSuggestions, vaultSuggestions);
}

async function storeDiscoveredEmailForPage(pageUrl, value) {
  if (!isCredentialPageAllowed(pageUrl)) {
    return false;
  }

  const email = normalizeEmail(value);
  if (!email || !isValidEmail(email)) {
    return false;
  }

  const result = await chrome.storage.local.get(STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS);
  const current = parseEmailSuggestions(result[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]);
  if (current.includes(email)) {
    return true;
  }

  const updated = [email, ...current].slice(0, MAX_AUTO_EMAIL_SUGGESTIONS);
  await chrome.storage.local.set({ [STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]: updated });
  return true;
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeVaultItemType(value) {
  const itemType = String(value || '').trim().toLowerCase();
  if (itemType !== 'card' && itemType !== 'address') {
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

function isCredentialAllowedForPage(credential, pageUrl) {
  const page = parseUrl(pageUrl);
  if (!page || !isCredentialPageAllowed(page.href)) return false;

  const credentialUrl = parseUrl(credential?.website_url);
  if (page.protocol === 'http:' && credentialUrl?.protocol === 'https:') {
    return false;
  }

  return true;
}

function getMessagePageUrl(payload, sender) {
  return sender?.url || sender?.tab?.url || payload?.pageUrl || payload?.url || '';
}

function getDomainFromUrl(url, fallback = '') {
  const parsed = parseUrl(url);
  return normalizeDomain(parsed?.hostname || fallback);
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

async function setPendingCredentials(payload) {
  const domain = normalizeDomain(payload?.domain) || getDomainFromUrl(payload?.url);
  const password = String(payload?.password || '');
  if (!domain || !password) return false;

  await chrome.storage.session.set({
    [STORAGE_KEY_PENDING_CREDENTIALS]: {
      url: payload.url,
      domain,
      username: String(payload.username || '').trim(),
      password,
      expiresAt: Date.now() + PENDING_CREDENTIALS_TTL_MS,
    },
  });
  return true;
}

async function getPendingCredentials(domain) {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) return null;

  const result = await chrome.storage.session.get(STORAGE_KEY_PENDING_CREDENTIALS);
  const pending = result[STORAGE_KEY_PENDING_CREDENTIALS];
  if (!pending || typeof pending !== 'object') return null;

  if (typeof pending.expiresAt !== 'number' || pending.expiresAt <= Date.now()) {
    await chrome.storage.session.remove(STORAGE_KEY_PENDING_CREDENTIALS);
    return null;
  }

  if (normalizeDomain(pending.domain) !== cleanDomain) {
    return null;
  }

  return pending;
}

async function clearPendingCredentials() {
  await chrome.storage.session.remove(STORAGE_KEY_PENDING_CREDENTIALS);
}

async function clearAllPendingState() {
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

  switch (type) {
    case 'GET_STATUS':
      return await api.getStatus();

    case 'SETUP': {
      const result = await api.setup(payload.masterPassword);
      return result;
    }

    case 'LOGIN': {
      const data = await api.login(payload.masterPassword);
      await session.saveToken(data.token);
      await session.resetAutoLock();
      return { success: true };
    }

    case 'LOGOUT':
      await session.lock();
      faviconCache.clear();
      await clearAllPendingState();
      return { success: true };

    case 'IS_UNLOCKED':
      return { unlocked: await session.isUnlocked() };

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
      await session.resetAutoLock();
      return await api.exportVault();
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

      await session.resetAutoLock();
      const domain = normalizeDomain(payload.domain) || getDomainFromUrl(pageUrl);
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
      if (preferredUsername) {
        credentials.sort((a, b) => {
          const aMatch = normalizeUsername(a.username) === preferredUsername ? 0 : 1;
          const bMatch = normalizeUsername(b.username) === preferredUsername ? 0 : 1;
          return aMatch - bMatch;
        });
      }
      return { credentials };
    }

    case 'GET_CREDENTIAL_FOR_FILL': {
      if (!(await session.isUnlocked())) {
        return { credential: null };
      }

      const pageUrl = getMessagePageUrl(payload, sender);
      if (payload?.userGesture !== true || !isCredentialPageAllowed(pageUrl)) {
        return { credential: null };
      }

      const domain = normalizeDomain(payload.domain) || getDomainFromUrl(pageUrl);
      if (!domain || !payload.id) {
        return { credential: null };
      }

      await session.resetAutoLock();
      const entries = await session.getCredentialsForDomain(domain);
      const entry = entries.find((item) => String(item.id) === String(payload.id));
      if (!entry || !isCredentialAllowedForPage(entry, pageUrl)) {
        return { credential: null };
      }

      const detail = await api.getEntry(entry.id);
      if (!isCredentialAllowedForPage(detail, pageUrl)) {
        return { credential: null };
      }

      return {
        credential: {
          id: detail.id,
          username: detail.username,
          password: detail.password,
          website_url: detail.website_url,
        },
      };
    }

    case 'GET_KNOWN_EMAIL_USERNAMES': {
      if (!(await session.isUnlocked())) {
        return { emails: [] };
      }
      await session.resetAutoLock();
      const emails = await getKnownEmailUsernamesFromVault();
      return { emails: emails.slice(0, 250) };
    }

    case 'GET_EMAIL_SUGGESTIONS': {
      const pageUrl = getMessagePageUrl(payload, sender);
      const emails = await getEmailSuggestionsForPage(pageUrl);
      return { emails: emails.slice(0, 250) };
    }

    case 'STORE_DISCOVERED_EMAIL': {
      const pageUrl = getMessagePageUrl(payload, sender);
      return {
        stored: await storeDiscoveredEmailForPage(pageUrl, payload.email),
      };
    }

    case 'PENDING_USERNAME': {
      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { stored: false };
      }
      const domain = normalizeDomain(payload.domain) || getDomainFromUrl(pageUrl);
      return { stored: await setPendingUsername(domain, payload.url || pageUrl, payload.username) };
    }

    case 'GET_PENDING_USERNAME': {
      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { username: '' };
      }
      const domain = normalizeDomain(payload?.domain) || getDomainFromUrl(pageUrl);
      return { username: await getPendingUsername(domain) };
    }

    case 'CLEAR_PENDING_USERNAME': {
      await clearPendingUsername(payload?.domain);
      return { cleared: true };
    }

    case 'PENDING_CREDENTIALS': {
      const pageUrl = getMessagePageUrl(payload, sender);
      const credentialUrl = payload.url || pageUrl;
      if (!isCredentialPageAllowed(pageUrl) || !isCredentialPageAllowed(credentialUrl)) {
        return { stored: false };
      }

      const domain = normalizeDomain(payload.domain) || getDomainFromUrl(credentialUrl);
      const username = payload.username || await getPendingUsername(domain) || '';
      return {
        stored: await setPendingCredentials({
          ...payload,
          url: credentialUrl,
          domain,
          username,
        }),
      };
    }

    case 'CHECK_PENDING_CREDENTIALS': {
      const pageUrl = getMessagePageUrl(payload, sender);
      if (!isCredentialPageAllowed(pageUrl)) {
        return { hasPending: false };
      }

      const domain = normalizeDomain(payload.domain) || getDomainFromUrl(pageUrl);
      const pending = await getPendingCredentials(domain);
      if (!pending || !isCredentialAllowedForPage({ website_url: pending.url }, pageUrl)) {
        return { hasPending: false };
      }

      return {
        hasPending: true,
        credentials: {
          url: pending.url,
          domain: pending.domain,
          username: pending.username || await getPendingUsername(domain) || '',
          password: pending.password,
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

      const { url, username, password } = payload;
      if (!isCredentialPageAllowed(url)) {
        return { saved: false };
      }

      await session.resetAutoLock();
      const domain = getDomainFromUrl(url);
      if (!domain) {
        return { saved: false };
      }

      const existing = (await api.listEntries(domain))
        .filter((entry) => isCredentialAllowedForPage(entry, url));
      const rememberedUsername = await getPendingUsername(domain);
      const effectiveUsername = String(username || rememberedUsername || '').trim();

      if (effectiveUsername) {
        // Normal flow: match by domain + username
        const match = existing.find((e) => normalizeUsername(e.username) === normalizeUsername(effectiveUsername));
        if (match) {
          await api.updateEntry(match.id, { password });
          session.clearCache();
          await clearPendingUsername(domain);
          return { saved: true, updated: true };
        } else {
          await api.createEntry({ website_url: url, username: effectiveUsername, password });
          session.clearCache();
          await clearPendingUsername(domain);
          return { saved: true, updated: false };
        }
      } else {
        // No username means we cannot safely identify which saved login should
        // be updated. Create a new entry instead of overwriting by domain only.
        await api.createEntry({ website_url: url, username: '', password });
        session.clearCache();
        await clearPendingUsername(domain);
        return { saved: true, updated: false };
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
