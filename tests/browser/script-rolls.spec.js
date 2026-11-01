import { test, expect } from '@playwright/test';
import { createScriptApi } from '../../extensions/dndbeyond/script-api.js';

test('local rolls use fresh SCDS modifiers, cancel opposing advantage and never post mutations', async () => {
  const sheet = { characterId: 123, initiativeBonus: 4, abilities: [{ name: 'Dexterity', label: 'DEX', modifier: 3, save: 6 }],
    skills: [{ name: 'Stealth', modifier: 9, isAdvantage: true, isDisadvantage: true }],
    attacks: [{ name: 'Bow', toHit: 7, damage: { type: 'Piercing', value: { diceCount: 1, diceValue: 8, fixedValue: 3, diceMultiplier: null, diceString: '1d8+3' } } }] };
  const calls = [];
  const api = createScriptApi({ request: async (_id, url, o) => { calls.push({ url, ...o }); return { status: 200, data: { foundCharacters: [sheet] } }; } });
  const roll = body => api.handle({ method: 'POST', path: '/v1/characters/123/rolls', body }, () => true);
  for (const [kind, name, modifier] of [['ability', 'DEX', 3], ['save', 'Dexterity', 6], ['skill', 'Stealth', 9], ['attack', 'Bow', 7], ['initiative', undefined, 4]]) {
    const r = await roll({ kind, name });
    expect(r).toMatchObject({ status: 200, body: { state: 'rolled', modifier, source: 'scds', posted: false } });
    expect(r.body.total).toBe(r.body.dice[0].values[0] + modifier);
  }
  const advantage = await roll({ kind: 'save', name: 'DEX', advantage: 'advantage' });
  expect(advantage.body.dice[0].values).toHaveLength(2);
  expect(advantage.body.total).toBe(Math.max(...advantage.body.dice[0].values) + 6);
  const damage = await roll({ kind: 'damage', name: 'Bow', critical: true });
  expect(damage.body.dice[0]).toMatchObject({ sides: 8 }); expect(damage.body.dice[0].values).toHaveLength(2);
  expect(damage.body.total).toBe(damage.body.dice[0].values.reduce((a, b) => a + b, 3));
  expect(calls.every(c => c.url === 'https://character-service-scds.dndbeyond.com/v2/characters' && c.method === 'POST')).toBe(true);
  expect(calls[0].body).toEqual({ characterIds: [123] });
});

test('rolls reject unresolved characters, ambiguous names and unsupported damage; explicit dice stay local', async () => {
  const api = createScriptApi({ request: async () => ({ status: 200, data: { foundCharacters: [{ characterId: 123, attacks: [{ name: 'X' }, { name: 'X' }] }] } }) });
  const roll = body => api.handle({ method: 'POST', path: '/v1/characters/123/rolls', body }, () => true);
  expect(await roll({ kind: 'damage', name: 'X' })).toMatchObject({ status: 400 });
  expect(await roll({ kind: 'damage', index: 0 })).toMatchObject({ status: 422 });
  expect(await roll({ kind: 'dice', expression: '10000d20' })).toMatchObject({ status: 400 });
  const local = createScriptApi({ request: async () => { throw Error('must remain local'); } });
  const r = await local.handle({ method: 'POST', path: '/v1/characters/123/rolls', body: { kind: 'dice', expression: '2d6+3-1d4' } }, () => true);
  expect(r).toMatchObject({ status: 200, body: { state: 'rolled', source: 'expression', posted: false, modifier: 3 } });
  expect(r.body.total).toBe(r.body.dice[0].values.reduce((a, b) => a + b, 3) - r.body.dice[1].values[0]);
});
