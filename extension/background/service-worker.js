import { VaultAPI } from './api.js';
import { SessionManager } from './session.js';

const api = new VaultAPI();
const session = new SessionManager(api);
const faviconCache = new Map();
let pendingCredentials = null;
let pendingCredentialsTimer = null;

// Restore token on startup
session.loadToken();

// Auto-lock alarm handler
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'auto-lock') {
    await session.lock();
  }
});

// Message handler for popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message });
  });
  return true; // Keep channel open for async response
});

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
        } catch {
          // Skip entries that fail to decrypt
        }
      }
      return { credentials };
    }

    case 'PENDING_CREDENTIALS': {
      if (pendingCredentialsTimer) {
        clearTimeout(pendingCredentialsTimer);
      }
      pendingCredentials = {
        url: payload.url,
        domain: payload.domain,
        username: payload.username,
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
          username: pendingCredentials.username,
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

      if (username) {
        // Normal flow: match by domain + username
        const match = existing.find((e) => e.username === username);
        if (match) {
          await api.updateEntry(match.id, { password });
          session.clearCache();
          return { saved: true, updated: true };
        } else {
          await api.createEntry({ website_url: url, username, password });
          session.clearCache();
          return { saved: true, updated: false };
        }
      } else {
        // Multi-step login (e.g. Google): no username captured on password step
        if (existing.length === 1) {
          await api.updateEntry(existing[0].id, { password });
          session.clearCache();
          return { saved: true, updated: true };
        }
        // Can't determine which entry to update without username
        return { saved: false };
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
