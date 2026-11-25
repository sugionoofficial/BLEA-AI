const CHANNEL = 'blea-browser-companion-v1';

window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || message.direction !== 'app-to-extension' || typeof message.requestId !== 'string') return;
  try {
    const result = await chrome.runtime.sendMessage({
      channel: CHANNEL,
      type: message.type,
      payload: message.payload || {},
    });
    window.postMessage({
      channel: CHANNEL,
      direction: 'extension-to-app',
      requestId: message.requestId,
      result: result?.result ?? null,
      error: result?.error || '',
    }, location.origin);
  } catch (error) {
    window.postMessage({
      channel: CHANNEL,
      direction: 'extension-to-app',
      requestId: message.requestId,
      error: String(error?.message || error).slice(0, 300),
    }, location.origin);
  }
});
