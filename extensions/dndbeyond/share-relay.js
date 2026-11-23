// character-share v2 roll relay. The worker listens to D&D Beyond's game log as
// the signed-in player and forwards only fulfilled dice rolls of the selected
// character that were made public or sent to the DM. It never sends anything to
// D&D Beyond except the keep-alive ping, and every failure is reported as a state.
export const RELAY_LIMITS = Object.freeze({ pingMs: 20000, minBackoffMs: 1000, maxBackoffMs: 30000, stableMs: 30000, campaignRetryMs: 60000,
  bufferMs: 30000, seen: 500, frameBytes: 262144, rolls: 10, sets: 10, dice: 100 });
const L = RELAY_LIMITS;
export const GAME_LOG = 'wss://game-log-api-live.dndbeyond.com/v1';
const ABILITIES = Object.freeze({ str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' });
const TYPES = new Set(['to hit', 'damage', 'check', 'save', 'heal', 'roll']);
const DAMAGE_TYPES = new Set(['acid', 'bludgeoning', 'cold', 'fire', 'force', 'lightning', 'necrotic', 'piercing', 'poison', 'psychic', 'radiant', 'slashing', 'thunder']);
function rollType(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (TYPES.has(v)) return v;
  if (v === 'attack') return 'to hit';
  if (v === 'healing') return 'heal';
  return DAMAGE_TYPES.has(v) ? 'damage' : 'roll'; // spell, recharge and unknown types
}
const KINDS = new Set(['', 'advantage', 'disadvantage', 'critical hit']);
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&apos;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘' };
// Plain text only: tags removed, D&D Beyond's apostrophe control bytes (0x18-0x1f)
// mapped back to ’, other control characters dropped, whitespace collapsed.
const range = (from, to) => String.fromCharCode(from) + '-' + String.fromCharCode(to);
const APOSTROPHES = new RegExp('[' + range(0x18, 0x1f) + ']', 'gu');
const INVISIBLE = new RegExp('[' + [[0x00, 0x17], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([f, t]) => range(f, t)).join('') + ']', 'gu');
export function cleanText(value, max = 120) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 20000).replace(/<[^>]*>/gu, ' ').replace(/&(?:amp|lt|gt|quot|#39|#x27|apos|nbsp|rsquo|lsquo);/gu, e => ENTITIES[e])
    .replace(/[\t\n\r\f\v]/gu, ' ').replace(APOSTROPHES, '’').replace(INVISIBLE, '')
    .replace(/\s+/gu, ' ').trim().slice(0, max);
}
const integer = v => Number.isSafeInteger(v) && Math.abs(v) <= 1000000;
// dateTime is observed both as epoch seconds and as milliseconds (string or number).
function time(value) {
  let n = typeof value === 'number' ? value : typeof value === 'string' && /^[0-9]{9,16}(?:\.[0-9]+)?$/u.test(value) ? Number(value) : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 100000000000) n *= 1000;
  n = Math.round(n);
  return Number.isSafeInteger(n) ? n : null;
}
function mapRoll(r) {
  const notation = r?.diceNotation;
  if (!notation || !Array.isArray(notation.set) || notation.set.length > L.sets) return null;
  const dice = [], parts = [];
  for (const set of notation.set) {
    const sides = /^d([1-9][0-9]{0,3})$/u.exec(typeof set?.dieType === 'string' ? set.dieType : '')?.[1];
    if (!sides || !Array.isArray(set.dice) || set.dice.length > L.dice) return null;
    const values = set.dice.map(d => d?.dieValue);
    if (!values.every(v => Number.isSafeInteger(v) && v >= 0 && v <= 10000)) return null;
    const count = Number.isSafeInteger(set.count) && set.count > 0 && set.count <= L.dice ? set.count : values.length;
    dice.push({ sides: Number(sides), values, keep: set.operation === 1 ? 'lowest' : set.operation === 2 ? 'highest' : 'all' });
    if (count) parts.push(`${count}d${sides}`);
  }
  const constant = integer(notation.constant) ? notation.constant : 0;
  const kept = dice.reduce((sum, d) => sum + (!d.values.length ? 0 : d.keep === 'highest' ? Math.max(...d.values) : d.keep === 'lowest' ? Math.min(...d.values) : d.values.reduce((a, b) => a + b, 0)), 0);
  const total = integer(r.result?.total) ? r.result.total : kept + constant;
  const text = parts.join('+') + (constant > 0 || !parts.length ? `${parts.length ? '+' : ''}${constant}` : constant < 0 ? String(constant) : '');
  return { type: rollType(r.rollType), kind: KINDS.has(r.rollKind) ? r.rollKind : '', notation: text, dice, constant, total };
}
// One game-log frame -> a contract roll, or null when it must not be relayed.
export function mapGameLogMessage(frame, { characterId, userId, now = () => Date.now() }) {
  try {
    if (!frame || typeof frame !== 'object' || frame.eventType !== 'dice/roll/fulfilled') return null;
    const data = frame.data, context = data?.context ?? {};
    if (!data || typeof data !== 'object') return null;
    const entityType = frame.entityType ?? context.entityType, entityId = frame.entityId ?? context.entityId;
    if (entityType !== 'character' || !['string', 'number'].includes(typeof entityId) || String(entityId) !== characterId) return null;
    const scope = frame.messageScope ?? context.messageScope, target = frame.messageTarget ?? context.messageTarget;
    let to;
    if (scope === 'gameId') to = 'everyone';
    else if (scope === 'userId' && ['string', 'number'].includes(typeof target) && String(target) !== '') {
      if (String(target) === String(userId)) return null; // Rolls only the player sees are never relayed.
      to = 'dm';
    } else return null;
    if (typeof data.rollId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(data.rollId)) return null;
    if (!Array.isArray(data.rolls) || !data.rolls.length || data.rolls.length > L.rolls) return null;
    const rolls = data.rolls.map(mapRoll);
    if (rolls.some(r => r === null)) return null;
    const action = typeof data.action === 'string' ? data.action : '';
    const label = ABILITIES[action.trim().toLowerCase()] ?? (cleanText(action, 120) || 'Roll');
    const d20 = rolls.find(r => r.dice.some(d => d.sides === 20));
    let advantage = d20?.kind === 'advantage' || d20?.kind === 'disadvantage' ? d20.kind : null;
    if (!advantage && d20) { const set = d20.dice.find(d => d.sides === 20 && d.values.length > 1 && d.keep !== 'all'); if (set) advantage = set.keep === 'highest' ? 'advantage' : 'disadvantage'; }
    return { roll_id: data.rollId, label, to, advantage, initiative: /^initiative$/iu.test(label), at_ms: time(frame.dateTime) ?? time(data.dateTime) ?? now(), rolls };
  } catch { return null; }
}
const codeOf = e => typeof e?.message === 'string' && /^[a-z0-9_]{1,40}$/u.test(e.message) ? e.message : 'request_failed';
const UNAVAILABLE = new Set(['permission_required', 'reauth_required', 'forbidden', 'account_mismatch', 'no_websocket', 'no_selection']);
// connectInfo(characterId) resolves { url, userId } or throws: no_campaign, permission_required, ...
export function createRollRelay({ connectInfo, WebSocket = globalThis.WebSocket, timers = globalThis, now = () => performance.now(), clock = () => Date.now(),
  storage = null, onRoll = () => {}, onState = () => {} }) {
  let character = null, active = false, socket = null, epoch = 0, retry = null, ping = null, backoff = L.minBackoffMs, openedAt = 0;
  let status = Object.freeze({ state: 'off' }), buffer = [], persisting = Promise.resolve();
  const seen = new Set();
  const loaded = (async () => {
    try {
      const saved = (await storage?.get('shareRolls'))?.shareRolls;
      if (!saved || !Array.isArray(saved.seen) || !Array.isArray(saved.buffer)) return;
      for (const id of saved.seen.slice(-L.seen)) if (typeof id === 'string') seen.add(id);
      buffer = saved.buffer.filter(e => Number.isSafeInteger(e?.at) && typeof e.character_id === 'string' && typeof e.roll?.roll_id === 'string').slice(-200);
    } catch { /* session storage unavailable: start empty */ }
  })();
  function setState(state, detail = null) {
    if (status.state === state && (status.detail ?? null) === detail) return;
    status = Object.freeze(detail ? { state, detail } : { state });
    try { onState(); } catch { /* subscriber failed */ }
  }
  function close() {
    epoch++; timers.clearTimeout(retry); timers.clearTimeout(ping); retry = ping = null; openedAt = 0;
    const s = socket; socket = null;
    if (s) { try { s.onopen = s.onmessage = s.onerror = s.onclose = null; s.close(1000); } catch { /* already closed */ } }
  }
  function schedule(e, delay = null) {
    if (e !== epoch || !active) return;
    const wait = delay ?? backoff; if (delay === null) backoff = Math.min(backoff * 2, L.maxBackoffMs);
    retry = timers.setTimeout(() => { retry = null; void connect(e); }, wait); retry?.unref?.();
  }
  function keepAlive(s) {
    ping = timers.setTimeout(() => {
      ping = null; if (socket !== s) return;
      try { s.send('{"data":"ping"}'); } catch { /* closing; onclose reconnects */ }
      keepAlive(s);
    }, L.pingMs); ping?.unref?.();
  }
  async function connect(e) {
    if (e !== epoch || !active) return;
    if (status.state === 'off') setState('unavailable', 'connecting');
    let info;
    try {
      if (typeof WebSocket !== 'function') throw Error('no_websocket');
      info = await connectInfo(character);
    } catch (error) {
      if (e !== epoch) return;
      const code = codeOf(error);
      if (code === 'no_campaign') { setState('no_campaign'); schedule(e, L.campaignRetryMs); return; }
      setState(UNAVAILABLE.has(code) ? 'unavailable' : 'error', code); schedule(e); return;
    }
    if (e !== epoch || !active) return;
    let s;
    try { s = new WebSocket(info.url); } catch { setState('error', 'socket_failed'); schedule(e); return; }
    socket = s; const id = character, userId = info.userId;
    s.onopen = () => { if (socket !== s) return; openedAt = now(); setState('listening'); keepAlive(s); };
    s.onmessage = event => { if (socket === s) void receive(event?.data, id, userId); };
    s.onerror = () => {}; // onclose follows and reports.
    s.onclose = event => {
      if (socket !== s) return;
      socket = null; timers.clearTimeout(ping); ping = null;
      if (openedAt && now() - openedAt >= L.stableMs) backoff = L.minBackoffMs;
      openedAt = 0;
      const code = Number.isSafeInteger(event?.code) ? event.code : 0;
      setState('error', `closed_${code}`); schedule(e);
    };
  }
  function prune() { const t = clock(); buffer = buffer.filter(entry => t - entry.at < L.bufferMs && entry.at <= t + 1000); }
  function persist() {
    const value = { seen: [...seen].slice(-L.seen), buffer };
    persisting = persisting.then(() => storage?.set({ shareRolls: value })).catch(() => {});
  }
  async function receive(raw, id, userId) {
    if (typeof raw !== 'string' || raw.length > L.frameBytes) return;
    let frame; try { frame = JSON.parse(raw); } catch { return; }
    const roll = mapGameLogMessage(frame, { characterId: id, userId, now: clock });
    if (!roll) return;
    await loaded;
    // D&D Beyond resends recent dice after a reconnect: relay each rollId once.
    if (seen.has(roll.roll_id)) return;
    seen.add(roll.roll_id); while (seen.size > L.seen) seen.delete(seen.values().next().value);
    prune(); buffer.push({ at: clock(), character_id: id, roll }); if (buffer.length > 200) buffer = buffer.slice(-200); persist();
    if (id === character) try { onRoll(id, roll); } catch { /* subscriber failed */ }
  }
  function update(id, on) {
    const want = !!on && typeof id === 'string';
    if (id === character && want === active) return;
    character = id; active = want; close(); backoff = L.minBackoffMs;
    if (!active) { setState('off'); return; }
    setState('unavailable', 'connecting');
    void connect(epoch);
  }
  async function buffered(id) { await loaded; prune(); return buffer.filter(entry => entry.character_id === id).map(entry => entry.roll); }
  return Object.freeze({ update, buffered, status: () => status, stop: () => { active = false; close(); setState('off'); } });
}
