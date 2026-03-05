// Entry detail logic
const EntryDetail = {
  currentEntry: null,
  passwordVisible: false,

  init() {
    this.screen = document.getElementById('detail-screen');
    this.domainEl = document.getElementById('detail-domain');
    this.urlEl = document.getElementById('detail-url');
    this.usernameEl = document.getElementById('detail-username');
    this.passwordEl = document.getElementById('detail-password');
    this.notesEl = document.getElementById('detail-notes');
    this.notesField = document.getElementById('detail-notes-field');
    this.togglePwBtn = document.getElementById('toggle-password');

    document.getElementById('back-from-detail').addEventListener('click', () => {
      this.hide();
      EntryList.show();
    });

    this.togglePwBtn.addEventListener('click', () => this.togglePassword());

    document.getElementById('edit-entry-btn').addEventListener('click', () => {
      if (this.currentEntry) {
        EntryForm.showEdit(this.currentEntry);
      }
    });

    document.getElementById('delete-entry-btn').addEventListener('click', () => this.handleDelete());

    // Copy buttons
    this.screen.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.copy;
        const el = document.getElementById(targetId);
        if (targetId === 'detail-url' && this.currentEntry) {
          window.open(this.currentEntry.website_url, '_blank');
          return;
        }
        let text;
        if (targetId === 'detail-password') {
          text = this.currentEntry?.password || '';
        } else {
          text = el.textContent;
        }
        navigator.clipboard.writeText(text).then(() => showToast('Copied!'));
      });
    });
  },

  async show(entryId) {
    this.passwordVisible = false;

    try {
      const entry = await sendMessage('GET_ENTRY', { id: entryId });
      this.currentEntry = entry;

      this.domainEl.textContent = entry.website_domain;
      this.urlEl.textContent = entry.website_url;
      this.usernameEl.textContent = entry.username;
      this.passwordEl.textContent = '\u2022'.repeat(12);
      this.togglePwBtn.innerHTML = '&#128065;';

      if (entry.notes) {
        this.notesEl.textContent = entry.notes;
        this.notesField.classList.remove('hidden');
      } else {
        this.notesField.classList.add('hidden');
      }

      EntryList.hide();
      this.screen.classList.remove('hidden');
    } catch (err) {
      showToast('Error: ' + err.message);
    }
  },

  hide() {
    this.screen.classList.add('hidden');
    this.currentEntry = null;
  },

  togglePassword() {
    this.passwordVisible = !this.passwordVisible;
    if (this.passwordVisible) {
      this.passwordEl.textContent = this.currentEntry.password;
      this.passwordEl.classList.remove('password-masked');
      this.togglePwBtn.innerHTML = '&#128064;';
    } else {
      this.passwordEl.textContent = '\u2022'.repeat(12);
      this.passwordEl.classList.add('password-masked');
      this.togglePwBtn.innerHTML = '&#128065;';
    }
  },

  async handleDelete() {
    if (!this.currentEntry) return;
    if (!confirm(`Delete credentials for ${this.currentEntry.website_domain}?`)) return;

    try {
      await sendMessage('DELETE_ENTRY', { id: this.currentEntry.id });
      showToast('Entry deleted');
      this.hide();
      EntryList.show();
    } catch (err) {
      showToast('Error: ' + err.message);
    }
  },
};
