const CHANNEL = 'blea-browser-companion-v1';
const PENDING = new Map();
let nextId = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== 'extension-to-app') return;
    const pending = PENDING.get(message.requestId);
    if (!pending) return;
    PENDING.delete(message.requestId);
    window.clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  });
}

export function browserBridgeAvailable() {
  return typeof window !== 'undefined'
    && (/^https:\/\/blea\.ai$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(window.location.origin));
}

export function requestBrowserBridge(type, payload = {}, { timeoutMs = 8000 } = {}) {
  if (!browserBridgeAvailable()) return Promise.reject(new Error('Browser Companion bridge hanya aktif dari blea.ai atau localhost.'));
  const requestId = `blea-${Date.now()}-${++nextId}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      PENDING.delete(requestId);
      reject(new Error('Ekstensi Browser Companion tidak merespons. Pastikan ekstensi terpasang, tab BLEA dimuat ulang, dan tab tujuan sudah dipilih.'));
    }, timeoutMs);
    PENDING.set(requestId, { resolve, reject, timer });
    window.postMessage({ channel: CHANNEL, direction: 'app-to-extension', requestId, type, payload }, window.location.origin);
  });
}
