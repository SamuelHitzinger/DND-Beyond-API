import { test, expect } from '@playwright/test';
import { createScriptApi } from '../../extensions/dndbeyond/script-api.js';

test('rests use sheet payloads and verify service-returned fields against fresh v5, never replay', async () => {
  let writes = 0;
  const c = { id: 123, removedHitPoints: 0, temporaryHitPoints: 1, spellSlots: [{ level: 1, used: 0 }], pactMagic: [], classes: [{ id: 8, hitDiceUsed: 0 }], conditions: [], actions: { race: null, class: [{ id: '9', entityTypeId: '10', limitedUse: { numberUsed: 0 } }] } };
  const api = createScriptApi({ request: async (_id, url, o) => {
    if (o.method === 'GET') return { status: 200, data: { success: true, data: c } };
    writes++; expect(url).toBe('https://character-service.dndbeyond.com/character/v5/character/rest/short');
    expect(o.body).toEqual({ characterId: 123, classHitDiceUsed: { 8: 0 }, resetMaxHpModifier: false });
    return { status: 200, data: { success: true, data: { ...c, actions: { class: c.actions.class }, removedHitPoints: writes === 2 ? 2 : 0 } } };
  } });
  const call = () => api.handle({ method: 'POST', path: '/v1/characters/123/rests/short', body: {} }, () => true);
  expect(await call()).toMatchObject({ body: { state: 'verified', verifiedFields: expect.arrayContaining(['removedHitPoints', 'spellSlots', 'actions']) } });
  expect(await call()).toMatchObject({ body: { state: 'unknown', reason: 'readback_mismatch' } });
  expect(writes).toBe(2);
});
