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

  async show({ animate = true, initialEntries = null, focusSearch = true } = {}) {
    const generation = ++window.VaultSections.renderGeneration;
    this.screen.classList.remove('hidden');
    if (animate) {
      window.animatePopupScreen?.(this.screen, 'back');
    }
    this.searchInput.value = '';
    this.renderLoadingState('Loading passwords...');

    try {
      const entries = Array.isArray(initialEntries) ? initialEntries : await sendMessage('LIST_ENTRIES');
      if (generation !== window.VaultSections.renderGeneration) return;
      this.entries = entries;
      this.filterEntries();
      if (focusSearch) this.focusSearchInput();
    } catch (err) {
      if (isSessionLostError(err) || generation !== window.VaultSections.renderGeneration) {
        return;
      }
      this.renderEmptyState(`Could not load passwords. ${err.message || 'Check the server connection.'}`, 'Try again', () => this.show());
      if (focusSearch) this.focusSearchInput();
    }
  },

  hide() {
    this.screen.classList.add('hidden');
  },

  filterEntries() {
    if (window.VaultSections?.handleSearchInput?.()) {
      return;
    }

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
    if (!entries.length) {
      this.renderSearchEmptyState('passwords', this.searchInput.value.trim());
      return;
    }

    this.listEl.innerHTML = entries
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

  async loadFavicons() {
    if (window.areFaviconsEnabled && !(await window.areFaviconsEnabled())) {
      return;
    }

    const iconEls = this.listEl.querySelectorAll('.entry-icon[data-favicon-domain]');
    const faviconsStillEnabled = async () => (
      !window.areFaviconsEnabled || await window.areFaviconsEnabled()
    );
    const canApplyFavicon = async (el) => (
      this.listEl.contains(el) && await faviconsStillEnabled()
    );
    const serverFallbacks = new Map();
    const getServerFallback = async (domain) => {
      if (!domain) {
        return null;
      }
      if (!(await faviconsStillEnabled())) {
        return null;
      }
      if (!serverFallbacks.has(domain)) {
        serverFallbacks.set(
          domain,
          sendMessage('GET_FAVICON', { domain }).catch(() => null)
        );
      }
      return serverFallbacks.get(domain);
    };

    await Promise.all(Array.from(iconEls).map(async (el) => {
      const domain = el.dataset.faviconDomain || '';
      const websiteUrl = el.dataset.faviconUrl || '';
      const hasServerFavicon = el.dataset.hasFavicon === 'true';
      let discoveredLoaded = false;

      const browserFaviconUrl = window.getBrowserFaviconUrl?.(websiteUrl, domain);
      if (browserFaviconUrl) {
        try {
          const img = await window.loadPopupFaviconImage(browserFaviconUrl);
          if (await canApplyFavicon(el)) {
            el.replaceChildren(img);
          }
        } catch {
          // Try the server-provided favicon below.
        }
      }

      try {
        const img = await window.loadDiscoveredFaviconImage?.(websiteUrl, domain);
        if (img) {
          discoveredLoaded = true;
          if (await canApplyFavicon(el)) {
            el.replaceChildren(img);
          }
        }
      } catch {
        // Fall back to the server-provided favicon below.
      }

      if (discoveredLoaded && !hasServerFavicon) {
        return;
      }

      try {
        const result = await getServerFallback(domain);
        if (result && window.isSafeFaviconDataUrl?.(result.dataUrl)) {
          const img = await window.loadPopupFaviconImage(result.dataUrl);
          if (await canApplyFavicon(el)) {
            el.replaceChildren(img);
          }
        }
      } catch {
        // Keep letter fallback
      }
    }));
  },
};
