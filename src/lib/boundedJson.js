// Bounded JSON parsing for Freebeat request and database responses.
const MAX_BODY = 16384;

export async function boundedJson(response, maxBytes = MAX_BODY) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_BODY;
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) throw new Error('too large');
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  } finally { reader.releaseLock(); }
}
