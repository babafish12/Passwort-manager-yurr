async (page) => {
  const base = 'http://127.0.0.1:8769/tests/fixtures/forms.html';
  const outcomes = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const scenario of ['spa', 'enter', 'click', 'formless', 'replacement', 'reveal', 'associated', 'multi-step', 'password-change', 'signup', 'navigation', 'slow', 'invalid', 'failed', 'transient', 'reset-click', 'contents-failed', 'dynamic-type', 'navigation-with-form']) {
    await page.goto(`${base}?scenario=${scenario}`);
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
    await page.locator('#yurrr-save-banner').waitFor({ state: 'visible', timeout: 11000 });
    const detected = await page.evaluate(() => window.fixtureState.pending);
    if (detected.password !== 'synthetic-new') throw new Error(`Wrong password captured: ${scenario}`);
    if (scenario !== 'password-change' && detected.username !== 'alice@example.com') throw new Error(`Wrong username captured: ${scenario}`);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const saved = await page.evaluate(() => window.fixtureState.saved);
    if (saved?.password !== 'synthetic-new') throw new Error(`Password was not saved: ${scenario}`);
    outcomes.push({ scenario, result: 'correct capture, banner and confirmed save' });
  }
  if (errors.length) throw new Error(errors.join('; '));
  return outcomes;
}
