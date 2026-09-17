import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadClassic, element } from './helpers.mjs';
import '../extension/lib/site-scope.js';

function field(name, value, { type = 'password', autocomplete = '' } = {}) {
  return {
    ...element(value), name, type, autocomplete, tagName: 'INPUT', labels: [],
    offsetWidth: 100, offsetHeight: 20,
    getAttribute: (key) => key === 'autocomplete' ? autocomplete : '',
    closest(selector) { return selector.includes('form') ? this.form || null : null; },
    matches() { return ['text', 'email', 'tel'].includes(this.type); },
  };
}
function form(...fields) {
  const owner = {
    tagName: 'FORM', elements: fields, isConnected: true, offsetWidth: 200, offsetHeight: 100,
    action: 'https://example.com/login', querySelectorAll: () => [], getAttribute: () => '',
  };
  fields.forEach((input) => { input.form = owner; });
  return owner;
}
function detector(extra = {}) {
  const window = {
    location: { href: 'https://example.com/login' }, getComputedStyle: () => ({}),
    addEventListener() {}, removeEventListener() {},
  };
  const document = { visibilityState: 'visible', querySelectorAll: () => [] };
  const heuristics = loadClassic('extension/content/heuristics.js', 'YurrrHeuristics', { window, document });
  const subject = loadClassic('extension/content/detector.js', 'YurrrDetector', {
    window, document, YurrrHeuristics: heuristics, YurrrSiteScope, crypto: { randomUUID },
    setTimeout: () => 1, clearTimeout() {}, ...extra,
  }, { before: '// Start detection' });
  return { subject, heuristics, window, document };
}

test('password changes recognize snake_case, kebab-case, camelCase and German labels', () => {
  for (const [oldName, newName, confirmName] of [
    ['old_password', 'new_password', 'confirm_password'],
    ['current-password', 'new-password', 'password-confirmation'],
    ['currentPassword', 'newPassword', 'repeatPassword'],
    ['Altes Passwort', 'Neues Passwort', 'Passwort bestätigen'],
  ]) {
    const { subject, heuristics } = detector();
    const old = field(oldName, 'old-secret');
    const next = field(newName, 'new-secret');
    const confirm = field(confirmName, 'new-secret');
    const owner = form(old, next, confirm);
    assert.equal(heuristics.isPasswordChangeForm(owner), true, oldName);
    assert.equal(subject.getSubmitPasswordField(owner, old), next, newName);
    assert.equal(heuristics.isConfirmationPasswordField(confirm), true, confirmName);
  }
});

test('an empty or mismatching new password never falls back to the saved old password', () => {
  const { subject } = detector();
  const old = field('old_password', 'old-secret');
  const next = field('new_password', '');
  const confirm = field('confirm_password', '');
  const owner = form(old, next, confirm);
  assert.equal(subject.getSubmitPasswordField(owner, old), null);
  next.value = 'new-secret';
  confirm.value = 'typo';
  assert.equal(subject.getSubmitPasswordField(owner, old), null);
});

test('revealing a password keeps its role and excludes it from username and address detection', () => {
  const { subject, heuristics } = detector();
  const password = field('password', 'synthetic-secret');
  const owner = form(password);
  assert.equal(heuristics.isPasswordField(password), true);
  password.type = 'text';
  assert.equal(subject.getSubmitPasswordField(owner), password);
  assert.equal(heuristics.isEligibleInput(password), false);
  assert.equal(heuristics.isEligibleAddressField(password), false);
  assert.equal(heuristics.isPasswordField(field('new', 'secret', { type: 'text', autocomplete: 'section-account new-password' })), true);
});

test('submission resolves the current DOM, including controls associated with form=, and snapshots before reset', () => {
  const { subject } = detector();
  const username = field('email', 'alice@example.com', { type: 'email' });
  const password = field('password', 'old-render');
  const owner = form(username, password);
  const replacement = field('password', 'new-render');
  replacement.form = owner;
  owner.elements[1] = replacement;
  let captured;
  subject.handleFormSubmit = (_, user, pw) => { captured = [user.value, pw.value]; };
  subject.captureSubmission({ type: 'submit', isTrusted: true, target: owner });
  replacement.value = '';
  assert.deepEqual(captured, ['alice@example.com', 'new-render']);
});

test('invalid, synthetic and composition submissions are ignored; a native submit is captured once', () => {
  const { subject } = detector();
  const password = field('password', 'test-secret');
  const owner = form(password);
  let calls = 0;
  subject.handleFormSubmit = () => { calls++; };
  subject.captureSubmission({ type: 'submit', isTrusted: false, target: owner });
  subject.captureSubmission({ type: 'keydown', key: 'Enter', isComposing: true, isTrusted: true, target: password });
  password.willValidate = true;
  password.validity = { valid: false };
  subject.captureSubmission({ type: 'submit', isTrusted: true, target: owner });
  assert.equal(calls, 0);
  password.validity.valid = true;
  subject.captureSubmission({ type: 'keydown', key: 'Enter', isTrusted: true, target: password });
  subject.captureSubmission({ type: 'submit', isTrusted: true, target: owner });
  assert.equal(calls, 1);
});

test('JavaScript sign-in buttons capture values, but reveal, cancel and unrelated actions do not', () => {
  const { subject } = detector();
  const username = field('email', 'alice@example.com', { type: 'email' });
  const password = field('password', 'test-secret');
  const owner = form(username, password);
  let captured;
  subject.handleFormSubmit = (_, user, pw) => { captured = [user.value, pw.value]; };
  const button = { tagName: 'BUTTON', type: 'button', form: owner, getAttribute: () => '' };
  for (const label of ['Show password', 'Abbrechen', 'Help', 'Forgot password']) {
    button.textContent = label;
    assert.equal(subject.isCredentialSubmitButton(button), false, label);
  }
  button.textContent = 'Anmelden';
  subject.captureSubmission({ type: 'click', isTrusted: true, target: { closest: (selector) => selector.includes('yurrr') ? null : button } });
  assert.deepEqual(captured, ['alice@example.com', 'test-secret']);
});

test('typed passwords get the same post-submit detection as generated passwords', async () => {
  const { subject } = detector();
  const password = field('password', 'manually-typed-secret');
  const owner = form(password);
  const messages = [];
  let queued;
  subject.sendRuntimeMessage = async (type, payload) => { messages.push({ type, payload }); return { stored: true }; };
  subject.queuePostSubmitSavePrompt = (...args) => { queued = args; };
  await subject.handleFormSubmit(owner, null, password);
  assert.equal(messages[0].payload.password, 'manually-typed-secret');
  assert.equal(queued[1], messages[0].payload.submissionId);
});

test('a stable SPA transition checks the save decision; an unchanged failed login does not prompt', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { subject } = detector({ Date, setTimeout, clearTimeout });
  const password = field('password', 'test-secret');
  const owner = form(password);
  const messages = [];
  subject.sendRuntimeMessage = async (type) => { messages.push(type); return { ready: true }; };
  subject.checkPendingCredentials = () => { messages.push('CHECK_PENDING_CREDENTIALS'); };
  subject.queuePostSubmitSavePrompt('https://example.com/login', 'attempt', owner, password);
  t.mock.timers.tick(1000);
  assert.equal(messages.length, 0);
  owner.isConnected = false;
  password.isConnected = false;
  t.mock.timers.tick(250);
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, ['MARK_PENDING_CREDENTIALS_READY', 'CHECK_PENDING_CREDENTIALS']);
});

test('late autofill cannot fill a field that has become a new-password field', () => {
  const { subject } = detector();
  const password = field('new_password', '');
  form(password);
  assert.equal(subject.canAutofillWithCredential(null, password, { id: 'one' }, { allowMissingUsername: true }), false);
});

test('masked one-time codes and card security codes are never treated as login passwords', () => {
  const { heuristics } = detector();
  for (const autocomplete of ['one-time-code', 'cc-csc', 'cc-number']) {
    assert.equal(heuristics.isPasswordField(field('code', '123456', { autocomplete })), false);
  }
});

test('password reset actions are recognized while form-reset buttons are ignored', () => {
  const { subject } = detector();
  for (const textContent of ['Reset password', 'Change password', 'Passwort zurücksetzen']) {
    assert.equal(subject.isCredentialSubmitButton({ type: 'button', textContent, getAttribute: () => '' }), true);
  }
  assert.equal(subject.isCredentialSubmitButton({ type: 'reset', textContent: 'Reset password' }), false);
});

test('autofill ignores a password node reused as a username field while the credential loads', () => {
  const { subject, heuristics } = detector();
  const password = field('password', '');
  form(password);
  assert.equal(heuristics.isPasswordField(password), true);
  password.type = 'text';
  password.getAttribute = (key) => key === 'autocomplete' ? 'username' : '';
  assert.equal(subject.canAutofillWithCredential(null, password, { id: 'one' }, { allowMissingUsername: true }), false);
});

test('clicking Yurrr Save cannot be mistaken for another website login submission', () => {
  const { subject } = detector();
  subject.handleFormSubmit = () => { throw new Error('Own banner was captured as a login'); };
  subject.captureSubmission({ type: 'click', isTrusted: true, target: { closest: () => ({ id: 'yurrr-save-banner' }) } });
});

test('the generator fills new and confirmation fields without overwriting the current password or readonly fields', () => {
  const { heuristics } = detector();
  const old = field('old_password', 'old-secret');
  const next = field('new_password', '');
  const confirm = field('confirm_password', '');
  const readonly = field('password_copy', 'readonly-value');
  readonly.readOnly = true;
  form(old, next, confirm, readonly);
  for (const input of [old, next, confirm, readonly]) input.dispatchEvent = () => {};
  const inputPrototype = Object.defineProperty({}, 'value', { set(value) { this.value = value; } });
  const subject = loadClassic('extension/content/overlay.js', 'YurrrOverlay', {
    YurrrHeuristics: heuristics, HTMLInputElement: { prototype: inputPrototype }, Event: class {},
  });
  subject.currentTarget = next;
  subject.currentPassword = 'generated-secret';
  subject.usePassword();
  assert.equal(old.value, 'old-secret');
  assert.equal(next.value, 'generated-secret');
  assert.equal(confirm.value, 'generated-secret');
  assert.equal(readonly.value, 'readonly-value');
});

test('pending checks retry twice, report failure, and a newer check cancels an older retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  const { subject } = detector({ Date, setTimeout, clearTimeout });
  let calls = 0;
  let status;
  subject.sendRuntimeMessage = async () => { calls++; throw new Error('offline'); };
  subject.showSaveStatus = (message) => { status = message; };
  await subject.checkPendingCredentials();
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  assert.match(status, /server connection/);
  t.mock.timers.tick(60000);
  assert.equal(calls, 3);
  await subject.checkPendingCredentials();
  subject.sendRuntimeMessage = async () => ({ hasPending: false });
  await subject.checkPendingCredentials();
  t.mock.timers.tick(1000);
  assert.equal(calls, 4);
});

test('a retargeted Shadow DOM submission captures the real form in the composed path', () => {
  const { subject } = detector();
  const password = field('password', 'shadow-secret');
  const owner = form(password);
  let captured;
  subject.handleFormSubmit = (_, user, pw) => { captured = pw.value; };
  subject.captureSubmission({ type: 'submit', isTrusted: true, target: {}, composedPath: () => [owner] });
  assert.equal(captured, 'shadow-secret');
});

test('child frames cannot automatically fill even an otherwise eligible password field', () => {
  const { subject, window } = detector();
  const password = field('password', '');
  form(password);
  window.top = {};
  assert.equal(subject.canAutofillWithCredential(null, password, { id: 'one' }, { allowMissingUsername: true }), false);
});

test('save banner configuration never retains a second password reference', async () => {
  const { subject } = detector();
  subject.sendRuntimeMessage = async () => ({ hasPending: true, credentials: {
    url: 'https://example.com', username: 'alice', password: 'synthetic-secret',
    submissionId: 'attempt', expiresAt: 123, action: 'choose_account', accounts: [],
  } });
  let options;
  subject.showSaveBanner = (_url, _username, password, _domain, config) => {
    assert.equal(password, 'synthetic-secret');
    options = config;
  };
  await subject.checkPendingCredentials();
  assert.equal(Object.hasOwn(options, 'password'), false);
  assert.equal(options.submissionId, 'attempt');
  assert.equal(options.expiresAt, 123);
});
