// Utility: Send message to service worker
function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        const err = new Error(response.error);
        if (response.code) err.code = response.code;
        if (isSessionLostError(err)) {
          handleSessionLoss(err);
        }
        reject(err);
        return;
      }
      resolve(response);
    });
  });
}

const ICONS = {
  lock: [
    '<path d="M8.5 10V7.5a3.5 3.5 0 1 1 7 0V10" />',
    '<rect x="5" y="10" width="14" height="10" rx="2" />',
    '<path d="M12 14v2.5" />',
  ],
  key: [
    '<path d="M14 8a4 4 0 1 1 0 8H7a3 3 0 0 1 0-6h7" />',
    '<path d="m14 12 7 0" />',
    '<path d="m18 9 0 6" />',
  ],
  link: [
    '<path d="M10 14 20 4" />',
    '<path d="M14 4h6v6" />',
    '<path d="M20 14v4a2 2 0 0 1-2 2h-4" />',
    '<path d="M10 20H6a2 2 0 0 1-2-2v-4" />',
    '<path d="M4 10V6a2 2 0 0 1 2-2h4" />',
  ],
  plus: [
    '<path d="M12 5v14" />',
    '<path d="M5 12h14" />',
  ],
  trash: [
    '<path d="M4 7h16" />',
    '<path d="M10 11v6" />',
    '<path d="M14 11v6" />',
    '<path d="M7 7l1 12h8l1-12" />',
    '<path d="M9 7V5h6v2" />',
  ],
  eye: [
    '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />',
    '<circle cx="12" cy="12" r="3" />',
  ],
  eyeOff: [
    '<path d="M3 3 21 21" />',
    '<path d="M9.7 9.7A3.2 3.2 0 0 0 12 15.2a3.2 3.2 0 0 0 2.3-.95" />',
    '<path d="M6.1 6.1C4 7.6 2.5 10 2.5 12c0 0 3.5 6 9.5 6 2 0 3.8-.6 5.3-1.5" />',
    '<path d="M14.8 5.1A10.4 10.4 0 0 1 21.5 12s-.9 1.5-2.6 3" />',
  ],
  copy: [
    '<rect x="9" y="9" width="11" height="11" rx="2" />',
    '<path d="M5 15V6a2 2 0 0 1 2-2h9" />',
  ],
  settings: [
    '<path d="M12 3.5v3" />',
    '<path d="M12 17.5v3" />',
    '<path d="m4.8 7 2.1 2.1" />',
    '<path d="m17.1 14.9 2.1 2.1" />',
    '<path d="M3.5 12h3" />',
    '<path d="M17.5 12h3" />',
    '<path d="m4.8 17 2.1-2.1" />',
    '<path d="m17.1 9.1 2.1-2.1" />',
    '<circle cx="12" cy="12" r="4" />',
  ],
  logout: [
    '<path d="M9 7.5V6a3 3 0 1 1 6 0v1.5" />',
    '<rect x="5" y="7.5" width="14" height="11.5" rx="2" />',
    '<path d="M12 11.5v3" />',
  ],
  check: ['<path d="m5 12 4 4 10-10" />'],
  x: [
    '<path d="m6 6 12 12" />',
    '<path d="m18 6-12 12" />',
  ],
  chevronRight: ['<path d="m9 6 6 6-6 6" />'],
  search: [
    '<circle cx="11" cy="11" r="6.5" />',
    '<path d="m16 16 4 4" />',
  ],
  creditCard: [
    '<rect x="3.5" y="6" width="17" height="12" rx="2.2" />',
    '<path d="M3.5 10h17" />',
    '<path d="M8 14h3" />',
  ],
  home: [
    '<path d="m4.5 11.5 7.5-6 7.5 6" />',
    '<path d="M7.5 10.5v8h9v-8" />',
  ],
};

function getPopupIcon(name, className = 'icon') {
  const paths = ICONS[name];
  if (!paths) return '';
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths.join('')}</svg>`;
}

window.getPopupIcon = getPopupIcon;

function setButtonLoading(button, loading, loadingLabel = 'Loading...') {
  if (!button) return;

  if (loading) {
    const labelEl = button.querySelector('.btn-label');
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = labelEl ? labelEl.textContent : button.textContent.trim();
    }

    if (labelEl) {
      labelEl.textContent = loadingLabel;
    } else {
      button.textContent = loadingLabel;
    }

    button.disabled = true;
    button.classList.add('is-loading');
    return;
  }

  const labelEl = button.querySelector('.btn-label');
  const original = button.dataset.originalLabel;
  if (original) {
    if (labelEl) {
      labelEl.textContent = original;
    } else {
      button.textContent = original;
    }
  }

  button.disabled = false;
  button.classList.remove('is-loading');
}

window.setButtonLoading = setButtonLoading;

function animatePopupScreen(target, direction = 'forward') {
  const el = typeof target === 'string' ? document.getElementById(target) : target;
  if (!el) return;

  el.classList.remove('screen-enter-forward', 'screen-enter-back');
  // restart CSS animation
  void el.offsetWidth;
  el.classList.add(direction === 'back' ? 'screen-enter-back' : 'screen-enter-forward');
}

window.animatePopupScreen = animatePopupScreen;

let toastDismissTimer = null;
let toastRemoveTimer = null;
let sessionLossInProgress = false;

function isSessionLostError(err) {
  return err?.code === 'SESSION_LOST';
}

async function handleSessionLoss(err) {
  if (sessionLossInProgress) return;
  sessionLossInProgress = true;

  try {
    await sendMessage('LOGOUT');
  } catch {
    // Local lock is still handled in the service worker error path.
  }

  const lockBtn = document.getElementById('lock-btn');
  if (lockBtn) lockBtn.classList.add('hidden');
  hideAllScreens();
  LoginScreen.show();
  showToast(err?.message || 'Verbindung verloren. Bitte erneut anmelden.', 'error');
  sessionLossInProgress = false;
}

// Utility: HTML escape
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Utility: Toast notification
function showToast(message, variant = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) {
    existing.remove();
  }

  if (toastDismissTimer) clearTimeout(toastDismissTimer);
  if (toastRemoveTimer) clearTimeout(toastRemoveTimer);

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.variant = variant;
  toast.innerHTML = `
    <div class="toast-inner">
      <span class="toast-icon">${getPopupIcon(variant === 'error' ? 'x' : 'check', 'icon-sm')}</span>
      <span class="toast-message">${escapeHtml(message)}</span>
    </div>
  `;

  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('toast-show');
  });

  toastDismissTimer = setTimeout(() => {
    toast.classList.add('toast-hide');
    toastRemoveTimer = setTimeout(() => {
      toast.remove();
    }, 260);
  }, 2500);
}

function truncateText(value, maxLength = 42) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function showConfirmDialog({
  title = 'Confirm',
  message = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  destructive = false,
  confirmIcon = 'check',
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-title">${escapeHtml(title)}</div>
        <p class="confirm-message">${escapeHtml(message)}</p>
        <div class="confirm-actions">
          <button type="button" class="btn btn-secondary confirm-cancel">
            <span class="btn-content">${getPopupIcon('x', 'icon-sm')}<span class="btn-label">${escapeHtml(cancelText)}</span>
            </span>
          </button>
          <button type="button" class="btn ${destructive ? 'btn-danger' : 'btn-primary'} confirm-action">
            <span class="btn-content">${getPopupIcon(confirmIcon, 'icon-sm')}<span class="btn-label">${escapeHtml(confirmText)}</span>
            </span>
          </button>
        </div>
      </div>
    `;

    const close = (value) => {
      overlay.removeEventListener('keydown', onKeydown);
      overlay.remove();
      resolve(value);
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        close(false);
      }
    };

    const cancel = () => close(false);
    const confirm = () => close(true);

    overlay.querySelector('.confirm-cancel').addEventListener('click', cancel);
    overlay.querySelector('.confirm-action').addEventListener('click', confirm);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cancel();
    });

    overlay.addEventListener('keydown', onKeydown);
    document.body.appendChild(overlay);
    const cancelBtn = overlay.querySelector('.confirm-cancel');
    if (cancelBtn) {
      cancelBtn.focus();
    } else {
      overlay.focus();
    }
  });
}

window.showConfirmDialog = showConfirmDialog;
window.truncateText = truncateText;

const VaultSections = {
  activeTab: 'passwords',
  LOCAL_STORAGE_KEYS: {
    card: 'yurrr_cards',
    address: 'yurrr_addresses',
  },
  migrationComplete: {},
  migrationPromises: {},

  init() {
    this.listScreen = document.getElementById('list-screen');
    this.detailScreen = document.getElementById('detail-screen');
    this.formScreen = document.getElementById('form-screen');
    this.listEl = document.getElementById('entry-list');
    this.searchInput = document.getElementById('search-input');
    this.addBtn = document.getElementById('add-btn');

    this.passwordsBtn = document.getElementById('section-passwords');
    this.cardsBtn = document.getElementById('section-cards');
    this.addressesBtn = document.getElementById('section-addresses');

    this.passwordsBtn.addEventListener('click', () => this.setActiveTab('passwords'));
    this.cardsBtn.addEventListener('click', () => this.setActiveTab('cards'));
    this.addressesBtn.addEventListener('click', () => this.setActiveTab('addresses'));
  },

  isPasswordsTab() {
    return this.activeTab === 'passwords';
  },

  updateChipState() {
    const chips = [this.passwordsBtn, this.cardsBtn, this.addressesBtn];
    chips.forEach((chip) => chip.classList.remove('section-chip-active'));

    if (this.activeTab === 'passwords') this.passwordsBtn.classList.add('section-chip-active');
    if (this.activeTab === 'cards') this.cardsBtn.classList.add('section-chip-active');
    if (this.activeTab === 'addresses') this.addressesBtn.classList.add('section-chip-active');
  },

  async setActiveTab(tab) {
    this.activeTab = tab;
    this.updateChipState();

    this.listScreen.classList.remove('hidden');
    this.detailScreen.classList.add('hidden');
    this.formScreen.classList.add('hidden');
    animatePopupScreen(this.listScreen, 'back');

    if (tab === 'passwords') {
      this.searchInput.placeholder = 'Search passwords...';
      this.addBtn.title = 'Add password';
      this.addBtn.setAttribute('aria-label', 'Add password');
      await EntryList.show();
      return;
    }

    this.searchInput.value = '';
    this.addBtn.title = tab === 'cards' ? 'Add card' : 'Add address';
    this.addBtn.setAttribute('aria-label', this.addBtn.title);
    this.searchInput.placeholder = tab === 'cards' ? 'Search cards...' : 'Search addresses...';
    await this.renderCurrentTab();
  },

  handleAddFromList() {
    if (this.activeTab === 'passwords') return false;

    if (this.activeTab === 'cards') {
      this.addCard().catch((err) => {
        showToast(`Error: ${err.message}`, 'error');
      });
      return true;
    }

    if (this.activeTab === 'addresses') {
      this.addAddress().catch((err) => {
        showToast(`Error: ${err.message}`, 'error');
      });
      return true;
    }

    return false;
  },

  handleSearchInput() {
    if (this.activeTab === 'passwords') return false;
    this.renderCurrentTab().catch((err) => {
      showToast(`Error: ${err.message}`, 'error');
    });
    return true;
  },

  normalizePayloadObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  },

  stripEntityMetadata(value) {
    const source = this.normalizePayloadObject(value);
    const { id, item_type, created_at, updated_at, ...payload } = source;
    return payload;
  },

  toCardPayload(value) {
    const base = this.stripEntityMetadata(value);
    const number = this.normalizeCardNumber(base.number);
    const last4 = number ? number.slice(-4) : this.normalizeCardNumber(base.last4).slice(-4);
    const expMonth = Number.parseInt(base.exp_month, 10);
    const expYear = Number.parseInt(base.exp_year, 10);

    return {
      ...base,
      label: String(base.label || '').trim(),
      cardholder_name: String(base.cardholder_name || '').trim(),
      number,
      last4,
      brand: String(base.brand || (number ? this.detectCardBrand(number) : 'unknown')).trim() || 'unknown',
      exp_month: Number.isFinite(expMonth) ? expMonth : base.exp_month || '',
      exp_year: Number.isFinite(expYear) ? expYear : base.exp_year || '',
    };
  },

  toAddressPayload(value) {
    const base = this.stripEntityMetadata(value);
    return {
      ...base,
      label: String(base.label || '').trim(),
      full_name: String(base.full_name || '').trim(),
      line1: String(base.line1 || '').trim(),
      line2: String(base.line2 || '').trim(),
      city: String(base.city || '').trim(),
      postal_code: String(base.postal_code || '').trim(),
      country: String(base.country || '').trim(),
    };
  },

  toVaultPayload(itemType, value) {
    return itemType === 'card' ? this.toCardPayload(value) : this.toAddressPayload(value);
  },

  mapVaultItem(item, itemType) {
    const payload = this.toVaultPayload(itemType, item?.payload);
    return {
      ...payload,
      id: item?.id,
      item_type: item?.item_type || itemType,
      created_at: item?.created_at,
      updated_at: item?.updated_at,
    };
  },

  stableStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }

    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`)
        .join(',')}}`;
    }

    return JSON.stringify(value);
  },

  payloadSignature(itemType, payload) {
    return this.stableStringify(this.toVaultPayload(itemType, payload));
  },

  async fetchVaultItems(itemType) {
    const response = await sendMessage('LIST_VAULT_ITEMS', { itemType });
    if (Array.isArray(response)) return response;
    if (Array.isArray(response?.items)) return response.items;
    return [];
  },

  async migrateLocalItems(itemType) {
    if (this.migrationComplete[itemType]) return;
    if (this.migrationPromises[itemType]) {
      await this.migrationPromises[itemType];
      return;
    }

    this.migrationPromises[itemType] = (async () => {
      const storageKey = this.LOCAL_STORAGE_KEYS[itemType];
      if (!storageKey) return;

      const result = await chrome.storage.local.get(storageKey);
      const localItems = Array.isArray(result[storageKey]) ? result[storageKey] : [];
      if (!localItems.length) {
        this.migrationComplete[itemType] = true;
        return;
      }

      const existingItems = await this.fetchVaultItems(itemType);
      const existingSignatures = new Set(
        existingItems.map((item) => this.payloadSignature(itemType, item?.payload))
      );

      let migratedCount = 0;
      for (const localItem of localItems) {
        const payload = this.toVaultPayload(itemType, localItem);
        const signature = this.payloadSignature(itemType, payload);
        if (existingSignatures.has(signature)) continue;

        await sendMessage('CREATE_VAULT_ITEM', { itemType, payload });
        existingSignatures.add(signature);
        migratedCount += 1;
      }

      await chrome.storage.local.remove(storageKey);
      this.migrationComplete[itemType] = true;

      if (migratedCount > 0) {
        const label = itemType === 'card'
          ? (migratedCount === 1 ? 'card' : 'cards')
          : (migratedCount === 1 ? 'address' : 'addresses');
        showToast(`Migrated ${migratedCount} ${label} to vault`);
      }
    })();

    try {
      await this.migrationPromises[itemType];
    } finally {
      delete this.migrationPromises[itemType];
    }
  },

  async listVaultEntities(itemType) {
    try {
      await this.migrateLocalItems(itemType);
    } catch (err) {
      showToast(`Local migration failed: ${err.message}`, 'error');
    }

    const items = await this.fetchVaultItems(itemType);
    return items.map((item) => this.mapVaultItem(item, itemType));
  },

  async getVaultEntity(itemType, id) {
    const items = await this.listVaultEntities(itemType);
    return items.find((item) => String(item.id) === String(id)) || null;
  },

  async createVaultEntity(itemType, payload) {
    return await sendMessage('CREATE_VAULT_ITEM', { itemType, payload });
  },

  async updateVaultEntity(id, payload) {
    return await sendMessage('UPDATE_VAULT_ITEM', { id, payload });
  },

  async deleteVaultEntity(id) {
    return await sendMessage('DELETE_VAULT_ITEM', { id });
  },

  renderLoadError(label, err) {
    this.listEl.innerHTML = `<div class="empty-state">Could not load ${escapeHtml(label)}</div>`;
    showToast(`Error: ${err.message}`, 'error');
  },

  normalizeCardNumber(value) {
    return String(value || '').replace(/\D+/g, '');
  },

  luhnValid(number) {
    if (!/^\d{12,19}$/.test(number)) return false;
    let sum = 0;
    let shouldDouble = false;

    for (let i = number.length - 1; i >= 0; i--) {
      let digit = Number.parseInt(number[i], 10);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }

    return sum % 10 === 0;
  },

  detectCardBrand(number) {
    if (/^4\d{12}(\d{3})?(\d{3})?$/.test(number)) return 'visa';

    const firstTwo = Number.parseInt(number.slice(0, 2), 10);
    const firstFour = Number.parseInt(number.slice(0, 4), 10);
    const firstSix = Number.parseInt(number.slice(0, 6), 10);

    if ((firstTwo >= 51 && firstTwo <= 55) || (firstFour >= 2221 && firstFour <= 2720)) {
      return 'mastercard';
    }

    if (firstTwo === 34 || firstTwo === 37) return 'amex';

    if (
      /^6011/.test(number) ||
      /^65/.test(number) ||
      (firstSix >= 622126 && firstSix <= 622925) ||
      firstThreeInRange(number, 644, 649)
    ) {
      return 'discover';
    }

    if (firstFour >= 3528 && firstFour <= 3589) return 'jcb';
    if (/^3(0[0-5]|[68])/.test(number)) return 'diners';

    return 'unknown';

    function firstThreeInRange(num, min, max) {
      const firstThree = Number.parseInt(num.slice(0, 3), 10);
      return firstThree >= min && firstThree <= max;
    }
  },

  formatBrand(brand) {
    const map = {
      visa: 'Visa',
      mastercard: 'Mastercard',
      amex: 'Amex',
      discover: 'Discover',
      jcb: 'JCB',
      diners: 'Diners',
      unknown: 'Card',
    };
    return map[brand] || 'Card';
  },

  formatCardNumberMasked(number) {
    const last4 = number.slice(-4);
    return `•••• ${last4}`;
  },

  async renderCurrentTab() {
    if (this.activeTab === 'cards') {
      await this.renderCards();
      return;
    }
    if (this.activeTab === 'addresses') {
      await this.renderAddresses();
    }
  },

  async renderCards() {
    let cards;
    try {
      cards = await this.listVaultEntities('card');
    } catch (err) {
      this.renderLoadError('cards', err);
      return;
    }

    const query = this.searchInput.value.trim().toLowerCase();
    const filtered = !query
      ? cards
      : cards.filter((card) => {
          const text = `${card.label || ''} ${card.brand || ''} ${card.last4 || ''} ${card.cardholder_name || ''}`.toLowerCase();
          return text.includes(query);
        });

    if (!filtered.length) {
      this.listEl.innerHTML = '<div class="empty-state">No cards saved yet</div>';
      return;
    }

    this.listEl.innerHTML = filtered
      .map(
        (card) => `
      <div class="entry-item" data-card-id="${escapeHtml(card.id)}">
        <div class="entry-icon">${getPopupIcon('creditCard', 'icon-sm')}</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(this.formatBrand(card.brand))} ${escapeHtml(this.formatCardNumberMasked(card.number || card.last4 || ''))}</div>
          <div class="entry-username">${escapeHtml(card.cardholder_name || 'No cardholder')} • exp ${escapeHtml(String(card.exp_month).padStart(2, '0'))}/${escapeHtml(String(card.exp_year || ''))}</div>
        </div>
        <button class="mini-icon-btn danger" data-card-delete="${escapeHtml(card.id)}" title="Delete" type="button">${getPopupIcon('trash', 'icon-sm')}</button>
        <span class="entry-chevron">${getPopupIcon('chevronRight', 'icon-xs')}</span>
      </div>
    `
      )
      .join('');

    this.listEl.querySelectorAll('[data-card-id]').forEach((el) => {
      el.addEventListener('click', async (event) => {
        const deleteBtn = event.target.closest('[data-card-delete]');
        if (deleteBtn) return;
        try {
          await this.editCard(el.dataset.cardId);
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    });

    this.listEl.querySelectorAll('[data-card-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await this.deleteCard(btn.dataset.cardDelete);
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    });
  },

  async renderAddresses() {
    let addresses;
    try {
      addresses = await this.listVaultEntities('address');
    } catch (err) {
      this.renderLoadError('addresses', err);
      return;
    }

    const query = this.searchInput.value.trim().toLowerCase();
    const filtered = !query
      ? addresses
      : addresses.filter((address) => {
          const text = `${address.label || ''} ${address.full_name || ''} ${address.line1 || ''} ${address.city || ''} ${address.country || ''}`.toLowerCase();
          return text.includes(query);
        });

    if (!filtered.length) {
      this.listEl.innerHTML = '<div class="empty-state">No addresses saved yet</div>';
      return;
    }

    this.listEl.innerHTML = filtered
      .map(
        (address) => `
      <div class="entry-item" data-address-id="${escapeHtml(address.id)}">
        <div class="entry-icon">${getPopupIcon('home', 'icon-sm')}</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(address.label || address.full_name || 'Address')}</div>
          <div class="entry-username">${escapeHtml(address.line1 || '')}, ${escapeHtml(address.city || '')} ${escapeHtml(address.postal_code || '')}</div>
        </div>
        <button class="mini-icon-btn danger" data-address-delete="${escapeHtml(address.id)}" title="Delete" type="button">${getPopupIcon('trash', 'icon-sm')}</button>
        <span class="entry-chevron">${getPopupIcon('chevronRight', 'icon-xs')}</span>
      </div>
    `
      )
      .join('');

    this.listEl.querySelectorAll('[data-address-id]').forEach((el) => {
      el.addEventListener('click', async (event) => {
        const deleteBtn = event.target.closest('[data-address-delete]');
        if (deleteBtn) return;
        try {
          await this.editAddress(el.dataset.addressId);
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    });

    this.listEl.querySelectorAll('[data-address-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await this.deleteAddress(btn.dataset.addressDelete);
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    });
  },

  async addCard() {
    const formData = await this.showEntityForm({
      title: 'Add Card',
      submitLabel: 'Save Card',
      fields: [
        { name: 'label', label: 'Label', placeholder: 'Private / Work' },
        { name: 'cardholder_name', label: 'Cardholder Name', required: true },
        { name: 'number', label: 'Card Number', required: true, placeholder: '4111 1111 1111 1111' },
        { name: 'exp_month', label: 'Exp Month', type: 'number', required: true, min: 1, max: 12 },
        { name: 'exp_year', label: 'Exp Year', type: 'number', required: true, min: 2024, max: 2100 },
      ],
      helper: 'Card brand is detected automatically (Visa, Mastercard, Amex, ...).',
    });

    if (!formData) return;

    const number = this.normalizeCardNumber(formData.number);
    if (!this.luhnValid(number)) {
      showToast('Invalid card number', 'error');
      return;
    }

    const brand = this.detectCardBrand(number);
    const payload = this.toCardPayload({
      label: String(formData.label || '').trim(),
      cardholder_name: String(formData.cardholder_name || '').trim(),
      number,
      last4: number.slice(-4),
      brand,
      exp_month: Number.parseInt(formData.exp_month, 10),
      exp_year: Number.parseInt(formData.exp_year, 10),
    });

    await this.createVaultEntity('card', payload);
    await this.renderCards();
    showToast('Card saved');
  },

  async editCard(cardId) {
    const existing = await this.getVaultEntity('card', cardId);
    if (!existing) return;

    const formData = await this.showEntityForm({
      title: 'Edit Card',
      submitLabel: 'Update Card',
      fields: [
        { name: 'label', label: 'Label', value: existing.label || '' },
        { name: 'cardholder_name', label: 'Cardholder Name', required: true, value: existing.cardholder_name || '' },
        { name: 'number', label: 'Card Number', required: true, value: existing.number || '' },
        { name: 'exp_month', label: 'Exp Month', type: 'number', required: true, min: 1, max: 12, value: existing.exp_month },
        { name: 'exp_year', label: 'Exp Year', type: 'number', required: true, min: 2024, max: 2100, value: existing.exp_year },
      ],
      helper: 'Card brand is detected automatically (Visa, Mastercard, Amex, ...).',
    });

    if (!formData) return;

    const number = this.normalizeCardNumber(formData.number);
    if (!this.luhnValid(number)) {
      showToast('Invalid card number', 'error');
      return;
    }

    const brand = this.detectCardBrand(number);
    const payload = this.toCardPayload({
      ...existing,
      label: String(formData.label || '').trim(),
      cardholder_name: String(formData.cardholder_name || '').trim(),
      number,
      last4: number.slice(-4),
      brand,
      exp_month: Number.parseInt(formData.exp_month, 10),
      exp_year: Number.parseInt(formData.exp_year, 10),
    });

    await this.updateVaultEntity(cardId, payload);
    await this.renderCards();
    showToast('Card updated');
  },

  async deleteCard(cardId) {
    const existing = await this.getVaultEntity('card', cardId);
    if (!existing) return;

    const cardLabel = existing.label || this.formatBrand(existing.brand) || 'Card';
    const shouldDelete = await showConfirmDialog({
      title: 'Delete Card',
      message: `Delete "${truncateText(cardLabel)}" and its payment details? This cannot be undone.`,
      confirmText: 'Delete Card',
      cancelText: 'Cancel',
      confirmIcon: 'trash',
      destructive: true,
    });

    if (!shouldDelete) return;

    await this.deleteVaultEntity(cardId);
    await this.renderCards();
    showToast(`Deleted ${truncateText(cardLabel)}`);
  },

  async addAddress() {
    const formData = await this.showEntityForm({
      title: 'Add Address',
      submitLabel: 'Save Address',
      fields: [
        { name: 'label', label: 'Label', placeholder: 'Home / Office' },
        { name: 'full_name', label: 'Full Name', required: true },
        { name: 'line1', label: 'Address Line 1', required: true },
        { name: 'line2', label: 'Address Line 2' },
        { name: 'city', label: 'City', required: true },
        { name: 'postal_code', label: 'Postal Code', required: true },
        { name: 'country', label: 'Country', required: true, placeholder: 'Switzerland' },
      ],
    });

    if (!formData) return;

    const payload = this.toAddressPayload({
      label: String(formData.label || '').trim(),
      full_name: String(formData.full_name || '').trim(),
      line1: String(formData.line1 || '').trim(),
      line2: String(formData.line2 || '').trim(),
      city: String(formData.city || '').trim(),
      postal_code: String(formData.postal_code || '').trim(),
      country: String(formData.country || '').trim(),
    });

    await this.createVaultEntity('address', payload);
    await this.renderAddresses();
    showToast('Address saved');
  },

  async editAddress(addressId) {
    const existing = await this.getVaultEntity('address', addressId);
    if (!existing) return;

    const formData = await this.showEntityForm({
      title: 'Edit Address',
      submitLabel: 'Update Address',
      fields: [
        { name: 'label', label: 'Label', value: existing.label || '' },
        { name: 'full_name', label: 'Full Name', required: true, value: existing.full_name || '' },
        { name: 'line1', label: 'Address Line 1', required: true, value: existing.line1 || '' },
        { name: 'line2', label: 'Address Line 2', value: existing.line2 || '' },
        { name: 'city', label: 'City', required: true, value: existing.city || '' },
        { name: 'postal_code', label: 'Postal Code', required: true, value: existing.postal_code || '' },
        { name: 'country', label: 'Country', required: true, value: existing.country || '' },
      ],
    });

    if (!formData) return;

    const payload = this.toAddressPayload({
      ...existing,
      label: String(formData.label || '').trim(),
      full_name: String(formData.full_name || '').trim(),
      line1: String(formData.line1 || '').trim(),
      line2: String(formData.line2 || '').trim(),
      city: String(formData.city || '').trim(),
      postal_code: String(formData.postal_code || '').trim(),
      country: String(formData.country || '').trim(),
    });

    await this.updateVaultEntity(addressId, payload);
    await this.renderAddresses();
    showToast('Address updated');
  },

  async deleteAddress(addressId) {
    const existing = await this.getVaultEntity('address', addressId);
    if (!existing) return;

    const addressLabel = existing.label || existing.full_name || 'Address';
    const shouldDelete = await showConfirmDialog({
      title: 'Delete Address',
      message: `Delete "${truncateText(addressLabel)}"? This action cannot be undone.`,
      confirmText: 'Delete Address',
      cancelText: 'Cancel',
      confirmIcon: 'trash',
      destructive: true,
    });

    if (!shouldDelete) return;

    await this.deleteVaultEntity(addressId);
    await this.renderAddresses();
    showToast(`Deleted ${truncateText(addressLabel)}`);
  },

  async showEntityForm({ title, fields, submitLabel = 'Save', helper = '' }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'entity-modal-overlay';

      const formBody = fields
        .map((field) => {
          const type = field.type || 'text';
          const value = field.value == null ? '' : String(field.value);
          const min = field.min != null ? ` min="${field.min}"` : '';
          const max = field.max != null ? ` max="${field.max}"` : '';
          const required = field.required ? ' required' : '';
          const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';

          return `
            <label class="entity-modal-label">${escapeHtml(field.label)}</label>
            <input class="entity-modal-input" name="${escapeHtml(field.name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}"${placeholder}${required}${min}${max}>
          `;
        })
        .join('');

      overlay.innerHTML = `
        <div class="entity-modal-card">
          <div class="entity-modal-title">${escapeHtml(title)}</div>
          ${helper ? `<div class="entity-modal-helper">${escapeHtml(helper)}</div>` : ''}
          <form id="entity-modal-form">
            ${formBody}
            <div class="entity-modal-actions">
              <button type="button" class="btn btn-secondary" id="entity-cancel">
                <span class="btn-content">${getPopupIcon('x', 'icon-sm')}<span class="btn-label">Cancel</span></span>
              </button>
              <button type="submit" class="btn btn-primary">
                <span class="btn-content">${getPopupIcon('check', 'icon-sm')}<span class="btn-label">${escapeHtml(submitLabel)}</span></span>
              </button>
            </div>
          </form>
        </div>
      `;

      document.body.appendChild(overlay);

      const close = (result = null) => {
        overlay.remove();
        resolve(result);
      };

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close(null);
      });

      overlay.querySelector('#entity-cancel').addEventListener('click', () => close(null));

      const formEl = overlay.querySelector('#entity-modal-form');
      formEl.addEventListener('submit', (event) => {
        event.preventDefault();

        const data = {};
        for (const field of fields) {
          const input = formEl.querySelector(`[name="${CSS.escape(field.name)}"]`);
          if (!input) continue;
          const raw = String(input.value || '').trim();
          if (field.required && !raw) {
            input.focus();
            return;
          }
          data[field.name] = raw;
        }

        close(data);
      });

      const firstInput = formEl.querySelector('input');
      if (firstInput) firstInput.focus();
    });
  },
};

window.VaultSections = VaultSections;

// Initialize all components
LoginScreen.init();
EntryList.init();
EntryDetail.init();
EntryForm.init();
VaultSections.init();

// Settings button
document.getElementById('settings-btn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// Lock button
document.getElementById('lock-btn').addEventListener('click', async () => {
  try {
    await sendMessage('LOGOUT');
  } catch {
    // local lock fallback still happens below
  }
  document.getElementById('lock-btn').classList.add('hidden');
  hideAllScreens();
  LoginScreen.show();
});

function hideAllScreens() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('list-screen').classList.add('hidden');
  document.getElementById('detail-screen').classList.add('hidden');
  document.getElementById('form-screen').classList.add('hidden');
}

// Utility: get server URL for cert warmup
async function getServerUrl() {
  const result = await chrome.storage.local.get('yurrr_server_url');
  return result.yurrr_server_url || 'https://localhost:8443';
}

// Startup: check if unlocked
(async () => {
  try {
    const result = await sendMessage('IS_UNLOCKED');
    if (result.unlocked) {
      // Verify server is reachable (also warms up self-signed cert)
      const serverUrl = await getServerUrl();
      try {
        await fetch(`${serverUrl}/api/v1/auth/status`);
      } catch {
        // Server unreachable — auto-lock and show login
        await sendMessage('LOGOUT');
        LoginScreen.show();
        return;
      }

      hideAllScreens();
      document.getElementById('lock-btn').classList.remove('hidden');
      await VaultSections.setActiveTab('passwords');
    } else {
      LoginScreen.show();
    }
  } catch {
    LoginScreen.show();
  }
})();
