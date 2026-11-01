import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createScriptApi } from '../../extensions/dndbeyond/script-api.js';

test('published contract resolves references and includes the real selected and explicit API route families', async () => {
  const document = JSON.parse(await readFile('docs/character-http-api.openapi.json', 'utf8'));
  const ids = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      expect(value.$ref).toMatch(/^#\//);
      let target = document; for (const key of value.$ref.slice(2).split('/')) target = target?.[key];
      expect(target, value.$ref).toBeDefined();
    }
    for (const item of Object.values(value)) visit(item);
  }
  visit(document);
  const api = createScriptApi({ request: async () => ({ status: 200, data: { success: true, data: { id: 123, inspiration: true } } }) });
  for (const suffix of ['', '/summary', '/inventory', '/currency', '/spell-slots', '/conditions', '/notes', '/rolls', '/custom-items', '/custom-actions', '/limited-use', '/prepared-spells']) {
    expect(document.paths['/v1/character' + suffix].get).toBeDefined();
    expect(document.paths['/v1/characters/{characterId}' + suffix].get).toBeDefined();
  }
  for (const [path, operations] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(operations)) {
    if (operation.operationId) { expect(ids.has(operation.operationId)).toBe(false); ids.add(operation.operationId); }
    if (!path.startsWith('/v1/character')) continue;
    const denied = await api.handle({ method: method.toUpperCase(), path: path.replace('{characterId}', '123').replace(/\{[^}]+\}/g, '1'), body: {} }, () => false, [], { id: '123', name: 'Invented' });
    if (path !== '/v1/characters') expect(denied.status).toBe(403);
  }
  expect(document.paths['/v1/character/recorder']).toBeUndefined();
  expect(await api.handle({ method: 'GET', path: '/v1/character/inspiration' }, () => true, ['123'], { id: '123', name: 'Invented' })).toMatchObject({ body: { inspiration: true, characterId: '123' } });
});
