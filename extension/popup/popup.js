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
  showToast(err?.message || 'Verbindung verloren. Bitte erneut anmelden.');
  sessionLossInProgress = false;
}

// Utility: HTML escape
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Utility: Toast notification
function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
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

    if (tab === 'passwords') {
      this.searchInput.placeholder = 'Search passwords...';
      this.addBtn.title = 'Add password';
      await EntryList.show();
      return;
    }

    this.searchInput.value = '';
    this.addBtn.title = tab === 'cards' ? 'Add card' : 'Add address';
    this.searchInput.placeholder = tab === 'cards' ? 'Search cards...' : 'Search addresses...';
    await this.renderCurrentTab();
  },

  handleAddFromList() {
    if (this.activeTab === 'passwords') return false;

    if (this.activeTab === 'cards') {
      this.addCard().catch((err) => {
        showToast(`Error: ${err.message}`);
      });
      return true;
    }

    if (this.activeTab === 'addresses') {
      this.addAddress().catch((err) => {
        showToast(`Error: ${err.message}`);
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
      (firstThreeInRange(number, 644, 649))
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
        <div class="entry-icon">💳</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(this.formatBrand(card.brand))} ${escapeHtml(this.formatCardNumberMasked(card.number || ''))}</div>
          <div class="entry-username">${escapeHtml(card.cardholder_name || 'No cardholder')} • exp ${escapeHtml(String(card.exp_month).padStart(2, '0'))}/${escapeHtml(String(card.exp_year || ''))}</div>
        </div>
        <button class="mini-icon-btn" data-card-delete="${escapeHtml(card.id)}" title="Delete">🗑</button>
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
        <div class="entry-icon">🏠</div>
        <div class="entry-info">
          <div class="entry-domain">${escapeHtml(address.label || address.full_name || 'Address')}</div>
          <div class="entry-username">${escapeHtml(address.line1 || '')}, ${escapeHtml(address.city || '')} ${escapeHtml(address.postal_code || '')}</div>
        </div>
        <button class="mini-icon-btn" data-address-delete="${escapeHtml(address.id)}" title="Delete">🗑</button>
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
      showToast('Invalid card number');
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
      showToast('Invalid card number');
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
              <button type="button" class="btn btn-secondary" id="entity-cancel">Cancel</button>
              <button type="submit" class="btn btn-primary">${escapeHtml(submitLabel)}</button>
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

// Lock button
document.getElementById('lock-btn').addEventListener('click', async () => {
  await sendMessage('LOGOUT');
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
  return result['yurrr_server_url'] || 'https://localhost:8443';
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
