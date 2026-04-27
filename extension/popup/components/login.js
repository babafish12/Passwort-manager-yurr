// Login screen logic
const LoginScreen = {
  init() {
    this.screen = document.getElementById('login-screen');
    this.loginForm = this.screen.querySelector('.login-form');
    this.passwordInput = document.getElementById('master-password');
    this.unlockBtn = document.getElementById('unlock-btn');
    this.errorEl = document.getElementById('login-error');
    this.statusDot = document.getElementById('server-status');
    this.setupSection = document.getElementById('setup-section');
    this.setupBtn = document.getElementById('setup-btn');

    this.unlockBtn.addEventListener('click', () => this.handleUnlock());
    this.passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleUnlock();
    });
    this.setupBtn.addEventListener('click', () => this.handleSetup());
  },

  async show() {
    this.screen.classList.remove('hidden');
    window.animatePopupScreen?.(this.screen, 'back');
    if (this.loginForm) {
      this.loginForm.classList.remove('login-form-animate');
      requestAnimationFrame(() => this.loginForm.classList.add('login-form-animate'));
    }
    this.errorEl.classList.add('hidden');
    this.passwordInput.value = '';
    this.passwordInput.focus();

    this.checkStatus();
    this.startStatusPolling();
  },

  startStatusPolling() {
    this.stopStatusPolling();
    this.statusInterval = setInterval(() => this.checkStatus(), 3000);
  },

  stopStatusPolling() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  },

  async getServerUrl() {
    const result = await chrome.storage.local.get('yurrr_server_url');
    return result['yurrr_server_url'] || 'https://localhost:8443';
  },

  async checkStatus() {
    try {
      // Fetch directly from popup context (not via service worker)
      // so the browser's cert exceptions are respected immediately
      const serverUrl = await this.getServerUrl();
      const resp = await fetch(`${serverUrl}/api/v1/auth/status`);
      const status = await resp.json();

      this.statusDot.classList.add('online');
      this.statusDot.classList.remove('offline');
      this.hideCertHint();

      if (!status.initialized) {
        this.setupSection.classList.remove('hidden');
        this.unlockBtn.classList.add('hidden');
      } else {
        this.setupSection.classList.add('hidden');
        this.unlockBtn.classList.remove('hidden');
      }
    } catch {
      this.statusDot.classList.add('offline');
      this.statusDot.classList.remove('online');
      this.showCertHint();
    }
  },

  showCertHint() {
    if (document.getElementById('cert-hint')) return;
    const hint = document.createElement('div');
    hint.id = 'cert-hint';
    hint.className = 'cert-hint';
    hint.innerHTML = 'Can\'t reach server. <a id="cert-link" href="#">Accept certificate</a>';
    this.errorEl.parentNode.insertBefore(hint, this.errorEl.nextSibling);
    document.getElementById('cert-link').addEventListener('click', async (e) => {
      e.preventDefault();
      const serverUrl = await this.getServerUrl();
      chrome.tabs.create({ url: `${serverUrl}/api/v1/auth/status` });
    });
  },

  hideCertHint() {
    const hint = document.getElementById('cert-hint');
    if (hint) hint.remove();
  },

  hide() {
    this.screen.classList.add('hidden');
    this.stopStatusPolling();
  },

  async handleUnlock() {
    const password = this.passwordInput.value;
    if (!password) return;

    window.setButtonLoading?.(this.unlockBtn, true, 'Unlocking...');
    this.errorEl.classList.add('hidden');

    try {
      await sendMessage('LOGIN', { masterPassword: password });
      window.VaultSections?.invalidateEntityCache?.();
      this.hide();
      if (window.VaultSections?.setActiveTab) {
        await window.VaultSections.setActiveTab(window.VaultSections.activeTab || 'passwords');
      } else {
        EntryList.show();
      }
      document.getElementById('lock-btn').classList.remove('hidden');
    } catch (err) {
      this.errorEl.textContent = err.message || 'Login failed';
      this.errorEl.classList.remove('hidden');
    } finally {
      window.setButtonLoading?.(this.unlockBtn, false);
    }
  },

  async handleSetup() {
    const password = this.passwordInput.value;
    if (!password || password.length < 8) {
      this.errorEl.textContent = 'Password must be at least 8 characters';
      this.errorEl.classList.remove('hidden');
      return;
    }

    window.setButtonLoading?.(this.setupBtn, true, 'Setting up...');

    try {
      await sendMessage('SETUP', { masterPassword: password });
      showToast('Vault created! Now log in.');
      this.setupSection.classList.add('hidden');
      this.unlockBtn.classList.remove('hidden');
    } catch (err) {
      this.errorEl.textContent = err.message || 'Setup failed';
      this.errorEl.classList.remove('hidden');
    } finally {
      window.setButtonLoading?.(this.setupBtn, false);
    }
  },
};
