// Form detection, auto-fill, and save prompt
const YurrrDetector = {
  initialized: false,
  detectedForms: new WeakSet(),
  activePicker: null,
  scanQueued: false,

  init() {
    if (this.initialized) return;
    this.initialized = true;

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

  scanForms() {
    const passwordFields = document.querySelectorAll('input[type="password"]');

    for (const pwField of passwordFields) {
      if (this.detectedForms.has(pwField)) continue;
      this.detectedForms.add(pwField);

      const form = pwField.closest('form');
      const usernameField = YurrrHeuristics.findUsernameField(pwField);
      
      if (usernameField) {
        this.detectedForms.add(usernameField);
      }

      const isRegistration = YurrrHeuristics.isRegistrationForm(form);

      if (isRegistration) {
        pwField.addEventListener('focus', () => {
          YurrrOverlay.show(pwField);
        });
      } else {
        this.tryAutoFill(usernameField, pwField);
      }

      if (form) {
        form.addEventListener('submit', () => {
          this.handleFormSubmit(form, usernameField, pwField);
        });
      }

      pwField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.handleFormSubmit(form, usernameField, pwField);
        }
      });
    }

    // Process standalone username fields for multi-step logins
    const standaloneUsernames = YurrrHeuristics.findStandaloneUsernameFields();
    for (const unField of standaloneUsernames) {
      if (this.detectedForms.has(unField)) continue;
      this.detectedForms.add(unField);

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
    }
  },

  async tryAutoFill(usernameField, passwordField) {
    const domain = window.location.hostname;

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'CHECK_CREDENTIALS', payload: { domain } },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp?.error) reject(new Error(resp.error));
            else resolve(resp);
          }
        );
      });

      const creds = response.credentials;
      if (!creds || creds.length === 0) return;

      // Auto-fill first match
      this.fillFields(usernameField, passwordField, creds[0]);

      // Attach picker to fields — opens on focus/click
      this.attachPicker(passwordField, usernameField, passwordField, creds);
      if (usernameField) {
        this.attachPicker(usernameField, usernameField, passwordField, creds);
      }
    } catch {
      // Vault likely locked, do nothing
    }
  },

  attachPicker(targetField, usernameField, passwordField, credentials) {
    let pickerOpen = false;

    const openPicker = () => {
      if (pickerOpen) return;
      pickerOpen = true;
      this.showPicker(targetField, usernameField, passwordField, credentials, () => {
        pickerOpen = false;
      });
    };

    targetField.addEventListener('focus', openPicker);
    targetField.addEventListener('click', openPicker);
  },

  showPicker(targetField, usernameField, passwordField, credentials, onClose) {
    this.hidePicker();

    const currentUser = usernameField?.value || '';

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
            <div class="item${cred.username === currentUser ? ' active' : ''}" data-index="${i}">
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
        const idx = parseInt(item.dataset.index);
        const cred = credentials[idx];
        this.fillFields(usernameField, passwordField, cred);

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

  handleFormSubmit(form, usernameField, passwordField) {
    const username = usernameField?.value || '';
    const password = passwordField?.value;

    if (!password) return;

    const url = window.location.href;
    const domain = window.location.hostname;

    chrome.runtime.sendMessage({
      type: 'PENDING_CREDENTIALS',
      payload: { url, domain, username, password },
    });
  },

  async checkPendingCredentials() {
    const domain = window.location.hostname;

    try {
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'CHECK_PENDING_CREDENTIALS', payload: { domain } },
          (resp) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (resp?.error) reject(new Error(resp.error));
            else resolve(resp);
          }
        );
      });

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
        await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: 'FORM_SUBMITTED', payload: { url, username, password } },
            (resp) => {
              if (resp?.error) reject(new Error(resp.error));
              else resolve(resp);
            }
          );
        });
      } catch {
        // Silent fail
      }
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
      banner.remove();
    });

    banner.querySelector('.yurrr-banner-dismiss').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
      banner.remove();
    });

    setTimeout(() => {
      if (banner.parentNode) {
        chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_CREDENTIALS' });
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
