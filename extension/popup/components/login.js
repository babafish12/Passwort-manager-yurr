// Login screen logic
const LoginScreen = {
  init() {
    this.screen = document.getElementById('login-screen');
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
    this.errorEl.classList.add('hidden');
    this.passwordInput.value = '';
    this.passwordInput.focus();

    // Check server status
    try {
      const status = await sendMessage('GET_STATUS');
      this.statusDot.classList.add('online');
      this.statusDot.classList.remove('offline');

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
    }
  },

  hide() {
    this.screen.classList.add('hidden');
  },

  async handleUnlock() {
    const password = this.passwordInput.value;
    if (!password) return;

    this.unlockBtn.disabled = true;
    this.unlockBtn.textContent = 'Unlocking...';
    this.errorEl.classList.add('hidden');

    try {
      await sendMessage('LOGIN', { masterPassword: password });
      this.hide();
      EntryList.show();
      document.getElementById('lock-btn').classList.remove('hidden');
    } catch (err) {
      this.errorEl.textContent = err.message || 'Login failed';
      this.errorEl.classList.remove('hidden');
    } finally {
      this.unlockBtn.disabled = false;
      this.unlockBtn.textContent = 'Unlock';
    }
  },

  async handleSetup() {
    const password = this.passwordInput.value;
    if (!password || password.length < 8) {
      this.errorEl.textContent = 'Password must be at least 8 characters';
      this.errorEl.classList.remove('hidden');
      return;
    }

    this.setupBtn.disabled = true;
    this.setupBtn.textContent = 'Setting up...';

    try {
      await sendMessage('SETUP', { masterPassword: password });
      showToast('Vault created! Now log in.');
      this.setupSection.classList.add('hidden');
      this.unlockBtn.classList.remove('hidden');
    } catch (err) {
      this.errorEl.textContent = err.message || 'Setup failed';
      this.errorEl.classList.remove('hidden');
    } finally {
      this.setupBtn.disabled = false;
      this.setupBtn.textContent = 'Initialize Vault';
    }
  },
};
