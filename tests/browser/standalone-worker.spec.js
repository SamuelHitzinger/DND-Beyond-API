import { test, expect } from '@playwright/test';
import { createLocalApi } from '../../extensions/dndbeyond/local-api.js';
const event = () => { const listeners = []; return { addListener: f => listeners.push(f), emit: (...args) => Promise.all(listeners.map(f => f(...args))) }; };
async function fixture(saved = {}) {
  const s = { saved: { localApi: { enabled: false }, ...saved }, native: [], replies: [], calls: [], accountId: '42', failSave: false,
    characters: [{ id: '123', name: 'First', details: 'Wizard' }, { id: '456', name: 'Second', details: 'Fighter' }] };
  const api = { runtime: { id: 'fake', getURL: p => 'chrome-extension://fake/' + p, onStartup: event(), onInstalled: event(),
    connectNative() { const p = { onMessage: event(), onDisconnect: event(), postMessage: m => s.native.push(m), disconnect() {} }; s.host = p; return p; } },
    permissions: { contains: async () => true, onRemoved: event() },
    storage: { local: { get: async () => structuredClone(s.saved), set: async v => { if (s.failSave) throw Error('storage'); Object.assign(s.saved, structuredClone(v)); }, remove: async keys => { for (const key of [].concat(keys)) delete s.saved[key]; } } } };
  const reader = { clear() {}, listCharacters: async () => ({ accountId: s.accountId, characters: s.characters }), requestCharacter: async (id, url, options) => {
    await options.assertScope(); s.calls.push({ id, url, options }); return { status: 200, data: { success: true, data: { id: Number(id), name: 'Invented' } } };
  } };
  const local = createLocalApi(api, { reader }); await local.initialize();
  const port = { name: 'character-picker', sender: { id: 'fake', url: 'chrome-extension://fake/ui/picker.html' }, onMessage: event(), onDisconnect: event(), postMessage: m => s.replies.push(m) };
  local.acceptPort(port); let sequence = 0;
  const request = async (type, data = {}) => { const requestId = ++sequence; await port.onMessage.emit({ type, requestId, ...data }); return s.replies.find(m => m.requestId === requestId); };
  return { s, local, request, api };
}
test('standalone picker remembers one selection, migrates a single previous choice and clears obsolete access', async () => {
  const h = await fixture({ scriptCharacters: ['123'] });
  try {
    expect(await h.request('list_characters')).toMatchObject({ ok: true, data: { selectedCharacter: { id: '123', name: 'First' } } });
    expect(h.s.saved).not.toHaveProperty('scriptCharacters');
    expect(await h.request('select_character', { characterId: '456' })).toMatchObject({ ok: true, data: { selectedCharacter: { id: '456' }, characters: ['456'] } });
    expect(h.s.saved.selectedCharacter).toMatchObject({ id: '456', accountId: '42' });
    const restored = await fixture(h.s.saved); expect(restored.local.status().selectedCharacter.id).toBe('456'); restored.local.disable();
    h.s.failSave = true; expect(await h.request('select_character', { characterId: '123' })).toMatchObject({ ok: false }); expect(h.local.status().selectedCharacter.id).toBe('456');
    expect(await h.request('clear_selection')).toMatchObject({ ok: false, error: 'ui_message' });
    expect(await h.request('enabled', { enabled: false })).toMatchObject({ ok: false, error: 'ui_message' });
    expect(await h.request('script_grant', { characterId: '123' })).toMatchObject({ ok: false });
  } finally { h.local.disable(); }
});
test('simple native request chunks use saved selection and refuse the previously selected character', async () => {
  const h = await fixture();
  try {
    await h.s.host.onMessage.emit({ type: 'ready' });
    await h.request('list_characters'); await h.request('select_character', { characterId: '123' });
    const id = 'a'.repeat(32);
    await h.s.host.onMessage.emit({ type: 'request', id, request: { method: 'GET', path: '/v1/character', body: null } });
    let frames = h.s.native.filter(m => m.type === 'response' && m.id === id);
    expect(frames.at(-1).final).toBe(true);
    expect(JSON.parse(frames.map(m => Buffer.from(m.data, 'base64').toString()).join(''))).toMatchObject({ status: 200, body: { characterId: '123', character: { id: 123 } } });
    await h.request('select_character', { characterId: '456' });
    await h.s.host.onMessage.emit({ type: 'request', id: 'b'.repeat(32), request: { method: 'GET', path: '/v1/characters/123', body: null } });
    frames = h.s.native.filter(m => m.id === 'b'.repeat(32));
    expect(JSON.parse(Buffer.from(frames[0].data, 'base64').toString()).status).toBe(403);
    expect(h.s.calls).toHaveLength(1);
  } finally { h.local.disable(); }
});
test('account changes or removed characters clear selection; renames update it', async () => {
  const h = await fixture();
  try {
    await h.request('list_characters'); await h.request('select_character', { characterId: '123' });
    h.s.characters[0].name = 'Renamed'; await h.request('list_characters'); expect(h.local.status().selectedCharacter.name).toBe('Renamed');
    h.s.accountId = '43'; await h.request('list_characters'); expect(h.local.status().selectedCharacter).toBeNull();
    await h.request('select_character', { characterId: '123' }); h.s.characters = []; await h.request('list_characters'); expect(h.local.status().selectedCharacter).toBeNull();
  } finally { h.local.disable(); }
});

test('startup automatically connects and discards an old paused preference', async () => {
  const h = await fixture({ localApi: { enabled: false } });
  try {
    expect(h.s.host).toBeDefined();
    expect(h.local.status().phase).toBe('connecting');
    expect(h.s.saved).not.toHaveProperty('localApi');
  } finally { h.local.disable(); }
});
