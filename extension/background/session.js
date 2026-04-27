import {
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_TOKEN_SERVER_URL,
  AUTO_LOCK_MINUTES,
  STORAGE_KEY_SESSION_MODE,
  STORAGE_KEY_LAST_ACTIVE,
  STORAGE_KEY_AUTO_LOCK_EXPIRES_AT,
  STORAGE_KEY_AUTO_LOCK_MINUTES,
  SESSION_MODE_PERSISTENT,
  SESSION_MODE_INACTIVITY,
} from '../lib/constants.js';

const AUTO_LOCK_ALARM = 'auto-lock';

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.credentialCache = new Map();
    this._cachedMode = null;
    this._clearingToken = false;
    this._tokenGeneration = 0;
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
    const minutes = Number.parseInt(result[STORAGE_KEY_AUTO_LOCK_MINUTES], 10);
    if (!Number.isFinite(minutes)) {
      return AUTO_LOCK_MINUTES;
    }
    return Math.max(1, Math.min(1440, minutes));
  }

  async saveToken(token) {
    const mode = await this._getMode();
    const serverUrl = await this.api.getServerUrl();
    if (mode === SESSION_MODE_PERSISTENT || mode === SESSION_MODE_INACTIVITY) {
      await chrome.storage.local.set({
        [STORAGE_KEY_TOKEN]: token,
        [STORAGE_KEY_TOKEN_SERVER_URL]: serverUrl,
      });
    } else {
      await chrome.storage.session.set({
        [STORAGE_KEY_TOKEN]: token,
        [STORAGE_KEY_TOKEN_SERVER_URL]: serverUrl,
      });
    }
    this.api.setToken(token, serverUrl);
    this.updateBadge(true);
    if (mode === SESSION_MODE_INACTIVITY) {
      await this.resetAutoLock();
    } else {
      await this.clearAutoLockState();
    }
  }

  async loadToken() {
    if (this._clearingToken) {
      return null;
    }

    const generation = this._tokenGeneration;
    const mode = await this._getMode();

    // Check session storage first (ephemeral — original behavior)
    let result = await chrome.storage.session.get([
      STORAGE_KEY_TOKEN,
      STORAGE_KEY_TOKEN_SERVER_URL,
    ]);
    let token = result[STORAGE_KEY_TOKEN] || null;
    let tokenServerUrl = result[STORAGE_KEY_TOKEN_SERVER_URL] || null;
    let tokenArea = 'session';

    // Fallback: check local storage (persistent or inactivity mode)
    if (!token) {
      result = await chrome.storage.local.get([
        STORAGE_KEY_TOKEN,
        STORAGE_KEY_TOKEN_SERVER_URL,
      ]);
      token = result[STORAGE_KEY_TOKEN] || null;
      tokenServerUrl = result[STORAGE_KEY_TOKEN_SERVER_URL] || null;
      tokenArea = 'local';
    }

    if (token) {
      const serverUrl = await this.api.getServerUrl();
      if (!tokenServerUrl) {
        const tokenServerRecord = { [STORAGE_KEY_TOKEN_SERVER_URL]: serverUrl };
        if (tokenArea === 'local') {
          await chrome.storage.local.set(tokenServerRecord);
        } else {
          await chrome.storage.session.set(tokenServerRecord);
        }
        tokenServerUrl = serverUrl;
      }

      if (!this.api.sameServerOrigin(tokenServerUrl, serverUrl)) {
        await this.clearToken();
        return null;
      }
    }

    if (this._clearingToken || generation !== this._tokenGeneration) {
      return null;
    }

    if (token && mode === SESSION_MODE_INACTIVITY) {
      if (await this._lockIfAutoLockExpired()) {
        return null;
      }
    } else {
      await this.clearAutoLockState();
    }

    if (token) {
      this.api.setToken(token, tokenServerUrl);
    }
    this.updateBadge(!!token);
    return token;
  }

  async clearToken() {
    this._clearingToken = true;
    this._tokenGeneration += 1;
    this.api.clearToken();
    this.credentialCache.clear();
    this.updateBadge(false);

    try {
      await chrome.storage.session.remove([
        STORAGE_KEY_TOKEN,
        STORAGE_KEY_TOKEN_SERVER_URL,
      ]);
      await chrome.storage.local.remove([
        STORAGE_KEY_TOKEN,
        STORAGE_KEY_TOKEN_SERVER_URL,
      ]);
      await this.clearAutoLockState();
    } finally {
      this._clearingToken = false;
    }
  }

  async isUnlocked() {
    const token = await this.loadToken();
    return !!token;
  }

  async clearAutoLockState() {
    await chrome.storage.local.remove([
      STORAGE_KEY_LAST_ACTIVE,
      STORAGE_KEY_AUTO_LOCK_EXPIRES_AT,
    ]);
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
  }

  async _getAutoLockDeadline() {
    const result = await chrome.storage.local.get([
      STORAGE_KEY_AUTO_LOCK_EXPIRES_AT,
      STORAGE_KEY_LAST_ACTIVE,
    ]);

    const expiresAt = result[STORAGE_KEY_AUTO_LOCK_EXPIRES_AT];
    if (typeof expiresAt === 'number') {
      return expiresAt;
    }

    const lastActive = result[STORAGE_KEY_LAST_ACTIVE];
    if (typeof lastActive !== 'number') {
      return null;
    }

    const autoLockMinutes = await this._getAutoLockMinutes();
    return lastActive + autoLockMinutes * 60 * 1000;
  }

  async _scheduleAutoLock(deadline) {
    await chrome.alarms.clear(AUTO_LOCK_ALARM);
    if (deadline <= Date.now()) {
      await this.lock();
      return false;
    }

    chrome.alarms.create(AUTO_LOCK_ALARM, { when: deadline });
    return true;
  }

  async _lockIfAutoLockExpired() {
    const deadline = await this._getAutoLockDeadline();
    if (!deadline) {
      return false;
    }

    if (deadline <= Date.now()) {
      await this.lock();
      return true;
    }

    await this._scheduleAutoLock(deadline);
    return false;
  }

  async resetAutoLock() {
    const mode = await this._getMode();
    if (mode !== SESSION_MODE_INACTIVITY) {
      await this.clearAutoLockState();
      return;
    }

    const autoLockMinutes = await this._getAutoLockMinutes();
    const now = Date.now();
    const deadline = now + autoLockMinutes * 60 * 1000;

    await chrome.storage.local.set({
      [STORAGE_KEY_LAST_ACTIVE]: now,
      [STORAGE_KEY_AUTO_LOCK_EXPIRES_AT]: deadline,
    });
    await this._scheduleAutoLock(deadline);
  }

  async lock() {
    try {
      await this.api.logout();
    } catch {
      // Server might be unreachable, clear local state anyway
    }
    await this.clearToken();
  }

  async forceLocalLock() {
    await this.clearToken();
  }

  setupIdleDetection() {
    try {
      chrome.idle.setDetectionInterval(60); // 1 minute
      chrome.idle.onStateChanged.addListener(async (newState) => {
        // Only lock immediately on laptop lock if mode is 'persistent'
        const mode = await this._getMode();
        if (mode === SESSION_MODE_PERSISTENT && newState === 'locked') {
          await this.lock();
        }
      });
    } catch {
      // idle API may not be available
    }

    chrome.storage.onChanged.addListener(async (changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      if (changes[STORAGE_KEY_SESSION_MODE]) {
        const newMode = changes[STORAGE_KEY_SESSION_MODE].newValue || 'ephemeral';
        this._cachedMode = newMode;
        // Clear token on mode change — user must re-login
        await this.clearToken();
        return;
      }

      if (!changes[STORAGE_KEY_AUTO_LOCK_MINUTES]) {
        return;
      }

      const mode = await this._getMode();
      if (mode !== SESSION_MODE_INACTIVITY) {
        return;
      }

      const tokenResult = await chrome.storage.local.get(STORAGE_KEY_TOKEN);
      if (!tokenResult[STORAGE_KEY_TOKEN]) {
        return;
      }

      const lastActiveResult = await chrome.storage.local.get(STORAGE_KEY_LAST_ACTIVE);
      const lastActive = lastActiveResult[STORAGE_KEY_LAST_ACTIVE];
      const baseTime = typeof lastActive === 'number' ? lastActive : Date.now();
      const minutes = changes[STORAGE_KEY_AUTO_LOCK_MINUTES].newValue || AUTO_LOCK_MINUTES;
      const deadline = baseTime + minutes * 60 * 1000;

      await chrome.storage.local.set({
        [STORAGE_KEY_AUTO_LOCK_EXPIRES_AT]: deadline,
      });
      await this._scheduleAutoLock(deadline);
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
