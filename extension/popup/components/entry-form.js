// Entry add/edit form logic
const EntryForm = {
  editingId: null,

  init() {
    this.screen = document.getElementById('form-screen');
    this.titleEl = document.getElementById('form-title');
    this.urlInput = document.getElementById('form-url');
    this.usernameInput = document.getElementById('form-username');
    this.passwordInput = document.getElementById('form-password');
    this.notesInput = document.getElementById('form-notes');
    this.saveBtn = document.getElementById('form-save');
    this.cancelBtn = document.getElementById('form-cancel');
    this.togglePwBtn = document.getElementById('form-toggle-pw');
    this.generateBtn = document.getElementById('form-generate');
    this.form = document.getElementById('entry-form');

    document.getElementById('back-from-form').addEventListener('click', () => this.cancel());
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handleSave();
    });
    this.togglePwBtn.addEventListener('click', () => this.togglePassword());
    this.generateBtn.addEventListener('click', () => this.generatePassword());

    this.passwordInput.addEventListener('input', () => PasswordGenerator.updateStrength(this.passwordInput.value));
  },

  showAdd() {
    this.editingId = null;
    this.titleEl.textContent = 'Add Entry';
    this.urlInput.value = '';
    this.usernameInput.value = '';
    this.passwordInput.value = '';
    this.notesInput.value = '';
    this.passwordInput.type = 'password';
    this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
    this.togglePwBtn.title = 'Show password';
    this.togglePwBtn.setAttribute('aria-label', 'Show password');

    EntryList.hide();
    this.screen.classList.remove('hidden');
    window.animatePopupScreen?.(this.screen, 'forward');
    this.urlInput.focus();
    PasswordGenerator.updateStrength('');
  },

  showEdit(entry) {
    this.editingId = entry.id;
    this.titleEl.textContent = 'Edit Entry';
    this.urlInput.value = entry.website_url;
    this.usernameInput.value = entry.username;
    this.passwordInput.value = entry.password;
    this.notesInput.value = entry.notes || '';
    this.passwordInput.type = 'password';
    this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eye', 'icon-sm') : '';
    this.togglePwBtn.title = 'Show password';
    this.togglePwBtn.setAttribute('aria-label', 'Show password');

    EntryDetail.hide();
    this.screen.classList.remove('hidden');
    window.animatePopupScreen?.(this.screen, 'forward');
    PasswordGenerator.updateStrength(entry.password);
    this.urlInput.focus();
  },

  cancel() {
    const editingId = this.editingId;
    this.screen.classList.add('hidden');
    this.clearSensitiveFields();
    if (editingId) {
      EntryDetail.show(editingId);
    } else {
      EntryList.show();
    }
  },

  clearSensitiveFields() {
    this.editingId = null;
    this.urlInput.value = '';
    this.usernameInput.value = '';
    this.passwordInput.value = '';
    this.notesInput.value = '';
    this.passwordInput.type = 'password';
    PasswordGenerator.updateStrength('');
  },

  togglePassword() {
    this.passwordInput.type = this.passwordInput.type === 'password' ? 'text' : 'password';
    this.togglePwBtn.innerHTML = window.getPopupIcon
      ? window.getPopupIcon(this.passwordInput.type === 'password' ? 'eye' : 'eyeOff', 'icon-sm')
      : '';
    const isVisible = this.passwordInput.type === 'text';
    this.togglePwBtn.title = isVisible ? 'Hide password' : 'Show password';
    this.togglePwBtn.setAttribute('aria-label', isVisible ? 'Hide password' : 'Show password');
  },

  async generatePassword() {
    try {
      const result = await sendMessage('GENERATE_PASSWORD', { length: 20 });
      this.passwordInput.value = result.password;
      this.passwordInput.type = 'text';
      this.togglePwBtn.innerHTML = window.getPopupIcon ? window.getPopupIcon('eyeOff', 'icon-sm') : '';
      this.togglePwBtn.title = 'Hide password';
      this.togglePwBtn.setAttribute('aria-label', 'Hide password');
      PasswordGenerator.updateStrength(result.password);
    } catch (err) {
      if (isSessionLostError(err)) return;
      showToast('Error: ' + err.message, 'error');
    }
  },

  async handleSave() {
    if (this.saveBtn.disabled || !this.form.reportValidity()) return;
    const url = this.urlInput.value.trim();
    const username = this.usernameInput.value.trim();
    const password = this.passwordInput.value;
    const notes = this.notesInput.value.trim();

    if (!url || !username || !password) {
      showToast('URL, username, and password are required', 'error');
      return;
    }

    window.setButtonLoading?.(this.saveBtn, true, 'Saving...');

    try {
      if (this.editingId) {
        await sendMessage('UPDATE_ENTRY', {
          id: this.editingId,
          data: { website_url: url, username, password, notes },
        });
        showToast('Entry updated');
      } else {
        await sendMessage('CREATE_ENTRY', {
          website_url: url,
          username,
          password,
          notes: notes || null,
        });
        showToast('Entry saved');
      }

      this.screen.classList.add('hidden');
      this.clearSensitiveFields();
      EntryList.show();
    } catch (err) {
      if (isSessionLostError(err)) return;
      showToast('Error: ' + err.message, 'error');
    } finally {
      window.setButtonLoading?.(this.saveBtn, false);
    }
  },
};
