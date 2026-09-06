import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function loadClassic(path, expression, globals = {}, { before } = {}) {
  let source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  if (before) source = source.slice(0, source.indexOf(before));
  source = source.replace(/^import[\s\S]*?;\n/gm, '');
  const context = vm.createContext({ URL, AbortSignal, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console, ...globals });
  return vm.runInContext(`${source}\n;${expression}`, context, { filename: path });
}

export function chromeMock(initialLocal = {}, initialSession = {}) {
  const listeners = [];
  const area = (initial, name) => {
    const data = { ...initial };
    return {
      data,
      async get(keys, callback) {
        const result = Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, data[key]]));
        callback?.(result);
        return result;
      },
      async set(values) { Object.assign(data, values); },
      async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
      async setAccessLevel() {},
    };
  };
  return {
    storage: { local: area(initialLocal, 'local'), session: area(initialSession, 'session'), onChanged: { addListener(fn) { listeners.push(fn); } } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    alarms: { clear: async () => true, create() {}, onAlarm: { addListener() {} } },
    idle: { setDetectionInterval() {}, onStateChanged: { addListener() {} } },
    runtime: { id: 'test-extension', getURL: (path) => `chrome-extension://test-extension/${path}`, onMessage: { addListener() {} } },
    listeners,
  };
}

export function element(value = '') {
  const classes = new Set();
  const attributes = new Map();
  return {
    value, disabled: false, dataset: {}, textContent: '', innerHTML: '', isConnected: true,
    classList: { add: (...names) => names.forEach((name) => classes.add(name)), remove: (...names) => names.forEach((name) => classes.delete(name)), contains: (name) => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
    setAttribute: (name, value) => attributes.set(name, value), getAttribute: (name) => attributes.get(name) || '',
    addEventListener() {}, removeEventListener() {}, focus() {}, replaceChildren() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}
