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
      if (window.VaultSections?.handleAddFromList?.()) {
        return;
      }
      EntryForm.showAdd();
    });
  },

  async show() {
    this.screen.classList.remove('hidden');
    window.animatePopupScreen?.(this.screen, 'back');
    this.searchInput.value = '';
    this.searchInput.focus();

    try {
      this.entries = await sendMessage('LIST_ENTRIES');
      this.renderEntries(this.entries);
    } catch (err) {
      if (isSessionLostError(err)) {
        return;
      }
      this.listEl.innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
    }
  },

  hide() {
    this.screen.classList.add('hidden');
  },

  filterEntries() {
    if (window.VaultSections?.handleSearchInput?.()) {
      return;
    }

    const query = this.searchInput.value.toLowerCase();
    if (!query) {
      this.renderEntries(this.entries);
      return;
    }
    const filtered = this.entries.filter(
      (e) =>
        (e.website_domain || '').toLowerCase().includes(query) ||
        (e.username || '').toLowerCase().includes(query)
    );
    this.renderEntries(filtered);
  },

  renderEntries(entries) {
    if (!entries.length) {
      this.listEl.innerHTML = '<div class="empty-state">No passwords saved yet</div>';
      return;
    }

    this.listEl.innerHTML = entries
      .map((e) => {
        const domain = e.website_domain || '';
        const initial = domain ? domain.charAt(0).toUpperCase() : '?';
        const entryId = escapeHtml(e.id);
        const username = escapeHtml(e.username || '');
        const icon = window.getPopupIcon ? window.getPopupIcon('trash', 'icon-sm') : '';
        const chevron = window.getPopupIcon ? window.getPopupIcon('chevronRight', 'icon-xs') : '';
        return `
      <div class="entry-item" data-id="${entryId}">
        <div class="entry-icon" data-favicon-domain="${escapeHtml(domain)}">${initial}</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(domain)}</div>
          <div class="entry-username">${username}</div>
        </div>
        <button class="mini-icon-btn danger" data-entry-delete="${entryId}" title="Delete" type="button">${icon}</button>
        <span class="entry-chevron">${chevron}</span>
      </div>
    `;
      })
      .join('');

    // Click handlers
    this.listEl.querySelectorAll('.entry-item').forEach((el) => {
      el.addEventListener('click', () => {
        EntryDetail.show(el.dataset.id);
      });
    });

    // Delete handlers
    this.listEl.querySelectorAll('[data-entry-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.deleteEntry(btn.dataset.entryDelete);
      });
    });

    // Load favicons asynchronously
    this.loadFavicons();
  },

  async deleteEntry(entryId) {
    const entry = this.entries.find((item) => item.id === entryId);
    if (!entry) return;

    const domainLabel = window.truncateText ? window.truncateText(entry.website_domain || '') : entry.website_domain || '';
    const userLabel = window.truncateText ? window.truncateText(entry.username || '') : entry.username || '';
    const shouldDelete = await window.showConfirmDialog({
      title: 'Delete Password',
      message: `Delete "${domainLabel}" (${userLabel})? This cannot be undone.`,
      confirmText: 'Delete Entry',
      confirmIcon: 'trash',
      cancelText: 'Cancel',
      destructive: true,
    });

    if (!shouldDelete) return;

    try {
      await sendMessage('DELETE_ENTRY', { id: entryId });
      this.entries = this.entries.filter((item) => item.id !== entryId);
      this.filterEntries();
      showToast(`Deleted ${domainLabel}`);
    } catch (err) {
      if (isSessionLostError(err)) return;
      showToast('Error: ' + err.message, 'error');
    }
  },

  async loadFavicons() {
    const iconEls = this.listEl.querySelectorAll('.entry-icon[data-favicon-domain]');
    const domains = new Set();
    iconEls.forEach((el) => domains.add(el.dataset.faviconDomain));

    for (const domain of domains) {
      if (!domain) {
        continue;
      }
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
