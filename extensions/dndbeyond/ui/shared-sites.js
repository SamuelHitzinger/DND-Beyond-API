// Websites approved for character-share. Uses its own port, separate from the
// picker/native status port, and only ever lists origins, their scopes and sharing state.
const el = id => document.getElementById(id);
const port = chrome.runtime.connect({ name: 'character-share-sites' });
const SCOPES = [['sheet', 'Sheet'], ['rolls', 'Rolls'], ['write', 'Changes']];
let open = true;
function button(text, label, origin) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'secondary'; b.textContent = text; b.setAttribute('aria-label', label); b.disabled = !open;
  b.addEventListener('click', () => { if (!open) return; b.disabled = true; port.postMessage({ type: 'revoke', origin }); });
  return b;
}
function toggles(origin, scopes) {
  const box = document.createElement('div'); box.className = 'site-scopes';
  const inputs = SCOPES.map(([key, text]) => {
    const label = document.createElement('label'), input = document.createElement('input');
    input.type = 'checkbox'; input.checked = scopes?.[key] === true; input.disabled = !open; input.dataset.scope = key;
    input.setAttribute('aria-label', `${text === 'Changes' ? 'Allow changes' : 'Share ' + text.toLowerCase()} with ${origin}`);
    label.append(input, ' ' + text); box.append(label); return input;
  });
  for (const input of inputs) input.addEventListener('change', () => {
    if (!open) return;
    const chosen = Object.fromEntries(inputs.map(i => [i.dataset.scope, i.checked]));
    for (const i of inputs) i.disabled = true; // Re-enabled by the worker's updated list.
    port.postMessage({ type: 'scopes', origin, scopes: chosen });
  });
  return box;
}
function render(sites) {
  el('shared-sites').replaceChildren(...sites.map(({ origin, state, scopes }) => {
    const item = document.createElement('li'), row = document.createElement('div'), name = document.createElement('span'), side = document.createElement('span');
    row.className = 'site-row'; name.textContent = origin; name.className = 'site'; side.className = 'site-state';
    if (state === 'shared') side.append(button('Stop sharing', `Stop sharing with ${origin}`, origin));
    else if (state === 'stopping') side.textContent = 'Stopping…';
    else { const note = document.createElement('span'); note.textContent = 'Stopped — not saved'; side.append(note, button('Retry', `Retry stopping sharing with ${origin}`, origin)); }
    row.append(name, side); item.dataset.state = state; item.append(row);
    if (state === 'shared') item.append(toggles(origin, scopes));
    return item;
  }));
  // Keep the section (and its error) visible while any stop is still unsaved.
  el('sharing').hidden = !sites.length;
  el('sharing-error').textContent = sites.some(s => s.state === 'unsaved') ?
    'Sharing has stopped, but the change could not be saved yet. The extension keeps retrying; choose Retry to try now.' : '';
}
port.onMessage.addListener(m => {
  if (m?.type !== 'sites' || !Array.isArray(m.sites)) return;
  render(m.sites.filter(s => typeof s?.origin === 'string' && ['shared', 'stopping', 'unsaved'].includes(s.state)));
});
port.onDisconnect.addListener(() => { open = false; for (const b of el('shared-sites').querySelectorAll('button, input')) b.disabled = true; });
window.addEventListener('pagehide', () => { open = false; port.disconnect(); });
