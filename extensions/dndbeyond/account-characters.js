// Public character-app contracts: helpers/userApi.ts, characterServiceApi.ts
// and types.ts. Only picker metadata crosses the worker/UI boundary.
const text = value => typeof value === 'string' ? value.slice(0, 256).trim() : '';
export function accountIdFromToken(token) {
  try {
    const part = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part), c => c.charCodeAt(0))));
    const id = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier'];
    if (typeof id === 'string' && /^[1-9][0-9]{0,15}$/.test(id)) return id;
  } catch { /* unsupported token shape */ }
  throw Error('schema');
}
export function accountCharacters(value) {
  if (value?.success !== true || !Array.isArray(value.data?.characters)) throw Error('schema');
  const characters = new Map();
  for (const c of value.data.characters) {
    if (!Number.isSafeInteger(c?.id) || c.id <= 0 || String(c.id).length > 16) throw Error('schema');
    if (c.status !== 1) continue; // Deleted and subscription-locked sheets cannot be selected.
    characters.set(String(c.id), { id: String(c.id), name: text(c.name) || 'Unnamed character',
      details: [Number.isInteger(c.level) && c.level > 0 ? `Level ${c.level}` : '', text(c.raceName), text(c.classDescription)].filter(Boolean).join(' · ') });
  }
  return [...characters.values()].sort((a, b) => a.name.localeCompare(b.name));
}
