import {
  STORAGE_KEY_TOKEN,
  STORAGE_KEY_TOKEN_SERVER_URL,
  AUTO_LOCK_MINUTES,
  STORAGE_KEY_SESSION_MODE,
  STORAGE_KEY_LAST_ACTIVE,
  STORAGE_KEY_AUTO_LOCK_EXPIRES_AT,
  STORAGE_KEY_AUTO_LOCK_MINUTES,
  STORAGE_KEY_CREDENTIAL_METADATA_CACHE,
  SESSION_MODE_PERSISTENT,
  SESSION_MODE_INACTIVITY,
  SESSION_MODE_NEVER,
  SESSION_MODES,
} from '../lib/constants.js';
import { PopupCache } from './popup-cache.js';

const AUTO_LOCK_ALARM = 'auto-lock';
const CREDENTIAL_METADATA_CACHE_TTL_MS = 5 * 60 * 1000;
const CREDENTIAL_METADATA_CACHE_MAX_DOMAINS = 50;

export class SessionManager {
  constructor(api) {
    this.api = api;
    this.credentialCache = new Map();
    this.popupCache = new PopupCache(api, this);
    this.onLock = () => {};
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
    this._cachedMode = this._normalizeMode(result[STORAGE_KEY_SESSION_MODE]);
    return this._cachedMode;
  }

  _normalizeMode(mode) {
    return SESSION_MODES.includes(mode) ? mode : 'ephemeral';
  }

  async isNeverAutoLockMode() {
    return (await this._getMode()) === SESSION_MODE_NEVER;
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
    await this.clearCache();
    const mode = await this._getMode();
    const serverUrl = await this.api.getServerUrl();
    if (
      mode === SESSION_MODE_PERSISTENT ||
      mode === SESSION_MODE_INACTIVITY ||
      mode === SESSION_MODE_NEVER
    ) {
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

    if (this._clearingToken || generation !== this._tokenGeneration) {
      return null;
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
    await Promise.all([this.clearCache(), this.onLock()]);
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
    // Keep a separate client for revocation so a slow server cannot delay the
    // local lock or clear a newer login when the logout request completes.
    const logoutApi = new this.api.constructor();
    logoutApi.serverUrl = this.api.tokenServerUrl || this.api.serverUrl;
    logoutApi.setToken(this.api.token, this.api.tokenServerUrl);
    await this.clearToken();
    if (!logoutApi.token || !logoutApi.serverUrl) return;
    try {
      await logoutApi.logout();
    } catch {
      // Server might be unreachable, clear local state anyway
    }
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
        const newMode = this._normalizeMode(changes[STORAGE_KEY_SESSION_MODE].newValue);
        this._cachedMode = newMode;
        // Clear token on mode change — user must re-login
        await this.lock();
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
    const normalizedDomain = this._normalizeDomain(domain);
    if (!normalizedDomain) {
      return [];
    }

    const serverUrl = await this.api.getServerUrl();
    const memoryRecord = this.credentialCache.get(normalizedDomain);
    if (this._isFreshCredentialCacheRecord(memoryRecord, serverUrl)) {
      return memoryRecord.entries;
    }

    const sessionRecord = await this._readCredentialMetadataCache(normalizedDomain, serverUrl);
    if (sessionRecord) {
      this.credentialCache.set(normalizedDomain, sessionRecord);
      return sessionRecord.entries;
    }

    try {
      const entries = this._sanitizeCredentialMetadata(
        await this.api.listEntries(normalizedDomain)
      );
      await this._writeCredentialMetadataCache(normalizedDomain, serverUrl, entries);
      return entries;
    } catch (err) {
      if (err?.code === 'NETWORK_ERROR' || err?.code === 'AUTH_ERROR') {
        throw err;
      }
      return [];
    }
  }

  _normalizeDomain(value) {
    return String(value || '').trim().toLowerCase();
  }

  _sanitizeCredentialMetadata(entries) {
    if (!Array.isArray(entries)) {
      return [];
    }

    return entries
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const id = String(entry.id || '').trim();
        if (!id) return null;

        return {
          id,
          website_url: String(entry.website_url || ''),
          website_domain: String(entry.website_domain || ''),
          username: String(entry.username || ''),
          favorite: entry.favorite === true,
          has_favicon: entry.has_favicon === true,
          created_at: String(entry.created_at || ''),
          updated_at: String(entry.updated_at || ''),
        };
      })
      .filter(Boolean);
  }

  _isFreshCredentialCacheRecord(record, serverUrl) {
    return Boolean(
      record &&
      Array.isArray(record.entries) &&
      typeof record.cachedAt === 'number' &&
      Date.now() - record.cachedAt < CREDENTIAL_METADATA_CACHE_TTL_MS &&
      this.api.sameServerOrigin(record.serverUrl, serverUrl)
    );
  }

  async _readCredentialMetadataCache(domain, serverUrl) {
    try {
      const result = await chrome.storage.session.get(STORAGE_KEY_CREDENTIAL_METADATA_CACHE);
      const cache = result[STORAGE_KEY_CREDENTIAL_METADATA_CACHE];
      const record = cache && typeof cache === 'object' && !Array.isArray(cache)
        ? cache[domain]
        : null;
      if (!this._isFreshCredentialCacheRecord(record, serverUrl)) {
        if (record) {
          await this._removeCredentialMetadataCacheDomain(domain);
        }
        return null;
      }

      return {
        cachedAt: record.cachedAt,
        serverUrl: record.serverUrl,
        entries: this._sanitizeCredentialMetadata(record.entries),
      };
    } catch {
      return null;
    }
  }

  async _writeCredentialMetadataCache(domain, serverUrl, entries) {
    const record = {
      cachedAt: Date.now(),
      serverUrl,
      entries,
    };
    this.credentialCache.set(domain, record);

    try {
      const result = await chrome.storage.session.get(STORAGE_KEY_CREDENTIAL_METADATA_CACHE);
      const rawCache = result[STORAGE_KEY_CREDENTIAL_METADATA_CACHE];
      const cache = rawCache && typeof rawCache === 'object' && !Array.isArray(rawCache)
        ? { ...rawCache }
        : {};
      cache[domain] = record;

      const trimmedCache = Object.fromEntries(
        Object.entries(cache)
          .filter(([, item]) => this._isFreshCredentialCacheRecord(item, serverUrl))
          .sort(([, a], [, b]) => b.cachedAt - a.cachedAt)
          .slice(0, CREDENTIAL_METADATA_CACHE_MAX_DOMAINS)
      );

      await chrome.storage.session.set({
        [STORAGE_KEY_CREDENTIAL_METADATA_CACHE]: trimmedCache,
      });
    } catch {
      try {
        await chrome.storage.session.remove(STORAGE_KEY_CREDENTIAL_METADATA_CACHE);
      } catch {
        // Ignore cache cleanup failure.
      }
    }
  }

  async _removeCredentialMetadataCacheDomain(domain) {
    try {
      const result = await chrome.storage.session.get(STORAGE_KEY_CREDENTIAL_METADATA_CACHE);
      const rawCache = result[STORAGE_KEY_CREDENTIAL_METADATA_CACHE];
      if (!rawCache || typeof rawCache !== 'object' || Array.isArray(rawCache)) {
        return;
      }

      const cache = { ...rawCache };
      delete cache[domain];
      await chrome.storage.session.set({
        [STORAGE_KEY_CREDENTIAL_METADATA_CACHE]: cache,
      });
    } catch {
      // Cache cleanup should never break autofill.
    }
  }

  async clearCache() {
    await this.popupCache.clear();
    await this.clearCredentialMetadataCache();
  }

  async mutateEntries(operation) {
    return this.popupCache.mutate(async () => {
      await this.clearCredentialMetadataCache();
      try {
        return await operation();
      } finally {
        await this.clearCredentialMetadataCache();
      }
    });
  }

  async clearCredentialMetadataCache() {
    this.credentialCache.clear();
    try {
      await chrome.storage.session.remove(STORAGE_KEY_CREDENTIAL_METADATA_CACHE);
    } catch {
      // Cache cleanup must not block lock/logout.
    }
  }
}
