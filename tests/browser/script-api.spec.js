import { test, expect } from '@playwright/test';

test('development reload is acknowledged without touching DDB', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  const api = createScriptApi({ request: async () => { throw Error('unexpected DDB call'); } });
  expect(await api.handle({ method: 'POST', path: '/dev/reload-extension', body: null }, () => false)).toEqual({ status: 202, body: { state: 'reloading' } });
  expect(await api.handle({ method: 'POST', path: '/dev/reload-extension', body: { delayMs: 10000 } }, () => false)).toMatchObject({ status: 202 });
  expect(await api.handle({ method: 'POST', path: '/dev/reload-extension', body: { delayMs: -1 } }, () => false)).toMatchObject({ status: 400 });
});

test('item deletion uses the published DELETE body and verifies absence', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  const api = createScriptApi({ request: async (_id, url, o) => {
    if (o.method === 'DELETE') {
      expect(url).toBe('https://character-service.dndbeyond.com/character/v5/inventory/item');
      expect(o.body).toEqual({ characterId: 123, id: 77, removeContainerContents: false });
      return { status: 200, data: { success: true } };
    }
    return { status: 200, data: { success: true, data: { id: 123, inventory: [] } } };
  } });
  expect(await api.handle({ method: 'DELETE', path: '/v1/characters/123/inventory/77' }, () => true)).toMatchObject({ body: { state: 'verified' } });
});

test('generic requests restrict hosts, preserve JSON and never retry ambiguous writes', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  const calls = [];
  const api = createScriptApi({ request: async (...args) => { calls.push(args); throw Error('network'); } });
  const grant = () => true;
  expect(await api.handle({ method: 'POST', path: '/v1/characters/123/request', body: { method: 'PUT', path: 'https://example.com/character', body: {} } }, grant)).toMatchObject({ status: 400 });
  expect(calls).toHaveLength(0);
  const r = await api.handle({ method: 'POST', path: '/v1/characters/123/request', body: { method: 'PUT', path: '/character/v5/condition', body: { id: 1, level: null } } }, grant);
  expect(r).toMatchObject({ status: 200, body: { state: 'unknown' } });
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toMatchObject({ body: { characterId: 123, id: 1, level: null } });
});

test('an upstream server failure remains unknown even with an HTTP response', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  const api = createScriptApi({ request: async () => ({ status: 500, data: { error: 'server failed after save' } }) });
  expect(await api.handle({ method: 'POST', path: '/v1/characters/123/request', body: { method: 'PUT', path: '/character/v5/condition', body: {} } }, () => true)).toMatchObject({ body: { state: 'unknown' } });
});

test('item add and spell slots use observed payloads, report created IDs and verify read-back', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  // v5's raw available counter can be zero even for a spellcaster. It is not
  // the rules engine's computed capacity and must not block valid updates.
  const character = { id: 123, inventory: [], spellSlots: [{ level: 1, used: 0, available: 0 }] };
  const api = createScriptApi({ request: async (_id, url, o) => {
    if (o.method === 'GET') return { status: 200, data: { success: true, data: structuredClone(character) } };
    if (url.endsWith('/inventory/item')) {
      expect(o.body).toEqual({ characterId: 123, equipment: [{ entityId: 8, entityTypeId: 9, quantity: 1, containerEntityId: 123, containerEntityTypeId: 1581111423 }] });
      character.inventory.push({ id: 77, definition: { id: 8, entityTypeId: 9 }, quantity: 1 });
    } else {
      expect(url).toBe('https://character-service.dndbeyond.com/character/v5/spell/slots');
      expect(o.body).toEqual({ characterId: 123, level1: 1 }); character.spellSlots[0].used = 1;
    }
    return { status: 200, data: { success: true } };
  } });
  expect(await api.handle({ method: 'POST', path: '/v1/characters/123/inventory', body: { entityId: 8, entityTypeId: 9, quantity: 1 } }, () => true)).toMatchObject({ body: { state: 'verified', itemIds: [77] } });
  expect(await api.handle({ method: 'PUT', path: '/v1/characters/123/spell-slots/1', body: { used: 1 } }, () => true)).toMatchObject({ body: { state: 'verified' } });
  expect(await api.handle({ method: 'PUT', path: '/v1/characters/123/spell-slots/1', body: { used: -1 } }, () => true)).toMatchObject({ status: 400 });
});

test('character allow-all is required; typed condition checks read-back and serializes writes', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  let conditions = [], writing = 0, max = 0;
  const api = createScriptApi({ request: async (id, path, options) => {
    if (options.method === 'GET') return { status: 200, data: { success: true, data: { id: 123, conditions } } };
    writing++; max = Math.max(max, writing); await new Promise(r => setTimeout(r, 5));
    conditions = options.method === 'DELETE' ? [] : [{ id: options.body.id, level: options.body.level }]; writing--;
    return { status: 200, data: { success: true } };
  } });
  const r = { method: 'PUT', path: '/v1/characters/123/conditions/1', body: {} };
  expect(await api.handle(r, () => false)).toMatchObject({ status: 403 });
  const results = await Promise.all([api.handle(r, () => true), api.handle(r, () => true)]);
  expect(results.every(r => r.body.state === 'verified')).toBe(true); expect(max).toBe(1);
});

test('inventory and currency wrappers use captured inventory paths and verify the changed field', async () => {
  const { createScriptApi } = await import('../../extensions/dndbeyond/script-api.js');
  const character = { id: 123, inventory: [{ id: 77, equipped: true, isAttuned: true, quantity: 1, containerEntityId: 123, containerEntityTypeId: 1581111423 }], currencies: { cp: 0, sp: 5, ep: 0, gp: 37, pp: 0 } };
  const calls = [];
  const api = createScriptApi({ request: async (_id, url, o) => {
    calls.push({ url, ...o });
    if (o.method === 'GET') return { status: 200, data: { success: true, data: structuredClone(character) } };
    const item = character.inventory[0];
    if (url.endsWith('/equipped')) item.equipped = o.body.value;
    if (url.endsWith('/attuned')) item.isAttuned = o.body.value;
    if (url.endsWith('/quantity')) item.quantity = o.body.quantity;
    if (url.endsWith('/move')) { item.containerEntityId = o.body.containerEntityId; item.containerEntityTypeId = o.body.containerEntityTypeId; }
    if (url.endsWith('/currency/transaction')) for (const coin of ['cp', 'sp', 'ep', 'gp', 'pp']) character.currencies[coin] += o.body[coin] ?? 0;
    return { status: 200, data: { success: true } };
  } });
  for (const [suffix, body] of [['inventory/77/equipped', { value: false }], ['inventory/77/attuned', { value: false }], ['inventory/77/quantity', { quantity: 2 }], ['inventory/77/container', { containerEntityId: 88, containerEntityTypeId: 1581111423 }], ['currency', { cp: 1 }]]) {
    expect(await api.handle({ method: 'PUT', path: '/v1/characters/123/' + suffix, body }, () => true)).toMatchObject({ status: 200, body: { state: 'verified' } });
  }
  expect(calls.filter(c => c.method === 'PUT').map(c => new URL(c.url).pathname)).toEqual(['/character/v5/inventory/item/equipped', '/character/v5/inventory/item/attuned', '/character/v5/inventory/item/quantity', '/character/v5/inventory/item/move', '/character/v5/inventory/currency/transaction']);
  expect(character.currencies.sp).toBe(5);
  expect(await api.handle({ method: 'PUT', path: '/v1/characters/123/inventory/77/quantity', body: { quantity: -1 } }, () => true)).toMatchObject({ status: 400 });
});
