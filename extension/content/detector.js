// Form detection, auto-fill, and save prompt
const YurrrDetector = {
  initialized: false,
  detectedForms: new Set(),

  init() {
    if (this.initialized) return;
    this.initialized = true;

    // Initial scan
    this.scanForms();

    // Watch for DOM changes (SPAs)
    const observer = new MutationObserver(() => {
      this.scanForms();
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
      const isRegistration = YurrrHeuristics.isRegistrationForm(form);

      if (isRegistration) {
        // Registration: show password suggestion on focus
        pwField.addEventListener('focus', () => {
          YurrrOverlay.show(pwField);
        });
      } else {
        // Login: try auto-fill
        this.tryAutoFill(usernameField, pwField);
      }

      // Listen for form submission to offer saving
      if (form) {
        form.addEventListener('submit', (e) => {
          this.handleFormSubmit(form, usernameField, pwField);
        });
      }

      // Also listen for Enter key on password field
      pwField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.handleFormSubmit(form, usernameField, pwField);
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

      if (creds.length === 1) {
        // Auto-fill single match
        this.fillFields(usernameField, passwordField, creds[0]);
      } else {
        // Multiple matches — add a picker icon (simplified: fill first match)
        this.fillFields(usernameField, passwordField, creds[0]);
      }
    } catch {
      // Vault likely locked, do nothing
    }
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
    const username = usernameField?.value;
    const password = passwordField?.value;

    if (!username || !password) return;

    const url = window.location.href;

    // Show save banner
    this.showSaveBanner(url, username, password);
  },

  showSaveBanner(url, username, password) {
    // Remove existing banner
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
      banner.remove();
    });

    banner.querySelector('.yurrr-banner-dismiss').addEventListener('click', () => {
      banner.remove();
    });

    // Auto-dismiss after 10 seconds
    setTimeout(() => {
      if (banner.parentNode) banner.remove();
    }, 10000);
  },
};

// Start detection
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => YurrrDetector.init());
} else {
  YurrrDetector.init();
}
