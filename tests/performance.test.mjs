import test from 'node:test';
import assert from 'node:assert/strict';
import { VaultAPI } from '../extension/background/api.js';
import { SessionManager } from '../extension/background/session.js';
import { chromeMock, loadClassic } from './helpers.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
function setup() {
  globalThis.chrome = chromeMock();
  const api = new VaultAPI();
  api.serverUrl = 'https://localhost:8443';
  api.setToken('synthetic-session', api.serverUrl);
  const session = new SessionManager(api);
  return { api, session, chrome: globalThis.chrome };
}

test('20 concurrent metadata reads share one request and never cache passwords or notes', async () => {
  const { api, session, chrome } = setup();
  let calls = 0;
  api.listEntries = async () => { calls++; return [{ id: 'one', username: 'alice', password: 'secret', notes: 'private' }]; };
  const results = await Promise.all(Array.from({ length: 20 }, () => session.getCredentialsForDomain('EXAMPLE.com')));
  assert.equal(calls, 1);
  assert.equal(results[0][0].password, undefined);
  assert.equal(results[0][0].notes, undefined);
  await session.getCredentialsForDomain('example.com');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(chrome.storage.session.data).includes('private'), false);
});

test('concurrent domains merge their cache writes; restart reuses only the same server and token', async () => {
  const { api, session, chrome } = setup();
  let calls = 0;
  api.listEntries = async (domain) => { calls++; return [{ id: domain }]; };
  await Promise.all(['one.test', 'two.test'].map((domain) => session.getCredentialsForDomain(domain)));
  assert.equal(Object.keys(chrome.storage.session.data.yurrr_credential_metadata_cache).length, 2);
  const restarted = new SessionManager(api);
  await restarted.getCredentialsForDomain('one.test');
  assert.equal(calls, 2);
  api.setToken('another-session', api.serverUrl);
  await restarted.getCredentialsForDomain('one.test');
  assert.equal(calls, 3);
});

test('invalidating a pending metadata read rejects it and permits a fresh request', async () => {
  const { api, session, chrome } = setup();
  const response = deferred();
  api.listEntries = () => response.promise;
  const old = session.getCredentialsForDomain('example.com');
  const rejected = assert.rejects(old, { code: 'SESSION_CHANGED' });
  await tick();
  await session.clearCredentialMetadataCache();
  response.resolve([{ id: 'stale' }]);
  await rejected;
  assert.equal(chrome.storage.session.data.yurrr_credential_metadata_cache, undefined);
  api.listEntries = async () => [{ id: 'fresh' }];
  assert.equal((await session.getCredentialsForDomain('example.com'))[0].id, 'fresh');
});

test('locking during a metadata storage write removes the late write', async () => {
  const { api, session, chrome } = setup();
  const started = deferred();
  const release = deferred();
  const set = chrome.storage.session.set.bind(chrome.storage.session);
  chrome.storage.session.set = async (value) => { started.resolve(); await release.promise; await set(value); };
  api.listEntries = async () => [{ id: 'one' }];
  const read = session.getCredentialsForDomain('example.com');
  const rejected = assert.rejects(read, { code: 'SESSION_CHANGED' });
  await started.promise;
  const clear = session.clearCredentialMetadataCache();
  release.resolve();
  await Promise.all([clear, rejected]);
  assert.equal(chrome.storage.session.data.yurrr_credential_metadata_cache, undefined);
});

test('failed metadata reads are retryable and the cache has a five-minute limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const { api, session } = setup();
  let calls = 0;
  api.listEntries = async () => { calls++; if (calls === 1) throw new Error('offline'); return [{ id: 'one' }]; };
  await assert.rejects(session.getCredentialsForDomain('example.com'), /offline/);
  await session.getCredentialsForDomain('example.com');
  t.mock.timers.tick(300000);
  await session.getCredentialsForDomain('example.com');
  assert.equal(calls, 3);
});

function favicons(overrides = {}) {
  return loadClassic('extension/popup/favicon-loader.js', 'FaviconLoader', {
    window: {
      areFaviconsEnabled: async () => true,
      getBrowserFaviconUrl: () => 'browser-icon',
      loadPopupFaviconImage: async () => ({ image: true }),
      loadDiscoveredFaviconImage: async () => { throw new Error('Unexpected discovery'); },
      ...overrides,
    },
    sendMessage: async () => { throw new Error('Unexpected server request'); },
  });
}

test('a successful browser favicon stops all fallback discovery', async () => {
  let discoveries = 0;
  const loader = favicons({ loadDiscoveredFaviconImage: async () => { discoveries++; return {}; } });
  await Promise.all(Array.from({ length: 100 }, () => loader.load({ website_domain: 'example.com' }, () => true)));
  assert.equal(discoveries, 0);
});

test('favicon loading allows four active jobs and drops queued work after navigation', async () => {
  const response = deferred();
  let calls = 0;
  let current = true;
  const loader = favicons({ loadPopupFaviconImage: () => { calls++; return response.promise; } });
  const jobs = Array.from({ length: 100 }, () => loader.load({}, () => current));
  await tick();
  assert.equal(calls, 4);
  current = false;
  response.resolve({ image: true });
  assert.equal((await Promise.all(jobs)).every((image) => image === null), true);
  assert.equal(calls, 4);
});

test('favicon discovery remains available after a browser-cache miss', async () => {
  const loader = favicons({
    loadPopupFaviconImage: async () => { throw new Error('missing'); },
    loadDiscoveredFaviconImage: async () => ({ source: 'discovery' }),
  });
  assert.equal((await loader.load({}, () => true)).source, 'discovery');
});
