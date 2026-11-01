// SCDS supplies computed sheet modifiers. Situational choices remain explicit;
// local rolls never consume resources, change HP, or post to the DDB game log.
const invalid = () => { throw Error('invalid_request'); };
const integer = n => Number.isSafeInteger(n);
const key = s => typeof s === 'string' ? s.trim().toLowerCase() : '';
function die(sides) {
  const limit = Math.floor(4294967296 / sides) * sides, sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= limit);
  return sample[0] % sides + 1;
}
function expression(text, critical = false) {
  if (typeof text !== 'string' || text.length > 200) invalid();
  const compact = text.replaceAll(/\s/gu, '').toLowerCase();
  if (!/^[+-]?(?:\d+d\d+|\d+)(?:[+-](?:\d+d\d+|\d+))*$/u.test(compact)) invalid();
  const dice = []; let modifier = 0, count = 0;
  for (const part of compact.match(/[+-]?[^+-]+/gu)) {
    const sign = part[0] === '-' ? -1 : 1, raw = part.replace(/^[+-]/u, '');
    if (raw.includes('d')) {
      let [n, sides] = raw.split('d').map(Number); if (critical) n *= 2;
      count += n;
      if (!integer(n) || n < 1 || count > 100 || !integer(sides) || sides < 2 || sides > 1000) invalid();
      dice.push({ sign, sides, count: n });
    } else modifier += sign * Number(raw);
  }
  if (!integer(modifier) || Math.abs(modifier) > 1000000) invalid();
  return { dice, modifier };
}
function choose(list, body) {
  if (!Array.isArray(list)) invalid();
  if (integer(body.index) && body.index >= 0 && body.index < list.length) return list[body.index];
  if (!key(body.name)) invalid();
  const found = list.filter(v => key(v.name) === key(body.name) || key(v.label) === key(body.name));
  if (found.length !== 1) invalid();
  return found[0];
}
export async function rollRoute({ method, route, body, id, call }) {
  if (route !== '/rolls' || !['GET', 'POST'].includes(method)) return null;
  if (method === 'POST' && (!body || typeof body !== 'object' || Array.isArray(body))) invalid();
  let sheet = null, fetchedAt = null;
  if (method === 'GET' || body.kind !== 'dice') {
    const r = await call('https://character-service-scds.dndbeyond.com/v2/characters', 'POST', { characterIds: [Number(id)] });
    const found = r.data?.foundCharacters?.filter(c => c.characterId === Number(id));
    if (r.status !== 200 || found?.length !== 1) return { status: 503, body: { error: 'scds_unresolved' } };
    sheet = found[0]; fetchedAt = Date.now();
  }
  if (method === 'GET') return { status: 200, body: { source: 'scds', fetchedAt, abilities: sheet.abilities, skills: sheet.skills, attacks: sheet.attacks, initiativeBonus: sheet.initiativeBonus } };
  const kind = body.kind; let item, parsed, advantage = body.advantage ?? 'auto', label = kind;
  if (!['auto', 'normal', 'advantage', 'disadvantage'].includes(advantage) || body.bonus !== undefined && (!integer(body.bonus) || Math.abs(body.bonus) > 1000000) || body.critical !== undefined && typeof body.critical !== 'boolean') invalid();
  if (kind === 'dice') parsed = expression(body.expression, body.critical);
  else if (kind === 'damage') {
    item = choose(sheet.attacks, body); label = item.name;
    const d = item.damage?.value;
    try {
      if (typeof d === 'number') parsed = expression(String(d));
      else if (typeof d === 'string') parsed = expression(d, body.critical);
      else if (d && (d.diceMultiplier === null || d.diceMultiplier === undefined || d.diceMultiplier === 1)) {
        // Structured dice are authoritative; the display string may be null.
        if (integer(d.diceCount) && d.diceCount > 0 && integer(d.diceValue) && integer(d.fixedValue ?? 0))
          parsed = expression(`${d.diceCount}d${d.diceValue}${(d.fixedValue ?? 0) >= 0 ? '+' : ''}${d.fixedValue ?? 0}`, body.critical);
        else if (d.diceCount === null || d.diceCount === 0) parsed = expression(String(d.fixedValue));
      }
    } catch { /* Unsupported upstream formula is explicit, never guessed. */ }
    if (!parsed) return { status: 422, body: { error: 'unsupported_damage_formula' } };
  } else {
    let modifier;
    switch (kind) {
      case 'ability': case 'save': item = choose(sheet.abilities, body); modifier = item[kind === 'save' ? 'save' : 'modifier']; break;
      case 'skill': item = choose(sheet.skills, body); modifier = item.modifier; break;
      case 'attack': item = choose(sheet.attacks, body); modifier = item.toHit; break;
      case 'initiative': modifier = sheet.initiativeBonus; break;
      default: invalid();
    }
    if (!integer(modifier)) return { status: 422, body: { error: 'modifier_unavailable' } };
    label = item?.name ?? kind;
    if (advantage === 'auto') advantage = kind === 'skill' && !!item.isAdvantage !== !!item.isDisadvantage ? (item.isAdvantage ? 'advantage' : 'disadvantage') : 'normal';
    parsed = { modifier, dice: [{ count: advantage === 'normal' ? 1 : 2, sides: 20, sign: 1 }] };
  }
  parsed.modifier += body.bonus ?? 0;
  const dice = parsed.dice.map(d => ({ sides: d.sides, sign: d.sign, values: Array.from({ length: d.count }, () => die(d.sides)) }));
  const d20 = !['dice', 'damage'].includes(kind);
  const sum = dice.reduce((total, d) => total + d.sign * (d20 && advantage === 'advantage' ? Math.max(...d.values) : d20 && advantage === 'disadvantage' ? Math.min(...d.values) : d.values.reduce((a, b) => a + b, 0)), 0);
  return { status: 200, body: { state: 'rolled', kind, label, source: sheet ? 'scds' : 'expression', fetchedAt, modifier: parsed.modifier, dice, total: sum + parsed.modifier, advantage: d20 ? advantage : null, critical: !!body.critical, posted: false } };
}
