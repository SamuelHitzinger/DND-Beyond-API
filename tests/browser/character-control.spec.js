import { test, expect } from '@playwright/test';
import { createScriptApi } from '../../extensions/dndbeyond/script-api.js';

function fixture() {
  const state = { removed: 7, temporary: 4, writes: [], failWrite: false };
  const api = createScriptApi({ request: async (_id, url, options) => {
    if (url.includes('scds')) return { status: 200, data: { foundCharacters: [{ characterId: 123, hitPointInfo: { current: 30 - state.removed, maximum: 30, temp: state.temporary } }] } };
    if (options.method === 'PUT') {
      state.writes.push(options.body);
      if (state.failWrite) throw Error('network');
      state.removed = options.body.removedHitPoints; state.temporary = options.body.temporaryHitPoints;
      return { status: 200, data: { success: true } };
    }
    return { status: 200, data: { success: true, data: { id: 123, name: 'Invented', removedHitPoints: state.removed, temporaryHitPoints: state.temporary } } };
  } });
  const call = (method, path, body = null) => api.handle({ method, path: '/v1/character' + path, body }, () => true, ['123'], { id: '123', name: 'Invented' });
  return { state, call };
}
test('summary reports fresh computed HP and HP routes verify damage, healing and temporary HP', async () => {
  const h = fixture();
  expect(await h.call('GET', '/summary')).toMatchObject({ status: 200, body: { summary: { character_id: '123', vitals: { current: 23, maximum: 30, temporary: 4 } } } });
  expect(await h.call('POST', '/hp/damage', { amount: 6, expected: { current: 23, maximum: 30, temporary: 4 } })).toMatchObject({ body: { state: 'verified', summary: { vitals: { current: 21, temporary: 0 } } } });
  expect(await h.call('POST', '/hp/heal', { amount: 50 })).toMatchObject({ body: { state: 'verified', summary: { vitals: { current: 30, temporary: 0 } } } });
  expect(await h.call('POST', '/hp/temporary', { value: 8 })).toMatchObject({ body: { state: 'verified', summary: { vitals: { current: 30, temporary: 8 } } } });
  expect(h.state.writes).toEqual([
    { characterId: 123, removedHitPoints: 9, temporaryHitPoints: 0 },
    { characterId: 123, removedHitPoints: 0, temporaryHitPoints: 0 },
    { characterId: 123, removedHitPoints: 0, temporaryHitPoints: 8 }
  ]);
});
test('HP conflicts and invalid amounts do not write; lost response stays unknown without replay', async () => {
  const h = fixture();
  expect(await h.call('POST', '/hp/damage', { amount: 1, expected: { current: 1, maximum: 30, temporary: 4 } })).toMatchObject({ body: { state: 'conflict' } });
  expect(await h.call('POST', '/hp/damage', { amount: -1 })).toMatchObject({ status: 400 });
  expect(h.state.writes).toHaveLength(0);
  h.state.failWrite = true;
  expect(await h.call('POST', '/hp/damage', { amount: 6 })).toMatchObject({ body: { state: 'unknown' } });
  expect(h.state.writes).toHaveLength(1);
});
