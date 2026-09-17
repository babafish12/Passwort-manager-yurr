// Form detection, auto-fill, and save prompt
const YurrrDetector = {
  initialized: false,
  detectedForms: new WeakSet(),
  detectedPasswords: new WeakSet(),
  detectedAddressFields: new WeakSet(),
  activePicker: null,
  activePickerCleanup: null,
  activeEmailPicker: null,
  activeEmailPickerCleanup: null,
  activeAddressPicker: null,
  activeAddressPickerCleanup: null,
  scanQueued: false,
  scanScopes: new Set(),
  observedRoots: new Map(),
  UI_SELECTOR: '#yurrr-save-banner, #yurrr-save-status, #yurrr-overlay-host, [data-yurrr-ui]',
  FIELD_SELECTOR: 'input, textarea, select, form, [role="form"], label',
  emailSuggestionsCache: null,
  emailSuggestionsCacheAt: 0,
  autofilledPasswordFields: new WeakMap(),
  submittingScopes: new WeakSet(),
  submissionGeneration: 0,
  saveBannerSubmissionId: null,
  savePromptTimer: null,
  saveBannerCleanup: null,
  saveStatusCleanup: null,
  pendingCheckGeneration: 0,
  pendingRetryTimer: null,
  pendingPromptReadyCleanup: null,
  EMAIL_SUGGESTIONS_LIST_ID: 'yurrr-email-suggestions-list',
  MAX_VISIBLE_EMAIL_SUGGESTIONS: 8,
  POST_SUBMIT_PROMPT_DELAY_MS: 700,
  POST_SUBMIT_TRANSITION_TIMEOUT_MS: 30000,
  POST_SUBMIT_TRANSITION_CHECK_MS: 250,
  POST_SUBMIT_TRANSITION_STABLE_MS: 1000,
  PENDING_PROMPT_READY_ARM_MS: 30000,
  SAVE_BANNER_TTL_MS: 5 * 60 * 1000,

  init() {
    if (this.initialized) return;
    this.initialized = true;

    document.addEventListener('submit', (event) => this.captureSubmission(event), true);
    document.addEventListener('click', (event) => this.captureSubmission(event), true);
    document.addEventListener('keydown', (event) => this.captureSubmission(event), true);
    document.addEventListener('focus', (event) => {
      const field = event.composedPath()[0];
      const root = field?.getRootNode();
      if (root?.host && root.mode === 'open' && !this.observedRoots.has(root)) {
        this.observeRoot(root);
        this.scanForms({ scope: root });
      }
    }, true);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.checkPendingCredentials();
    });
    this.refresh({ retryKnown: false });

  },

  observeRoot(root) {
    if (this.observedRoots.has(root)) return;
    const observer = new MutationObserver((records) => this.handleMutations(records));
    observer.observe(root === document ? document.documentElement : root, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['type', 'autocomplete', 'form', 'hidden', 'disabled', 'readonly', 'class', 'style'],
    });
    const submit = (event) => this.captureSubmission(event);
    if (root !== document) root.addEventListener('submit', submit, true);
    this.observedRoots.set(root, { observer, submit });
  },

  discoverRoots(node) {
    for (const el of [node, ...node.querySelectorAll?.('*') || []]) {
      if (!el.shadowRoot || el.closest?.(this.UI_SELECTOR)) continue;
      if (!this.observedRoots.has(el.shadowRoot)) {
        this.observeRoot(el.shadowRoot);
        this.queueScan(el.shadowRoot);
      }
      this.discoverRoots(el.shadowRoot);
    }
  },

  handleMutations(records) {
    for (const record of records) {
      const target = record.target;
      if (target.closest?.(this.UI_SELECTOR)) continue;
      if (record.type === 'childList') {
        const changed = [...record.addedNodes, ...record.removedNodes].filter((node) => node.nodeType === 1);
        for (const node of record.addedNodes) {
          if (node.nodeType === 1 && !node.matches(this.UI_SELECTOR)) this.discoverRoots(node);
        }
        if (!changed.some((node) => !node.matches(this.UI_SELECTOR) &&
            (node.matches(this.FIELD_SELECTOR) || node.querySelector(this.FIELD_SELECTOR)))) continue;
      } else if (!target.matches?.(this.FIELD_SELECTOR) && !target.querySelector?.(this.FIELD_SELECTOR)) {
        continue;
      }
      const scope = YurrrHeuristics.getForm(target) ||
        (target.matches?.('input, textarea, select') ? target.getRootNode() : target);
      this.queueScan(scope);
      // Controls using form= may be outside the mutated subtree.
      for (const node of record.addedNodes || []) {
        if (node.form) this.queueScan(node.form);
      }
    }
    for (const [root, { observer, submit }] of this.observedRoots) {
      if (root.host && !root.host.isConnected) {
        observer.disconnect();
        root.removeEventListener('submit', submit, true);
        this.observedRoots.delete(root);
      }
    }
  },

  queueScan(scope) {
    this.scanScopes.add(scope);
    if (this.scanQueued) return;
    this.scanQueued = true;
    requestAnimationFrame(() => {
      this.scanQueued = false;
      const scopes = [...this.scanScopes];
      this.scanScopes.clear();
      for (const scope of scopes) {
        if (scope.isConnected === false || scopes.some((other) => other !== scope && other.contains(scope))) continue;
        this.scanForms({ scope });
      }
    });
  },

  refresh({ retryKnown = true } = {}) {
    this.removeEmailSuggestionsDatalist();
    void this.checkPendingCredentials();
    this.observeRoot(document);
    this.discoverRoots(document);
    this.scanScopes.clear();
    for (const root of this.observedRoots.keys()) {
      if (root.isConnected !== false) this.scanForms({ retryKnown, scope: root });
    }
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
    if (!field.isConnected || (field.getRootNode?.() || document).activeElement !== field) {
      this.hideEmailPicker();
      return;
    }

    if (!suggestions.length) {
      this.hideEmailPicker();
      return;
    }

    this.hideEmailPicker();

    const host = document.createElement('div');
    host.dataset.yurrrUi = '1';
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
      const path = e.composedPath?.() || [e.target];
      if (!path.includes(host) && !path.includes(field)) {
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
    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
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

  getSubmitPasswordField(scope, fallbackField = null) {
    const fields = scope ? YurrrHeuristics.getVisiblePasswordFields(scope).filter((field) =>
      !YurrrHeuristics.getForm(field) || YurrrHeuristics.getForm(field) === scope)
      : [fallbackField].filter(Boolean);
    const current = fields.find((field) => YurrrHeuristics.isCurrentPasswordField(field));
    const newFields = fields.filter((field) => YurrrHeuristics.isNewPasswordField(field));
    const candidates = newFields.length ? newFields : fields.filter((field) => field !== current);
    const primary = candidates.find((field) => !YurrrHeuristics.isConfirmationPasswordField(field))
      || candidates[0] || current;
    if (!primary?.value) return null;
    // A change form with an empty new password must never save the old password.
    if (fields.length > 1 && primary === current) return null;
    if (candidates.some((field) => field !== primary && field.value !== primary.value)) return null;
    return primary;
  },

  isCredentialSubmitButton(button) {
    if (button.disabled || button.type === 'reset') return false;
    const text = `${button.textContent || ''} ${button.value || ''} ${button.getAttribute('aria-label') || ''}`;
    if (/(cancel|abbrechen|zurück\b|back\b|show|hide|anzeigen|ausblenden|forgot|vergessen|generate|generier)/i.test(text)) return false;
    return button.type === 'submit' ||
      /(log[ -]?in|sign[ -]?in|sign[ -]?up|register|anmelden|einloggen|registrier|continue|weiter|next|save|speichern|update|ändern|bestätigen|create account|change password|reset password|passwort zurücksetzen)/i.test(text);
  },

  captureSubmission(event) {
    if (!event.isTrusted || !this.isCredentialPageAllowed()) return;
    const target = event.composedPath?.()[0] || event.target;
    if (target.closest?.(this.UI_SELECTOR)) return;
    let scope;
    let fallbackField = null;
    let fallbackUsernameField = null;
    if (event.type === 'submit') {
      scope = target;
    } else if (event.type === 'keydown') {
      if (event.key !== 'Enter' || event.repeat || event.isComposing || target.tagName !== 'INPUT') return;
      fallbackField = YurrrHeuristics.isPasswordField(target) ? target : null;
      if (!fallbackField && YurrrHeuristics.scoreUsernameCandidate(target) < 6) return;
      if (!fallbackField) fallbackUsernameField = target;
      scope = YurrrHeuristics.getForm(target);
    } else {
      const button = target.closest('button, input[type="submit"], input[type="button"], [role="button"]');
      if (!button || !this.isCredentialSubmitButton(button)) return;
      scope = YurrrHeuristics.getForm(button);
      if (!scope) {
        // For JS forms, use the nearest shared container of the action and fields.
        for (let parent = button.parentNode; parent?.querySelectorAll; parent = parent.parentNode) {
          if (YurrrHeuristics.getVisiblePasswordFields(parent).some((field) => !YurrrHeuristics.getForm(field)) ||
              YurrrHeuristics.findStandaloneUsernameFields(parent).some((field) => !YurrrHeuristics.getForm(field))) {
            scope = parent;
            break;
          }
        }
      }
    }
    if (!scope && !fallbackField && !fallbackUsernameField) return;
    const passwordField = this.getSubmitPasswordField(scope, fallbackField);
    const usernameField = fallbackUsernameField || (passwordField
      ? YurrrHeuristics.findUsernameField(passwordField, scope)
      : YurrrHeuristics.findStandaloneUsernameFields(scope || document)[0]);
    if (!passwordField && !usernameField) return;
    if (scope?.tagName === 'FORM' && !scope.noValidate && !event.submitter?.formNoValidate &&
        Array.from(scope.elements).some((field) => field.willValidate && !field.validity.valid)) return;
    const key = scope || passwordField || usernameField;
    if (this.submittingScopes.has(key)) return;
    this.submittingScopes.add(key);
    setTimeout(() => this.submittingScopes.delete(key), 0);
    // Capture before page handlers reset or replace the fields.
    void this.handleFormSubmit(scope, usernameField, passwordField);
  },

  scanForms({ retryKnown = false, scope = document } = {}) {
    const passwordFields = YurrrHeuristics.getPasswordFields(scope);

    for (const pwField of passwordFields) {
      if (this.detectedPasswords.has(pwField) && !retryKnown &&
          !(this.autofilledPasswordFields.has(pwField) && !pwField.value)) continue;
      const resolveUsernameField = () => YurrrHeuristics.findUsernameField(pwField);
      const initialUsernameField = resolveUsernameField();
      const form = YurrrHeuristics.getForm(pwField);
      const isNewPassword = YurrrHeuristics.isNewPasswordField(pwField) ||
        (YurrrHeuristics.isRegistrationForm(form) && !YurrrHeuristics.isCurrentPasswordField(pwField));
      if (this.detectedPasswords.has(pwField)) {
        if (!isNewPassword && (retryKnown ||
            (this.autofilledPasswordFields.has(pwField) && !pwField.value))) {
          void this.tryAutoFill(initialUsernameField, pwField, { allowAutofill: true });
        }
        continue;
      }
      this.detectedPasswords.add(pwField);
      this.detectedForms.add(pwField);
      if (initialUsernameField) this.detectedForms.add(initialUsernameField);

      if (!isNewPassword) {
        void this.tryAutoFill(initialUsernameField, pwField, { allowAutofill: true });
        this.retryAutoFillOnInteraction(pwField, resolveUsernameField, pwField, { allowAutofill: true });
      } else {
        const emailField = YurrrHeuristics.findRegistrationEmailField(form, pwField) || initialUsernameField;
        if (emailField) {
          this.detectedForms.add(emailField);
          this.applyEmailSuggestions(emailField);
        }
      }
      pwField.addEventListener('focus', () => {
        const currentForm = YurrrHeuristics.getForm(pwField);
        const isNew = YurrrHeuristics.isNewPasswordField(pwField) ||
          (YurrrHeuristics.isRegistrationForm(currentForm) && !YurrrHeuristics.isCurrentPasswordField(pwField));
        if (isNew) {
          if (this.isCredentialPageAllowed()) YurrrOverlay.show(pwField);
          return;
        }
        const usernameField = resolveUsernameField();
        this.attachPicker(pwField, usernameField, pwField);
        this.attachPicker(usernameField, usernameField, pwField);
      });
    }

    // Process standalone username fields for multi-step logins
    const standaloneUsernames = YurrrHeuristics.findStandaloneUsernameFields(scope, this.detectedForms);
    for (const unField of standaloneUsernames) {
      if (this.detectedForms.has(unField)) continue;
      this.detectedForms.add(unField);

      void this.applyEmailSuggestions(unField);
      this.tryAutoFill(unField, null);
      this.retryAutoFillOnInteraction(unField, unField, null);

      unField.addEventListener('change', () => {
        const username = unField.value || '';
        this.rememberUsername(YurrrSiteScope.key(window.location.href), window.location.href, username);
      });
    }

    this.scanAddressFields(scope);
  },

  getAddressFieldScope(field) {
    return field?.closest('fieldset') || field?.closest('form') || field?.getRootNode?.() || document;
  },

  scanAddressFields(scanScope = document) {
    if (!this.isCredentialPageAllowed()) return;

    const scopes = new Set();
    const candidates = Array.from(scanScope.querySelectorAll(YurrrHeuristics.addressFieldSelector || ''));
    for (const field of candidates) {
      if (this.detectedAddressFields.has(field)) continue;
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
      if (!addresses.length || !targetField.isConnected || (targetField.getRootNode?.() || document).activeElement !== targetField) return false;
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
    host.dataset.yurrrUi = '1';
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
      const path = e.composedPath?.() || [e.target];
      if (!path.includes(host) && !path.includes(targetField)) {
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

    field.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
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
    if ((window.top && window.top !== window) || document.visibilityState === 'hidden') return false;
    if (!passwordField || !credential?.id) return false;
    if (!YurrrHeuristics.isPasswordField(passwordField)) return false;
    const form = YurrrHeuristics.getForm(passwordField);
    if (YurrrHeuristics.isNewPasswordField(passwordField) ||
        (YurrrHeuristics.isRegistrationForm(form) && !YurrrHeuristics.isCurrentPasswordField(passwordField))) return false;
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
    host.dataset.yurrrUi = '1';
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
      const path = e.composedPath?.() || [e.target];
      if (!path.includes(host) && !path.includes(targetField)) {
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
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  fillFields(usernameField, passwordField, credential) {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

    if (usernameField && credential.username) {
      nativeSetter.call(usernameField, credential.username);
      usernameField.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      usernameField.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (passwordField && credential.password) {
      nativeSetter.call(passwordField, credential.password);
      passwordField.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      passwordField.dispatchEvent(new Event('change', { bubbles: true }));
    }
  },

  hasLikelyPostSubmitTransition(startUrl, form, passwordField) {
    if (window.location.href !== startUrl) return true;
    // A display:contents form has no box even while its password field is visible.
    if (passwordField) return !passwordField.isConnected || YurrrHeuristics.isHidden(passwordField);
    return Boolean(form && (!form.isConnected || YurrrHeuristics.isHidden(form)));
  },

  queuePostSubmitSavePrompt(url, submissionId, form, passwordField) {
    if (this.savePromptTimer) {
      clearTimeout(this.savePromptTimer);
    }

    const startedAt = Date.now();
    let transitionStartedAt = null;
    const checkForTransition = () => {
      if (this.hasLikelyPostSubmitTransition(url, form, passwordField)) {
        transitionStartedAt ||= Date.now();
        if (Date.now() - transitionStartedAt >= this.POST_SUBMIT_TRANSITION_STABLE_MS) {
          this.savePromptTimer = null;
          void this.sendRuntimeMessage('MARK_PENDING_CREDENTIALS_READY', { submissionId })
            .then((result) => {
              if (result?.ready && document.visibilityState !== 'hidden') return this.checkPendingCredentials();
            })
            .catch(() => {});
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

    this.savePromptTimer = setTimeout(checkForTransition, this.POST_SUBMIT_PROMPT_DELAY_MS);
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
    const readyPayload = { submissionId: payload.submissionId };

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
        chrome.runtime.sendMessage({ type: 'MARK_PENDING_CREDENTIALS_READY', payload: readyPayload });
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
    const generation = ++this.submissionGeneration;
    ++this.pendingCheckGeneration;
    clearTimeout(this.pendingRetryTimer);
    if (this.savePromptTimer) clearTimeout(this.savePromptTimer);
    if (this.saveBannerCleanup) this.saveBannerCleanup(false);
    if (this.saveStatusCleanup) this.saveStatusCleanup();
    const pendingPayload = {
      submissionId: crypto.randomUUID(),
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
      if (generation !== this.submissionGeneration) return;
      if (!response?.stored) {
        this.disarmPendingCredentialsPromptReady();
        this.showSaveStatus(response?.reason === 'locked'
          ? 'Yurrr is locked. Unlock it, then submit the form again to save this password.'
          : 'Yurrr could not capture this password. Please submit the form again.');
        return;
      }
    } catch {
      if (generation === this.submissionGeneration) {
        this.disarmPendingCredentialsPromptReady();
        this.showSaveStatus('Yurrr could not capture this password. Open the extension and try again.');
      }
      return;
    }

    this.queuePostSubmitSavePrompt(url, pendingPayload.submissionId, form, passwordField);
    void this.checkPendingCredentials({ submissionId: pendingPayload.submissionId });
  },

  async checkPendingCredentials({ manual = false, submissionId, attempt = 0 } = {}) {
    if (!this.isCredentialPageAllowed()) return;
    const generation = ++this.pendingCheckGeneration;
    clearTimeout(this.pendingRetryTimer);
    const domain = YurrrSiteScope.key(window.location.href);

    try {
      const response = await this.sendRuntimeMessage('CHECK_PENDING_CREDENTIALS', {
        domain,
        pageUrl: window.location.href,
        manual,
        submissionId,
      });
      if (generation !== this.pendingCheckGeneration) return;
      if (response.hasPending && response.credentials.submissionId !== this.saveBannerSubmissionId) {
        const { url, username, password, ...options } = response.credentials;
        this.showSaveBanner(url, username, password, domain, options);
      } else if (response.available && !this.saveBannerCleanup) {
        this.showSaveStatus('Submitted password captured. Review it if you want to save it.', {
          submissionId: response.submissionId,
          expiresAt: response.expiresAt,
          actionLabel: 'Review',
          action: () => this.checkPendingCredentials({ manual: true, submissionId: response.submissionId }),
        });
      } else if (!response.hasPending && !response.available) {
        if (this.saveStatusCleanup) this.saveStatusCleanup();
        if (manual) this.showSaveStatus(response.reason === 'unchanged'
          ? 'This password is already saved.'
          : 'No pending password is available. Unlock Yurrr and submit the form again.');
      }
    } catch {
      if (generation !== this.pendingCheckGeneration) return;
      if (attempt < 2) {
        this.pendingRetryTimer = setTimeout(() => {
          if (generation === this.pendingCheckGeneration) void this.checkPendingCredentials({ manual, submissionId, attempt: attempt + 1 });
        }, [1000, 3000][attempt]);
      } else {
        this.showSaveStatus('Yurrr could not check the submitted password. Check the server connection and retry.', {
          submissionId,
          actionLabel: 'Retry',
          action: () => this.checkPendingCredentials({ manual, submissionId }),
        });
      }
    }
  },

  showSaveStatus(message, { action, actionLabel, submissionId, expiresAt } = {}) {
    if (this.saveStatusCleanup) this.saveStatusCleanup();
    const status = document.createElement('div');
    status.id = 'yurrr-save-status';
    status.setAttribute('role', 'status');
    status.innerHTML = `<span><strong>Yurrr</strong> — ${this.escapeHtml(message)}</span>
      ${action ? `<button class="yurrr-status-action" type="button">${this.escapeHtml(actionLabel)}</button>` : ''}
      <button class="yurrr-status-dismiss" type="button" aria-label="Dismiss Yurrr message">×</button>`;
    document.body.appendChild(status);
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      status.remove();
      if (this.saveStatusCleanup === cleanup) this.saveStatusCleanup = null;
    };
    this.saveStatusCleanup = cleanup;
    timer = setTimeout(cleanup, Math.max(0, Math.min(this.SAVE_BANNER_TTL_MS, (expiresAt || Date.now() + 60000) - Date.now())));
    status.querySelector('.yurrr-status-action')?.addEventListener('click', (event) => {
      if (event.isTrusted) { cleanup(); void action(); }
    });
    status.querySelector('.yurrr-status-dismiss').addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      cleanup();
      ++this.pendingCheckGeneration;
      clearTimeout(this.pendingRetryTimer);
      if (submissionId) {
        clearTimeout(this.savePromptTimer);
        this.disarmPendingCredentialsPromptReady();
        void this.sendRuntimeMessage('CLEAR_PENDING_CREDENTIALS', { submissionId }).catch(() => {});
      }
    });
  },

  showSaveBanner(url, username, password, domain = YurrrSiteScope.key(window.location.href), options = {}) {
    if (this.saveStatusCleanup) this.saveStatusCleanup();
    if (this.saveBannerCleanup) {
      this.saveBannerCleanup(false);
    } else {
      const existing = document.getElementById('yurrr-save-banner');
      if (existing) existing.remove();
    }

    this.saveBannerSubmissionId = options.submissionId || null;
    const banner = document.createElement('div');
    banner.id = 'yurrr-save-banner';
    const chooseAccount = options.action === 'choose_account';
    const initialMessage = chooseAccount ? 'Choose the account to update, or enter a username for a new login.'
      : options.message || `Save password for ${domain}?`;
    const initialButtonLabel = options.action === 'update' ? 'Update' : 'Save';
    const shadow = banner.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        .yurrr-banner-text {
          font-size: 14px;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .yurrr-banner-text strong {
          color: #d8b24c;
        }
        .yurrr-banner-text[data-variant='error'] {
          color: #ffd3ce;
        }
        .yurrr-banner-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          align-items: center;
        }
        label {
          display: flex;
          gap: 6px;
          align-items: center;
          font-size: 13px;
        }
        input,
        select {
          max-width: 180px;
          padding: 5px;
          color: #172024;
          background: #eef3ef;
          border: 1px solid #d8b24c;
          border-radius: 4px;
        }
        .yurrr-banner-actions button {
          padding: 6px 14px;
          border: none;
          border-radius: 4px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }
        .yurrr-banner-actions button:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }
        .yurrr-banner-save {
          background: #d8b24c;
          color: #172024;
        }
        .yurrr-banner-dismiss {
          background: #243039;
          color: #eef3ef;
        }
      </style>
      <div class="yurrr-banner-text">
        <strong>Yurrr</strong> &mdash; ${this.escapeHtml(initialMessage)}
      </div>
      <div class="yurrr-banner-actions">
        ${chooseAccount ? `<label>Account <select class="yurrr-banner-account">
          <option value="">New login</option>${(options.accounts || []).map((account, index) =>
            `<option value="${index}">${this.escapeHtml(account.username || '(no username)')}</option>`).join('')}
        </select></label><label>Username <input class="yurrr-banner-username" type="text" autocomplete="off" value="${this.escapeHtml(username)}"></label>` : ''}
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
        this.saveBannerSubmissionId = null;
      }
      pendingPassword = '';
      if (clearPending) {
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS', payload: { submissionId: options.submissionId } });
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_USERNAME', payload: { domain } });
      }
      banner.remove();
    };
    this.saveBannerCleanup = dismissBanner;

    const textEl = shadow.querySelector('.yurrr-banner-text');
    const saveBtn = shadow.querySelector('.yurrr-banner-save');
    const saveBtnOriginalLabel = saveBtn.textContent;
    const accountSelect = shadow.querySelector('.yurrr-banner-account');
    const usernameInput = shadow.querySelector('.yurrr-banner-username');
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
    }, Math.max(0, Math.min(this.SAVE_BANNER_TTL_MS, (options.expiresAt || Date.now() + this.SAVE_BANNER_TTL_MS) - Date.now())));

    accountSelect?.addEventListener('change', (event) => {
      if (!event.isTrusted) return;
      confirmUpdateEntryId = accountSelect.value === '' ? null
        : String(options.accounts[Number(accountSelect.value)]?.id || '') || null;
      usernameInput.disabled = Boolean(confirmUpdateEntryId);
      saveBtn.textContent = confirmUpdateEntryId ? 'Update' : 'Save';
    });

    saveBtn.addEventListener('click', async (e) => {
      if (!e.isTrusted) return;
      if (usernameInput && !confirmUpdateEntryId && !usernameInput.value.trim()) {
        setBannerMessage('Enter a username or select a saved account.', true);
        usernameInput.focus();
        return;
      }
      saveBtn.disabled = true;
      setBannerMessage('Saving password...');
      try {
        const response = await this.sendRuntimeMessage('FORM_SUBMITTED', {
          submissionId: options.submissionId,
          url,
          pageUrl: window.location.href,
          username: usernameInput?.value.trim() || username,
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

    shadow.querySelector('.yurrr-banner-dismiss').addEventListener('click', (e) => {
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
