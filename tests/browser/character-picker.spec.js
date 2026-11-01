import { test, expect } from '@playwright/test';
import { createHttpReader } from '../../extensions/dndbeyond/http-read.js';
import { createScriptApi } from '../../extensions/dndbeyond/script-api.js';

const token = user => 'e30.' + Buffer.from(JSON.stringify({ 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': user })).toString('base64url') + '.signature';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('account discovery follows the public listing contract and returns only picker metadata', async () => {
  const calls = [];
  const reader = createHttpReader({ fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('auth-service')) return json({ token: token('42'), ttl: 300 });
    return json({ success: true, data: { characters: [
      { id: 123, name: '<b>Hero</b>', status: 1, isAssigned: true, level: 4, classDescription: 'Wizard 4', raceName: 'Elf', campaignName: 'Private campaign' },
      { id: 456, name: 'Locked', status: 3, isAssigned: true },
      { id: 789, name: 'Deleted', status: 2, isAssigned: true }
    ] } });
  } });
  expect(typeof reader.listCharacters).toBe('function');
  expect(await reader.listCharacters()).toEqual({ accountId: '42', characters: [
    { id: '123', name: '<b>Hero</b>', details: 'Level 4 · Elf · Wizard 4' }
  ] });
  expect(calls.map(c => [c.url, c.method, c.credentials])).toEqual([
    ['https://auth-service.dndbeyond.com/v1/cobalt-token', 'POST', 'include'],
    ['https://character-service.dndbeyond.com/character/v5/characters/list?userId=42', 'GET', 'omit']
  ]);
  expect(calls[1].headers.Authorization).toBe('Bearer ' + token('42'));
});

test('account discovery rejects malformed contracts and propagates login/rate errors', async () => {
  for (const [response, error] of [[() => json({ success: true, data: {} }), 'schema'],
    [() => new Response('', { status: 401 }), 'reauth_required'], [() => new Response('', { status: 429 }), 'rate_limited']]) {
    const reader = createHttpReader({ fetch: async url => url.includes('auth-service') ? json({ token: token('42'), ttl: 300 }) : response() });
    expect(typeof reader.listCharacters).toBe('function');
    await expect(reader.listCharacters()).rejects.toThrow(error);
  }
});

test('selected aliases resolve once, preserve explicit ID routes and stop queued revoked work', async () => {
  let selection = '123', release;
  const calls = [];
  const api = createScriptApi({ request: async (id, url, options) => {
    calls.push({ id, url, options });
    if (calls.length === 1) await new Promise(r => { release = r; });
    return { status: 200, data: { success: true, data: { id: Number(id), name: 'Invented' } } };
  } });
  expect(await api.handle({ method: 'GET', path: '/v1/character' }, () => false, [], null)).toMatchObject({ status: 409, body: { error: 'no_character_selected' } });
  const one = api.handle({ method: 'GET', path: '/v1/character' }, id => id === selection, ['123'], { id: '123', name: 'Invented' });
  await expect.poll(() => calls.length).toBe(1);
  const queued = api.handle({ method: 'GET', path: '/v1/character' }, id => id === selection, ['123'], { id: '123', name: 'Invented' });
  selection = '456'; release();
  expect(await one).toMatchObject({ body: { characterId: '123' } });
  expect(await queued).toMatchObject({ status: 403 });
  expect(calls).toHaveLength(1);
  expect(await api.handle({ method: 'GET', path: '/v1/characters/456' }, () => true)).toMatchObject({ status: 200, body: { character: { id: 456 } } });
  expect(await api.handle({ method: 'GET', path: '/v1/status' }, () => true, ['456'], { id: '456', name: 'Other' })).toMatchObject({ body: { selected: { id: '456', name: 'Other' } } });
});
