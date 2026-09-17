// Share a small network budget across list renders and the detail view.
const FaviconLoader = {
  active: 0,
  queue: [],
  serverRequests: new Map(),

  load(entry, isCurrent) {
    return new Promise((resolve) => {
      this.queue.push({ entry, isCurrent, resolve });
      this.drain();
    });
  },

  drain() {
    while (this.active < 4 && this.queue.length) {
      const job = this.queue.shift();
      if (!job.isCurrent()) { job.resolve(null); continue; }
      this.active += 1;
      this.find(job.entry, job.isCurrent).catch(() => null).then(job.resolve).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  },

  async find(entry, isCurrent) {
    const url = entry.website_url || '';
    const domain = entry.website_domain || '';
    const server = async () => {
      if (!domain) return null;
      if (!this.serverRequests.has(domain)) {
        this.serverRequests.set(domain, sendMessage('GET_FAVICON', { domain }).catch(() => null));
      }
      const result = await this.serverRequests.get(domain);
      return window.isSafeFaviconDataUrl(result?.dataUrl)
        ? window.loadPopupFaviconImage(result.dataUrl) : null;
    };
    const browser = window.getBrowserFaviconUrl(url, domain);
    const sources = [
      () => browser ? window.loadPopupFaviconImage(browser) : null,
      ...(entry.has_favicon ? [server] : []),
      () => window.loadDiscoveredFaviconImage(url, domain, isCurrent),
      ...(!entry.has_favicon ? [server] : []),
    ];
    for (const source of sources) {
      if (!isCurrent() || !(await window.areFaviconsEnabled())) return null;
      try {
        const image = await source();
        if (image) return isCurrent() && await window.areFaviconsEnabled() ? image : null;
      } catch { /* Try the next source. */ }
    }
    return null;
  },
};
