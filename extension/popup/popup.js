const STORAGE_KEY_ENABLE_FAVICONS = 'yurrr_enable_favicons';
let faviconsEnabledCache = null;

async function areFaviconsEnabled() {
  if (faviconsEnabledCache !== null) return faviconsEnabledCache;

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_ENABLE_FAVICONS);
    faviconsEnabledCache = result[STORAGE_KEY_ENABLE_FAVICONS] !== false;
  } catch {
    faviconsEnabledCache = false;
  }

  return faviconsEnabledCache;
}

window.areFaviconsEnabled = areFaviconsEnabled;

// Utility: Send message to service worker
async function sendMessage(type, payload = {}) {
  if (type === 'GET_FAVICON' && !(await areFaviconsEnabled())) {
    return { dataUrl: null };
  }

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
  fingerprint: [
    '<path d="M6.4 11.5a5.6 5.6 0 0 1 11.2 0" />',
    '<path d="M8.6 14.5c.2-3.3 1.4-5 3.4-5s3.2 1.7 3.4 5" />',
    '<path d="M12 13.2c0 2.7-.8 5-2.5 6.8" />',
    '<path d="M14.6 19.5c.8-1.6 1.2-3.6 1.2-6.1" />',
    '<path d="M4.8 15.8c.3-5.9 2.7-8.9 7.2-8.9 2 0 3.7.6 4.9 1.9" />',
    '<path d="M19.2 15.6c.2-2.2-.1-4-1-5.4" />',
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
let resumeUnlockedSessionInProgress = false;
let sessionInvalidToastShown = false;
let startupComplete = false;

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
  window.VaultSections?.invalidateEntityCache?.();
  hideAllScreens();
  LoginScreen.show();
  showToast(err?.message || 'Verbindung verloren. Bitte erneut anmelden.', 'error');
  sessionLossInProgress = false;
}

async function showUnlockedVault() {
  LoginScreen.hide();
  hideAllScreens();
  document.getElementById('lock-btn').classList.remove('hidden');
  await VaultSections.setActiveTab(VaultSections.activeTab || 'passwords');
}

async function tryResumeUnlockedSession({ showToast: shouldShowToast = true, allowHidden = false } = {}) {
  if (resumeUnlockedSessionInProgress) return false;
  if (!allowHidden && document.getElementById('login-screen')?.classList.contains('hidden')) return false;
  if (document.getElementById('master-password')?.value) return false;

  resumeUnlockedSessionInProgress = true;
  try {
    const result = await sendMessage('IS_UNLOCKED');
    if (result.unlocked && result.reachable !== false) {
      await showUnlockedVault();
      if (shouldShowToast && startupComplete) {
        showToast('Reconnected to server');
      }
      return true;
    }

    if (!result.unlocked && result.reason === 'session_invalid' && !sessionInvalidToastShown) {
      sessionInvalidToastShown = true;
      showToast('Session expired. Please log in again.', 'error');
    }
  } catch {
    // LoginScreen status polling keeps showing connection state.
  } finally {
    resumeUnlockedSessionInProgress = false;
  }

  return false;
}

window.tryResumeUnlockedSession = tryResumeUnlockedSession;

// Utility: HTML escape
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
  toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
  toast.setAttribute('aria-atomic', 'true');

  const inner = document.createElement('div');
  inner.className = 'toast-inner';
  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.innerHTML = getPopupIcon(variant === 'error' ? 'x' : 'check', 'icon-sm');
  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;
  inner.append(icon, text);
  toast.appendChild(inner);

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

function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  )).filter((el) => !el.disabled && !el.hasAttribute('hidden') && el.offsetParent !== null);
}

function trapDialogFocus(container, event) {
  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(container);
  if (!focusable.length) {
    event.preventDefault();
    container.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
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
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = `confirm-title-${Date.now()}`;
    const messageId = `confirm-message-${Date.now()}`;
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('tabindex', '-1');
    overlay.innerHTML = `
      <div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${messageId}">
        <div class="confirm-title" id="${titleId}">${escapeHtml(title)}</div>
        <p class="confirm-message" id="${messageId}">${escapeHtml(message)}</p>
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
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(value);
    };

    const onKeydown = (event) => {
      if (event.key === 'Escape') {
        close(false);
        return;
      }
      trapDialogFocus(overlay, event);
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

function hideBootScreen() {
  document.getElementById('boot-screen')?.classList.add('hidden');
  document.getElementById('app')?.setAttribute('data-boot-state', 'ready');
}

const VaultSections = {
  activeTab: 'passwords',
  LOCAL_STORAGE_KEYS: {
    card: 'yurrr_cards',
    address: 'yurrr_addresses',
    passkey: 'yurrr_passkeys',
  },
  migrationComplete: {},
  migrationPromises: {},
  entityCache: {},

  init() {
    this.listScreen = document.getElementById('list-screen');
    this.detailScreen = document.getElementById('detail-screen');
    this.formScreen = document.getElementById('form-screen');
    this.listEl = document.getElementById('entry-list');
    this.searchInput = document.getElementById('search-input');
    this.addBtn = document.getElementById('add-btn');

    this.passwordsBtn = document.getElementById('section-passwords');
    this.passkeysBtn = document.getElementById('section-passkeys');
    this.cardsBtn = document.getElementById('section-cards');
    this.addressesBtn = document.getElementById('section-addresses');
    this.sectionTabs = [
      { tab: 'passwords', button: this.passwordsBtn },
      { tab: 'passkeys', button: this.passkeysBtn },
      { tab: 'cards', button: this.cardsBtn },
      { tab: 'addresses', button: this.addressesBtn },
    ];

    this.passwordsBtn.addEventListener('click', () => this.setActiveTab('passwords'));
    this.passkeysBtn.addEventListener('click', () => this.setActiveTab('passkeys'));
    this.cardsBtn.addEventListener('click', () => this.setActiveTab('cards'));
    this.addressesBtn.addEventListener('click', () => this.setActiveTab('addresses'));
    this.sectionTabs.forEach(({ button }) => {
      button.addEventListener('keydown', (event) => this.handleTabKeydown(event));
    });
  },

  handleTabKeydown(event) {
    const keyMap = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    const currentIndex = this.sectionTabs.findIndex(({ button }) => button === event.currentTarget);
    let nextIndex = null;

    if (Object.prototype.hasOwnProperty.call(keyMap, event.key)) {
      nextIndex = (currentIndex + keyMap[event.key] + this.sectionTabs.length) % this.sectionTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = this.sectionTabs.length - 1;
    }

    if (nextIndex === null || currentIndex === -1) return;
    event.preventDefault();

    const target = this.sectionTabs[nextIndex];
    target.button.focus();
    this.setActiveTab(target.tab).catch((err) => {
      showToast(`Error: ${err.message}`, 'error');
    });
  },

  isPasswordsTab() {
    return this.activeTab === 'passwords';
  },

  updateChipState() {
    const chips = [this.passwordsBtn, this.passkeysBtn, this.cardsBtn, this.addressesBtn];
    chips.forEach((chip) => {
      chip.classList.remove('section-chip-active');
      chip.setAttribute('aria-selected', 'false');
      chip.setAttribute('tabindex', '-1');
    });

    if (this.activeTab === 'passwords') {
      this.passwordsBtn.classList.add('section-chip-active');
      this.passwordsBtn.setAttribute('aria-selected', 'true');
      this.passwordsBtn.setAttribute('tabindex', '0');
      this.listEl.setAttribute('aria-labelledby', 'section-passwords');
    }
    if (this.activeTab === 'passkeys') {
      this.passkeysBtn.classList.add('section-chip-active');
      this.passkeysBtn.setAttribute('aria-selected', 'true');
      this.passkeysBtn.setAttribute('tabindex', '0');
      this.listEl.setAttribute('aria-labelledby', 'section-passkeys');
    }
    if (this.activeTab === 'cards') {
      this.cardsBtn.classList.add('section-chip-active');
      this.cardsBtn.setAttribute('aria-selected', 'true');
      this.cardsBtn.setAttribute('tabindex', '0');
      this.listEl.setAttribute('aria-labelledby', 'section-cards');
    }
    if (this.activeTab === 'addresses') {
      this.addressesBtn.classList.add('section-chip-active');
      this.addressesBtn.setAttribute('aria-selected', 'true');
      this.addressesBtn.setAttribute('tabindex', '0');
      this.listEl.setAttribute('aria-labelledby', 'section-addresses');
    }
  },

  async setActiveTab(tab, options = {}) {
    this.activeTab = tab;
    this.updateChipState();

    this.detailScreen.classList.add('hidden');
    this.formScreen.classList.add('hidden');

    if (tab === 'passwords') {
      this.searchInput.placeholder = 'Search passwords...';
      this.addBtn.title = 'Add password';
      this.addBtn.setAttribute('aria-label', 'Add password');
      await EntryList.show({ initialEntries: options.passwordEntries || null });
      return;
    }

    this.listScreen.classList.remove('hidden');
    animatePopupScreen(this.listScreen, 'back');
    this.searchInput.value = '';
    this.addBtn.title = tab === 'cards' ? 'Add card' : tab === 'passkeys' ? 'Add passkey' : 'Add address';
    this.addBtn.setAttribute('aria-label', this.addBtn.title);
    this.searchInput.placeholder = tab === 'cards'
      ? 'Search cards...'
      : tab === 'passkeys'
        ? 'Search passkeys...'
        : 'Search addresses...';
    EntryList.renderLoadingState(`Loading ${tab}...`);
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

    if (this.activeTab === 'passkeys') {
      this.addPasskey().catch((err) => {
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

  toPasskeyPayload(value) {
    const base = this.stripEntityMetadata(value);
    const websiteUrl = String(base.website_url || '').trim();
    return {
      ...base,
      label: String(base.label || '').trim(),
      website_url: websiteUrl,
      rp_id: this.normalizeRpId(base.rp_id, websiteUrl),
      user_name: String(base.user_name || '').trim(),
      display_name: String(base.display_name || '').trim(),
      credential_id: String(base.credential_id || '').trim(),
      public_key: String(base.public_key || '').trim(),
      notes: String(base.notes || '').trim(),
    };
  },

  toVaultPayload(itemType, value) {
    if (itemType === 'card') return this.toCardPayload(value);
    if (itemType === 'passkey') return this.toPasskeyPayload(value);
    return this.toAddressPayload(value);
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
        const label = this.getItemTypeLabel(itemType, migratedCount);
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

    if (this.entityCache[itemType]) {
      return this.entityCache[itemType];
    }

    const items = await this.fetchVaultItems(itemType);
    const mapped = items.map((item) => this.mapVaultItem(item, itemType));
    this.entityCache[itemType] = mapped;
    return mapped;
  },

  invalidateEntityCache(itemType) {
    if (itemType) {
      delete this.entityCache[itemType];
      return;
    }

    this.entityCache = {};
  },

  async getVaultEntity(itemType, id) {
    const items = await this.listVaultEntities(itemType);
    return items.find((item) => String(item.id) === String(id)) || null;
  },

  async createVaultEntity(itemType, payload) {
    const result = await sendMessage('CREATE_VAULT_ITEM', { itemType, payload });
    this.invalidateEntityCache(itemType);
    return result;
  },

  async updateVaultEntity(id, payload) {
    const result = await sendMessage('UPDATE_VAULT_ITEM', { id, payload });
    this.invalidateEntityCache();
    return result;
  },

  async deleteVaultEntity(id) {
    const result = await sendMessage('DELETE_VAULT_ITEM', { id });
    this.invalidateEntityCache();
    return result;
  },

  renderLoadError(label, err) {
    this.listEl.innerHTML = `<div class="empty-state">Could not load ${escapeHtml(label)}</div>`;
    showToast(`Error: ${err.message}`, 'error');
  },

  isActivationKey(event) {
    return event.key === 'Enter' || event.key === ' ';
  },

  getItemTypeLabel(itemType, count = 2) {
    const singular = {
      card: 'card',
      address: 'address',
      passkey: 'passkey',
    }[itemType] || 'item';
    const plural = {
      card: 'cards',
      address: 'addresses',
      passkey: 'passkeys',
    }[itemType] || 'items';

    return count === 1 ? singular : plural;
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

  normalizeRpId(rpId, websiteUrl = '') {
    const explicit = String(rpId || '').trim().toLowerCase();
    if (explicit) return explicit;

    try {
      const parsed = new URL(websiteUrl);
      return parsed.hostname.toLowerCase();
    } catch {
      return '';
    }
  },

  formatPasskeyLabel(passkey) {
    return passkey.label || passkey.rp_id || 'Passkey';
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
    if (this.activeTab === 'passkeys') {
      await this.renderPasskeys();
      return;
    }
    if (this.activeTab === 'cards') {
      await this.renderCards();
      return;
    }
    if (this.activeTab === 'addresses') {
      await this.renderAddresses();
    }
  },

  async renderPasskeys() {
    let passkeys;
    try {
      passkeys = await this.listVaultEntities('passkey');
    } catch (err) {
      this.renderLoadError('passkeys', err);
      return;
    }

    const query = this.searchInput.value.trim().toLowerCase();
    const filtered = !query
      ? passkeys
      : passkeys.filter((passkey) => {
          const text = `${passkey.label || ''} ${passkey.rp_id || ''} ${passkey.website_url || ''} ${passkey.user_name || ''} ${passkey.display_name || ''}`.toLowerCase();
          return text.includes(query);
        });

    if (!filtered.length) {
      this.listEl.innerHTML = '<div class="empty-state">No passkeys saved yet</div>';
      return;
    }

    this.listEl.innerHTML = filtered
      .map(
        (passkey) => {
          const label = this.formatPasskeyLabel(passkey);
          return `
      <div class="entry-item">
        <button class="entry-main" data-passkey-id="${escapeHtml(passkey.id)}" type="button" aria-label="${escapeHtml(`Open passkey for ${label}`)}">
          <div class="entry-icon">${getPopupIcon('fingerprint', 'icon-sm')}</div>
          <div class="entry-info">
            <div class="entry-domain">${escapeHtml(label)}</div>
            <div class="entry-username">${escapeHtml(passkey.user_name || passkey.display_name || 'No account')} • ${escapeHtml(passkey.rp_id || 'No RP ID')}</div>
          </div>
          <span class="entry-chevron" aria-hidden="true">${getPopupIcon('chevronRight', 'icon-xs')}</span>
        </button>
        <button class="mini-icon-btn danger" data-passkey-delete="${escapeHtml(passkey.id)}" title="Delete" aria-label="${escapeHtml(`Delete passkey for ${label}`)}" type="button">${getPopupIcon('trash', 'icon-sm')}</button>
      </div>
    `;
        }
      )
      .join('');

    this.listEl.querySelectorAll('.entry-main[data-passkey-id]').forEach((el) => {
      el.addEventListener('click', async () => {
        try {
          await this.editPasskey(el.dataset.passkeyId);
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    });

    this.listEl.querySelectorAll('[data-passkey-delete]').forEach((btn) => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await this.deletePasskey(btn.dataset.passkeyDelete);
        } catch (err) {
          showToast(`Error: ${err.message}`, 'error');
        }
      });
    });
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
        (card) => {
          const cardLabel = `${this.formatBrand(card.brand)} ${this.formatCardNumberMasked(card.number || card.last4 || '')}`;
          return `
      <div class="entry-item">
        <button class="entry-main" data-card-id="${escapeHtml(card.id)}" type="button" aria-label="${escapeHtml(`Open card ${cardLabel}`)}">
          <div class="entry-icon">${getPopupIcon('creditCard', 'icon-sm')}</div>
          <div class="entry-info">
            <div class="entry-domain">${escapeHtml(cardLabel)}</div>
            <div class="entry-username">${escapeHtml(card.cardholder_name || 'No cardholder')} • exp ${escapeHtml(String(card.exp_month).padStart(2, '0'))}/${escapeHtml(String(card.exp_year || ''))}</div>
          </div>
          <span class="entry-chevron" aria-hidden="true">${getPopupIcon('chevronRight', 'icon-xs')}</span>
        </button>
        <button class="mini-icon-btn danger" data-card-delete="${escapeHtml(card.id)}" title="Delete" aria-label="${escapeHtml(`Delete card ${cardLabel}`)}" type="button">${getPopupIcon('trash', 'icon-sm')}</button>
      </div>
    `;
        }
      )
      .join('');

    this.listEl.querySelectorAll('.entry-main[data-card-id]').forEach((el) => {
      el.addEventListener('click', async () => {
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
        (address) => {
          const addressLabel = address.label || address.full_name || 'Address';
          return `
      <div class="entry-item">
        <button class="entry-main" data-address-id="${escapeHtml(address.id)}" type="button" aria-label="${escapeHtml(`Open address ${addressLabel}`)}">
          <div class="entry-icon">${getPopupIcon('home', 'icon-sm')}</div>
          <div class="entry-info">
            <div class="entry-domain">${escapeHtml(addressLabel)}</div>
            <div class="entry-username">${escapeHtml(address.line1 || '')}, ${escapeHtml(address.city || '')} ${escapeHtml(address.postal_code || '')}</div>
          </div>
          <span class="entry-chevron" aria-hidden="true">${getPopupIcon('chevronRight', 'icon-xs')}</span>
        </button>
        <button class="mini-icon-btn danger" data-address-delete="${escapeHtml(address.id)}" title="Delete" aria-label="${escapeHtml(`Delete address ${addressLabel}`)}" type="button">${getPopupIcon('trash', 'icon-sm')}</button>
      </div>
    `;
        }
      )
      .join('');

    this.listEl.querySelectorAll('.entry-main[data-address-id]').forEach((el) => {
      el.addEventListener('click', async () => {
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

  async addPasskey() {
    const formData = await this.showEntityForm({
      title: 'Add Passkey',
      submitLabel: 'Save Passkey',
      fields: [
        { name: 'label', label: 'Label', placeholder: 'GitHub personal' },
        { name: 'website_url', label: 'Website URL', placeholder: 'https://example.com' },
        { name: 'rp_id', label: 'Relying Party ID', required: true, placeholder: 'example.com' },
        { name: 'user_name', label: 'Account / Email', required: true },
        { name: 'display_name', label: 'Display Name' },
        { name: 'credential_id', label: 'Credential ID', required: true },
        { name: 'public_key', label: 'Public Key' },
        { name: 'notes', label: 'Notes' },
      ],
    });

    if (!formData) return;

    const payload = this.toPasskeyPayload(formData);
    if (!payload.rp_id || !payload.user_name || !payload.credential_id) {
      showToast('RP ID, account, and credential ID are required', 'error');
      return;
    }

    await this.createVaultEntity('passkey', payload);
    await this.renderPasskeys();
    showToast('Passkey saved');
  },

  async editPasskey(passkeyId) {
    const existing = await this.getVaultEntity('passkey', passkeyId);
    if (!existing) return;

    const formData = await this.showEntityForm({
      title: 'Edit Passkey',
      submitLabel: 'Update Passkey',
      fields: [
        { name: 'label', label: 'Label', value: existing.label || '' },
        { name: 'website_url', label: 'Website URL', value: existing.website_url || '' },
        { name: 'rp_id', label: 'Relying Party ID', required: true, value: existing.rp_id || '' },
        { name: 'user_name', label: 'Account / Email', required: true, value: existing.user_name || '' },
        { name: 'display_name', label: 'Display Name', value: existing.display_name || '' },
        { name: 'credential_id', label: 'Credential ID', required: true, value: existing.credential_id || '' },
        { name: 'public_key', label: 'Public Key', value: existing.public_key || '' },
        { name: 'notes', label: 'Notes', value: existing.notes || '' },
      ],
    });

    if (!formData) return;

    const payload = this.toPasskeyPayload({ ...existing, ...formData });
    if (!payload.rp_id || !payload.user_name || !payload.credential_id) {
      showToast('RP ID, account, and credential ID are required', 'error');
      return;
    }

    await this.updateVaultEntity(passkeyId, payload);
    await this.renderPasskeys();
    showToast('Passkey updated');
  },

  async deletePasskey(passkeyId) {
    const existing = await this.getVaultEntity('passkey', passkeyId);
    if (!existing) return;

    const passkeyLabel = this.formatPasskeyLabel(existing);
    const shouldDelete = await showConfirmDialog({
      title: 'Delete Passkey',
      message: `Delete "${truncateText(passkeyLabel)}"? This action cannot be undone.`,
      confirmText: 'Delete Passkey',
      cancelText: 'Cancel',
      confirmIcon: 'trash',
      destructive: true,
    });

    if (!shouldDelete) return;

    await this.deleteVaultEntity(passkeyId);
    await this.renderPasskeys();
    showToast(`Deleted ${truncateText(passkeyLabel)}`);
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
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const titleId = `entity-modal-title-${Date.now()}`;
      const helperId = `entity-modal-helper-${Date.now()}`;
      const overlay = document.createElement('div');
      overlay.className = 'entity-modal-overlay';
      overlay.setAttribute('tabindex', '-1');

      const formBody = fields
        .map((field, index) => {
          const type = field.type || 'text';
          const value = field.value == null ? '' : String(field.value);
          const min = field.min != null ? ` min="${field.min}"` : '';
          const max = field.max != null ? ` max="${field.max}"` : '';
          const required = field.required ? ' required' : '';
          const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
          const fieldId = `entity-field-${Date.now()}-${index}-${field.name.replace(/[^a-z0-9_-]/gi, '-')}`;

          return `
            <label class="entity-modal-label" for="${escapeHtml(fieldId)}">${escapeHtml(field.label)}</label>
            <input class="entity-modal-input" id="${escapeHtml(fieldId)}" name="${escapeHtml(field.name)}" type="${escapeHtml(type)}" value="${escapeHtml(value)}"${placeholder}${required}${min}${max}>
          `;
        })
        .join('');

      overlay.innerHTML = `
        <div class="entity-modal-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}"${helper ? ` aria-describedby="${helperId}"` : ''}>
          <div class="entity-modal-title" id="${titleId}">${escapeHtml(title)}</div>
          ${helper ? `<div class="entity-modal-helper" id="${helperId}">${escapeHtml(helper)}</div>` : ''}
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
        overlay.removeEventListener('keydown', onKeydown);
        overlay.remove();
        if (previousFocus?.isConnected) previousFocus.focus();
        resolve(result);
      };

      const onKeydown = (event) => {
        if (event.key === 'Escape') {
          close(null);
          return;
        }
        trapDialogFocus(overlay, event);
      };

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close(null);
      });
      overlay.addEventListener('keydown', onKeydown);

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

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.yurrr_server_url) {
    window.VaultSections?.invalidateEntityCache?.();
  }
  if (areaName === 'local' && changes[STORAGE_KEY_ENABLE_FAVICONS]) {
    faviconsEnabledCache = changes[STORAGE_KEY_ENABLE_FAVICONS].newValue !== false;
  }
});

// Lock button
document.getElementById('lock-btn').addEventListener('click', async () => {
  try {
    await sendMessage('LOGOUT');
  } catch {
    // local lock fallback still happens below
  }
  window.VaultSections?.invalidateEntityCache?.();
  document.getElementById('lock-btn').classList.add('hidden');
  hideAllScreens();
  LoginScreen.show();
});

function hideAllScreens() {
  hideBootScreen();
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('list-screen').classList.add('hidden');
  document.getElementById('detail-screen').classList.add('hidden');
  document.getElementById('form-screen').classList.add('hidden');
}

// Startup: check if unlocked
(async () => {
  try {
    const result = await sendMessage('IS_UNLOCKED');
    if (result.unlocked) {
      if (result.reachable === false) {
        const loginStatus = await LoginScreen.show({
          animate: false,
          awaitStatus: true,
          allowResume: true,
          allowHiddenResume: true,
          reveal: false,
          focus: false,
        });
        hideBootScreen();
        if (loginStatus?.resumed) {
          return;
        }
        LoginScreen.revealPrepared({ animate: false, focus: true });
        if (!loginStatus?.online) {
          showToast('Server not reachable. Will reconnect automatically when available.', 'error');
        }
        return;
      }

      await showUnlockedVault();
      hideBootScreen();
    } else {
      await LoginScreen.show({
        animate: false,
        awaitStatus: true,
        allowResume: false,
        reveal: false,
        focus: false,
      });
      hideBootScreen();
      LoginScreen.revealPrepared({ animate: false, focus: true });
      if (result.reason === 'session_invalid') {
        sessionInvalidToastShown = true;
        showToast('Session expired. Please log in again.', 'error');
      }
    }
  } catch {
    await LoginScreen.show({
      animate: false,
      awaitStatus: true,
      allowResume: false,
      reveal: false,
      focus: false,
    });
    hideBootScreen();
    LoginScreen.revealPrepared({ animate: false, focus: true });
  } finally {
    startupComplete = true;
  }
})();
