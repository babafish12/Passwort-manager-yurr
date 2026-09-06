import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VaultAPI } from '../extension/background/api.js';
import { SessionManager } from '../extension/background/session.js';
import * as constants from '../extension/lib/constants.js';
import '../extension/lib/site-scope.js';
import { loadClassic, chromeMock, element } from './helpers.mjs';

const cases = JSON.parse(readFileSync(new URL('./site-scope-cases.json', import.meta.url)));
test('LAN scope includes effective port, including existing URLs and IPv6', () => {
  for (const [url, expected] of cases) assert.equal(YurrrSiteScope.key(url) || null, expected, url);
});

function worker() {
  return loadClassic('extension/background/service-worker.js', '({ isCredentialAllowedForPage, getDomainFromUrl, getSafeCredentialUrlForPage, getCredentialSaveDecision, setPendingUsername, getPendingUsername })', {
    ...constants, VaultAPI, SessionManager, YurrrSiteScope,
    chrome: chromeMock(),
  });
}

test('autofill and save prompts isolate LAN ports, including default ports', async () => {
  globalThis.chrome = chromeMock();
  const subject = worker();
  const saved = { website_url: 'http://192.168.1.10:8080/login', username: 'admin' };
  assert.equal(subject.isCredentialAllowedForPage(saved, 'http://192.168.1.10:8080/other'), true);
  assert.equal(subject.isCredentialAllowedForPage(saved, 'http://192.168.1.10:9000/'), false);
  for (const host of ['100.118.2.12', '[febf::1]', '[::ffff:c0a8:10a]']) {
    assert.equal(subject.isCredentialAllowedForPage({ website_url: `http://${host}:8080` }, `http://${host}:8080/`), true);
    assert.equal(subject.isCredentialAllowedForPage({ website_url: `http://${host}:8080` }, `http://${host}:9000/`), false);
  }
  assert.equal(subject.isCredentialAllowedForPage({ website_url: 'http://192.168.1.10' }, 'http://192.168.1.10:80/'), true);
  assert.equal(subject.isCredentialAllowedForPage({ website_url: 'https://192.168.1.10' }, 'http://192.168.1.10:443/'), false);
  assert.equal(subject.isCredentialAllowedForPage({ website_url: '192.168.1.10:8080' }, 'https://192.168.1.10:8080/'), true);
  assert.equal(subject.isCredentialAllowedForPage({ website_url: 'https://example.com' }, 'https://www.example.com/login'), true);
  assert.equal(subject.isCredentialAllowedForPage({ website_url: 'https://example.com' }, 'https://evil.example.com/'), false);
  assert.equal(subject.getSafeCredentialUrlForPage('http://192.168.1.10:9000', 'http://192.168.1.10:8080/'), 'http://192.168.1.10:8080/');
  const decision = await subject.getCredentialSaveDecision([saved], 'http://192.168.1.10:9000/', 'admin', 'new');
  assert.equal(decision.action, 'create');
  const first = subject.getDomainFromUrl('http://192.168.1.10:8080');
  const second = subject.getDomainFromUrl('http://192.168.1.10:9000');
  await subject.setPendingUsername(first, '', 'alice');
  await subject.setPendingUsername(second, '', 'bob');
  assert.equal(await subject.getPendingUsername(first), 'alice');
  assert.equal(await subject.getPendingUsername(second), 'bob');
});

const parser = loadClassic('extension/options/csv-parser.js', 'CSVParser');
test('CSV preserves quoted passwords, Unicode, whitespace, commas and newlines', () => {
  const report = parser.parseWithReport('\uFEFFurl,username,password,note\r\nHTTPS://example.com,alice,"  a,""b""\r\nç  ","line1\nline2"\r\nhttpbin.org,bob,secret,\r\n', 'chrome');
  assert.equal(report.entries.length, 2);
  assert.equal(report.entries[0].password, '  a,"b"\r\nç  ');
  assert.equal(report.entries[0].notes, 'line1\nline2');
  assert.equal(report.entries[1].website_url, 'https://httpbin.org/');
});
test('CSV reports skipped records and rejects malformed exports instead of corrupting passwords', () => {
  const report = parser.parseWithReport('url,username,password\nhttps://example.com,,secret\nftp://example.com,user,secret\nhttps://example.com,user,secret', 'firefox');
  assert.equal(report.skippedRows, 2);
  assert.equal(report.entries.length, 1);
  for (const text of ['url,username,password\nx,u,"secret', 'url,username,password\nx,u,s,e', 'url,password\nx,s', 'url,username,password\nx,u,s"ecret']) {
    assert.throws(() => parser.parse(text, 'chrome'));
  }
});

test('API locks locally before a delayed logout and ignores old credential responses', async () => {
  globalThis.chrome = chromeMock({}, { yurrr_token: 'old', yurrr_token_server_url: 'https://localhost:8443' });
  const api = new VaultAPI();
  api.serverUrl = 'https://localhost:8443';
  api.setToken('old', api.serverUrl);
  const manager = new SessionManager(api);
  let finishEntry;
  let finishLogout;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal);
    return new Promise((resolve) => {
      if (url.endsWith('/logout')) finishLogout = resolve;
      else finishEntry = resolve;
    });
  };
  try {
    const entryRequest = api.getEntry('one');
    await new Promise((resolve) => setImmediate(resolve));
    const locking = manager.lock();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(api.token, null);
    assert.equal(chrome.storage.session.data.yurrr_token, undefined);
    api.setToken('new', api.serverUrl);
    finishEntry(new Response(JSON.stringify({ password: 'old-secret' })));
    await assert.rejects(entryRequest, { code: 'SESSION_CHANGED' });
    finishLogout(new Response('{}'));
    await locking;
    assert.equal(api.token, 'new');
  } finally { globalThis.fetch = originalFetch; }
});

test('favicon conversion works without FileReader in a service worker', async () => {
  const api = new VaultAPI();
  api.serverUrl = 'https://localhost:8443';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  try { assert.equal(await api.getFavicon('example.com'), 'data:image/png;base64,AQID'); }
  finally { globalThis.fetch = originalFetch; }
});

test('login prevents duplicate submissions and status polling cannot reenable a busy button', async () => {
  let resolveLogin;
  let loginCalls = 0;
  const elements = Object.fromEntries(['login-screen', 'master-password', 'unlock-btn', 'login-error', 'server-status', 'server-status-text', 'setup-section', 'setup-btn', 'lock-btn'].map((id) => [id, element()]));
  const subject = loadClassic('extension/popup/components/login.js', 'LoginScreen', {
    document: { getElementById: (id) => elements[id] },
    window: { setButtonLoading(button, busy) { button.disabled = busy; }, VaultSections: { setActiveTab: async () => {} } },
    sendMessage() { loginCalls++; return new Promise((resolve) => { resolveLogin = resolve; }); },
  });
  subject.init();
  subject.setLoginControls('unlock');
  subject.passwordInput.value = 'test-password';
  const first = subject.handleUnlock();
  await subject.handleUnlock();
  subject.setLoginControls('unlock');
  assert.equal(loginCalls, 1);
  assert.equal(subject.unlockBtn.disabled, true);
  resolveLogin({});
  await first;
  assert.equal(subject.passwordInput.value, '');
});

test('editing an entry explicitly sends empty notes to delete existing notes', async () => {
  let message;
  const subject = loadClassic('extension/popup/components/entry-form.js', 'EntryForm', {
    window: {}, PasswordGenerator: { updateStrength() {} }, EntryList: { show() {} }, showToast() {}, isSessionLostError: () => false,
    sendMessage: async (type, payload) => { message = { type, payload }; },
  });
  Object.assign(subject, { editingId: 'one', form: { reportValidity: () => true }, saveBtn: element(), screen: element(), urlInput: element('https://example.com'), usernameInput: element('alice'), passwordInput: element('secret'), notesInput: element('') });
  await subject.handleSave();
  assert.equal(message.type, 'UPDATE_ENTRY');
  assert.equal(message.payload.data.notes, '');
});

test('address detection keeps email fields intact and distinguishes city from street', () => {
  const subject = loadClassic('extension/content/heuristics.js', 'YurrrHeuristics', { window: { getComputedStyle: () => ({}) } });
  const field = (name, autocomplete = '') => ({ ...element(), name, type: 'text', tagName: 'INPUT', offsetWidth: 100, offsetHeight: 20, labels: [], closest: () => null, getAttribute: (key) => key === 'autocomplete' ? autocomplete : '' });
  assert.equal(subject.getAddressFieldKind(field('Email address')), '');
  assert.equal(subject.getAddressFieldKind(field('address_city')), 'city');
  assert.equal(subject.getAddressFieldKind(field('address_postal_code')), 'postal_code');
  assert.equal(subject.getAddressFieldKind(field('address', 'shipping email')), '');
  assert.equal(subject.getAddressFieldKind(field('address_line1')), 'line1');
});

test('a slower tab response cannot replace the newly selected vault section', async () => {
  let resolveCards;
  const list = element();
  const subject = loadClassic('extension/popup/popup.js', 'VaultSections', {
    window: {}, document: { createElement: () => element() },
    EntryList: { renderSearchEmptyState() {} },
  }, { before: '// Initialize all components' });
  subject.listEl = list;
  subject.searchInput = element();
  subject.activeTab = 'cards';
  subject.listVaultEntities = (type) => type === 'card'
    ? new Promise((resolve) => { resolveCards = resolve; })
    : Promise.resolve([{ id: 'address-one', full_name: 'Sample Address', postal_code: '8000' }]);
  const cards = subject.renderCards();
  subject.activeTab = 'addresses';
  await subject.renderAddresses();
  const addressMarkup = list.innerHTML;
  resolveCards([{ id: 'card-one', brand: 'visa', last4: '1234' }]);
  await cards;
  assert.equal(list.innerHTML, addressMarkup);
  assert.match(list.innerHTML, /data-address-id/);
});

test('generator discards a late response after the suggestion has closed', async () => {
  let respond;
  const subject = loadClassic('extension/content/overlay.js', 'YurrrOverlay', {
    chrome: { runtime: { sendMessage(message, callback) { respond = callback; } } },
  });
  subject.elements = { pwEl: element(), useBtn: element() };
  subject.currentTarget = element();
  const generating = subject.generateAndShow(20);
  subject.hide();
  respond({ password: 'late-test-secret' });
  await generating;
  assert.equal(subject.currentPassword, '');
  assert.equal(subject.elements.pwEl.textContent, '');
  assert.equal(subject.elements.useBtn.disabled, true);
});
