import { VaultAPI } from './api.js';
import { SessionManager } from './session.js';

const api = new VaultAPI();
const session = new SessionManager(api);
const faviconCache = new Map();

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

    case 'FORM_SUBMITTED': {
      if (!(await session.isUnlocked())) {
        return { saved: false };
      }
      session.resetAutoLock();
      const { url, username, password } = payload;

      // Check if entry already exists for this domain+username
      const domain = new URL(url).hostname;
      const existing = await api.listEntries(domain);
      const match = existing.find((e) => e.username === username);

      if (match) {
        // Update existing
        await api.updateEntry(match.id, { password });
        session.clearCache();
        return { saved: true, updated: true };
      } else {
        // Create new
        await api.createEntry({ website_url: url, username, password });
        session.clearCache();
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
