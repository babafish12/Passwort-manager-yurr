// Entry list logic
const EntryList = {
  entries: [],

  init() {
    this.screen = document.getElementById('list-screen');
    this.listEl = document.getElementById('entry-list');
    this.searchInput = document.getElementById('search-input');
    this.addBtn = document.getElementById('add-btn');

    this.searchInput.addEventListener('input', () => this.filterEntries());
    this.addBtn.addEventListener('click', () => {
      EntryForm.showAdd();
    });
  },

  async show() {
    this.screen.classList.remove('hidden');
    this.searchInput.value = '';

    try {
      this.entries = await sendMessage('LIST_ENTRIES');
      this.renderEntries(this.entries);
    } catch (err) {
      this.listEl.innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
    }
  },

  hide() {
    this.screen.classList.add('hidden');
  },

  filterEntries() {
    const query = this.searchInput.value.toLowerCase();
    if (!query) {
      this.renderEntries(this.entries);
      return;
    }
    const filtered = this.entries.filter(
      (e) =>
        e.website_domain.toLowerCase().includes(query) ||
        e.username.toLowerCase().includes(query)
    );
    this.renderEntries(filtered);
  },

  renderEntries(entries) {
    if (!entries.length) {
      this.listEl.innerHTML = '<div class="empty-state">No passwords saved yet</div>';
      return;
    }

    this.listEl.innerHTML = entries
      .map(
        (e) => `
      <div class="entry-item" data-id="${e.id}">
        <div class="entry-icon">${e.website_domain.charAt(0).toUpperCase()}</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(e.website_domain)}</div>
          <div class="entry-username">${escapeHtml(e.username)}</div>
        </div>
      </div>
    `
      )
      .join('');

    // Click handlers
    this.listEl.querySelectorAll('.entry-item').forEach((el) => {
      el.addEventListener('click', () => {
        EntryDetail.show(el.dataset.id);
      });
    });
  },
};
