import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/update-server.sh', import.meta.url));
function run(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yurrr-updater-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['.git', 'server', 'bin']) mkdirSync(join(root, name));
  writeFileSync(join(root, 'server/vault.db'), 'synthetic database');
  const commands = {
    git: 'exit 0',
    cargo: 'exit "${BUILD_FAIL:-0}"',
    sudo: 'exec "$@"',
    systemctl: `printf '%s\\n' "$*" >> "$TRACE"
case "$1" in
  is-active) exit "${'${INACTIVE:-0}'}";;
  daemon-reload) exit "${'${RELOAD_FAIL:-0}'}";;
  start) exit "${'${START_FAIL:-0}'}";;
esac`,
    cp: 'if [[ "${BACKUP_FAIL:-0}" == 1 ]]; then exit 1; fi\nexec /usr/bin/cp "$@"',
  };
  for (const [name, body] of Object.entries(commands)) writeFileSync(join(root, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const trace = join(root, 'trace');
  writeFileSync(trace, '');
  const result = spawnSync('/bin/bash', [script], {
    env: { ...process.env, PATH: `${join(root, 'bin')}:/usr/bin:/bin`, YURRR_REPO_DIR: root,
      YURRR_SERVER_DIR: join(root, 'server'), YURRR_BACKUP_DIR: join(root, 'backups'),
      YURRR_SERVICE_NAME: 'synthetic-test-service', YURRR_SKIP_BACKUP: '0', TRACE: trace, ...overrides },
    encoding: 'utf8',
  });
  return { ...result, calls: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean) };
}

test('a failed backup restarts a previously active service and keeps the failing exit code', (t) => {
  const result = run(t, { BACKUP_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ['is-active --quiet synthetic-test-service', 'stop synthetic-test-service', 'start synthetic-test-service']);
});
test('a failed build never stops the service', (t) => {
  const result = run(t, { BUILD_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, []);
});
test('a failed backup does not start a service that was already inactive', (t) => {
  const result = run(t, { INACTIVE: '1', BACKUP_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.calls.some((call) => call.startsWith('start ')), false);
});
test('daemon reload failures also recover service availability', (t) => {
  const result = run(t, { RELOAD_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.calls.at(-1), 'start synthetic-test-service');
});
test('a failed recovery reports the manual start command', (t) => {
  const result = run(t, { BACKUP_FAIL: '1', START_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recovery failed.*sudo systemctl start synthetic-test-service/);
});
test('a successful update starts the service exactly once', (t) => {
  const result = run(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((call) => call.startsWith('start ')).length, 1);
});
