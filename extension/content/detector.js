// Form detection, auto-fill, and save prompt
const YurrrDetector = {
  initialized: false,
  detectedForms: new WeakSet(),
  activePicker: null,
  scanQueued: false,
  emailSuggestionsCache: null,
  emailSuggestionsCacheAt: 0,
  autoEmailPersistQueue: Promise.resolve(),
  observedEmailFields: new WeakSet(),
  EMAIL_SUGGESTIONS_KEY: 'yurrr_email_suggestions',
  AUTO_EMAIL_SUGGESTIONS_KEY: 'yurrr_auto_email_suggestions',
  AUTO_EMAIL_SELECTED_KEY: 'yurrr_auto_email_selected',
  EMAIL_SUGGESTIONS_LIST_ID: 'yurrr-email-suggestions-list',
  MAX_AUTO_EMAIL_SUGGESTIONS: 100,

  init() {
    if (this.initialized) return;
    this.initialized = true;

    this.checkPendingCredentials();
    this.scanForms();
    this.discoverEmailsFromGoogleContext();
    this.backfillEmailsFromVault();

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
          reject(new Error(resp.error));
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
      const result = await chrome.storage.local.get([
        this.EMAIL_SUGGESTIONS_KEY,
        this.AUTO_EMAIL_SUGGESTIONS_KEY,
        this.AUTO_EMAIL_SELECTED_KEY,
      ]);
      const manualSuggestions = this.parseEmailSuggestions(result[this.EMAIL_SUGGESTIONS_KEY]);
      const allAutoSuggestions = this.parseEmailSuggestions(result[this.AUTO_EMAIL_SUGGESTIONS_KEY]);
      const hasSelectedAutoEmails = Array.isArray(result[this.AUTO_EMAIL_SELECTED_KEY]);
      const selectedAutoEmails = this.parseEmailSuggestions(result[this.AUTO_EMAIL_SELECTED_KEY]);
      const selectedSet = new Set(selectedAutoEmails.map((email) => this.normalizeEmail(email)));
      const autoSuggestions = hasSelectedAutoEmails
        ? allAutoSuggestions.filter((email) => selectedSet.has(this.normalizeEmail(email)))
        : allAutoSuggestions;
      let vaultSuggestions = [];
      try {
        const vaultResp = await this.sendRuntimeMessage('GET_KNOWN_EMAIL_USERNAMES');
        vaultSuggestions = this.parseEmailSuggestions(vaultResp?.emails);
      } catch {
        // locked/offline or unavailable
      }

      const combined = this.mergeEmailLists(manualSuggestions, autoSuggestions, vaultSuggestions);
      this.emailSuggestionsCache = combined;
      this.emailSuggestionsCacheAt = now;
      return combined;
    } catch {
      return [];
    }
  },

  mergeEmailLists(...lists) {
    const unique = [];
    const seen = new Set();

    for (const list of lists) {
      for (const email of list) {
        const normalized = this.normalizeEmail(email);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        unique.push(email);
      }
    }

    return unique;
  },

  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  },

  ensureEmailSuggestionsDatalist(suggestions) {
    let dataList = document.getElementById(this.EMAIL_SUGGESTIONS_LIST_ID);
    if (!dataList) {
      dataList = document.createElement('datalist');
      dataList.id = this.EMAIL_SUGGESTIONS_LIST_ID;
      document.body.appendChild(dataList);
    }

    const existing = Array.from(dataList.querySelectorAll('option')).map((option) => option.value);
    if (existing.length === suggestions.length && existing.every((value, idx) => value === suggestions[idx])) {
      return;
    }

    dataList.innerHTML = suggestions
      .map((email) => `<option value="${this.escapeHtml(email)}"></option>`)
      .join('');
  },

  async applyEmailSuggestions(field) {
    if (!field) return;
    if (!YurrrHeuristics.isLikelyEmailField(field)) return;

    const suggestions = await this.loadEmailSuggestions();
    if (!suggestions.length) return;

    this.ensureEmailSuggestionsDatalist(suggestions);
    field.setAttribute('list', this.EMAIL_SUGGESTIONS_LIST_ID);
  },

  observeEmailField(field) {
    if (!field || this.observedEmailFields.has(field)) return;
    if (!YurrrHeuristics.isLikelyEmailField(field)) return;

    this.observedEmailFields.add(field);

    const collect = () => {
      const value = field.value || '';
      this.storeDiscoveredEmail(value);
    };

    field.addEventListener('change', collect);
    field.addEventListener('blur', collect);
  },

  async storeDiscoveredEmail(value) {
    const email = this.normalizeEmail(value);
    if (!email || !this.isValidEmail(email)) return;

    this.autoEmailPersistQueue = this.autoEmailPersistQueue.then(async () => {
      const result = await chrome.storage.local.get(this.AUTO_EMAIL_SUGGESTIONS_KEY);
      const current = this.parseEmailSuggestions(result[this.AUTO_EMAIL_SUGGESTIONS_KEY]).map((entry) => this.normalizeEmail(entry));
      if (current.includes(email)) return;

      const updated = [email, ...current].slice(0, this.MAX_AUTO_EMAIL_SUGGESTIONS);
      await chrome.storage.local.set({ [this.AUTO_EMAIL_SUGGESTIONS_KEY]: updated });
      this.emailSuggestionsCache = null;
      this.emailSuggestionsCacheAt = 0;
    }).catch(() => {
      // Ignore storage races
    });

    await this.autoEmailPersistQueue;
  },

  extractEmailsFromText(text) {
    if (!text) return [];
    const matches = String(text).match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
    if (!matches) return [];
    return this.parseEmailSuggestions(matches);
  },

  async discoverEmailsFromGoogleContext() {
    const host = window.location.hostname.toLowerCase();
    if (!/(^|\.)google\.com$|(^|\.)googlemail\.com$|(^|\.)gmail\.com$/.test(host)) {
      return;
    }

    // Delay slightly so account chips can render on dynamic Google pages.
    setTimeout(async () => {
      const discovered = new Set();

      const attrCandidates = document.querySelectorAll('[data-email], [email], a[href^="mailto:"]');
      for (const node of attrCandidates) {
        const raw =
          node.getAttribute('data-email') ||
          node.getAttribute('email') ||
          node.getAttribute('href') ||
          '';
        const emails = this.extractEmailsFromText(raw);
        for (const email of emails) discovered.add(this.normalizeEmail(email));
      }

      const pageText = (document.body?.innerText || '').slice(0, 120000);
      const textEmails = this.extractEmailsFromText(pageText);
      for (const email of textEmails) discovered.add(this.normalizeEmail(email));

      for (const email of discovered) {
        await this.storeDiscoveredEmail(email);
      }
    }, 900);
  },

  async backfillEmailsFromVault() {
    try {
      const response = await this.sendRuntimeMessage('GET_KNOWN_EMAIL_USERNAMES');
      const emails = this.parseEmailSuggestions(response?.emails);
      for (const email of emails) {
        await this.storeDiscoveredEmail(email);
      }
    } catch {
      // vault likely locked
    }
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
        username: normalized,
      });
    } catch {
      // Silent fail
    }
  },

  async getRememberedUsername(domain) {
    try {
      const response = await this.sendRuntimeMessage('GET_PENDING_USERNAME', { domain });
      return response?.username || '';
    } catch {
      return '';
    }
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

      const isRegistration = YurrrHeuristics.isRegistrationForm(form);

      if (isRegistration) {
        pwField.addEventListener('focus', () => {
          YurrrOverlay.show(pwField);
        });

        const emailField = YurrrHeuristics.findRegistrationEmailField(form, pwField) || initialUsernameField;
        if (emailField) {
          this.detectedForms.add(emailField);
          void this.applyEmailSuggestions(emailField);
          this.observeEmailField(emailField);
        }
      } else {
        this.tryAutoFill(initialUsernameField, pwField);

        // Re-evaluate dynamically for multi-step/login forms that mutate fields after initial scan.
        pwField.addEventListener('focus', () => {
          this.tryAutoFill(resolveUsernameField(), pwField);
        });
      }

      if (form) {
        form.addEventListener('submit', () => {
          this.handleFormSubmit(form, resolveUsernameField(), pwField);
        });
      }

      pwField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.handleFormSubmit(form, resolveUsernameField(), pwField);
        }
      });
    }

    // Process standalone username fields for multi-step logins
    const standaloneUsernames = YurrrHeuristics.findStandaloneUsernameFields();
    for (const unField of standaloneUsernames) {
      if (this.detectedForms.has(unField)) continue;
      this.detectedForms.add(unField);

      void this.applyEmailSuggestions(unField);
      this.observeEmailField(unField);
      this.tryAutoFill(unField, null);

      const form = unField.closest('form');
      if (form) {
        form.addEventListener('submit', () => {
          this.handleFormSubmit(form, unField, null);
        });
      }

      unField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.handleFormSubmit(form, unField, null);
        }
      });

      unField.addEventListener('change', () => {
        const username = unField.value || '';
        this.rememberUsername(window.location.hostname, window.location.href, username);
        this.storeDiscoveredEmail(username);
      });
    }
  },

  async tryAutoFill(usernameField, passwordField) {
    const domain = window.location.hostname;

    try {
      let preferredUsername = usernameField?.value || '';
      if (!preferredUsername) {
        preferredUsername = await this.getRememberedUsername(domain);
      }

      const response = await this.sendRuntimeMessage('CHECK_CREDENTIALS', { domain, preferredUsername });
      const creds = response.credentials;
      if (!creds || creds.length === 0) return;

      const selectedCredential = this.selectCredential(creds, preferredUsername) || creds[0];

      // Auto-fill best match
      this.fillFields(usernameField, passwordField, selectedCredential);

      // Attach picker to fields — opens on focus/click
      this.attachPicker(passwordField, usernameField, passwordField, creds, preferredUsername);
      this.attachPicker(usernameField, usernameField, passwordField, creds, preferredUsername);
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

    // Position below target field
    const rect = targetField.getBoundingClientRect();
    host.style.top = `${rect.bottom + window.scrollY + 4}px`;
    host.style.left = `${rect.left + window.scrollX}px`;
    host.style.minWidth = `${Math.max(260, rect.width)}px`;

    const closePicker = () => {
      this.hidePicker();
      if (onClose) onClose();
      document.removeEventListener('click', outsideClickHandler);
      document.removeEventListener('keydown', escHandler);
    };

    // Click handlers for items
    shadow.querySelectorAll('.item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent blur on the input field
        const idx = Number.parseInt(item.dataset.index, 10);
        const cred = credentials[idx];
        this.fillFields(usernameField, passwordField, cred);
        this.rememberUsername(window.location.hostname, window.location.href, cred.username);

        shadow.querySelectorAll('.item').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');

        setTimeout(() => closePicker(), 150);
      });
    });

    // Close on outside click (delayed to avoid catching the triggering click)
    const outsideClickHandler = (e) => {
      if (!host.contains(e.target) && e.target !== targetField) {
        closePicker();
      }
    };
    setTimeout(() => document.addEventListener('click', outsideClickHandler), 0);

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') closePicker();
    };
    document.addEventListener('keydown', escHandler);
  },

  hidePicker() {
    if (this.activePicker) {
      this.activePicker.remove();
      this.activePicker = null;
    }
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

  async handleFormSubmit(form, usernameField, passwordField) {
    const url = window.location.href;
    const domain = window.location.hostname;
    const typedUsername = String(usernameField?.value || '').trim();
    const password = passwordField?.value;

    // Step 1 of multi-step login: remember identifier/email for the upcoming password step.
    if (!password) {
      if (typedUsername) {
        await this.rememberUsername(domain, url, typedUsername);
      }
      return;
    }

    let username = typedUsername;
    if (!username) {
      username = await this.getRememberedUsername(domain);
    }

    chrome.runtime.sendMessage({
      type: 'PENDING_CREDENTIALS',
      payload: { url, domain, username, password },
    });
  },

  async checkPendingCredentials() {
    const domain = window.location.hostname;

    try {
      const response = await this.sendRuntimeMessage('CHECK_PENDING_CREDENTIALS', { domain });

      if (response.hasPending) {
        const { url, username, password } = response.credentials;
        this.showSaveBanner(url, username, password);
      }
    } catch {
      // Silent fail
    }
  },

  showSaveBanner(url, username, password) {
    const existing = document.getElementById('yurrr-save-banner');
    if (existing) existing.remove();

    const domain = window.location.hostname;
    const banner = document.createElement('div');
    banner.id = 'yurrr-save-banner';
    banner.innerHTML = `
      <div class="yurrr-banner-text">
        <strong>Yurrr</strong> &mdash; Save password for <strong>${domain}</strong>?
      </div>
      <div class="yurrr-banner-actions">
        <button class="yurrr-banner-save">Save</button>
        <button class="yurrr-banner-dismiss">Dismiss</button>
      </div>
    `;

    document.body.appendChild(banner);

    banner.querySelector('.yurrr-banner-save').addEventListener('click', async () => {
      try {
        await this.sendRuntimeMessage('FORM_SUBMITTED', { url, username, password });
      } catch {
        // Silent fail
      }

      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_USERNAME', payload: { domain } });
      banner.remove();
    });

    banner.querySelector('.yurrr-banner-dismiss').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_USERNAME', payload: { domain } });
      banner.remove();
    });

    setTimeout(() => {
      if (banner.parentNode) {
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_USERNAME', payload: { domain } });
        banner.remove();
      }
    }, 10000);
  },
};

// Start detection
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => YurrrDetector.init());
} else {
  YurrrDetector.init();
}
