import { VaultAPI } from './api.js';
import { SessionManager } from './session.js';

const api = new VaultAPI();
const session = new SessionManager(api);
const faviconCache = new Map();
let pendingCredentials = null;
let pendingCredentialsTimer = null;
const pendingUsernames = new Map();
const PENDING_USERNAME_TTL_MS = 10 * 60 * 1000;
const AUTH_REQUIRED_TYPES = new Set([
  'LIST_ENTRIES',
  'GET_ENTRY',
  'CREATE_ENTRY',
  'UPDATE_ENTRY',
  'DELETE_ENTRY',
  'GENERATE_PASSWORD',
  'CHECK_CREDENTIALS',
  'FORM_SUBMITTED',
  'GET_FAVICON',
  'BULK_IMPORT',
  'CHANGE_PASSWORD',
  'GET_KNOWN_EMAIL_USERNAMES',
]);

// Restore token on startup (fire-and-forget, non-blocking)
session.loadToken();
session.setupIdleDetection();

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

function setPendingUsername(domain, url, username) {
  const cleanDomain = String(domain || '').trim().toLowerCase();
  const cleanUsername = String(username || '').trim();
  if (!cleanDomain || !cleanUsername) return;

  pendingUsernames.set(cleanDomain, {
    username: cleanUsername,
    url: url || null,
    timestamp: Date.now(),
  });
}

function getPendingUsername(domain) {
  const cleanDomain = String(domain || '').trim().toLowerCase();
  if (!cleanDomain) return '';
  const value = pendingUsernames.get(cleanDomain);
  if (!value) return '';
  if (Date.now() - value.timestamp > PENDING_USERNAME_TTL_MS) {
    pendingUsernames.delete(cleanDomain);
    return '';
  }
  return value.username;
}

function clearPendingUsername(domain) {
  const cleanDomain = String(domain || '').trim().toLowerCase();
  if (!cleanDomain) return;
  pendingUsernames.delete(cleanDomain);
}

function clearAllPendingState() {
  pendingCredentials = null;
  pendingUsernames.clear();
  if (pendingCredentialsTimer) {
    clearTimeout(pendingCredentialsTimer);
    pendingCredentialsTimer = null;
  }
}

async function normalizeAndHandleError(messageType, err) {
  const error = err instanceof Error ? err : new Error(String(err || 'Unknown error'));
  const code = error.code || '';
  const shouldForceLock =
    AUTH_REQUIRED_TYPES.has(messageType) &&
    (code === 'NETWORK_ERROR' || code === 'AUTH_ERROR');

  if (shouldForceLock) {
    await session.forceLocalLock();
    faviconCache.clear();
    clearAllPendingState();
    return {
      code: 'SESSION_LOST',
      message: code === 'NETWORK_ERROR' ? 'Network disconnected. Please log in again.' : 'Session expired. Please log in again.',
    };
  }

  return {
    code: code || 'UNKNOWN_ERROR',
    message: error.message || 'Unknown error',
  };
}

async function handleMessage(message, sender) {
  const { type, payload } = message;

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
      session.resetAutoLock();
      return { success: true };
    }

    case 'LOGOUT':
      await session.lock();
      faviconCache.clear();
      clearAllPendingState();
      return { success: true };

    case 'IS_UNLOCKED':
      return { unlocked: await session.isUnlocked() };

    case 'LIST_ENTRIES': {
      session.resetAutoLock();
      return await api.listEntries(payload?.domain);
    }

    case 'GET_ENTRY': {
      session.resetAutoLock();
      return await api.getEntry(payload.id);
    }

    case 'CREATE_ENTRY': {
      session.resetAutoLock();
      session.clearCache();
      return await api.createEntry(payload);
    }

    case 'UPDATE_ENTRY': {
      session.resetAutoLock();
      session.clearCache();
      return await api.updateEntry(payload.id, payload.data);
    }

    case 'DELETE_ENTRY': {
      session.resetAutoLock();
      session.clearCache();
      return await api.deleteEntry(payload.id);
    }

    case 'GENERATE_PASSWORD': {
      session.resetAutoLock();
      return await api.generatePassword(payload);
    }

    case 'CHECK_CREDENTIALS': {
      if (!(await session.isUnlocked())) {
        return { credentials: [] };
      }
      session.resetAutoLock();
      const domain = payload.domain;
      const entries = await session.getCredentialsForDomain(domain);
      // For each entry, fetch the decrypted password
      const credentials = [];
      for (const entry of entries) {
        try {
          const detail = await api.getEntry(entry.id);
          credentials.push({
            id: detail.id,
            username: detail.username,
            password: detail.password,
            website_url: detail.website_url,
          });
        } catch (err) {
          if (err?.code === 'NETWORK_ERROR' || err?.code === 'AUTH_ERROR') {
            throw err;
          }
          // Skip entries that fail to decrypt
        }
      }
      const preferredUsername = normalizeUsername(payload?.preferredUsername || getPendingUsername(domain));
      if (preferredUsername) {
        credentials.sort((a, b) => {
          const aMatch = normalizeUsername(a.username) === preferredUsername ? 0 : 1;
          const bMatch = normalizeUsername(b.username) === preferredUsername ? 0 : 1;
          return aMatch - bMatch;
        });
      }
      return { credentials };
    }

    case 'GET_KNOWN_EMAIL_USERNAMES': {
      if (!(await session.isUnlocked())) {
        return { emails: [] };
      }
      session.resetAutoLock();
      const entries = await api.listEntries();
      const seen = new Set();
      const emails = [];

      for (const entry of entries) {
        const username = String(entry.username || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) continue;
        if (seen.has(username)) continue;
        seen.add(username);
        emails.push(username);
      }

      return { emails: emails.slice(0, 250) };
    }

    case 'PENDING_USERNAME': {
      setPendingUsername(payload.domain, payload.url, payload.username);
      return { stored: true };
    }

    case 'GET_PENDING_USERNAME': {
      return { username: getPendingUsername(payload?.domain) };
    }

    case 'CLEAR_PENDING_USERNAME': {
      clearPendingUsername(payload?.domain);
      return { cleared: true };
    }

    case 'PENDING_CREDENTIALS': {
      if (pendingCredentialsTimer) {
        clearTimeout(pendingCredentialsTimer);
      }
      pendingCredentials = {
        url: payload.url,
        domain: payload.domain,
        username: payload.username || getPendingUsername(payload.domain) || '',
        password: payload.password,
        timestamp: Date.now(),
      };
      pendingCredentialsTimer = setTimeout(() => {
        pendingCredentials = null;
        pendingCredentialsTimer = null;
      }, 30000);
      return { stored: true };
    }

    case 'CHECK_PENDING_CREDENTIALS': {
      const { domain } = payload;
      if (
        !pendingCredentials ||
        pendingCredentials.domain !== domain ||
        Date.now() - pendingCredentials.timestamp > 30000
      ) {
        return { hasPending: false };
      }
      return {
        hasPending: true,
        credentials: {
          url: pendingCredentials.url,
          domain: pendingCredentials.domain,
          username: pendingCredentials.username || getPendingUsername(domain) || '',
          password: pendingCredentials.password,
        },
      };
    }

    case 'CLEAR_PENDING_CREDENTIALS': {
      pendingCredentials = null;
      if (pendingCredentialsTimer) {
        clearTimeout(pendingCredentialsTimer);
        pendingCredentialsTimer = null;
      }
      return { cleared: true };
    }

    case 'FORM_SUBMITTED': {
      if (!(await session.isUnlocked())) {
        return { saved: false };
      }
      session.resetAutoLock();
      const { url, username, password } = payload;

      const domain = new URL(url).hostname;
      const existing = await api.listEntries(domain);
      const rememberedUsername = getPendingUsername(domain);
      const effectiveUsername = String(username || rememberedUsername || '').trim();

      if (effectiveUsername) {
        // Normal flow: match by domain + username
        const match = existing.find((e) => normalizeUsername(e.username) === normalizeUsername(effectiveUsername));
        if (match) {
          await api.updateEntry(match.id, { password });
          session.clearCache();
          clearPendingUsername(domain);
          return { saved: true, updated: true };
        } else {
          await api.createEntry({ website_url: url, username: effectiveUsername, password });
          session.clearCache();
          clearPendingUsername(domain);
          return { saved: true, updated: false };
        }
      } else {
        // Multi-step login (e.g. Google): no username captured on password step
        if (existing.length === 1) {
          await api.updateEntry(existing[0].id, { password });
          session.clearCache();
          clearPendingUsername(domain);
          return { saved: true, updated: true };
        }
        // If 0 or >1 existing entries, create a new entry with an empty username 
        // to prevent password loss.
        await api.createEntry({ website_url: url, username: '', password });
        session.clearCache();
        clearPendingUsername(domain);
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
      session.resetAutoLock();
      session.clearCache();
      return await api.bulkImport(payload.entries, payload.skipDuplicates);
    }

    case 'CHANGE_PASSWORD': {
      session.resetAutoLock();
      const result = await api.changePassword(payload.currentPassword, payload.newPassword);
      await session.clearToken();
      return result;
    }

    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}
