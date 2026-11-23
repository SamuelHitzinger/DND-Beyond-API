import { pickerClient, connectionText, errorText } from './picker-client.js';
const el = id => document.getElementById(id);
let status = null, busy = false;
function render(s) {
  status = s;
  el('connection').textContent = connectionText(s); el('connection').dataset.ready = String(s.phase === 'ready');
  el('refresh').disabled = busy || s.account.phase === 'loading';
  el('setup').hidden = s.account.error !== 'permission_required' && ['connecting', 'ready'].includes(s.phase);
  const characters = s.account.characters;
  el('characters').replaceChildren();
  const placeholder = new Option(s.account.phase === 'loading' ? 'Loading characters…' : 'Choose a character', '');
  el('characters').append(placeholder);
  for (const c of characters) el('characters').append(new Option(c.name + (c.details ? ` — ${c.details}` : ''), c.id));
  if (s.selectedCharacter && !characters.some(c => c.id === s.selectedCharacter.id)) {
    el('characters').append(new Option(s.selectedCharacter.name, s.selectedCharacter.id));
  }
  el('characters').value = s.selectedCharacter?.id ?? '';
  // Choosing a character uses the browser's own D&D Beyond session; the Windows helper is
  // only needed by local applications, so its status is informational here.
  el('characters').disabled = busy || s.account.phase !== 'ready' || !characters.length;
  el('list-help').textContent = s.account.phase === 'ready' && !characters.length ? 'No active characters in this account. Create or unlock one on D&D Beyond, then refresh.' :
    'Choose from your signed-in D&D Beyond account.';
  if (s.account.error) el('error').textContent = errorText(s.account.error);
}
const request = pickerClient(render, () => { el('error').textContent = errorText('disconnected'); });
async function run(type, data = {}) {
  if (busy) return;
  busy = true; el('error').textContent = ''; if (status) render(status);
  try { await request(type, data); }
  catch (e) { el('error').textContent = errorText(e.message); }
  finally { busy = false; if (status) render(status); }
}
el('characters').addEventListener('change', () => { if (el('characters').value) void run('select_character', { characterId: el('characters').value }); });
el('refresh').addEventListener('click', () => { void run('list_characters'); });
void request('status').then(() => run('list_characters')).catch(e => { el('error').textContent = errorText(e.message); });
