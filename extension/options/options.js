const STORAGE_KEY = 'yurrr_server_url';
const DEFAULT_URL = 'https://localhost:8443';
const STORAGE_KEY_EMAIL_SUGGESTIONS = 'yurrr_email_suggestions';
const STORAGE_KEY_ENABLE_FAVICONS = 'yurrr_enable_favicons';
const STORAGE_KEY_AUTOFILL_ENABLED = 'yurrr_autofill_enabled';
const DECRYPTED_EXPORT_CONFIRMATION = 'EXPORT DECRYPTED VAULT';
const MAX_EMAIL_SUGGESTIONS = 100;
const SESSION_MODES = new Set(['ephemeral', 'persistent', 'inactivity', 'never']);
const STORAGE_KEY_DETAIL_RESUME_MINUTES = 'yurrr_detail_resume_minutes';
const DEFAULT_DETAIL_RESUME_MINUTES = 5;
const MAX_DETAIL_RESUME_MINUTES = 60;

const serverUrlInput = document.getElementById('server-url');
const testBtn = document.getElementById('test-btn');
const saveBtn = document.getElementById('save-btn');
const statusEl = document.getElementById('status');
const exportVaultBtn = document.getElementById('export-vault-btn');
const exportStatusEl = document.getElementById('export-status');
const enableFaviconsEl = document.getElementById('enable-favicons');
const privacyStatusEl = document.getElementById('privacy-status');

const TOAST_ICONS = {
  success: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg>',
  error: '<svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12" /><path d="m18 6-12 12" /></svg>',
};

let toastDismissTimer = null;
let toastRemoveTimer = null;
const statusHideTimers = new WeakMap();

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

function showToast(message, variant = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

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
  icon.innerHTML = TOAST_ICONS[variant] || TOAST_ICONS.success;
  const text = document.createElement('span');
  text.textContent = message;
  inner.append(icon, text);
  toast.appendChild(inner);

  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));

  toastDismissTimer = setTimeout(() => {
    toast.classList.add('toast-hide');
    toastRemoveTimer = setTimeout(() => toast.remove(), 260);
  }, 2500);
}

function hideStatusLater(el, delay = 2500) {
  const existingTimer = statusHideTimers.get(el);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    el.className = 'status hidden';
    statusHideTimers.delete(el);
  }, delay);
  statusHideTimers.set(el, timer);
}

// Load saved URL
chrome.storage.local.get(STORAGE_KEY, (result) => {
  serverUrlInput.value = result[STORAGE_KEY] || DEFAULT_URL;
});

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  showToast(message, type === 'error' ? 'error' : 'success');
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return true;
  }

  const parts = host.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((part) => Number.parseInt(part, 10));
  if (nums.some((num, idx) => !Number.isInteger(num) || String(num) !== parts[idx] || num < 0 || num > 255)) {
    return false;
  }

  return nums[0] === 127;
}

function normalizeServerUrlInput(value) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error('Use a valid HTTPS server URL.');
  }

  if (url.username || url.password) {
    throw new Error('Server URL must not contain credentials.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Use an HTTPS server URL.');
  }

  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('HTTP is only allowed for localhost development URLs.');
  }

  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

testBtn.addEventListener('click', async () => {
  setButtonLoading(testBtn, true, 'Testing...');

  try {
    const url = normalizeServerUrlInput(serverUrlInput.value);
    serverUrlInput.value = url;
    const resp = await fetch(`${url}/api/v1/auth/status`);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}`);
    }
    const data = await resp.json();
    showStatus(
      `Connected! Server v${data.server_version} - ${data.initialized ? 'Vault initialized' : 'Vault not initialized'}`,
      'success'
    );
  } catch (err) {
    showStatus(`Connection failed: ${err.message}. Have you accepted the self-signed certificate?`, 'error');
  } finally {
    setButtonLoading(testBtn, false);
    hideStatusLater(statusEl);
  }
});

saveBtn.addEventListener('click', () => {
  let url;
  try {
    url = normalizeServerUrlInput(serverUrlInput.value);
    serverUrlInput.value = url;
  } catch (err) {
    showStatus(err.message, 'error');
    hideStatusLater(statusEl);
    return;
  }

  setButtonLoading(saveBtn, true, 'Saving...');
  chrome.storage.local.set({ [STORAGE_KEY]: url }, () => {
    showStatus('Settings saved!', 'success');
    setButtonLoading(saveBtn, false);
    hideStatusLater(statusEl);
  });
});

// --- Session Mode ---
const STORAGE_KEY_SESSION_MODE = 'yurrr_session_mode';
const STORAGE_KEY_AUTO_LOCK_MINUTES = 'yurrr_auto_lock_minutes';
const sessionModeSelect = document.getElementById('session-mode');
const saveSessionBtn = document.getElementById('save-session-btn');
const sessionStatusEl = document.getElementById('session-status');
const autoLockField = document.getElementById('auto-lock-field');
const autoLockInput = document.getElementById('auto-lock-minutes');
const detailResumeInput = document.getElementById('detail-resume-minutes');
const autofillEnabledInput = document.getElementById('autofill-enabled');
const emailSuggestionsInput = document.getElementById('email-suggestions');
const saveEmailsBtn = document.getElementById('save-emails-btn');
const emailStatusEl = document.getElementById('email-status');

function updateAutoLockVisibility(mode) {
  autoLockField.style.display = mode === 'inactivity' ? '' : 'none';
}

function normalizeDetailResumeMinutes(value) {
  const minutes = Number.parseInt(value, 10);
  if (!Number.isFinite(minutes)) return DEFAULT_DETAIL_RESUME_MINUTES;
  return Math.max(0, Math.min(MAX_DETAIL_RESUME_MINUTES, minutes));
}

chrome.storage.local.get(
  [
    STORAGE_KEY_SESSION_MODE,
    STORAGE_KEY_AUTO_LOCK_MINUTES,
    STORAGE_KEY_DETAIL_RESUME_MINUTES,
    STORAGE_KEY_AUTOFILL_ENABLED,
  ],
  (result) => {
    const storedMode = result[STORAGE_KEY_SESSION_MODE] || 'ephemeral';
    const mode = SESSION_MODES.has(storedMode) ? storedMode : 'ephemeral';
    sessionModeSelect.value = mode;
    autoLockInput.value = result[STORAGE_KEY_AUTO_LOCK_MINUTES] || 15;
    detailResumeInput.value = normalizeDetailResumeMinutes(result[STORAGE_KEY_DETAIL_RESUME_MINUTES]);
    autofillEnabledInput.checked = result[STORAGE_KEY_AUTOFILL_ENABLED] === true;
    updateAutoLockVisibility(mode);
  }
);

sessionModeSelect.addEventListener('change', () => {
  updateAutoLockVisibility(sessionModeSelect.value);
});

saveSessionBtn.addEventListener('click', () => {
  const mode = sessionModeSelect.value;
  const minutes = Math.max(1, Math.min(1440, parseInt(autoLockInput.value, 10) || 15));
  const detailResumeMinutes = normalizeDetailResumeMinutes(detailResumeInput.value);
  autoLockInput.value = minutes;
  detailResumeInput.value = detailResumeMinutes;

  const data = {
    [STORAGE_KEY_SESSION_MODE]: mode,
    [STORAGE_KEY_DETAIL_RESUME_MINUTES]: detailResumeMinutes,
    [STORAGE_KEY_AUTOFILL_ENABLED]: autofillEnabledInput.checked,
  };
  if (mode === 'inactivity') {
    data[STORAGE_KEY_AUTO_LOCK_MINUTES] = minutes;
  }

  setButtonLoading(saveSessionBtn, true, 'Saving...');
  chrome.storage.local.set(data, () => {
    let message = 'Saved! Session will be cleared on browser restart.';
    if (mode === 'persistent') {
      message = 'Saved! Session persists across restarts, but locks when laptop locks.';
    } else if (mode === 'inactivity') {
      message = `Saved! Relaxed mode: session locks after ${minutes} minutes of inactivity.`;
    } else if (mode === 'never') {
      message = 'Saved! Session only locks on manual lock, password change, or server restart.';
    }
    const resumeMessage = detailResumeMinutes === 0
      ? ' Entry restore is disabled.'
      : ` Entry restore window is ${detailResumeMinutes} minute${detailResumeMinutes === 1 ? '' : 's'}.`;
    const autofillMessage = autofillEnabledInput.checked
      ? ' Autofill is enabled.'
      : ' Autofill is disabled.';
    const fullMessage = `${message}${resumeMessage}${autofillMessage}`;
    sessionStatusEl.textContent = fullMessage;
    sessionStatusEl.className = 'status success';
    showToast(fullMessage, 'success');
    setButtonLoading(saveSessionBtn, false);
    hideStatusLater(sessionStatusEl, 3000);
  });
});

// --- Email Suggestions ---

function normalizeEmailSuggestions(rawValue) {
  const rawItems = String(rawValue || '').split(/\n|,|;/);
  const unique = [];
  const seen = new Set();

  for (const rawItem of rawItems) {
    const email = rawItem.trim();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(email);
  }

  return unique.slice(0, MAX_EMAIL_SUGGESTIONS);
}

async function sendBackgroundMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.error) {
        reject(new Error(response.error));
        return;
      }
      resolve(response);
    });
  });
}

function showExportStatus(message, type) {
  exportStatusEl.textContent = message;
  exportStatusEl.className = `status ${type}`;
  showToast(message, type === 'error' ? 'error' : 'success');
}

function showPrivacyStatus(message, type) {
  privacyStatusEl.textContent = message;
  privacyStatusEl.className = `status ${type}`;
  showToast(message, type === 'error' ? 'error' : 'success');
}

function confirmDecryptedExport() {
  const message = [
    'This downloads every vault item as decrypted JSON.',
    'Anyone with the file can read the passwords and notes.',
    '',
    `Type ${DECRYPTED_EXPORT_CONFIRMATION} to continue.`,
  ].join('\n');
  return window.prompt(message, '') === DECRYPTED_EXPORT_CONFIRMATION;
}

function promptExportMasterPassword() {
  const value = window.prompt('Enter your master password to export decrypted vault data.', '');
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function downloadJson(filename, data) {
  const json = JSON.stringify(data ?? null, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportVaultBtn.addEventListener('click', async () => {
  if (!confirmDecryptedExport()) {
    showExportStatus('Export canceled.', 'error');
    hideStatusLater(exportStatusEl, 3000);
    return;
  }

  let masterPassword = promptExportMasterPassword();
  if (!masterPassword) {
    showExportStatus('Export canceled.', 'error');
    hideStatusLater(exportStatusEl, 3000);
    return;
  }

  setButtonLoading(exportVaultBtn, true, 'Exporting...');

  try {
    const exportData = await sendBackgroundMessage('EXPORT_VAULT', { masterPassword });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadJson(`yurrr-vault-export-${timestamp}.json`, exportData);
    showExportStatus('Vault export downloaded.', 'success');
  } catch (err) {
    showExportStatus(`Export failed: ${err.message}`, 'error');
  } finally {
    masterPassword = '';
    setButtonLoading(exportVaultBtn, false);
    hideStatusLater(exportStatusEl, 3000);
  }
});

chrome.storage.local.get(STORAGE_KEY_ENABLE_FAVICONS, (result) => {
  enableFaviconsEl.checked = result[STORAGE_KEY_ENABLE_FAVICONS] !== false;
});

enableFaviconsEl.addEventListener('change', () => {
  const enabled = enableFaviconsEl.checked;
  chrome.storage.local.set({ [STORAGE_KEY_ENABLE_FAVICONS]: enabled }, () => {
    const message = enabled
      ? 'Website favicons enabled for popup display.'
      : 'Website favicons disabled for popup display.';
    showPrivacyStatus(message, 'success');
    hideStatusLater(privacyStatusEl, 3000);
  });
});

function showEmailStatus(message, type) {
  emailStatusEl.textContent = message;
  emailStatusEl.className = `status ${type}`;
  showToast(message, type === 'error' ? 'error' : 'success');
}

function parseStoredEmailSuggestions(value) {
  if (Array.isArray(value)) {
    return normalizeEmailSuggestions(value.join('\n'));
  }
  return normalizeEmailSuggestions(value || '');
}

chrome.storage.local.get(STORAGE_KEY_EMAIL_SUGGESTIONS, (result) => {
  const suggestions = parseStoredEmailSuggestions(result[STORAGE_KEY_EMAIL_SUGGESTIONS]);
  emailSuggestionsInput.value = suggestions.join('\n');
});

saveEmailsBtn.addEventListener('click', () => {
  const emails = normalizeEmailSuggestions(emailSuggestionsInput.value);
  setButtonLoading(saveEmailsBtn, true, 'Saving...');
  chrome.storage.local.set({ [STORAGE_KEY_EMAIL_SUGGESTIONS]: emails }, () => {
    emailSuggestionsInput.value = emails.join('\n');
    showEmailStatus(`Saved ${emails.length} suggestion${emails.length === 1 ? '' : 's'}.`, 'success');
    setButtonLoading(saveEmailsBtn, false);
    hideStatusLater(emailStatusEl, 3000);
  });
});

// --- Import ---

const csvFileInput = document.getElementById('csv-file');
const browserSelect = document.getElementById('browser-select');
const previewBtn = document.getElementById('preview-btn');
const importBtn = document.getElementById('import-btn');
const previewArea = document.getElementById('preview-area');
const previewList = document.getElementById('preview-list');
const previewCount = document.getElementById('preview-count');
const importStatus = document.getElementById('import-status');
const skipDuplicatesEl = document.getElementById('skip-duplicates');

let parsedEntries = [];

function clearParsedImportState(clearFile = false) {
  parsedEntries = [];
  importBtn.disabled = true;
  previewArea.classList.add('hidden');
  if (clearFile) {
    csvFileInput.value = '';
    previewBtn.disabled = true;
  }
}

function showImportStatus(message, type, showToastFlag = true) {
  importStatus.textContent = message;
  importStatus.className = `status ${type}`;
  if (showToastFlag) {
    showToast(message, type === 'error' ? 'error' : 'success');
  }
}

csvFileInput.addEventListener('change', () => {
  previewBtn.disabled = !csvFileInput.files.length;
  clearParsedImportState(false);
  importStatus.classList.add('hidden');
});

browserSelect.addEventListener('change', () => {
  clearParsedImportState(false);
  importStatus.classList.add('hidden');
});

previewBtn.addEventListener('click', () => {
  const file = csvFileInput.files[0];
  if (!file) return;

  setButtonLoading(previewBtn, true, 'Parsing...');

  const reader = new FileReader();
  reader.onload = (e) => {
    const csvText = e.target.result;
    const browserType = browserSelect.value;
    parsedEntries = CSVParser.parse(csvText, browserType);

    previewCount.textContent = parsedEntries.length;

    if (!parsedEntries.length) {
      previewList.innerHTML = '<div class="preview-item">No valid entries found in CSV file.</div>';
      previewArea.classList.remove('hidden');
      importBtn.disabled = true;
      setButtonLoading(previewBtn, false);
      return;
    }

    previewList.innerHTML = parsedEntries
      .slice(0, 20)
      .map((entry) => {
        let domain;
        try {
          domain = new URL(entry.website_url).hostname;
        } catch {
          domain = entry.website_url;
        }
        return `<div class="preview-item"><strong>${escapeHtml(domain)}</strong> - ${escapeHtml(entry.username)}</div>`;
      })
      .join('');

    if (parsedEntries.length > 20) {
      previewList.innerHTML += `<div class="preview-item">...and ${parsedEntries.length - 20} more</div>`;
    }

    previewArea.classList.remove('hidden');
    importBtn.disabled = false;
    showToast(`Preview ready: ${parsedEntries.length} entries.`, 'success');
    setButtonLoading(previewBtn, false);
  };

  reader.onerror = () => {
    showToast('Could not read CSV file.', 'error');
    setButtonLoading(previewBtn, false);
  };

  reader.readAsText(file);
});

importBtn.addEventListener('click', async () => {
  if (!parsedEntries.length) return;

  setButtonLoading(importBtn, true, 'Importing...');
  showImportStatus(`Importing ${parsedEntries.length} entries...`, 'success', false);

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: 'BULK_IMPORT',
          payload: {
            entries: parsedEntries,
            skipDuplicates: skipDuplicatesEl.checked,
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (response && response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        }
      );
    });

    showImportStatus(`Done! Imported: ${result.imported}, Skipped: ${result.skipped}, Failed: ${result.failed}`, 'success', true);
    clearParsedImportState(true);
  } catch (err) {
    showImportStatus(`Import failed: ${err.message}`, 'error', true);
  } finally {
    setButtonLoading(importBtn, false);
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
