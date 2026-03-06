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
    this.searchInput.focus();

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
        <div class="entry-icon"${e.has_favicon ? ` data-favicon-domain="${escapeHtml(e.website_domain)}"` : ''}>${e.website_domain.charAt(0).toUpperCase()}</div>
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

    // Load favicons asynchronously
    this.loadFavicons();
  },

  async loadFavicons() {
    const iconEls = this.listEl.querySelectorAll('.entry-icon[data-favicon-domain]');
    const domains = new Set();
    iconEls.forEach((el) => domains.add(el.dataset.faviconDomain));

    for (const domain of domains) {
      try {
        const result = await sendMessage('GET_FAVICON', { domain });
        if (result && result.dataUrl) {
          this.listEl
            .querySelectorAll(`.entry-icon[data-favicon-domain="${CSS.escape(domain)}"]`)
            .forEach((el) => {
              el.innerHTML = `<img src="${result.dataUrl}" alt="">`;
            });
        }
      } catch {
        // Keep letter fallback
      }
    }
  },
};
