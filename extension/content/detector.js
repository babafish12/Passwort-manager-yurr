// Form detection, auto-fill, and save prompt
const YurrrDetector = {
  initialized: false,
  detectedForms: new WeakSet(),
  activePicker: null,
  activePickerCleanup: null,
  activeEmailPicker: null,
  activeEmailPickerCleanup: null,
  scanQueued: false,
  emailSuggestionsCache: null,
  emailSuggestionsCacheAt: 0,
  observedSubmitForms: new WeakSet(),
  savePromptTimer: null,
  saveBannerCleanup: null,
  pendingPromptReadyCleanup: null,
  EMAIL_SUGGESTIONS_LIST_ID: 'yurrr-email-suggestions-list',
  MAX_VISIBLE_EMAIL_SUGGESTIONS: 8,
  GENERATED_PASSWORD_PROMPT_DELAY_MS: 700,
  GENERATED_PASSWORD_MAX_AGE_MS: 10 * 60 * 1000,
  POST_SUBMIT_TRANSITION_TIMEOUT_MS: 5000,
  POST_SUBMIT_TRANSITION_CHECK_MS: 250,
  POST_SUBMIT_TRANSITION_STABLE_MS: 1000,
  PENDING_PROMPT_READY_ARM_MS: 5000,
  SAVE_BANNER_TTL_MS: 5 * 60 * 1000,

  init() {
    if (this.initialized) return;
    this.initialized = true;

    this.removeEmailSuggestionsDatalist();
    this.checkPendingCredentials();
    this.scanForms();

    // Watch for DOM changes (SPAs) — debounced via rAF
    const observer = new MutationObserver(() => {
      if (this.scanQueued) return;
      this.scanQueued = true;
      requestAnimationFrame(() => {
        this.scanQueued = false;
        this.scanForms();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  },

  async sendRuntimeMessage(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (resp?.error) {
          const error = new Error(resp.error);
          error.code = resp.code || '';
          reject(error);
          return;
        }
        resolve(resp);
      });
    });
  },

  parseEmailSuggestions(value) {
    const raw = Array.isArray(value)
      ? value
      : typeof value === 'string'
        ? value.split(/[\n,;]+/)
        : [];

    const seen = new Set();
    const suggestions = [];

    for (const item of raw) {
      const email = String(item || '').trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      seen.add(key);
      suggestions.push(email);
    }

    return suggestions;
  },

  async loadEmailSuggestions(force = false) {
    const now = Date.now();
    if (!force && this.emailSuggestionsCache && now - this.emailSuggestionsCacheAt < 10000) {
      return this.emailSuggestionsCache;
    }

    try {
      const result = await this.sendRuntimeMessage('GET_EMAIL_SUGGESTIONS', {
        pageUrl: window.location.href,
      });
      const combined = this.parseEmailSuggestions(result?.emails)
        .slice(0, this.MAX_VISIBLE_EMAIL_SUGGESTIONS);
      this.emailSuggestionsCache = combined;
      this.emailSuggestionsCacheAt = now;
      return combined;
    } catch {
      return [];
    }
  },

  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  },

  parseUrl(value) {
    try {
      return new URL(value);
    } catch {
      return null;
    }
  },

  normalizeHostname(hostname) {
    return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  },

  isPrivateIPv4(hostname) {
    const parts = this.normalizeHostname(hostname).split('.');
    if (parts.length !== 4) return false;
    const nums = parts.map((part) => Number.parseInt(part, 10));
    if (nums.some((num, idx) => !Number.isInteger(num) || String(num) !== parts[idx] || num < 0 || num > 255)) {
      return false;
    }

    return (
      nums[0] === 10 ||
      nums[0] === 127 ||
      (nums[0] === 172 && nums[1] >= 16 && nums[1] <= 31) ||
      (nums[0] === 192 && nums[1] === 168) ||
      (nums[0] === 169 && nums[1] === 254)
    );
  },

  isPrivateIPv6(hostname) {
    const host = this.normalizeHostname(hostname);
    return (
      host === '::1' ||
      /^f[cd][0-9a-f]*:/i.test(host) ||
      /^fe80:/i.test(host)
    );
  },

  isHttpDevHost(hostname) {
    const host = this.normalizeHostname(hostname);
    return (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      this.isPrivateIPv4(host) ||
      this.isPrivateIPv6(host)
    );
  },

  isCredentialPageAllowed() {
    const url = this.parseUrl(window.location.href);
    if (!url) return false;
    if (url.protocol === 'https:') return true;
    if (url.protocol === 'http:') return this.isHttpDevHost(url.hostname);
    return false;
  },

  removeEmailSuggestionsDatalist() {
    const dataList = document.getElementById(this.EMAIL_SUGGESTIONS_LIST_ID);
    if (dataList) dataList.remove();

    document
      .querySelectorAll(`input[list="${this.EMAIL_SUGGESTIONS_LIST_ID}"]`)
      .forEach((field) => field.removeAttribute('list'));
  },

  applyEmailSuggestions(field) {
    if (!field) return;
    if (!this.isCredentialPageAllowed()) return;
    if (!YurrrHeuristics.isLikelyEmailField(field)) return;
    if (field.getAttribute('list') === this.EMAIL_SUGGESTIONS_LIST_ID) {
      field.removeAttribute('list');
    }
    this.attachEmailPicker(field);
  },

  attachEmailPicker(field) {
    if (!field || field.dataset.yurrrEmailPickerAttached === '1') return;
    field.dataset.yurrrEmailPickerAttached = '1';

    const openPicker = () => {
      this.showEmailPicker(field);
    };

    field.addEventListener('focus', openPicker);
    field.addEventListener('click', openPicker);
  },

  positionFloatingHost(host, targetField, minWidth = 260) {
    const rect = targetField.getBoundingClientRect();
    const viewportPadding = 8;
    const availableWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
    const width = Math.min(Math.max(minWidth, rect.width), availableWidth);
    const minLeft = window.scrollX + viewportPadding;
    const maxLeft = window.scrollX + window.innerWidth - width - viewportPadding;
    const left = Math.max(minLeft, Math.min(rect.left + window.scrollX, maxLeft));
    const availableHeight = Math.max(160, window.innerHeight - viewportPadding * 2);
    const hostHeight = Math.min(host.offsetHeight, availableHeight);
    const belowTop = rect.bottom + window.scrollY + 4;
    const aboveTop = rect.top + window.scrollY - hostHeight - 4;
    const minTop = window.scrollY + viewportPadding;
    const maxTop = window.scrollY + window.innerHeight - hostHeight - viewportPadding;
    const preferredTop = belowTop + hostHeight > maxTop + viewportPadding && aboveTop >= minTop
      ? aboveTop
      : belowTop;
    const top = Math.max(minTop, Math.min(preferredTop, maxTop));

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    host.style.width = `${width}px`;
    host.style.maxHeight = `${availableHeight}px`;
    host.style.overflowY = 'auto';
  },

  async showEmailPicker(field) {
    if (!field || !YurrrHeuristics.isLikelyEmailField(field)) return;
    if (!this.isCredentialPageAllowed()) return;

    const suggestions = await this.loadEmailSuggestions(true);
    if (!field.isConnected || document.activeElement !== field) {
      this.hideEmailPicker();
      return;
    }

    if (!suggestions.length) {
      this.hideEmailPicker();
      return;
    }

    this.hideEmailPicker();

    const host = document.createElement('div');
    Object.assign(host.style, {
      position: 'absolute',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
    });

    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .picker {
          background: #1a1a2e;
          border: 1px solid #2ecc71;
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          color: #e0e0e0;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          overflow: hidden;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 14px;
          background: #16213e;
          border-bottom: 1px solid #0f3460;
        }
        .title { font-weight: 700; color: #2ecc71; font-size: 13px; }
        .subtitle { color: #888; font-size: 11px; }
        .list { max-height: 220px; overflow-y: auto; padding: 4px 0; }
        .item {
          cursor: pointer;
          font-size: 13px;
          font-weight: 600;
          overflow: hidden;
          padding: 10px 14px;
          text-overflow: ellipsis;
          transition: background 0.12s;
          white-space: nowrap;
        }
        .item:hover { background: #16213e; }
      </style>
      <div class="picker">
        <div class="header">
          <span class="title">Yurrr</span>
          <span class="subtitle">E-Mail</span>
        </div>
        <div class="list">
          ${suggestions
            .map((email, i) => `<div class="item" data-index="${i}">${this.escapeHtml(email)}</div>`)
            .join('')}
        </div>
      </div>
    `;

    document.body.appendChild(host);
    this.activeEmailPicker = host;
    this.positionFloatingHost(host, field, 260);

    let closed = false;
    let outsideClickTimer = null;

    const outsideClickHandler = (e) => {
      if (!host.contains(e.target) && e.target !== field) {
        this.hideEmailPicker();
      }
    };

    const escHandler = (e) => {
      if (e.key === 'Escape') this.hideEmailPicker();
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (outsideClickTimer !== null) {
        clearTimeout(outsideClickTimer);
        outsideClickTimer = null;
      }
      document.removeEventListener('click', outsideClickHandler);
      document.removeEventListener('keydown', escHandler);
      if (this.activeEmailPicker === host) {
        this.activeEmailPicker = null;
      }
      if (this.activeEmailPickerCleanup === cleanup) {
        this.activeEmailPickerCleanup = null;
      }
      host.remove();
    };
    this.activeEmailPickerCleanup = cleanup;

    shadow.querySelectorAll('.item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number.parseInt(item.dataset.index, 10);
        const email = suggestions[idx];
        this.fillEmailField(field, email);
        this.rememberUsername(window.location.hostname, window.location.href, email);
        this.hideEmailPicker();
      });
    });

    outsideClickTimer = setTimeout(() => {
      outsideClickTimer = null;
      if (!closed) {
        document.addEventListener('click', outsideClickHandler);
      }
    }, 0);
    document.addEventListener('keydown', escHandler);
  },

  hideEmailPicker() {
    if (this.activeEmailPickerCleanup) {
      const cleanup = this.activeEmailPickerCleanup;
      this.activeEmailPickerCleanup = null;
      cleanup();
      return;
    }

    if (this.activeEmailPicker) {
      this.activeEmailPicker.remove();
    }
    this.activeEmailPicker = null;
  },

  fillEmailField(field, email) {
    if (!field || !email) return;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(field, email);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  },

  normalizeUsername(value) {
    return String(value || '').trim().toLowerCase();
  },

  selectCredential(credentials, preferredUsername) {
    if (!credentials.length) return null;
    const preferred = this.normalizeUsername(preferredUsername);
    if (!preferred) return credentials[0];

    const exact = credentials.find((cred) => this.normalizeUsername(cred.username) === preferred);
    return exact || credentials[0];
  },

  async rememberUsername(domain, url, username) {
    const normalized = String(username || '').trim();
    if (!normalized) return;

    try {
      await this.sendRuntimeMessage('PENDING_USERNAME', {
        domain,
        url,
        pageUrl: window.location.href,
        username: normalized,
      });
    } catch {
      // Silent fail
    }
  },

  async getRememberedUsername(domain) {
    try {
      const response = await this.sendRuntimeMessage('GET_PENDING_USERNAME', {
        domain,
        pageUrl: window.location.href,
      });
      return response?.username || '';
    } catch {
      return '';
    }
  },

  getSubmitPasswordField(form, fallbackField) {
    if (!form || !YurrrHeuristics.isPasswordChangeForm(form)) {
      return fallbackField;
    }

    const currentPasswordField = YurrrHeuristics.findCurrentPasswordField(form);
    const candidates = YurrrHeuristics.getVisiblePasswordFields(form)
      .filter((field) => field !== currentPasswordField && String(field.value || '').length > 0);

    return candidates.find((field) => YurrrHeuristics.isNewPasswordField(field))
      || candidates[0]
      || fallbackField;
  },

  attachFormSubmitHandler(form, resolveUsernameField, passwordField) {
    if (!form || this.observedSubmitForms.has(form)) return;
    this.observedSubmitForms.add(form);

    form.addEventListener('submit', (e) => {
      if (!e.isTrusted) return;
      this.handleFormSubmit(
        form,
        resolveUsernameField(),
        this.getSubmitPasswordField(form, passwordField),
      );
    });
  },

  scanForms() {
    const passwordFields = document.querySelectorAll('input[type="password"]');

    for (const pwField of passwordFields) {
      if (this.detectedForms.has(pwField)) continue;
      this.detectedForms.add(pwField);

      const form = pwField.closest('form');
      const resolveUsernameField = () => YurrrHeuristics.findUsernameField(pwField);
      const initialUsernameField = resolveUsernameField();

      if (initialUsernameField) {
        this.detectedForms.add(initialUsernameField);
      }

      const isPasswordChange = YurrrHeuristics.isPasswordChangeForm(form);
      if (isPasswordChange) {
        const currentPasswordField = YurrrHeuristics.findCurrentPasswordField(form);
        if (pwField === currentPasswordField) {
          this.tryAutoFill(initialUsernameField, pwField);
          pwField.addEventListener('focus', () => {
            this.tryAutoFill(resolveUsernameField(), pwField, true, pwField);
          });
        } else {
          pwField.addEventListener('focus', () => {
            if (this.isCredentialPageAllowed()) {
              YurrrOverlay.show(pwField);
            }
          });
        }

        this.attachFormSubmitHandler(form, resolveUsernameField, pwField);
        pwField.addEventListener('keydown', (e) => {
          if (!e.isTrusted) return;
          if (e.key === 'Enter') {
            this.handleFormSubmit(
              form,
              resolveUsernameField(),
              this.getSubmitPasswordField(form, pwField),
            );
          }
        });
        continue;
      }

      const isRegistration = YurrrHeuristics.isRegistrationForm(form);

      if (isRegistration) {
        pwField.addEventListener('focus', () => {
          if (this.isCredentialPageAllowed()) {
            YurrrOverlay.show(pwField);
          }
        });

        const emailField = YurrrHeuristics.findRegistrationEmailField(form, pwField) || initialUsernameField;
        if (emailField) {
          this.detectedForms.add(emailField);
          void this.applyEmailSuggestions(emailField);
        }
      } else {
        this.tryAutoFill(initialUsernameField, pwField);

        // Re-evaluate dynamically for multi-step/login forms that mutate fields after initial scan.
        pwField.addEventListener('focus', () => {
          this.tryAutoFill(resolveUsernameField(), pwField, true, pwField);
        });
      }

      this.attachFormSubmitHandler(form, resolveUsernameField, pwField);

      pwField.addEventListener('keydown', (e) => {
        if (!e.isTrusted) return;
        if (e.key === 'Enter') {
          this.handleFormSubmit(form, resolveUsernameField(), this.getSubmitPasswordField(form, pwField));
        }
      });
    }

    // Process standalone username fields for multi-step logins
    const standaloneUsernames = YurrrHeuristics.findStandaloneUsernameFields();
    for (const unField of standaloneUsernames) {
      if (this.detectedForms.has(unField)) continue;
      this.detectedForms.add(unField);

      void this.applyEmailSuggestions(unField);
      this.tryAutoFill(unField, null);

      const form = unField.closest('form');
      if (form) {
        form.addEventListener('submit', (e) => {
          if (!e.isTrusted) return;
          this.handleFormSubmit(form, unField, null);
        });
      }

      unField.addEventListener('keydown', (e) => {
        if (!e.isTrusted) return;
        if (e.key === 'Enter') {
          this.handleFormSubmit(form, unField, null);
        }
      });

      unField.addEventListener('change', () => {
        const username = unField.value || '';
        this.rememberUsername(window.location.hostname, window.location.href, username);
      });
    }
  },

  async tryAutoFill(usernameField, passwordField, openOnReady = false, pickerTarget = null) {
    if (!this.isCredentialPageAllowed()) return;

    const domain = window.location.hostname;

    try {
      let preferredUsername = usernameField?.value || '';
      if (!preferredUsername) {
        preferredUsername = await this.getRememberedUsername(domain);
      }

      const response = await this.sendRuntimeMessage('CHECK_CREDENTIALS', {
        domain,
        preferredUsername,
        pageUrl: window.location.href,
      });
      const creds = response.credentials;
      if (!creds || creds.length === 0) return;

      // Attach picker to fields — opens on focus/click
      this.attachPicker(passwordField, usernameField, passwordField, creds, preferredUsername);
      this.attachPicker(usernameField, usernameField, passwordField, creds, preferredUsername);
      if (openOnReady && pickerTarget?.isConnected && document.activeElement === pickerTarget) {
        this.showPicker(pickerTarget, usernameField, passwordField, creds, preferredUsername);
      }
    } catch {
      // Vault likely locked, do nothing
    }
  },

  attachPicker(targetField, usernameField, passwordField, credentials, preferredUsername = '') {
    if (!targetField) return;
    if (targetField.dataset.yurrrPickerAttached === '1') return;
    targetField.dataset.yurrrPickerAttached = '1';

    let pickerOpen = false;

    const openPicker = () => {
      if (pickerOpen) return;
      pickerOpen = true;
      this.showPicker(targetField, usernameField, passwordField, credentials, preferredUsername, () => {
        pickerOpen = false;
      });
    };

    targetField.addEventListener('focus', openPicker);
    targetField.addEventListener('click', openPicker);
  },

  showPicker(targetField, usernameField, passwordField, credentials, preferredUsername, onClose) {
    this.hidePicker();

    const currentUser = preferredUsername || usernameField?.value || '';

    const host = document.createElement('div');
    Object.assign(host.style, {
      position: 'absolute',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
    });
    const shadow = host.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        .picker {
          background: #1a1a2e;
          border: 1px solid #2ecc71;
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          color: #e0e0e0;
          overflow: hidden;
          animation: fadeIn 0.2s ease;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          background: #16213e;
          border-bottom: 1px solid #0f3460;
        }
        .header svg { width: 16px; height: 16px; fill: #2ecc71; flex-shrink: 0; }
        .title { font-weight: 700; color: #2ecc71; font-size: 13px; }
        .subtitle { font-size: 11px; color: #888; margin-left: auto; }
        .list { padding: 4px 0; max-height: 240px; overflow-y: auto; }
        .item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          cursor: pointer;
          transition: background 0.12s;
        }
        .item:hover { background: #16213e; }
        .item.active { background: rgba(46,204,113,0.08); }
        .avatar {
          width: 32px; height: 32px;
          border-radius: 6px;
          background: #0f3460;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .avatar svg { width: 16px; height: 16px; fill: #2ecc71; }
        .info { flex: 1; min-width: 0; }
        .user {
          font-size: 13px; font-weight: 600; color: #e0e0e0;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pass { font-size: 11px; color: #666; letter-spacing: 2px; margin-top: 2px; }
        .check { width: 18px; height: 18px; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
        .check svg { width: 18px; height: 18px; fill: #2ecc71; }
        .item.active .check { opacity: 1; }
      </style>
      <div class="picker">
        <div class="header">
          <svg viewBox="0 0 24 24"><path d="M12.65 10a6 6 0 1 0-1.3 0H2v4h2v4h4v-4h3.35zM9 6a3 3 0 1 1 0 .01V6z"/></svg>
          <span class="title">Yurrr</span>
          <span class="subtitle">${credentials.length} gespeichert</span>
        </div>
        <div class="list">
          ${credentials
            .map(
              (cred, i) => `
            <div class="item${this.normalizeUsername(cred.username) === this.normalizeUsername(currentUser) ? ' active' : ''}" data-index="${i}">
              <div class="avatar">
                <svg viewBox="0 0 24 24"><path d="M12 12c2.7 0 5-2.3 5-5s-2.3-5-5-5-5 2.3-5 5 2.3 5 5 5zm0 2c-3.3 0-10 1.7-10 5v3h20v-3c0-3.3-6.7-5-10-5z"/></svg>
              </div>
              <div class="info">
                <div class="user">${this.escapeHtml(cred.username)}</div>
                <div class="pass">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
              </div>
              <div class="check">
                <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    `;

    document.body.appendChild(host);
    this.activePicker = host;
    this.positionFloatingHost(host, targetField, 260);

    let closed = false;
    let outsideClickTimer = null;

    const outsideClickHandler = (e) => {
      if (!host.contains(e.target) && e.target !== targetField) {
        this.hidePicker();
      }
    };

    const escHandler = (e) => {
      if (e.key === 'Escape') this.hidePicker();
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (outsideClickTimer !== null) {
        clearTimeout(outsideClickTimer);
        outsideClickTimer = null;
      }
      document.removeEventListener('click', outsideClickHandler);
      document.removeEventListener('keydown', escHandler);
      if (this.activePicker === host) {
        this.activePicker = null;
      }
      if (this.activePickerCleanup === cleanup) {
        this.activePickerCleanup = null;
      }
      host.remove();
      if (onClose) onClose();
    };
    this.activePickerCleanup = cleanup;

    // Click handlers for items
    shadow.querySelectorAll('.item').forEach((item) => {
      item.addEventListener('mousedown', async (e) => {
        e.preventDefault(); // Prevent blur on the input field
        if (item.dataset.loading === '1') return;
        item.dataset.loading = '1';

        const idx = Number.parseInt(item.dataset.index, 10);
        const cred = credentials[idx];

        try {
          let fillCredential = cred;
          if (passwordField) {
            const response = await this.sendRuntimeMessage('GET_CREDENTIAL_FOR_FILL', {
              id: cred.id,
              domain: window.location.hostname,
              pageUrl: window.location.href,
              userGesture: true,
            });
            fillCredential = response?.credential;
          }

          if (!fillCredential) return;
          this.fillFields(usernameField, passwordField, fillCredential);
          this.rememberUsername(window.location.hostname, window.location.href, fillCredential.username);
        } catch {
          return;
        } finally {
          item.dataset.loading = '0';
        }

        shadow.querySelectorAll('.item').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');

        setTimeout(() => this.hidePicker(), 150);
      });
    });

    // Close on outside click (delayed to avoid catching the triggering click)
    outsideClickTimer = setTimeout(() => {
      outsideClickTimer = null;
      if (!closed) {
        document.addEventListener('click', outsideClickHandler);
      }
    }, 0);

    // Close on Escape
    document.addEventListener('keydown', escHandler);
  },

  hidePicker() {
    if (this.activePickerCleanup) {
      const cleanup = this.activePickerCleanup;
      this.activePickerCleanup = null;
      cleanup();
      return;
    }

    if (this.activePicker) {
      this.activePicker.remove();
    }
    this.activePicker = null;
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  fillFields(usernameField, passwordField, credential) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    if (usernameField && credential.username) {
      nativeSetter.call(usernameField, credential.username);
      usernameField.dispatchEvent(new Event('input', { bubbles: true }));
      usernameField.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (passwordField && credential.password) {
      nativeSetter.call(passwordField, credential.password);
      passwordField.dispatchEvent(new Event('input', { bubbles: true }));
      passwordField.dispatchEvent(new Event('change', { bubbles: true }));
    }
  },

  isYurrrGeneratedPassword(form, passwordField, password) {
    if (!passwordField || !password) return false;

    const candidates = [passwordField, form].filter(Boolean);
    const store = globalThis.YurrrGeneratedPasswordStore;
    if (!store) return false;

    const now = Date.now();

    return candidates.some((el) => {
      const generated = store.get(el);
      return (
        generated?.password === password &&
        Number.isFinite(generated.generatedAt) &&
        now - generated.generatedAt <= this.GENERATED_PASSWORD_MAX_AGE_MS
      );
    });
  },

  hasLikelyPostSubmitTransition(startUrl, form, passwordField) {
    if (window.location.href !== startUrl) return true;
    if (form && (!form.isConnected || YurrrHeuristics.isHidden(form))) return true;
    if (passwordField && (!passwordField.isConnected || YurrrHeuristics.isHidden(passwordField))) return true;
    return false;
  },

  queueGeneratedPasswordSavePrompt(url, username, password, domain, form, passwordField) {
    if (this.savePromptTimer) {
      clearTimeout(this.savePromptTimer);
    }

    const startedAt = Date.now();
    let transitionStartedAt = null;
    const checkForTransition = () => {
      if (document.visibilityState === 'hidden') {
        this.savePromptTimer = null;
        return;
      }

      if (this.hasLikelyPostSubmitTransition(url, form, passwordField)) {
        transitionStartedAt ||= Date.now();
        if (Date.now() - transitionStartedAt >= this.POST_SUBMIT_TRANSITION_STABLE_MS) {
          this.savePromptTimer = null;
          this.showSaveBanner(url, username, password, domain);
          return;
        }
      } else {
        transitionStartedAt = null;
      }

      if (Date.now() - startedAt >= this.POST_SUBMIT_TRANSITION_TIMEOUT_MS) {
        this.savePromptTimer = null;
        return;
      }

      this.savePromptTimer = setTimeout(checkForTransition, this.POST_SUBMIT_TRANSITION_CHECK_MS);
    };

    this.savePromptTimer = setTimeout(checkForTransition, this.GENERATED_PASSWORD_PROMPT_DELAY_MS);
  },

  disarmPendingCredentialsPromptReady() {
    if (!this.pendingPromptReadyCleanup) return;
    const cleanup = this.pendingPromptReadyCleanup;
    this.pendingPromptReadyCleanup = null;
    cleanup();
  },

  armPendingCredentialsPromptReady(payload) {
    this.disarmPendingCredentialsPromptReady();

    let armed = true;
    let timeoutId = null;
    const readyPayload = {
      ...payload,
      promptReady: true,
    };

    const cleanup = () => {
      if (!armed) return;
      armed = false;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      window.removeEventListener('pagehide', markReady);
      window.removeEventListener('beforeunload', markReady);
      if (this.pendingPromptReadyCleanup === cleanup) {
        this.pendingPromptReadyCleanup = null;
      }
    };

    const markReady = () => {
      if (!armed) return;
      cleanup();
      try {
        chrome.runtime.sendMessage({ type: 'PENDING_CREDENTIALS', payload: readyPayload });
      } catch {
        // Best-effort marker during navigation.
      }
    };

    this.pendingPromptReadyCleanup = cleanup;
    window.addEventListener('pagehide', markReady);
    window.addEventListener('beforeunload', markReady);
    timeoutId = setTimeout(cleanup, this.PENDING_PROMPT_READY_ARM_MS);
  },

  async handleFormSubmit(form, usernameField, passwordField) {
    if (!this.isCredentialPageAllowed()) return;

    const url = window.location.href;
    const domain = window.location.hostname;
    const resolvedUsernameField = usernameField || YurrrHeuristics.findRegistrationEmailField(form, passwordField);
    const typedUsername = String(resolvedUsernameField?.value || '').trim();
    const password = passwordField?.value;

    // Step 1 of multi-step login: remember identifier/email for the upcoming password step.
    if (!password) {
      if (typedUsername) {
        await this.rememberUsername(domain, url, typedUsername);
      }
      return;
    }

    const username = typedUsername;
    const pendingPayload = {
      url,
      domain,
      pageUrl: url,
      username,
      password,
      promptReady: false,
    };

    const pendingStore = this.sendRuntimeMessage('PENDING_CREDENTIALS', pendingPayload);
    this.armPendingCredentialsPromptReady(pendingPayload);
    try {
      const response = await pendingStore;
      if (response?.stored === false) {
        this.disarmPendingCredentialsPromptReady();
        return;
      }
    } catch {
      this.disarmPendingCredentialsPromptReady();
      return;
    }

    if (this.isYurrrGeneratedPassword(form, passwordField, password)) {
      this.queueGeneratedPasswordSavePrompt(url, username, password, domain, form, passwordField);
    }
  },

  async checkPendingCredentials() {
    if (!this.isCredentialPageAllowed()) return;

    const domain = window.location.hostname;

    try {
      const response = await this.sendRuntimeMessage('CHECK_PENDING_CREDENTIALS', {
        domain,
        pageUrl: window.location.href,
      });

      if (response.hasPending) {
        const { url, username, password } = response.credentials;
        this.showSaveBanner(url, username, password, domain, {
          action: response.credentials.action,
          entryId: response.credentials.entryId,
          message: response.credentials.message,
        });
      }
    } catch {
      // Silent fail
    }
  },

  showSaveBanner(url, username, password, domain = window.location.hostname, options = {}) {
    if (this.saveBannerCleanup) {
      this.saveBannerCleanup(false);
    } else {
      const existing = document.getElementById('yurrr-save-banner');
      if (existing) existing.remove();
    }

    const banner = document.createElement('div');
    banner.id = 'yurrr-save-banner';
    const initialMessage = options.message || `Save password for ${domain}?`;
    const initialButtonLabel = options.action === 'update' ? 'Update' : 'Save';
    banner.innerHTML = `
      <div class="yurrr-banner-text">
        <strong>Yurrr</strong> &mdash; ${this.escapeHtml(initialMessage)}
      </div>
      <div class="yurrr-banner-actions">
        <button class="yurrr-banner-save">${this.escapeHtml(initialButtonLabel)}</button>
        <button class="yurrr-banner-dismiss">Dismiss</button>
      </div>
    `;

    document.body.appendChild(banner);

    let autoDismissTimer = null;
    let pendingPassword = password;
    const dismissBanner = (clearPending = true) => {
      clearTimeout(autoDismissTimer);
      if (this.saveBannerCleanup === dismissBanner) {
        this.saveBannerCleanup = null;
      }
      pendingPassword = '';
      if (clearPending) {
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_USERNAME', payload: { domain } });
      }
      banner.remove();
    };
    this.saveBannerCleanup = dismissBanner;

    const textEl = banner.querySelector('.yurrr-banner-text');
    const saveBtn = banner.querySelector('.yurrr-banner-save');
    const saveBtnOriginalLabel = saveBtn.textContent;
    let confirmUpdateEntryId = options.action === 'update' && options.entryId
      ? String(options.entryId)
      : null;

    const setBannerMessage = (message, isError = false) => {
      textEl.innerHTML = `<strong>Yurrr</strong> &mdash; ${this.escapeHtml(message)}`;
      textEl.dataset.variant = isError ? 'error' : 'info';
    };

    autoDismissTimer = setTimeout(() => {
      if (banner.parentNode) {
        dismissBanner();
      }
    }, this.SAVE_BANNER_TTL_MS);

    saveBtn.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      saveBtn.disabled = true;
      setBannerMessage('Saving password...');
      try {
        const response = await this.sendRuntimeMessage('FORM_SUBMITTED', {
          url,
          pageUrl: window.location.href,
          username,
          password: pendingPassword,
          entryId: confirmUpdateEntryId,
          confirmUpdate: Boolean(confirmUpdateEntryId),
        });

        if (response?.saved) {
          this.emailSuggestionsCache = null;
          this.emailSuggestionsCacheAt = 0;
          dismissBanner();
          return;
        }

        if (response?.reason === 'confirm_update' && response.entryId) {
          confirmUpdateEntryId = response.entryId;
          setBannerMessage(response.message || 'Update the existing saved login?');
          saveBtn.textContent = 'Update';
          saveBtn.disabled = false;
          return;
        }

        setBannerMessage(response?.message || 'Password was not saved. Unlock Yurrr and try again.', true);
        saveBtn.textContent = saveBtnOriginalLabel;
        saveBtn.disabled = false;
        return;
      } catch {
        setBannerMessage('Password was not saved. Unlock Yurrr and try again.', true);
        saveBtn.textContent = saveBtnOriginalLabel;
        saveBtn.disabled = false;
        return;
      }
    });

    banner.querySelector('.yurrr-banner-dismiss').addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      dismissBanner();
    });
  },
};

// Start detection
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => YurrrDetector.init());
} else {
  YurrrDetector.init();
}
