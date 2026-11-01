// Script-facing convenience routes. Credentials and the actual fetch stay in
// http-read.js. Unknown writes are never retried or automatically inverted.
import { sheetRoute } from './sheet-api.js';
import { rollRoute } from './script-rolls.js';
import { characterControl } from './character-summary.js';
const HOSTS = new Set(['character-service.dndbeyond.com', 'character-service-scds.dndbeyond.com']);
const READ = new Set(['GET', 'HEAD']);
const result = (status, body) => ({ status, body });
const invalid = () => { throw Error('invalid_request'); };
const natural = (v, min = 0) => Number.isSafeInteger(v) && v >= min;
const COINS = ['cp', 'sp', 'ep', 'gp', 'pp'];
const acknowledgement = r => r.status >= 500 || r.status < 200 || r.status >= 300 && r.status < 400 ? 'unknown' : r.status >= 400 || r.data?.success === false ? 'rejected' : 'acknowledged';
export function characterUrl(path) {
  if (typeof path !== 'string' || path.includes('\\') || /[\u0000-\u0020]/u.test(path)) invalid();
  const url = new URL(path, 'https://character-service.dndbeyond.com');
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash) invalid();
  return url.href;
}
export function createScriptApi({ request }) {
  const queues = new Map();
  async function serial(id, operation) {
    const previous = queues.get(id) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation); queues.set(id, pending);
    try { return await pending; } finally { if (queues.get(id) === pending) queues.delete(id); }
  }
  async function handle(input, allowed, characters = [], selected = null) {
    try {
      const { method, body = null } = input;
      let { path } = input;
      if (typeof path !== 'string' || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) invalid();
      if (method === 'POST' && path === '/dev/reload-extension') {
        if (body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => k !== 'delayMs') ||
            body.delayMs !== undefined && (!natural(body.delayMs) || body.delayMs > 20000))) invalid();
        return result(202, { state: 'reloading' });
      }
      if (method === 'GET' && path === '/v1/characters') return result(200, { characters, selected });
      if (method === 'GET' && path === '/v1/status') return result(200, { browser: 'connected', characters, selected });
      const followsSelection = path === '/v1/character' || path.startsWith('/v1/character/');
      if (followsSelection) {
        if (!selected) return result(409, { error: 'no_character_selected' });
        path = `/v1/characters/${selected.id}` + path.slice('/v1/character'.length);
      }
      const match = /^\/v1\/characters\/([1-9][0-9]{0,15})(\/.*)?$/u.exec(path);
      if (!match || Number(match[1]) > Number.MAX_SAFE_INTEGER) return result(404, { error: 'route_not_found' });
      const id = match[1], route = match[2] ?? '';
      if (!allowed(id)) return result(403, { error: 'character_not_allowed' });
      const response = await serial(id, async () => {
        if (!allowed(id)) return result(403, { error: 'character_not_allowed' });
        const call = (path, method = 'GET', body = null) => request(id, characterUrl(path), { method, body, assertScope: () => { if (!allowed(id)) throw Error('revoked'); } });
        const read = async () => {
          const r = await call(`/character/v5/character/${id}`);
          if (r.status !== 200 || r.data?.success !== true || r.data.data?.id !== Number(id)) throw Error('read_failed');
          return r.data.data;
        };
        const control = await characterControl({ method, route, body, id, call, read });
        if (control) return control;
        const roll = await rollRoute({ method, route, body, id, call });
        if (roll) return roll;
        const sheet = await sheetRoute({ method, route, body, id, read, mutate: (...args) => mutate(call, read, ...args) });
        if (sheet) return sheet;
        if (route === '' && method === 'GET') return result(200, { character: await read() });
        if (route === '/inventory' && method === 'GET') { const c = await read(); return result(200, { inventory: c.inventory, customItems: c.customItems }); }
        if (route === '/inventory' && method === 'POST') {
          if (!body || !natural(body.entityId, 1) || !natural(body.entityTypeId, 1) || !natural(body.quantity ?? 1, 1)) invalid();
          const equipment = { entityId: body.entityId, entityTypeId: body.entityTypeId, quantity: body.quantity ?? 1,
            containerEntityId: body.containerEntityId ?? Number(id), containerEntityTypeId: body.containerEntityTypeId ?? 1581111423 };
          if (!natural(equipment.containerEntityId, 1) || !natural(equipment.containerEntityTypeId, 1)) invalid();
          const before = await read(), existing = new Set(before.inventory?.map(i => i.id)); let created = [];
          const response = await mutate(call, read, '/character/v5/inventory/item', 'POST', { characterId: Number(id), equipment: [equipment] }, c => {
            created = c.inventory?.filter(i => !existing.has(i.id) && i.definition?.id === equipment.entityId && i.definition?.entityTypeId === equipment.entityTypeId && i.quantity === equipment.quantity) ?? [];
            return created.length === 1;
          });
          response.body.itemIds = created.map(i => i.id); return response;
        }
        const removeItem = /^\/inventory\/([1-9][0-9]*)$/u.exec(route);
        if (removeItem && method === 'DELETE') {
          const itemId = Number(removeItem[1]); if (!natural(itemId, 1)) invalid();
          return mutate(call, read, '/character/v5/inventory/item', 'DELETE', { characterId: Number(id), id: itemId, removeContainerContents: false }, c => Array.isArray(c.inventory) && !c.inventory.some(i => i.id === itemId));
        }
        if (route === '/spell-slots' && method === 'GET') { const c = await read(); return result(200, { spellSlots: c.spellSlots, pactMagic: c.pactMagic }); }
        const slot = /^\/(spell-slots|pact-slots)\/([1-9])$/u.exec(route);
        if (slot && method === 'PUT') {
          const level = Number(slot[2]), key = slot[1] === 'pact-slots' ? 'pactMagic' : 'spellSlots';
          if (!body || !natural(body.used) || !(await read())[key]?.some(s => s.level === level)) invalid();
          return mutate(call, read, `/character/v5/spell/${key === 'pactMagic' ? 'pact-magic' : 'slots'}`, 'PUT', { characterId: Number(id), [`level${level}`]: body.used }, c => c[key]?.find(s => s.level === level)?.used === body.used);
        }
        if (route === '/currency' && method === 'GET') return result(200, { currencies: (await read()).currencies });
        if (route === '/currency' && method === 'PUT') {
          if (!body || !Object.keys(body).length || Object.keys(body).some(k => !COINS.includes(k) || !natural(body[k]))) invalid();
          const before = (await read()).currencies;
          if (!before || COINS.some(k => !natural(before[k]))) throw Error('read_failed');
          const target = { ...before, ...body };
          const delta = Object.fromEntries(Object.keys(body).map(k => [k, target[k] - before[k]]));
          return mutate(call, read, '/character/v5/inventory/currency/transaction', 'PUT', { characterId: Number(id), ...delta, destinationEntityId: Number(id), destinationEntityTypeId: 1581111423 },
            c => COINS.every(k => c.currencies?.[k] === target[k]));
        }
        const item = /^\/inventory\/([1-9][0-9]*)\/(equipped|attuned|quantity|container)$/u.exec(route);
        if (item && method === 'PUT') {
          const itemId = Number(item[1]), kind = item[2];
          if (!natural(itemId, 1) || !body) invalid();
          let fields, verify;
          if (kind === 'quantity') {
            if (!natural(body.quantity, 1)) invalid();
            fields = { quantity: body.quantity }; verify = i => i?.quantity === body.quantity;
          } else if (kind === 'container') {
            if (!natural(body.containerEntityId, 1) || !natural(body.containerEntityTypeId, 1)) invalid();
            fields = { containerEntityId: body.containerEntityId, containerEntityTypeId: body.containerEntityTypeId };
            verify = i => i?.containerEntityId === body.containerEntityId && i?.containerEntityTypeId === body.containerEntityTypeId;
          } else {
            if (typeof body.value !== 'boolean') invalid();
            fields = { value: body.value }; verify = i => i?.[kind === 'attuned' ? 'isAttuned' : 'equipped'] === body.value;
          }
          return mutate(call, read, `/character/v5/inventory/item/${kind === 'container' ? 'move' : kind}`, 'PUT', { characterId: Number(id), id: itemId, ...fields }, c => verify(c.inventory?.find(i => i.id === itemId)));
        }
        if (route === '/request' && method === 'POST') {
          if (!body || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(body.method)) invalid();
          const url = characterUrl(body.path), write = !READ.has(body.method);
          let data = body.body ?? null;
          // Convenient default for the standard character-service mutation body.
          // Other/nested payload shapes are passed through as supplied.
          if (write && data && typeof data === 'object' && !Array.isArray(data)) data = { characterId: Number(id), ...data };
          try {
            const response = await call(url, body.method, data);
            return result(200, { state: write ? acknowledgement(response) : 'read', response });
          } catch (e) { return result(write ? 200 : 502, { state: write ? 'unknown' : 'failed', reason: e.message }); }
        }
        const condition = /^\/conditions\/([1-9]|1[0-5])$/u.exec(route);
        if (condition && ['PUT', 'DELETE'].includes(method)) {
          const conditionId = Number(condition[1]), level = conditionId === 4 && method === 'PUT' ? body?.level : null;
          if (conditionId === 4 && method === 'PUT' && (!Number.isInteger(level) || level < 1 || level > 6)) invalid();
          return mutate(call, read, '/character/v5/condition', method, { characterId: Number(id), id: conditionId, level },
            c => { const found = c.conditions?.find(c => c.id === conditionId); return Array.isArray(c.conditions) && (method === 'DELETE' ? !found : !!found && (conditionId !== 4 || found.level === level)); });
        }
        return result(404, { error: 'route_not_found' });
      });
      if (followsSelection) response.body.characterId = id;
      return response;
    } catch (e) { return result(e.message === 'invalid_request' ? 400 : 502, { error: e.message }); }
  }
  return Object.freeze({ handle });
}

async function mutate(call, read, path, method, body, verify) {
  let dispatched = false;
  try {
    // A completed response means acknowledgement only; a fresh v5 read proves
    // the requested field. No automatic retry after any attempted mutation.
    dispatched = true;
    const response = await call(path, method, body);
    const state = acknowledgement(response);
    if (state !== 'acknowledged') return result(200, { state, response });
    const after = await read();
    const verified = verify(after, response);
    return result(200, { state: verified ? 'verified' : 'unknown', reason: verified ? null : 'readback_mismatch', response });
  } catch (e) { return result(dispatched ? 200 : 502, { state: dispatched ? 'unknown' : 'failed', reason: e.message }); }
}
