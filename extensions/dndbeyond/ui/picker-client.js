// One port per page. Worker owns selection and native connection lifetimes.
export function pickerClient(render, onClose) {
  const port = chrome.runtime.connect({ name: 'character-picker' }), pending = new Map();
  let sequence = 0, open = true;
  const request = (type, data = {}) => new Promise((resolve, reject) => {
    if (!open) { reject(Error('disconnected')); return; }
    const requestId = ++sequence;
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error('timeout')); }, 25000);
    pending.set(requestId, { resolve, reject, timer });
    port.postMessage({ type, requestId, ...data });
  });
  port.onMessage.addListener(message => {
    if (message.type === 'status') { render(message.data); return; }
    const p = pending.get(message.requestId); if (!p) return;
    pending.delete(message.requestId); clearTimeout(p.timer);
    if (message.ok) { render(message.data); p.resolve(message.data); } else p.reject(Error(message.error));
  });
  const close = () => {
    if (!open) return; open = false; clearInterval(timer);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('disconnected')); }
    pending.clear(); onClose();
  };
  port.onDisconnect.addListener(close);
  const timer = setInterval(() => { void request('status').catch(() => {}); }, 10000);
  window.addEventListener('pagehide', () => { close(); port.disconnect(); });
  return request;
}
export function connectionText(s) {
  if (s.phase === 'ready') return 'Connected · available to local apps';
  // The helper app (Windows or macOS) only serves the local HTTP API; choosing and sharing work without it.
  if (s.phase === 'connecting') return 'Connecting to the helper app…';
  if (s.phase === 'retry_wait') return 'Helper app not running · only local apps need it · retrying…';
  return 'Helper app not running · only local apps need it · see connection help';
}
export function errorText(code) {
  return ({ permission_required: 'D&D Beyond access is disabled in the browser’s extension settings.',
    reauth_required: 'Sign in to D&D Beyond in this browser, then refresh characters.',
    forbidden: 'D&D Beyond denied access. Check your sign-in, then refresh characters.',
    rate_limited: 'D&D Beyond is busy. Wait a minute, then refresh characters.',
    busy: 'Another request is running. Try again when it finishes.',
    scope_ended: 'The connection changed. Refresh characters and try again.',
    character_unavailable: 'This character is no longer available. Refresh the list.',
    schema: 'D&D Beyond returned an unexpected character list. Try again after checking your D&D Beyond account.',
    disconnected: 'The extension restarted. Close and reopen this panel.',
    timeout: 'The request timed out. Check your connection and try again.' })[code] ?? 'Could not connect. Check your internet connection and try again.';
}
