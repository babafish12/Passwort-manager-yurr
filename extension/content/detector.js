// Form detection, auto-fill, and save prompt
const YurrrDetector = {
  initialized: false,
  detectedForms: new WeakSet(),
  detectedAddressFields: new WeakSet(),
  activePicker: null,
  activePickerCleanup: null,
  activeEmailPicker: null,
  activeEmailPickerCleanup: null,
  activeAddressPicker: null,
  activeAddressPickerCleanup: null,
  scanQueued: false,
  emailSuggestionsCache: null,
  emailSuggestionsCacheAt: 0,
  autofilledPasswordFields: new WeakMap(),
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

    this.refresh({ retryKnown: false });

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

  refresh({ retryKnown = true } = {}) {
    this.removeEmailSuggestionsDatalist();
    void this.checkPendingCredentials();
    this.scanForms({ retryKnown });
    return true;
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

  isHttpDevHost(hostname) {
    return YurrrSiteScope.isLocalHost(hostname);
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
          background: #172024;
          border: 1px solid #d8b24c;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(23, 32, 36, 0.34);
          color: #eef3ef;
          font-family: 'Atkinson Hyperlegible', Aptos, 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          overflow: hidden;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 14px;
          background: #243039;
          border-bottom: 1px solid rgba(216, 178, 76, 0.32);
        }
        .title { font-weight: 760; color: #d8b24c; font-size: 13px; }
        .subtitle { color: #aab5b0; font-size: 11px; }
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
        .item:hover { background: #243039; }
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
        this.rememberUsername(YurrrSiteScope.key(window.location.href), window.location.href, email);
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

  selectCredential(credentials, preferredUsername, lastSelectedCredentialId = null) {
    if (!credentials.length) return null;
    const preferred = this.normalizeUsername(preferredUsername);
    const lastSelected = lastSelectedCredentialId
      ? credentials.find((cred) => String(cred.id) === String(lastSelectedCredentialId))
      : null;

    if (!preferred) {
      return lastSelected || (credentials.length === 1 ? credentials[0] : null);
    }

    const exactMatches = credentials
      .filter((cred) => this.normalizeUsername(cred.username) === preferred);
    if (lastSelected && this.normalizeUsername(lastSelected.username) === preferred) {
      return lastSelected;
    }

    return exactMatches.length === 1 ? exactMatches[0] : null;
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

  scanForms({ retryKnown = false } = {}) {
    const passwordFields = document.querySelectorAll('input[type="password"]');

    for (const pwField of passwordFields) {
      const form = pwField.closest('form');
      const resolveUsernameField = () => YurrrHeuristics.findUsernameField(pwField);
      const initialUsernameField = resolveUsernameField();

      if (this.detectedForms.has(pwField)) {
        const shouldRetryKnown = retryKnown
          || (
            this.autofilledPasswordFields.has(pwField) &&
            String(pwField.value || '').length === 0
          );
        if (shouldRetryKnown) {
          const isPasswordChange = YurrrHeuristics.isPasswordChangeForm(form);
          const isRegistration = YurrrHeuristics.isRegistrationForm(form);
          const currentPasswordField = isPasswordChange
            ? YurrrHeuristics.findCurrentPasswordField(form)
            : null;
          if (!isRegistration && (!isPasswordChange || pwField === currentPasswordField)) {
            this.tryAutoFill(initialUsernameField, pwField, { allowAutofill: true });
          }
        }
        continue;
      }
      this.detectedForms.add(pwField);

      if (initialUsernameField) {
        this.detectedForms.add(initialUsernameField);
      }

      const isPasswordChange = YurrrHeuristics.isPasswordChangeForm(form);
      if (isPasswordChange) {
        const currentPasswordField = YurrrHeuristics.findCurrentPasswordField(form);
        if (pwField === currentPasswordField) {
          this.tryAutoFill(initialUsernameField, pwField, { allowAutofill: true });
          this.retryAutoFillOnInteraction(pwField, resolveUsernameField, pwField, { allowAutofill: true });
          pwField.addEventListener('focus', () => {
            const usernameField = resolveUsernameField();
            this.attachPicker(pwField, usernameField, pwField);
            this.attachPicker(usernameField, usernameField, pwField);
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
        this.tryAutoFill(initialUsernameField, pwField, { allowAutofill: true });
        this.retryAutoFillOnInteraction(pwField, resolveUsernameField, pwField, { allowAutofill: true });

        // Re-evaluate dynamically for multi-step/login forms that mutate fields after initial scan.
        pwField.addEventListener('focus', () => {
          const usernameField = resolveUsernameField();
          this.attachPicker(pwField, usernameField, pwField);
          this.attachPicker(usernameField, usernameField, pwField);
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
      this.retryAutoFillOnInteraction(unField, unField, null);

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
        this.rememberUsername(YurrrSiteScope.key(window.location.href), window.location.href, username);
      });
    }

    this.scanAddressFields();
  },

  getAddressFieldScope(field) {
    return field?.closest('fieldset') || field?.closest('form') || document;
  },

  scanAddressFields() {
    if (!this.isCredentialPageAllowed()) return;

    const scopes = new Set();
    const candidates = Array.from(document.querySelectorAll(YurrrHeuristics.addressFieldSelector || ''));
    for (const field of candidates) {
      if (!YurrrHeuristics.getAddressFieldKind(field)) continue;
      scopes.add(this.getAddressFieldScope(field));
    }

    for (const scope of scopes) {
      const fields = YurrrHeuristics.findAddressFields(scope);
      for (const field of fields) {
        if (this.detectedAddressFields.has(field)) continue;
        this.detectedAddressFields.add(field);
        this.attachAddressPicker(field);
      }
    }
  },

  attachAddressPicker(field) {
    if (!field || field.dataset.yurrrAddressPickerAttached === '1') return;
    field.dataset.yurrrAddressPickerAttached = '1';

    let pickerOpen = false;
    const openPicker = async (event) => {
      if (!event.isTrusted) return;
      if (pickerOpen) return;
      pickerOpen = true;
      const opened = await this.openAddressPicker(field, () => {
        pickerOpen = false;
      });
      if (!opened) pickerOpen = false;
    };

    field.addEventListener('focus', openPicker);
    field.addEventListener('click', openPicker);
  },

  async loadAddressesForFill() {
    const response = await this.sendRuntimeMessage('LIST_ADDRESSES_FOR_FILL', {
      pageUrl: window.location.href,
      userGesture: true,
    });
    return Array.isArray(response?.addresses) ? response.addresses : [];
  },

  async openAddressPicker(targetField, onClose) {
    if (!targetField?.isConnected || !this.isCredentialPageAllowed()) return false;
    if (!this.getAddressFieldsForScope(targetField).length) return false;

    try {
      const addresses = await this.loadAddressesForFill();
      if (!addresses.length || !targetField.isConnected || document.activeElement !== targetField) return false;
      this.showAddressPicker(targetField, addresses, onClose);
      return true;
    } catch {
      return false;
    }
  },

  getAddressLabel(address) {
    return String(address?.label || address?.full_name || 'Address').trim();
  },

  getAddressSubtitle(address) {
    const cityLine = [address?.postal_code, address?.city].filter(Boolean).join(' ');
    return [address?.line1, cityLine, address?.country].filter(Boolean).join(', ');
  },

  showAddressPicker(targetField, addresses, onClose) {
    this.hideAddressPicker();
    this.hidePicker();
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
          background: #172024;
          border: 1px solid #d8b24c;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(23, 32, 36, 0.34);
          color: #eef3ef;
          font-family: 'Atkinson Hyperlegible', Aptos, 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          overflow: hidden;
        }
        .header {
          align-items: center;
          background: #243039;
          border-bottom: 1px solid rgba(216, 178, 76, 0.32);
          display: flex;
          gap: 8px;
          padding: 10px 14px;
        }
        .header svg { fill: #d8b24c; flex-shrink: 0; height: 16px; width: 16px; }
        .title { color: #d8b24c; font-size: 13px; font-weight: 760; }
        .subtitle { color: #aab5b0; font-size: 11px; margin-left: auto; }
        .list { max-height: 240px; overflow-y: auto; padding: 4px 0; }
        .item {
          align-items: center;
          cursor: pointer;
          display: flex;
          gap: 10px;
          padding: 10px 14px;
          transition: background 0.12s;
        }
        .item:hover { background: #243039; }
        .item.active { background: rgba(104,199,184,0.12); }
        .avatar {
          align-items: center;
          background: #243039;
          border-radius: 6px;
          display: flex;
          flex-shrink: 0;
          height: 32px;
          justify-content: center;
          width: 32px;
        }
        .avatar svg { fill: #d8b24c; height: 16px; width: 16px; }
        .info { flex: 1; min-width: 0; }
        .name {
          color: #eef3ef;
          font-size: 13px;
          font-weight: 700;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .details {
          color: #aab5b0;
          font-size: 11px;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .check { flex-shrink: 0; height: 18px; opacity: 0; transition: opacity 0.15s; width: 18px; }
        .check svg { fill: #68c7b8; height: 18px; width: 18px; }
        .item.active .check { opacity: 1; }
      </style>
      <div class="picker">
        <div class="header">
          <svg viewBox="0 0 24 24"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
          <span class="title">Yurrr</span>
          <span class="subtitle">${addresses.length} Adressen</span>
        </div>
        <div class="list">
          ${addresses
            .map((address, i) => `
              <div class="item" data-index="${i}">
                <div class="avatar">
                  <svg viewBox="0 0 24 24"><path d="M12 2 2 7v15h20V7L12 2zm0 2.2 7 3.5V20H5V7.7l7-3.5zM8 10h8v2H8v-2zm0 4h8v2H8v-2z"/></svg>
                </div>
                <div class="info">
                  <div class="name">${this.escapeHtml(this.getAddressLabel(address))}</div>
                  <div class="details">${this.escapeHtml(this.getAddressSubtitle(address))}</div>
                </div>
                <div class="check">
                  <svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                </div>
              </div>
            `)
            .join('')}
        </div>
      </div>
    `;

    document.body.appendChild(host);
    this.activeAddressPicker = host;
    this.positionFloatingHost(host, targetField, 280);

    let closed = false;
    let outsideClickTimer = null;

    const outsideClickHandler = (e) => {
      if (!host.contains(e.target) && e.target !== targetField) {
        this.hideAddressPicker();
      }
    };

    const escHandler = (e) => {
      if (e.key === 'Escape') this.hideAddressPicker();
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
      if (this.activeAddressPicker === host) {
        this.activeAddressPicker = null;
      }
      if (this.activeAddressPickerCleanup === cleanup) {
        this.activeAddressPickerCleanup = null;
      }
      host.remove();
      if (onClose) onClose();
    };
    this.activeAddressPickerCleanup = cleanup;

    shadow.querySelectorAll('.item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number.parseInt(item.dataset.index, 10);
        const address = addresses[idx];
        this.fillAddressFields(targetField, address);

        shadow.querySelectorAll('.item').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');

        setTimeout(() => this.hideAddressPicker(), 150);
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

  hideAddressPicker() {
    if (this.activeAddressPickerCleanup) {
      const cleanup = this.activeAddressPickerCleanup;
      this.activeAddressPickerCleanup = null;
      cleanup();
      return;
    }

    if (this.activeAddressPicker) {
      this.activeAddressPicker.remove();
    }
    this.activeAddressPicker = null;
  },

  getAddressFieldsForScope(targetField) {
    const scope = this.getAddressFieldScope(targetField);
    const group = (field) => YurrrHeuristics.getAutocompleteTokens(field)
      .filter((token) => token.startsWith('section-') || token === 'shipping' || token === 'billing')
      .join(' ');
    const targetGroup = group(targetField);
    return YurrrHeuristics.findAddressFields(scope).filter((field) => group(field) === targetGroup);
  },

  getNameParts(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length <= 1) {
      return { givenName: parts[0] || '', familyName: '' };
    }

    return {
      givenName: parts.slice(0, -1).join(' '),
      familyName: parts[parts.length - 1],
    };
  },

  getAddressValueForKind(kind, address, field) {
    const fullName = String(address?.full_name || '').trim();
    const { givenName, familyName } = this.getNameParts(fullName);
    const line1 = String(address?.line1 || '').trim();
    const line2 = String(address?.line2 || '').trim();

    switch (kind) {
      case 'given_name':
        return givenName;
      case 'family_name':
        return familyName;
      case 'full_name':
        return fullName;
      case 'street_address': {
        if ((field?.tagName || '').toLowerCase() === 'textarea') {
          return [line1, line2].filter(Boolean).join('\n');
        }
        return [line1, line2].filter(Boolean).join(', ');
      }
      case 'line1':
        return line1;
      case 'line2':
        return line2;
      case 'city':
        return String(address?.city || '').trim();
      case 'postal_code':
        return String(address?.postal_code || '').trim();
      case 'country':
        return String(address?.country || '').trim();
      default:
        return '';
    }
  },

  normalizeSelectMatch(value) {
    return String(value || '').trim().toLowerCase().replace(/[\s._-]+/g, '');
  },

  findMatchingSelectOption(select, value) {
    const needle = this.normalizeSelectMatch(value);
    if (!needle) return null;

    return Array.from(select.options || []).find((option) => {
      const candidates = [
        option.value,
        option.textContent,
        option.label,
      ].map((item) => this.normalizeSelectMatch(item));
      return candidates.includes(needle);
    }) || null;
  },

  setFieldValue(field, value) {
    const normalized = String(value || '').trim();
    if (!field || !normalized) return false;

    const tagName = String(field.tagName || '').toLowerCase();
    if (tagName === 'select') {
      const option = this.findMatchingSelectOption(field, normalized);
      if (!option) return false;
      field.value = option.value;
    } else if (tagName === 'textarea') {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(field, normalized);
      } else {
        field.value = normalized;
      }
    } else {
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(field, normalized);
      } else {
        field.value = normalized;
      }
    }

    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  },

  fillAddressFields(targetField, address) {
    if (!address) return;

    const fields = this.getAddressFieldsForScope(targetField);
    for (const field of fields) {
      const kind = YurrrHeuristics.getAddressFieldKind(field);
      const value = this.getAddressValueForKind(kind, address, field);
      this.setFieldValue(field, value);
    }
  },

  async loadCredentialsForFields(usernameField) {
    const domain = YurrrSiteScope.key(window.location.href);
    let preferredUsername = String(usernameField?.value || '').trim();
    if (!preferredUsername) {
      preferredUsername = await this.getRememberedUsername(domain);
    }

    const response = await this.sendRuntimeMessage('CHECK_CREDENTIALS', {
      domain,
      preferredUsername,
      pageUrl: window.location.href,
    });

    return {
      credentials: Array.isArray(response?.credentials) ? response.credentials : [],
      preferredUsername,
      lastSelectedCredentialId: response?.lastSelectedCredentialId || null,
    };
  },

  canAutofillWithCredential(usernameField, passwordField, credential, options = {}) {
    if (!passwordField || !credential?.id) return false;
    if (!passwordField.isConnected) return false;
    if (passwordField.disabled || passwordField.readOnly) return false;
    if (YurrrHeuristics.isHidden(passwordField)) return false;
    if (String(passwordField.value || '').length > 0) return false;

    if (!usernameField) {
      return options.allowMissingUsername === true;
    }

    if (!usernameField.isConnected || YurrrHeuristics.isHidden(usernameField)) return false;

    const currentUsername = String(usernameField.value || '').trim();
    if (!currentUsername) return options.allowMissingUsername === true;

    return this.normalizeUsername(currentUsername) === this.normalizeUsername(credential.username);
  },

  shouldAutofillCredentialWithoutTypedUsername(credential, credentials, preferredUsername, lastSelectedCredentialId) {
    if (!credential?.id) return false;

    const preferred = this.normalizeUsername(preferredUsername);
    if (preferred) {
      const matchingCredentials = credentials
        .filter((item) => this.normalizeUsername(item.username) === preferred);
      if (lastSelectedCredentialId && String(credential.id) === String(lastSelectedCredentialId)) {
        return matchingCredentials.some((item) => String(item.id) === String(credential.id));
      }

      return matchingCredentials.length === 1 &&
        String(matchingCredentials[0].id) === String(credential.id);
    }

    if (lastSelectedCredentialId && String(credential.id) === String(lastSelectedCredentialId)) {
      return true;
    }

    return credentials.length === 1;
  },

  async tryDirectAutofill(usernameField, passwordField, credentials, preferredUsername, lastSelectedCredentialId) {
    if (!passwordField) {
      return;
    }

    if (
      this.autofilledPasswordFields.has(passwordField) &&
      String(passwordField.value || '').length > 0
    ) {
      return;
    }

    const credential = this.selectCredential(credentials, preferredUsername, lastSelectedCredentialId);
    const typedUsername = String(usernameField?.value || '').trim();
    const allowMissingUsername = !typedUsername
      && this.shouldAutofillCredentialWithoutTypedUsername(
        credential,
        credentials,
        preferredUsername,
        lastSelectedCredentialId,
      );
    if (!this.canAutofillWithCredential(usernameField, passwordField, credential, { allowMissingUsername })) {
      return;
    }

    try {
      const response = await this.sendRuntimeMessage('GET_CREDENTIAL_FOR_AUTOFILL', {
        id: credential.id,
        domain: YurrrSiteScope.key(window.location.href),
        pageUrl: window.location.href,
      });
      const fillCredential = response?.credential;
      const allowReturnedMissingUsername = !typedUsername
        && this.shouldAutofillCredentialWithoutTypedUsername(
          fillCredential,
          credentials,
          preferredUsername,
          lastSelectedCredentialId,
        );
      if (!this.canAutofillWithCredential(
        usernameField,
        passwordField,
        fillCredential,
        { allowMissingUsername: allowReturnedMissingUsername },
      )) {
        return;
      }

      this.fillFields(usernameField, passwordField, fillCredential);
      this.autofilledPasswordFields.set(passwordField, {
        credentialId: String(fillCredential.id),
        filledAt: Date.now(),
      });
    } catch {
      // Autofill is opt-in and best-effort; manual picker remains available.
    }
  },

  async tryAutoFill(usernameField, passwordField, options = {}) {
    if (!this.isCredentialPageAllowed()) return;

    const { allowAutofill = false } = options;

    this.attachPicker(passwordField, usernameField, passwordField);
    this.attachPicker(usernameField, usernameField, passwordField);

    try {
      const {
        credentials,
        preferredUsername,
        lastSelectedCredentialId,
      } = await this.loadCredentialsForFields(usernameField);
      if (!credentials.length) return;

      if (allowAutofill) {
        await this.tryDirectAutofill(
          usernameField,
          passwordField,
          credentials,
          preferredUsername,
          lastSelectedCredentialId,
        );
      }
    } catch {
      // Vault likely locked, do nothing
    }
  },

  retryAutoFillOnInteraction(targetField, resolveUsernameField, passwordField, options = {}) {
    if (!targetField || targetField.dataset.yurrrAutofillRetryAttached === '1') return;
    targetField.dataset.yurrrAutofillRetryAttached = '1';

    let retryQueued = false;
    const retry = () => {
      if (retryQueued) return;
      retryQueued = true;

      setTimeout(() => {
        retryQueued = false;
      }, 250);

      const usernameField = typeof resolveUsernameField === 'function'
        ? resolveUsernameField()
        : resolveUsernameField;
      void this.tryAutoFill(usernameField, passwordField, options);
    };

    targetField.addEventListener('focus', retry);
    targetField.addEventListener('click', retry);
  },

  async openCredentialPicker(targetField, usernameField, passwordField, onClose) {
    if (!targetField?.isConnected) return false;

    try {
      const { credentials, preferredUsername } = await this.loadCredentialsForFields(usernameField);
      if (!credentials.length || !targetField.isConnected) return false;
      this.showPicker(targetField, usernameField, passwordField, credentials, preferredUsername, onClose);
      return true;
    } catch {
      return false;
    }
  },

  attachPicker(targetField, usernameField, passwordField) {
    if (!targetField) return;
    targetField.yurrrPickerContext = { usernameField, passwordField };
    if (targetField.dataset.yurrrPickerAttached === '1') return;
    targetField.dataset.yurrrPickerAttached = '1';

    let pickerOpen = false;

    const openPicker = async () => {
      if (pickerOpen) return;
      pickerOpen = true;
      const context = targetField.yurrrPickerContext || {};
      const resolvedPasswordField = context.passwordField
        || ((targetField.type || '').toLowerCase() === 'password' ? targetField : null);
      const resolvedUsernameField = resolvedPasswordField
        ? YurrrHeuristics.findUsernameField(resolvedPasswordField) || context.usernameField
        : context.usernameField || targetField;
      const opened = await this.openCredentialPicker(targetField, resolvedUsernameField, resolvedPasswordField, () => {
        pickerOpen = false;
      });
      if (!opened) pickerOpen = false;
    };

    targetField.addEventListener('focus', openPicker);
    targetField.addEventListener('click', openPicker);
  },

  async rememberSelectedCredential(id) {
    if (!id) return;
    try {
      await this.sendRuntimeMessage('REMEMBER_SELECTED_CREDENTIAL', {
        id,
        domain: YurrrSiteScope.key(window.location.href),
        pageUrl: window.location.href,
      });
    } catch {
      // Remembering the last manual pick is non-critical.
    }
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
          background: #172024;
          border: 1px solid #d8b24c;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(23, 32, 36, 0.34);
          font-family: 'Atkinson Hyperlegible', Aptos, 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          color: #eef3ef;
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
          background: #243039;
          border-bottom: 1px solid rgba(216, 178, 76, 0.32);
        }
        .header svg { width: 16px; height: 16px; fill: #d8b24c; flex-shrink: 0; }
        .title { font-weight: 760; color: #d8b24c; font-size: 13px; }
        .subtitle { font-size: 11px; color: #aab5b0; margin-left: auto; }
        .list { padding: 4px 0; max-height: 240px; overflow-y: auto; }
        .item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          cursor: pointer;
          transition: background 0.12s;
        }
        .item:hover { background: #243039; }
        .item.active { background: rgba(104,199,184,0.12); }
        .avatar {
          width: 32px; height: 32px;
          border-radius: 6px;
          background: #243039;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .avatar svg { width: 16px; height: 16px; fill: #d8b24c; }
        .info { flex: 1; min-width: 0; }
        .user {
          font-size: 13px; font-weight: 700; color: #eef3ef;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .pass { font-size: 11px; color: #aab5b0; letter-spacing: 2px; margin-top: 2px; }
        .check { width: 18px; height: 18px; flex-shrink: 0; opacity: 0; transition: opacity 0.15s; }
        .check svg { width: 18px; height: 18px; fill: #68c7b8; }
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
              domain: YurrrSiteScope.key(window.location.href),
              pageUrl: window.location.href,
              userGesture: true,
            });
            fillCredential = response?.credential;
          }

          if (!fillCredential) return;
          this.fillFields(usernameField, passwordField, fillCredential);
          this.rememberUsername(YurrrSiteScope.key(window.location.href), window.location.href, fillCredential.username);
          void this.rememberSelectedCredential(fillCredential.id);
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
    const domain = YurrrSiteScope.key(window.location.href);
    const isPasswordChange = YurrrHeuristics.isPasswordChangeForm(form);
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
      isPasswordChange,
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

    const domain = YurrrSiteScope.key(window.location.href);

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

  showSaveBanner(url, username, password, domain = YurrrSiteScope.key(window.location.href), options = {}) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'YURRR_REFRESH_FORMS') {
    return false;
  }

  Promise.resolve(YurrrDetector.refresh())
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
