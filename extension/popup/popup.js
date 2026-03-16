// Utility: Send message to service worker
function sendMessage(type, payload = {}) {
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
  setTimeout(() => toast.remove(), 2000);
}

// Initialize all components
LoginScreen.init();
EntryList.init();
EntryDetail.init();
EntryForm.init();

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
      // Warm up self-signed cert from popup context before service worker API calls
      const serverUrl = await getServerUrl();
      try { await fetch(`${serverUrl}/api/v1/auth/status`); } catch {}

      hideAllScreens();
      document.getElementById('lock-btn').classList.remove('hidden');
      EntryList.show();
    } else {
      LoginScreen.show();
    }
  } catch {
    LoginScreen.show();
  }
})();
