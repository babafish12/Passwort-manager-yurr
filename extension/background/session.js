import {
  STORAGE_KEY_TOKEN,
  AUTO_LOCK_MINUTES,
  STORAGE_KEY_SESSION_MODE,
  STORAGE_KEY_LAST_ACTIVE,
  STORAGE_KEY_AUTO_LOCK_MINUTES,
  SESSION_MODE_PERSISTENT,
  SESSION_MODE_INACTIVITY,
} from '../lib/constants.js';

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.credentialCache = new Map();
    this._cachedMode = null;
    this.updateBadge(false);
  }

  updateBadge(unlocked) {
    if (unlocked) {
      chrome.action.setBadgeText({ text: '' });
    } else {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#D32F2F' });
    }
  }

  async _getMode() {
    if (this._cachedMode) return this._cachedMode;
    const result = await chrome.storage.local.get(STORAGE_KEY_SESSION_MODE);
    this._cachedMode = result[STORAGE_KEY_SESSION_MODE] || 'ephemeral';
    return this._cachedMode;
  }

  async _getAutoLockMinutes() {
    const result = await chrome.storage.local.get(STORAGE_KEY_AUTO_LOCK_MINUTES);
    return result[STORAGE_KEY_AUTO_LOCK_MINUTES] || AUTO_LOCK_MINUTES;
  }

  async saveToken(token) {
    const mode = await this._getMode();
    if (mode === SESSION_MODE_PERSISTENT || mode === SESSION_MODE_INACTIVITY) {
      await chrome.storage.local.set({ [STORAGE_KEY_TOKEN]: token });
    } else {
      await chrome.storage.session.set({ [STORAGE_KEY_TOKEN]: token });
    }
    this.api.setToken(token);
    this.updateBadge(true);
    await this.resetAutoLock();
  }

  async loadToken() {
    const mode = await this._getMode();

    // Check session storage first (ephemeral — original behavior)
    let result = await chrome.storage.session.get(STORAGE_KEY_TOKEN);
    let token = result[STORAGE_KEY_TOKEN] || null;

    // Fallback: check local storage (persistent or inactivity mode)
    if (!token) {
      result = await chrome.storage.local.get(STORAGE_KEY_TOKEN);
      token = result[STORAGE_KEY_TOKEN] || null;

      // In persistent/inactivity mode, check if we timed out while browser was closed
      if (token && (mode === SESSION_MODE_PERSISTENT || mode === SESSION_MODE_INACTIVITY)) {
        const autoLockMinutes = await this._getAutoLockMinutes();
        const lastActiveResult = await chrome.storage.local.get(STORAGE_KEY_LAST_ACTIVE);
        const lastActive = lastActiveResult[STORAGE_KEY_LAST_ACTIVE];
        if (lastActive && Date.now() - lastActive > autoLockMinutes * 60 * 1000) {
          await this.lock();
          return null;
        }
      }
    }

    if (token) {
      this.api.setToken(token);
    }
    this.updateBadge(!!token);
    return token;
  }

  async clearToken() {
    await chrome.storage.session.remove(STORAGE_KEY_TOKEN);
    await chrome.storage.local.remove(STORAGE_KEY_TOKEN);
    await chrome.storage.local.remove(STORAGE_KEY_LAST_ACTIVE);
    this.api.clearToken();
    this.credentialCache.clear();
    this.updateBadge(false);
  }

  async isUnlocked() {
    const token = await this.loadToken();
    return !!token;
  }

  async resetAutoLock() {
    const autoLockMinutes = await this._getAutoLockMinutes();
    chrome.alarms.clear('auto-lock');
    chrome.alarms.create('auto-lock', { delayInMinutes: autoLockMinutes });
    await chrome.storage.local.set({ [STORAGE_KEY_LAST_ACTIVE]: Date.now() });
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

  async forceLocalLock() {
    await this.clearToken();
    chrome.alarms.clear('auto-lock');
  }

  setupIdleDetection() {
    try {
      chrome.idle.setDetectionInterval(60); // 1 minute
      chrome.idle.onStateChanged.addListener((newState) => {
        // Only lock immediately on laptop lock if mode is 'persistent'
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
    } catch (err) {
      if (err?.code === 'NETWORK_ERROR' || err?.code === 'AUTH_ERROR') {
        throw err;
      }
      return [];
    }
  }

  clearCache() {
    this.credentialCache.clear();
  }
}
