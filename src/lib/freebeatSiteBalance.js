// Temporary, admin-only diagnostic for the Freebeat website. This is not MCP.
// The supplied session cookie is forwarded only to this fixed HTTPS endpoint and is never stored.
const BALANCE_URL = 'https://freebeat.ai/api/proxy/v1/user/credits/findCredits';
const MAX_BODY = 16384;

export async function boundedJson(response) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new Error('too large');
  if (!response.body) throw new Error('empty');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  } finally { reader.releaseLock(); }
}

function result(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

// Accept a single HTTP Cookie header value, never raw headers, request lines or control characters.
function validCookie(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 &&
    /^[\x20-\x7e]+$/.test(value) && value.split(';').every((part) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21-\x3a\x3c-\x7e]*$/.test(part.trim()));
}

function creditNumber(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export async function siteBalance(request) {
  // Bearer auth and admin role are checked by handleFreebeat; require same-origin POST too.
  if (request.headers.get('origin') !== new URL(request.url).origin) return result({ error: 'Permintaan harus berasal dari halaman BLEA ini.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return result({ error: 'Format permintaan tidak valid.' }, 400);
  let input;
  try { input = await boundedJson(request); } catch { return result({ error: 'Permintaan tidak valid atau terlalu besar.' }, 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || !validCookie(input.cookie)) return result({ error: 'Masukkan hanya nilai header Cookie Freebeat yang valid (maksimal 8192 karakter).' }, 400);

  let upstream;
  try {
    upstream = await fetch(BALANCE_URL, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { accept: 'application/json', cookie: input.cookie },
    });
  } catch { return result({ error: 'Tidak dapat menghubungi situs Freebeat. Tidak ada cookie yang disimpan.' }, 502); }
  if (upstream.status >= 300 && upstream.status < 400) {
    try { await upstream.body?.cancel(); } catch { /* ignore stream errors */ }
    return result({ error: 'Pengalihan Freebeat ditolak demi keamanan.' }, 502);
  }
  if (!upstream.ok) {
    try { await upstream.body?.cancel(); } catch { /* ignore stream errors */ }
    return result({ error: upstream.status === 401 || upstream.status === 403 ? 'Sesi situs ditolak atau kedaluwarsa. Tidak ada cookie yang disimpan.' : 'Situs Freebeat menolak permintaan saldo. Tidak ada cookie yang disimpan.' }, 502);
  }
  let payload;
  try { payload = await boundedJson(upstream); } catch { return result({ error: 'Respons saldo situs Freebeat tidak valid.' }, 502); }
  const totalCredits = creditNumber(payload?.data?.totalCredits);
  if (payload?.code !== 0 || totalCredits === null) return result({ error: 'Situs Freebeat tidak mengembalikan saldo yang valid; periksa sesi dan izin akun.' }, 502);
  const balance = { totalCredits };
  for (const field of ['free', 'boost', 'membership', 'event']) {
    const value = creditNumber(payload.data[field]);
    if (value !== null) balance[field] = value;
  }
  return result({ ok: true, balance });
}
