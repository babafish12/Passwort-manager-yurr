// Login screen logic
const LoginScreen = {
  init() {
    this.screen = document.getElementById('login-screen');
    this.loginForm = this.screen.querySelector('.login-form');
    this.passwordInput = document.getElementById('master-password');
    this.unlockBtn = document.getElementById('unlock-btn');
    this.errorEl = document.getElementById('login-error');
    this.statusDot = document.getElementById('server-status');
    this.statusText = document.getElementById('server-status-text');
    this.setupSection = document.getElementById('setup-section');
    this.setupBtn = document.getElementById('setup-btn');
    this.lastStatusOffline = false;
    this.busy = false;
    this.controlState = 'checking';
    this.statusGeneration = 0;
    this.statusCheckInProgress = false;

    this.unlockBtn.addEventListener('click', () => this.handleUnlock());
    this.passwordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.controlState === 'setup') this.handleSetup();
        else if (this.controlState === 'unlock') this.handleUnlock();
      }
    });
    this.setupBtn.addEventListener('click', () => this.handleSetup());
  },

  async show({
    animate = true,
    awaitStatus = false,
    allowResume = false,
    allowHiddenResume = false,
    reveal = true,
    focus = true,
  } = {}) {
    if (reveal) {
      this.reveal({ animate, focus: false });
    }
    this.errorEl.classList.add('hidden');
    this.passwordInput.value = '';
    this.setStatus('checking', 'Checking server...');
    this.setLoginControls('checking');

    const statusCheck = this.checkStatus({ allowResume, allowHiddenResume });
    const statusResult = awaitStatus ? await statusCheck : null;

    if (reveal && focus && !this.screen.classList.contains('hidden')) {
      this.focusPasswordInput();
    }
    if (reveal && !this.screen.classList.contains('hidden')) {
      this.startStatusPolling();
    }

    return awaitStatus ? statusResult : statusCheck;
  },

  reveal({ animate = true, focus = true } = {}) {
    this.screen.classList.remove('hidden');
    if (animate) {
      window.animatePopupScreen?.(this.screen, 'back');
    }
    if (this.loginForm) {
      this.loginForm.classList.remove('login-form-animate');
      requestAnimationFrame(() => this.loginForm.classList.add('login-form-animate'));
    }
    if (focus) {
      this.focusPasswordInput();
    }
  },

  revealPrepared({ animate = true, focus = true } = {}) {
    this.reveal({ animate, focus });
    if (!this.screen.classList.contains('hidden')) {
      this.startStatusPolling();
    }
  },

  focusPasswordInput() {
    this.passwordInput.focus({ preventScroll: true });
  },

  startStatusPolling() {
    this.stopStatusPolling();
    this.statusInterval = setInterval(() => this.checkStatus({ allowResume: true }), 3000);
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

  setStatus(state, message) {
    this.statusDot.classList.toggle('online', state === 'online');
    this.statusDot.classList.toggle('offline', state === 'offline');
    if (this.statusText) {
      this.statusText.textContent = message;
    }
  },

  setLoginControls(state) {
    this.controlState = state;
    this.passwordInput.autocomplete = state === 'setup' ? 'new-password' : 'current-password';
    if (state === 'setup') {
      this.setupSection.classList.remove('hidden');
      this.unlockBtn.classList.add('hidden');
      this.unlockBtn.disabled = true;
      this.setupBtn.disabled = this.busy;
      return;
    }

    this.setupSection.classList.add('hidden');
    this.unlockBtn.classList.toggle('hidden', state !== 'unlock');
    this.unlockBtn.disabled = state !== 'unlock' || this.busy;
  },

  async checkStatus({ allowResume = true, allowHiddenResume = false } = {}) {
    if (this.busy || this.statusCheckInProgress) return null;
    const generation = this.statusGeneration;
    this.statusCheckInProgress = true;
    try {
      // Fetch directly from popup context (not via service worker)
      // so the browser's cert exceptions are respected immediately
      const serverUrl = await this.getServerUrl();
      const resp = await fetch(`${serverUrl}/api/v1/auth/status`, {
        signal: AbortSignal.timeout(8000), cache: 'no-store', redirect: 'error', credentials: 'omit',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const status = await resp.json();
      if (typeof status.initialized !== 'boolean') throw new Error('Invalid server response');
      if (generation !== this.statusGeneration || this.busy) return null;

      this.setStatus('online', status.initialized ? 'Server online. Vault locked.' : 'Server online. Vault setup needed.');
      this.hideCertHint();

      if (!status.initialized) {
        this.setLoginControls('setup');
      } else {
        this.setLoginControls('unlock');
        if (allowResume && !this.passwordInput.value) {
          const resumed = await window.tryResumeUnlockedSession?.({
            showToast: this.lastStatusOffline,
            allowHidden: allowHiddenResume,
          });
          if (resumed) {
            this.lastStatusOffline = false;
            return { online: true, initialized: true, resumed: true };
          }
        }
      }
      this.lastStatusOffline = false;
      return { online: true, initialized: status.initialized, resumed: false };
    } catch {
      if (generation !== this.statusGeneration || this.busy) return null;
      this.setStatus('offline', 'Server offline. Check connection or certificate.');
      this.setLoginControls('unlock');
      this.showCertHint();
      this.lastStatusOffline = true;
      return { online: false, initialized: null, resumed: false };
    } finally {
      this.statusCheckInProgress = false;
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
    this.statusGeneration += 1;
    this.screen.classList.add('hidden');
    this.passwordInput.value = '';
    this.stopStatusPolling();
  },

  async handleUnlock() {
    if (this.busy || this.controlState !== 'unlock') return;
    const password = this.passwordInput.value;
    if (!password) return;

    this.busy = true;
    this.statusGeneration += 1;
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
      void window.refreshActiveCredentialTab?.();
    } catch (err) {
      this.errorEl.textContent = err.message || 'Login failed';
      this.errorEl.classList.remove('hidden');
    } finally {
      this.busy = false;
      window.setButtonLoading?.(this.unlockBtn, false);
    }
  },

  async handleSetup() {
    if (this.busy || this.controlState !== 'setup') return;
    const password = this.passwordInput.value;
    if (!password || password.length < 8) {
      this.errorEl.textContent = 'Password must be at least 8 characters';
      this.errorEl.classList.remove('hidden');
      return;
    }

    this.busy = true;
    this.statusGeneration += 1;
    window.setButtonLoading?.(this.setupBtn, true, 'Setting up...');

    try {
      await sendMessage('SETUP', { masterPassword: password });
      showToast('Vault created! Now log in.');
      this.setLoginControls('unlock');
      this.passwordInput.value = '';
      this.focusPasswordInput();
    } catch (err) {
      this.errorEl.textContent = err.message || 'Setup failed';
      this.errorEl.classList.remove('hidden');
    } finally {
      this.busy = false;
      window.setButtonLoading?.(this.setupBtn, false);
      this.setLoginControls(this.controlState);
    }
  },
};
