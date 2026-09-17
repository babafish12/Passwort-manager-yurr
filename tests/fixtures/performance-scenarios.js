async (page) => {
  const origin = 'http://127.0.0.1:8769';
  const results = {};
  await page.goto(`${origin}/tests/fixtures/forms.html?scenario=spa`);
  results.detector = await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await frame();
    let scans = 0;
    const scan = YurrrDetector.scanForms.bind(YurrrDetector);
    YurrrDetector.scanForms = (options) => { scans++; return scan(options); };
    const text = document.createElement('span');
    document.getElementById('result').append(text);
    for (let i = 0; i < 20; i++) { text.textContent = String(i); await frame(); }
    const textScans = scans;
    if (textScans !== 0) throw new Error(`Irrelevant text caused ${textScans} scans`);
    const form = document.querySelector('form');
    const password = form.querySelector('input[type="password"]');
    const replacement = password.cloneNode(true);
    password.replaceWith(replacement);
    await frame();
    if (replacement.dataset.yurrrPickerAttached !== '1') throw new Error('Replacement field was not scanned');
    const fieldScans = scans - textScans;
    if (fieldScans !== 1) throw new Error(`Replacement required ${fieldScans} scans`);
    return { unrelatedTextUpdates: 20, textScans, replacementScans: fieldScans };
  });

  await page.route(`${origin}/yurrr-performance`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><link rel="stylesheet" href="/extension/popup/popup.css"><div id="list-screen"><input id="search-input"><button id="add-btn">Add</button><div id="entry-list" style="height:500px;overflow:auto"></div></div>` }));
  await page.goto(`${origin}/yurrr-performance`);
  await page.addScriptTag({ url: `${origin}/extension/lib/site-scope.js` });
  await page.addScriptTag({ content: `window.VaultSections = { activeTab: 'passwords', handleSearchInput: () => false };
    window.areFaviconsEnabled = async () => false;
    window.getPopupIcon = () => '<svg><path></path></svg>';
    function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
    const EntryDetail = { show() {} };` });
  await page.addScriptTag({ url: `${origin}/extension/popup/components/entry-list.js` });
  results.popup = await page.evaluate(() => {
    EntryList.init();
    const measurements = [];
    for (const count of [100, 1000, 5000]) {
      const entries = Array.from({ length: count }, (_, i) => ({ id: String(i), website_domain: `site${i}.test`, website_url: `https://site${i}.test`, username: `user${i}` }));
      EntryList.entries = entries;
      const times = [];
      for (let iteration = 0; iteration < 7; iteration++) {
        const start = performance.now();
        EntryList.renderEntries(entries);
        void EntryList.listEl.offsetHeight;
        times.push(performance.now() - start);
      }
      measurements.push({ entries: count, renderedRows: document.querySelectorAll('.entry-item').length,
        nodes: EntryList.listEl.querySelectorAll('*').length, medianRenderWithLayoutMs: times.sort((a, b) => a - b)[3] });
    }
    return measurements;
  });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  if (await page.locator('.entry-main').first().getAttribute('data-id') !== '50') throw new Error('Second page is wrong');
  await page.evaluate(() => EntryList.applySnapshot({ data: EntryList.entries, expiresAt: Date.now() + 300000 }));
  if (await page.locator('.entry-main').first().getAttribute('data-id') !== '50') throw new Error('Background refresh lost the current page');
  await page.locator('#search-input').fill('user4999');
  if (await page.locator('.entry-main').count() !== 1 || await page.locator('.entry-main').getAttribute('data-id') !== '4999') throw new Error('Search missed an unrendered entry');
  results.pagination = 'next page and search across all 5000 entries passed';
  return results;
}
