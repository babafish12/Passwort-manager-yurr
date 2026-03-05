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
    this.create();
    this.currentTarget = targetField;

    // Position below target field
    const rect = targetField.getBoundingClientRect();
    this.container.style.top = `${rect.bottom + window.scrollY + 4}px`;
    this.container.style.left = `${rect.left + window.scrollX}px`;
    this.container.style.width = `${Math.max(rect.width, 300)}px`;
    this.container.style.display = 'block';

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

    // Also fill confirm password if present
    const form = target.closest('form');
    if (form) {
      const pwFields = form.querySelectorAll('input[type="password"]');
      for (const field of pwFields) {
        if (field !== target) {
          nativeSetter.call(field, pw);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }

    this.hide();
  },

  destroy() {
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  },
};
