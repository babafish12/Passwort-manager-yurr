import { DEFAULT_SERVER_URL, API_BASE, STORAGE_KEY_SERVER_URL } from '../lib/constants.js';

export class VaultAPI {
  constructor() {
    this.token = null;
    this.serverUrl = null;
    this.tokenServerUrl = null;
  }

  createError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  isLikelyNetworkError(err) {
    const message = String(err?.message || '');
    return (
      err?.name === 'TypeError' ||
      /Failed to fetch|NetworkError|fetch failed|ERR_/i.test(message)
    );
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getServerUrl() {
    if (this.serverUrl) return this.serverUrl;
    const result = await chrome.storage.local.get(STORAGE_KEY_SERVER_URL);
    this.serverUrl = this.normalizeServerUrl(result[STORAGE_KEY_SERVER_URL] || DEFAULT_SERVER_URL);
    return this.serverUrl;
  }

  normalizeServerUrl(value) {
    let url;
    try {
      url = new URL(String(value || '').trim());
    } catch {
      throw this.createError('Invalid server URL. Use an HTTPS URL.', 'CONFIG_ERROR');
    }

    if (url.username || url.password) {
      throw this.createError('Invalid server URL. Credentials in URLs are not allowed.', 'CONFIG_ERROR');
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw this.createError('Invalid server URL. Use HTTPS.', 'CONFIG_ERROR');
    }

    if (url.protocol === 'http:' && !this.isLoopbackHost(url.hostname)) {
      throw this.createError('Refusing to send secrets to a non-local HTTP server URL.', 'CONFIG_ERROR');
    }

    url.hash = '';
    url.search = '';
    return url.href.replace(/\/+$/, '');
  }

  isLoopbackHost(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
      return true;
    }

    const parts = host.split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map((part) => Number.parseInt(part, 10));
    if (nums.some((num, idx) => !Number.isInteger(num) || String(num) !== parts[idx] || num < 0 || num > 255)) {
      return false;
    }

    return nums[0] === 127;
  }

  invalidateServerUrlCache() {
    this.serverUrl = null;
  }

  setToken(token, serverUrl = null) {
    this.token = token;
    this.tokenServerUrl = serverUrl || this.serverUrl || null;
  }

  clearToken() {
    this.token = null;
    this.tokenServerUrl = null;
  }

  isIdempotentMethod(method) {
    return ['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase());
  }

  sameServerOrigin(a, b) {
    if (!a || !b) return true;
    try {
      return new URL(a).origin === new URL(b).origin;
    } catch {
      return a === b;
    }
  }

  encodePathId(id) {
    return encodeURIComponent(String(id));
  }

  async request(method, path, body = null, requiresAuth = true) {
    const serverUrl = await this.getServerUrl();
    const url = `${serverUrl}${API_BASE}${path}`;

    const headers = { 'Content-Type': 'application/json' };
    if (requiresAuth && this.token) {
      if (!this.sameServerOrigin(this.tokenServerUrl, serverUrl)) {
        this.clearToken();
        throw this.createError('Session server changed. Please log in again.', 'AUTH_ERROR');
      }
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const options = { method, headers };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const maxAttempts = this.isIdempotentMethod(method) ? 2 : 1;
    let response;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetch(url, options);
        break;
      } catch (err) {
        if (attempt < maxAttempts && this.isLikelyNetworkError(err)) {
          await this.sleep(350);
          continue;
        }
        if (this.isLikelyNetworkError(err)) {
          throw this.createError('Failed to reach server', 'NETWORK_ERROR');
        }
        throw err;
      }
    }

    const rawText = await response.text();
    let data = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { error: rawText };
      }
    }

    if (!response.ok) {
      const message = data.error || data.message || `HTTP ${response.status}`;
      if (requiresAuth && (response.status === 401 || response.status === 403)) {
        throw this.createError(message, 'AUTH_ERROR');
      }
      throw this.createError(message, 'HTTP_ERROR');
    }

    return data;
  }

  // Auth endpoints
  async getStatus() {
    return this.request('GET', '/auth/status', null, false);
  }

  async setup(masterPassword) {
    return this.request('POST', '/auth/setup', { master_password: masterPassword }, false);
  }

  async login(masterPassword, options = {}) {
    const data = await this.request(
      'POST',
      '/auth/login',
      {
        master_password: masterPassword,
        never_auto_lock: options.neverAutoLock === true,
      },
      false
    );
    this.setToken(data.token, await this.getServerUrl());
    return data;
  }

  async logout() {
    const result = await this.request('POST', '/auth/logout');
    this.clearToken();
    return result;
  }

  async validateSession() {
    return this.request('GET', '/auth/session');
  }

  // Entry endpoints
  async listEntries(domain = null) {
    const path = domain ? `/entries?domain=${encodeURIComponent(domain)}` : '/entries';
    return this.request('GET', path);
  }

  async getEntry(id) {
    return this.request('GET', `/entries/${this.encodePathId(id)}`);
  }

  async createEntry(entry) {
    return this.request('POST', '/entries', entry);
  }

  async updateEntry(id, entry) {
    return this.request('PUT', `/entries/${this.encodePathId(id)}`, entry);
  }

  async deleteEntry(id) {
    return this.request('DELETE', `/entries/${this.encodePathId(id)}`);
  }

  // Vault item endpoints
  async listVaultItems(itemType) {
    const path = itemType
      ? `/vault-items?type=${encodeURIComponent(itemType)}`
      : '/vault-items';
    return this.request('GET', path);
  }

  async createVaultItem(itemType, payload) {
    return this.request('POST', '/vault-items', {
      item_type: itemType,
      payload,
    });
  }

  async updateVaultItem(id, payload) {
    return this.request('PUT', `/vault-items/${this.encodePathId(id)}`, { payload });
  }

  async deleteVaultItem(id) {
    return this.request('DELETE', `/vault-items/${this.encodePathId(id)}`);
  }

  async exportVault(masterPassword) {
    return this.request('POST', '/vault/export', {
      master_password: masterPassword,
    });
  }

  // Generate password
  async generatePassword(options = {}) {
    return this.request('POST', '/generate', {
      length: options.length || 20,
      uppercase: options.uppercase !== false,
      lowercase: options.lowercase !== false,
      digits: options.digits !== false,
      symbols: options.symbols !== false,
    });
  }

  // Favicon
  async getFavicon(domain) {
    const serverUrl = await this.getServerUrl();
    const url = `${serverUrl}${API_BASE}/favicons/${encodeURIComponent(domain)}`;
    const headers = {};
    if (this.token) {
      if (!this.sameServerOrigin(this.tokenServerUrl, serverUrl)) {
        this.clearToken();
        throw this.createError('Session server changed. Please log in again.', 'AUTH_ERROR');
      }
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    let response;
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetch(url, { headers });
        break;
      } catch (err) {
        if (attempt < maxAttempts && this.isLikelyNetworkError(err)) {
          await this.sleep(300);
          continue;
        }
        if (this.isLikelyNetworkError(err)) {
          throw this.createError('Failed to reach server', 'NETWORK_ERROR');
        }
        throw err;
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw this.createError('Session expired', 'AUTH_ERROR');
    }
    if (!response.ok) return null;
    const blob = await response.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  // Bulk import
  async bulkImport(entries, skipDuplicates = true) {
    return this.request('POST', '/entries/import', {
      entries,
      skip_duplicates: skipDuplicates,
    });
  }

  // Change master password
  async changePassword(currentPassword, newPassword) {
    return this.request('PUT', '/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
  }
}
