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

    document.getElementById('back-from-detail').addEventListener('click', () => {
      this.hide();
      EntryList.show();
    });

    this.togglePwBtn.addEventListener('click', () => this.togglePassword());

    document.getElementById('edit-entry-btn').addEventListener('click', () => {
      if (this.currentEntry) {
        EntryForm.showEdit(this.currentEntry);
      }
    });

    document.getElementById('delete-entry-btn').addEventListener('click', () => this.handleDelete());
    this.copyAllBtn.addEventListener('click', () => this.copyAllDetails());

    // Copy buttons
    this.screen.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copy;
        const el = document.getElementById(targetId);
        if (targetId === 'detail-url' && this.currentEntry) {
          window.open(this.normalizeOpenUrl(this.currentEntry.website_url), '_blank', 'noopener,noreferrer');
          return;
        }
        let text;
        if (targetId === 'detail-password') {
          text = this.currentEntry?.password || '';
        } else {
          text = el.textContent;
        }
        navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
      });
    });

    window.addEventListener('pagehide', () => {
      if (this.currentEntry && !this.screen.classList.contains('hidden')) {
        this.persistResumeState().catch(() => {});
      }
    });
  },

  async show(entryId) {
    this.passwordVisible = false;
    this.stopResumeTimer();

    try {
      const entry = await sendMessage('GET_ENTRY', { id: entryId });
      this.currentEntry = entry;

      this.domainEl.textContent = entry.website_domain;
      this.faviconEl.innerHTML = '';
      this.loadDetailFavicon(entry);
      this.urlEl.textContent = entry.website_url;
      this.usernameEl.textContent = entry.username;
      this.passwordEl.textContent = '\u2022'.repeat(12);
      this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
      this.togglePwBtn.title = 'Show password';
      this.togglePwBtn.setAttribute('aria-label', 'Show password');

      if (entry.notes) {
        this.notesEl.textContent = entry.notes;
        this.notesField.classList.remove('hidden');
      } else {
        this.notesField.classList.add('hidden');
      }

      EntryList.hide();
      this.screen.classList.remove('hidden');
      window.animatePopupScreen?.(this.screen, 'forward');
      this.startResumeTimer();
      return true;
    } catch (err) {
      if (isSessionLostError(err)) return false;
      showToast('Error: ' + err.message, 'error');
      return false;
    }
  },

  hide({ clearResume = true } = {}) {
    this.screen.classList.add('hidden');
    this.passwordVisible = false;
    this.passwordEl.textContent = '\u2022'.repeat(12);
    this.passwordEl.classList.add('password-masked');
    this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
    this.togglePwBtn.title = 'Show password';
    this.togglePwBtn.setAttribute('aria-label', 'Show password');
    this.currentEntry = null;
    if (clearResume) {
      this.clearResumeState();
    } else {
      this.stopResumeTimer();
    }
  },

  togglePassword() {
    this.passwordVisible = !this.passwordVisible;
    if (this.passwordVisible) {
      this.passwordEl.textContent = this.currentEntry.password;
      this.passwordEl.classList.remove('password-masked');
      this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eyeOff', 'icon-sm') : '';
      this.togglePwBtn.title = 'Hide password';
      this.togglePwBtn.setAttribute('aria-label', 'Hide password');
    } else {
      this.passwordEl.textContent = '\u2022'.repeat(12);
      this.passwordEl.classList.add('password-masked');
      this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
      this.togglePwBtn.title = 'Show password';
      this.togglePwBtn.setAttribute('aria-label', 'Show password');
    }
  },

  async copyAllDetails() {
    if (!this.currentEntry) return;

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

    const timeoutMs = await this.getResumeTimeoutMs();
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
    try {
      const store = this.getResumeStore();
      const result = await store.get(DETAIL_RESUME_STATE_KEY);
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
    if (!this.currentEntry) return;

    const domainLabel = this.currentEntry.website_domain || 'this entry';
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
      await sendMessage('DELETE_ENTRY', { id: this.currentEntry.id });
      showToast(`Deleted ${window.truncateText ? window.truncateText(domainLabel) : domainLabel}`);
      this.hide();
      EntryList.show();
    } catch (err) {
      if (isSessionLostError(err)) return;
      showToast('Error: ' + err.message, 'error');
    }
  },
};
