const STORAGE_KEY = 'yurrr_server_url';
const DEFAULT_URL = 'https://localhost:8443';
const STORAGE_KEY_EMAIL_SUGGESTIONS = 'yurrr_email_suggestions';
const STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS = 'yurrr_auto_email_suggestions';
const STORAGE_KEY_AUTO_EMAIL_SELECTED = 'yurrr_auto_email_selected';

const serverUrlInput = document.getElementById('server-url');
const testBtn = document.getElementById('test-btn');
const saveBtn = document.getElementById('save-btn');
const statusEl = document.getElementById('status');

// Load saved URL
chrome.storage.local.get(STORAGE_KEY, (result) => {
  serverUrlInput.value = result[STORAGE_KEY] || DEFAULT_URL;
});

function showStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

testBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.replace(/\/+$/, '');
  testBtn.disabled = true;
  testBtn.textContent = 'Testing...';

  try {
    const resp = await fetch(`${url}/api/v1/auth/status`);
    const data = await resp.json();
    showStatus(
      `Connected! Server v${data.server_version} — ${data.initialized ? 'Vault initialized' : 'Vault not initialized'}`,
      'success'
    );
  } catch (err) {
    showStatus(`Connection failed: ${err.message}. Have you accepted the self-signed certificate?`, 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = 'Test Connection';
  }
});

saveBtn.addEventListener('click', () => {
  const url = serverUrlInput.value.replace(/\/+$/, '');
  chrome.storage.local.set({ [STORAGE_KEY]: url }, () => {
    showStatus('Settings saved!', 'success');
    setTimeout(() => { statusEl.className = 'status hidden'; }, 2000);
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
const emailSuggestionsInput = document.getElementById('email-suggestions');
const saveEmailsBtn = document.getElementById('save-emails-btn');
const autoEmailSelectionListEl = document.getElementById('auto-email-selection-list');
const selectAllAutoEmailsBtn = document.getElementById('select-all-auto-emails-btn');
const selectNoneAutoEmailsBtn = document.getElementById('select-none-auto-emails-btn');
const clearAutoEmailsBtn = document.getElementById('clear-auto-emails-btn');
const importVaultEmailsBtn = document.getElementById('import-vault-emails-btn');
const emailStatusEl = document.getElementById('email-status');

let autoDetectedEmails = [];
let selectedAutoEmails = [];
let selectedInitialized = false;

function updateAutoLockVisibility(mode) {
  autoLockField.style.display = mode === 'inactivity' ? '' : 'none';
}

chrome.storage.local.get([STORAGE_KEY_SESSION_MODE, STORAGE_KEY_AUTO_LOCK_MINUTES], (result) => {
  const mode = result[STORAGE_KEY_SESSION_MODE] || 'ephemeral';
  sessionModeSelect.value = mode;
  autoLockInput.value = result[STORAGE_KEY_AUTO_LOCK_MINUTES] || 15;
  updateAutoLockVisibility(mode);
});

sessionModeSelect.addEventListener('change', () => {
  updateAutoLockVisibility(sessionModeSelect.value);
});

saveSessionBtn.addEventListener('click', () => {
  const mode = sessionModeSelect.value;
  const minutes = Math.max(1, Math.min(1440, parseInt(autoLockInput.value, 10) || 15));
  autoLockInput.value = minutes;

  const data = { [STORAGE_KEY_SESSION_MODE]: mode };
  if (mode === 'inactivity') {
    data[STORAGE_KEY_AUTO_LOCK_MINUTES] = minutes;
  }

  chrome.storage.local.set(data, () => {
    let message = 'Saved! Session will be cleared on browser restart.';
    if (mode === 'persistent') {
      message = 'Saved! Session persists across restarts, but locks when laptop locks.';
    } else if (mode === 'inactivity') {
      message = `Saved! Relaxed mode: session locks after ${minutes} minutes of inactivity.`;
    }
    sessionStatusEl.textContent = message;
    sessionStatusEl.className = 'status success';
    setTimeout(() => { sessionStatusEl.className = 'status hidden'; }, 3000);
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

  return unique;
}

function mergeUniqueEmails(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    for (const raw of list) {
      const email = String(raw || '').trim().toLowerCase();
      if (!email) continue;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
      if (seen.has(email)) continue;
      seen.add(email);
      merged.push(email);
    }
  }
  return merged;
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

function showEmailStatus(message, type) {
  emailStatusEl.textContent = message;
  emailStatusEl.className = `status ${type}`;
}

function parseStoredEmailSuggestions(value) {
  if (Array.isArray(value)) {
    return normalizeEmailSuggestions(value.join('\n'));
  }
  return normalizeEmailSuggestions(value || '');
}

function sanitizeSelectedAutoEmails(selectedEmails, detectedEmails) {
  const allowed = new Set(mergeUniqueEmails(detectedEmails));
  const selected = mergeUniqueEmails(selectedEmails);
  return selected.filter((email) => allowed.has(email));
}

function renderAutoEmailSelectionList() {
  if (!autoDetectedEmails.length) {
    autoEmailSelectionListEl.innerHTML = '<div class="auto-email-empty">No auto-detected emails yet.</div>';
    return;
  }

  const selectedSet = new Set(selectedAutoEmails);
  autoEmailSelectionListEl.innerHTML = autoDetectedEmails
    .map((email, idx) => {
      const id = `auto-email-item-${idx}`;
      const checked = selectedSet.has(email) ? 'checked' : '';
      return `
        <label class="auto-email-item" for="${id}">
          <input id="${id}" type="checkbox" data-email="${escapeHtml(email)}" ${checked}>
          <span>${escapeHtml(email)}</span>
        </label>
      `;
    })
    .join('');
}

function persistSelectedAutoEmails() {
  chrome.storage.local.set({ [STORAGE_KEY_AUTO_EMAIL_SELECTED]: selectedAutoEmails });
}

function setSelectedAutoEmails(nextSelected, persist = true) {
  selectedAutoEmails = sanitizeSelectedAutoEmails(nextSelected, autoDetectedEmails);
  selectedInitialized = true;
  renderAutoEmailSelectionList();
  if (persist) {
    persistSelectedAutoEmails();
  }
}

function applyAutoDetectedEmails(nextDetectedEmails, persistSelection = true) {
  const previousDetected = autoDetectedEmails;
  autoDetectedEmails = mergeUniqueEmails(nextDetectedEmails);

  if (!selectedInitialized) {
    selectedAutoEmails = [...autoDetectedEmails];
    selectedInitialized = true;
  } else {
    const selectedSet = new Set(sanitizeSelectedAutoEmails(selectedAutoEmails, autoDetectedEmails));
    const previousSet = new Set(previousDetected);
    for (const email of autoDetectedEmails) {
      if (!previousSet.has(email)) {
        selectedSet.add(email);
      }
    }
    selectedAutoEmails = Array.from(selectedSet);
  }

  renderAutoEmailSelectionList();
  if (persistSelection) {
    persistSelectedAutoEmails();
  }
}

chrome.storage.local.get(
  [STORAGE_KEY_EMAIL_SUGGESTIONS, STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS, STORAGE_KEY_AUTO_EMAIL_SELECTED],
  (result) => {
  const suggestions = Array.isArray(result[STORAGE_KEY_EMAIL_SUGGESTIONS])
    ? result[STORAGE_KEY_EMAIL_SUGGESTIONS]
    : [];
  const autoSuggestions = parseStoredEmailSuggestions(result[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]);
  const hasSelected = Array.isArray(result[STORAGE_KEY_AUTO_EMAIL_SELECTED]);
  const selected = parseStoredEmailSuggestions(result[STORAGE_KEY_AUTO_EMAIL_SELECTED]);

  emailSuggestionsInput.value = suggestions.join('\n');
  autoDetectedEmails = autoSuggestions;
  if (hasSelected) {
    selectedAutoEmails = sanitizeSelectedAutoEmails(selected, autoDetectedEmails);
    selectedInitialized = true;
    renderAutoEmailSelectionList();
  } else {
    applyAutoDetectedEmails(autoDetectedEmails, true);
  }
});

saveEmailsBtn.addEventListener('click', () => {
  const emails = normalizeEmailSuggestions(emailSuggestionsInput.value);
  chrome.storage.local.set({ [STORAGE_KEY_EMAIL_SUGGESTIONS]: emails }, () => {
    emailSuggestionsInput.value = emails.join('\n');
    showEmailStatus(`Saved ${emails.length} suggestion${emails.length === 1 ? '' : 's'}.`, 'success');
    setTimeout(() => {
      emailStatusEl.className = 'status hidden';
    }, 3000);
  });
});

clearAutoEmailsBtn.addEventListener('click', () => {
  chrome.storage.local.set({
    [STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]: [],
    [STORAGE_KEY_AUTO_EMAIL_SELECTED]: [],
  }, () => {
    autoDetectedEmails = [];
    selectedAutoEmails = [];
    selectedInitialized = true;
    renderAutoEmailSelectionList();
    showEmailStatus('Auto-detected emails cleared.', 'success');
    setTimeout(() => {
      emailStatusEl.className = 'status hidden';
    }, 3000);
  });
});

importVaultEmailsBtn.addEventListener('click', async () => {
  importVaultEmailsBtn.disabled = true;
  importVaultEmailsBtn.textContent = 'Importing...';

  try {
    const result = await sendBackgroundMessage('GET_KNOWN_EMAIL_USERNAMES');
    const vaultEmails = Array.isArray(result?.emails) ? result.emails : [];
    const existing = await chrome.storage.local.get(STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS);
    const currentAuto = Array.isArray(existing[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS])
      ? existing[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]
      : [];

    const merged = mergeUniqueEmails(currentAuto, vaultEmails);
    await chrome.storage.local.set({ [STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]: merged });
    showEmailStatus(`Imported ${vaultEmails.length} emails from vault.`, 'success');
  } catch (err) {
    showEmailStatus(`Import failed: ${err.message}`, 'error');
  } finally {
    importVaultEmailsBtn.disabled = false;
    importVaultEmailsBtn.textContent = 'Import From Vault';
  }
});

selectAllAutoEmailsBtn.addEventListener('click', () => {
  setSelectedAutoEmails(autoDetectedEmails, true);
});

selectNoneAutoEmailsBtn.addEventListener('click', () => {
  setSelectedAutoEmails([], true);
});

autoEmailSelectionListEl.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.type !== 'checkbox') return;

  const email = String(target.dataset.email || '').trim().toLowerCase();
  if (!email) return;

  const next = new Set(selectedAutoEmails);
  if (target.checked) {
    next.add(email);
  } else {
    next.delete(email);
  }
  setSelectedAutoEmails(Array.from(next), true);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS]) {
    const next = Array.isArray(changes[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS].newValue)
      ? changes[STORAGE_KEY_AUTO_EMAIL_SUGGESTIONS].newValue
      : [];
    applyAutoDetectedEmails(next, true);
  }
  if (changes[STORAGE_KEY_AUTO_EMAIL_SELECTED]) {
    const nextSelected = Array.isArray(changes[STORAGE_KEY_AUTO_EMAIL_SELECTED].newValue)
      ? changes[STORAGE_KEY_AUTO_EMAIL_SELECTED].newValue
      : [];
    setSelectedAutoEmails(nextSelected, false);
  }
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

csvFileInput.addEventListener('change', () => {
  previewBtn.disabled = !csvFileInput.files.length;
  importBtn.disabled = true;
  previewArea.classList.add('hidden');
  importStatus.classList.add('hidden');
  parsedEntries = [];
});

previewBtn.addEventListener('click', () => {
  const file = csvFileInput.files[0];
  if (!file) return;

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
        return `<div class="preview-item"><strong>${escapeHtml(domain)}</strong> &mdash; ${escapeHtml(entry.username)}</div>`;
      })
      .join('');

    if (parsedEntries.length > 20) {
      previewList.innerHTML += `<div class="preview-item">...and ${parsedEntries.length - 20} more</div>`;
    }

    previewArea.classList.remove('hidden');
    importBtn.disabled = false;
  };
  reader.readAsText(file);
});

importBtn.addEventListener('click', async () => {
  if (!parsedEntries.length) return;

  importBtn.disabled = true;
  importBtn.textContent = 'Importing...';
  importStatus.className = 'status';
  importStatus.textContent = `Importing ${parsedEntries.length} entries...`;

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

    importStatus.className = 'status success';
    importStatus.textContent = `Done! Imported: ${result.imported}, Skipped: ${result.skipped}, Failed: ${result.failed}`;
  } catch (err) {
    importStatus.className = 'status error';
    importStatus.textContent = `Import failed: ${err.message}`;
  } finally {
    importBtn.disabled = false;
    importBtn.textContent = 'Import';
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
