// character-share v2 sheet projection, portrait and the shared sheet poll.
// Inputs are D&D Beyond's v5 character JSON and the SCDS computed sheet. Field
// names beyond the HP rule are taken from open-source parsers (Avrae's SCDS
// types, ddb-importer, Splat) and are parsed defensively: anything missing or
// of an unexpected shape becomes null, and building never throws.
import { cleanText } from './share-relay.js';
export const SCDS_URL = 'https://character-service-scds.dndbeyond.com/v2/characters';
export const SHEET_LIMITS = Object.freeze({ abilities: 6, skills: 40, attacks: 60, spells: 300, slots: 10, conditions: 15, bytes: 90 * 1024,
  portraitBytes: 90 * 1024, portraitDownload: 3 * 1024 * 1024, portraitSize: 128, portraits: 16, portraitRetryMs: 600000 });
const L = SHEET_LIMITS;
const KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const LONG = { str: 'strength', dex: 'dexterity', con: 'constitution', int: 'intelligence', wis: 'wisdom', cha: 'charisma' };
const SKILLS = { acrobatics: 'dex', 'animal handling': 'wis', arcana: 'int', athletics: 'str', deception: 'cha', history: 'int', insight: 'wis',
  intimidation: 'cha', investigation: 'int', medicine: 'wis', nature: 'int', perception: 'wis', performance: 'cha', persuasion: 'cha',
  religion: 'int', 'sleight of hand': 'dex', stealth: 'dex', survival: 'wis' };
// D&D Beyond activation types (rule data): 1 action, 3 bonus action, 4 reaction, 6 minute, 7 hour.
const ACTIVATION = { 1: ['action', 'actions'], 3: ['bonus action', 'bonus actions'], 4: ['reaction', 'reactions'], 6: ['minute', 'minutes'], 7: ['hour', 'hours'] };
// Standard multiclass spellcaster table (caster level 1-20 -> slots of level 1-9).
const FULL_CASTER = [[], [2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2], [4, 3, 3, 3, 2, 1],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1, 1],
  [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
const DAMAGE = /^(?:\d+d\d+(?:[+-]\d+)*|\d+)$/u;
const int = (v, min = -1000000, max = 1000000) => Number.isSafeInteger(v) && v >= min && v <= max ? v : null;
const obj = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const arr = v => Array.isArray(v) ? v : [];
const text = (v, max = 120) => cleanText(v, max) || null;
const safe = (f, fallback) => { try { return f(); } catch { return fallback; } };
function damageText(value) {
  if (int(value, 0) !== null) return String(value);
  const v = obj(value);
  const given = typeof v.diceString === 'string' ? v.diceString.replaceAll(/\s/gu, '') : '';
  if (DAMAGE.test(given) && given.length <= 40) return given;
  const count = int(v.diceCount, 1, 100), sides = int(v.diceValue, 1, 1000), fixed = int(v.fixedValue) ?? 0;
  if (count && sides) return `${count}d${sides}${fixed > 0 ? '+' + fixed : fixed < 0 ? fixed : ''}`;
  if (!count && int(v.fixedValue, 0) !== null) return String(v.fixedValue);
  return null;
}
const findAbility = (list, key) => list.find(a => [a?.name, a?.label].some(n => typeof n === 'string' && [key, LONG[key]].includes(n.trim().toLowerCase())));
function proficientSaves(character) {
  const found = new Set(), groups = obj(character.modifiers);
  // Item modifiers can depend on equipping/attunement, so only these groups count.
  for (const group of ['race', 'class', 'background', 'feat']) {
    for (const m of arr(groups[group])) if (m?.type === 'proficiency' && typeof m.subType === 'string') {
      const match = /^([a-z]+)-saving-throws$/u.exec(m.subType); if (match) found.add(match[1]);
    }
  }
  return found;
}
function hitPoints(character, computed) {
  // Same verified consistency rule as character-summary.js.
  const hp = computed?.hitPointInfo, n = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000000;
  if (!hp || ![hp.current, hp.maximum, hp.temp, character.removedHitPoints, character.temporaryHitPoints].every(n)) return null;
  if (hp.current + character.removedHitPoints !== hp.maximum || hp.temp !== character.temporaryHitPoints) return null;
  return { current: hp.current, max: hp.maximum, temp: hp.temp };
}
function slotMaxima(classes) {
  const table = c => arr(obj(obj(c?.definition).spellRules).levelSpellSlots);
  const row = c => arr(table(c)[int(c?.level, 0, 20) ?? -1]).map(v => int(v, 0, 20) ?? 0);
  const casters = classes.filter(c => table(c).some(r => arr(r).some(v => int(v, 1) !== null)));
  const warlock = casters.filter(c => obj(c.definition).name === 'Warlock');
  const others = casters.filter(c => !warlock.includes(c));
  let spell = null;
  if (others.length === 1) spell = row(others[0]);
  else if (others.length > 1) {
    let level = 0;
    for (const c of others) {
      const rules = obj(obj(c.definition).spellRules), divisor = int(rules.multiClassSpellSlotDivisor, 1, 3);
      if (!divisor) { level = null; break; }
      level += (int(rules.multiClassSpellSlotRounding) === 2 ? Math.ceil : Math.floor)((int(c.level, 0, 20) ?? 0) / divisor);
    }
    spell = level === null ? null : FULL_CASTER[Math.min(level, 20)];
  } else spell = [];
  return { spell, pact: warlock.length === 1 ? row(warlock[0]) : warlock.length ? null : [] };
}
function spellSlots(character) {
  const { spell, pact } = slotMaxima(arr(character.classes)), slots = [];
  for (const [list, maxima, isPact] of [[character.spellSlots, spell, false], [character.pactMagic, pact, true]]) {
    for (const s of arr(list)) {
      const level = int(s?.level, 1, 9), used = int(s?.used, 0, 20);
      if (level === null || used === null) continue;
      const max = maxima ? maxima[level - 1] ?? 0 : null;
      if ((max ?? 0) > 0 || used > 0) slots.push({ level, used, max, pact: isPact });
    }
  }
  return slots.slice(0, L.slots);
}
function castingFor(info, className) {
  const pick = list => {
    const entries = arr(list).filter(e => int(e?.value) !== null);
    const own = entries.filter(e => className && arr(e.sources).includes(className));
    return own.length ? own[0].value : entries.length === 1 ? entries[0].value : null;
  };
  return { toHit: pick(info.spellAttacks), dc: pick(info.saveDcs) };
}
function spells(character, computed) {
  const classes = new Map(arr(character.classes).map(c => [c?.id, obj(c?.definition).name])), info = obj(computed?.castingInfo), found = new Map();
  const add = (s, className, fromClass) => {
    const d = obj(s?.definition), name = text(d.name), level = int(d.level, 0, 9);
    if (!name || level === null) return;
    const casting = fromClass ? castingFor(info, className) : { toHit: null, dc: null };
    const save = d.requiresSavingThrow === true, range = obj(d.range), activation = obj(d.activation), unit = ACTIVATION[activation.activationType];
    const time = int(activation.activationTime, 1, 1000);
    const damage = arr(d.modifiers).filter(m => m?.type === 'damage').map(m => damageText(m.die)).find(Boolean) ?? null;
    const prepared = s.prepared === true || s.alwaysPrepared === true || level === 0 || !fromClass;
    const spell = { name, level, to_hit: d.requiresAttackRoll === true ? int(casting.toHit) : null, save_dc: save ? int(casting.dc, 0, 100) : null,
      save_ability: save ? KEYS[int(d.saveDcAbilityId, 1, 6) - 1] ?? null : null, damage, prepared, school: text(d.school, 40),
      casting_time: unit && time ? `${time} ${time === 1 ? unit[0] : unit[1]}` : null,
      range: int(range.rangeValue, 1, 100000) ? `${range.rangeValue} ft.` : text(range.origin, 40) };
    const key = `${level}\n${name}`, previous = found.get(key);
    if (!previous || !previous.prepared && spell.prepared) found.set(key, spell);
  };
  for (const group of arr(character.classSpells)) for (const s of arr(group?.spells)) add(s, classes.get(group?.characterClassId), true);
  for (const source of ['class', 'race', 'background', 'feat', 'item']) for (const s of arr(obj(character.spells)[source])) add(s, null, false);
  return [...found.values()].sort((a, b) => a.level - b.level || a.name.localeCompare(b.name)).slice(0, L.spells);
}
function attacks(computed) {
  return arr(computed?.attacks).slice(0, L.attacks).flatMap(a => {
    const name = text(a?.name); if (!name) return [];
    const damage = obj(a.damage), range = obj(a.range), save = obj(a.saveInfo);
    const value = int(range.value, 1, 100000), long = int(range.longRangeValue, 1, 100000);
    const where = [text(range.label, 40), value ? `${value}${long ? '/' + long : ''} ft.` : ''].filter(Boolean).join(' ');
    return [{ name, to_hit: int(a.toHit), damage: damageText(damage.value), damage_type: text(damage.type, 40), range: where || null,
      notes: int(save.value, 0, 100) !== null ? cleanText(`DC ${save.value} ${cleanText(save.label, 40)}`, 120) : null }];
  });
}
function summary(character, computed) {
  const classes = arr(character.classes), level = int(computed?.level, 1, 40) ?? (classes.length ? classes.reduce((n, c) => n + (int(c?.level, 0, 20) ?? 0), 0) || null : null);
  const race = text(obj(character.race).fullName) ?? text(obj(character.race).baseName) ?? text(obj(computed?.race).name);
  const classText = classes.length ? classes.map(c => [cleanText(obj(c?.definition).name, 60), int(c?.level, 1, 20)].filter(Boolean).join(' ')).filter(Boolean).join(' / ')
    : arr(computed?.classes).map(c => [cleanText(c?.name, 60), int(c?.level, 1, 20)].filter(Boolean).join(' ')).filter(Boolean).join(' / ');
  return { level, summary: cleanText([level ? `Level ${level}` : '', race ?? '', classText].filter(Boolean).join(' · '), 256) };
}
// Never throws; unknown values are null. computed may be null (SCDS unavailable).
export function buildSheet(characterInput, computedInput, fetchedAt) {
  const character = obj(characterInput), computed = computedInput && typeof computedInput === 'object' ? computedInput : null, c = obj(computed);
  const head = safe(() => summary(character, computed), { level: null, summary: '' });
  const abilityList = arr(c.abilities), saves = safe(() => proficientSaves(character), new Set());
  const speeds = arr(c.speeds), walk = speeds.find(s => /^walk/iu.test(s?.name ?? '')) ?? (speeds.length === 1 ? speeds[0] : null);
  const deathV5 = obj(character.deathSaves), deathScds = obj(c.deathSaveInfo);
  const death = [deathV5, deathScds].find(d => int(d.successCount, 0, 3) !== null && int(d.failCount, 0, 3) !== null);
  const sheet = {
    summary: head.summary, level: head.level, ac: int(c.armorClass, 0, 100), initiative: int(c.initiativeBonus, -100, 100), proficiency: int(c.proficiencyBonus, 0, 20),
    speed: int(walk?.distance, 0, 10000) !== null ? `${walk.distance} ft.` : null,
    inspiration: typeof character.inspiration === 'boolean' ? character.inspiration : c.inspiration === true,
    hp: safe(() => hitPoints(character, computed), null),
    passives: { perception: int(c.passivePerception, 0, 100), investigation: int(c.passiveInvestigation, 0, 100), insight: int(c.passiveInsight, 0, 100) },
    abilities: KEYS.map(key => { const a = obj(findAbility(abilityList, key)); return { key, score: int(a.score, 0, 100), modifier: int(a.modifier, -20, 50), save: int(a.save, -20, 50), save_proficient: saves.has(LONG[key]) }; }),
    skills: safe(() => arr(c.skills).slice(0, L.skills).flatMap(s => {
      const name = text(s?.name, 60); if (!name) return [];
      return [{ name, ability: SKILLS[name.toLowerCase()] ?? null, modifier: int(s.modifier, -20, 50), proficient: s.isProficient === true || s.isExpert === true,
        advantage: s.isAdvantage === true, disadvantage: s.isDisadvantage === true }];
    }), []),
    attacks: safe(() => attacks(computed), []),
    spells: safe(() => spells(character, computed), []),
    spell_slots: safe(() => spellSlots(character), []),
    conditions: safe(() => arr(character.conditions).flatMap(x => { const id = int(x?.id, 1, 15); return id === null ? [] : [{ id, level: id === 4 ? int(x.level, 1, 6) : null }]; }).slice(0, L.conditions), []),
    death_saves: death ? { success: death.successCount, fail: death.failCount } : null,
    fetched_at: Number.isSafeInteger(fetchedAt) ? fetchedAt : Date.now(),
  };
  // Stay under the size limit: shed the longest lists first, never the vitals.
  const size = () => new TextEncoder().encode(JSON.stringify(sheet)).length;
  // The margin keeps the whole sheet message (envelope included) under the limit.
  for (const key of ['spells', 'attacks', 'skills']) while (sheet[key].length && size() >= L.bytes - 512) sheet[key].length = Math.floor(sheet[key].length * 0.8);
  return sheet;
}
// Identical sheets compare equal regardless of when they were fetched.
export const sheetKey = sheet => JSON.stringify({ ...sheet, fetched_at: 0 });

export const PORTRAIT_HOSTS = Object.freeze(['www.dndbeyond.com', 'media.dndbeyond.com']);
export function portraitUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    // www.dndbeyond.com serves the whole site; only its /avatars/ images are portraits.
    if (url.hostname === 'www.dndbeyond.com' && !url.pathname.startsWith('/avatars/')) return null;
    return url.protocol === 'https:' && PORTRAIT_HOSTS.includes(url.hostname) && !url.port && !url.username && !url.password && !/\.svgz?$/iu.test(url.pathname) ? url.href : null;
  } catch { return null; }
}
const IMAGE = /^image\/(?:png|jpeg|jpg|pjpeg|webp|gif|avif|bmp)$/u;
async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw Error('too_large');
  if (!response.body?.getReader) { const b = await response.arrayBuffer(); if (b.byteLength > limit) throw Error('too_large'); return [new Uint8Array(b)]; }
  const reader = response.body.getReader(), chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength;
    if (total > limit) { try { await reader.cancel(); } catch { /* closed */ } throw Error('too_large'); }
    chunks.push(value);
  }
  return chunks;
}
function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}
// Decode, shrink to <= 128 px and re-encode (WebP, else JPEG) so pages only ever
// receive a small raster data: URL produced by the extension.
export async function encodePortrait(blob, { createImageBitmap: decode = globalThis.createImageBitmap, OffscreenCanvas: Canvas = globalThis.OffscreenCanvas } = {}) {
  if (typeof decode !== 'function' || typeof Canvas !== 'function') return null;
  const bitmap = await decode(blob);
  try {
    if (!bitmap.width || !bitmap.height) return null;
    const scale = Math.min(1, L.portraitSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new Canvas(width, height), context = canvas.getContext('2d');
    for (const [type, quality] of [['image/webp', 0.85], ['image/webp', 0.6], ['image/jpeg', 0.8], ['image/jpeg', 0.5]]) {
      context.clearRect(0, 0, width, height);
      if (type === 'image/jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
      context.drawImage(bitmap, 0, 0, width, height);
      const out = await canvas.convertToBlob({ type, quality });
      if (out.type !== type) continue; // WebP encoding unavailable: fall back to JPEG.
      const url = `data:${type};base64,` + base64(new Uint8Array(await out.arrayBuffer()));
      if (url.length < L.portraitBytes) return url;
    }
    return null;
  } finally { bitmap.close?.(); }
}
export function createPortraits({ fetch = (...a) => globalThis.fetch(...a), encode = blob => encodePortrait(blob), now = () => performance.now() } = {}) {
  const cache = new Map();
  async function load(url) {
    const response = await fetch(url, { credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', cache: 'default', signal: AbortSignal.timeout(15000) });
    // fetch cannot expose intermediate redirect hops; the final URL must be allowlisted too.
    if (!response.ok || response.url && !portraitUrl(response.url)) return null;
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE.test(type)) return null; // Never SVG or other active formats.
    const chunks = await readLimited(response, L.portraitDownload);
    return encode(new Blob(chunks, { type }));
  }
  function get(value) {
    const url = portraitUrl(value); if (!url) return Promise.resolve(null);
    const hit = cache.get(url);
    if (hit && (hit.ok || now() - hit.at < L.portraitRetryMs)) return hit.value;
    const entry = { at: now(), ok: false, value: null };
    entry.value = load(url).then(v => { entry.ok = typeof v === 'string'; return entry.ok ? v : null; }, () => null);
    cache.delete(url); cache.set(url, entry);
    while (cache.size > L.portraits) cache.delete(cache.keys().next().value);
    return entry.value;
  }
  return Object.freeze({ get });
}

// One shared poll for the selected character while any eligible port is open.
export function createSheetFeed({ load, deliver, timers = globalThis, now = () => performance.now(), intervalMs = 20000 }) {
  let id = null, active = false, timer = null, running = null, again = false, latest = null;
  function schedule() {
    if (!active || timer || running) return;
    timer = timers.setTimeout(() => { timer = null; poll(); }, intervalMs); timer?.unref?.();
  }
  function poll() {
    if (!active) return;
    if (running) { again = true; return; }
    timers.clearTimeout(timer); timer = null;
    const target = id;
    running = (async () => {
      try {
        const result = await load(target);
        if (target === id && active) { latest = { id: target, at: now(), result }; deliver(target, result); }
      } catch { /* Not delivered; the next poll tries again. */ }
    })().finally(() => { running = null; if (again && active) { again = false; poll(); } else { again = false; schedule(); } });
  }
  function update(nextId, on) {
    const changed = nextId !== id; id = nextId; active = !!on && typeof nextId === 'string';
    if (changed && latest?.id !== id) latest = null;
    if (!active) { timers.clearTimeout(timer); timer = null; return; }
    if (changed) poll(); else if (!running && (!latest || now() - latest.at >= intervalMs)) poll(); else schedule();
  }
  // The cached result only for the requested character (never another character's
  // sheet during a selection switch).
  const current = requested => latest && typeof requested === 'string' && latest.id === requested && latest.id === id ? latest.result : null;
  return Object.freeze({ update, poke: poll, current, forget: () => { latest = null; }, stop: () => { active = false; timers.clearTimeout(timer); timer = null; } });
}
