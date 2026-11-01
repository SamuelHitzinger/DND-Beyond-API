import { test, expect } from '@playwright/test';
import { createHttpReader } from '../../extensions/dndbeyond/http-read.js';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('only the token exchange sends cookies; clearing login forces a new exchange and writes are not retried', async () => {
  const calls = []; let fail = false;
  const reader = createHttpReader({ fetch: async (url, options) => {
    calls.push({ url, options });
    if (url.includes('auth-service')) return json({ token: 'FAKE.payload.signature', ttl: 300 });
    if (fail) throw Error('disconnected');
    return json({ success: true, data: { id: 123 } });
  } });
  const read = () => reader.requestCharacter('123', '/character/v5/character/123');
  await read(); await read();
  expect(calls.filter(c => c.url.includes('auth-service'))).toHaveLength(1);
  expect(calls[0].options.credentials).toBe('include');
  expect(calls[1].options).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
  reader.clear(); await read();
  expect(calls.filter(c => c.url.includes('auth-service'))).toHaveLength(2);
  fail = true;
  await expect(reader.requestCharacter('123', '/character/v5/life/hp/damage-taken', { method: 'PUT', body: { characterId: 123 } })).rejects.toThrow('network');
  expect(calls.filter(c => c.options.method === 'PUT')).toHaveLength(1);
});

test('selection or permission loss before dispatch prevents the authenticated service request', async () => {
  let resolve, allowed = true; const calls = [];
  const reader = createHttpReader({ fetch: async (url, options) => {
    calls.push(url);
    await new Promise(r => { resolve = r; });
    return json({ token: 'FAKE.payload.signature', ttl: 300 });
  } });
  const call = reader.requestCharacter('123', '/character/v5/life/hp/damage-taken', { method: 'PUT', body: {}, assertScope: () => { if (!allowed) throw Error('scope_ended'); } });
  await expect.poll(() => calls.length).toBe(1);
  allowed = false; resolve();
  await expect(call).rejects.toThrow('scope_ended');
  expect(calls).toEqual(['https://auth-service.dndbeyond.com/v1/cobalt-token']);
});
