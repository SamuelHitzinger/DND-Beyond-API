import { pickerClient, connectionText, errorText } from './picker-client.js';
const el = id => document.getElementById(id);
const request = pickerClient(s => {
  el('connection').textContent = connectionText(s); el('connection').dataset.ready = String(s.phase === 'ready');
  el('retry').hidden = ['ready', 'connecting'].includes(s.phase);
}, () => { el('error').textContent = errorText('disconnected'); });
el('retry').addEventListener('click', () => { void request('retry').catch(e => { el('error').textContent = errorText(e.message); }); });
void request('status').catch(e => { el('error').textContent = errorText(e.message); });
