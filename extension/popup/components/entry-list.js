// Entry list logic
const EntryList = {
  entries: [],
  expiresAt: 0,
  expiryTimer: null,
  page: 0,
  pageSize: 50,
  faviconGeneration: 0,
  faviconObserver: null,

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

  async show({ animate = true, initialSnapshot = null, focusSearch = true, preserveSearch = false } = {}) {
    const generation = ++window.VaultSections.renderGeneration;
    this.screen.classList.remove('hidden');
    if (animate) {
      window.animatePopupScreen?.(this.screen, 'back');
    }
    if (!preserveSearch) this.searchInput.value = '';
    if (initialSnapshot) this.applySnapshot(initialSnapshot);
    else if (this.expiresAt > Date.now()) this.filterEntries();
    else this.renderLoadingState('Loading passwords...');

    try {
      const snapshot = initialSnapshot || await sendMessage('POPUP_LIST');
      if (generation !== window.VaultSections.renderGeneration) return;
      this.applySnapshot(snapshot);
      if (focusSearch) this.focusSearchInput();
    } catch (err) {
      if (isSessionLostError(err) || err.code === 'CACHE_CHANGED' || generation !== window.VaultSections.renderGeneration) {
        return;
      }
      this.renderEmptyState(`Could not load passwords. ${err.message || 'Check the server connection.'}`, 'Try again', () => this.show());
      if (focusSearch) this.focusSearchInput();
    }
  },

  applySnapshot(snapshot) {
    if (!snapshot || snapshot.expiresAt <= Date.now()) return;
    this.entries = snapshot.data;
    this.expiresAt = snapshot.expiresAt;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.invalidate(), Math.max(0, this.expiresAt - Date.now()));
    window.updateCacheConnection?.(snapshot.offline);
    if (!this.screen.classList.contains('hidden') && window.VaultSections.activeTab === 'passwords') {
      this.filterEntries({ resetPage: false });
    }
  },

  invalidate() {
    this.cancelFavicons();
    clearTimeout(this.expiryTimer);
    this.expiresAt = 0;
    this.entries = [];
    if (!this.screen.classList.contains('hidden') && window.VaultSections.activeTab === 'passwords') {
      this.renderEmptyState('Reload passwords to get the latest data.', 'Reload', () => this.show({ preserveSearch: true }));
    }
  },

  async refresh({ cacheOnly = true } = {}) {
    const generation = window.VaultSections.renderGeneration;
    try {
      const snapshot = await sendMessage('POPUP_LIST', { activity: false, refresh: false, cacheOnly });
      if (generation !== window.VaultSections.renderGeneration) return;
      if (snapshot) this.applySnapshot(snapshot);
      else this.invalidate();
    } catch (err) {
      if (isSessionLostError(err) || err.code === 'CACHE_CHANGED') return;
      window.updateCacheConnection?.(err.code === 'NETWORK_ERROR');
    }
  },

  hide() {
    this.cancelFavicons();
    this.screen.classList.add('hidden');
  },

  filterEntries({ resetPage = true } = {}) {
    if (window.VaultSections?.handleSearchInput?.()) {
      return;
    }

    if (resetPage) this.page = 0;
    const query = this.searchInput.value.trim().toLowerCase();
    if (!query) {
      this.renderEntries(this.entries);
      return;
    }
    const filtered = this.entries.filter(
      (e) =>
        YurrrSiteScope.label(e).toLowerCase().includes(query) ||
        (e.username || '').toLowerCase().includes(query)
    );
    this.renderEntries(filtered);
  },

  renderEntries(entries) {
    this.cancelFavicons();
    if (!entries.length) {
      this.renderSearchEmptyState('passwords', this.searchInput.value.trim());
      return;
    }

    this.page = Math.max(0, Math.min(this.page, Math.ceil(entries.length / this.pageSize) - 1));
    const start = this.page * this.pageSize;
    this.listEl.innerHTML = entries.slice(start, start + this.pageSize)
      .map((e) => {
        const domain = YurrrSiteScope.label(e);
        const initial = domain ? domain.charAt(0).toUpperCase() : '?';
        const entryId = escapeHtml(e.id);
        const websiteUrl = escapeHtml(e.website_url || '');
        const hasFavicon = e.has_favicon === true ? 'true' : 'false';
        const username = escapeHtml(e.username || '');
        const icon = window.getPopupIcon ? window.getPopupIcon('trash', 'icon-sm') : '';
        const chevron = window.getPopupIcon ? window.getPopupIcon('chevronRight', 'icon-xs') : '';
        const label = escapeHtml(`Open password for ${domain || username || 'entry'}`);
        const deleteLabel = escapeHtml(`Delete password for ${domain || username || 'entry'}`);
        return `
      <div class="entry-item">
        <button class="entry-main" data-id="${entryId}" type="button" aria-label="${label}">
          <div class="entry-icon" data-favicon-domain="${escapeHtml(e.website_domain || '')}" data-favicon-url="${websiteUrl}" data-has-favicon="${hasFavicon}">${escapeHtml(initial)}</div>
          <div class="entry-info">
            <div class="entry-domain">${escapeHtml(domain)}</div>
            <div class="entry-username">${username}</div>
          </div>
          <span class="entry-chevron" aria-hidden="true">${chevron}</span>
        </button>
        <button class="mini-icon-btn danger" data-entry-delete="${entryId}" title="Delete" aria-label="${deleteLabel}" type="button">${icon}</button>
      </div>
    `;
      })
      .join('');

    if (entries.length > this.pageSize) {
      this.listEl.insertAdjacentHTML('beforeend', `<nav class="list-pagination" aria-label="Password pages">
        <button type="button" class="btn btn-secondary" data-page="previous" ${this.page === 0 ? 'disabled' : ''}>Previous</button>
        <span aria-live="polite">${start + 1}–${Math.min(start + this.pageSize, entries.length)} of ${entries.length}</span>
        <button type="button" class="btn btn-secondary" data-page="next" ${start + this.pageSize >= entries.length ? 'disabled' : ''}>Next</button>
      </nav>`);
      this.listEl.querySelectorAll('[data-page]').forEach((button) => {
        button.addEventListener('click', () => {
          const direction = button.dataset.page;
          this.page += direction === 'next' ? 1 : -1;
          this.renderEntries(entries);
          this.listEl.scrollTop = 0;
          const next = this.listEl.querySelector(`[data-page="${direction}"]:not(:disabled)`)
            || this.listEl.querySelector('[data-page]:not(:disabled)');
          next?.focus({ preventScroll: true });
        });
      });
    }

    // Click handlers
    this.listEl.querySelectorAll('.entry-main[data-id]').forEach((el) => {
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

  renderEmptyState(message, actionLabel, action) {
    this.cancelFavicons();
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = message;
    if (actionLabel && action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-secondary empty-state-action';
      button.textContent = actionLabel;
      button.addEventListener('click', action);
      empty.appendChild(button);
    }
    this.listEl.replaceChildren(empty);
  },

  renderSearchEmptyState(label, query) {
    if (query) {
      this.renderEmptyState(`No ${label} match “${query}”.`, 'Clear search', () => {
        this.searchInput.value = '';
        this.filterEntries();
        this.searchInput.focus();
      });
    } else {
      this.renderEmptyState(`No ${label} saved yet. Add your first item to get started.`, this.addBtn.title, () => this.addBtn.click());
    }
  },

  renderLoadingState(message = 'Loading...') {
    this.cancelFavicons();
    this.listEl.innerHTML = `
      <div class="list-skeleton" role="status" aria-live="polite" aria-label="${escapeHtml(message)}">
        <div class="list-skeleton-line"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
        <div class="skeleton-row"></div>
      </div>
    `;
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

  cancelFavicons() {
    this.faviconGeneration += 1;
    this.faviconObserver?.disconnect();
    this.faviconObserver = null;
  },

  async loadFavicons() {
    const generation = this.faviconGeneration;
    if (!(await window.areFaviconsEnabled?.()) || generation !== this.faviconGeneration) return;
    const load = async (el) => {
      const isCurrent = () => generation === this.faviconGeneration && this.listEl.contains(el);
      const image = await FaviconLoader.load({
        website_url: el.dataset.faviconUrl,
        website_domain: el.dataset.faviconDomain,
        has_favicon: el.dataset.hasFavicon === 'true',
      }, isCurrent);
      if (image && isCurrent()) el.replaceChildren(image);
    };
    const icons = this.listEl.querySelectorAll('.entry-icon[data-favicon-domain]');
    if (typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver((records) => {
        for (const record of records) {
          if (!record.isIntersecting) continue;
          observer.unobserve(record.target);
          void load(record.target);
        }
      }, { root: this.listEl, rootMargin: '80px' });
      this.faviconObserver = observer;
      icons.forEach((icon) => observer.observe(icon));
    } else {
      await Promise.all(Array.from(icons, load));
    }
  },
};
