const number = v => Number.isSafeInteger(v) && v >= 0 && v <= 1000000;
export async function readSummary(id, call, read) {
  const character = await read();
  const response = await call('https://character-service-scds.dndbeyond.com/v2/characters', 'POST', { characterIds: [Number(id)] });
  const computed = response.status === 200 ? response.data?.foundCharacters?.find(c => c.characterId === Number(id)) : null;
  const hp = computed?.hitPointInfo;
  const consistent = hp && [hp.current, hp.maximum, hp.temp, character.removedHitPoints, character.temporaryHitPoints].every(number) &&
    hp.current + character.removedHitPoints === hp.maximum && hp.temp === character.temporaryHitPoints;
  const capability = consistent ? 'verified' : 'unsupported';
  return { schema: 1, character_id: id, url: `https://www.dndbeyond.com/characters/${id}`, name: String(character.name ?? '').slice(0, 256),
    vitals: { current: consistent ? hp.current : null, maximum: consistent ? hp.maximum : null, temporary: number(character.temporaryHitPoints) ? character.temporaryHitPoints : null },
    observed_at_ms: Date.now(), freshness: 'fresh', capabilities: { read: 'verified', apply_damage: capability, apply_healing: capability, set_temporary_hp: capability } };
}
export async function characterControl({ method, route, body, id, call, read }) {
  if (method === 'GET' && route === '/summary') return { status: 200, body: { summary: await readSummary(id, call, read) } };
  const hp = /^\/hp\/(damage|heal|temporary)$/u.exec(route);
  if (method !== 'POST' || !hp) return null;
  const field = hp[1] === 'temporary' ? 'value' : 'amount';
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => ![field, 'expected'].includes(k)) ||
      !number(body[field]) || field === 'amount' && body[field] === 0 || body.expected !== undefined &&
      (!body.expected || Object.keys(body.expected).sort().join(',') !== 'current,maximum,temporary' || !Object.values(body.expected).every(number))) throw Error('invalid_request');
  const before = await readSummary(id, call, read), vitals = before.vitals;
  if (before.capabilities.apply_damage !== 'verified') return { status: 200, body: { state: 'rejected', reason: 'hp_unavailable', summary: before } };
  if (body.expected && Object.keys(vitals).some(k => vitals[k] !== body.expected[k])) return { status: 200, body: { state: 'conflict', reason: 'expected_hp_changed', summary: before } };
  let current = vitals.current, temporary = vitals.temporary;
  if (hp[1] === 'damage') { const absorbed = Math.min(temporary, body.amount); temporary -= absorbed; current = Math.max(0, current - body.amount + absorbed); }
  else if (hp[1] === 'heal') current = Math.min(vitals.maximum, current + body.amount);
  else temporary = body.value;
  if (current === vitals.current && temporary === vitals.temporary) return { status: 200, body: { state: 'verified', summary: before } };
  try {
    const reply = await call('/character/v5/life/hp/damage-taken', 'PUT', { characterId: Number(id), removedHitPoints: vitals.maximum - current, temporaryHitPoints: temporary });
    if (reply.status < 200 || reply.status >= 300 || reply.data?.success === false) return { status: 200, body: { state: reply.status >= 400 && reply.status < 500 || reply.data?.success === false ? 'rejected' : 'unknown', response: reply } };
    const after = await readSummary(id, call, read);
    const verified = after.vitals.current === current && after.vitals.temporary === temporary && after.vitals.maximum === vitals.maximum;
    return { status: 200, body: { state: verified ? 'verified' : 'unknown', reason: verified ? null : 'readback_mismatch', summary: after } };
  } catch (e) { return { status: 200, body: { state: 'unknown', reason: e.message } }; }
}
