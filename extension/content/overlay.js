// Password suggestion dropdown overlay
const YurrrOverlay = {
  container: null,
  currentTarget: null,

  create() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'yurrr-overlay';
    this.container.innerHTML = `
      <div class="yurrr-overlay-header">
        <span class="yurrr-overlay-logo">Yurrr</span>
        <span class="yurrr-overlay-subtitle">Suggested Password</span>
      </div>
      <div class="yurrr-overlay-password" id="yurrr-suggested-pw"></div>
      <div class="yurrr-overlay-controls">
        <div class="yurrr-overlay-slider-row">
          <label>Length: <span id="yurrr-pw-length-label">20</span></label>
          <input type="range" id="yurrr-pw-length" min="12" max="32" value="20">
        </div>
        <div class="yurrr-overlay-actions">
          <button id="yurrr-regenerate" class="yurrr-btn-secondary">Regenerate</button>
          <button id="yurrr-use-pw" class="yurrr-btn-primary">Use Password</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.container);

    // Slider
    const slider = this.container.querySelector('#yurrr-pw-length');
    const label = this.container.querySelector('#yurrr-pw-length-label');
    slider.addEventListener('input', () => {
      label.textContent = slider.value;
    });

    // Regenerate
    this.container.querySelector('#yurrr-regenerate').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.generateAndShow(parseInt(slider.value));
    });

    // Use password
    this.container.querySelector('#yurrr-use-pw').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.usePassword();
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (this.container && !this.container.contains(e.target) && e.target !== this.currentTarget) {
        this.hide();
      }
    });
  },

  async show(targetField) {
    if (!targetField) return;
    if (typeof YurrrDetector !== 'undefined' && !YurrrDetector.isCredentialPageAllowed()) {
      this.hide();
      return;
    }

    this.create();
    this.currentTarget = targetField;

    // Position below target field without letting the overlay leave the viewport.
    const rect = targetField.getBoundingClientRect();
    const viewportPadding = 8;
    const availableWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
    const width = Math.min(Math.max(rect.width, 300), availableWidth);
    const minLeft = window.scrollX + viewportPadding;
    const maxLeft = window.scrollX + window.innerWidth - width - viewportPadding;
    const left = Math.max(minLeft, Math.min(rect.left + window.scrollX, maxLeft));

    this.container.style.display = 'block';
    this.container.style.visibility = 'hidden';
    this.container.style.left = `${left}px`;
    this.container.style.width = `${width}px`;
    const availableHeight = Math.max(180, window.innerHeight - viewportPadding * 2);
    this.container.style.maxHeight = `${availableHeight}px`;

    const belowTop = rect.bottom + window.scrollY + 4;
    const overlayHeight = Math.min(this.container.offsetHeight, availableHeight);
    const aboveTop = rect.top + window.scrollY - overlayHeight - 4;
    const minTop = window.scrollY + viewportPadding;
    const maxTop = window.scrollY + window.innerHeight - overlayHeight - viewportPadding;
    const preferredTop = belowTop + overlayHeight > maxTop + viewportPadding && aboveTop >= minTop
      ? aboveTop
      : belowTop;
    const top = Math.max(minTop, Math.min(preferredTop, maxTop));
    this.container.style.top = `${top}px`;
    this.container.style.visibility = '';

    await this.generateAndShow(20);
  },

  hide() {
    if (this.container) {
      this.container.style.display = 'none';
    }
    this.currentTarget = null;
  },

  async generateAndShow(length) {
    const pwEl = this.container.querySelector('#yurrr-suggested-pw');
    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'GENERATE_PASSWORD', payload: { length } },
          (resp) => {
            if (resp?.error) reject(new Error(resp.error));
            else resolve(resp);
          }
        );
      });
      pwEl.textContent = result.password;
    } catch {
      pwEl.textContent = 'Unable to generate (vault locked?)';
    }
  },

  usePassword() {
    const pw = this.container.querySelector('#yurrr-suggested-pw').textContent;
    if (!pw || !this.currentTarget) return;

    // Fill the password field
    const target = this.currentTarget;
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    nativeSetter.call(target, pw);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    this.markGeneratedPassword(target, pw);

    // Also fill confirm password if present
    const form = target.closest('form');
    if (form) {
      const pwFields = form.querySelectorAll('input[type="password"]');
      const isPasswordChange = typeof YurrrHeuristics !== 'undefined'
        && YurrrHeuristics.isPasswordChangeForm(form);
      const currentPasswordField = isPasswordChange
        ? YurrrHeuristics.findCurrentPasswordField(form)
        : null;

      for (const field of pwFields) {
        if (field === target) {
          continue;
        }

        if (isPasswordChange) {
          const isCurrentPassword = field === currentPasswordField
            || YurrrHeuristics.isCurrentPasswordField(field);
          if (isCurrentPassword || !YurrrHeuristics.isNewPasswordField(field)) {
            continue;
          }
        }

        nativeSetter.call(field, pw);
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        this.markGeneratedPassword(field, pw);
      }
    }

    this.hide();
  },

  markGeneratedPassword(field, password) {
    if (!field || !password) return;

    const store = globalThis.YurrrGeneratedPasswordStore || new WeakMap();
    globalThis.YurrrGeneratedPasswordStore = store;

    const value = {
      password,
      generatedAt: Date.now(),
    };
    store.set(field, value);

    const form = field.closest('form');
    if (form) {
      store.set(form, value);
    }
  },

  destroy() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  },
};
