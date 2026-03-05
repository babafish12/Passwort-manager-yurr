import { STORAGE_KEY_TOKEN, AUTO_LOCK_MINUTES } from '../lib/constants.js';

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.credentialCache = new Map();
  }

  async saveToken(token) {
    await chrome.storage.session.set({ [STORAGE_KEY_TOKEN]: token });
    this.api.setToken(token);
  }

  async loadToken() {
    const result = await chrome.storage.session.get(STORAGE_KEY_TOKEN);
    const token = result[STORAGE_KEY_TOKEN] || null;
    if (token) {
      this.api.setToken(token);
    }
    return token;
  }

  async clearToken() {
    await chrome.storage.session.remove(STORAGE_KEY_TOKEN);
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
