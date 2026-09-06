// Password suggestion dropdown overlay
const YurrrOverlay = {
  container: null,
  currentTarget: null,
  currentPassword: '',
  elements: null,
  generation: 0,

  create() {
    if (this.container) return;

    this.container = document.createElement('div');
    this.container.id = 'yurrr-overlay-host';
    Object.assign(this.container.style, {
      display: 'none',
      position: 'absolute',
      zIndex: '2147483647',
      margin: '0',
      padding: '0',
    });

    const shadow = this.container.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .overlay {
          background: #172024;
          border: 1px solid #d8b24c;
          border-radius: 8px;
          box-shadow: 0 10px 28px rgba(23, 32, 36, 0.34);
          color: #eef3ef;
          font-family: 'Atkinson Hyperlegible', Aptos, 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
          overflow: hidden;
          overflow-y: auto;
        }
        .header {
          align-items: center;
          background: #243039;
          border-bottom: 1px solid rgba(216, 178, 76, 0.32);
          display: flex;
          justify-content: space-between;
          padding: 8px 12px;
        }
        .logo { color: #d8b24c; font-size: 13px; font-weight: 760; }
        .subtitle { color: #aab5b0; font-size: 11px; }
        .password {
          background: #243039;
          border-radius: 4px;
          font-family: 'SFMono-Regular', 'Cascadia Mono', 'Roboto Mono', ui-monospace, monospace;
          font-size: 14px;
          margin: 8px;
          padding: 10px 12px;
          user-select: all;
          word-break: break-all;
        }
        .controls { padding: 8px 12px 12px; }
        .slider-row {
          align-items: center;
          color: #aab5b0;
          display: flex;
          font-size: 12px;
          gap: 8px;
          margin-bottom: 8px;
        }
        .slider-row input[type="range"] { accent-color: #68c7b8; flex: 1; }
        .actions { display: flex; gap: 6px; }
        button {
          border: none;
          border-radius: 4px;
          cursor: pointer;
          flex: 1;
          font-size: 12px;
          font-weight: 600;
          padding: 6px 12px;
        }
        button:disabled { cursor: not-allowed; opacity: 0.6; }
        .primary { background: #d8b24c; color: #172024; }
        .primary:hover:not(:disabled) { background: #c59e3e; }
        .secondary {
          background: #243039;
          border: 1px solid rgba(216, 178, 76, 0.28);
          color: #eef3ef;
        }
        .secondary:hover:not(:disabled) { background: #2d3a40; }
      </style>
      <div class="overlay">
        <div class="header">
          <span class="logo">Yurrr</span>
          <span class="subtitle">Suggested Password</span>
        </div>
        <div class="password"></div>
        <div class="controls">
          <div class="slider-row">
            <label for="yurrr-password-length">Length: <span class="length-label">20</span></label>
            <input id="yurrr-password-length" class="length" type="range" min="12" max="32" value="20">
          </div>
          <div class="actions">
            <button class="secondary regenerate" type="button">Regenerate</button>
            <button class="primary use-password" type="button">Use Password</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(this.container);

    const slider = shadow.querySelector('.length');
    const label = shadow.querySelector('.length-label');
    const pwEl = shadow.querySelector('.password');
    const useBtn = shadow.querySelector('.use-password');
    this.elements = { slider, label, pwEl, useBtn };

    slider.addEventListener('input', () => {
      label.textContent = slider.value;
    });
    slider.addEventListener('change', () => this.generateAndShow(Number.parseInt(slider.value, 10)));
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.hide();
      }
    });

    shadow.querySelector('.regenerate').addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.preventDefault();
      e.stopPropagation();
      this.generateAndShow(Number.parseInt(slider.value, 10));
    });

    useBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
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
    this.elements.slider.value = '20';
    this.elements.label.textContent = '20';

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
    this.generation += 1;
    if (this.container) {
      this.container.style.display = 'none';
    }
    if (this.elements?.pwEl) {
      this.elements.pwEl.textContent = '';
    }
    if (this.elements?.useBtn) {
      this.elements.useBtn.disabled = true;
    }
    this.currentTarget = null;
    this.currentPassword = '';
  },

  async generateAndShow(length) {
    const generation = ++this.generation;
    const pwEl = this.elements?.pwEl;
    const useBtn = this.elements?.useBtn;
    if (!pwEl || !useBtn) return;

    this.currentPassword = '';
    useBtn.disabled = true;
    pwEl.textContent = 'Generating...';

    try {
      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'GENERATE_PASSWORD', payload: { length } },
          (resp) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else if (resp?.error) reject(new Error(resp.error));
            else resolve(resp);
          }
        );
      });
      if (generation !== this.generation || !this.currentTarget) return;
      if (!result?.password) {
        throw new Error('No password generated');
      }
      this.currentPassword = result.password;
      pwEl.textContent = result.password;
      useBtn.disabled = false;
    } catch {
      if (generation !== this.generation || !this.currentTarget) return;
      pwEl.textContent = 'Unable to generate (vault locked?)';
    }
  },

  usePassword() {
    const pw = this.currentPassword;
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
    this.hide();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
    this.elements = null;
    this.currentPassword = '';
  },
};
