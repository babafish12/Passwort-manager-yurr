const STORAGE_KEY = 'yurrr_server_url';
const DEFAULT_URL = 'https://localhost:8443';

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
