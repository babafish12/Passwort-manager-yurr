import {
  STORAGE_KEY_TOKEN,
  AUTO_LOCK_MINUTES,
  STORAGE_KEY_SESSION_MODE,
  SESSION_MODE_PERSISTENT,
} from '../lib/constants.js';

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.credentialCache = new Map();
    this._cachedMode = null;
  }

  async _getMode() {
    if (this._cachedMode) return this._cachedMode;
    const result = await chrome.storage.local.get(STORAGE_KEY_SESSION_MODE);
    this._cachedMode = result[STORAGE_KEY_SESSION_MODE] || 'ephemeral';
    return this._cachedMode;
  }

  async saveToken(token) {
    const mode = await this._getMode();
    if (mode === SESSION_MODE_PERSISTENT) {
      await chrome.storage.local.set({ [STORAGE_KEY_TOKEN]: token });
    } else {
      await chrome.storage.session.set({ [STORAGE_KEY_TOKEN]: token });
    }
    this.api.setToken(token);
  }

  async loadToken() {
    // Check session storage first (ephemeral — original behavior)
    let result = await chrome.storage.session.get(STORAGE_KEY_TOKEN);
    let token = result[STORAGE_KEY_TOKEN] || null;

    // Fallback: check local storage (persistent mode)
    if (!token) {
      result = await chrome.storage.local.get(STORAGE_KEY_TOKEN);
      token = result[STORAGE_KEY_TOKEN] || null;
    }

    if (token) {
      this.api.setToken(token);
    }
    return token;
  }

  async clearToken() {
    await chrome.storage.session.remove(STORAGE_KEY_TOKEN);
    await chrome.storage.local.remove(STORAGE_KEY_TOKEN);
    this.api.clearToken();
    this.credentialCache.clear();
  }

  async isUnlocked() {
    const token = await this.loadToken();
    return !!token;
  }

  resetAutoLock() {
    chrome.alarms.clear('auto-lock');
    chrome.alarms.create('auto-lock', { delayInMinutes: AUTO_LOCK_MINUTES });
  }

  async lock() {
    try {
      await this.api.logout();
    } catch {
      // Server might be unreachable, clear local state anyway
    }
    await this.clearToken();
    chrome.alarms.clear('auto-lock');
  }

  setupIdleDetection() {
    try {
      chrome.idle.setDetectionInterval(15);
      chrome.idle.onStateChanged.addListener((newState) => {
        if (this._cachedMode === SESSION_MODE_PERSISTENT && newState === 'locked') {
          this.lock();
        }
      });
    } catch {
      // idle API may not be available
    }

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY_SESSION_MODE]) {
        const newMode = changes[STORAGE_KEY_SESSION_MODE].newValue || 'ephemeral';
        this._cachedMode = newMode;
        // Clear token on mode change — user must re-login
        this.clearToken();
      }
    });
  }

  async getCredentialsForDomain(domain) {
    if (this.credentialCache.has(domain)) {
      return this.credentialCache.get(domain);
    }

    try {
      const entries = await this.api.listEntries(domain);
      this.credentialCache.set(domain, entries);
      return entries;
    } catch {
      return [];
    }
  }

  clearCache() {
    this.credentialCache.clear();
  }
}
