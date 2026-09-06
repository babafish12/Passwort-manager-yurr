// Entry detail logic
const DETAIL_RESUME_STATE_KEY = 'yurrr_detail_resume_state';
const STORAGE_KEY_DETAIL_RESUME_MINUTES = 'yurrr_detail_resume_minutes';
const DEFAULT_DETAIL_RESUME_MINUTES = 5;
const MAX_DETAIL_RESUME_MINUTES = 60;
const DETAIL_RESUME_REFRESH_MS = 5000;

const EntryDetail = {
  currentEntry: null,
  passwordVisible: false,
  resumeTimer: null,
  entryId: null,
  expiresAt: 0,
  expiryTimer: null,
  revision: 0,

  init() {
    this.screen = document.getElementById('detail-screen');
    this.domainEl = document.getElementById('detail-domain');
    this.faviconEl = document.getElementById('detail-favicon');
    this.urlEl = document.getElementById('detail-url');
    this.usernameEl = document.getElementById('detail-username');
    this.passwordEl = document.getElementById('detail-password');
    this.notesEl = document.getElementById('detail-notes');
    this.notesField = document.getElementById('detail-notes-field');
    this.togglePwBtn = document.getElementById('toggle-password');
    this.copyAllBtn = document.getElementById('copy-entry-all-btn');
    this.statusEl = document.getElementById('detail-status');
    this.retryBtn = document.getElementById('detail-retry');
    this.retryBtn.addEventListener('click', () => this.show(this.entryId));

    document.getElementById('back-from-detail').addEventListener('click', () => {
      this.hide();
      EntryList.show({ preserveSearch: true });
    });

    this.togglePwBtn.addEventListener('click', () => this.togglePassword());

    document.getElementById('edit-entry-btn').addEventListener('click', async () => {
      const entry = await this.getActionEntry();
      if (entry) EntryForm.showEdit(entry, this.expiresAt);
    });

    document.getElementById('delete-entry-btn').addEventListener('click', () => this.handleDelete());
    this.copyAllBtn.addEventListener('click', () => this.copyAllDetails());

    // Copy buttons
    this.screen.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copy;
        const el = document.getElementById(targetId);
        if (targetId === 'detail-url') {
          window.open(this.normalizeOpenUrl(this.urlEl.textContent), '_blank', 'noopener,noreferrer');
          return;
        }
        let text;
        if (targetId === 'detail-password') {
          const entry = await this.getActionEntry();
          if (!entry) return;
          text = entry.password;
        } else {
          text = el.textContent;
        }
        navigator.clipboard.writeText(text)
          .then(() => showToast('Copied!'))
          .catch((err) => showToast(`Copy failed: ${err.message}`, 'error'));
      });
    });

    window.addEventListener('pagehide', () => {
      if (this.currentEntry && !this.screen.classList.contains('hidden')) {
        this.persistResumeState().catch(() => {});
      }
    });
  },

  async show(entryId) {
    const generation = ++window.VaultSections.renderGeneration;
    this.entryId = entryId;
    this.stopResumeTimer();
    this.invalidate('Loading login...', false);
    const revision = this.revision;
    const metadata = EntryList.entries.find((entry) => entry.id === entryId);
    this.domainEl.textContent = metadata ? YurrrSiteScope.label(metadata) : 'Login';
    this.urlEl.textContent = metadata?.website_url || '';
    this.usernameEl.textContent = metadata?.username || '';
    this.faviconEl.replaceChildren();
    EntryList.hide();
    this.screen.classList.remove('hidden');
    window.animatePopupScreen?.(this.screen, 'forward');
    document.getElementById('back-from-detail').focus();

    try {
      const snapshot = await sendMessage('POPUP_ENTRY', { id: entryId });
      if (generation !== window.VaultSections.renderGeneration || revision !== this.revision) return false;
      this.applySnapshot(snapshot);
      this.loadDetailFavicon(snapshot.data);
      this.startResumeTimer();
      return true;
    } catch (err) {
      if (isSessionLostError(err) || generation !== window.VaultSections.renderGeneration) return false;
      this.invalidate(err.message || 'Could not load login.');
      window.updateCacheConnection?.(err.code === 'NETWORK_ERROR');
      return true;
    }
  },

  setSecretControls(enabled) {
    this.togglePwBtn.disabled = !enabled;
    this.copyAllBtn.disabled = !enabled;
    document.getElementById('edit-entry-btn').disabled = !enabled;
    this.screen.querySelectorAll('[data-copy="detail-password"]').forEach((button) => { button.disabled = !enabled; });
  },

  maskPassword() {
    this.passwordVisible = false;
    this.passwordEl.textContent = '\u2022'.repeat(12);
    this.passwordEl.classList.add('password-masked');
    this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
    this.togglePwBtn.title = 'Show password';
    this.togglePwBtn.setAttribute('aria-label', 'Show password');
  },

  invalidate(message = 'Reload this login to use its password and notes.', retry = true) {
    this.revision += 1;
    this.stopResumeTimer();
    clearTimeout(this.expiryTimer);
    this.currentEntry = null;
    this.expiresAt = 0;
    this.maskPassword();
    this.notesEl.textContent = '';
    this.notesField.classList.add('hidden');
    this.setSecretControls(false);
    this.statusEl.textContent = message;
    this.retryBtn.classList.toggle('hidden', !retry);
  },

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.expiresAt <= Date.now()) {
      this.invalidate();
      return;
    }
    const entry = snapshot.data;
    this.currentEntry = entry;
    this.expiresAt = snapshot.expiresAt;
    this.domainEl.textContent = YurrrSiteScope.label(entry);
    this.urlEl.textContent = entry.website_url;
    this.usernameEl.textContent = entry.username;
    this.notesEl.textContent = entry.notes || '';
    this.notesField.classList.toggle('hidden', !entry.notes);
    this.maskPassword();
    this.setSecretControls(true);
    this.statusEl.textContent = '';
    this.retryBtn.classList.add('hidden');
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.invalidate(), Math.max(0, this.expiresAt - Date.now()));
    window.updateCacheConnection?.(snapshot.offline);
  },

  async refresh() {
    const entryId = this.entryId;
    const revision = this.revision;
    const generation = window.VaultSections.renderGeneration;
    if (!entryId || this.screen.classList.contains('hidden')) return;
    try {
      const snapshot = await sendMessage('POPUP_ENTRY', { id: entryId, activity: false, refresh: false, cacheOnly: true });
      if (generation !== window.VaultSections.renderGeneration || entryId !== this.entryId || revision !== this.revision) return;
      this.applySnapshot(snapshot);
    } catch (err) {
      if (!isSessionLostError(err) && generation === window.VaultSections.renderGeneration) this.invalidate();
    }
  },

  async getActionEntry() {
    if (!this.currentEntry || this.expiresAt <= Date.now()) {
      this.invalidate();
      return null;
    }
    const entryId = this.entryId;
    const revision = this.revision;
    const generation = window.VaultSections.renderGeneration;
    try {
      const snapshot = await sendMessage('POPUP_ENTRY', { id: entryId });
      if (generation !== window.VaultSections.renderGeneration || entryId !== this.entryId || revision !== this.revision || this.screen.classList.contains('hidden')) return null;
      this.applySnapshot(snapshot);
      return this.currentEntry;
    } catch (err) {
      if (!isSessionLostError(err) && generation === window.VaultSections.renderGeneration) this.invalidate(err.message);
      return null;
    }
  },

  hide({ clearResume = true } = {}) {
    window.VaultSections.renderGeneration += 1;
    this.entryId = null;
    this.invalidate();
    this.screen.classList.add('hidden');
    this.domainEl.textContent = '';
    this.urlEl.textContent = '';
    this.usernameEl.textContent = '';
    this.notesEl.textContent = '';
    this.faviconEl.replaceChildren();
    if (clearResume) {
      this.clearResumeState();
    } else {
      this.stopResumeTimer();
    }
  },

  async togglePassword() {
    if (this.passwordVisible) {
      this.maskPassword();
      return;
    }
    if (!(await this.getActionEntry())) return;
    this.passwordVisible = true;
    this.passwordEl.textContent = this.currentEntry.password;
    this.passwordEl.classList.remove('password-masked');
    this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eyeOff', 'icon-sm') : '';
    this.togglePwBtn.title = 'Hide password';
    this.togglePwBtn.setAttribute('aria-label', 'Hide password');
  },

  async copyAllDetails() {
    if (!(await this.getActionEntry())) return;

    const text = [
      `Website: ${this.currentEntry.website_url || ''}`,
      `Username / Email: ${this.currentEntry.username || ''}`,
      `Password: ${this.currentEntry.password || ''}`,
    ].join('\n');

    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied all login data!');
    } catch (err) {
      showToast(`Copy failed: ${err.message}`, 'error');
    }
  },

  getResumeStore() {
    return chrome.storage.session || chrome.storage.local;
  },

  normalizeResumeMinutes(value) {
    const minutes = Number.parseFloat(value);
    if (!Number.isFinite(minutes)) return DEFAULT_DETAIL_RESUME_MINUTES;
    return Math.max(0, Math.min(MAX_DETAIL_RESUME_MINUTES, minutes));
  },

  async getResumeTimeoutMs() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY_DETAIL_RESUME_MINUTES);
      return this.normalizeResumeMinutes(result[STORAGE_KEY_DETAIL_RESUME_MINUTES]) * 60 * 1000;
    } catch {
      return DEFAULT_DETAIL_RESUME_MINUTES * 60 * 1000;
    }
  },

  async persistResumeState() {
    if (!this.currentEntry?.id || this.screen.classList.contains('hidden')) return;
    const entry = this.currentEntry;

    const timeoutMs = await this.getResumeTimeoutMs();
    if (this.currentEntry !== entry || this.screen.classList.contains('hidden')) return;
    const store = this.getResumeStore();
    if (timeoutMs <= 0) {
      await store.remove(DETAIL_RESUME_STATE_KEY);
      return;
    }

    await store.set({
      [DETAIL_RESUME_STATE_KEY]: {
        entryId: String(this.currentEntry.id),
        expiresAt: Date.now() + timeoutMs,
      },
    });
  },

  startResumeTimer() {
    this.stopResumeTimer();
    this.persistResumeState().catch(() => {});
    this.resumeTimer = setInterval(() => {
      this.persistResumeState().catch(() => {});
    }, DETAIL_RESUME_REFRESH_MS);
  },

  stopResumeTimer() {
    if (!this.resumeTimer) return;
    clearInterval(this.resumeTimer);
    this.resumeTimer = null;
  },

  async clearResumeState() {
    this.stopResumeTimer();
    try {
      await this.getResumeStore().remove(DETAIL_RESUME_STATE_KEY);
    } catch {
      // Restore state is best-effort only.
    }
  },

  async tryRestore() {
    const generation = window.VaultSections.renderGeneration;
    try {
      const store = this.getResumeStore();
      const result = await store.get(DETAIL_RESUME_STATE_KEY);
      if (generation !== window.VaultSections.renderGeneration) return true;
      const state = result[DETAIL_RESUME_STATE_KEY];
      const entryId = state?.entryId;
      const expiresAt = Number(state?.expiresAt);

      if (!entryId || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        await this.clearResumeState();
        return false;
      }

      if (window.VaultSections) {
        window.VaultSections.activeTab = 'passwords';
        window.VaultSections.updateChipState?.();
      }

      const restored = await this.show(entryId);
      if (restored) return true;
      if (window.VaultSections.renderGeneration !== generation + 1) return true;

      if (!document.getElementById('login-screen')?.classList.contains('hidden')) {
        return true;
      }

      await this.clearResumeState();
      return false;
    } catch {
      await this.clearResumeState();
      return false;
    }
  },

  async loadDetailFavicon(entry) {
    if (window.areFaviconsEnabled && !(await window.areFaviconsEnabled())) {
      return;
    }

    const entryId = entry?.id;
    const domain = entry?.website_domain || '';
    const websiteUrl = entry?.website_url || '';
    const hasServerFavicon = entry?.has_favicon === true;
    let discoveredLoaded = false;
    const isCurrentEntry = () => (
      this.currentEntry?.id === entryId &&
      this.currentEntry?.website_domain === domain &&
      this.currentEntry?.website_url === websiteUrl
    );
    const canApplyFavicon = async () => (
      isCurrentEntry() &&
      (!window.areFaviconsEnabled || await window.areFaviconsEnabled())
    );

    const browserFaviconUrl = window.getBrowserFaviconUrl?.(websiteUrl, domain);
    if (browserFaviconUrl) {
      try {
        const img = await window.loadPopupFaviconImage(browserFaviconUrl);
        if (await canApplyFavicon()) {
          this.faviconEl.replaceChildren(img);
        }
      } catch {
        // Try the server-provided favicon below.
      }
    }

    try {
      const img = await window.loadDiscoveredFaviconImage?.(websiteUrl, domain);
      if (img) {
        discoveredLoaded = true;
        if (await canApplyFavicon()) {
          this.faviconEl.replaceChildren(img);
        }
      }
    } catch {
      // Fall back to the server-provided favicon below.
    }

    if (discoveredLoaded && !hasServerFavicon) {
      return;
    }

    try {
      const result = await sendMessage('GET_FAVICON', { domain });
      if (
        result &&
        await canApplyFavicon() &&
        window.isSafeFaviconDataUrl?.(result.dataUrl)
      ) {
        const img = await window.loadPopupFaviconImage(result.dataUrl);
        if (await canApplyFavicon()) {
          this.faviconEl.replaceChildren(img);
        }
      }
    } catch {
      // No favicon available
    }
  },

  normalizeOpenUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'about:blank';

    const parseHttpUrl = (candidate) => {
      try {
        const url = new URL(candidate);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
      } catch {
        return '';
      }
    };

    const direct = parseHttpUrl(raw);
    if (direct) return direct;

    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return 'about:blank';
    }

    return parseHttpUrl(`https://${raw}`) || 'about:blank';
  },

  async handleDelete() {
    if (!this.entryId) return;
    const entryId = this.entryId;

    const domainLabel = this.currentEntry?.website_domain || 'this entry';
    const shouldDelete = await window.showConfirmDialog({
      title: 'Delete Password',
      message: `Delete "${window.truncateText ? window.truncateText(domainLabel) : domainLabel}"? This cannot be undone.`,
      confirmText: 'Delete Entry',
      cancelText: 'Cancel',
      confirmIcon: 'trash',
      destructive: true,
    });
    if (!shouldDelete) return;

    try {
      await sendMessage('DELETE_ENTRY', { id: entryId });
      showToast(`Deleted ${window.truncateText ? window.truncateText(domainLabel) : domainLabel}`);
      this.hide();
      EntryList.show();
    } catch (err) {
      if (isSessionLostError(err)) return;
      showToast('Error: ' + err.message, 'error');
    }
  },
};
