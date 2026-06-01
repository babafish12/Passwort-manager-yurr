// Entry detail logic
const EntryDetail = {
  currentEntry: null,
  passwordVisible: false,

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
  },

  async show(entryId) {
    this.passwordVisible = false;

    try {
      const entry = await sendMessage('GET_ENTRY', { id: entryId });
      this.currentEntry = entry;

      this.domainEl.textContent = entry.website_domain;
      this.faviconEl.innerHTML = '';
      this.loadDetailFavicon(entry.website_domain);
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
    } catch (err) {
      if (isSessionLostError(err)) return;
      showToast('Error: ' + err.message, 'error');
    }
  },

  hide() {
    this.screen.classList.add('hidden');
    this.passwordVisible = false;
    this.passwordEl.textContent = '\u2022'.repeat(12);
    this.passwordEl.classList.add('password-masked');
    this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
    this.togglePwBtn.title = 'Show password';
    this.togglePwBtn.setAttribute('aria-label', 'Show password');
    this.currentEntry = null;
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

  async loadDetailFavicon(domain) {
    try {
      const result = await sendMessage('GET_FAVICON', { domain });
      if (
        result &&
        this.currentEntry?.website_domain === domain &&
        this.isSafeImageDataUrl(result.dataUrl)
      ) {
        const img = document.createElement('img');
        img.src = result.dataUrl;
        img.alt = '';
        this.faviconEl.replaceChildren(img);
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

  isSafeImageDataUrl(dataUrl) {
    return /^data:image\/(png|jpe?g|webp|gif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i
      .test(String(dataUrl || ''));
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
