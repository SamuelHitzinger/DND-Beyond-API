// Additional character fields. Paths and payloads follow the public sheet's
// rules-engine request definitions and saga payload transforms.
const bad = () => { throw Error('invalid_request'); };
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && v >= min && v <= max;
const notes = new Set(['allies', 'personalPossessions', 'otherHoldings', 'organizations', 'enemies', 'backstory', 'otherNotes']);
const allActions = c => Object.values(c.actions ?? {}).flat().filter(Boolean);
const allSpells = c => (c.classSpells ?? []).flatMap(group => (group.spells ?? []).map(spell => ({ ...spell, characterClassId: group.characterClassId })));
export async function sheetRoute({ method, route, body, id, read, mutate }) {
  const cid = Number(id);
  const rest = /^\/rests\/(short|long)$/u.exec(route);
  if (rest && method === 'POST') {
    body ??= {};
    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['resetMaxHpModifier', ...(rest[1] === 'short' ? ['classHitDiceUsed'] : ['adjustConditionLevel'])].includes(k)) ||
        ['resetMaxHpModifier', 'adjustConditionLevel'].some(k => body[k] !== undefined && typeof body[k] !== 'boolean')) bad();
    const before = await read();
    const values = { characterId: cid, resetMaxHpModifier: body.resetMaxHpModifier ?? false };
    if (rest[1] === 'long') values.adjustConditionLevel = body.adjustConditionLevel ?? false;
    else {
      values.classHitDiceUsed = Object.fromEntries((before.classes ?? []).map(c => [c.id, c.hitDiceUsed]));
      const supplied = body.classHitDiceUsed ?? {};
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied) || Object.entries(supplied).some(([k, v]) => !Object.hasOwn(values.classHitDiceUsed, k) || !integer(v, 0, before.classes.find(c => String(c.id) === k).level))) bad();
      Object.assign(values.classHitDiceUsed, supplied);
    }
    const verifiedFields = [];
    const response = await mutate(`/character/v5/character/rest/${rest[1]}`, 'POST', values, (after, reply) => {
      const data = reply.data?.data;
      if (!data || typeof data !== 'object') return false;
      for (const k of ['overrideHitPoints', 'temporaryHitPoints', 'bonusHitPoints', 'removedHitPoints', 'spellSlots', 'pactMagic', 'conditions', 'classes']) {
        if (Object.hasOwn(data, k)) {
          if (JSON.stringify(data[k]) !== JSON.stringify(after[k])) return false;
          verifiedFields.push(k);
        }
      }
      if (data.actions) {
        for (const a of allActions(data)) {
          const found = allActions(after).find(v => String(v.id) === String(a.id) && String(v.entityTypeId) === String(a.entityTypeId));
          if (!found || JSON.stringify(found.limitedUse) !== JSON.stringify(a.limitedUse)) return false;
        }
        verifiedFields.push('actions');
      }
      return verifiedFields.includes('removedHitPoints') && verifiedFields.includes('spellSlots');
    });
    response.body.verifiedFields = verifiedFields;
    return response;
  }
  const custom = /^\/(custom-items|custom-actions)(?:\/([1-9][0-9]*))?$/u.exec(route);
  if (custom && ['POST', 'PUT', 'DELETE'].includes(method)) {
    const isItem = custom[1] === 'custom-items', collection = isItem ? 'customItems' : 'customActions';
    const path = `/character/v5/custom/${isItem ? 'item' : 'action'}`;
    const itemId = custom[2] ? Number(custom[2]) : null;
    if (method !== 'POST' && !integer(itemId, 1) || method === 'POST' && itemId !== null) bad();
    if (method === 'DELETE') return mutate(path, 'DELETE', { characterId: cid, id: itemId }, c => Array.isArray(c[collection]) && !c[collection].some(v => Number(v.id) === itemId));
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) bad();
    const before = await read(), previous = itemId === null ? null : before[collection]?.find(v => Number(v.id) === itemId);
    if (method === 'PUT' && !previous) bad();
    let properties;
    if (isItem) {
      const keys = ['name', 'description', 'quantity', 'weight', 'cost', 'notes'];
      if (Object.keys(body).some(k => !keys.includes(k))) bad();
      properties = Object.fromEntries(keys.map(k => [k, body[k] !== undefined ? body[k] : previous?.[k] ?? (k === 'quantity' ? 1 : null)]));
      if (typeof properties.name !== 'string' || !properties.name.length || !integer(properties.quantity, 1) ||
          ['cost', 'weight'].some(k => properties[k] !== null && (!Number.isFinite(properties[k]) || properties[k] < 0)) ||
          ['description', 'notes'].some(k => properties[k] !== null && typeof properties[k] !== 'string')) bad();
    } else {
      properties = { ...(method === 'POST' ? { actionType: 3 } : {}), ...body };
      if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.length) || method === 'POST' && !body.name) bad();
      if (properties.actionType !== undefined && !integer(properties.actionType, 1, 3)) bad();
    }
    const existing = new Set(before[collection]?.map(v => v.id)); let created = null;
    const response = await mutate(path, method, { ...properties, characterId: cid, ...(itemId !== null ? { id: itemId } : {}) }, c => {
      const candidates = itemId === null ? (c[collection] ?? []).filter(v => !existing.has(v.id)) : (c[collection] ?? []).filter(v => Number(v.id) === itemId);
      if (candidates.length !== 1) return false;
      created = candidates[0];
      return Object.keys(body).every(k => JSON.stringify(created[k] ?? null) === JSON.stringify(body[k] ?? null));
    });
    if (method === 'POST') response.body.id = created?.id ?? null;
    return response;
  }
  if (method === 'GET') {
    const fields = { '/inspiration': 'inspiration', '/xp': 'currentXp', '/death-saves': 'deathSaves', '/notes': 'notes', '/conditions': 'conditions', '/custom-items': 'customItems', '/custom-actions': 'customActions' };
    if (Object.hasOwn(fields, route)) { const key = fields[route]; return { status: 200, body: { [key]: (await read())[key] } }; }
    if (route === '/limited-use') return { status: 200, body: { actions: allActions(await read()).filter(a => a.limitedUse) } };
    if (route === '/prepared-spells') return { status: 200, body: { spells: allSpells(await read()) } };
  }
  if (method === 'PUT' && ['/inspiration', '/xp', '/death-saves', '/notes', '/limited-use', '/prepared-spells'].includes(route)) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad();
    switch (route) {
      case '/inspiration':
        if (typeof body.inspiration !== 'boolean') bad();
        return mutate('/character/v5/character/inspiration', 'PUT', { characterId: cid, inspiration: body.inspiration }, c => c.inspiration === body.inspiration);
      case '/xp':
        if (!integer(body.currentXp)) bad();
        return mutate('/character/v5/character/progression', 'PUT', { characterId: cid, currentXp: body.currentXp }, c => c.currentXp === body.currentXp);
      case '/death-saves':
        if (!integer(body.failCount, 0, 3) || !integer(body.successCount, 0, 3)) bad();
        return mutate('/character/v5/life/death-saves', 'PUT', { characterId: cid, failCount: body.failCount, successCount: body.successCount }, c => c.deathSaves?.failCount === body.failCount && c.deathSaves?.successCount === body.successCount);
      case '/notes': {
        if (!Object.keys(body).length || Object.keys(body).some(k => !notes.has(k) || body[k] !== null && typeof body[k] !== 'string')) bad();
        const values = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, v ?? '']));
        return mutate('/character/v5/description/notes', 'PUT', { characterId: cid, ...values }, c => Object.entries(values).every(([k, v]) => (c.notes?.[k] ?? '') === v));
      }
      case '/limited-use': {
        // Raw v5 action IDs are sometimes decimal strings, unlike spell/item IDs.
        const actionId = Number(body.id), entityTypeId = Number(body.entityTypeId);
        if (!integer(actionId, 1) || !integer(entityTypeId, 1) || !integer(body.uses)) bad();
        const find = c => allActions(c).find(a => Number(a.id) === actionId && Number(a.entityTypeId) === entityTypeId);
        if (!find(await read())?.limitedUse) bad();
        return mutate('/character/v5/action/limited-use', 'PUT', { characterId: cid, id: actionId, entityTypeId, uses: body.uses }, c => find(c)?.limitedUse?.numberUsed === body.uses);
      }
      case '/prepared-spells': {
        if (!integer(body.id, 1) || !integer(body.characterClassId, 1) || typeof body.prepared !== 'boolean') bad();
        const find = c => allSpells(c).find(s => s.id === body.id && s.characterClassId === body.characterClassId);
        const spell = find(await read()); if (!spell) bad();
        return mutate('/character/v5/spell/prepared', 'PUT', { characterId: cid, id: spell.id, entityTypeId: spell.entityTypeId, spellId: spell.definition.id, characterClassId: body.characterClassId, prepared: body.prepared }, c => find(c)?.prepared === body.prepared);
      }
    }
  }
  return null;
}
