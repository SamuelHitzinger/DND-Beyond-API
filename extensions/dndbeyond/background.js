import { EXTENSION_ID } from './identity.js';
import { createHttpReader } from './http-read.js';
import { createLocalApi } from './local-api.js';
import { createWebShare } from './web-share.js';
export function createBridge(api, { reader = createHttpReader(), accountReader = createHttpReader() } = {}) {
  const bridge = createLocalApi(api, { reader, accountReader });
  // Website sharing has its own ports and its own D&D Beyond reader: the picker's
  // reader is cleared whenever the Windows helper is missing or reconnects, and
  // shared sheets, rolls and writes must not depend on the helper.
  const share = createWebShare(api, bridge, { reader: createHttpReader() });
  api.runtime.onConnect.addListener(port => { try { if (share.ownsPort(port)) share.acceptPort(port); else bridge.acceptPort(port); } catch { port.disconnect(); } });
  api.runtime.onConnectExternal.addListener(port => { try { share.acceptExternal(port); } catch { port.disconnect(); } });
  void bridge.initialize();
  return bridge;
}
if (chrome.runtime.id !== EXTENSION_ID) throw Error('extension_identity');
export const bridge = createBridge(chrome);
