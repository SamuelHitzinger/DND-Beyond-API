import { test, expect } from '@playwright/test';
import { createLocalApi } from '../../extensions/dndbeyond/local-api.js';
import { createWebShare, SHARE_LIMITS } from '../../extensions/dndbeyond/web-share.js';
const event = () => { const listeners = []; return { addListener: f => listeners.push(f), emit: (...args) => Promise.all(listeners.map(f => f(...args))) }; };
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const SITE = 'https://table.example.ts.net:8443', LOCAL = 'http://127.0.0.1:5173';
async function fixture(saved = {}, session = {}, options = {}) {
  const s = { saved: structuredClone(saved), session: structuredClone(session), windows: [], updates: [], removed: [], clock: 0, timers: [], localWrites: [],
    failSave: false, failSession: false, failSessionRead: false, onLocalSet: null, holdCreate: null, accountId: '42',
    characters: [{ id: '123', name: 'First', details: 'Level 5 · Elf · Wizard 5' }, { id: '456', name: 'Second', details: 'Level 2 · Human · Fighter 2' }] };
  let windowId = 100;
  const api = { runtime: { id: 'fake', getURL: p => 'chrome-extension://fake/' + p, onStartup: event(), onInstalled: event(),
    connectNative() { const p = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }; s.host = p; return p; } },
    permissions: { contains: async () => true, onRemoved: event() },
    windows: { onRemoved: event(),
      create: async options => { s.windows.push(options); if (s.holdCreate) await s.holdCreate; const id = ++windowId; return { id, tabs: [{ id: id + 1000 }] }; },
      update: async (id, options) => { if (s.removed.includes(id)) throw Error('No window'); s.updates.push({ id, options }); return { id }; },
      remove: async id => { s.removed.push(id); } },
    storage: {
      local: { get: async () => structuredClone(s.saved),
        set: async v => {
          s.localWrites.push(structuredClone(v)); const mode = s.onLocalSet?.(v);
          if (mode === 'write-then-fail') { Object.assign(s.saved, structuredClone(v)); throw Error('storage'); }
          if (mode === 'fail' || s.failSave) throw Error('storage');
          Object.assign(s.saved, structuredClone(v));
        }, remove: async keys => { for (const key of [].concat(keys)) delete s.saved[key]; } },
      session: { get: async () => { if (s.failSessionRead) throw Error('session'); return structuredClone(s.session); },
        set: async v => { if (s.failSession) throw Error('session'); Object.assign(s.session, structuredClone(v)); } } } };
  Object.assign(s, options);
  const reader = { clear() {}, listCharacters: async () => ({ accountId: s.accountId, characters: structuredClone(s.characters) }), requestCharacter: async () => ({ status: 200, data: {} }) };
  const timers = { setTimeout: f => { s.timers.push(f); return s.timers.length; }, clearTimeout() {} };
  const local = createLocalApi(api, { reader }), share = createWebShare(api, local, { now: () => s.clock, timers });
  await share.ready; await tick();
  const picker = { name: 'character-picker', sender: { id: 'fake', url: 'chrome-extension://fake/ui/picker.html' }, onMessage: event(), onDisconnect: event(), postMessage() {} };
  local.acceptPort(picker); let sequence = 0;
  const request = async (type, data = {}) => { await picker.onMessage.emit({ type, requestId: ++sequence, ...data }); };
  const port = (name, sender, messages = []) => ({ name, sender, messages, disconnected: false, onMessage: event(), onDisconnect: event(), postMessage: m => messages.push(structuredClone(m)), disconnect() { this.disconnected = true; } });
  const page = (origin = SITE, extra = {}) => {
    const p = port('character-share', { url: origin + '/table/play?x=1', origin, frameId: 0, tab: { id: 7, windowId: 1 }, ...extra });
    share.acceptExternal(p); return p;
  };
  // By default the page inside the most recently created popup window.
  const approval = (origin, win = windowId, tab = win + 1000) => {
    const p = port('character-share-approval', { id: 'fake', url: 'chrome-extension://fake/ui/share.html?origin=' + encodeURIComponent(origin), origin: 'chrome-extension://fake', frameId: 0, tab: { id: tab, windowId: win } });
    share.acceptPort(p); return p;
  };
  const sites = () => { const p = port('character-share-sites', { id: 'fake', url: 'chrome-extension://fake/ui/picker.html', origin: 'chrome-extension://fake', frameId: 0 }); share.acceptPort(p); return p; };
  const select = async id => { await request('list_characters'); await request('select_character', { characterId: id }); };
  const runTimers = async () => { for (const f of s.timers.splice(0)) f(); await tick(); };
  return { s, api, local, share, page, approval, sites, select, request, runTimers };
}
const states = p => p.messages.filter(m => m.type === 'state');
async function ask(h, origin = SITE) { const p = h.page(origin); await tick(); await p.onMessage.emit({ type: 'request_access' }); await tick(); return p; }
async function approve(h, origin = SITE) {
  const p = await ask(h, origin), window = h.approval(origin);
  await window.onMessage.emit({ type: 'decide', share: true }); await tick();
  return { p, window };
}
const NO_SCOPES = { sheet: false, rolls: false, write: false };
const shared = (origin, state = 'shared', scopes = NO_SCOPES) => ({ origin, state, scopes });
// v2 state; v1 approvals (Share without scopes) are identity-only.
const state = (fields = {}) => ({ type: 'state', version: 2, approved: false, scopes: { identity: false, ...NO_SCOPES }, selected: null, helper: 'connecting', revision: 1, relay: { state: 'off' }, ...fields });
const IDENTITY = { identity: true, ...NO_SCOPES };

test('allowed origins connect and learn nothing about the character before consent', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const p = h.page(); await tick();
    expect(states(p)).toEqual([state()]);
    expect(h.s.windows).toHaveLength(0);
    for (const origin of [LOCAL, 'http://localhost:8080', 'https://other.ts.net']) { const local = h.page(origin); await tick(); expect(states(local)[0]).toMatchObject({ approved: false, selected: null }); }
  } finally { h.local.disable(); }
});
test('request_access opens one approval window; Share publishes exactly id, name and details', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const a = h.page(), b = h.page(); await tick();
    await a.onMessage.emit({ type: 'request_access' }); await b.onMessage.emit({ type: 'request_access' }); await tick();
    expect(h.s.windows).toEqual([{ url: 'chrome-extension://fake/ui/share.html?origin=' + encodeURIComponent(SITE), type: 'popup', width: 460, height: 720, focused: true }]);
    expect(() => h.approval('https://unrequested.ts.net')).toThrow('ui_sender');
    const window = h.approval(SITE);
    expect(window.messages).toEqual([{ type: 'approval', origin: SITE, character: 'First', upgrade: false, current: NO_SCOPES }]);
    expect(() => h.approval(SITE)).toThrow('ui_sender');
    await window.onMessage.emit({ type: 'decide', share: true }); await tick();
    for (const p of [a, b]) {
      expect(states(p).at(-1)).toEqual(state({ approved: true, scopes: IDENTITY, selected: { id: '123', name: 'First', details: 'Level 5 · Elf · Wizard 5' }, revision: 2 }));
      expect(Object.keys(states(p).at(-1).selected)).toEqual(['id', 'name', 'details']);
    }
    expect(h.s.saved.sharedOrigins).toEqual([SITE]); expect(h.s.removed).toEqual([101]); expect(h.share.origins()).toEqual([SITE]);
    const other = h.page('http://localhost:3000'); await tick(); expect(states(other).at(-1)).toMatchObject({ approved: false, selected: null });
    const later = h.page(); await tick(); expect(states(later)).toEqual([{ ...states(a).at(-1), revision: 1 }]);
    const all = JSON.stringify([a, b, later, other].flatMap(p => p.messages));
    for (const secret of ['accountId', '"42"', 'Second', 'characters', 'account', 'enabled', 'phase']) expect(all).not.toContain(secret);
  } finally { h.local.disable(); }
});
test("Don't share or closing the window starts a per-origin cooldown that also applies to new ports", async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const p = await ask(h), window = h.approval(SITE);
    await window.onMessage.emit({ type: 'decide', share: false }); await tick();
    expect(states(p)).toHaveLength(2); expect(states(p)[1]).toEqual(states(p)[0]);
    expect(h.s.saved.sharedOrigins ?? []).toEqual([]); expect(h.s.removed).toEqual([101]);
    await p.onMessage.emit({ type: 'request_access' }); await tick();
    expect(states(p)).toHaveLength(2); expect(h.s.windows).toHaveLength(1);
    h.s.clock = 5000;
    const fresh = await ask(h);
    expect(states(fresh).at(-1)).toEqual({ ...state(), retry_after_ms: 10000 });
    expect(h.s.windows).toHaveLength(1);
    h.s.clock = 15001;
    const after = await ask(h); expect(h.s.windows).toHaveLength(2);
    expect(states(after).every(m => !('retry_after_ms' in m))).toBe(true);
    const closing = h.approval(SITE); await closing.onDisconnect.emit(); await tick();
    expect(states(after).at(-1)).toMatchObject({ approved: false, selected: null });
    const blocked = await ask(h); expect(states(blocked).at(-1).retry_after_ms).toBe(SHARE_LIMITS.cooldownMs);
    h.s.clock = 30002;
    await ask(h); expect(h.s.windows).toHaveLength(3);
    await h.api.windows.onRemoved.emit(103); await tick(); // Closed before its page connected.
    const third = await ask(h); expect(states(third).at(-1).retry_after_ms).toBe(SHARE_LIMITS.cooldownMs);
    h.s.clock = 60003; await ask(h); expect(h.s.windows).toHaveLength(4);
    const bad = h.approval(SITE); await bad.onMessage.emit({ type: 'decide', share: 'yes' }); await tick();
    expect(bad.disconnected).toBe(true); expect(h.share.origins()).toEqual([]);
  } finally { h.local.disable(); }
});
test('prompts are limited per origin per minute, across origins, and focus is throttled', async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < 3; i++) { h.s.clock = i * 16000; await ask(h); await h.api.windows.onRemoved.emit(101 + i); await tick(); }
    h.s.clock = 48000;
    const limited = await ask(h);
    expect(h.s.windows).toHaveLength(3); expect(states(limited).at(-1).retry_after_ms).toBe(60000 - 48000);
    h.s.clock = 60001; await ask(h); expect(h.s.windows).toHaveLength(4);
    const p = h.page(); await tick();
    for (const t of [60500, 61000, 61900]) { h.s.clock = t; await p.onMessage.emit({ type: 'request_access' }); await tick(); }
    expect(h.s.updates).toHaveLength(0);
    h.s.clock = 62100; await p.onMessage.emit({ type: 'request_access' }); await tick();
    expect(h.s.updates).toEqual([{ id: 104, options: { focused: true } }]);
    await ask(h, LOCAL); await ask(h, 'http://localhost:1');
    expect(h.s.windows).toHaveLength(6);
    const busy = await ask(h, 'http://localhost:2');
    expect(h.s.windows).toHaveLength(6); expect(states(busy).at(-1).retry_after_ms).toBe(SHARE_LIMITS.busyMs);
  } finally { h.local.disable(); }
});
test('port counts are capped per origin and in total', async () => {
  const h = await fixture();
  try {
    for (let i = 0; i < SHARE_LIMITS.portsPerOrigin; i++) h.page();
    expect(() => h.page()).toThrow('share_limit');
    for (let i = SHARE_LIMITS.portsPerOrigin; i < SHARE_LIMITS.ports; i++) h.page('http://localhost:' + (1000 + i % 40));
    expect(() => h.page('https://fresh.ts.net')).toThrow('share_limit');
  } finally { h.local.disable(); }
});
test('approval decisions bind to the page inside the window the worker created', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    let release; h.s.holdCreate = new Promise(r => { release = r; });
    const p = await ask(h);
    const wrong = h.approval(SITE, 555, 1555), right = h.approval(SITE, 101, 1101);
    expect(wrong.messages).toEqual([]); expect(right.messages).toEqual([]);
    release(); await tick();
    expect(wrong.disconnected).toBe(true); expect(right.messages).toEqual([{ type: 'approval', origin: SITE, character: 'First', upgrade: false, current: NO_SCOPES }]);
    await wrong.onMessage.emit({ type: 'decide', share: true }); await tick();
    expect(states(p).at(-1)).toMatchObject({ approved: false });
    await right.onMessage.emit({ type: 'decide', share: true }); await tick();
    expect(states(p).at(-1)).toMatchObject({ approved: true, selected: { id: '123' } });
    h.s.holdCreate = null;
    await ask(h, LOCAL);
    expect(() => h.approval(LOCAL, 999, 1102)).toThrow('ui_sender');
    expect(() => h.approval(LOCAL, 102, 4242)).toThrow('ui_sender');
    expect(() => h.share.acceptPort({ name: 'character-share-approval', sender: { id: 'fake', url: 'chrome-extension://fake/ui/share.html?origin=' + encodeURIComponent(LOCAL), origin: 'chrome-extension://fake', frameId: 0 }, onMessage: event(), onDisconnect: event() })).toThrow('ui_sender');
    const window = h.approval(LOCAL, 102, 1102); expect(window.messages).toHaveLength(1);
  } finally { h.local.disable(); }
});
test('revocation from the picker sends approved:false, disconnects the site and persists', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const manager = h.sites(); await tick();
    expect(manager.messages).toEqual([{ type: 'sites', sites: [] }]);
    const { p } = await approve(h);
    const otherSite = await approve(h, LOCAL);
    expect(manager.messages.at(-1)).toEqual({ type: 'sites', sites: [shared(LOCAL), shared(SITE)] });
    await manager.onMessage.emit({ type: 'revoke', origin: SITE }); await tick();
    expect(states(p).at(-1)).toMatchObject({ approved: false, selected: null }); expect(p.disconnected).toBe(true);
    expect(otherSite.p.disconnected).toBe(false);
    expect(h.s.saved.sharedOrigins).toEqual([LOCAL]); expect(h.s.session.pendingRevocations).toEqual([]);
    expect(manager.messages.at(-1)).toEqual({ type: 'sites', sites: [shared(LOCAL)] });
    const count = p.messages.length; await h.select('456'); expect(p.messages).toHaveLength(count);
    const reconnect = h.page(); await tick(); expect(states(reconnect)[0]).toMatchObject({ approved: false, selected: null });
    await manager.onMessage.emit({ type: 'revoke', origin: SITE, extra: 1 }); expect(manager.disconnected).toBe(true);
    const restored = await fixture(h.s.saved, h.s.session); expect(restored.share.origins()).toEqual([LOCAL]); restored.local.disable();
    expect(() => h.share.acceptPort({ name: 'character-share-sites', sender: { id: 'fake', url: 'chrome-extension://fake/ui/setup.html' }, onMessage: event(), onDisconnect: event() })).toThrow('ui_sender');
  } finally { h.local.disable(); }
});
test('a Stop sharing that cannot be saved stops data, stays listed for Retry and survives a worker restart', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const manager = h.sites(); await tick();
    const { p } = await approve(h);
    h.s.failSave = true;
    await manager.onMessage.emit({ type: 'revoke', origin: SITE }); await tick();
    expect(states(p).at(-1)).toMatchObject({ approved: false, selected: null }); expect(p.disconnected).toBe(true);
    expect(manager.messages.map(m => m.sites)).toContainEqual([shared(SITE, 'stopping')]);
    expect(manager.messages.at(-1)).toEqual({ type: 'sites', sites: [shared(SITE, 'unsaved')] });
    expect(h.share.origins()).toEqual([]); expect(h.s.saved.sharedOrigins).toEqual([SITE]);
    expect(h.s.session.pendingRevocations).toEqual([SITE]);
    const again = h.page(); await tick(); expect(states(again).at(-1)).toMatchObject({ approved: false, selected: null });
    await again.onMessage.emit({ type: 'request_access' }); await tick(); expect(h.s.windows).toHaveLength(2);

    // A worker restart with the removal still unsaved keeps the site stopped and retries.
    const restarted = await fixture(h.s.saved, h.s.session, { failSave: true });
    expect(restarted.share.origins()).toEqual([]); expect(restarted.share.sites()).toEqual([shared(SITE, 'unsaved')]);
    const page = restarted.page(); await tick(); expect(states(page)[0]).toMatchObject({ approved: false, selected: null });
    restarted.s.failSave = false; await restarted.runTimers();
    expect(restarted.s.saved.sharedOrigins).toEqual([]); expect(restarted.share.sites()).toEqual([]); expect(restarted.s.session.pendingRevocations).toEqual([]);
    restarted.local.disable();

    await manager.onMessage.emit({ type: 'revoke', origin: SITE }); await tick();
    expect(manager.messages.at(-1)).toEqual({ type: 'sites', sites: [shared(SITE, 'unsaved')] });
    h.s.failSave = false; await manager.onMessage.emit({ type: 'revoke', origin: SITE }); await tick();
    expect(manager.messages.at(-1)).toEqual({ type: 'sites', sites: [] });
    expect(h.s.saved.sharedOrigins).toEqual([]); expect(h.s.session.pendingRevocations).toEqual([]);
    expect(h.s.timers.length).toBeLessThanOrEqual(1); await h.runTimers(); expect(h.s.saved.sharedOrigins).toEqual([]);
  } finally { h.local.disable(); }
});
test('approvals and revocations are serialized from committed state; failed saves never leave an origin stored', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const { p: a } = await approve(h, SITE);
    const b = await ask(h, LOCAL), wb = h.approval(LOCAL);
    const c = await ask(h, 'http://localhost:7000'), wc = h.approval('http://localhost:7000');
    const manager = h.sites(); await tick();
    h.s.onLocalSet = v => v.sharedOrigins?.includes(LOCAL) ? 'fail' : null;
    await Promise.all([wb.onMessage.emit({ type: 'decide', share: true }), wc.onMessage.emit({ type: 'decide', share: true }), manager.onMessage.emit({ type: 'revoke', origin: SITE })]);
    await tick();
    expect(h.s.saved.sharedOrigins).toEqual(['http://localhost:7000']);
    expect(h.share.origins()).toEqual(['http://localhost:7000']);
    expect(h.share.sites()).toEqual([shared('http://localhost:7000')]);
    expect(states(b).at(-1)).toMatchObject({ approved: false, selected: null }); expect(states(c).at(-1)).toMatchObject({ approved: true });
    expect(states(a).at(-1)).toMatchObject({ approved: false }); expect(a.disconnected).toBe(true);
    const shareWrites = h.s.localWrites.filter(w => 'sharedOrigins' in w);
    for (const write of shareWrites) expect(write.sharedOrigins.length).toBeLessThanOrEqual(2);
    expect(shareWrites.at(-1).sharedOrigins).toEqual(h.s.saved.sharedOrigins);

    // Worst case: the failed write lands and the rollback fails. It is treated as a stopped, unsaved site.
    h.s.onLocalSet = v => v.sharedOrigins?.includes(LOCAL) ? 'write-then-fail' : v.sharedOrigins ? 'fail' : null;
    const d = await ask(h, LOCAL);
    h.s.clock += 1; const wd = h.approval(LOCAL); await wd.onMessage.emit({ type: 'decide', share: true }); await tick();
    expect(states(d).at(-1)).toMatchObject({ approved: false, selected: null });
    expect(h.s.saved.sharedOrigins).toContain(LOCAL); expect(h.share.origins()).toEqual(['http://localhost:7000']);
    expect(h.share.sites()).toEqual([shared(LOCAL, 'unsaved'), shared('http://localhost:7000')]);
    expect(h.s.session.pendingRevocations).toEqual([LOCAL]);
    const restarted = await fixture(h.s.saved, h.s.session); expect(restarted.share.origins()).toEqual(['http://localhost:7000']);
    expect(restarted.s.saved.sharedOrigins).toEqual(['http://localhost:7000']); restarted.local.disable();
    h.s.onLocalSet = null; await h.runTimers();
    expect(h.s.saved.sharedOrigins).toEqual(['http://localhost:7000']); expect(h.share.sites()).toEqual([shared('http://localhost:7000')]);
  } finally { h.local.disable(); }
});
test('iframes, wrong names and unsupported or inconsistent senders are rejected', async () => {
  const h = await fixture();
  try {
    expect(() => h.page(SITE, { frameId: 1 })).toThrow('share_sender');
    expect(() => h.page(SITE, { tab: undefined })).toThrow('share_sender');
    expect(() => h.page(SITE, { origin: undefined })).toThrow('share_sender');
    expect(() => h.page(SITE, { url: 'https://evil.ts.net/x' })).toThrow('share_sender');
    for (const origin of ['http://table.ts.net', 'http://192.168.1.4:8080', 'chrome-extension://other', 'null', 'file://']) expect(() => h.page(origin)).toThrow('share_sender');
    for (const name of ['character-picker', 'character-share-approval', '', undefined]) {
      expect(() => h.share.acceptExternal({ name, sender: { url: SITE + '/', origin: SITE, frameId: 0, tab: {} }, onMessage: event(), onDisconnect: event() })).toThrow('share_sender');
    }
  } finally { h.local.disable(); }
});
test('bad, oversized and flooding messages disconnect the page without serializing them', async () => {
  const h = await fixture();
  try {
    let serialized = false;
    const huge = {}; for (let i = 0; i < 5000; i++) huge['k' + i] = i;
    for (const message of [{ type: 'status' }, { type: 'request_access', extra: true }, ['request_access'], 'request_access', null, { type: 'x'.repeat(2000) },
      { type: 'request_access', toJSON() { serialized = true; } }, { toJSON() { serialized = true; }, type: 'request_access' }, huge, Object.create({ type: 'request_access' })]) {
      const p = h.page(); await tick(); await p.onMessage.emit(message); expect(p.disconnected).toBe(true);
    }
    expect(serialized).toBe(false); expect(h.s.windows).toHaveLength(0);
    const flood = h.page(); await tick();
    for (let i = 0; i < 10; i++) await flood.onMessage.emit({ type: 'request_access' });
    expect(flood.disconnected).toBe(false);
    await flood.onMessage.emit({ type: 'request_access' }); expect(flood.disconnected).toBe(true);
    const steady = h.page(); await tick();
    for (let i = 0; i < 30; i++) { h.s.clock += 150; await steady.onMessage.emit({ type: 'request_access' }); }
    expect(steady.disconnected).toBe(false);
  } finally { h.local.disable(); }
});
test('selection, details and helper changes publish deduplicated states with new revisions', async () => {
  const h = await fixture();
  try {
    await h.select('123');
    const { p } = await approve(h);
    const before = p.messages.length;
    await h.request('list_characters'); await h.request('status');
    expect(p.messages).toHaveLength(before);
    await h.request('select_character', { characterId: '456' });
    expect(states(p).at(-1)).toMatchObject({ approved: true, selected: { id: '456', name: 'Second', details: 'Level 2 · Human · Fighter 2' }, revision: 3 });
    h.s.characters[1].details = 'Level 3 · Human · Fighter 3'; await h.request('list_characters');
    expect(states(p).at(-1)).toMatchObject({ selected: { details: 'Level 3 · Human · Fighter 3' }, revision: 4 });
    expect(h.s.saved.selectedCharacter).toEqual({ id: '456', name: 'Second', details: 'Level 3 · Human · Fighter 3', accountId: '42' });
    await h.s.host.onMessage.emit({ type: 'ready' });
    expect(states(p).at(-1)).toMatchObject({ helper: 'ready', revision: 4 });
    const json = states(p).map(m => JSON.stringify(m));
    expect(new Set(json).size).toBe(json.length);
    h.s.accountId = '43'; await h.request('list_characters');
    expect(states(p).at(-1)).toMatchObject({ approved: true, selected: null, revision: 5 });
    const restored = await fixture({ ...h.s.saved, selectedCharacter: { id: '456', name: 'Second', details: 'Level 3 · Human · Fighter 3', accountId: '42' } });
    expect(restored.local.sharedIdentity()).toEqual({ id: '456', name: 'Second', details: 'Level 3 · Human · Fighter 3' });
    expect(restored.local.status().selectedCharacter).toEqual({ id: '456', name: 'Second' });
    const page = restored.page(); await tick();
    expect(states(page)).toEqual([state({ approved: true, scopes: IDENTITY, selected: { id: '456', name: 'Second', details: 'Level 3 · Human · Fighter 3' } })]);
    restored.local.disable();
    const legacy = await fixture({ selectedCharacter: { id: '123', name: 'First', accountId: '42' } });
    expect(legacy.local.sharedIdentity()).toEqual({ id: '123', name: 'First', details: '' }); legacy.local.disable();
  } finally { h.local.disable(); }
});
test('unreadable sharing storage fails closed and is never overwritten', async () => {
  const h = await fixture({ sharedOrigins: [SITE, 'http://evil.example', 'https://x.ts.net/path', 42] });
  try {
    expect(h.share.origins()).toEqual([SITE]);
    await h.select('123'); h.s.failSave = true;
    const p = await ask(h, 'https://new.ts.net');
    const window = h.approval('https://new.ts.net'); await window.onMessage.emit({ type: 'decide', share: true }); await tick();
    expect(states(p).at(-1)).toMatchObject({ approved: false, selected: null }); expect(h.share.origins()).toEqual([SITE]);
  } finally { h.local.disable(); }
  const unreadable = await fixture({ sharedOrigins: [SITE] }, { pendingRevocations: [] }, { failSessionRead: true });
  try {
    await unreadable.select('123');
    expect(unreadable.share.origins()).toEqual([]);
    const p = await ask(unreadable, LOCAL), window = unreadable.approval(LOCAL);
    await window.onMessage.emit({ type: 'decide', share: true }); await tick();
    expect(states(p).at(-1)).toMatchObject({ approved: false });
    expect(unreadable.s.localWrites.filter(w => 'sharedOrigins' in w)).toEqual([]); expect(unreadable.s.saved.sharedOrigins).toEqual([SITE]);
  } finally { unreadable.local.disable(); }
});
