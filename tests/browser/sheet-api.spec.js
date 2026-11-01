import { test, expect } from '@playwright/test';
import { createScriptApi } from '../../extensions/dndbeyond/script-api.js';

test('sheet fields use bundle-derived paths, preserve unrelated values and verify after mutation', async () => {
  const c = { id: 123, inspiration: false, currentXp: 10, deathSaves: { failCount: 0, successCount: 0 }, notes: { otherNotes: null, backstory: 'preserve' },
    actions: { race: null, class: [{ id: '8', entityTypeId: '9', limitedUse: { numberUsed: 0 } }] }, classSpells: [{ characterClassId: 7, spells: [{ id: 6, entityTypeId: 5, definition: { id: 4 }, prepared: true }] }] };
  const paths = [];
  const api = createScriptApi({ request: async (_id, url, o) => {
    if (o.method === 'GET') return { status: 200, data: { success: true, data: structuredClone(c) } };
    const path = new URL(url).pathname; paths.push(path);
    if (path.endsWith('/inspiration')) c.inspiration = o.body.inspiration;
    if (path.endsWith('/progression')) c.currentXp = o.body.currentXp;
    if (path.endsWith('/death-saves')) c.deathSaves = { failCount: o.body.failCount, successCount: o.body.successCount };
    if (path.endsWith('/notes')) c.notes = { ...c.notes, ...Object.fromEntries(Object.entries(o.body).filter(([k]) => k !== 'characterId')) };
    if (path.endsWith('/limited-use')) { expect(o.body).toMatchObject({ id: 8, entityTypeId: 9, uses: 1 }); c.actions.class[0].limitedUse.numberUsed = 1; }
    if (path.endsWith('/prepared')) { expect(o.body).toMatchObject({ id: 6, spellId: 4, characterClassId: 7, entityTypeId: 5, prepared: false }); c.classSpells[0].spells[0].prepared = false; }
    return { status: 200, data: { success: true } };
  } });
  for (const [route, body] of [['inspiration', { inspiration: true }], ['xp', { currentXp: 11 }], ['death-saves', { failCount: 1, successCount: 0 }], ['notes', { otherNotes: null }], ['limited-use', { id: '8', entityTypeId: '9', uses: 1 }], ['prepared-spells', { id: 6, characterClassId: 7, prepared: false }]]) {
    expect(await api.handle({ method: 'PUT', path: '/v1/characters/123/' + route, body }, () => true)).toMatchObject({ body: { state: 'verified' } });
  }
  expect(c.notes.otherNotes).toBe(''); expect(c.notes.backstory).toBe('preserve');
  expect(paths).toEqual(['/character/v5/character/inspiration', '/character/v5/character/progression', '/character/v5/life/death-saves', '/character/v5/description/notes', '/character/v5/action/limited-use', '/character/v5/spell/prepared']);
});

test('custom item and action CRUD use individual IDs and preserve custom item quantity on updates', async () => {
  const c = { id: 123, customItems: [], customActions: [] };
  const api = createScriptApi({ request: async (_id, url, o) => {
    if (o.method === 'GET') return { status: 200, data: { success: true, data: structuredClone(c) } };
    const item = url.endsWith('/custom/item'), list = item ? c.customItems : c.customActions;
    if (o.method === 'POST') list.push({ ...o.body, id: item ? 77 : '88' });
    if (o.method === 'PUT') { if (item) expect(o.body.quantity).toBe(1); Object.assign(list.find(v => Number(v.id) === o.body.id), o.body, { id: item ? 77 : '88' }); }
    if (o.method === 'DELETE') list.splice(list.findIndex(v => Number(v.id) === o.body.id), 1);
    return { status: 200, data: { success: true } };
  } });
  for (const [route, id] of [['custom-items', 77], ['custom-actions', 88]]) {
    const call = (method, suffix, body) => api.handle({ method, path: '/v1/characters/123/' + route + suffix, body }, () => true);
    expect(await call('POST', '', { name: 'Synthetic' })).toMatchObject({ body: { state: 'verified', id: route === 'custom-actions' ? String(id) : id } });
    expect(await call('PUT', '/' + id, { name: 'Changed' })).toMatchObject({ body: { state: 'verified' } });
    expect(await call('DELETE', '/' + id)).toMatchObject({ body: { state: 'verified' } });
  }
});
