import { expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export const origin = 'chrome-extension://abeakpcagojpphodembeeajfjgmcadnc/';
export const origins = ['https://auth-service.dndbeyond.com/*', 'https://character-service.dndbeyond.com/*', 'https://character-service-scds.dndbeyond.com/*'];
export async function fixture(info) {
  const root = fileURLToPath(new URL('../../', import.meta.url)), extension = info.outputPath('extension');
  await mkdir(extension, { recursive: true }); await cp(process.env.CHARACTER_API_EXTENSION_UNDER_TEST ?? root + '/extensions/dndbeyond', extension, { recursive: true });
  await cp(extension + '/background.js', extension + '/production-background.js');
  const token = 'e30.' + Buffer.from(JSON.stringify({ 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier': '42' })).toString('base64url') + '.signature';
  await writeFile(extension + '/boundary.js', `
    globalThis.nativeMessages=[]; globalThis.nativePorts=[]; globalThis.httpCalls=[];
    const event=()=>{const listeners=[];return {addListener:f=>listeners.push(f),emit:x=>Promise.all(listeners.map(f=>f(x)))};};
    chrome.runtime.connectNative=()=>{const p={onMessage:event(),onDisconnect:event(),postMessage:m=>nativeMessages.push(m),disconnect(){this.onDisconnect.emit();}};nativePorts.push(p);return p;};
    chrome.permissions.contains=async()=>true;
    globalThis.fetch=async(url,options)=>{
      const allowed=['https://auth-service.dndbeyond.com/v1/cobalt-token','https://character-service.dndbeyond.com/character/v5/characters/list?userId=42','https://character-service.dndbeyond.com/character/v5/character/123'];
      if(!allowed.includes(url)) throw Error('external traffic blocked');
      httpCalls.push({url,method:options.method});
      const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
      if(url.includes('auth-service')) return json({token:${JSON.stringify(token)},ttl:300});
      if(url.includes('/characters/list?')) {
        if(globalThis.listFailure) return new Response('',{status:listFailure});
        return json({success:true,data:{characters:globalThis.emptyList?[]:[{id:123,name:'<b>Invented Hero</b>',status:1,level:4,raceName:'Elf',classDescription:'Wizard 4'},{id:456,name:'Second Hero',status:1,level:2,raceName:'Human',classDescription:'Fighter 2'}]}});
      }
      return json({success:true,data:{id:123,name:'Invented Hero'}});
    };
  `);
  await writeFile(extension + '/background.js', "import './boundary.js';\nimport {bridge} from './production-background.js';\nglobalThis.bridge=bridge;\n");
  await mkdir(root + '/artifacts/profiles', { recursive: true }); const profile = await mkdtemp(root + '/artifacts/profiles/picker-');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, serviceWorkers: 'allow', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort('blockedbyclient'));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await expect.poll(() => worker.evaluate(() => !!globalThis.bridge)).toBe(true);
  const send = message => worker.evaluate(message => nativePorts.at(-1).onMessage.emit(message), message);
  return { context, worker, send };
}
