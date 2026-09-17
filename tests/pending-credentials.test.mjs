import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultAPI } from '../extension/background/api.js';
import { SessionManager } from '../extension/background/session.js';
import * as constants from '../extension/lib/constants.js';
import '../extension/lib/site-scope.js';
import { loadClassic, chromeMock } from './helpers.mjs';

const sender = (tabId = 1, frameId = 0, url = 'https://example.com/login') => ({
  id: 'test-extension', tab: { id: tabId }, frameId, url,
});
const payload = (submissionId = 'attempt-one', username = 'alice') => ({
  url: 'https://example.com/login', pageUrl: 'https://example.com/login',
  username, password: 'synthetic-new-secret', submissionId,
});
async function worker(chrome = chromeMock({}, {
  yurrr_token: 'test-session', yurrr_token_server_url: 'https://localhost:8443',
})) {
  globalThis.chrome = chrome;
  const subject = loadClassic('extension/background/service-worker.js', '({ ready: startupReady, handleMessage, api, session, getPendingCredentials })', {
    ...constants, VaultAPI, SessionManager, YurrrSiteScope, chrome, Date,
  });
  await subject.ready;
  subject.api.listEntries = async () => [];
  subject.api.createEntry = async () => ({});
  subject.send = (type, data, from = sender()) => subject.handleMessage({ type, payload: data }, from);
  return { ...subject, chrome };
}
async function ready(subject, id = 'attempt-one', from = sender()) {
  return subject.send('MARK_PENDING_CREDENTIALS_READY', { submissionId: id }, from);
}

test('concurrent tabs and frames keep independent pending saves and can save one without clearing the others', async () => {
  const subject = await worker();
  const from = [sender(1), sender(2), sender(1, 2)];
  await Promise.all(from.map((source, index) => subject.send('PENDING_CREDENTIALS', payload(`attempt-${index}`), source)));
  for (const [index, source] of from.entries()) {
    await ready(subject, `attempt-${index}`, source);
    const result = await subject.send('CHECK_PENDING_CREDENTIALS', {}, source);
    assert.equal(result.credentials.submissionId, `attempt-${index}`);
  }
  const result = await subject.send('FORM_SUBMITTED', payload('attempt-0'), from[0]);
  assert.equal(result.saved, true);
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {}, from[0])).hasPending, false);
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {}, from[1])).hasPending, true);
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {}, from[2])).hasPending, true);
});

test('pending saves survive worker restart, stay in session memory, and expire without extending the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const initial = await worker();
  await initial.send('PENDING_CREDENTIALS', payload());
  await ready(initial);
  const restarted = await worker(initial.chrome);
  t.mock.timers.tick(40000);
  assert.equal((await restarted.send('CHECK_PENDING_CREDENTIALS', {})).credentials.password, 'synthetic-new-secret');
  assert.equal(initial.chrome.storage.local.data.yurrr_pending_credentials, undefined);
  t.mock.timers.tick(260000);
  assert.equal((await restarted.send('CHECK_PENDING_CREDENTIALS', {})).hasPending, false);
  assert.equal(initial.chrome.storage.session.data.yurrr_pending_credentials, undefined);
});

test('stale navigation markers and dismissals cannot replace or clear a newer submission', async () => {
  const subject = await worker();
  await subject.send('PENDING_CREDENTIALS', payload('old'));
  await subject.send('PENDING_CREDENTIALS', payload('new'));
  assert.equal((await ready(subject, 'old')).ready, false);
  await subject.send('CLEAR_PENDING_CREDENTIALS', { submissionId: 'old' });
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).hasPending, false);
  await ready(subject, 'new');
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).credentials.submissionId, 'new');
});

test('pending usernames for multi-step logins cannot leak from another tab or frame', async () => {
  const subject = await worker();
  await Promise.all([
    subject.send('PENDING_USERNAME', { username: 'alice' }, sender(1)),
    subject.send('PENDING_USERNAME', { username: 'bob' }, sender(2)),
  ]);
  await subject.send('PENDING_CREDENTIALS', payload('first', ''), sender(1));
  await ready(subject, 'first', sender(1));
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {}, sender(1))).credentials.username, 'alice');
  assert.equal((await subject.send('GET_PENDING_USERNAME', {}, sender(2))).username, 'bob');
  assert.equal((await subject.send('GET_PENDING_USERNAME', {}, sender(1, 2))).username, '');
});

test('same-page submissions wait for a transition, and unchanged saved passwords suppress the banner', async () => {
  const subject = await worker();
  await subject.send('PENDING_CREDENTIALS', payload());
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).hasPending, false);
  await ready(subject);
  const entry = { id: 'one', username: 'alice', website_url: 'https://example.com', password: payload().password };
  subject.api.listEntries = async () => [entry];
  subject.api.getEntry = async () => entry;
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).reason, 'unchanged');
});

test('password changes offer an update and change only the selected password after confirmation', async () => {
  const subject = await worker();
  const entry = { id: 'one', username: 'alice', website_url: 'https://example.com', password: 'synthetic-old-secret' };
  subject.api.listEntries = async () => [entry];
  subject.api.getEntry = async () => entry;
  let update;
  subject.api.updateEntry = async (...args) => { update = args; };
  await subject.send('PENDING_CREDENTIALS', { ...payload(), isPasswordChange: true });
  await ready(subject);
  const result = await subject.send('CHECK_PENDING_CREDENTIALS', {});
  assert.equal(result.credentials.action, 'update');
  assert.equal(update, undefined);
  assert.equal((await subject.send('FORM_SUBMITTED', { ...payload(), confirmUpdate: true, entryId: result.credentials.entryId })).updated, true);
  assert.equal(update[0], 'one');
  assert.deepEqual(Object.keys(update[1]), ['password']);
});

test('save submission requires its matching ID and page origin even if the password happens to match', async () => {
  const subject = await worker();
  await subject.send('PENDING_CREDENTIALS', payload());
  const wrongAttempt = await subject.send('FORM_SUBMITTED', payload('other-attempt'));
  assert.equal(wrongAttempt.reason, 'missing_pending_credential');
  const otherOrigin = await subject.send('FORM_SUBMITTED', payload(), sender(1, 0, 'https://attacker.example/login'));
  assert.equal(otherOrigin.reason, 'missing_pending_credential');
});

test('lock clears a pending write already in flight, and another login cannot reuse it', async (t) => {
  const subject = await worker();
  let started;
  let release;
  const waiting = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { release = resolve; });
  const set = subject.chrome.storage.session.set.bind(subject.chrome.storage.session);
  t.mock.method(subject.chrome.storage.session, 'set', async (data) => {
    if (data.yurrr_pending_credentials) { started(); await blocked; }
    await set(data);
  });
  const saving = subject.send('PENDING_CREDENTIALS', payload());
  await waiting;
  const locking = subject.session.forceLocalLock();
  release();
  await Promise.all([saving, locking]);
  assert.equal(subject.chrome.storage.session.data.yurrr_pending_credentials, undefined);
  await subject.session.saveToken('another-session');
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).hasPending, false);
});

test('a delayed save decision cannot display or discard a newer submission', async () => {
  const subject = await worker();
  await subject.send('PENDING_CREDENTIALS', payload('old'));
  await ready(subject, 'old');
  let respond;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  subject.api.listEntries = () => new Promise((resolve) => { respond = resolve; started(); });
  const check = subject.send('CHECK_PENDING_CREDENTIALS', {});
  await waiting;
  await subject.send('PENDING_CREDENTIALS', payload('new'));
  respond([]);
  assert.equal((await check).hasPending, false);
  assert.equal((await subject.getPendingCredentials('example.com', sender())).submissionId, 'new');
});

test('an immediate navigation marker and next-page check wait for the pending credential write', async () => {
  const subject = await worker();
  const storing = subject.send('PENDING_CREDENTIALS', payload('navigation', ''));
  const marking = ready(subject, 'navigation');
  const checking = subject.send('CHECK_PENDING_CREDENTIALS', {});
  assert.equal((await storing).stored, true);
  assert.equal((await marking).ready, true);
  // The password-only fixture has no known username, but must reach a save decision.
  assert.equal((await checking).reason, 'missing_username');
});

test('closing a tab clears only its pending saves and remembered usernames', async () => {
  const chrome = chromeMock({}, { yurrr_token: 'test-session', yurrr_token_server_url: 'https://localhost:8443' });
  let removeTab;
  chrome.tabs.onRemoved.addListener = (listener) => { removeTab = listener; };
  const subject = await worker(chrome);
  for (const tabId of [1, 2]) {
    await subject.send('PENDING_USERNAME', { username: `user-${tabId}` }, sender(tabId));
    await subject.send('PENDING_CREDENTIALS', payload(`attempt-${tabId}`), sender(tabId));
    await ready(subject, `attempt-${tabId}`, sender(tabId));
  }
  await removeTab(1);
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {}, sender(1))).hasPending, false);
  assert.equal((await subject.send('GET_PENDING_USERNAME', {}, sender(1))).username, '');
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {}, sender(2))).hasPending, true);
  assert.equal((await subject.send('GET_PENDING_USERNAME', {}, sender(2))).username, 'user-2');
});

test('case-sensitive account names prefer the exact login and ambiguous case variants never overwrite an arbitrary account', async () => {
  const subject = await worker();
  const entries = ['alice', 'Alice'].map((username) => ({ id: username, username, website_url: 'https://example.com', password: 'old-secret' }));
  subject.api.listEntries = async () => entries;
  subject.api.getEntry = async (id) => entries.find((entry) => entry.id === id);
  await subject.send('PENDING_CREDENTIALS', payload('exact', 'Alice'));
  await ready(subject, 'exact');
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).credentials.entryId, 'Alice');
  await subject.send('PENDING_CREDENTIALS', payload('ambiguous', 'ALICE'));
  await ready(subject, 'ambiguous');
  const saving = await subject.send('FORM_SUBMITTED', payload('ambiguous', 'ALICE'));
  assert.equal(saving.saved, false);
  assert.equal(saving.reason, 'ambiguous_username');
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', {})).reason, 'ambiguous_username');
});

test('manual review works without a transition and still requires a separate confirmed save', async () => {
  const subject = await worker();
  let saves = 0;
  subject.api.createEntry = async () => { saves++; };
  await subject.send('PENDING_CREDENTIALS', payload());
  const automatic = await subject.send('CHECK_PENDING_CREDENTIALS', {});
  assert.equal(automatic.hasPending, false);
  assert.equal(automatic.available, true);
  assert.equal(automatic.credentials, undefined);
  const manual = await subject.send('CHECK_PENDING_CREDENTIALS', { manual: true, submissionId: 'attempt-one' });
  assert.equal(manual.hasPending, true);
  assert.equal(saves, 0);
  assert.equal((await subject.send('CHECK_PENDING_CREDENTIALS', { manual: true, submissionId: 'old-attempt' })).hasPending, false);
  assert.equal((await subject.send('FORM_SUBMITTED', payload())).saved, true);
  assert.equal(saves, 1);
});

test('missing or ambiguous usernames retain pending credentials and offer only accounts from this site', async () => {
  const subject = await worker();
  const entries = ['alice', 'bob'].map((username) => ({ id: username, username, website_url: 'https://example.com' }));
  subject.api.listEntries = async () => [...entries, { id: 'foreign', username: 'other', website_url: 'https://other.test' }];
  subject.api.getEntry = async (id) => ({ ...entries.find((entry) => entry.id === id), password: 'old' });
  let update;
  subject.api.updateEntry = async (...args) => { update = args; };
  await subject.send('PENDING_CREDENTIALS', payload('missing', ''));
  const result = await subject.send('CHECK_PENDING_CREDENTIALS', { manual: true });
  assert.equal(result.credentials.action, 'choose_account');
  assert.deepEqual(Array.from(result.credentials.accounts, (item) => item.id), ['alice', 'bob']);
  assert.equal((await subject.getPendingCredentials('example.com', sender())).submissionId, 'missing');
  const rejected = await subject.send('FORM_SUBMITTED', { ...payload('missing', ''), entryId: 'foreign', confirmUpdate: true });
  assert.equal(rejected.reason, 'entry_not_found');
  assert.equal(update, undefined);
  const saved = await subject.send('FORM_SUBMITTED', { ...payload('missing', ''), entryId: 'bob', confirmUpdate: true });
  assert.equal(saved.updated, true);
  assert.equal(update[0], 'bob');
});

test('a missing username can be supplied during review to create a new login', async () => {
  const subject = await worker();
  let created;
  subject.api.createEntry = async (value) => { created = value; };
  await subject.send('PENDING_CREDENTIALS', payload('missing', ''));
  const result = await subject.send('CHECK_PENDING_CREDENTIALS', { manual: true });
  assert.equal(result.credentials.action, 'choose_account');
  assert.equal((await subject.send('FORM_SUBMITTED', payload('missing', 'new-user'))).saved, true);
  assert.equal(created.username, 'new-user');
});

test('network failures retain the pending save and locking reports why capture was refused', async () => {
  const subject = await worker();
  await subject.send('PENDING_CREDENTIALS', payload());
  subject.api.listEntries = async () => { throw new Error('offline'); };
  await assert.rejects(subject.send('CHECK_PENDING_CREDENTIALS', { manual: true }), /offline/);
  assert.equal((await subject.getPendingCredentials('example.com', sender())).submissionId, 'attempt-one');
  await subject.session.forceLocalLock();
  assert.equal((await subject.send('PENDING_CREDENTIALS', payload())).reason, 'locked');
});

test('automatic credential requests from child frames and inactive tabs are denied before reading a secret', async () => {
  const subject = await worker();
  subject.api.getEntry = () => { throw new Error('Must not read a secret'); };
  for (const source of [sender(1, 2), { ...sender(), tab: { id: 1, active: false } }]) {
    const result = await subject.send('GET_CREDENTIAL_FOR_AUTOFILL', { id: 'one' }, source);
    assert.equal(result.credential, null);
  }
});
