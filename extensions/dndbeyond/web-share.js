// character-share v2: consent-gated sharing of the selected character with
// approved web origins. Kept apart from the picker/native authority: its own
// ports, storage keys, D&D Beyond reader and explicit projections. status(), the
// account list, accountId and tokens never reach a web page. Each approved origin
// has scopes: identity (always), sheet, rolls and write.
import { createHttpReader, HTTP_ORIGINS } from './http-read.js';
import { accountIdFromToken } from './account-characters.js';
import { characterUrl, createScriptApi } from './script-api.js';
import { buildSheet, createPortraits, createSheetFeed, sheetKey, SCDS_URL } from './share-sheet.js';
import { createRollRelay, GAME_LOG } from './share-relay.js';
import { applyShape, createApplier, reasonCode } from './share-apply.js';
export const SHARE_PORT = 'character-share';
const APPROVAL_PORT = 'character-share-approval', SITES_PORT = 'character-share-sites';
export const SHARE_LIMITS = Object.freeze({ messagesPerSecond: 10, sites: 64, portsPerOrigin: 16, ports: 64, windows: 3,
  promptsPerMinute: 3, cooldownMs: 15000, focusMs: 2000, busyMs: 5000, retryMs: 15000, sheetMs: 20000, refreshMs: 5000, campaignMs: 60000 });
export const SCOPES = Object.freeze(['sheet', 'rolls', 'write']);
const L = SHARE_LIMITS, NONE = Object.freeze({ sheet: false, rolls: false, write: false });
const fail = code => { throw Error(code); };
const plain = m => !!m && typeof m === 'object' && Object.getPrototypeOf(m) === Object.prototype;
// Cheap exact-shape check: no serialization, stops at the first unexpected key.
function exact(m, keys) {
  if (!plain(m)) return false;
  let n = 0; for (const k in m) if (++n > keys.length || !keys.includes(k)) return false;
  return n === keys.length;
}
const scopeChoice = v => exact(v, SCOPES) && SCOPES.every(k => typeof v[k] === 'boolean');
// Stored scope records are read leniently: anything but an explicit true is off.
const storedScopes = v => Object.freeze(Object.fromEntries(SCOPES.map(k => [k, plain(v) && v[k] === true])));
const codeOf = e => reasonCode(e?.message) ?? 'request_failed';
export function shareOrigin(value) {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value) return null;
    return url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) ? value : null;
  } catch { return null; }
}
export function createWebShare(api, bridge, { now = () => performance.now(), clock = () => Date.now(), timers = globalThis, reader = createHttpReader(),
  WebSocket = globalThis.WebSocket, portraits = createPortraits() } = {}) {
  const pages = new Map(), approvals = new Map(), managers = new Set(), cooldowns = new Map(), prompts = new Map(), refreshes = new Map();
  // committed/granted mirror storage.local.sharedOrigins/sharedScopes. revoking holds
  // stopped sites whose removal is not yet saved: they are never shared, and stay
  // listed until saved. lowering holds scope reductions in effect before they are saved.
  const revoking = new Map(), markers = new Set(), lowering = new Map(), scopeWrites = new Map();
  let committed = new Set(), granted = new Map(), writable = false, queue = Promise.resolve(), markerQueue = Promise.resolve(), retryTimer = null;
  const isShared = origin => committed.has(origin) && !revoking.has(origin);
  function scopesOf(origin) {
    if (!isShared(origin)) return NONE;
    const g = granted.get(origin) ?? NONE, low = lowering.get(origin);
    return { sheet: g.sheet && (!low || low.sheet), rolls: g.rolls && (!low || low.rolls), write: g.write && (!low || low.write) };
  }
  const loaded = (async () => {
    try {
      const [local, session] = await Promise.all([api.storage.local.get(['sharedOrigins', 'sharedScopes']), api.storage.session.get('pendingRevocations')]);
      const saved = local.sharedOrigins ?? [], scopes = local.sharedScopes ?? {}, pending = session.pendingRevocations ?? [];
      if (!Array.isArray(saved) || !Array.isArray(pending) || !plain(scopes)) fail('schema');
      committed = new Set(saved.filter(o => shareOrigin(o) === o).slice(0, L.sites));
      // v1 approvals have no scope record and stay identity-only.
      granted = new Map([...committed].map(o => [o, storedScopes(Object.hasOwn(scopes, o) ? scopes[o] : null)]));
      // A stop whose removal was not saved before a worker restart stays stopped.
      for (const o of pending) if (shareOrigin(o) === o) { markers.add(o); if (committed.has(o)) revoking.set(o, 'unsaved'); }
      writable = true;
    } catch { committed = new Set(); granted = new Map(); revoking.clear(); } // Fail closed; never overwrite unread storage.
    for (const o of revoking.keys()) void revoke(o);
    if (writable && [...markers].some(o => !committed.has(o))) { for (const o of [...markers]) if (!committed.has(o)) markers.delete(o); void writeMarkers(); }
  })();
  const ready = Promise.all([loaded, bridge.initialize()]).then(() => {});

  // One queue for approvals, scope changes and revocations, each computed from committed state.
  const record = (origins, scopes) => ({ sharedOrigins: [...origins],
    sharedScopes: Object.fromEntries([...origins].filter(o => SCOPES.some(k => scopes.get(o)?.[k])).map(o => [o, { ...scopes.get(o) }])) });
  function commit(change) {
    const run = queue.then(async () => {
      if (!writable) fail('storage_unavailable');
      const next = change({ origins: new Set(committed), scopes: new Map(granted) });
      try { await api.storage.local.set(record(next.origins, next.scopes)); }
      catch {
        try { await api.storage.local.set(record(committed, granted)); } catch { fail('storage_uncertain'); }
        fail('storage_unavailable');
      }
      committed = next.origins; granted = next.scopes;
    });
    queue = run.catch(() => {}); return run;
  }
  function writeMarkers() {
    const run = markerQueue.then(() => api.storage.session.set({ pendingRevocations: [...markers] }));
    markerQueue = run.catch(() => {}); return run.catch(() => {});
  }
  function mark(origin, on) { if (on ? markers.has(origin) : !markers.delete(origin)) return markerQueue; if (on) markers.add(origin); return writeMarkers(); }
  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = timers.setTimeout(() => { retryTimer = null; for (const [o, s] of revoking) if (s === 'unsaved') void revoke(o); }, L.retryMs);
    retryTimer?.unref?.();
  }

  // D&D Beyond access for web pages: its own reader, independent of the Windows
  // helper, gated by the host permission and the selection's account.
  // Losing host access also closes the game-log socket; the next connect reports permission_required.
  api.permissions?.onRemoved?.addListener(change => { if (change?.origins?.length) { reader.clear(); feed.forget(); relay.stop(); refresh(); } });
  async function permission() { if (!await api.permissions.contains({ origins: [...HTTP_ORIGINS] })) fail('permission_required'); }
  const selectedId = () => bridge.sharedIdentity()?.id ?? null;
  const following = id => async () => { if (selectedId() !== id) fail('scope_ended'); };
  const request = (id, url, options) => reader.requestCharacter(id, url, { ...options, account: bridge.selectedAccountId?.() ?? null,
    assertScope: async () => { await permission(); await options.assertScope(); } });
  const call = (id, path, method, body, assertScope) => request(id, characterUrl(path), { method, body, assertScope });
  async function account(assertScope, fresh = false) {
    const token = await reader.token({ fresh, assertScope: async () => { await permission(); await assertScope(); } });
    const userId = accountIdFromToken(token);
    if (userId !== bridge.selectedAccountId?.()) fail('account_mismatch'); // Signed in to a different D&D Beyond account.
    return { token, userId };
  }
  async function readCharacter(id, assertScope) {
    const r = await call(id, `/character/v5/character/${id}`, 'GET', null, assertScope);
    if (r.status !== 200 || r.data?.success !== true || r.data.data?.id !== Number(id)) fail(r.status === 401 ? 'reauth_required' : r.status === 403 ? 'forbidden' : r.status === 429 ? 'rate_limited' : 'read_failed');
    return r.data.data;
  }
  const campaigns = new Map();
  const campaignOf = character => { const id = character?.campaign?.id; return Number.isSafeInteger(id) && id > 0 ? String(id) : null; };
  function rememberCampaign(id, character) { campaigns.delete(id); campaigns.set(id, { at: now(), campaign: campaignOf(character) }); while (campaigns.size > 8) campaigns.delete(campaigns.keys().next().value); }
  async function loadSheet(id) {
    const scope = following(id);
    await permission(); await account(scope);
    const character = await readCharacter(id, scope);
    rememberCampaign(id, character);
    let computed = null;
    try {
      const r = await call(id, SCDS_URL, 'POST', { characterIds: [Number(id)] }, scope);
      const found = r.status === 200 && Array.isArray(r.data?.foundCharacters) ? r.data.foundCharacters.filter(c => c?.characterId === Number(id)) : [];
      computed = found.length === 1 ? found[0] : null;
    } catch (e) { if (e.message === 'scope_ended') throw e; } // The sheet is still useful without SCDS.
    const sheet = buildSheet(character, computed, clock());
    const portrait = await portraits.get(character?.decorations?.avatarUrl).catch(() => null);
    await scope();
    return { sheet, portrait: typeof portrait === 'string' ? portrait : null };
  }
  async function relayInfo(id) {
    const scope = following(id);
    await permission();
    const { token, userId } = await account(scope, true); // Every (re)connect uses a newly minted token (ttl <= 300 s).
    let cached = campaigns.get(id);
    if (!cached || now() - cached.at >= L.campaignMs) { rememberCampaign(id, await readCharacter(id, scope)); cached = campaigns.get(id); }
    if (!cached.campaign) fail('no_campaign');
    await scope();
    return { userId, url: `${GAME_LOG}?gameId=${encodeURIComponent(cached.campaign)}&userId=${encodeURIComponent(userId)}&stt=${encodeURIComponent(token)}` };
  }

  // Ports and the messages they receive.
  function stateFor(page) {
    const allowed = isShared(page.origin), scopes = scopesOf(page.origin), identity = allowed ? bridge.sharedIdentity() : null;
    const selected = identity ? { id: identity.id, name: identity.name, details: identity.details } : null, key = JSON.stringify(selected);
    if (key !== page.key) { page.key = key; page.revision++; }
    return { type: 'state', version: 2, approved: allowed, scopes: { identity: allowed, sheet: scopes.sheet, rolls: scopes.rolls, write: scopes.write },
      selected, helper: bridge.helperState(), revision: page.revision, relay: scopes.rolls ? { ...relay.status() } : { state: 'off' } };
  }
  function drop(port) { pages.delete(port); try { port.disconnect(); } catch { /* closed */ } }
  function post(port, message) { try { port.postMessage(message); return true; } catch { drop(port); return false; } }
  function send(port, force = false, retryAfter = 0) {
    const page = pages.get(port); if (!page?.ready) return;
    const state = stateFor(page), text = JSON.stringify(state);
    if (!force && text === page.last) return; // Deduplicate identical consecutive states.
    page.last = text;
    post(port, retryAfter > 0 ? { ...state, retry_after_ms: Math.ceil(retryAfter) } : state);
  }
  function sendSheet(port, page, id, result) {
    if (!page.sheet || !pages.has(port) || selectedId() !== id) return;
    const key = sheetKey(result.sheet), fresh = page.sheet.id !== id;
    const portraitChanged = fresh || page.sheet.portrait !== result.portrait;
    if (!fresh && key === page.sheet.key && !portraitChanged) return; // Identical sheets are not repeated.
    page.sheet = { id, key, portrait: result.portrait };
    send(port); // The page sees the matching state (and revision) first.
    post(port, { type: 'sheet', character_id: id, revision: page.revision, sheet: result.sheet, portrait: portraitChanged ? result.portrait : null });
  }
  function sendRoll(port, page, id, roll) {
    if (!page.rolls || page.rolls.has(roll.roll_id)) return;
    page.rolls.add(roll.roll_id); if (page.rolls.size > 200) page.rolls.delete(page.rolls.values().next().value);
    post(port, { type: 'roll', character_id: id, roll });
  }
  // Start or stop per-port sheet and roll delivery after scope, selection or port changes.
  function sync() {
    const id = selectedId(); let sheets = false, rolls = false;
    for (const [port, page] of [...pages]) {
      if (!page.ready) continue;
      const scopes = scopesOf(page.origin);
      if (!scopes.sheet || !id) page.sheet = null;
      else {
        sheets = true;
        if (!page.sheet) { page.sheet = { id: null, key: null, portrait: null }; const current = feed.current(id); if (current) sendSheet(port, page, id, current); }
      }
      if (!scopes.rolls || !id) page.rolls = null;
      else {
        rolls = true;
        if (!page.rolls) { // Re-send the last 30 s so a reconnect or worker restart loses nothing.
          page.rolls = new Set();
          void relay.buffered(id).then(list => { if (pages.get(port) === page && selectedId() === id) for (const roll of list) sendRoll(port, page, id, roll); });
        }
      }
    }
    feed.update(id, sheets); relay.update(id, rolls);
  }
  const feed = createSheetFeed({ load: loadSheet, timers, now, intervalMs: L.sheetMs,
    deliver: (id, result) => { for (const [port, page] of [...pages]) if (page.ready && scopesOf(page.origin).sheet) sendSheet(port, page, id, result); } });
  const relay = createRollRelay({ connectInfo: relayInfo, WebSocket, timers, now, clock, storage: api.storage.session,
    onRoll: (id, roll) => { for (const [port, page] of [...pages]) if (page.ready && scopesOf(page.origin).rolls && selectedId() === id) sendRoll(port, page, id, roll); },
    onState: () => { for (const [port, page] of pages) if (scopesOf(page.origin).rolls) send(port); } });
  const scripts = createScriptApi({ request });
  const applier = createApplier({ storage: api.storage.session, now: clock, run: runApply });   // wall clock: the rate window survives a restart
  // Every apply for a character (its read-before-write and its write) runs in one queue,
  // so two quick opposite operations cannot both verify against the same old read.
  const applyQueues = new Map();
  function runApply(origin, m) {
    const id = m.character_id, previous = applyQueues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => applyNow(origin, m)); applyQueues.set(id, pending);
    return pending.finally(() => { if (applyQueues.get(id) === pending) applyQueues.delete(id); });
  }
  async function applyNow(origin, m) {
    const id = m.character_id, allowed = x => x === id && scopesOf(origin).write && selectedId() === id;
    const scope = async () => { if (!allowed(id)) fail('revoked'); };
    const before = e => ({ state: 'rejected', reason: codeOf(e), final: false }); // Nothing was sent to D&D Beyond.
    try { await permission(); await account(scope); } catch (e) { return before(e); }
    const base = `/v1/characters/${id}`;
    let input;
    if (m.op === 'damage' || m.op === 'heal' || m.op === 'temp') {
      const body = m.op === 'temp' ? { value: m.amount } : { amount: m.amount };
      if (m.expected) body.expected = { current: m.expected.current, maximum: m.expected.maximum, temporary: m.expected.temporary };
      input = { method: 'POST', path: `${base}/hp/${m.op === 'temp' ? 'temporary' : m.op}`, body };
    } else {
      // Read first: an operation already in the requested state is verified without a write.
      let character; try { character = await readCharacter(id, scope); } catch (e) { return before(e); }
      if (m.op === 'condition') {
        const level = m.level ?? null;
        if (m.on && (m.condition === 4) !== (level !== null)) return { state: 'rejected', reason: 'invalid', final: false };
        if (!Array.isArray(character.conditions)) return before(Error('read_failed'));
        const found = character.conditions.find(c => c?.id === m.condition);
        if (m.on ? found && (m.condition !== 4 || found.level === level) : !found) return { state: 'verified', reason: null, final: true };
        input = { method: m.on ? 'PUT' : 'DELETE', path: `${base}/conditions/${m.condition}`, body: m.on && m.condition === 4 ? { level } : null };
      } else {
        const d = character.deathSaves;
        if (d && d.successCount === m.success && d.failCount === m.fail) return { state: 'verified', reason: null, final: true };
        input = { method: 'PUT', path: `${base}/death-saves`, body: { failCount: m.fail, successCount: m.success } };
      }
    }
    const r = await scripts.handle(input, allowed, [id], null);
    if (r.status === 400) return { state: 'rejected', reason: 'invalid', final: false };
    if (r.status === 403) return { state: 'rejected', reason: 'scope', final: false };
    if (r.status !== 200) return { state: 'rejected', reason: codeOf(Error(r.body?.error)), final: false }; // Failed before any write.
    const b = r.body ?? {};
    if (b.state === 'verified') return { state: 'verified', reason: null, final: true };
    if (b.state === 'conflict') return { state: 'conflict', reason: b.reason ?? 'conflict', final: true };
    if (b.state === 'rejected') return { state: 'rejected', reason: b.reason ?? 'dndbeyond_rejected', final: b.reason !== 'hp_unavailable' }; // hp_unavailable: nothing sent.
    return { state: 'unknown', reason: b.reason ?? 'unconfirmed', final: true };
  }
  const sendOrigin = origin => { for (const [port, page] of [...pages]) if (page.origin === origin) send(port, true); sync(); };
  function describe(origin, force = false) {
    const pending = approvals.get(origin); if (!pending?.port) return;
    const message = { type: 'approval', origin, character: bridge.sharedIdentity()?.name ?? null, upgrade: isShared(origin), current: scopesOf(origin) }, text = JSON.stringify(message);
    if (!force && text === pending.last) return; pending.last = text;
    try { pending.port.postMessage(message); } catch { /* window closed */ }
  }
  const siteList = () => ({ type: 'sites', sites: [...committed].sort().map(origin => ({ origin, state: revoking.get(origin) ?? 'shared', scopes: scopesOf(origin) })) });
  function broadcastSites() { for (const port of managers) { try { port.postMessage(siteList()); } catch { managers.delete(port); } } }
  function refresh() { for (const port of [...pages.keys()]) send(port); sync(); for (const origin of approvals.keys()) describe(origin); }
  bridge.watch(refresh);

  function request_(port, page) {
    const origin = page.origin;
    // Approved with every scope: nothing to ask. Approved but missing a scope: ask again as an upgrade.
    if (page.denied || isShared(origin) && SCOPES.every(k => scopesOf(origin)[k])) return;
    const t = now(), cool = cooldowns.get(origin) ?? 0;
    if (cool > t) { send(port, true, cool - t); return; }
    cooldowns.delete(origin);
    const existing = approvals.get(origin);
    if (existing) { // One window per origin; refocus at most every focusMs.
      if (existing.windowId === undefined || t - existing.focused < L.focusMs) return;
      existing.focused = t;
      api.windows.update(existing.windowId, { focused: true }).catch(() => { if (approvals.get(origin) === existing && !existing.port) approvals.delete(origin); });
      return;
    }
    const recent = (prompts.get(origin) ?? []).filter(x => t - x < 60000);
    if (recent.length) prompts.set(origin, recent); else prompts.delete(origin);
    if (recent.length >= L.promptsPerMinute) { send(port, true, recent[0] + 60000 - t); return; }
    if (approvals.size >= L.windows) { send(port, true, L.busyMs); return; }
    recent.push(t); prompts.set(origin, recent);
    void openApproval(origin, t);
  }
  async function openApproval(origin, t) {
    const pending = { origin, windowId: undefined, tabId: undefined, port: null, early: [], last: null, focused: t };
    approvals.set(origin, pending);
    try {
      const created = await api.windows.create({ url: api.runtime.getURL('ui/share.html') + '?origin=' + encodeURIComponent(origin), type: 'popup', width: 460, height: 720, focused: true });
      if (approvals.get(origin) !== pending || created?.id === undefined) {
        if (created?.id !== undefined) api.windows.remove(created.id).catch(() => {});
        if (approvals.get(origin) === pending) approvals.delete(origin);
        return;
      }
      pending.windowId = created.id; pending.tabId = created.tabs?.[0]?.id;
      for (const port of pending.early.splice(0)) { try { bind(port, pending); } catch { try { port.disconnect(); } catch { /* closed */ } } }
    } catch { if (approvals.get(origin) === pending) approvals.delete(origin); }
  }
  async function grant(origin, scopes) {
    try {
      await commit(next => { if (!next.origins.has(origin) && next.origins.size >= L.sites) fail('too_many_sites'); next.origins.add(origin); next.scopes.set(origin, storedScopes(scopes)); return next; });
      revoking.delete(origin); lowering.delete(origin); void mark(origin, false); return true;
    } catch (e) {
      if (e.message === 'storage_uncertain') { // Storage may hold it: treat as a stopped, unsaved site.
        committed.add(origin); revoking.set(origin, 'unsaved'); void mark(origin, true); scheduleRetry();
      }
      return false;
    }
  }
  async function decide(origin, pending, share, scopes) {
    if (approvals.get(origin) !== pending) return false;
    approvals.delete(origin);
    if (pending.windowId !== undefined) api.windows.remove(pending.windowId).catch(() => {});
    const done = share && await grant(origin, scopes ?? NONE);
    if (!share) { // Don't share, Keep current or a closed window: cool down for every port of the origin.
      cooldowns.set(origin, now() + L.cooldownMs);
      for (const page of pages.values()) if (page.origin === origin) page.denied = true;
    }
    sendOrigin(origin); broadcastSites(); // Every decision is delivered, even an unchanged state.
    return done;
  }
  async function revoke(origin) {
    await loaded;
    if (!committed.has(origin)) { broadcastSites(); return; }
    revoking.set(origin, 'stopping'); // Stop publishing first, then tell and disconnect the site's pages.
    closeApproval(origin); // A window still open could otherwise re-grant later.
    for (const [port, page] of [...pages]) if (page.origin === origin) { send(port, true); drop(port); }
    sync(); broadcastSites();
    await mark(origin, true);
    try { await commit(next => { next.origins.delete(origin); next.scopes.delete(origin); return next; }); } catch { /* reported below */ }
    if (!committed.has(origin)) { revoking.delete(origin); lowering.delete(origin); void mark(origin, false); }
    else if (revoking.has(origin)) { revoking.set(origin, 'unsaved'); scheduleRetry(); }
    broadcastSites();
  }
  function closeApproval(origin) {
    const pending = approvals.get(origin); if (!pending) return;
    approvals.delete(origin);
    if (pending.windowId !== undefined) api.windows.remove(pending.windowId).catch(() => {});
    for (const port of [pending.port, ...pending.early]) if (port) try { port.disconnect(); } catch { /* closed */ }
  }
  // Popup toggles. A reduction takes effect at once; if it cannot be saved the
  // site is stopped entirely (fail closed) instead of keeping the old scopes. A
  // raise whose rollback also failed (storage may hold it) is stopped the same way.
  async function setScopes(origin, wanted) {
    await loaded;
    if (!isShared(origin)) { broadcastSites(); return; }
    const current = scopesOf(origin), reducing = SCOPES.some(k => current[k] && !wanted[k]);
    if (reducing) { const low = lowering.get(origin) ?? { sheet: true, rolls: true, write: true }; lowering.set(origin, Object.fromEntries(SCOPES.map(k => [k, low[k] && wanted[k]]))); sendOrigin(origin); }
    scopeWrites.set(origin, (scopeWrites.get(origin) ?? 0) + 1);
    let failed = false, uncertain = false;
    try { await commit(next => { if (!next.origins.has(origin)) fail('revoked'); next.scopes.set(origin, storedScopes(wanted)); return next; }); }
    catch (e) { failed = e.message !== 'revoked'; uncertain = e.message === 'storage_uncertain'; }
    const left = scopeWrites.get(origin) - 1;
    if (left) scopeWrites.set(origin, left); else { scopeWrites.delete(origin); if (!failed) lowering.delete(origin); }
    if (failed && (reducing || uncertain || lowering.has(origin))) { void revoke(origin); return; }
    sendOrigin(origin); broadcastSites(); describe(origin); // An open upgrade window shows the new current scopes.
  }

  function receive(port, message) {
    const page = pages.get(port); if (!page) return;
    const t = now(); page.times = page.times.filter(x => t - x < 1000); page.times.push(t);
    // Valid messages are a few bytes with a fixed shape; any other shape or size disconnects.
    let kind = null;
    if (page.times.length <= L.messagesPerSecond) {
      if (exact(message, ['type'])) kind = message.type === 'request_access' || message.type === 'refresh' ? message.type : null;
      else if (applyShape(message)) kind = 'apply';
    }
    if (!kind) { drop(port); return; }
    void ready.then(() => {
      if (pages.get(port) !== page) return;
      if (kind === 'request_access') request_(port, page);
      else if (kind === 'refresh') {
        if (!page.ready || !scopesOf(page.origin).sheet || !selectedId()) return;
        const last = refreshes.get(page.origin);
        if (last !== undefined && t - last < L.refreshMs) return; // At most once per 5 s per origin.
        refreshes.set(page.origin, t); feed.poke();
      } else void applyFor(port, page, message);
    }).catch(() => {});
  }
  async function applyFor(port, page, m) {
    const origin = page.origin;
    const result = await applier.apply(origin, m, { scope: () => scopesOf(origin).write, character: () => selectedId() === m.character_id })
      .catch(() => ({ state: 'unknown', reason: 'request_failed' }));
    if (pages.get(port) === page) post(port, { type: 'applied', op_id: m.op_id, state: result.state, reason: result.reason });
    if (!['scope', 'character', 'rate', 'invalid'].includes(result.reason) && selectedId() === m.character_id) feed.poke();
  }
  function acceptExternal(port) {
    const s = port?.sender; let origin = null;
    try { if (port.name === SHARE_PORT && s?.tab && s.frameId === 0 && typeof s.url === 'string' && new URL(s.url).origin === s.origin) origin = shareOrigin(s.origin); }
    catch { origin = null; }
    if (!origin) fail('share_sender');
    let same = 0; for (const p of pages.values()) if (p.origin === origin) same++;
    if (pages.size >= L.ports || same >= L.portsPerOrigin) fail('share_limit');
    const page = { origin, ready: false, denied: false, last: null, key: undefined, revision: 0, times: [], sheet: null, rolls: null };
    pages.set(port, page);
    port.onDisconnect.addListener(() => { void api.runtime.lastError; if (pages.get(port) === page) { pages.delete(port); sync(); } });
    port.onMessage.addListener(message => receive(port, message));
    // Authorize before the first snapshot: approvals and selection are loaded first.
    void ready.then(() => { if (pages.get(port) === page) { page.ready = true; send(port, true); sync(); } });
  }

  function internalUrl(port) {
    const s = port?.sender;
    if (s?.id !== api.runtime.id || typeof s.url !== 'string' || s.frameId !== undefined && s.frameId !== 0 ||
        s.origin !== undefined && s.origin !== `chrome-extension://${api.runtime.id}`) fail('ui_sender');
    return s.url;
  }
  function acceptApproval(port) {
    const url = internalUrl(port), base = api.runtime.getURL('ui/share.html') + '?';
    if (!url.startsWith(base) || !Number.isInteger(port.sender.tab?.windowId)) fail('ui_sender');
    const origin = new URLSearchParams(url.slice(base.length)).get('origin'), pending = approvals.get(origin);
    if (shareOrigin(origin) !== origin || !pending || pending.port) fail('ui_sender');
    if (pending.windowId !== undefined) { bind(port, pending); return; }
    // The page loaded before windows.create resolved: bind once its window is known.
    if (pending.early.length >= 4) fail('ui_sender');
    pending.early.push(port);
    port.onDisconnect.addListener(() => { const i = pending.early.indexOf(port); if (i >= 0) pending.early.splice(i, 1); });
  }
  // A decision counts only from the page inside the window the worker created.
  function bind(port, pending) {
    const tab = port.sender.tab, origin = pending.origin;
    if (pending.port || tab?.windowId !== pending.windowId || pending.tabId !== undefined && tab.id !== pending.tabId) fail('ui_sender');
    pending.port = port;
    // Closing the window is the same as "Don't share" for the waiting pages.
    port.onDisconnect.addListener(() => { void api.runtime.lastError; void decide(origin, pending, false); });
    port.onMessage.addListener(m => {
      if (approvals.get(origin) !== pending) return;
      // {type:'decide', share, scopes:{sheet, rolls, write}}; without scopes a Share is identity-only.
      const valid = plain(m) && m.type === 'decide' && typeof m.share === 'boolean' && (exact(m, ['type', 'share']) || exact(m, ['type', 'share', 'scopes']) && scopeChoice(m.scopes));
      void decide(origin, pending, valid && m.share, valid ? m.scopes : undefined);
      if (!valid) try { port.disconnect(); } catch { /* closed */ }
    });
    describe(origin, true);
  }
  function acceptSites(port) {
    if (internalUrl(port) !== api.runtime.getURL('ui/picker.html')) fail('ui_sender');
    managers.add(port);
    port.onDisconnect.addListener(() => managers.delete(port));
    port.onMessage.addListener(m => {
      if (!managers.has(port)) return;
      if (exact(m, ['type', 'origin']) && m.type === 'revoke' && typeof m.origin === 'string') { void revoke(m.origin); return; } // Also the Retry action.
      if (exact(m, ['type', 'origin', 'scopes']) && m.type === 'scopes' && typeof m.origin === 'string' && scopeChoice(m.scopes)) { void setScopes(m.origin, { ...m.scopes }); return; }
      managers.delete(port); try { port.disconnect(); } catch { /* closed */ }
    });
    void loaded.then(() => { if (managers.has(port)) try { port.postMessage(siteList()); } catch { managers.delete(port); } });
  }
  const ownsPort = port => [APPROVAL_PORT, SITES_PORT].includes(port?.name);
  function acceptPort(port) { if (port?.name === APPROVAL_PORT) acceptApproval(port); else if (port?.name === SITES_PORT) acceptSites(port); else fail('ui_sender'); }
  api.windows?.onRemoved?.addListener(id => { for (const p of [...approvals.values()]) if (p.windowId === id) void decide(p.origin, p, false); });
  function stop() { feed.stop(); relay.stop(); }
  return Object.freeze({ ready, ownsPort, acceptPort, acceptExternal, revoke, stop, origins: () => [...committed].filter(isShared).sort(), sites: () => siteList().sites });
}
