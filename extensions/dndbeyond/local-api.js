// The browser owns login, remembered selection and native-host lifetime.
import { NATIVE_HOST } from './identity.js';
import { HTTP_ORIGINS, isHttpCharacterId } from './http-read.js';
import { createScriptApi } from './script-api.js';
const fail = code => { throw Error(code); };
const safeError = e => ['busy', 'permission_required', 'reauth_required', 'forbidden', 'scope_ended', 'timeout', 'schema', 'network', 'rate_limited', 'character_unavailable', 'ui_message'].includes(e?.message) ? e.message : 'request_failed';
export function createLocalApi(api, { reader, timers = globalThis } = {}) {
  let enabled = false, phase = 'disabled', error = null, native = null, epoch = 0, revision = 0;
  let heartbeat = null, retry = null, lastInput = 0, initializing = null, selecting = false;
  let selectedCharacter = null, legacyChoice = null, accountId = null;
  let account = { phase: 'idle', error: null, characters: [] };
  const ports = new Set();
  const selection = () => selectedCharacter ? { id: selectedCharacter.id, name: selectedCharacter.name } : null;
  const status = () => ({ enabled, phase, error, selectedCharacter: selection(), characters: selectedCharacter ? [selectedCharacter.id] : [], account: structuredClone(account) });
  function publish() { for (const port of ports) { try { port.postMessage({ type: 'status', data: status() }); } catch { /* page closed */ } } }
  async function permission() { if (!await api.permissions.contains({ origins: [...HTTP_ORIGINS] })) fail('permission_required'); }
  const scripts = createScriptApi({ request: (id, path, options) => reader.requestCharacter(id, path, { ...options, assertScope: async () => { await permission(); await options.assertScope(); } }) });
  async function saveSelection(value) {
    if (selecting) fail('busy'); selecting = true;
    try {
      await api.storage.local.set({ selectedCharacter: value });
      if (selectedCharacter?.id !== value?.id || selectedCharacter?.accountId !== value?.accountId) revision++;
      selectedCharacter = value; legacyChoice = null;
      await api.storage.local.remove(['scriptCharacters', 'validationEvidence']); publish();
    } finally { selecting = false; }
  }
  async function listCharacters() {
    await initialize();
    if (account.phase === 'loading') fail('busy');
    const captured = epoch;
    const assertScope = async () => { if (captured !== epoch) fail('scope_ended'); await permission(); };
    account = { phase: 'loading', error: null, characters: [] }; publish();
    try {
      const result = await reader.listCharacters({ assertScope }); await assertScope();
      if (selectedCharacter) {
        const chosen = result.characters.find(c => c.id === selectedCharacter.id);
        if (selectedCharacter.accountId !== result.accountId || !chosen) await saveSelection(null);
        else if (chosen.name !== selectedCharacter.name) await saveSelection({ ...selectedCharacter, name: chosen.name });
      } else if (legacyChoice) {
        const chosen = result.characters.find(c => c.id === legacyChoice);
        if (chosen) await saveSelection({ id: chosen.id, name: chosen.name, accountId: result.accountId });
      }
      accountId = result.accountId; account = { phase: 'ready', error: null, characters: result.characters }; publish();
    } catch (e) { account = { phase: 'error', error: safeError(e), characters: [] }; publish(); throw e; }
  }
  function disable() {
    enabled = false; epoch++; reader.clear();
    timers.clearTimeout(retry); retry = null; timers.clearInterval(heartbeat); heartbeat = null;
    const previous = native; native = null; try { previous?.disconnect(); } catch { /* closed */ }
    phase = 'disabled'; publish();
  }
  function lost() {
    const reconnect = enabled; disable(); enabled = reconnect;
    if (reconnect) { phase = 'retry_wait'; error = 'native_unavailable'; retry = timers.setTimeout(connect, 5000); retry?.unref?.(); publish(); }
  }
  async function receive(message, port, captured) {
    if (native !== port || captured !== epoch) return;
    lastInput = performance.now();
    if (message?.type === 'ready') { phase = 'ready'; error = null; publish(); return; }
    if (message?.type === 'pong') return;
    if (phase !== 'ready' || message?.type !== 'request' || !/^[0-9a-f]{32}$/u.test(message.id)) return lost();
    const input = message.request, selectedRevision = revision;
    const allowed = id => enabled && captured === epoch && revision === selectedRevision && selectedCharacter?.id === id;
    let response;
    if (input?.method === 'GET' && input.path === '/v1/account/characters') {
      try { await listCharacters(); response = { status: 200, body: { characters: account.characters } }; }
      catch (e) { response = { status: 502, body: { error: safeError(e) } }; }
    } else response = await scripts.handle(input, allowed, selectedCharacter ? [selectedCharacter.id] : [], selection());
    if (native !== port || captured !== epoch) return;
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    for (let offset = 0, index = 0; offset < bytes.length; offset += 24000, index++) {
      if (native !== port || captured !== epoch) return;
      const data = btoa(String.fromCharCode(...bytes.subarray(offset, offset + 24000)));
      port.postMessage({ type: 'response', id: message.id, index, final: offset + 24000 >= bytes.length, data });
      await new Promise(resolve => timers.setTimeout(resolve, 0));
    }
    if (input?.method === 'POST' && input.path === '/dev/reload-extension' && response.status === 202) {
      const delay = input.body?.delayMs ?? 300;
      if (delay > 300) timers.setTimeout(disable, 300); // Native pause only during source upgrades.
      timers.setTimeout(() => api.runtime.reload(), Math.max(300, delay));
    }
  }
  function connect() {
    retry = null; if (!enabled || native) return;
    phase = 'connecting'; const captured = ++epoch;
    try {
      const port = api.runtime.connectNative(NATIVE_HOST); native = port; lastInput = performance.now();
      port.onMessage.addListener(message => receive(message, port, captured).catch(() => { if (native === port) lost(); }));
      port.onDisconnect.addListener(() => { void api.runtime.lastError; if (native === port) lost(); });
      heartbeat = timers.setInterval(() => {
        if (native !== port) return;
        if (performance.now() - lastInput > 10000) return lost();
        try { port.postMessage({ type: 'ping' }); } catch { lost(); }
      }, 2000); heartbeat?.unref?.();
    } catch { lost(); }
    publish();
  }
  function initialize() {
    return initializing ??= (async () => {
      try {
        await api.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
        const saved = await api.storage.local.get(['selectedCharacter', 'scriptCharacters']);
        const selected = saved.selectedCharacter;
        if (isHttpCharacterId(selected?.id) && typeof selected.name === 'string' && selected.name.length <= 256 && /^[1-9][0-9]{0,15}$/u.test(selected.accountId)) selectedCharacter = { id: selected.id, name: selected.name, accountId: selected.accountId };
        else if (saved.scriptCharacters?.length === 1 && isHttpCharacterId(saved.scriptCharacters[0])) legacyChoice = saved.scriptCharacters[0];
        await api.storage.local.remove('localApi');
        enabled = true; connect();
      } catch { phase = 'disabled'; error = 'storage_unavailable'; }
      publish();
    })();
  }
  function acceptPort(port) {
    const sender = port.sender;
    if (port.name !== 'character-picker' || sender?.id !== api.runtime.id || !['ui/picker.html', 'ui/setup.html'].some(p => sender.url === api.runtime.getURL(p)) ||
        sender.frameId !== undefined && sender.frameId !== 0 || sender.origin !== undefined && sender.origin !== `chrome-extension://${api.runtime.id}`) fail('ui_sender');
    ports.add(port); let work = false;
    port.onDisconnect.addListener(() => ports.delete(port));
    port.onMessage.addListener(async m => {
      if (!ports.has(port)) return;
      const fields = { status: [], retry: [], list_characters: [], select_character: ['characterId'] };
      try {
        if (!m || !Object.hasOwn(fields, m.type) || !Number.isSafeInteger(m.requestId) || m.requestId <= 0 || Object.keys(m).length !== fields[m.type].length + 2 || !fields[m.type].every(k => Object.hasOwn(m, k))) fail('ui_message');
        if (work && m.type !== 'status') fail('busy');
        const mutating = m.type !== 'status'; if (mutating) work = true;
        try {
          await initialize();
          if (m.type === 'retry') { enabled = true; timers.clearTimeout(retry); connect(); }
          else if (m.type === 'list_characters') await listCharacters();
          else if (m.type === 'select_character') {
            const selected = account.phase === 'ready' && account.characters.find(c => c.id === m.characterId);
            if (!selected || !accountId) fail('character_unavailable');
            await saveSelection({ id: selected.id, name: selected.name, accountId });
          }
          if (ports.has(port)) port.postMessage({ requestId: m.requestId, ok: true, data: status() });
        } finally { if (mutating) work = false; }
      } catch (e) { if (ports.has(port)) port.postMessage({ requestId: m?.requestId, ok: false, error: safeError(e) }); }
    });
    port.postMessage({ type: 'status', data: status() });
  }
  api.permissions.onRemoved?.addListener(change => { if (change.origins?.length) { reader.clear(); account = { phase: 'error', error: 'permission_required', characters: [] }; publish(); } });
  api.runtime.onStartup?.addListener(initialize); api.runtime.onInstalled?.addListener(initialize);
  return Object.freeze({ initialize, status, acceptPort, disable });
}
