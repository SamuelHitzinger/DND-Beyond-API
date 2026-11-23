import { test, expect } from '@playwright/test';
import { fixture, origin, origins } from './picker-ui-helpers.js';

async function start(s) {
  await expect.poll(() => s.worker.evaluate(() => nativePorts.length)).toBe(1);
  await s.send({ type: 'ready' });
  const page = await s.context.newPage(); await page.goto(origin + 'ui/picker.html');
  await page.evaluate(() => { chrome.permissions.request = () => { throw Error('Unexpected permission prompt'); }; });
  await expect(page.locator('#connection')).toContainText('Connected');
  return page;
}

test('picker automatically discovers account characters and remembers the choice without permission or sharing controls', async ({}, info) => {
  const s = await fixture(info, {});
  try {
    const page = await start(s);
    await expect(page.getByLabel('Character', { exact: true })).toBeEnabled();
    await expect(page.locator('#characters option')).toHaveCount(3);
    await expect(page.locator('#characters option').nth(1)).toHaveText('<b>Invented Hero</b> — Level 4 · Elf · Wizard 4');
    await page.getByLabel('Character', { exact: true }).selectOption('123');
    await expect(page.locator('#characters option:checked')).toContainText('<b>Invented Hero</b>');
    await expect(page.locator('#characters b')).toHaveCount(0);
    expect(await page.evaluate(origins => chrome.permissions.contains({ origins }), origins)).toBe(true);
    await expect(page.getByRole('button', { name: /Allow|Connect|Stop sharing|Pause API/i })).toHaveCount(0);
    await expect.poll(() => s.worker.evaluate(async () => (await chrome.storage.local.get('selectedCharacter')).selectedCharacter?.id ?? null)).toBe('123');
    // Exercise the real worker/native framing and selected alias, not only UI storage.
    const requestId = 'a'.repeat(32);
    await s.send({ type: 'request', id: requestId, request: { method: 'GET', path: '/v1/character', body: null } });
    await expect.poll(() => s.worker.evaluate(id => nativeMessages.some(m => m.type === 'response' && m.id === id && m.final), requestId)).toBe(true);
    const response = await s.worker.evaluate(id => {
      const bytes = nativeMessages.filter(m => m.type === 'response' && m.id === id).sort((a, b) => a.index - b.index).map(m => atob(m.data)).join('');
      return JSON.parse(bytes);
    }, requestId);
    expect(response).toMatchObject({ status: 200, body: { characterId: '123', character: { id: 123, name: 'Invented Hero' } } });
    await expect(page.locator('input')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('picker.png') });
    await page.close();
    const again = await s.context.newPage(); await again.goto(origin + 'ui/picker.html');
    await expect(again.getByLabel('Character', { exact: true })).toHaveValue('123');
    expect(await s.worker.evaluate(() => httpCalls.some(c => c.method === 'PUT' || c.method === 'DELETE'))).toBe(false);
  } finally { await s.context.close(); }
});

test('sign-in loss and empty account list have recovery without opt-in setup', async ({}, info) => {
  const s = await fixture(info, {});
  try {
    const popup = await start(s);
    await expect(popup.locator('#characters option')).toHaveCount(3);
    await s.worker.evaluate(() => { globalThis.listFailure = 401; });
    await popup.getByRole('button', { name: 'Refresh characters' }).click();
    await expect(popup.locator('#error')).toContainText('Sign in');
    await expect(popup.getByRole('link', { name: 'Open D&D Beyond' })).toBeVisible();
    await s.worker.evaluate(() => { globalThis.listFailure = 0; globalThis.emptyList = true; });
    await popup.getByRole('button', { name: 'Refresh characters' }).click();
    await expect(popup.locator('#list-help')).toContainText('No active characters');
    await expect(popup.getByLabel('Character', { exact: true })).toBeDisabled();
    const help = await s.context.newPage(); await help.goto(origin + 'ui/setup.html');
    await expect(help.getByRole('button', { name: /Allow|Connect|Stop sharing|Pause API/i })).toHaveCount(0);
  } finally { await s.context.close(); }
});

test('without the Windows helper the picker still lists and selects characters', async ({}, info) => {
  const s = await fixture(info, {});
  try {
    await expect.poll(() => s.worker.evaluate(() => nativePorts.length)).toBe(1);
    await s.worker.evaluate(() => nativePorts.at(-1).disconnect()); // The helper never becomes ready.
    const page = await s.context.newPage(); await page.goto(origin + 'ui/picker.html');
    await expect(page.locator('#connection')).toContainText(/unavailable|Connecting/u);
    await expect(page.getByLabel('Character', { exact: true })).toBeEnabled();
    await page.getByLabel('Character', { exact: true }).selectOption('123');
    await expect.poll(() => s.worker.evaluate(async () => (await chrome.storage.local.get('selectedCharacter')).selectedCharacter?.id ?? null)).toBe('123');
    expect(await s.worker.evaluate(() => bridge.status().phase)).not.toBe('ready');
  } finally { await s.context.close(); }
});
