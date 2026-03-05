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
