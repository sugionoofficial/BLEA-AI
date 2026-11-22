// Resolver untuk tautan Facebook & TikTok di semua input URL /generate.
//
// Facebook video/reel -> discrape lewat getmyfb.com (endpoint HTMX /process),
// dengan fallback men-scrape halaman facebook.com publik langsung bila
// getmyfb.com memblokir/berubah (keduanya tidak punya API resmi — rapuh by
// design, lihat komentar di setiap fungsi).
//
// TikTok video/foto -> discrape lewat ssstik.io (endpoint HTMX /abc?url=dl),
// dengan fallback ke tikwm.com (API publik yang jauh lebih stabil) bila
// ssstik.io gagal/berubah struktur.
//
// Hasil resolve TIDAK langsung dikembalikan ke klien sebagai URL mentah:
// link CDN ssscdn.io/tikcdn.io umumnya berumur pendek (token base64) dan
// kadang menolak permintaan tanpa Referer yang tepat. Sebagai gantinya kita
// terbitkan URL proxy same-origin bertanda tangan (pola sama seperti
// signVideoContentUrl di worker.js) supaya elemen <video>/<audio> di
// browser bisa memutar/scrub-nya untuk fitur "potong" tanpa kena CORS, lalu
// klien meng-upload hasil (utuh atau terpotong) ke Supabase Storage sendiri.
import { isSafeRemoteMediaUrl, BROWSER_LIKE_USER_AGENT } from './safeUrl.js';

export function fail(message, status = 502) { return Object.assign(new Error(message), { status }); }

function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(String(str || '').replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8Encode(str) { return new TextEncoder().encode(str); }
function utf8Decode(bytes) { return new TextDecoder().decode(bytes); }

async function proxyKey(env) {
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.GITHUB_CLIENT_SECRET || env.SUPABASE_ANON_KEY || 'blea-media-proxy-dev';
  const digest = await crypto.subtle.digest('SHA-256', utf8Encode(`blea-media-proxy-v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

// Token = base64url(JSON {u, k, n, uid, exp}) + signature terpisah, supaya
// elemen <video>/<audio> native (yang tidak bisa mengirim header Authorization)
// tetap bisa memuat media lewat query string, seperti pola signed URL video
// content yang sudah ada di worker.js.
export async function signMediaProxyUrl(payload, env, ttlMs = 15 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  const body = { ...payload, exp };
  const token = base64url(utf8Encode(JSON.stringify(body)));
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', await proxyKey(env), utf8Encode(token)));
  const sig = base64url(sigBytes);
  return `/api/media/proxy?t=${encodeURIComponent(token)}&sig=${encodeURIComponent(sig)}`;
}

export async function verifyMediaProxyToken(token, sig, env) {
  try {
    if (!token || !sig) return null;
    const ok = await crypto.subtle.verify('HMAC', await proxyKey(env), unbase64url(sig), utf8Encode(token));
    if (!ok) return null;
    const payload = JSON.parse(utf8Decode(unbase64url(token)));
    if (!payload?.u || !Number.isFinite(payload?.exp) || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- Deteksi platform ----------
export function detectSocialPlatform(rawUrl) {
  let host = '';
  try { host = new URL(rawUrl).hostname.toLowerCase(); } catch { return null; }
  if (/(^|\.)facebook\.com$/.test(host) || /(^|\.)fb\.watch$/.test(host) || /(^|\.)fb\.me$/.test(host)) return 'facebook';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  return null;
}

// ---------- Helper HTML ekstraksi tanpa DOM (regex, tahan urutan atribut) ----------
function extractAnchorHrefByClass(html, className) {
  const anchorRe = /<a\b[^>]*>/gi;
  const classRe = new RegExp(`class=["'][^"']*\\b${className}\\b[^"']*["']`, 'i');
  let m;
  while ((m = anchorRe.exec(html))) {
    const tag = m[0];
    if (classRe.test(tag)) {
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (hrefMatch) return hrefMatch[1];
    }
  }
  return null;
}

function jsonUnescape(fragment) {
  try { return JSON.parse(`"${fragment}"`); } catch { return fragment; }
}

// ---------- Facebook: getmyfb.com (HTMX /process) ----------
const GETMYFB_HEADERS = {
  'user-agent': BROWSER_LIKE_USER_AGENT,
  accept: '*/*',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'hx-request': 'true',
  'hx-target': 'target',
  'hx-current-url': 'https://getmyfb.com/',
  origin: 'https://getmyfb.com',
  referer: 'https://getmyfb.com/',
};

function parseGetMyFbHtml(page) {
  const links = {};
  let thumb = null;
  const liRe = /<li class="results-list-item">([\s\S]*?)<\/li>/g;
  let m;
  while ((m = liRe.exec(page))) {
    const block = m[1];
    const label = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const hrefMatch = block.match(/href=["']([^"']+)["']/);
    if (!hrefMatch) continue;
    if ((label.startsWith('720') || label.includes('(hd)')) && !links.hd) links.hd = hrefMatch[1];
    else if ((label.startsWith('360') || label.includes('(sd)')) && !links.sd) links.sd = hrefMatch[1];
  }
  const thumbMatch = page.match(/<img class="results-item-image"\s+src=["']([^"']+)["']/);
  if (thumbMatch) thumb = thumbMatch[1];
  return { links, thumb };
}

async function resolveFacebookViaGetMyFb(fbUrl) {
  await fetch('https://getmyfb.com/', {
    headers: { 'user-agent': BROWSER_LIKE_USER_AGENT },
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  const res = await fetch('https://getmyfb.com/process', {
    method: 'POST',
    headers: GETMYFB_HEADERS,
    body: new URLSearchParams({ id: fbUrl, locale: 'en' }).toString(),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  if (/"rate_limit"/.test(text)) throw fail('getmyfb.com sedang membatasi permintaan (rate limit). Coba lagi dalam beberapa saat.', 429);
  const { links, thumb } = parseGetMyFbHtml(text);
  const resolvedUrl = links.hd || links.sd;
  if (resolvedUrl) {
    return { resolvedUrl, quality: links.hd ? 'hd' : 'sd', thumbnail: thumb || null, kind: 'video', via: 'getmyfb.com' };
  }
  const trigger = (res.headers.get('hx-trigger') || '').toLowerCase();
  if (trigger.includes('private')) throw fail('Video Facebook ini privat atau tidak dapat diakses publik.', 422);
  throw fail('getmyfb.com tidak mengembalikan link unduhan (struktur situs mungkin berubah).', 502);
}

// Jalur cadangan: scrape metadata video publik langsung dari facebook.com.
// Dipakai saat getmyfb.com diblokir (umum terjadi dari IP datacenter) atau
// berubah markup. Teknik regex ini umum dipakai pustaka open-source sejenis.
async function resolveFacebookDirect(fbUrl) {
  const res = await fetch(fbUrl, {
    headers: {
      'user-agent': BROWSER_LIKE_USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(20000),
  });
  let text = await res.text();
  text = text.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const hdMatch = text.match(/"browser_native_hd_url":"(.*?)"/) || text.match(/"playable_url_quality_hd":"(.*?)"/);
  const sdMatch = text.match(/"browser_native_sd_url":"(.*?)"/) || text.match(/"playable_url":"(.*?)"/);
  const picked = hdMatch?.[1] || sdMatch?.[1];
  if (!picked) throw fail('Tidak dapat mengekstrak video dari facebook.com secara langsung.', 502);
  const thumbMatch = text.match(/"preferred_thumbnail":\{"image":\{"uri":"(.*?)"/);
  return {
    resolvedUrl: jsonUnescape(picked),
    quality: hdMatch ? 'hd' : 'sd',
    thumbnail: thumbMatch ? jsonUnescape(thumbMatch[1]) : null,
    kind: 'video',
    via: 'facebook.com',
  };
}

export async function resolveFacebookUrl(fbUrl) {
  try {
    return await resolveFacebookViaGetMyFb(fbUrl);
  } catch (primaryErr) {
    if (primaryErr?.status === 422) throw primaryErr; // privat: fallback tidak akan membantu
    try {
      return await resolveFacebookDirect(fbUrl);
    } catch {
      throw primaryErr;
    }
  }
}

// ---------- TikTok: ssstik.io (HTMX /abc?url=dl) ----------
async function resolveTikTokViaSsstik(ttUrl) {
  const page = await fetch('https://ssstik.io/en', {
    headers: { 'user-agent': BROWSER_LIKE_USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*' },
    signal: AbortSignal.timeout(15000),
  });
  const rawSetCookie = page.headers.get('set-cookie') || '';
  const cookie = rawSetCookie ? rawSetCookie.split(/,(?=[^;]+?=)/).map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ') : '';
  const html = await page.text();

  let hxPost = '/abc?url=dl';
  let tt = '0';
  let ts = '';
  const formMatch = html.match(/<form\b[^>]*hx-target=["']#target["'][^>]*>/i);
  if (formMatch) {
    const tag = formMatch[0];
    // include-vals biasanya berisi literal objek JS mentah (mis. {tt:'abc',ts:123})
    // yang memakai tanda kutip tunggal DI DALAM nilai atribut berkutip ganda —
    // backreference (["']) ... \1 dipakai supaya kutip tunggal internal tidak
    // dianggap penutup atribut.
    const hxPostMatch = tag.match(/hx-post=(["'])([^"']+)\1/i);
    if (hxPostMatch) hxPost = hxPostMatch[2];
    const includeValsMatch = tag.match(/include-vals=(["'])([\s\S]*?)\1/i);
    if (includeValsMatch) {
      const raw = includeValsMatch[2];
      const ttMatch = raw.match(/tt:\s*'([^']*)'/) || raw.match(/tt:\s*"([^"]*)"/);
      const tsMatch = raw.match(/ts:\s*([0-9]+)/);
      if (ttMatch?.[1]) tt = ttMatch[1];
      if (tsMatch?.[1]) ts = tsMatch[1];
    }
  }
  const postUrl = hxPost.startsWith('http') ? hxPost : `https://ssstik.io${hxPost.startsWith('/') ? '' : '/'}${hxPost}`;

  const body = new URLSearchParams({ id: ttUrl, locale: 'en', tt });
  if (ts) body.set('ts', ts);

  const dlRes = await fetch(postUrl, {
    method: 'POST',
    headers: {
      'user-agent': BROWSER_LIKE_USER_AGENT,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      referer: 'https://ssstik.io/',
      origin: 'https://ssstik.io',
      ...(cookie ? { cookie } : {}),
    },
    body: body.toString(),
    signal: AbortSignal.timeout(25000),
  });
  const dlHtml = await dlRes.text();

  const videoHref = extractAnchorHrefByClass(dlHtml, 'without_watermark_direct') || extractAnchorHrefByClass(dlHtml, 'without_watermark');
  const musicHref = extractAnchorHrefByClass(dlHtml, 'music');
  if (videoHref) {
    const resolvedUrl = videoHref.startsWith('http') ? videoHref : `https://ssstik.io${videoHref}`;
    return { resolvedUrl, kind: 'video', audioUrl: musicHref || null, via: 'ssstik.io' };
  }

  const photoLinks = Array.from(dlHtml.matchAll(/href=["'](https:\/\/tikcdn\.io\/ssstik\/[^"']+)["']/gi)).map((mm) => mm[1]);
  if (photoLinks.length > 0) {
    return { resolvedUrl: photoLinks[0], kind: 'image', gallery: photoLinks, via: 'ssstik.io' };
  }
  throw fail('ssstik.io tidak mengembalikan link unduhan (video privat, atau struktur situs berubah).', 502);
}

// Jalur cadangan: tikwm.com, API publik tidak resmi yang jauh lebih stabil
// daripada halaman HTMX ssstik.io. Hanya dipakai bila ssstik.io gagal.
async function resolveTikTokViaTikwm(ttUrl) {
  const res = await fetch('https://tikwm.com/api/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      cookie: 'current_language=en',
      'user-agent': BROWSER_LIKE_USER_AGENT,
    },
    body: new URLSearchParams({ url: ttUrl, hd: '1' }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null);
  const v = data?.data;
  const resolvedUrl = v?.hdplay || v?.play;
  if (!resolvedUrl) throw fail('tikwm.com tidak mengembalikan link unduhan.', 502);
  const absolute = resolvedUrl.startsWith('http') ? resolvedUrl : `https://tikwm.com${resolvedUrl}`;
  return {
    resolvedUrl: absolute,
    kind: 'video',
    audioUrl: v?.music ? (v.music.startsWith('http') ? v.music : `https://tikwm.com${v.music}`) : null,
    thumbnail: v?.cover || null,
    via: 'tikwm.com',
  };
}

export async function resolveTikTokUrl(ttUrl) {
  try {
    return await resolveTikTokViaSsstik(ttUrl);
  } catch (primaryErr) {
    try {
      return await resolveTikTokViaTikwm(ttUrl);
    } catch {
      throw primaryErr;
    }
  }
}

export async function resolveSocialMediaUrl(rawUrl) {
  const platform = detectSocialPlatform(rawUrl);
  if (platform === 'facebook') return { platform, ...(await resolveFacebookUrl(rawUrl)) };
  if (platform === 'tiktok') return { platform, ...(await resolveTikTokUrl(rawUrl)) };
  throw fail('URL ini bukan tautan Facebook atau TikTok yang didukung.', 400);
}

// ---------- Rate limit ringan per pengguna (in-memory, best-effort) ----------
const RESOLVE_WINDOW_MS = 5 * 60 * 1000;
const RESOLVE_MAX_PER_WINDOW = 8;
const resolveHistory = new Map(); // userId -> timestamps[]

function checkResolveRateLimit(userId) {
  const now = Date.now();
  const list = (resolveHistory.get(userId) || []).filter((t) => now - t < RESOLVE_WINDOW_MS);
  if (list.length >= RESOLVE_MAX_PER_WINDOW) {
    throw fail('Terlalu banyak percobaan resolve tautan. Coba lagi dalam beberapa menit.', 429);
  }
  list.push(now);
  resolveHistory.set(userId, list);
  if (resolveHistory.size > 2000) {
    for (const [key, entries] of resolveHistory) {
      if (!entries.some((t) => now - t < RESOLVE_WINDOW_MS)) resolveHistory.delete(key);
    }
  }
}

// ---------- Worker route: POST /api/media/resolve ----------
// Body: { url } — hasil: { ok, platform, kind, proxyUrl, downloadProxyUrl, audioProxyUrl?, thumbnail?, quality? }
export async function handleMediaResolve(request, env, user) {
  if (!user?.id) throw fail('Login diperlukan.', 401);
  checkResolveRateLimit(user.id);
  let body;
  try { body = await request.json(); } catch { throw fail('Body permintaan tidak valid.', 400); }
  const rawUrl = String(body?.url || '').trim();
  if (!rawUrl) throw fail('URL wajib diisi.', 400);
  if (!isSafeRemoteMediaUrl(rawUrl)) throw fail('URL harus HTTPS publik yang valid.', 400);

  const resolved = await resolveSocialMediaUrl(rawUrl);
  if (!isSafeRemoteMediaUrl(resolved.resolvedUrl)) throw fail('Link hasil resolve tidak valid/aman.', 502);

  const proxyUrl = await signMediaProxyUrl({ u: resolved.resolvedUrl, k: resolved.kind, n: `${resolved.platform}-${resolved.kind}` }, env);
  let audioProxyUrl = null;
  if (resolved.audioUrl && isSafeRemoteMediaUrl(resolved.audioUrl)) {
    audioProxyUrl = await signMediaProxyUrl({ u: resolved.audioUrl, k: 'audio', n: `${resolved.platform}-audio` }, env);
  }

  return {
    ok: true,
    platform: resolved.platform,
    kind: resolved.kind,
    via: resolved.via,
    quality: resolved.quality || null,
    thumbnail: resolved.thumbnail || null,
    proxyUrl,
    downloadProxyUrl: `${proxyUrl}&download=1`,
    audioProxyUrl,
  };
}

// ---------- Worker route: GET/HEAD /api/media/proxy?t=&sig= ----------
// Streaming proxy SSRF-guarded + ditandatangani (bukan bearer) supaya elemen
// <video>/<audio> native browser bisa memuatnya untuk preview/trim/upload.
const MEDIA_PROXY_MAX_BYTES = 300 * 1024 * 1024; // batas keras; validasi akhir (100MB video/25MB audio) tetap di uploadFreebeat*.

export async function handleMediaProxy(request, url, env) {
  const method = request.method;
  const token = url.searchParams.get('t');
  const sig = url.searchParams.get('sig');
  const payload = await verifyMediaProxyToken(token, sig, env);
  if (!payload) return new Response(JSON.stringify({ error: 'Link proxy tidak valid atau kedaluwarsa.' }), { status: 401, headers: { 'content-type': 'application/json' } });
  if (!isSafeRemoteMediaUrl(payload.u)) return new Response(JSON.stringify({ error: 'Sumber media tidak valid.' }), { status: 400, headers: { 'content-type': 'application/json' } });

  let sourceHost = '';
  try { sourceHost = new URL(payload.u).hostname; } catch { /* sudah divalidasi di atas */ }
  const referer = /tiktok|tikcdn|tikwm/i.test(sourceHost) ? 'https://www.tiktok.com/' : /facebook|fbcdn|ssscdn/i.test(sourceHost) ? 'https://www.facebook.com/' : undefined;

  const upstreamHeaders = {
    'user-agent': BROWSER_LIKE_USER_AGENT,
    accept: '*/*',
    ...(referer ? { referer } : {}),
  };
  const range = request.headers.get('range');
  if (range) upstreamHeaders.range = range;

  let upstream;
  try {
    upstream = await fetch(payload.u, { method, headers: upstreamHeaders, signal: AbortSignal.timeout(60000) });
  } catch (err) {
    return new Response(JSON.stringify({ error: `Gagal mengambil media sumber: ${String(err?.message || err)}` }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return new Response(JSON.stringify({ error: 'Gagal mengambil media sumber.', status: upstream.status }), { status: 502, headers: { 'content-type': 'application/json' } });
  }
  const contentLength = Number(upstream.headers.get('content-length') || 0);
  if (contentLength > MEDIA_PROXY_MAX_BYTES) {
    return new Response(JSON.stringify({ error: 'Media sumber terlalu besar.' }), { status: 413, headers: { 'content-type': 'application/json' } });
  }

  const respHeaders = new Headers();
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
    const v = upstream.headers.get(h);
    if (v) respHeaders.set(h, v);
  }
  if (!respHeaders.has('content-type')) {
    respHeaders.set('content-type', payload.k === 'image' ? 'image/jpeg' : payload.k === 'audio' ? 'audio/mpeg' : 'video/mp4');
  }
  respHeaders.set('cache-control', 'private, max-age=300');
  respHeaders.set('x-content-type-options', 'nosniff');
  if (url.searchParams.get('download') === '1') {
    const ext = payload.k === 'image' ? 'jpg' : payload.k === 'audio' ? 'mp3' : 'mp4';
    const safeName = String(payload.n || 'media').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || 'media';
    respHeaders.set('content-disposition', `attachment; filename="blea-${safeName}.${ext}"`);
  }
  return new Response(method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: respHeaders });
}
