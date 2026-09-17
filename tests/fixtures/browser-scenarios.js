async (page) => {
  const base = 'http://127.0.0.1:8769/tests/fixtures/forms.html';
  const outcomes = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const save = async (context) => {
    const button = await context.evaluateHandle(() => window.fixtureState.saveBannerRoot.querySelector('.yurrr-banner-save'));
    await button.asElement().click();
    await button.dispose();
  };
  for (const scenario of ['spa', 'enter', 'click', 'formless', 'replacement', 'reveal', 'associated', 'multi-step', 'password-change', 'signup', 'navigation', 'slow', 'invalid', 'failed', 'transient', 'reset-click', 'contents-failed', 'dynamic-type', 'navigation-with-form', 'shadow', 'nested-shadow', 'dynamic-shadow', 'shadow-formless', 'shadow-replacement', 'manual', 'choose-account']) {
    await page.goto(`${base}?scenario=${scenario}`);
    if (scenario === 'dynamic-shadow') await page.getByRole('button', { name: 'Open login' }).click();
    if (scenario === 'shadow-replacement') {
      await page.getByRole('button', { name: 'Replace shadow fields' }).click();
      await page.waitForFunction(() => document.querySelector('#fixture section').shadowRoot.querySelector('input[type="password"]').dataset.yurrrPickerAttached === '1');
    }
    if (scenario === 'password-change') {
      await page.getByLabel('Old password').fill('synthetic-old');
      await page.getByLabel('New password', { exact: true }).fill('synthetic-new');
      await page.getByLabel('Confirm password').fill('synthetic-new');
      await page.keyboard.press('Escape');
    } else {
      await page.getByLabel('Email').fill(scenario === 'invalid' ? 'invalid-email' : 'alice@example.com');
      if (scenario === 'multi-step') await page.getByRole('button', { name: 'Weiter' }).click();
      if (scenario === 'replacement') await page.getByRole('button', { name: 'Replace fields' }).click();
      if (scenario === 'dynamic-type') await page.getByRole('button', { name: 'Enable password' }).click();
      await page.getByLabel('Password', { exact: true }).fill('synthetic-new');
      if (scenario === 'signup') {
        await page.getByLabel('Confirm password').fill('synthetic-new');
        await page.keyboard.press('Escape');
      }
      if (scenario === 'reveal') await page.getByRole('button', { name: 'Show password' }).click();
    }
    if (scenario === 'enter') await page.getByLabel('Password', { exact: true }).press('Enter');
    else await page.getByRole('button', { name: /^(Sign in|Anmelden|Save password|Register|Reset password)$/ }).click();
    if (['invalid', 'failed', 'transient', 'contents-failed'].includes(scenario)) {
      // Let the transition observation window see a failed or briefly hidden form.
      await page.waitForTimeout(2100);
      if (await page.locator('#yurrr-save-banner').count()) throw new Error(`Unexpected save banner: ${scenario}`);
      outcomes.push({ scenario, result: 'no false save prompt' });
      continue;
    }
    if (['manual', 'choose-account'].includes(scenario)) {
      if (await page.locator('#yurrr-save-banner').count()) throw new Error('Save banner shown without explicit review');
      await page.getByRole('button', { name: 'Review', exact: true }).click();
    }
    await page.locator('#yurrr-save-banner').waitFor({ state: 'visible', timeout: 11000 });
    const detected = await page.evaluate(() => window.fixtureState.pending);
    if (detected.password !== 'synthetic-new') throw new Error(`Wrong password captured: ${scenario}`);
    if (scenario !== 'password-change' && detected.username !== 'alice@example.com') throw new Error(`Wrong username captured: ${scenario}`);
    if (scenario === 'choose-account') {
      if (await page.locator('#yurrr-save-banner option').count() || await page.locator('#yurrr-save-banner').evaluate((host) => host.shadowRoot !== null)) throw new Error('Account names exposed to page DOM');
      const handle = await page.evaluateHandle(() => window.fixtureState.saveBannerRoot.querySelector('select'));
      const account = handle.asElement();
      await account.focus();
      await account.press('Home');
      await account.press('ArrowDown');
      await account.press('ArrowDown');
      await account.press('Tab');
      await handle.dispose();
    }
    await save(page);
    const saved = await page.evaluate(() => window.fixtureState.saved);
    if (saved?.password !== 'synthetic-new') throw new Error(`Password was not saved: ${scenario}`);
    if (scenario === 'choose-account' && (saved.entryId !== 'bob' || !saved.confirmUpdate)) throw new Error('Wrong update selection');
    outcomes.push({ scenario, result: 'correct capture, banner and confirmed save' });
  }
  await page.goto(`${base}?scenario=failed`);
  await page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.style.cssText = 'width: 800px; height: 550px';
    document.body.append(frame);
  }, `${base}?scenario=spa&child=1`);
  const child = page.frameLocator('iframe');
  await child.getByLabel('Email').fill('frame@example.com');
  await child.getByLabel('Password', { exact: true }).fill('frame-secret');
  await child.getByRole('button', { name: 'Sign in', exact: true }).click();
  await child.locator('#yurrr-save-banner').waitFor({ state: 'visible' });
  if (await page.locator('#yurrr-save-banner').count()) throw new Error('Frame save leaked to parent');
  const frame = page.frames().find((frame) => frame.url().includes('child=1'));
  await save(frame);
  const frameSaved = await frame.evaluate(() => window.fixtureState.saved);
  if (frameSaved?.password !== 'frame-secret') throw new Error('Frame save failed');
  outcomes.push({ scenario: 'iframe', result: 'independent capture and explicit save' });
  await page.goto(`${base}?scenario=shadow`);
  await page.getByLabel('Password', { exact: true }).evaluate((input) => { input.autocomplete = 'new-password'; });
  await page.getByLabel('Password', { exact: true }).click();
  await page.locator('#yurrr-overlay-host').waitFor({ state: 'visible' });
  await page.getByRole('heading').click();
  await page.locator('#yurrr-overlay-host').waitFor({ state: 'hidden' });
  outcomes.push({ scenario: 'shadow-generator-click', result: 'stays open on field click, closes on outside click' });
  await page.goto(`${base}?scenario=spa`);
  await page.evaluate(() => {
    document.getElementById('fixture').innerHTML = '<section id="late-shadow"></section>';
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    document.getElementById('late-shadow').attachShadow({ mode: 'open' }).innerHTML = '<label>New shadow password <input type="password" autocomplete="new-password"></label>';
  });
  await page.getByLabel('New shadow password').click();
  await page.locator('#yurrr-overlay-host').waitFor({ state: 'visible' });
  outcomes.push({ scenario: 'late-shadow-first-focus', result: 'generator opens on the first interaction' });
  await page.evaluate(() => {
    const host = document.getElementById('late-shadow');
    host.addEventListener('input', (event) => { window.fixtureState.componentValue = event.composedPath()[0].value; });
    YurrrDetector.fillFields(null, host.shadowRoot.querySelector('input'), { password: 'synthetic-filled' });
  });
  if (await page.evaluate(() => window.fixtureState.componentValue) !== 'synthetic-filled') throw new Error('Component missed the fill input event');
  const usePassword = await page.evaluateHandle(() => window.fixtureState.overlayRoot.querySelector('.use-password'));
  await usePassword.asElement().click();
  await usePassword.dispose();
  if (await page.evaluate(() => window.fixtureState.componentValue) !== 'synthetic-generated') throw new Error('Component missed the generator input event');
  outcomes.push({ scenario: 'shadow-component-input', result: 'manual fill and generated password update the component model' });
  if (errors.length) throw new Error(errors.join('; '));
  return outcomes;
}
