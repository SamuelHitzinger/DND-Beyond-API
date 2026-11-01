import { EXTENSION_ID } from './identity.js';
import { createHttpReader } from './http-read.js';
import { createLocalApi } from './local-api.js';
export function createBridge(api, { reader = createHttpReader() } = {}) {
  const bridge = createLocalApi(api, { reader });
  api.runtime.onConnect.addListener(port => { try { bridge.acceptPort(port); } catch { port.disconnect(); } });
  void bridge.initialize();
  return bridge;
}
if (chrome.runtime.id !== EXTENSION_ID) throw Error('extension_identity');
export const bridge = createBridge(chrome);
