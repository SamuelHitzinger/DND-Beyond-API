import { test, expect } from '@playwright/test';
import { fixture, origin } from './picker-ui-helpers.js';
const ID = 'abeakpcagojpphodembeeajfjgmcadnc', SITE = 'http://localhost:4173', FRAME = 'http://127.0.0.1:4174';
// The approval window closes as soon as the worker has the decision; Playwright's
// post-click wait can race that close, which is not a failure of the click itself.
const decide = async (page, name) => { await page.getByRole('button', { name, exact: true }).click().catch(e => { if (!page.isClosed()) throw e; }); };
const connect = id => {
  window.messages = []; window.ended = false;
  window.port = chrome.runtime.connect(id, { name: 'character-share' });
  port.onMessage.addListener(m => messages.push(m)); port.onDisconnect.addListener(() => { window.ended = true; });
};

test('a real web page connects, asks once, sees only the shared identity and is cut off by Stop sharing', async ({}, info) => {
  const s = await fixture(info, {});
  try {
    await expect.poll(() => s.worker.evaluate(() => nativePorts.length)).toBe(1);
    await s.send({ type: 'ready' });
    const picker = await s.context.newPage(); await picker.goto(origin + 'ui/picker.html');
    await expect(picker.locator('#connection')).toContainText('Connected');
    await picker.getByLabel('Character', { exact: true }).selectOption('123');
    await expect.poll(() => s.worker.evaluate(async () => (await chrome.storage.local.get('selectedCharacter')).selectedCharacter?.details ?? null)).toBe('Level 4 · Elf · Wizard 4');
    await expect(picker.locator('#sharing')).toBeHidden();

    const table = await s.context.newPage();
    await table.route(/^http:\/\/(localhost:4173|127\.0\.0\.1:4174)\//u, route => route.fulfill({ contentType: 'text/html',
      body: route.request().url().startsWith(SITE) ? `<!doctype html><title>Table</title><iframe src="${FRAME}/frame"></iframe>` : '<!doctype html><title>Frame</title>' }));
    await table.goto(SITE + '/table');
    await table.evaluate(connect, ID);
    await expect.poll(() => table.evaluate(() => messages.length)).toBe(1);
    const NO = { sheet: false, rolls: false, write: false };
    expect(await table.evaluate(() => messages[0])).toEqual({ type: 'state', version: 2, approved: false, scopes: { identity: false, ...NO }, selected: null, helper: 'ready', revision: 1, relay: { state: 'off' } });

    // Allowed-pattern iframes and other port names are refused by the worker.
    const frame = table.frames().find(f => f.url().startsWith(FRAME));
    await frame.evaluate(connect, ID);
    await expect.poll(() => frame.evaluate(() => ended)).toBe(true);
    expect(await frame.evaluate(() => messages)).toEqual([]);
    await table.evaluate(id => { window.badClosed = false; chrome.runtime.connect(id, { name: 'character-picker' }).onDisconnect.addListener(() => { window.badClosed = true; }); }, ID);
    await expect.poll(() => table.evaluate(() => badClosed)).toBe(true);

    const opened = s.context.waitForEvent('page', p => p.url().startsWith(origin + 'ui/share.html'));
    await table.evaluate(() => { port.postMessage({ type: 'request_access' }); port.postMessage({ type: 'request_access' }); });
    const approval = await opened;
    await expect(approval.locator('#origin')).toHaveText(SITE);
    await expect(approval.locator('#character')).toHaveText('<b>Invented Hero</b>');
    await approval.screenshot({ path: info.outputPath('share-approval.png') });
    expect(s.context.pages().filter(p => p.url().startsWith(origin + 'ui/share.html'))).toHaveLength(1);
    // Identity only: every optional scope is unticked before sharing.
    for (const box of [/Read the character sheet/, /See your dice rolls/, /Change this character/]) await approval.getByRole('checkbox', { name: box }).uncheck();
    await decide(approval, 'Share');
    await expect.poll(() => table.evaluate(() => messages.at(-1))).toEqual({ type: 'state', version: 2, approved: true, scopes: { identity: true, ...NO },
      selected: { id: '123', name: '<b>Invented Hero</b>', details: 'Level 4 · Elf · Wizard 4' }, helper: 'ready', revision: 2, relay: { state: 'off' } });
    await expect.poll(() => approval.isClosed()).toBe(true);

    await picker.getByLabel('Character', { exact: true }).selectOption('456');
    await expect.poll(() => table.evaluate(() => messages.at(-1).selected?.id)).toBe('456');
    expect(await table.evaluate(() => messages.at(-1).revision)).toBe(3);
    await expect(picker.locator('#sharing')).toBeVisible();
    await expect(picker.locator('#shared-sites li')).toHaveCount(1);
    await expect(picker.locator('#shared-sites li')).toContainText(`${SITE}Stop sharing`);
    await expect(picker.getByRole('checkbox', { name: `Share sheet with ${SITE}` })).not.toBeChecked();
    await picker.screenshot({ path: info.outputPath('picker-shared.png') });
    // A stop that cannot be saved cuts the page off at once but stays listed with Retry.
    await s.worker.evaluate(() => { globalThis.realSet = chrome.storage.local.set; chrome.storage.local.set = async () => { throw Error('disk full'); }; });
    await picker.getByRole('button', { name: `Stop sharing with ${SITE}` }).click();
    await expect.poll(() => table.evaluate(() => ended)).toBe(true);
    expect(await table.evaluate(() => messages.at(-1))).toMatchObject({ approved: false, selected: null });
    await expect(picker.locator('#shared-sites li')).toHaveText([`${SITE}Stopped — not savedRetry`]);
    await expect(picker.locator('#sharing-error')).toContainText('could not be saved');
    expect(await s.worker.evaluate(async () => (await chrome.storage.session.get('pendingRevocations')).pendingRevocations)).toEqual([SITE]);
    await picker.screenshot({ path: info.outputPath('picker-unsaved.png') });
    await s.worker.evaluate(() => { chrome.storage.local.set = globalThis.realSet; });
    await picker.getByRole('button', { name: `Retry stopping sharing with ${SITE}` }).click();
    await expect(picker.locator('#sharing')).toBeHidden();
    const all = JSON.stringify(await table.evaluate(() => messages));
    for (const secret of ['accountId', '"42"', 'characters', 'account', 'phase']) expect(all).not.toContain(secret);
    expect(await s.worker.evaluate(async () => (await chrome.storage.local.get('sharedOrigins')).sharedOrigins)).toEqual([]);
    expect(await s.worker.evaluate(async () => (await chrome.storage.session.get('pendingRevocations')).pendingRevocations)).toEqual([]);

    // Don't share: the waiting page is told, and a fresh port gets a cooldown hint instead of a window.
    await table.evaluate(connect, ID);
    await expect.poll(() => table.evaluate(() => messages.length)).toBe(1);
    const prompt = s.context.waitForEvent('page', p => p.url().startsWith(origin + 'ui/share.html'));
    await table.evaluate(() => port.postMessage({ type: 'request_access' }));
    await decide(await prompt, "Don't share");
    await expect.poll(() => table.evaluate(() => messages.length)).toBe(2);
    await table.evaluate(connect, ID);
    await expect.poll(() => table.evaluate(() => messages.length)).toBe(1);
    await table.evaluate(() => port.postMessage({ type: 'request_access' }));
    await expect.poll(() => table.evaluate(() => messages.at(-1).retry_after_ms ?? 0)).toBeGreaterThan(10000);
    expect(s.context.pages().filter(p => p.url().startsWith(origin + 'ui/share.html'))).toHaveLength(0);
  } finally { await s.context.close(); }
});

// character-share v2 end to end in the real worker: consent with scopes, sheet and
// portrait without the Windows helper, a verified write, the roll relay and popup toggles.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const V2_BOUNDARY = `
  globalThis.sockets=[]; globalThis.avatarCalls=[]; globalThis.sheetState={removed:7,temp:4};
  globalThis.WebSocket=class{constructor(url){this.url=url;this.sent=[];this.closed=false;sockets.push(this);}send(d){this.sent.push(d);}close(){this.closed=true;}};
  const baseFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{
    const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
    if(url==='https://character-service.dndbeyond.com/character/v5/character/123'){httpCalls.push({url,method:options.method});
      return json({success:true,data:{id:123,name:'Invented Hero',removedHitPoints:sheetState.removed,temporaryHitPoints:sheetState.temp,inspiration:false,campaign:{id:555},
        decorations:{avatarUrl:'https://www.dndbeyond.com/avatars/1/2/hero.png'},race:{fullName:'Elf'},classes:[{id:1,level:4,definition:{name:'Wizard'}}],conditions:[],deathSaves:{failCount:0,successCount:0}}});}
    if(url==='https://character-service-scds.dndbeyond.com/v2/characters'&&options.method==='POST'){httpCalls.push({url,method:'POST'});
      return json({foundCharacters:[{characterId:123,level:4,armorClass:12,initiativeBonus:2,proficiencyBonus:2,hitPointInfo:{current:30-sheetState.removed,maximum:30,temp:sheetState.temp},
        speeds:[{name:'Walking',distance:30}],passivePerception:11,passiveInvestigation:13,passiveInsight:11,abilities:[{name:'int',score:16,modifier:3,save:5}]}]});}
    if(url==='https://character-service.dndbeyond.com/character/v5/life/hp/damage-taken'&&options.method==='PUT'){const b=JSON.parse(options.body);httpCalls.push({url,method:'PUT',body:b});
      sheetState.removed=b.removedHitPoints;sheetState.temp=b.temporaryHitPoints;return json({success:true});}
    if(url==='https://www.dndbeyond.com/avatars/1/2/hero.png'){avatarCalls.push({credentials:options.credentials});
      return new Response(Uint8Array.from(atob('${PNG}'),c=>c.charCodeAt(0)),{headers:{'content-type':'image/png'}});}
    return baseFetch(url,options);
  };
`;
test('v2: scoped consent delivers sheet, portrait, rolls and a verified write without the Windows helper', async ({}, info) => {
  const s = await fixture(info, { boundary: V2_BOUNDARY });
  try {
    await expect.poll(() => s.worker.evaluate(() => nativePorts.length)).toBe(1);
    await s.send({ type: 'ready' });
    const picker = await s.context.newPage(); await picker.goto(origin + 'ui/picker.html');
    await picker.getByLabel('Character', { exact: true }).selectOption('123');
    await expect.poll(() => s.worker.evaluate(async () => (await chrome.storage.local.get('selectedCharacter')).selectedCharacter?.id ?? null)).toBe('123');
    // The helper app goes away (as on a machine without it); the picker's reader is cleared.
    await s.worker.evaluate(() => nativePorts.at(-1).disconnect());
    await expect(picker.locator('#connection')).toContainText('Helper app not running');

    const table = await s.context.newPage();
    await table.route(/^http:\/\/localhost:4173\//u, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Table</title>' }));
    await table.goto(SITE + '/table');
    await table.evaluate(connect, ID);
    await expect.poll(() => table.evaluate(() => messages.length)).toBe(1);
    const opened = s.context.waitForEvent('page', p => p.url().startsWith(origin + 'ui/share.html'));
    await table.evaluate(() => port.postMessage({ type: 'request_access' }));
    const approval = await opened;
    for (const box of [/Read the character sheet/, /See your dice rolls/, /Change this character/]) await expect(approval.getByRole('checkbox', { name: box })).toBeChecked();
    await expect(approval.locator('.scope.write')).toContainText('saved to your real D&D Beyond character sheet');
    await approval.screenshot({ path: info.outputPath('share-approval-v2.png') });
    await decide(approval, 'Share');

    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'sheet').length)).toBe(1);
    const sheet = await table.evaluate(() => messages.find(m => m.type === 'sheet'));
    expect(sheet).toMatchObject({ character_id: '123', revision: 2, sheet: { summary: 'Level 4 · Elf · Wizard 4', ac: 12, speed: '30 ft.', hp: { current: 23, max: 30, temp: 4 },
      passives: { perception: 11, investigation: 13, insight: 11 } } });
    expect(sheet.portrait).toMatch(/^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/=]+$/u); expect(sheet.portrait.length).toBeLessThan(90 * 1024);
    expect(await s.worker.evaluate(() => avatarCalls)).toEqual([{ credentials: 'omit' }]);
    const state = await table.evaluate(() => messages.filter(m => m.type === 'state').at(-1));
    expect(state).toMatchObject({ version: 2, approved: true, scopes: { identity: true, sheet: true, rolls: true, write: true }, helper: 'unavailable' });

    // Roll relay: the worker's game-log socket (mocked) for campaign 555 as user 42.
    await expect.poll(() => s.worker.evaluate(() => sockets.length)).toBe(1);
    expect(await s.worker.evaluate(() => sockets[0].url)).toMatch(/^wss:\/\/game-log-api-live\.dndbeyond\.com\/v1\?gameId=555&userId=42&stt=e30\./u);
    await s.worker.evaluate(() => sockets[0].onopen());
    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'state').at(-1).relay)).toEqual({ state: 'listening' });
    await s.worker.evaluate(() => {
      const roll = (rollId, scope, target) => JSON.stringify({ eventType: 'dice/roll/fulfilled', entityType: 'character', entityId: '123', messageScope: scope, messageTarget: target, dateTime: '1800000000000',
        data: { rollId, action: 'Fire Bolt', rolls: [{ diceNotation: { set: [{ count: 1, dieType: 'd20', dice: [{ dieType: 'd20', dieValue: 11 }], operation: 0 }], constant: 5 }, rollType: 'to hit', rollKind: '', result: { total: 16 } }] } });
      sockets[0].onmessage({ data: roll('self-1', 'userId', '42') }); sockets[0].onmessage({ data: roll('pub-1', 'gameId', '555') }); sockets[0].onmessage({ data: roll('pub-1', 'gameId', '555') });
    });
    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'roll').map(m => m.roll.roll_id))).toEqual(['pub-1']);
    expect(await table.evaluate(() => messages.find(m => m.type === 'roll').roll)).toMatchObject({ label: 'Fire Bolt', to: 'everyone', rolls: [{ type: 'to hit', notation: '1d20+5', total: 16 }] });

    // A verified write through the extension's own reader.
    await table.evaluate(() => port.postMessage({ type: 'apply', op_id: 'e2e-1', character_id: '123', op: 'damage', amount: 5, expected: { current: 23, maximum: 30, temporary: 4 } }));
    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'applied'))).toEqual([{ type: 'applied', op_id: 'e2e-1', state: 'verified', reason: null }]);
    expect(await s.worker.evaluate(() => httpCalls.filter(c => c.method === 'PUT'))).toEqual([{ url: 'https://character-service.dndbeyond.com/character/v5/life/hp/damage-taken', method: 'PUT', body: { characterId: 123, removedHitPoints: 8, temporaryHitPoints: 0 } }]);
    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'sheet').at(-1).sheet.hp)).toEqual({ current: 22, max: 30, temp: 0 });

    // Popup: per-site toggles. Turning off changes is immediate.
    await picker.reload();
    await expect(picker.getByRole('checkbox', { name: `Allow changes with ${SITE}` })).toBeChecked();
    await picker.screenshot({ path: info.outputPath('picker-shared-v2.png') });
    await picker.getByRole('checkbox', { name: `Allow changes with ${SITE}` }).uncheck();
    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'state').at(-1).scopes.write)).toBe(false);
    await table.evaluate(() => port.postMessage({ type: 'apply', op_id: 'e2e-2', character_id: '123', op: 'heal', amount: 1, expected: null }));
    await expect.poll(() => table.evaluate(() => messages.filter(m => m.type === 'applied').at(-1))).toEqual({ type: 'applied', op_id: 'e2e-2', state: 'rejected', reason: 'scope' });
    expect(await s.worker.evaluate(async () => (await chrome.storage.local.get('sharedScopes')).sharedScopes)).toEqual({ [SITE]: { sheet: true, rolls: true, write: false } });
    expect(await s.worker.evaluate(() => sockets.flatMap(x => x.sent).filter(m => m !== '{"data":"ping"}'))).toEqual([]);
    const all = JSON.stringify(await table.evaluate(() => messages));
    for (const secret of ['accountId', 'e30.', 'stt=', 'characters']) expect(all).not.toContain(secret);
  } finally { await s.context.close(); }
});
