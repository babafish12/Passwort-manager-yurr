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

const VaultSections = {
  activeTab: 'passwords',
  STORAGE_KEY_CARDS: 'yurrr_cards',
  STORAGE_KEY_ADDRESSES: 'yurrr_addresses',

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
    this.renderCurrentTab();
    return true;
  },

  createId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  },

  async storageGet(key) {
    const result = await chrome.storage.local.get(key);
    return Array.isArray(result[key]) ? result[key] : [];
  },

  async storageSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
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
    const cards = await this.storageGet(this.STORAGE_KEY_CARDS);
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
          <div class="entry-domain">${escapeHtml(this.formatBrand(card.brand))} ${escapeHtml(this.formatCardNumberMasked(card.number || ''))}</div>
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
        await this.editCard(el.dataset.cardId);
      });
    });

    this.listEl.querySelectorAll('[data-card-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.deleteCard(btn.dataset.cardDelete);
      });
    });
  },

  async renderAddresses() {
    const addresses = await this.storageGet(this.STORAGE_KEY_ADDRESSES);
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
        await this.editAddress(el.dataset.addressId);
      });
    });

    this.listEl.querySelectorAll('[data-address-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.deleteAddress(btn.dataset.addressDelete);
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
    const cards = await this.storageGet(this.STORAGE_KEY_CARDS);
    cards.unshift({
      id: this.createId(),
      label: String(formData.label || '').trim(),
      cardholder_name: String(formData.cardholder_name || '').trim(),
      number,
      last4: number.slice(-4),
      brand,
      exp_month: Number.parseInt(formData.exp_month, 10),
      exp_year: Number.parseInt(formData.exp_year, 10),
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    await this.storageSet(this.STORAGE_KEY_CARDS, cards);
    await this.renderCards();
    showToast('Card saved');
  },

  async editCard(cardId) {
    const cards = await this.storageGet(this.STORAGE_KEY_CARDS);
    const existing = cards.find((item) => item.id === cardId);
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
    const idx = cards.findIndex((item) => item.id === cardId);
    cards[idx] = {
      ...cards[idx],
      label: String(formData.label || '').trim(),
      cardholder_name: String(formData.cardholder_name || '').trim(),
      number,
      last4: number.slice(-4),
      brand,
      exp_month: Number.parseInt(formData.exp_month, 10),
      exp_year: Number.parseInt(formData.exp_year, 10),
      updated_at: Date.now(),
    };

    await this.storageSet(this.STORAGE_KEY_CARDS, cards);
    await this.renderCards();
    showToast('Card updated');
  },

  async deleteCard(cardId) {
    if (!confirm('Delete this card?')) return;
    const cards = await this.storageGet(this.STORAGE_KEY_CARDS);
    const updated = cards.filter((item) => item.id !== cardId);
    await this.storageSet(this.STORAGE_KEY_CARDS, updated);
    await this.renderCards();
    showToast('Card deleted');
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

    const addresses = await this.storageGet(this.STORAGE_KEY_ADDRESSES);
    addresses.unshift({
      id: this.createId(),
      label: String(formData.label || '').trim(),
      full_name: String(formData.full_name || '').trim(),
      line1: String(formData.line1 || '').trim(),
      line2: String(formData.line2 || '').trim(),
      city: String(formData.city || '').trim(),
      postal_code: String(formData.postal_code || '').trim(),
      country: String(formData.country || '').trim(),
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    await this.storageSet(this.STORAGE_KEY_ADDRESSES, addresses);
    await this.renderAddresses();
    showToast('Address saved');
  },

  async editAddress(addressId) {
    const addresses = await this.storageGet(this.STORAGE_KEY_ADDRESSES);
    const existing = addresses.find((item) => item.id === addressId);
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

    const idx = addresses.findIndex((item) => item.id === addressId);
    addresses[idx] = {
      ...addresses[idx],
      label: String(formData.label || '').trim(),
      full_name: String(formData.full_name || '').trim(),
      line1: String(formData.line1 || '').trim(),
      line2: String(formData.line2 || '').trim(),
      city: String(formData.city || '').trim(),
      postal_code: String(formData.postal_code || '').trim(),
      country: String(formData.country || '').trim(),
      updated_at: Date.now(),
    };

    await this.storageSet(this.STORAGE_KEY_ADDRESSES, addresses);
    await this.renderAddresses();
    showToast('Address updated');
  },

  async deleteAddress(addressId) {
    if (!confirm('Delete this address?')) return;
    const addresses = await this.storageGet(this.STORAGE_KEY_ADDRESSES);
    const updated = addresses.filter((item) => item.id !== addressId);
    await this.storageSet(this.STORAGE_KEY_ADDRESSES, updated);
    await this.renderAddresses();
    showToast('Address deleted');
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
