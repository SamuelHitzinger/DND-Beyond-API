// Approval window for one website origin. The worker supplies the origin it
// validated and, for an upgrade, the scopes the site already has; the page only
// reports the chosen scopes with Share or Don't share and is then closed.
const el = id => document.getElementById(id);
const SCOPES = ['sheet', 'rolls', 'write'], NAMES = { sheet: 'character sheet', rolls: 'dice rolls', write: 'changes' };
const port = chrome.runtime.connect({ name: 'character-share-approval' });
let decided = false, initialized = false;
const controls = enabled => { el('share').disabled = el('deny').disabled = !enabled; for (const k of SCOPES) el('scope-' + k).disabled = !enabled; };
port.onMessage.addListener(m => {
  if (m?.type !== 'approval' || typeof m.origin !== 'string') return;
  el('origin').textContent = m.origin;
  el('character').textContent = typeof m.character === 'string' ? m.character : 'No character selected yet. The site will see the one you choose later.';
  const current = Object.fromEntries(SCOPES.map(k => [k, m.current?.[k] === true]));
  // Rendered in full on every message: the worker re-describes the window when the
  // site's sharing changes (popup toggles), in either direction.
  const upgrade = m.upgrade === true, has = SCOPES.filter(k => current[k]).map(k => NAMES[k]);
  el('title').textContent = upgrade ? 'Share more with this site?' : 'Share your character?';
  el('intro').textContent = upgrade ? 'This website already sees your selected character and asks for more:' : 'This website asks to use your selected character:';
  el('current').textContent = upgrade ? 'Currently shared: who you are playing' + (has.length ? ', ' + has.join(', ') : '') + '.' : '';
  el('current').hidden = !upgrade;
  el('share').textContent = upgrade ? 'Update sharing' : 'Share'; el('deny').textContent = upgrade ? 'Keep current' : "Don't share";
  for (const k of SCOPES) document.querySelector(`[data-new="${k}"]`).hidden = !upgrade || current[k];
  // Every choice starts checked (the defaults) and can be unchecked before sharing.
  if (!initialized) { initialized = true; for (const k of SCOPES) el('scope-' + k).checked = true; }
  controls(!decided);
});
port.onDisconnect.addListener(() => {
  controls(false);
  if (!decided) el('error').textContent = 'This request is no longer active. Close this window and ask again from the website.';
});
function decide(share) {
  if (decided) return; decided = true; controls(false);
  port.postMessage({ type: 'decide', share, scopes: Object.fromEntries(SCOPES.map(k => [k, share && el('scope-' + k).checked])) });
}
el('share').addEventListener('click', () => decide(true));
el('deny').addEventListener('click', () => decide(false));
