import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultAPI } from '../extension/background/api.js';
import { SessionManager } from '../extension/background/session.js';
import * as constants from '../extension/lib/constants.js';
import { chromeMock, element, loadClassic } from './helpers.mjs';

const entry = (id = 'one', password = 'synthetic-secret') => ({
  id, website_url: 'https://example.com/login', website_domain: 'example.com',
  username: 'alice', password, notes: 'Synthetic note', favorite: false,
  updated_at: '2026-09-06 12:00:00', created_at: '2026-09-06 12:00:00', has_favicon: false,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function setup(t, { local = {}, chrome = chromeMock(local, { yurrr_token: 'session-one', yurrr_token_server_url: 'https://localhost:8443' }) } = {}) {
  globalThis.chrome = chrome;
  const api = new VaultAPI();
  api.serverUrl = 'https://localhost:8443';
  api.setToken('session-one', api.serverUrl);
  const session = new SessionManager(api);
  const requests = [];
  const changes = [];
  t.mock.method(api, 'listEntries', async () => { requests.push('list'); return [entry()]; });
  t.mock.method(api, 'getEntry', async (id) => { requests.push(id); return entry(id); });
  session.popupCache.onChange = (change) => changes.push(change);
  return { chrome, api, session, cache: session.popupCache, requests, changes };
}

test('popup bootstrap authenticates with the list, without a separate session request; content scripts cannot use it', async (t) => {
  const chrome = chromeMock({}, { yurrr_token: 'session-one', yurrr_token_server_url: 'https://localhost:8443' });
  globalThis.chrome = chrome;
  const worker = loadClassic('extension/background/service-worker.js', '({ ready: startupReady, handleMessage, api })', {
    ...constants, VaultAPI, SessionManager, chrome,
  });
  await worker.ready;
  t.mock.method(worker.api, 'listEntries', async () => [entry()]);
  t.mock.method(worker.api, 'validateSession', async () => { throw new Error('Unexpected session request'); });
  const sender = { id: chrome.runtime.id };
  const cold = await worker.handleMessage({ type: 'POPUP_BOOTSTRAP' }, sender);
  const warm = await worker.handleMessage({ type: 'POPUP_BOOTSTRAP' }, sender);
  assert.equal(cold.unlocked, true);
  assert.equal(warm.snapshot.data[0].username, 'alice');
  assert.equal(worker.api.listEntries.mock.callCount(), 1);
  assert.equal(worker.api.validateSession.mock.callCount(), 0);
  assert.equal(cold.snapshot.data[0].password, undefined);
  for (const type of ['POPUP_BOOTSTRAP', 'POPUP_LIST', 'POPUP_ENTRY']) {
    await assert.rejects(worker.handleMessage({ type, payload: { id: 'one' } }, {
      id: chrome.runtime.id, tab: { id: 1 }, url: 'https://example.com',
    }), { code: 'FORBIDDEN' });
  }
});

test('cached details return before a deferred background response and concurrent refreshes share one request', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { api, cache } = setup(t);
  const first = await cache.read('entry:one');
  t.mock.timers.tick(constants.POPUP_CACHE_REFRESH_MS);
  const response = deferred();
  api.getEntry.mock.mockImplementation(() => response.promise);
  const [a, b] = await Promise.all([cache.read('entry:one'), cache.read('entry:one')]);
  assert.equal(a.data.password, 'synthetic-secret');
  assert.equal(b.expiresAt, first.expiresAt);
  assert.equal(api.getEntry.mock.callCount(), 2);
  response.resolve(entry('one', 'new-secret'));
  await tick();
  const refreshed = await cache.read('entry:one');
  assert.equal(refreshed.data.password, 'new-secret');
});

test('concurrent cold reads share one request and responses cannot modify the cached object', async (t) => {
  const { api, cache } = setup(t);
  const response = deferred();
  api.getEntry.mock.mockImplementation(() => response.promise);
  const a = cache.read('entry:one');
  const b = cache.read('entry:one');
  await tick();
  assert.equal(api.getEntry.mock.callCount(), 1);
  response.resolve(entry());
  const [first, second] = await Promise.all([a, b]);
  first.data.password = 'modified-by-consumer';
  assert.equal(second.data.password, 'synthetic-secret');
  assert.equal((await cache.read('entry:one')).data.password, 'synthetic-secret');
});

test('offline reads do not extend the five-minute deadline, and expiry removes the stored secrets', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { api, session, cache, chrome, changes } = setup(t);
  const initial = await cache.read('entry:one');
  api.getEntry.mock.mockImplementation(async () => { throw api.createError('Offline', 'NETWORK_ERROR'); });
  t.mock.timers.tick(31000);
  const offline = await cache.read('entry:one');
  await tick();
  assert.equal(offline.expiresAt, initial.expiresAt);
  assert.equal(changes.some((change) => change.offline), true);
  assert.equal((await cache.read('entry:one', { refresh: false })).offline, true);
  t.mock.timers.tick(constants.POPUP_CACHE_TTL_MS - 31000);
  await cache.expire();
  assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined);
  assert.equal(cache.records.size, 0);
  assert.equal(await session.isUnlocked(), true);
  await assert.rejects(cache.read('entry:one'), { code: 'NETWORK_ERROR' });
});

test('service-worker restart restores session cache; browser restart and different tokens or exact server paths cannot reuse it', async (t) => {
  const { cache, chrome } = setup(t);
  await cache.read('entry:one');
  const restarted = setup(t, { chrome });
  assert.equal((await restarted.cache.read('entry:one')).data.password, 'synthetic-secret');
  assert.equal(restarted.requests.length, 0);
  chrome.storage.session.data.yurrr_token = 'session-two';
  await restarted.cache.read('entry:one');
  assert.equal(restarted.requests.length, 1);
  const otherPath = setup(t, { chrome });
  otherPath.api.serverUrl = 'https://localhost:8443/other-vault';
  await otherPath.cache.read('entry:one');
  assert.equal(otherPath.requests.length, 1);
  const browserRestart = setup(t);
  await browserRestart.cache.read('entry:one');
  assert.equal(browserRestart.requests.length, 1);
  assert.equal(chrome.storage.local.data.yurrr_popup_cache, undefined);
});

test('cache retains only the 20 most recently used details plus the sanitized list', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { cache, chrome } = setup(t);
  await cache.read('list');
  for (let i = 0; i < 20; i++) {
    t.mock.timers.tick(1);
    await cache.read(`entry:${i}`);
  }
  t.mock.timers.tick(1);
  await cache.read('entry:0');
  t.mock.timers.tick(1);
  await cache.read('entry:20');
  assert.equal(cache.records.size, 21);
  assert.equal(cache.records.has('entry:1'), false);
  assert.equal(cache.records.has('entry:0'), true);
  const list = chrome.storage.session.data.yurrr_popup_cache.records.list.data;
  assert.equal(list[0].password, undefined);
  assert.equal(list[0].notes, undefined);
});

test('expired inactivity deadline is checked before cached access can reset the alarm', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { cache, api, chrome } = setup(t, { local: { yurrr_session_mode: 'inactivity', yurrr_auto_lock_minutes: 1 } });
  t.mock.method(VaultAPI.prototype, 'logout', async () => ({}));
  const snapshot = await cache.read('entry:one');
  assert.equal(snapshot.expiresAt, 1060000);
  t.mock.timers.tick(60000);
  await assert.rejects(cache.read('entry:one'), { code: 'SESSION_LOST' });
  assert.equal(api.token, null);
  assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined);
});

test('server rejection clears cached secrets, including when it arrives during background refresh', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { cache, api, chrome } = setup(t);
  await cache.read('entry:one');
  t.mock.timers.tick(31000);
  const response = deferred();
  api.getEntry.mock.mockImplementation(() => response.promise);
  await cache.read('entry:one');
  response.reject(api.createError('Revoked', 'AUTH_ERROR'));
  await tick();
  assert.equal(api.token, null);
  assert.equal(cache.records.size, 0);
  assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined);
});

test('lock and a new login discard old responses without clearing the new session', async (t) => {
  const { api, cache, session, chrome } = setup(t);
  const response = deferred();
  api.getEntry.mock.mockImplementation(() => response.promise);
  const reading = cache.read('entry:one');
  const rejected = assert.rejects(reading, { code: 'SESSION_CHANGED' });
  await tick();
  await session.forceLocalLock();
  await session.saveToken('new-token');
  response.resolve(entry('one', 'old-secret'));
  await rejected;
  assert.equal(api.token, 'new-token');
  assert.equal(cache.records.size, 0);
  assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined);
});

test('a storage write already in flight cannot resurrect a locked cache', async (t) => {
  const { cache, chrome, session } = setup(t);
  const started = deferred();
  const release = deferred();
  const set = chrome.storage.session.set.bind(chrome.storage.session);
  t.mock.method(chrome.storage.session, 'set', async (data) => {
    if (data.yurrr_popup_cache) { started.resolve(); await release.promise; }
    await set(data);
  });
  const reading = cache.read('entry:one');
  const rejected = assert.rejects(reading, { code: 'SESSION_CHANGED' });
  await started.promise;
  const locking = session.forceLocalLock();
  release.resolve();
  await locking;
  await rejected;
  assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined);
});

test('mutations invalidate both before and after writing and reject reads started before the mutation', async (t) => {
  const { cache, session, api } = setup(t);
  await cache.read('list');
  const old = deferred();
  api.getEntry.mock.mockImplementation(() => old.promise);
  const reading = cache.read('entry:one');
  const rejected = assert.rejects(reading, { code: 'CACHE_CHANGED' });
  await tick();
  const mutation = deferred();
  const writing = session.mutateEntries(() => mutation.promise);
  await tick();
  assert.equal(cache.records.size, 0);
  old.resolve(entry());
  await rejected;
  api.getEntry.mock.mockImplementation(async () => entry('one', 'updated'));
  const after = cache.read('entry:one');
  mutation.resolve();
  await writing;
  assert.equal((await after).data.password, 'updated');
  assert.equal(cache.records.has('list'), false);
});

test('remote deletion evicts both a cached detail and the list', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { cache, api, changes } = setup(t);
  await cache.read('list');
  await cache.read('entry:one');
  t.mock.timers.tick(31000);
  const response = deferred();
  api.getEntry.mock.mockImplementation(() => response.promise);
  await cache.read('entry:one');
  const error = api.createError('Deleted', 'HTTP_ERROR');
  error.status = 404;
  response.reject(error);
  await tick();
  assert.equal(cache.records.size, 0);
  assert.equal(changes.some((change) => change.kind === 'removed'), true);
});

test('storage failures preserve normal reads without writing decrypted data to local storage', async (t) => {
  const { cache, chrome } = setup(t);
  t.mock.method(chrome.storage.session, 'set', async () => { throw new Error('Quota exceeded'); });
  assert.equal((await cache.read('entry:one')).data.password, 'synthetic-secret');
  assert.equal((await cache.read('entry:one')).data.password, 'synthetic-secret');
  assert.deepEqual(chrome.storage.local.data, {});
});

function detailUI(sendMessage) {
  const ids = ['detail-screen', 'detail-domain', 'detail-favicon', 'detail-url', 'detail-username', 'detail-password', 'detail-notes', 'detail-notes-field', 'toggle-password', 'copy-entry-all-btn', 'detail-status', 'detail-retry', 'edit-entry-btn', 'delete-entry-btn', 'back-from-detail'];
  const elements = Object.fromEntries(ids.map((id) => [id, element()]));
  const sections = { renderGeneration: 0 };
  const subject = loadClassic('extension/popup/components/entry-detail.js', 'EntryDetail', {
    document: { getElementById: (id) => elements[id] },
    window: { VaultSections: sections, addEventListener() {} },
    YurrrSiteScope: { label: (entry) => entry.website_domain },
    EntryList: { entries: [entry()], hide() {} },
    Date,
    sendMessage, isSessionLostError: (err) => err.code === 'SESSION_LOST',
    setTimeout: () => 1, clearTimeout() {},
  });
  subject.init();
  subject.loadDetailFavicon = () => {};
  subject.startResumeTimer = () => {};
  subject.clearResumeState = () => {};
  return { subject, elements, sections };
}

test('detail opens before the server response, keeps secrets disabled, and ignores a response after navigation', async () => {
  const response = deferred();
  const { subject, elements } = detailUI(() => response.promise);
  elements['detail-screen'].classList.add('hidden');
  const opening = subject.show('one');
  assert.equal(elements['detail-screen'].classList.contains('hidden'), false);
  assert.equal(elements['detail-username'].textContent, 'alice');
  assert.equal(elements['toggle-password'].disabled, true);
  subject.hide();
  response.resolve({ data: entry(), expiresAt: Date.now() + 300000 });
  assert.equal(await opening, false);
  assert.equal(subject.currentEntry, null);
  assert.equal(elements['detail-notes'].textContent, '');
});

test('an expired open detail masks and discards secrets before allowing reveal or edit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let requests = 0;
  const { subject, elements } = detailUI(async () => { requests++; return { data: entry(), expiresAt: 1000100 }; });
  await subject.show('one');
  assert.equal(elements['toggle-password'].disabled, false);
  t.mock.timers.tick(101);
  assert.equal(await subject.getActionEntry(), null);
  assert.equal(subject.currentEntry, null);
  assert.equal(elements['detail-notes'].textContent, '');
  assert.equal(elements['edit-entry-btn'].disabled, true);
  assert.equal(requests, 1);
});

test('an invalidation arriving during a password action cannot restore the old detail', async () => {
  const response = deferred();
  let calls = 0;
  const { subject } = detailUI(() => ++calls === 1
    ? Promise.resolve({ data: entry(), expiresAt: Date.now() + 300000 })
    : response.promise);
  await subject.show('one');
  const action = subject.getActionEntry();
  subject.invalidate();
  response.resolve({ data: entry(), expiresAt: Date.now() + 300000 });
  assert.equal(await action, null);
  assert.equal(subject.currentEntry, null);
});

test('returning to the list renders cached rows immediately and preserves the filter through background updates', async () => {
  const response = deferred();
  const sections = { renderGeneration: 0, activeTab: 'passwords' };
  const subject = loadClassic('extension/popup/components/entry-list.js', 'EntryList', {
    window: { VaultSections: sections }, sendMessage: () => response.promise,
    setTimeout: () => 1, clearTimeout() {}, Date,
  });
  Object.assign(subject, { screen: element(), listEl: element(), searchInput: element('alice'), entries: [entry()], expiresAt: Date.now() + 300000 });
  let rendered;
  subject.filterEntries = () => { rendered = subject.entries; };
  subject.focusSearchInput = () => {};
  subject.renderLoadingState = () => { throw new Error('Cached list must not show a skeleton'); };
  const opening = subject.show({ preserveSearch: true });
  assert.equal(rendered[0].username, 'alice');
  assert.equal(subject.searchInput.value, 'alice');
  response.resolve({ data: [{ ...entry(), username: 'alice-new' }], expiresAt: Date.now() + 300000 });
  await opening;
  assert.equal(rendered[0].username, 'alice-new');
  assert.equal(subject.searchInput.value, 'alice');
});

test('a background list response cannot replace a different selected section', async () => {
  const response = deferred();
  const sections = { renderGeneration: 0, activeTab: 'passwords' };
  const subject = loadClassic('extension/popup/components/entry-list.js', 'EntryList', {
    window: { VaultSections: sections }, sendMessage: () => response.promise,
  });
  subject.applySnapshot = () => { throw new Error('Old response rendered after navigation'); };
  const refreshing = subject.refresh();
  sections.activeTab = 'cards';
  sections.renderGeneration++;
  response.resolve({ data: [entry()], expiresAt: Date.now() + 300000 });
  await refreshing;
});

test('CRUD, CSV import and master-password change messages invalidate popup secrets', async (t) => {
  for (const [type, method, payload] of [
    ['CREATE_ENTRY', 'createEntry', entry()],
    ['UPDATE_ENTRY', 'updateEntry', { id: 'one', data: { password: 'changed' } }],
    ['DELETE_ENTRY', 'deleteEntry', { id: 'one' }],
    ['BULK_IMPORT', 'bulkImport', { entries: [entry()] }],
    ['CHANGE_PASSWORD', 'changePassword', { currentPassword: 'synthetic-old', newPassword: 'synthetic-new' }],
  ]) {
    const chrome = chromeMock({}, { yurrr_token: 'session-one', yurrr_token_server_url: 'https://localhost:8443' });
    globalThis.chrome = chrome;
    const worker = loadClassic('extension/background/service-worker.js', '({ ready: startupReady, handleMessage, api, session })', {
      ...constants, VaultAPI, SessionManager, chrome,
    });
    await worker.ready;
    t.mock.method(worker.api, 'getEntry', async () => entry());
    t.mock.method(worker.api, method, async () => ({}));
    await worker.session.popupCache.read('entry:one');
    await worker.handleMessage({ type, payload }, { id: chrome.runtime.id });
    assert.equal(worker.session.popupCache.records.size, 0, type);
    assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined, type);
  }
});

test('queued mutations cannot run against a different login', async (t) => {
  const { session } = setup(t);
  const first = deferred();
  const mutation = session.mutateEntries(() => first.promise);
  await tick();
  let secondRan = false;
  const queued = session.mutateEntries(async () => { secondRan = true; });
  const rejected = assert.rejects(queued, { code: 'SESSION_CHANGED' });
  await session.forceLocalLock();
  await session.saveToken('second-session');
  first.resolve();
  await mutation;
  await rejected;
  assert.equal(secondRan, false);
});

test('startup can restore a still-valid detail when the list has expired and the server is offline', async (t) => {
  const chrome = chromeMock({}, {
    yurrr_token: 'session-one', yurrr_token_server_url: 'https://localhost:8443',
    yurrr_detail_resume_state: { entryId: 'one', expiresAt: Date.now() + 300000 },
  });
  globalThis.chrome = chrome;
  const worker = loadClassic('extension/background/service-worker.js', '({ ready: startupReady, handleMessage, api, session })', {
    ...constants, VaultAPI, SessionManager, chrome,
  });
  await worker.ready;
  t.mock.method(worker.api, 'getEntry', async () => entry());
  t.mock.method(worker.api, 'listEntries', async () => { throw worker.api.createError('Offline', 'NETWORK_ERROR'); });
  await worker.session.popupCache.read('entry:one');
  const result = await worker.handleMessage({ type: 'POPUP_BOOTSTRAP' }, { id: chrome.runtime.id });
  assert.equal(result.unlocked, true);
  assert.equal(result.snapshot, null);
  await tick();
  assert.equal(worker.api.getEntry.mock.callCount(), 1);
});

test('token replacement immediately invalidates cached secrets through the storage listener', async (t) => {
  const chrome = chromeMock({}, { yurrr_token: 'session-one', yurrr_token_server_url: 'https://localhost:8443' });
  globalThis.chrome = chrome;
  const worker = loadClassic('extension/background/service-worker.js', '({ ready: startupReady, api, session })', {
    ...constants, VaultAPI, SessionManager, chrome,
  });
  await worker.ready;
  t.mock.method(worker.api, 'getEntry', async () => entry());
  await worker.session.popupCache.read('entry:one');
  chrome.storage.session.data.yurrr_token = 'session-two';
  for (const listener of chrome.listeners) listener({ yurrr_token: { oldValue: 'session-one', newValue: 'session-two' } }, 'session');
  await tick();
  assert.equal(worker.session.popupCache.records.size, 0);
  assert.equal(chrome.storage.session.data.yurrr_popup_cache, undefined);
});

test('a cancelled startup detail restore does not redirect subsequent user navigation to the list', async () => {
  const { subject, sections } = detailUI(() => {});
  const response = deferred();
  subject.getResumeStore = () => ({ get: async () => ({ yurrr_detail_resume_state: { entryId: 'one', expiresAt: Date.now() + 300000 } }) });
  subject.show = () => { sections.renderGeneration++; return response.promise; };
  const restoring = subject.tryRestore();
  await tick();
  sections.renderGeneration++; // User navigates away while the detail is loading.
  response.resolve(false);
  assert.equal(await restoring, true);
});

test('an expired edit form clears its fields instead of revealing or submitting the cached password', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  let submissions = 0;
  const subject = loadClassic('extension/popup/components/entry-form.js', 'EntryForm', {
    window: {}, Date, setTimeout: () => 1, clearTimeout() {},
    EntryDetail: { hide() {}, show() {} }, EntryList: { show() {} },
    PasswordGenerator: { updateStrength() {} }, sendMessage: () => { submissions++; },
  });
  for (const key of ['screen', 'titleEl', 'urlInput', 'usernameInput', 'passwordInput', 'notesInput', 'togglePwBtn', 'saveBtn']) subject[key] = element();
  subject.form = { reportValidity: () => true };
  subject.showEdit(entry(), 1000100);
  t.mock.timers.tick(101);
  await subject.handleSave();
  assert.equal(submissions, 0);
  assert.equal(subject.passwordInput.value, '');
  assert.equal(subject.notesInput.value, '');
  assert.equal(subject.screen.classList.contains('hidden'), true);
});

test('a late detail 404 cannot discard a refreshed list that already excludes the deleted entry', async (t) => {
  const { cache, api } = setup(t);
  const response = deferred();
  api.getEntry.mock.mockImplementation(() => response.promise);
  const reading = cache.read('entry:one');
  const rejected = assert.rejects(reading, { status: 404 });
  await tick();
  api.listEntries.mock.mockImplementation(async () => [entry('two')]);
  await cache.read('list');
  const error = api.createError('Deleted', 'HTTP_ERROR');
  error.status = 404;
  response.reject(error);
  await rejected;
  assert.equal((await cache.read('list')).data[0].id, 'two');
  assert.equal(api.listEntries.mock.callCount(), 1);
});
