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

  async show({ animate = true, initialEntries = null } = {}) {
    this.screen.classList.remove('hidden');
    if (animate) {
      window.animatePopupScreen?.(this.screen, 'back');
    }
    this.searchInput.value = '';
    this.focusSearchInput();

    try {
      this.entries = Array.isArray(initialEntries) ? initialEntries : await sendMessage('LIST_ENTRIES');
      this.renderEntries(this.entries);
      this.focusSearchInput();
    } catch (err) {
      if (isSessionLostError(err)) {
        return;
      }
      this.renderEmptyState(`Failed to load: ${err.message || 'Unknown error'}`);
      this.focusSearchInput();
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
      this.renderEmptyState('No passwords saved yet');
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
      <div class="entry-item" data-id="${entryId}" role="button" tabindex="0">
        <div class="entry-icon" data-favicon-domain="${escapeHtml(domain)}">${escapeHtml(initial)}</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(domain)}</div>
          <div class="entry-username">${username}</div>
        </div>
        <button class="mini-icon-btn danger" data-entry-delete="${entryId}" title="Delete" aria-label="Delete password" type="button">${icon}</button>
        <span class="entry-chevron">${chevron}</span>
      </div>
    `;
      })
      .join('');

    // Click handlers
    this.listEl.querySelectorAll('.entry-item').forEach((el) => {
      const openEntry = () => {
        EntryDetail.show(el.dataset.id);
      };

      el.addEventListener('click', (event) => {
        if (event.target.closest('[data-entry-delete]')) return;
        openEntry();
      });

      el.addEventListener('keydown', (event) => {
        if ((event.key !== 'Enter' && event.key !== ' ') || event.target.closest('[data-entry-delete]')) return;
        event.preventDefault();
        openEntry();
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

  renderEmptyState(message) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = message;
    this.listEl.replaceChildren(empty);
  },

  focusSearchInput() {
    if (!this.searchInput || this.screen.classList.contains('hidden')) return;

    this.searchInput.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (!this.searchInput || this.screen.classList.contains('hidden')) return;
      this.searchInput.focus({ preventScroll: true });
    });
    setTimeout(() => {
      if (!this.searchInput || this.screen.classList.contains('hidden')) return;
      this.searchInput.focus({ preventScroll: true });
    }, 50);
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
    if (window.areFaviconsEnabled && !(await window.areFaviconsEnabled())) {
      return;
    }

    const iconEls = this.listEl.querySelectorAll('.entry-icon[data-favicon-domain]');
    const domains = new Set();
    iconEls.forEach((el) => domains.add(el.dataset.faviconDomain));

    for (const domain of domains) {
      if (!domain) {
        continue;
      }
      try {
        const result = await sendMessage('GET_FAVICON', { domain });
        if (result && this.isSafeImageDataUrl(result.dataUrl)) {
          this.listEl
            .querySelectorAll(`.entry-icon[data-favicon-domain="${CSS.escape(domain)}"]`)
            .forEach((el) => {
              const img = document.createElement('img');
              img.src = result.dataUrl;
              img.alt = '';
              el.replaceChildren(img);
            });
        }
      } catch {
        // Keep letter fallback
      }
    }
  },

  isSafeImageDataUrl(dataUrl) {
    return /^data:image\/(png|jpe?g|webp|gif|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=]+$/i
      .test(String(dataUrl || ''));
  },
};
