import { test, expect } from '@playwright/test';
import { createLocalApi } from '../../extensions/dndbeyond/local-api.js';
import { createWebShare } from '../../extensions/dndbeyond/web-share.js';
import { buildSheet, createSheetFeed, portraitUrl } from '../../extensions/dndbeyond/share-sheet.js';
import { mapGameLogMessage, cleanText } from '../../extensions/dndbeyond/share-relay.js';
import { createHttpReader } from '../../extensions/dndbeyond/http-read.js';
import { applyShape, createApplier } from '../../extensions/dndbeyond/share-apply.js';
// character-share v2: scopes, sheet projection, apply and roll relay. D&D Beyond
// is mocked entirely; no network, credentials or real browser profile is used.
const event = () => { const listeners = []; return { addListener: f => listeners.push(f), emit: (...args) => Promise.all(listeners.map(f => f(...args))) }; };
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const SITE = 'https://table.example.ts.net:8443', LOCAL = 'http://127.0.0.1:5173';
const ALL = { sheet: true, rolls: true, write: true }, NO_SCOPES = { sheet: false, rolls: false, write: false };
const TOKEN = 'e30.' + Buffer.from(JSON.stringify({ 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': '42' })).toString('base64url') + '.sig';
const V5 = 'https://character-service.dndbeyond.com/character/v5/character/', SCDS = 'https://character-service-scds.dndbeyond.com/v2/characters';

function character(id = 123) {
  return { id, name: 'Mira', removedHitPoints: 7, temporaryHitPoints: 4, inspiration: true, campaign: { id: 9001, name: 'Invented' },
    decorations: { avatarUrl: 'https://www.dndbeyond.com/avatars/1/2/mira.png' },
    race: { fullName: 'Human', baseName: 'Human' },
    classes: [{ id: 77, level: 5, definition: { name: 'Paladin', spellRules: { levelSpellSlots: [[], [0], [2], [3], [3], [4, 2]] } } }],
    modifiers: { class: [{ type: 'proficiency', subType: 'wisdom-saving-throws' }, { type: 'proficiency', subType: 'charisma-saving-throws' }], item: [{ type: 'proficiency', subType: 'strength-saving-throws' }] },
    spellSlots: [{ level: 1, used: 1, available: 0 }, { level: 2, used: 0, available: 0 }, { level: 3, used: 0, available: 0 }], pactMagic: [],
    classSpells: [{ characterClassId: 77, spells: [
      { prepared: true, definition: { name: 'Bless', level: 1, school: 'Enchantment', range: { origin: 'Ranged', rangeValue: 30 }, activation: { activationTime: 1, activationType: 1 } } },
      { prepared: false, definition: { name: 'Command', level: 1, school: 'Enchantment', requiresSavingThrow: true, saveDcAbilityId: 5, range: { origin: 'Ranged', rangeValue: 60 }, activation: { activationTime: 1, activationType: 1 } } },
      { prepared: true, definition: { name: '<b>Searing</b> Smite', level: 1, requiresAttackRoll: false, modifiers: [{ type: 'damage', die: { diceString: '1d6' } }], range: { origin: 'Self' }, activation: { activationTime: 1, activationType: 3 } } }] }],
    spells: { race: [], class: [], item: [{ definition: { name: 'Light', level: 0, school: 'Evocation', range: { origin: 'Touch' } } }], feat: null },
    conditions: [{ id: 4, level: 2 }, { id: 12, level: null }], deathSaves: { failCount: 0, successCount: 0, isStabilized: true } };
}
function computed(id = 123, v5 = character(id)) {
  return { characterId: id, level: 5, armorClass: 18, initiativeBonus: 1, proficiencyBonus: 3, inspiration: false,
    hitPointInfo: { current: 45 - v5.removedHitPoints, maximum: 45, temp: v5.temporaryHitPoints },
    speeds: [{ name: 'Walking', distance: 30 }], passivePerception: 13, passiveInvestigation: 10, passiveInsight: 13,
    abilities: [{ name: 'str', label: 'STR', score: 16, modifier: 3, save: 3 }, { name: 'dex', label: 'DEX', score: 10, modifier: 0, save: 0 },
      { name: 'con', label: 'CON', score: 14, modifier: 2, save: 2 }, { name: 'int', label: 'INT', score: 8, modifier: -1, save: -1 },
      { name: 'wis', label: 'WIS', score: 12, modifier: 1, save: 4 }, { name: 'cha', label: 'CHA', score: 16, modifier: 3, save: 6 }],
    skills: [{ name: 'Perception', modifier: 3, isProficient: true, isAdvantage: false, isDisadvantage: false },
      { name: 'Stealth', modifier: 0, isProficient: false, isAdvantage: false, isDisadvantage: true }, { name: 'Athletics', modifier: 9, isExpert: true }],
    attacks: [{ name: 'Longsword', toHit: 6, range: { label: 'Reach', value: 5 }, damage: { type: 'Slashing', value: { diceCount: 1, diceValue: 8, fixedValue: 3, diceString: '1d8+3' } } },
      { name: 'Javelin', toHit: 6, range: { value: 30, longRangeValue: 120 }, damage: { type: 'Piercing', value: { diceCount: 1, diceValue: 6, fixedValue: 3, diceString: '1d6 + 3' } }, saveInfo: { value: 13, label: 'DEX' } },
      { name: 'Weird', damage: { value: { diceString: '<script>1d4+1d6</script>' } } }],
    castingInfo: { modifiers: [{ value: 3, sources: ['Paladin'] }], saveDcs: [{ value: 14, sources: ['Paladin'] }], spellAttacks: [{ value: 6, sources: ['Paladin'] }] } };
}

async function fixture(saved = {}, session = {}) {
  const s = { saved: structuredClone(saved), session: structuredClone(session), windows: [], removed: [], clock: 0, date: 1_800_000_000_000, timers: [], sockets: [],
    calls: [], tokens: 0, localClears: 0, shareClears: 0, failSave: false, permitted: true, onLocalSet: null, sessionDelayMs: 0, portrait: 'data:image/webp;base64,UklG', accountId: '42', scdsFails: false,
    characters: [{ id: '123', name: 'Mira', details: 'Level 5 · Human · Paladin 5' }, { id: '456', name: 'Second', details: 'Level 2 · Elf · Rogue 2' }],
    v5: { 123: character(123), 456: { ...character(456), name: 'Second', campaign: null, decorations: { avatarUrl: '' } } }, writes: [] };
  let windowId = 100, timerId = 0;
  const api = { runtime: { id: 'fake', getURL: p => 'chrome-extension://fake/' + p, onStartup: event(), onInstalled: event(),
    connectNative() { const p = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }; s.host = p; return p; } },
    permissions: { contains: async () => s.permitted, onRemoved: event() },
    windows: { onRemoved: event(), create: async options => { s.windows.push(options); const id = ++windowId; return { id, tabs: [{ id: id + 1000 }] }; },
      update: async id => ({ id }), remove: async id => { s.removed.push(id); } },
    storage: {
      local: { get: async () => structuredClone(s.saved), set: async v => {
        const mode = s.onLocalSet?.(v);
        if (mode === 'write-then-fail') { Object.assign(s.saved, structuredClone(v)); throw Error('storage'); }
        if (s.failSave || mode === 'fail') throw Error('storage'); Object.assign(s.saved, structuredClone(v)); },
        remove: async keys => { if (s.removeHold) await s.removeHold; for (const key of [].concat(keys)) delete s.saved[key]; } },
      session: { get: async () => structuredClone(s.session), set: async v => {
        if (s.sessionDelayMs) await new Promise(r => setTimeout(r, s.sessionDelayMs)); Object.assign(s.session, structuredClone(v)); } } } };
  const localReader = { clear() { s.localClears++; }, listCharacters: async () => ({ accountId: s.accountId, characters: structuredClone(s.characters) }), requestCharacter: async () => { throw Error('local reader unused'); } };
  const json = data => ({ status: 200, data });
  const shareReader = {
    clear() { s.shareClears++; },
    async token({ assertScope }) { await assertScope(); s.tokens++; return TOKEN; },
    async requestCharacter(id, url, { method = 'GET', body = null, assertScope }) {
      await assertScope(); s.calls.push({ id, url, method, body: structuredClone(body) });
      const c = s.v5[id];
      if (url === V5 + id && method === 'GET') return json({ success: true, data: structuredClone(c) });
      if (url === SCDS && method === 'POST') return s.scdsFails ? { status: 503, data: null } : json({ foundCharacters: [computed(Number(id), c)] });
      s.writes.push({ url, method, body: structuredClone(body) });
      if (url.endsWith('/life/hp/damage-taken')) { c.removedHitPoints = body.removedHitPoints; c.temporaryHitPoints = body.temporaryHitPoints; return json({ success: true }); }
      if (url.endsWith('/condition')) { c.conditions = c.conditions.filter(x => x.id !== body.id); if (method === 'PUT') c.conditions.push({ id: body.id, level: body.level }); return json({ success: true }); }
      if (url.endsWith('/life/death-saves')) { c.deathSaves = { ...c.deathSaves, failCount: body.failCount, successCount: body.successCount }; return json({ success: true }); }
      return { status: 404, data: null };
    } };
  class FakeSocket { constructor(url) { this.url = url; this.sent = []; this.closed = false; s.sockets.push(this); } send(d) { this.sent.push(d); } close() { this.closed = true; } }
  const timers = { setTimeout: (f, ms) => { const t = { id: ++timerId, f, ms, live: true }; s.timers.push(t); return t.id; }, clearTimeout: id => { const t = s.timers.find(x => x.id === id); if (t) t.live = false; } };
  const local = createLocalApi(api, { reader: localReader });
  const share = createWebShare(api, local, { now: () => s.clock, clock: () => s.date, timers, reader: shareReader, WebSocket: FakeSocket, portraits: { get: async url => url ? s.portrait : null } });
  await share.ready; await tick();
  const picker = { name: 'character-picker', sender: { id: 'fake', url: 'chrome-extension://fake/ui/picker.html' }, onMessage: event(), onDisconnect: event(), postMessage() {} };
  local.acceptPort(picker); let sequence = 0;
  const request = async (type, data = {}) => { await picker.onMessage.emit({ type, requestId: ++sequence, ...data }); await tick(); };
  const port = (name, sender, messages = []) => ({ name, sender, messages, disconnected: false, onMessage: event(), onDisconnect: event(), postMessage: m => messages.push(structuredClone(m)), disconnect() { this.disconnected = true; } });
  const page = async (origin = SITE) => { const p = port('character-share', { url: origin + '/table', origin, frameId: 0, tab: { id: 7, windowId: 1 } }); share.acceptExternal(p); await tick(); return p; };
  const approval = (origin, win = windowId) => { const p = port('character-share-approval', { id: 'fake', url: 'chrome-extension://fake/ui/share.html?origin=' + encodeURIComponent(origin), origin: 'chrome-extension://fake', frameId: 0, tab: { id: win + 1000, windowId: win } }); share.acceptPort(p); return p; };
  const sites = () => { const p = port('character-share-sites', { id: 'fake', url: 'chrome-extension://fake/ui/picker.html', origin: 'chrome-extension://fake', frameId: 0 }); share.acceptPort(p); return p; };
  const select = async id => { await request('list_characters'); await request('select_character', { characterId: id }); };
  // Runs the live timers with this delay (e.g. the 20 s sheet poll), then settles.
  const advance = async ms => { s.clock += ms; s.date += ms; for (const t of s.timers.filter(t => t.live && t.ms === ms)) { t.live = false; t.f(); } await tick(); };
  const send = async (p, m) => { await p.onMessage.emit(m); await tick(); };
  const close = async p => { await p.onDisconnect.emit(); await tick(); };
  return { s, api, local, share, page, approval, sites, select, request, advance, send, close, stop: () => { share.stop(); local.disable(); } };
}
const of = (p, type) => p.messages.filter(m => m.type === type);
async function approve(h, origin = SITE, scopes = ALL) {
  const p = await h.page(origin); await h.send(p, { type: 'request_access' });
  const window = h.approval(origin); await h.send(window, { type: 'decide', share: true, scopes });
  return p;
}

test('scopes: v1 approvals stay identity-only, request_access upgrades them, and the popup toggles each scope', async () => {
  const h = await fixture({ sharedOrigins: [SITE] });
  try {
    await h.select('123');
    const p = await h.page();
    expect(of(p, 'state')[0]).toMatchObject({ version: 2, approved: true, scopes: { identity: true, ...NO_SCOPES }, relay: { state: 'off' }, selected: { id: '123' } });
    expect(of(p, 'sheet')).toEqual([]);
    await h.send(p, { type: 'request_access' });
    expect(h.s.windows).toHaveLength(1);
    const window = h.approval(SITE);
    expect(window.messages).toEqual([{ type: 'approval', origin: SITE, character: 'Mira', upgrade: true, current: NO_SCOPES }]);
    await h.send(window, { type: 'decide', share: true, scopes: { sheet: true, rolls: false, write: true } });
    expect(of(p, 'state').at(-1).scopes).toEqual({ identity: true, sheet: true, rolls: false, write: true });
    expect(h.s.saved.sharedOrigins).toEqual([SITE]);
    expect(h.s.saved.sharedScopes).toEqual({ [SITE]: { sheet: true, rolls: false, write: true } });
    expect(of(p, 'sheet')).toHaveLength(1);

    // Still missing a scope: asking again reopens the window; Keep current changes nothing and cools down.
    await h.send(p, { type: 'request_access' });
    expect(h.s.windows).toHaveLength(2);
    const again = h.approval(SITE);
    expect(again.messages[0]).toMatchObject({ upgrade: true, current: { sheet: true, rolls: false, write: true } });
    await h.send(again, { type: 'decide', share: false, scopes: NO_SCOPES });
    expect(of(p, 'state').at(-1)).toMatchObject({ approved: true, scopes: { sheet: true, rolls: false, write: true } });
    const fresh = await h.page(); await h.send(fresh, { type: 'request_access' });
    expect(of(fresh, 'state').at(-1).retry_after_ms).toBe(15000); expect(h.s.windows).toHaveLength(2);

    // An invalid decision disconnects the window and grants nothing.
    h.s.clock += 20000;
    await h.send(fresh, { type: 'request_access' }); const bad = h.approval(SITE);
    await h.send(bad, { type: 'decide', share: true, scopes: { sheet: true, rolls: 'yes', write: true } });
    expect(bad.disconnected).toBe(true); expect(h.s.saved.sharedScopes[SITE].rolls).toBe(false);

    // Popup: list with scopes, lower write at once, then Stop sharing.
    const manager = h.sites(); await tick();
    expect(manager.messages.at(-1)).toEqual({ type: 'sites', sites: [{ origin: SITE, state: 'shared', scopes: { sheet: true, rolls: false, write: true } }] });
    await h.send(manager, { type: 'scopes', origin: SITE, scopes: { sheet: true, rolls: true, write: false } });
    expect(of(p, 'state').at(-1).scopes).toEqual({ identity: true, sheet: true, rolls: true, write: false });
    expect(h.s.saved.sharedScopes[SITE]).toEqual({ sheet: true, rolls: true, write: false });
    expect(manager.messages.at(-1).sites[0].scopes).toEqual({ sheet: true, rolls: true, write: false });
    await h.send(manager, { type: 'scopes', origin: SITE, scopes: { sheet: true, write: false } });
    expect(manager.disconnected).toBe(true);
    const restarted = await fixture(h.s.saved, h.s.session); await restarted.select('123');
    const later = await restarted.page(); expect(of(later, 'state')[0].scopes).toEqual({ identity: true, sheet: true, rolls: true, write: false }); restarted.stop();

    // Every scope granted: request_access is ignored.
    const all = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: ALL } }); await all.select('123');
    const full = await all.page(); await all.send(full, { type: 'request_access' }); expect(all.s.windows).toHaveLength(0); all.stop();
  } finally { h.stop(); }
});

test('scopes: a reduction that cannot be saved stops sharing instead of keeping the old scopes', async () => {
  const h = await fixture({ sharedOrigins: [SITE, LOCAL], sharedScopes: { [SITE]: ALL, [LOCAL]: { sheet: true, rolls: 'x', bogus: 1 }, 'https://gone.ts.net': ALL, x: 5 } });
  try {
    await h.select('123');
    const p = await h.page(), local = await h.page(LOCAL);
    expect(of(local, 'state')[0].scopes).toEqual({ identity: true, sheet: true, rolls: false, write: false });
    const manager = h.sites(); await tick();
    h.s.failSave = true;
    await h.send(manager, { type: 'scopes', origin: SITE, scopes: { sheet: true, rolls: true, write: false } });
    expect(of(p, 'state').some(m => m.approved && !m.scopes.write)).toBe(true); // Lowered before the save was attempted.
    expect(of(p, 'state').at(-1)).toMatchObject({ approved: false, selected: null }); expect(p.disconnected).toBe(true);
    expect(manager.messages.at(-1).sites).toContainEqual({ origin: SITE, state: 'unsaved', scopes: NO_SCOPES });
    // Raising a scope whose save and rollback both fail (storage may hold the raise) stops sharing too.
    await h.send(manager, { type: 'scopes', origin: LOCAL, scopes: ALL });
    expect(of(local, 'state').at(-1)).toMatchObject({ approved: false, selected: null }); expect(local.disconnected).toBe(true);
    expect(of(local, 'state').every(m => !m.scopes.write)).toBe(true);
  } finally { h.stop(); }
});

test('sheet projection follows the contract from v5 + SCDS and tolerates missing or odd fields', () => {
  const sheet = buildSheet(character(), computed(), 1234);
  expect(sheet).toEqual({
    summary: 'Level 5 · Human · Paladin 5', level: 5, ac: 18, initiative: 1, proficiency: 3, speed: '30 ft.', inspiration: true,
    hp: { current: 38, max: 45, temp: 4 }, passives: { perception: 13, investigation: 10, insight: 13 },
    abilities: [{ key: 'str', score: 16, modifier: 3, save: 3, save_proficient: false }, { key: 'dex', score: 10, modifier: 0, save: 0, save_proficient: false },
      { key: 'con', score: 14, modifier: 2, save: 2, save_proficient: false }, { key: 'int', score: 8, modifier: -1, save: -1, save_proficient: false },
      { key: 'wis', score: 12, modifier: 1, save: 4, save_proficient: true }, { key: 'cha', score: 16, modifier: 3, save: 6, save_proficient: true }],
    skills: [{ name: 'Perception', ability: 'wis', modifier: 3, proficient: true, advantage: false, disadvantage: false },
      { name: 'Stealth', ability: 'dex', modifier: 0, proficient: false, advantage: false, disadvantage: true },
      { name: 'Athletics', ability: 'str', modifier: 9, proficient: true, advantage: false, disadvantage: false }],
    attacks: [{ name: 'Longsword', to_hit: 6, damage: '1d8+3', damage_type: 'Slashing', range: 'Reach 5 ft.', notes: null },
      { name: 'Javelin', to_hit: 6, damage: '1d6+3', damage_type: 'Piercing', range: '30/120 ft.', notes: 'DC 13 DEX' },
      { name: 'Weird', to_hit: null, damage: null, damage_type: null, range: null, notes: null }],
    spells: [{ name: 'Light', level: 0, to_hit: null, save_dc: null, save_ability: null, damage: null, prepared: true, school: 'Evocation', casting_time: null, range: 'Touch' },
      { name: 'Bless', level: 1, to_hit: null, save_dc: null, save_ability: null, damage: null, prepared: true, school: 'Enchantment', casting_time: '1 action', range: '30 ft.' },
      { name: 'Command', level: 1, to_hit: null, save_dc: 14, save_ability: 'wis', damage: null, prepared: false, school: 'Enchantment', casting_time: '1 action', range: '60 ft.' },
      { name: 'Searing Smite', level: 1, to_hit: null, save_dc: null, save_ability: null, damage: '1d6', prepared: true, school: null, casting_time: '1 bonus action', range: 'Self' }],
    spell_slots: [{ level: 1, used: 1, max: 4, pact: false }, { level: 2, used: 0, max: 2, pact: false }],
    conditions: [{ id: 4, level: 2 }, { id: 12, level: null }], death_saves: { success: 0, fail: 0 }, fetched_at: 1234 });
  for (const d of sheet.attacks.map(a => a.damage).filter(Boolean)) expect(d).toMatch(/^(?:\d+d\d+(?:[+-]\d+)*|\d+)$/u);

  // SCDS unavailable or inconsistent: computed values are null, never guessed.
  const v5 = character(); v5.removedHitPoints = 1;
  expect(buildSheet(v5, computed(123, character()), 1)).toMatchObject({ hp: null, ac: 18 });
  expect(buildSheet(character(), null, 1)).toMatchObject({ summary: 'Level 5 · Human · Paladin 5', level: 5, ac: null, hp: null, speed: null, initiative: null,
    passives: { perception: null, investigation: null, insight: null }, skills: [], attacks: [], conditions: [{ id: 4, level: 2 }, { id: 12, level: null }] });
  expect(buildSheet(character(), null, 1).abilities[0]).toEqual({ key: 'str', score: null, modifier: null, save: null, save_proficient: false });
  const multi = character(); multi.classes.push({ id: 78, level: 3, definition: { name: 'Sorcerer', spellRules: { multiClassSpellSlotDivisor: 1, levelSpellSlots: [[], [2], [3], [4, 2]] } } });
  multi.classes[0].definition.spellRules.multiClassSpellSlotDivisor = 2;
  expect(buildSheet(multi, null, 1).spell_slots).toEqual([{ level: 1, used: 1, max: 4, pact: false }, { level: 2, used: 0, max: 3, pact: false }, { level: 3, used: 0, max: 2, pact: false }]);
  multi.classes[1].definition.spellRules.multiClassSpellSlotDivisor = undefined;
  expect(buildSheet(multi, null, 1).spell_slots).toEqual([{ level: 1, used: 1, max: null, pact: false }]);

  // Arbitrary shapes never throw and every field of the contract is present.
  const keys = Object.keys(sheet);
  for (const [a, b] of [[null, null], [{}, {}], [[], 'x'], [{ classes: 'x', race: 5, spells: [], classSpells: [{ spells: [null, 1, { definition: { name: 5 } }] }], conditions: [{ id: 99 }, null, { id: 3, level: 9 }], deathSaves: { failCount: 9 } },
    { abilities: [null, { name: 'str', score: 'x' }], skills: 'x', attacks: [null, { name: '' }, { name: 'A', toHit: 1.5, damage: { value: -3 } }], speeds: [{ name: 'Fly', distance: 60 }, { name: 'Swim' }], hitPointInfo: 'x' }]]) {
    const built = buildSheet(a, b, 5);
    expect(Object.keys(built)).toEqual(keys);
    expect(JSON.stringify(built)).not.toContain('undefined');
  }
  const odd = buildSheet({ conditions: [{ id: 99 }, null, { id: 3, level: 9 }], deathSaves: { failCount: 9 } }, { attacks: [{ name: 'A', toHit: 1.5, damage: { value: -3 } }], speeds: [{ name: 'Fly', distance: 60 }, { name: 'Swim' }] }, 5);
  expect(odd).toMatchObject({ conditions: [{ id: 3, level: null }], death_saves: null, attacks: [{ name: 'A', to_hit: null, damage: null }], speed: null, summary: '', level: null });

  // Large sheets stay within the limits.
  const huge = character(); huge.classSpells[0].spells = Array.from({ length: 2000 }, (_, i) => ({ prepared: true, definition: { name: 'Spell ' + i + ' ' + 'x'.repeat(100), level: i % 10, school: 'Evocation' } }));
  const big = buildSheet(huge, computed(), 1);
  expect(big.spells.length).toBeLessThanOrEqual(300); expect(new TextEncoder().encode(JSON.stringify(big)).length).toBeLessThan(90 * 1024);
});

test('one shared 20 s poll fans out deduplicated sheets; portraits are sent first and on change; refresh is limited', async () => {
  const h = await fixture({ sharedOrigins: [SITE, LOCAL], sharedScopes: { [SITE]: ALL, [LOCAL]: { sheet: true, rolls: false, write: false } } });
  try {
    await h.select('123');
    const a = await h.page(), b = await h.page(), c = await h.page(LOCAL);
    const v5Reads = () => h.s.calls.filter(x => x.url === V5 + '123').length, scdsReads = () => h.s.calls.filter(x => x.url === SCDS).length;
    for (const p of [a, b, c]) {
      expect(of(p, 'sheet')).toHaveLength(1);
      expect(of(p, 'sheet')[0]).toMatchObject({ character_id: '123', revision: 1, portrait: h.s.portrait, sheet: { hp: { current: 38, max: 45, temp: 4 }, fetched_at: h.s.date } });
    }
    const pollReads = v5Reads(); expect(scdsReads()).toBe(1); // One poll for three ports, not one per port.
    expect(JSON.stringify([a, b, c].flatMap(p => p.messages))).not.toContain(TOKEN);

    await h.advance(20000); // Nothing changed: no repeated sheet.
    expect(scdsReads()).toBe(2); for (const p of [a, b, c]) expect(of(p, 'sheet')).toHaveLength(1);
    h.s.v5[123].removedHitPoints = 10; await h.advance(20000);
    for (const p of [a, b, c]) expect(of(p, 'sheet').at(-1)).toMatchObject({ portrait: null, sheet: { hp: { current: 35 } } });
    h.s.portrait = 'data:image/webp;base64,CHANGED'; await h.advance(20000);
    expect(of(a, 'sheet').at(-1).portrait).toBe('data:image/webp;base64,CHANGED');

    // refresh: at most once per 5 s per origin; ignored without the sheet scope.
    const before = scdsReads();
    await h.send(a, { type: 'refresh' }); await h.send(b, { type: 'refresh' });
    expect(scdsReads()).toBe(before + 1);
    h.s.clock += 5000; await h.send(b, { type: 'refresh' }); expect(scdsReads()).toBe(before + 2);
    expect(a.disconnected).toBe(false);

    // Selection change: the new character's sheet follows with the new revision; no campaign is fine.
    await h.request('select_character', { characterId: '456' });
    expect(of(a, 'sheet').at(-1)).toMatchObject({ character_id: '456', revision: 2, portrait: null });
    expect(of(a, 'state').at(-1)).toMatchObject({ selected: { id: '456' }, revision: 2 });

    // Closing every sheet port stops the poll.
    for (const p of [a, b, c]) await h.close(p);
    const reads = scdsReads(); await h.advance(20000); expect(scdsReads()).toBe(reads);
    expect(v5Reads()).toBeGreaterThanOrEqual(pollReads);
  } finally { h.stop(); }
});

test('sheets, rolls and writes do not depend on the Windows helper', async () => {
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: ALL } });
  try {
    await h.select('123');
    // The helper is missing: the native port disconnects and the picker's reader is cleared.
    await h.s.host.onDisconnect.emit(); await tick();
    expect(h.local.status().phase).toBe('retry_wait'); expect(h.s.localClears).toBeGreaterThan(0);
    const p = await h.page();
    expect(of(p, 'state')[0]).toMatchObject({ helper: 'unavailable', approved: true });
    expect(of(p, 'sheet')).toHaveLength(1);
    await h.s.host.onDisconnect.emit(); await h.advance(20000);
    h.s.v5[123].temporaryHitPoints = 0; await h.advance(20000);
    expect(of(p, 'sheet').at(-1).sheet.hp).toEqual({ current: 38, max: 45, temp: 0 });
    await h.send(p, { type: 'apply', op_id: 'helperless', character_id: '123', op: 'heal', amount: 3, expected: null });
    expect(of(p, 'applied').at(-1)).toEqual({ type: 'applied', op_id: 'helperless', state: 'verified', reason: null });
    expect(h.s.shareClears).toBe(0);
    expect(h.s.sockets).toHaveLength(1);
  } finally { h.stop(); }
});

test('apply: write scope, selected character, idempotent op_id, rate limit and verified readback', async () => {
  const h = await fixture({ sharedOrigins: [SITE, LOCAL], sharedScopes: { [SITE]: ALL, [LOCAL]: { sheet: true, rolls: false, write: false } } });
  try {
    await h.select('123');
    const p = await approveless(h);
    const applied = () => of(p, 'applied').at(-1);
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'op-1', character_id: '123', op: 'damage', amount: 6, expected: { current: 38, maximum: 45, temporary: 4 } });
    expect(applied()).toEqual({ type: 'applied', op_id: 'op-1', state: 'verified', reason: null });
    expect(h.s.writes).toEqual([{ url: 'https://character-service.dndbeyond.com/character/v5/life/hp/damage-taken', method: 'PUT', body: { characterId: 123, removedHitPoints: 9, temporaryHitPoints: 0 } }]);
    expect(of(p, 'sheet').at(-1).sheet.hp).toEqual({ current: 36, max: 45, temp: 0 }); // Sheet sent after the apply.
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'op-1', character_id: '123', op: 'damage', amount: 6, expected: { current: 38, maximum: 45, temporary: 4 } });
    expect(applied()).toEqual({ type: 'applied', op_id: 'op-1', state: 'verified', reason: null }); expect(h.s.writes).toHaveLength(1);
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'op-2', character_id: '123', op: 'heal', amount: 2, expected: { current: 38, maximum: 45, temporary: 4 } });
    expect(applied()).toEqual({ type: 'applied', op_id: 'op-2', state: 'conflict', reason: 'expected_hp_changed' }); expect(h.s.writes).toHaveLength(1);
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'op-3', character_id: '123', op: 'temp', amount: 5 });
    expect(applied()).toMatchObject({ state: 'verified' }); expect(h.s.v5[123].temporaryHitPoints).toBe(5);
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'op-4', character_id: '123', op: 'damage', amount: 0, expected: null });
    expect(applied()).toMatchObject({ state: 'rejected', reason: 'invalid' });

    // Conditions and death saves: read first, verified without a write when already so.
    const writes = h.s.writes.length;
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'c-1', character_id: '123', op: 'condition', condition: 12, on: true, level: null });
    expect(applied()).toMatchObject({ op_id: 'c-1', state: 'verified' }); expect(h.s.writes).toHaveLength(writes);
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'c-2', character_id: '123', op: 'condition', condition: 3, on: true, level: null });
    expect(applied()).toMatchObject({ op_id: 'c-2', state: 'verified', reason: null });
    expect(h.s.writes.at(-1)).toEqual({ url: 'https://character-service.dndbeyond.com/character/v5/condition', method: 'PUT', body: { characterId: 123, id: 3, level: null } });
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'c-3', character_id: '123', op: 'condition', condition: 4, on: true, level: 3 });
    expect(applied()).toMatchObject({ op_id: 'c-3', state: 'verified' }); expect(h.s.v5[123].conditions).toContainEqual({ id: 4, level: 3 });
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'c-4', character_id: '123', op: 'condition', condition: 12, on: false });
    expect(applied()).toMatchObject({ op_id: 'c-4', state: 'verified' }); expect(h.s.writes.at(-1).method).toBe('DELETE');
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'c-5', character_id: '123', op: 'condition', condition: 4, on: true, level: null });
    expect(applied()).toMatchObject({ op_id: 'c-5', state: 'rejected', reason: 'invalid' });
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'd-1', character_id: '123', op: 'death_saves', success: 1, fail: 2 });
    expect(applied()).toMatchObject({ op_id: 'd-1', state: 'verified' }); expect(h.s.v5[123].deathSaves).toMatchObject({ successCount: 1, failCount: 2 });
    const before = h.s.writes.length;
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'd-2', character_id: '123', op: 'death_saves', success: 1, fail: 2 });
    expect(applied()).toMatchObject({ op_id: 'd-2', state: 'verified' }); expect(h.s.writes).toHaveLength(before);

    // Wrong character, missing write scope, then the per-origin rate limit.
    h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'w-1', character_id: '456', op: 'heal', amount: 1 });
    expect(applied()).toEqual({ type: 'applied', op_id: 'w-1', state: 'rejected', reason: 'character' });
    const local = await h.page(LOCAL);
    await h.send(local, { type: 'apply', op_id: 'w-2', character_id: '123', op: 'heal', amount: 1 });
    expect(of(local, 'applied')).toEqual([{ type: 'applied', op_id: 'w-2', state: 'rejected', reason: 'scope' }]);
    expect(h.s.writes).toHaveLength(before);
    const used = 11; // op-1..op-4, c-1..c-5, d-1 and d-2 count; the repeated op-1 and the rejected w-1/w-2 do not
    for (let i = used + 1; i <= 20; i++) { h.s.clock += 100; h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'r' + i, character_id: '123', op: 'temp', amount: 5 }); }
    expect(applied()).not.toMatchObject({ reason: 'rate' });
    h.s.clock += 1000; h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'r-over', character_id: '123', op: 'temp', amount: 5 });
    expect(applied()).toEqual({ type: 'applied', op_id: 'r-over', state: 'rejected', reason: 'rate' });
    h.s.clock += 60000; h.s.date += 60000; h.s.clock += 150; await h.send(p, { type: 'apply', op_id: 'r-over', character_id: '123', op: 'temp', amount: 6 });
    expect(applied()).toMatchObject({ op_id: 'r-over', state: 'verified' }); // A rejected op_id was not stored.

    // Outcomes survive a worker restart; an op dispatched before the restart is never re-applied.
    expect(h.s.session.shareApplies.length).toBeLessThanOrEqual(200);
    const restarted = await fixture({ ...h.s.saved }, { ...h.s.session, shareApplies: [...h.s.session.shareApplies, [SITE + '\nlost', { state: 'pending', reason: null }]] });
    try {
      await restarted.select('123');
      const q = await restarted.page();
      await restarted.send(q, { type: 'apply', op_id: 'op-1', character_id: '123', op: 'damage', amount: 6, expected: null });
      expect(of(q, 'applied').at(-1)).toEqual({ type: 'applied', op_id: 'op-1', state: 'verified', reason: null });
      await restarted.send(q, { type: 'apply', op_id: 'lost', character_id: '123', op: 'damage', amount: 6, expected: null });
      expect(of(q, 'applied').at(-1)).toEqual({ type: 'applied', op_id: 'lost', state: 'unknown', reason: 'interrupted' });
      expect(restarted.s.writes).toEqual([]);
    } finally { restarted.stop(); }

    // Malformed applies disconnect.
    for (const bad of [{ type: 'apply', op_id: 'x y', character_id: '123', op: 'heal', amount: 1 }, { type: 'apply', op_id: 'a', character_id: 123, op: 'heal', amount: 1 },
      { type: 'apply', op_id: 'a', character_id: '123', op: 'heal', amount: -1 }, { type: 'apply', op_id: 'a', character_id: '123', op: 'heal', amount: 1, extra: 1 },
      { type: 'apply', op_id: 'a', character_id: '123', op: 'condition', condition: 16, on: true }, { type: 'apply', op_id: 'a', character_id: '123', op: 'death_saves', success: 4, fail: 0 },
      { type: 'apply', op_id: 'a'.repeat(41), character_id: '123', op: 'heal', amount: 1 }, { type: 'apply', op_id: 'a', character_id: '123', op: 'heal', amount: 1, expected: { current: 1 } }]) {
      expect(applyShape(bad)).toBe(false);
      const q = await h.page(); await h.send(q, bad); expect(q.disconnected).toBe(true);
    }
  } finally { h.stop(); }
});
async function approveless(h) { const p = await h.page(); expect(of(p, 'sheet')).toHaveLength(1); return p; }

test('rolls: game-log frames for the selected character are mapped, filtered, deduplicated and buffered', async () => {
  const h = await fixture({ sharedOrigins: [SITE, LOCAL], sharedScopes: { [SITE]: ALL, [LOCAL]: { sheet: true, rolls: false, write: false } } });
  try {
    await h.select('123');
    const p = await h.page(), other = await h.page(LOCAL);
    expect(h.s.sockets).toHaveLength(1);
    const socket = h.s.sockets[0];
    expect(socket.url).toBe(`wss://game-log-api-live.dndbeyond.com/v1?gameId=9001&userId=42&stt=${TOKEN}`);
    expect(of(p, 'state').at(-1).relay).toEqual({ state: 'unavailable', detail: 'connecting' });
    socket.onopen(); await tick();
    expect(of(p, 'state').at(-1).relay).toEqual({ state: 'listening' }); expect(of(other, 'state').at(-1).relay).toEqual({ state: 'off' });
    const frame = (rollId, extra = {}, data = {}) => JSON.stringify({ id: 'm-' + rollId, dateTime: '1800000000123', gameId: '9001', userId: '42', eventType: 'dice/roll/fulfilled',
      entityId: '123', entityType: 'character', messageScope: 'gameId', messageTarget: '9001', ...extra,
      data: { rollId, action: 'Longsword', context: { entityId: '123', entityType: 'character', name: 'Mira' },
        rolls: [{ diceNotation: { set: [{ count: 1, dieType: 'd20', dice: [{ dieType: 'd20', dieValue: 14 }], operation: 0 }], constant: 6 }, rollType: 'to hit', rollKind: '', result: { total: 20 } }], ...data } });
    socket.onmessage({ data: frame('r1') });
    socket.onmessage({ data: frame('r2', { messageScope: 'userId', messageTarget: '7' }, { action: 'dex', rolls: [{ diceNotation: { set: [{ count: 2, dieType: 'd20', dice: [{ dieValue: 3 }, { dieValue: 17 }], operation: 2 }], constant: -1 }, rollType: 'check', rollKind: 'advantage', result: { total: 16 } }] }) });
    socket.onmessage({ data: frame('r3', { messageScope: 'userId', messageTarget: '42' }) }); // Self roll.
    socket.onmessage({ data: frame('r4', { entityId: '999' }) }); // Another character.
    socket.onmessage({ data: frame('r5', { eventType: 'dice/roll/pending' }) });
    socket.onmessage({ data: frame('r1') }); // Resent after a reconnect.
    socket.onmessage({ data: 'pong' }); socket.onmessage({ data: '{"broken' }); socket.onmessage({ data: 'x'.repeat(300000) });
    socket.onmessage({ data: frame('r6', {}, { action: 'Mira\u0019s <i>Initiative</i>', rolls: [{ diceNotation: { set: [{ count: 2, dieType: 'd6', dice: [{ dieValue: 2 }, { dieValue: 5 }] }, { count: 1, dieType: 'd8', dice: [{ dieValue: 8 }] }], constant: 0 }, rollType: 'fire', rollKind: 'critical hit', result: { total: 15 } }] }) });
    await tick();
    const rolls = of(p, 'roll');
    expect(rolls.map(r => r.roll.roll_id)).toEqual(['r1', 'r2', 'r6']);
    expect(rolls[0]).toEqual({ type: 'roll', character_id: '123', roll: { roll_id: 'r1', label: 'Longsword', to: 'everyone', advantage: null, initiative: false, at_ms: 1800000000123,
      rolls: [{ type: 'to hit', kind: '', notation: '1d20+6', dice: [{ sides: 20, values: [14], keep: 'all' }], constant: 6, total: 20 }] } });
    expect(rolls[1].roll).toMatchObject({ label: 'Dexterity', to: 'dm', advantage: 'advantage', rolls: [{ type: 'check', kind: 'advantage', notation: '2d20-1', dice: [{ sides: 20, values: [3, 17], keep: 'highest' }], constant: -1, total: 16 }] });
    expect(rolls[2].roll).toMatchObject({ label: 'Mira’s Initiative', rolls: [{ type: 'damage', kind: 'critical hit', notation: '2d6+1d8', constant: 0, total: 15 }] });
    expect(of(other, 'roll')).toEqual([]);

    // A reconnecting port gets the last 30 s again (deduplicated by roll_id on the page).
    const late = await h.page(); await tick();
    expect(of(late, 'roll').map(r => r.roll.roll_id)).toEqual(['r1', 'r2', 'r6']);
    h.s.date += 31000; const later = await h.page(); await tick(); expect(of(later, 'roll')).toEqual([]);

    // Keep-alive ping every 20 s is the only thing ever sent to D&D Beyond.
    await h.advance(20000); expect(socket.sent).toEqual(['{"data":"ping"}']);
    // The socket closes: visible error, reconnect after backoff with a fresh token.
    const tokens = h.s.tokens;
    socket.onclose({ code: 1006 }); await tick();
    expect(of(p, 'state').at(-1).relay).toEqual({ state: 'error', detail: 'closed_1006' });
    await h.advance(1000); expect(h.s.sockets).toHaveLength(2); expect(h.s.tokens).toBe(tokens + 1);
    h.s.sockets[1].onclose({ code: 1008 }); await tick(); await h.advance(2000); expect(h.s.sockets).toHaveLength(3);
    h.s.sockets[2].onopen(); await tick(); expect(of(p, 'state').at(-1).relay).toEqual({ state: 'listening' });
    expect(h.s.sockets.flatMap(x => x.sent).every(m => m === '{"data":"ping"}')).toBe(true);

    // A character without a campaign: no socket, relay no_campaign.
    await h.request('select_character', { characterId: '456' });
    expect(h.s.sockets[2].closed).toBe(true); expect(h.s.sockets).toHaveLength(3);
    expect(of(p, 'state').at(-1).relay).toEqual({ state: 'no_campaign' });
    await h.request('select_character', { characterId: '123' }); expect(h.s.sockets).toHaveLength(4);

    // The socket stays open only while a rolls port is open.
    for (const x of [p, late, later]) await h.close(x);
    expect(h.s.sockets[3].closed).toBe(true);
  } finally { h.stop(); }
});

test('roll mapping drops malformed frames and keeps text plain', () => {
  const base = { eventType: 'dice/roll/fulfilled', entityType: 'character', entityId: 5, messageScope: 'gameId', dateTime: 1700000000,
    data: { rollId: 'abc', action: 'cha', rolls: [{ diceNotation: { set: [{ count: 2, dieType: 'd20', dice: [{ dieValue: 4 }, { dieValue: 9 }], operation: 1 }], constant: 2 }, rollType: 'save', rollKind: 'weird' }] } };
  expect(mapGameLogMessage(base, { characterId: '5', userId: '1' })).toEqual({ roll_id: 'abc', label: 'Charisma', to: 'everyone', advantage: 'disadvantage', initiative: false, at_ms: 1700000000000,
    rolls: [{ type: 'save', kind: '', notation: '2d20+2', dice: [{ sides: 20, values: [4, 9], keep: 'lowest' }], constant: 2, total: 6 }] });
  for (const broken of [null, 'x', { ...base, data: null }, { ...base, messageScope: 'userId' }, { ...base, messageScope: 'other' }, { ...base, data: { ...base.data, rollId: 'a b' } },
    { ...base, data: { ...base.data, rolls: [] } }, { ...base, data: { ...base.data, rolls: [{ diceNotation: { set: [{ dieType: 'd0', dice: [] }] } }] } },
    { ...base, data: { ...base.data, rolls: [{ diceNotation: { set: [{ dieType: 'd6', dice: [{ dieValue: 'x' }] }] } }] } }, { ...base, entityType: 'monster' }]) {
    expect(mapGameLogMessage(broken, { characterId: '5', userId: '1' })).toBeNull();
  }
  const sneaky = mapGameLogMessage({ ...base, data: { ...base.data, action: '<img src=x onerror=alert(1)>Fireball\u0000\u001b' } }, { characterId: '5', userId: '1' });
  expect(sneaky.label).toBe('Fireball’');
});

test('apply: nothing is dispatched while the ledger is unreadable, and the rate window survives a restart', async () => {
  let fail = true; const data = {}; let runs = 0;
  const storage = { get: async keys => { if (fail) throw Error('unreadable'); return Object.fromEntries([].concat(keys).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    set: async v => { if (fail) throw Error('unwritable'); Object.assign(data, structuredClone(v)); } };
  let t = 1_000_000;
  const run = async () => { runs++; return { state: 'verified', reason: null }; };
  const checks = { scope: () => true, character: () => true };
  const op = id => ({ type: 'apply', op_id: id, character_id: '123', op: 'damage', amount: 3, expected: null });
  const a = createApplier({ storage, run, now: () => t });
  expect(await a.apply('https://x.ts.net', op('o1'), checks)).toEqual({ state: 'rejected', reason: 'storage_unavailable' });
  expect(runs).toBe(0);
  fail = false;                                    // storage recovers: the ledger is read before anything is dispatched
  expect(await a.apply('https://x.ts.net', op('o1'), checks)).toEqual({ state: 'verified', reason: null });
  for (let i = 2; i <= 20; i++) await a.apply('https://x.ts.net', op('o' + i), checks);
  expect(await a.apply('https://x.ts.net', op('o21'), checks)).toEqual({ state: 'rejected', reason: 'rate' });
  await new Promise(r => setTimeout(r, 20));
  const b = createApplier({ storage, run, now: () => t + 1000 });   // a restarted worker within the same minute
  expect(await b.apply('https://x.ts.net', op('o22'), checks)).toEqual({ state: 'rejected', reason: 'rate' });
  expect(await b.apply('https://x.ts.net', op('o1'), checks)).toEqual({ state: 'verified', reason: null });   // stored outcome, not re-run
  expect(runs).toBe(20);
  const c = createApplier({ storage, run, now: () => t + 61000 });
  expect(await c.apply('https://x.ts.net', op('o23'), checks)).toEqual({ state: 'verified', reason: null });
});

// Review fixes (cross-provider review of character-share v2).
test('review 1: the cached sheet is only ever delivered for the character it belongs to', async () => {
  const delivered = [], timers = { setTimeout: () => 1, clearTimeout() {} };
  const feed = createSheetFeed({ load: async id => ({ sheet: { id }, portrait: null }), deliver: (id, r) => delivered.push([id, r.sheet.id]), timers, now: () => 0 });
  feed.update('123', true); await tick();
  expect(feed.current('123')).toEqual({ sheet: { id: '123' }, portrait: null });
  expect(feed.current('456')).toBeNull(); expect(feed.current(undefined)).toBeNull();
  feed.update('456', true); expect(feed.current('123')).toBeNull(); await tick();
  expect(delivered).toEqual([['123', '123'], ['456', '456']]);
  feed.forget(); expect(feed.current('456')).toBeNull();

  // In the worker: selection is saved, then published after another storage call. A page that
  // becomes ready in between must not get the previous character's cached sheet as the new one.
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: { sheet: true, rolls: false, write: false } } });
  try {
    await h.select('123');
    const a = await h.page(); expect(of(a, 'sheet').at(-1).sheet.hp.current).toBe(38);
    h.s.v5[456].removedHitPoints = 20; // The second character has 25 HP.
    let release; h.s.removeHold = new Promise(r => { release = r; });
    const switching = h.request('select_character', { characterId: '456' });
    await tick();
    const late = await h.page();
    release(); h.s.removeHold = null; await switching; await tick();
    for (const p of [a, late]) for (const m of of(p, 'sheet')) expect([m.character_id, m.sheet.hp.current]).toEqual(m.character_id === '123' ? ['123', 38] : ['456', 25]);
    expect(of(late, 'sheet').at(-1)).toMatchObject({ character_id: '456', sheet: { hp: { current: 25 } } });
  } finally { h.stop(); }
});

test('review 2: a popup raise whose save and rollback fail stops sharing and stays stopped after a restart', async () => {
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: { sheet: true, rolls: false, write: false } } });
  try {
    await h.select('123');
    const p = await h.page(), manager = h.sites(); await tick();
    // The raise lands in storage, the call reports failure and the rollback fails too.
    h.s.onLocalSet = v => v.sharedScopes?.[SITE]?.write ? 'write-then-fail' : v.sharedOrigins ? 'fail' : null;
    await h.send(manager, { type: 'scopes', origin: SITE, scopes: ALL });
    expect(h.s.saved.sharedScopes[SITE].write).toBe(true); // Storage holds the raise...
    expect(of(p, 'state').every(m => !m.scopes.write)).toBe(true); // ...but it was never granted,
    expect(p.disconnected).toBe(true); expect(manager.messages.at(-1).sites).toEqual([{ origin: SITE, state: 'unsaved', scopes: NO_SCOPES }]);
    expect(h.s.session.pendingRevocations).toEqual([SITE]);
    const restarted = await fixture(h.s.saved, h.s.session, {}); // ...and stays stopped after a worker restart.
    try { await restarted.select('123'); const q = await restarted.page(); expect(of(q, 'state')[0]).toMatchObject({ approved: false, scopes: { write: false } }); }
    finally { restarted.stop(); }
    // A raise that fails cleanly (rollback succeeded) changes nothing and keeps sharing.
    const c = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: { sheet: true, rolls: false, write: false } } });
    try {
      await c.select('123'); const q = await c.page(), m = c.sites(); await tick();
      c.s.onLocalSet = v => v.sharedScopes?.[SITE]?.write ? 'fail' : null;
      await c.send(m, { type: 'scopes', origin: SITE, scopes: ALL });
      expect(of(q, 'state').at(-1)).toMatchObject({ approved: true, scopes: { sheet: true, write: false } }); expect(q.disconnected).toBe(false);
      expect(c.s.saved.sharedScopes[SITE]).toEqual({ sheet: true, rolls: false, write: false });
    } finally { c.stop(); }
  } finally { h.stop(); }
});

test('review 3: Stop sharing closes an open approval window; popup changes re-describe it', async () => {
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: { sheet: true, rolls: false, write: false } } });
  try {
    await h.select('123');
    const p = await h.page(); await h.send(p, { type: 'request_access' });
    const window = h.approval(SITE), manager = h.sites(); await tick();
    expect(window.messages.at(-1)).toMatchObject({ upgrade: true, current: { sheet: true, rolls: false, write: false } });
    await h.send(manager, { type: 'scopes', origin: SITE, scopes: { sheet: true, rolls: true, write: false } });
    expect(window.messages.at(-1)).toMatchObject({ upgrade: true, current: { sheet: true, rolls: true, write: false } });
    await h.send(manager, { type: 'revoke', origin: SITE });
    expect(h.s.removed).toContain(101); expect(window.disconnected).toBe(true);
    // A late click in the stale window grants nothing.
    await h.send(window, { type: 'decide', share: true, scopes: ALL });
    expect(h.share.origins()).toEqual([]); expect(h.s.saved.sharedOrigins).toEqual([]); expect(h.s.saved.sharedScopes).toEqual({});
    // The origin can ask again afterwards (no cooldown was imposed by the stop).
    const again = await h.page(); await h.send(again, { type: 'request_access' }); expect(h.s.windows).toHaveLength(2);
    expect(h.approval(SITE).messages.at(-1)).toMatchObject({ upgrade: false, current: NO_SCOPES });
  } finally { h.stop(); }
});

test('review 4: opposite condition and death-save applies sent back to back end in the last requested state', async () => {
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: ALL } });
  try {
    await h.select('123');
    const p = await h.page(); const before = h.s.writes.length;
    const on = { type: 'apply', op_id: 'q-on', character_id: '123', op: 'condition', condition: 3, on: true, level: null };
    const off = { type: 'apply', op_id: 'q-off', character_id: '123', op: 'condition', condition: 3, on: false, level: null };
    h.s.clock += 200; void p.onMessage.emit(on); h.s.clock += 200; void p.onMessage.emit(off); await tick(); await tick();
    expect(of(p, 'applied').map(m => [m.op_id, m.state])).toEqual([['q-on', 'verified'], ['q-off', 'verified']]);
    expect(h.s.writes.slice(before).map(w => w.method)).toEqual(['PUT', 'DELETE']);
    expect(h.s.v5[123].conditions.some(c => c.id === 3)).toBe(false);
    h.s.clock += 200; void p.onMessage.emit({ type: 'apply', op_id: 'ds-1', character_id: '123', op: 'death_saves', success: 2, fail: 0 });
    h.s.clock += 200; void p.onMessage.emit({ type: 'apply', op_id: 'ds-2', character_id: '123', op: 'death_saves', success: 0, fail: 0 });
    await tick(); await tick();
    expect(of(p, 'applied').slice(-2).map(m => m.state)).toEqual(['verified', 'verified']);
    expect(h.s.v5[123].deathSaves).toMatchObject({ successCount: 0, failCount: 0 });
    expect(h.s.writes.slice(before).map(w => w.url.split('/').at(-1))).toEqual(['condition', 'condition', 'death-saves', 'death-saves']);
  } finally { h.stop(); }
});

test('review 5: requests use only a token of the selected account, and one caller ending does not fail another', async () => {
  const token = id => 'e30.' + Buffer.from(JSON.stringify({ 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': id })).toString('base64url') + '.sig';
  let account = '42', clock = 0, release = null; const calls = [];
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const reader = createHttpReader({ monotonic: () => clock, fetch: async url => {
    calls.push(url);
    if (url.includes('auth-service')) { if (release) await new Promise(r => { const go = release; release = null; go(r); }); return json({ token: token(account), ttl: 60 }); }
    return json({ success: true, data: { id: 123 } });
  } });
  expect((await reader.requestCharacter('123', '/character/v5/character/123', { account: '42' })).status).toBe(200);
  // The browser is now signed in to another account; the cached token expires and a refresh switches accounts.
  account = '43'; clock = 31000;
  await expect(reader.requestCharacter('123', '/character/v5/life/hp/damage-taken', { method: 'PUT', body: {}, account: '42' })).rejects.toThrow('account_mismatch');
  expect(calls.filter(u => u.includes('damage-taken'))).toEqual([]);
  // Without an account pin (the local API) behaviour is unchanged.
  expect((await reader.requestCharacter('123', '/character/v5/character/123')).status).toBe(200);

  // Shared refresh: the first caller's scope ends while the exchange is in flight; the second still succeeds.
  reader.clear(); let resume; release = r => { resume = r; };
  let firstAllowed = true;
  const first = reader.requestCharacter('123', '/character/v5/character/123', { assertScope: () => { if (!firstAllowed) throw Error('scope_ended'); } });
  await expect.poll(() => typeof resume).toBe('function');
  const second = reader.requestCharacter('123', '/character/v5/character/123', { account: '43' });
  firstAllowed = false; resume();
  await expect(first).rejects.toThrow('scope_ended');
  expect((await second).status).toBe(200);
  expect(calls.filter(u => u.includes('auth-service'))).toHaveLength(3);
});

test('review 6: the outcome is saved before the reply, and hp_unavailable leaves the op_id free', async () => {
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: ALL } });
  try {
    await h.select('123');
    const p = await h.page();
    h.s.sessionDelayMs = 20; // Slow session storage: the reply must still wait for the saved outcome.
    const atReply = [];
    const post = p.postMessage; p.postMessage = m => { if (m.type === 'applied') atReply.push(structuredClone(h.s.session.shareApplies ?? [])); post(m); };
    h.s.clock += 200; await p.onMessage.emit({ type: 'apply', op_id: 'slow-1', character_id: '123', op: 'heal', amount: 1, expected: null });
    await expect.poll(() => of(p, 'applied').length).toBe(1);
    expect(atReply[0]).toContainEqual([SITE + '\nslow-1', { state: 'verified', reason: null }]);
    h.s.sessionDelayMs = 0;
    // SCDS unavailable: HP cannot be verified, so nothing is written and the op_id stays usable.
    h.s.scdsFails = true;
    h.s.clock += 200; await h.send(p, { type: 'apply', op_id: 'hp-1', character_id: '123', op: 'damage', amount: 2, expected: null });
    expect(of(p, 'applied').at(-1)).toEqual({ type: 'applied', op_id: 'hp-1', state: 'rejected', reason: 'hp_unavailable' });
    expect(h.s.session.shareApplies.some(([k]) => k === SITE + '\nhp-1')).toBe(false);
    h.s.scdsFails = false;
    h.s.clock += 200; await h.send(p, { type: 'apply', op_id: 'hp-1', character_id: '123', op: 'damage', amount: 2, expected: null });
    expect(of(p, 'applied').at(-1)).toMatchObject({ op_id: 'hp-1', state: 'verified' });
  } finally { h.stop(); }
});

test('review 7: the picker lists and selects characters with no Windows helper, across native retries', async () => {
  const saved = {}; let release; const ports = [];
  const api = { runtime: { id: 'fake', getURL: p => 'chrome-extension://fake/' + p, onStartup: event(), onInstalled: event(),
    connectNative() { const p = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }; ports.push(p); return p; } },
    permissions: { contains: async () => true, onRemoved: event() },
    storage: { local: { get: async () => structuredClone(saved), set: async v => { Object.assign(saved, structuredClone(v)); }, remove: async keys => { for (const k of [].concat(keys)) delete saved[k]; } } } };
  const clears = { native: 0, account: 0 };
  const nativeReader = { clear() { clears.native++; }, listCharacters: async () => { throw Error('native reader must not list'); }, requestCharacter: async () => ({ status: 200, data: {} }) };
  const accountReader = { clear() { clears.account++; }, listCharacters: async ({ assertScope }) => { await new Promise(r => { release = r; }); await assertScope();
    return { accountId: '42', characters: [{ id: '123', name: 'Mira', details: 'Level 5' }] }; } };
  const fake = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
  const local = createLocalApi(api, { reader: nativeReader, accountReader, timers: fake });
  try {
    await local.initialize();
    const replies = [], picker = { name: 'character-picker', sender: { id: 'fake', url: 'chrome-extension://fake/ui/picker.html' }, onMessage: event(), onDisconnect: event(), postMessage: m => replies.push(m) };
    local.acceptPort(picker);
    const listing = picker.onMessage.emit({ type: 'list_characters', requestId: 1 });
    await expect.poll(() => typeof release).toBe('function');
    await ports[0].onDisconnect.emit(); // The helper is missing: the native retry loop disables and clears its reader.
    expect(local.status().phase).toBe('retry_wait'); expect(clears.native).toBe(1);
    release(); await listing;
    expect(replies.find(m => m.requestId === 1)).toMatchObject({ ok: true, data: { account: { phase: 'ready', characters: [{ id: '123' }] } } });
    await picker.onMessage.emit({ type: 'select_character', requestId: 2, characterId: '123' });
    expect(replies.find(m => m.requestId === 2)).toMatchObject({ ok: true, data: { selectedCharacter: { id: '123', name: 'Mira' } } });
    expect(saved.selectedCharacter).toMatchObject({ id: '123', accountId: '42' }); expect(clears.account).toBe(0);
    expect(local.sharedIdentity()).toEqual({ id: '123', name: 'Mira', details: 'Level 5' });
  } finally { local.disable(); }
});

test('review 8-10: roll buffer is capped, permission loss forgets the cached sheet, portraits and text are restricted', async () => {
  const h = await fixture({ sharedOrigins: [SITE], sharedScopes: { [SITE]: ALL } });
  try {
    await h.select('123');
    const p = await h.page(); h.s.sockets[0].onopen(); await tick();
    for (let i = 0; i < 250; i++) h.s.sockets[0].onmessage({ data: JSON.stringify({ eventType: 'dice/roll/fulfilled', entityType: 'character', entityId: '123', messageScope: 'gameId',
      data: { rollId: 'cap-' + i, action: 'x', rolls: [{ diceNotation: { set: [{ count: 1, dieType: 'd6', dice: [{ dieValue: 3 }] }], constant: 0 }, rollType: 'roll' }] } }) });
    await tick();
    expect(of(p, 'roll')).toHaveLength(250); expect(h.s.session.shareRolls.buffer).toHaveLength(200);
    expect(h.s.session.shareRolls.buffer[0].roll.roll_id).toBe('cap-50');

    // Host access removed: newly connecting pages get no cached sheet.
    h.s.permitted = false; await h.api.permissions.onRemoved.emit({ origins: ['https://character-service.dndbeyond.com/*'] }); await tick();
    const late = await h.page(); await tick();
    expect(of(late, 'sheet')).toEqual([]); expect(of(late, 'state').at(-1).relay).toMatchObject({ state: 'unavailable', detail: 'permission_required' });
  } finally { h.stop(); }
  expect(portraitUrl('https://www.dndbeyond.com/avatars/1/2/x.png')).toBe('https://www.dndbeyond.com/avatars/1/2/x.png');
  for (const bad of ['https://www.dndbeyond.com/characters/1', 'https://www.dndbeyond.com/', 'https://www.dndbeyond.com/avatars/x.svg', 'http://www.dndbeyond.com/avatars/x.png', 'https://evil.com/avatars/x.png'])
    expect(portraitUrl(bad)).toBeNull();
  expect(portraitUrl('https://media.dndbeyond.com/a/b.png')).toBe('https://media.dndbeyond.com/a/b.png');
  const tab = String.fromCharCode(9), nl = String.fromCharCode(10), cr = String.fromCharCode(13);
  expect(cleanText('Fire' + tab + 'Bolt' + cr + nl + 'of' + nl + 'Doom')).toBe('Fire Bolt of Doom');
});
