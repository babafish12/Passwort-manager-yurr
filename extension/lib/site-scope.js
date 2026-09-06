// Shared by extension pages, the service worker, and content scripts.
globalThis.YurrrSiteScope = Object.freeze({
  parse(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    if (raw.includes('://') && !raw.split('://')[1]?.match(/^[^/]/)) return null;
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  },

  isLocalHost(value) {
    const host = String(value || '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
    if (host.includes(':')) {
      const mapped = host.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
      if (mapped) {
        const high = Number.parseInt(mapped[1], 16);
        const low = Number.parseInt(mapped[2], 16);
        return this.isLocalHost([high >> 8, high & 255, low >> 8, low & 255].join('.'));
      }
      const first = Number.parseInt(host.split(':')[0], 16);
      return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
    }
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  },

  key(value) {
    const url = this.parse(value);
    if (!url) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return this.isLocalHost(host) ? `${host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}` : host;
  },

  label(entry) {
    return this.key(entry?.website_url) || String(entry?.website_domain || '');
  },
});
