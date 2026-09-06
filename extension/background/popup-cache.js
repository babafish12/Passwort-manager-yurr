import {
  STORAGE_KEY_POPUP_CACHE,
  POPUP_CACHE_TTL_MS,
  POPUP_CACHE_REFRESH_MS,
  POPUP_CACHE_MAX_DETAILS,
  POPUP_CACHE_ALARM,
} from '../lib/constants.js';

// Only the trusted popup uses this cache. Autofill continues to fetch credentials
// through its existing page/domain checks.
export class PopupCache {
  constructor(api, session) {
    this.api = api;
    this.session = session;
    this.records = new Map();
    this.pending = new Map();
    this.generation = 0;
    this.storageQueue = Promise.resolve();
    this.loaded = null;
    this.owner = null;
    this.mutation = null;
    this.offline = false;
    this.onChange = () => {};
  }

  context() {
    return {
      token: this.api.token,
      serverUrl: this.api.serverUrl,
      tokenGeneration: this.api.tokenGeneration,
      generation: this.generation,
    };
  }

  assertSession(context) {
    if (!context.token || context.token !== this.api.token ||
        context.serverUrl !== this.api.serverUrl ||
        context.tokenGeneration !== this.api.tokenGeneration) {
      throw this.api.createError('Session changed. Please try again.', 'SESSION_CHANGED');
    }
  }

  assertCurrent(context) {
    this.assertSession(context);
    if (context.generation !== this.generation) {
      throw this.api.createError('Vault changed. Please try again.', 'CACHE_CHANGED');
    }
  }

  fresh(record) {
    const age = Date.now() - record?.cachedAt;
    return Number.isFinite(age) && age >= 0 && age < POPUP_CACHE_TTL_MS;
  }

  sanitize(key, data) {
    if (key === 'list') {
      if (!Array.isArray(data)) throw new Error('Invalid password list');
      return this.session._sanitizeCredentialMetadata(data);
    }
    if (!data || String(data.id) !== key.slice(6) || typeof data.password !== 'string') {
      throw new Error('Invalid password entry');
    }
    const [metadata] = this.session._sanitizeCredentialMetadata([data]);
    return { ...metadata, password: data.password, notes: typeof data.notes === 'string' ? data.notes : null };
  }

  async load() {
    const context = this.context();
    if (this.owner && (this.owner.token !== context.token || this.owner.serverUrl !== context.serverUrl)) {
      await this.clear();
    }
    if (!this.loaded) {
      const current = this.context();
      this.owner = { token: current.token, serverUrl: current.serverUrl };
      this.loaded = (async () => {
        await this.storageQueue;
        let stored;
        try {
          stored = (await chrome.storage.session.get(STORAGE_KEY_POPUP_CACHE))[STORAGE_KEY_POPUP_CACHE];
        } catch {
          // RAM caching still works if browser storage is unavailable.
        }
        this.assertCurrent(current);
        if (stored?.token === current.token && stored?.serverUrl === current.serverUrl) {
          for (const [key, record] of Object.entries(stored.records || {})) {
            if (!(key === 'list' || key.startsWith('entry:')) || !this.fresh(record)) continue;
            try {
              this.records.set(key, { ...record, data: this.sanitize(key, record.data) });
            } catch {
              // Ignore incomplete or obsolete records.
            }
          }
        }
        this.prune();
      })();
    }
    await this.loaded;
  }

  prune() {
    const removed = [];
    for (const [key, record] of this.records) {
      if (!this.fresh(record)) {
        this.records.delete(key);
        removed.push(key);
      }
    }
    const details = [...this.records].reverse().filter(([key]) => key !== 'list')
      .sort(([, a], [, b]) => b.lastUsedAt - a.lastUsedAt);
    for (const [key] of details.slice(POPUP_CACHE_MAX_DETAILS)) {
      this.records.delete(key);
      removed.push(key);
    }
    return removed;
  }

  persist() {
    // Serialize writes and serialize the current state at execution time. A
    // delayed write must never restore a snapshot cleared by lock or mutation.
    this.storageQueue = this.storageQueue.then(async () => {
      this.prune();
      try {
        if (this.records.size && this.owner?.token === this.api.token && this.owner?.serverUrl === this.api.serverUrl) {
          await chrome.storage.session.set({
            [STORAGE_KEY_POPUP_CACHE]: { ...this.owner, records: Object.fromEntries(this.records) },
          });
        } else {
          await chrome.storage.session.remove(STORAGE_KEY_POPUP_CACHE);
        }
      } catch {
        // Never fall back to disk storage for decrypted credentials.
        try { await chrome.storage.session.remove(STORAGE_KEY_POPUP_CACHE); } catch { /* best effort */ }
      }
      try {
        if (this.records.size) {
          const when = Math.min(...[...this.records.values()].map((record) => record.cachedAt + POPUP_CACHE_TTL_MS));
          await chrome.alarms.create(POPUP_CACHE_ALARM, { when });
        } else {
          await chrome.alarms.clear(POPUP_CACHE_ALARM);
        }
      } catch { /* Expiry is also enforced on every read and in the popup. */ }
    });
    return this.storageQueue;
  }

  clear() {
    this.generation += 1;
    this.records.clear();
    this.pending.clear();
    this.loaded = null;
    this.owner = null;
    this.offline = false;
    const clearing = this.persist();
    this.onChange({ kind: 'invalidated' });
    return clearing;
  }

  async expire() {
    if (!(await this.session.isUnlocked())) return this.clear();
    await this.load();
    const keys = this.prune();
    await this.persist();
    this.onChange({ kind: 'expired', keys });
  }

  mutate(operation) {
    const context = this.context();
    const previous = this.mutation;
    const task = (async () => {
      if (previous) await previous.catch(() => {});
      this.assertSession(context);
      await this.clear();
      try {
        this.assertSession(context);
        return await operation();
      } finally {
        await this.clear();
      }
    })();
    this.mutation = task;
    return task.finally(() => {
      if (this.mutation === task) this.mutation = null;
    });
  }

  async fetch(key, context) {
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      try {
        const data = key === 'list' ? await this.api.listEntries() : await this.api.getEntry(key.slice(6));
        this.assertCurrent(context);
        const record = { data: this.sanitize(key, data), cachedAt: Date.now(), lastUsedAt: Date.now() };
        const invalidated = [];
        if (key === 'list') {
          const entries = new Map(record.data.map((entry) => [entry.id, entry]));
          for (const [detailKey, detail] of this.records) {
            if (detailKey === 'list') continue;
            const entry = entries.get(detail.data.id);
            if (!entry || entry.updated_at !== detail.data.updated_at) {
              this.records.delete(detailKey);
              invalidated.push(detailKey);
            }
          }
        }
        this.records.set(key, record);
        this.offline = false;
        invalidated.push(...this.prune());
        await this.persist();
        this.assertCurrent(context);
        this.onChange({ kind: 'updated', keys: [key], invalidated, offline: false });
        return record;
      } catch (err) {
        this.assertCurrent(context);
        if (err.code === 'AUTH_ERROR') {
          await this.session.forceLocalLock();
          throw this.api.createError('Session expired. Please log in again.', 'SESSION_LOST');
        } else if (err.code === 'NETWORK_ERROR') {
          this.offline = true;
          this.onChange({ kind: 'connection', offline: true });
        } else if (err.status === 404) {
          const keys = [key];
          this.records.delete(key);
          if (this.records.get('list')?.data.some((entry) => entry.id === key.slice(6))) {
            this.records.delete('list');
            keys.push('list');
          }
          await this.persist();
          this.assertCurrent(context);
          this.onChange({ kind: 'removed', keys });
        }
        throw err;
      }
    })();
    this.pending.set(key, task);
    try {
      return await task;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }

  async read(key, { activity = true, refresh = true, cacheOnly = false } = {}) {
    if (this.mutation) await this.mutation.catch(() => {});
    if (!(await this.session.isUnlocked())) {
      throw this.api.createError('Vault is locked. Please log in again.', 'SESSION_LOST');
    }
    if (activity) await this.session.resetAutoLock();
    await this.load();
    if (this.mutation) return this.read(key, { activity, refresh, cacheOnly });
    const context = this.context();
    let record = this.records.get(key);
    if (!this.fresh(record)) {
      this.records.delete(key);
      if (cacheOnly) return null;
      record = await this.fetch(key, context);
    } else {
      record.lastUsedAt = Date.now();
      this.records.delete(key);
      this.records.set(key, record);
      void this.persist();
      if (refresh && Date.now() - record.cachedAt >= POPUP_CACHE_REFRESH_MS) {
        void this.fetch(key, context).catch(() => {});
      }
    }
    // Recheck after I/O, before returning secrets (including a cache hit).
    if (!(await this.session.isUnlocked())) {
      throw this.api.createError('Vault is locked. Please log in again.', 'SESSION_LOST');
    }
    this.assertCurrent(context);
    const localDeadline = await this.session._getAutoLockDeadline();
    this.assertCurrent(context);
    record = this.records.get(key);
    if (!this.fresh(record)) throw this.api.createError('Cached data expired. Please retry.', 'CACHE_CHANGED');
    if (this.mutation) throw this.api.createError('Vault changed. Please try again.', 'CACHE_CHANGED');
    return {
      data: structuredClone(record.data),
      expiresAt: Math.min(record.cachedAt + POPUP_CACHE_TTL_MS, localDeadline || Infinity),
      offline: this.offline,
    };
  }
}
