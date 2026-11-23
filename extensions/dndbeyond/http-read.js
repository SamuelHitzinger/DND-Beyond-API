// Browser-owned authentication and host-restricted JSON requests. No login
// credential is persisted or returned. Reads/writes are never automatically retried.
import { characterUrl } from './script-api.js';
import { accountIdFromToken, accountCharacters } from './account-characters.js';
export const HTTP_ORIGINS = Object.freeze([
  'https://auth-service.dndbeyond.com/*', 'https://character-service.dndbeyond.com/*',
  'https://character-service-scds.dndbeyond.com/*',
]);
export const isHttpCharacterId = v => typeof v === 'string' && /^[1-9][0-9]{0,15}$/u.test(v) && Number.isSafeInteger(Number(v));
const known = new Set(['schema', 'network', 'timeout', 'rate_limited', 'reauth_required', 'forbidden', 'permission_required', 'scope_ended', 'revoked', 'invalid_request', 'too_large']);
export function createHttpReader({ fetch = globalThis.fetch, monotonic = () => performance.now() } = {}) {
  let token = null, expires = 0, refreshing = null, generation = new AbortController();
  function clear() { generation.abort(); generation = new AbortController(); token = null; expires = 0; refreshing = null; }
  async function json(url, options, assertScope) {
    const scope = generation, timeout = AbortSignal.timeout(15000);
    await assertScope(); scope.signal.throwIfAborted();
    try {
      const response = await fetch(url, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.any([scope.signal, timeout]) });
      const text = await response.text();
      if (text.length > 6291456) throw Error('too_large');
      let data; try { data = text ? JSON.parse(text) : null; } catch { throw Error('schema'); }
      return { status: response.status, data };
    } catch (e) {
      if (scope.signal.aborted) throw Error('scope_ended');
      if (timeout.aborted) throw Error('timeout');
      throw Error(known.has(e.message) ? e.message : 'network');
    }
  }
  async function getToken(assertScope, fresh = false) {
    await assertScope();
    if (!fresh && token && monotonic() < expires - 30000) return token;
    if (!refreshing) {
      // One shared exchange per generation. It is not bound to the first caller's
      // scope: every caller re-checks its own scope after it resolves, so one caller's
      // ended scope never fails another caller's request.
      const scope = generation;
      refreshing = (async () => {
        const response = await json('https://auth-service.dndbeyond.com/v1/cobalt-token', {
          method: 'POST', credentials: 'include', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}',
        }, async () => {});
        if ([401, 403].includes(response.status)) throw Error('reauth_required');
        if (response.status === 429) throw Error('rate_limited');
        if (response.status !== 200) throw Error('network');
        const value = response.data;
        if (!Number.isInteger(value?.ttl) || value.ttl < 1 || value.ttl > 300 || typeof value.token !== 'string' ||
            value.token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value.token)) throw Error('schema');
        if (generation !== scope) throw Error('scope_ended');
        token = value.token; expires = monotonic() + value.ttl * 1000; return token;
      })();
    }
    const pending = refreshing;
    let value;
    try { value = await pending; } finally { if (refreshing === pending) refreshing = null; }
    await assertScope();
    return value;
  }
  // account (optional): the request is sent only with a token of this D&D Beyond
  // account, checked on the token actually used (a refresh may switch accounts).
  async function requestCharacter(characterId, path, { method = 'GET', body = null, assertScope = async () => {}, account = undefined } = {}) {
    if (!isHttpCharacterId(characterId)) throw Error('invalid_request');
    const url = characterUrl(path), bearer = await getToken(assertScope);
    if (account !== undefined && accountIdFromToken(bearer) !== account) throw Error('account_mismatch');
    const response = await json(url, { method, credentials: 'omit',
      headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}`, ...(body !== null ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== null && !['GET', 'HEAD'].includes(method) ? { body: JSON.stringify(body) } : {}),
    }, assertScope);
    if ([401, 403].includes(response.status)) { token = null; expires = 0; }
    return response;
  }
  async function listCharacters({ assertScope = async () => {} } = {}) {
    const bearer = await getToken(assertScope, true), accountId = accountIdFromToken(bearer);
    const response = await json(`https://character-service.dndbeyond.com/character/v5/characters/list?userId=${accountId}`, {
      method: 'GET', credentials: 'omit', headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
    }, assertScope);
    if ([401, 403].includes(response.status)) { token = null; expires = 0; throw Error(response.status === 401 ? 'reauth_required' : 'forbidden'); }
    if (response.status === 429) throw Error('rate_limited');
    if (response.status !== 200) throw Error('network');
    await assertScope(); return { accountId, characters: accountCharacters(response.data) };
  }
  // The game-log relay (web-share.js) authenticates its socket with a cobalt token.
  const tokenFor = ({ assertScope = async () => {}, fresh = false } = {}) => getToken(assertScope, fresh);
  return Object.freeze({ clear, requestCharacter, listCharacters, token: tokenFor });
}
