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

    document.getElementById('back-from-form').addEventListener('click', () => this.cancel());
    this.cancelBtn.addEventListener('click', () => this.cancel());
    this.saveBtn.addEventListener('click', () => this.handleSave());
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

    EntryList.hide();
    this.screen.classList.remove('hidden');
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

    EntryDetail.hide();
    this.screen.classList.remove('hidden');
    PasswordGenerator.updateStrength(entry.password);
  },

  cancel() {
    this.screen.classList.add('hidden');
    if (this.editingId) {
      EntryDetail.show(this.editingId);
    } else {
      EntryList.show();
    }
  },

  togglePassword() {
    this.passwordInput.type = this.passwordInput.type === 'password' ? 'text' : 'password';
  },

  async generatePassword() {
    try {
      const result = await sendMessage('GENERATE_PASSWORD', { length: 20 });
      this.passwordInput.value = result.password;
      this.passwordInput.type = 'text';
      PasswordGenerator.updateStrength(result.password);
    } catch (err) {
      showToast('Error: ' + err.message);
    }
  },

  async handleSave() {
    const url = this.urlInput.value.trim();
    const username = this.usernameInput.value.trim();
    const password = this.passwordInput.value;
    const notes = this.notesInput.value.trim();

    if (!url || !username || !password) {
      showToast('URL, username, and password are required');
      return;
    }

    this.saveBtn.disabled = true;
    this.saveBtn.textContent = 'Saving...';

    try {
      if (this.editingId) {
        await sendMessage('UPDATE_ENTRY', {
          id: this.editingId,
          data: { website_url: url, username, password, notes: notes || null },
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
      EntryList.show();
    } catch (err) {
      showToast('Error: ' + err.message);
    } finally {
      this.saveBtn.disabled = false;
      this.saveBtn.textContent = 'Save';
    }
  },
};
