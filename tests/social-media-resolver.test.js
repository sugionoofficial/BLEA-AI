import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { isSafeRemoteMediaUrl } from '../src/lib/safeUrl.js';
import {
  detectSocialPlatform,
  resolveFacebookUrl,
  resolveTikTokUrl,
  signMediaProxyUrl,
  verifyMediaProxyToken,
} from '../src/lib/socialMediaResolver.js';

const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret', ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
const request = (path, { token, method = 'GET', body } = {}) => new Request(`https://blea-ai.blea-ai.workers.dev${path}`, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
const call = (path, options) => worker.fetch(request(path, options), env);

function withMockedFetch(handler, fn) {
  return async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      await fn();
    } finally {
      globalThis.fetch = realFetch;
    }
  };
}

test('detectSocialPlatform recognizes Facebook and TikTok hosts only', () => {
  assert.equal(detectSocialPlatform('https://www.facebook.com/watch?v=123'), 'facebook');
  assert.equal(detectSocialPlatform('https://fb.watch/abc123/'), 'facebook');
  assert.equal(detectSocialPlatform('https://vt.tiktok.com/abc/'), 'tiktok');
  assert.equal(detectSocialPlatform('https://www.tiktok.com/@user/video/123'), 'tiktok');
  assert.equal(detectSocialPlatform('https://suno.com/song/abc'), null);
  assert.equal(detectSocialPlatform('not a url'), null);
});

test('isSafeRemoteMediaUrl rejects non-https and private/internal hosts', () => {
  assert.equal(isSafeRemoteMediaUrl('https://example.com/video.mp4'), true);
  assert.equal(isSafeRemoteMediaUrl('http://example.com/video.mp4'), false);
  assert.equal(isSafeRemoteMediaUrl('https://localhost/video.mp4'), false);
  assert.equal(isSafeRemoteMediaUrl('https://127.0.0.1/video.mp4'), false);
  assert.equal(isSafeRemoteMediaUrl('https://192.168.1.5/video.mp4'), false);
  assert.equal(isSafeRemoteMediaUrl('https://10.0.0.5/video.mp4'), false);
  assert.equal(isSafeRemoteMediaUrl('https://user:pass@example.com/video.mp4'), false);
  assert.equal(isSafeRemoteMediaUrl(123), false);
});

test('resolveFacebookUrl parses getmyfb.com results-list-item HD/SD links', withMockedFetch(async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://getmyfb.com/') return new Response('ok');
  if (url === 'https://getmyfb.com/process') {
    const html = `
      <ul>
        <li class="results-list-item"><a href="https://cdn.ssscdn.io/get?token=hd">720p (HD)</a></li>
        <li class="results-list-item"><a href="https://cdn.ssscdn.io/get?token=sd">360p (SD)</a></li>
      </ul>
      <img class="results-item-image" src="https://cdn.ssscdn.io/thumb.jpg" />
    `;
    return new Response(html, { headers: { 'hx-trigger': 'resultsuccess' } });
  }
  throw new Error(`unexpected fetch ${url}`);
}, async () => {
  const result = await resolveFacebookUrl('https://www.facebook.com/watch/?v=1393572814172251');
  assert.equal(result.resolvedUrl, 'https://cdn.ssscdn.io/get?token=hd');
  assert.equal(result.quality, 'hd');
  assert.equal(result.thumbnail, 'https://cdn.ssscdn.io/thumb.jpg');
  assert.equal(result.via, 'getmyfb.com');
}));

test('resolveFacebookUrl falls back to direct facebook.com scrape when getmyfb.com yields nothing', withMockedFetch(async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://getmyfb.com/') return new Response('ok');
  if (url === 'https://getmyfb.com/process') {
    return new Response('<div>no results here</div>', { headers: { 'hx-trigger': 'resultfail' } });
  }
  if (url.startsWith('https://www.facebook.com/watch')) {
    const html = '<html>"browser_native_hd_url":"https:\\/\\/video.fbcdn.net\\/abc.mp4"</html>';
    return new Response(html);
  }
  throw new Error(`unexpected fetch ${url}`);
}, async () => {
  const result = await resolveFacebookUrl('https://www.facebook.com/watch?v=1393572814172251');
  assert.equal(result.resolvedUrl, 'https://video.fbcdn.net/abc.mp4');
  assert.equal(result.via, 'facebook.com');
}));

test('resolveFacebookUrl surfaces a private-video error without attempting the fallback', withMockedFetch(async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://getmyfb.com/') return new Response('ok');
  if (url === 'https://getmyfb.com/process') {
    return new Response('<div>private</div>', { headers: { 'hx-trigger': 'resultisprivate' } });
  }
  throw new Error(`unexpected fetch ${url} (fallback should not run for private videos)`);
}, async () => {
  await assert.rejects(() => resolveFacebookUrl('https://www.facebook.com/watch?v=999'), /privat/i);
}));

test('resolveTikTokUrl parses the ssstik.io HTMX form token and without_watermark link', withMockedFetch(async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://ssstik.io/en') {
    const html = `<form id="main" hx-target="#target" hx-post="/abc?url=dl" include-vals="{tt:'abc123',ts:1700000000000}"></form>`;
    return new Response(html);
  }
  if (url === 'https://ssstik.io/abc?url=dl') {
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('tt'), 'abc123');
    assert.equal(body.get('ts'), '1700000000000');
    const html = '<div><a href="https://tikcdn.io/ssstik/video-direct" class="without_watermark_direct">Download</a><a href="https://tikcdn.io/ssstik/music" class="music">Music</a></div>';
    return new Response(html);
  }
  throw new Error(`unexpected fetch ${url}`);
}, async () => {
  const result = await resolveTikTokUrl('https://www.tiktok.com/@user/video/123');
  assert.equal(result.resolvedUrl, 'https://tikcdn.io/ssstik/video-direct');
  assert.equal(result.audioUrl, 'https://tikcdn.io/ssstik/music');
  assert.equal(result.via, 'ssstik.io');
}));

test('resolveTikTokUrl falls back to tikwm.com when ssstik.io has no download link', withMockedFetch(async (input) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://ssstik.io/en') return new Response('<form hx-target="#target" hx-post="/abc?url=dl" include-vals="{tt:\'0\'}"></form>');
  if (url === 'https://ssstik.io/abc?url=dl') return new Response('<div>no links</div>');
  if (url === 'https://tikwm.com/api/') {
    return Response.json({ data: { play: '/video/abc.mp4', music: '/music/abc.mp3', cover: 'https://tikwm.com/cover.jpg' } });
  }
  throw new Error(`unexpected fetch ${url}`);
}, async () => {
  const result = await resolveTikTokUrl('https://www.tiktok.com/@user/video/456');
  assert.equal(result.resolvedUrl, 'https://tikwm.com/video/abc.mp4');
  assert.equal(result.audioUrl, 'https://tikwm.com/music/abc.mp3');
  assert.equal(result.via, 'tikwm.com');
}));

test('signMediaProxyUrl / verifyMediaProxyToken round-trip, reject tampering and expiry', async () => {
  const signed = await signMediaProxyUrl({ u: 'https://cdn.example.com/a.mp4', k: 'video' }, env, 1000);
  const params = new URL(`https://x${signed}`).searchParams;
  const payload = await verifyMediaProxyToken(params.get('t'), params.get('sig'), env);
  assert.equal(payload.u, 'https://cdn.example.com/a.mp4');

  const tampered = await verifyMediaProxyToken(params.get('t'), 'not-a-real-signature', env);
  assert.equal(tampered, null);

  const expiredSigned = await signMediaProxyUrl({ u: 'https://cdn.example.com/a.mp4', k: 'video' }, env, -1000);
  const expiredParams = new URL(`https://x${expiredSigned}`).searchParams;
  const expired = await verifyMediaProxyToken(expiredParams.get('t'), expiredParams.get('sig'), env);
  assert.equal(expired, null);
});

test('POST /api/media/resolve requires login, validates URL, and rejects unsupported platforms', withMockedFetch(async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://supabase.example/auth/v1/user') {
    const token = init.headers.authorization?.replace('Bearer ', '');
    if (token !== 'user-token') return Response.json({}, { status: 401 });
    return Response.json({ id: 'user-1', app_metadata: { role: 'user' } });
  }
  throw new Error(`unexpected fetch ${url}`);
}, async () => {
  const noAuth = await call('/api/media/resolve', { method: 'POST', body: { url: 'https://www.tiktok.com/@a/video/1' } });
  assert.equal(noAuth.status, 401);

  const badUrl = await call('/api/media/resolve', { method: 'POST', token: 'user-token', body: { url: 'not-a-url' } });
  assert.equal(badUrl.status, 400);

  const unsupported = await call('/api/media/resolve', { method: 'POST', token: 'user-token', body: { url: 'https://example.com/song.mp3' } });
  assert.equal(unsupported.status, 400);
  const unsupportedBody = await unsupported.json();
  assert.match(unsupportedBody.error, /Facebook atau TikTok/);
}));

test('GET /api/media/proxy rejects invalid/expired/tampered signatures', async () => {
  const res = await call('/api/media/proxy?t=bogus&sig=bogus');
  assert.equal(res.status, 401);
});

test('end-to-end: resolve a TikTok URL then stream it through the signed proxy', withMockedFetch(async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'https://supabase.example/auth/v1/user') {
    return Response.json({ id: 'user-1', app_metadata: { role: 'user' } });
  }
  if (url === 'https://ssstik.io/en') {
    return new Response('<form hx-target="#target" hx-post="/abc?url=dl" include-vals="{tt:\'tok\',ts:1}"></form>');
  }
  if (url === 'https://ssstik.io/abc?url=dl') {
    return new Response('<a href="https://tikcdn.io/ssstik/final.mp4" class="without_watermark_direct">dl</a>');
  }
  if (url === 'https://tikcdn.io/ssstik/final.mp4') {
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } });
  }
  throw new Error(`unexpected fetch ${url} ${JSON.stringify(init)}`);
}, async () => {
  const resolveRes = await call('/api/media/resolve', { method: 'POST', token: 'user-token', body: { url: 'https://www.tiktok.com/@a/video/1' } });
  assert.equal(resolveRes.status, 200);
  const data = await resolveRes.json();
  assert.equal(data.ok, true);
  assert.equal(data.platform, 'tiktok');
  assert.ok(data.proxyUrl.startsWith('/api/media/proxy?t='));

  const streamRes = await call(data.proxyUrl);
  assert.equal(streamRes.status, 200);
  assert.equal(streamRes.headers.get('content-type'), 'video/mp4');
  const bytes = new Uint8Array(await streamRes.arrayBuffer());
  assert.deepEqual([...bytes], [1, 2, 3, 4]);
}));
