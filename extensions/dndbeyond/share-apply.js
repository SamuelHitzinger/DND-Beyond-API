// character-share v2 writes ("apply"). Shape checks never serialize the message.
// Outcomes are idempotent per op_id: the last 200 are kept in storage.session and
// a repeated op_id returns the stored outcome. A write is never retried
// automatically; one interrupted by a worker restart is reported as unknown.
export const APPLY_LIMITS = Object.freeze({ perMinute: 20, keep: 200, saveWaitMs: 2000 });
const OP_ID = /^[A-Za-z0-9_-]{1,40}$/u, CHARACTER = /^[1-9][0-9]{0,15}$/u;
const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const plain = m => !!m && typeof m === 'object' && Object.getPrototypeOf(m) === Object.prototype;
function keys(m, required, optional = []) {
  if (!plain(m)) return false;
  let n = 0;
  for (const k in m) if (++n > required.length + optional.length || !required.includes(k) && !optional.includes(k)) return false;
  return required.every(k => Object.hasOwn(m, k));
}
const BASE = ['type', 'op_id', 'character_id', 'op'];
export function applyShape(m) {
  if (!plain(m) || m.type !== 'apply' || typeof m.op_id !== 'string' || !OP_ID.test(m.op_id) ||
      typeof m.character_id !== 'string' || !CHARACTER.test(m.character_id)) return false;
  switch (m.op) {
    case 'damage': case 'heal': case 'temp':
      return keys(m, [...BASE, 'amount'], ['expected']) && int(m.amount, 0, 1000000) &&
        (m.expected === null || m.expected === undefined || keys(m.expected, ['current', 'maximum', 'temporary']) && ['current', 'maximum', 'temporary'].every(k => int(m.expected[k], 0, 1000000)));
    case 'condition':
      return keys(m, [...BASE, 'condition', 'on'], ['level']) && int(m.condition, 1, 15) && typeof m.on === 'boolean' && (m.level === null || m.level === undefined || int(m.level, 1, 6));
    case 'death_saves':
      return keys(m, [...BASE, 'success', 'fail']) && int(m.success, 0, 3) && int(m.fail, 0, 3);
    default: return false;
  }
}
const STATES = new Set(['verified', 'rejected', 'conflict', 'unknown']);
export const reasonCode = v => typeof v === 'string' && /^[a-z0-9_]{1,40}$/u.test(v) ? v : v === null || v === undefined ? null : 'request_failed';
const outcome = (state, reason = null) => Object.freeze({ state, reason: reasonCode(reason) });
const validStored = v => plain(v) && (STATES.has(v.state) || v.state === 'pending') && (v.reason === null || typeof v.reason === 'string');
// run(origin, message) -> { state, reason, final } where final=false means nothing
// was dispatched to D&D Beyond (so the op_id stays free for a later attempt).
// No write is dispatched until the ledger has been read successfully (an unreadable
// ledger could otherwise let a repeated op_id apply twice); the per-origin rate window
// is kept in the same storage, with wall-clock times, so a worker restart does not reset it.
export function createApplier({ storage, run, now = () => Date.now() }) {
  const outcomes = new Map(), inflight = new Map();
  let rates = new Map(), writes = Promise.resolve(), ready = false, loading = null;
  // Resolves true once the ledger was read; an unreadable ledger is retried on the next apply.
  function load() {
    if (ready) return Promise.resolve(true);
    return loading ??= (async () => {
      try {
        const got = await storage.get(['shareApplies', 'shareApplyRates']);
        const saved = got?.shareApplies, savedRates = got?.shareApplyRates;
        if (Array.isArray(saved)) for (const e of saved.slice(-APPLY_LIMITS.keep)) if (Array.isArray(e) && typeof e[0] === 'string' && validStored(e[1]) && !outcomes.has(e[0])) outcomes.set(e[0], { state: e[1].state, reason: e[1].reason });
        if (plain(savedRates)) for (const [o, v] of Object.entries(savedRates)) if (Array.isArray(v)) rates.set(o, v.filter(Number.isFinite).slice(-APPLY_LIMITS.perMinute));
        ready = true;
      } catch { ready = false; }
      loading = null;
      return ready;
    })();
  }
  void load();
  function persist() {
    const entries = [...outcomes].slice(-APPLY_LIMITS.keep), windows = Object.fromEntries(rates);
    const run = writes.then(() => storage.set({ shareApplies: entries, shareApplyRates: windows }));
    writes = run.catch(() => {}); return run;
  }
  function remember(key, value) {
    outcomes.delete(key); outcomes.set(key, value);
    while (outcomes.size > APPLY_LIMITS.keep) outcomes.delete(outcomes.keys().next().value);
    return persist();
  }
  // checks: { scope(): bool, character(): bool }
  async function apply(origin, m, checks) {
    if (!checks.scope()) return outcome('rejected', 'scope');
    if (!checks.character()) return outcome('rejected', 'character');
    const key = origin + '\n' + m.op_id;
    if (!await load()) return outcome('rejected', 'storage_unavailable');
    if (inflight.has(key)) return inflight.get(key);
    const stored = outcomes.get(key);
    if (stored?.state === 'pending') { // Dispatched by an earlier worker that stopped before the outcome was known.
      const interrupted = outcome('unknown', 'interrupted'); void remember(key, interrupted).catch(() => {}); return interrupted;
    }
    if (stored) return outcome(stored.state, stored.reason);
    const t = now(), recent = (rates.get(origin) ?? []).filter(x => t - x < 60000 && x <= t);
    if (recent.length >= APPLY_LIMITS.perMinute) { rates.set(origin, recent); return outcome('rejected', 'rate'); }
    recent.push(t); rates.set(origin, recent);
    const work = (async () => {
      // Record the attempt first so a restarted worker never applies this op_id again.
      try { await remember(key, { state: 'pending', reason: null }); }
      catch { outcomes.delete(key); return outcome('rejected', 'storage_unavailable'); }
      let result;
      try { result = await run(origin, m); } catch (e) { result = { state: 'unknown', reason: e?.message, final: true }; }
      const done = outcome(STATES.has(result?.state) ? result.state : 'unknown', result?.reason);
      // Save the outcome (or clear the pending marker) before replying, so a worker
      // that stops right after the reply does not later report this op as interrupted.
      // Bounded: a hung storage write never withholds the reply.
      let saved;
      if (result?.final === false) { outcomes.delete(key); saved = persist(); }
      else saved = remember(key, { state: done.state, reason: done.reason });
      await Promise.race([saved.catch(() => {}), new Promise(resolve => { const t = setTimeout(resolve, APPLY_LIMITS.saveWaitMs); t?.unref?.(); })]);
      return done;
    })().finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }
  return Object.freeze({ apply });
}
