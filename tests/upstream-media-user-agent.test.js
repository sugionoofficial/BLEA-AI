// Regression for the production incident: music generations finished `completed` (credits charged,
// provider returned a valid file) but playback failed with
//   {"error":"Failed to stream upstream music media","status":403,"detail":"...403 ERROR...Request blocked..."}
//
// Root cause: Cloudflare Workers' global fetch() sends NO `User-Agent` header by default (unlike
// Node/browser fetch or curl). Freebeat's media CDN (fb-video-n3.freebeat.ai, fronted by CloudFront)
// rejects empty-UA requests with a 403 "Request blocked" HTML page. The Worker's media proxies
// (/api/music/content/:id, /api/video/content/:id, /api/image/content/:id) forwarded that 403 to the
// client as a 502. Every upstream media subrequest must therefore send an identifying User-Agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const BASE = 'https://blea.example';

const baseEnv = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-secret',
  FREEBEAT_CREDENTIAL_ENCRYPTION_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
};

function apiReq(path, { method = 'POST', body, token = 'user-token' } = {}) {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    headers.set('origin', 'https://blea.example');
  }
  return new Request(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
}

// Emulates CloudFront/Freebeat bot filtering: any subrequest without a non-empty User-Agent is
// blocked with the exact 403 HTML shape seen in production.
function cloudfrontUaGuard(headers, respond) {
  const ua = headers.get ? headers.get('user-agent') : headers['user-agent'];
  if (!ua || !String(ua).trim()) {
    return new Response(
      '<HTML><HEAD><TITLE>ERROR: The request could not be satisfied</TITLE></HEAD><BODY><H1>403 ERROR</H1>The request could not be satisfied.<BR/>Request blocked.</BODY></HTML>',
      { status: 403, headers: { 'content-type': 'text/html' } },
    );
  }
  return respond(ua);
}

test('GET /api/video/content/:id sends a User-Agent so a UA-filtered CDN does not 403', async () => {
  const realFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'u@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations')) {
      return Response.json([{
        id: 'vid-ua-1',
        user_id: 'user-1',
        provider: 'alibaba',
        model: 'wan2.2-i2v-plus',
        status: 'completed',
        upstream_result_url: 'https://fb-video-n3.freebeat.test/lmp/generated/video/final.mp4',
        created_at: '2026-11-22T00:00:00Z',
        updated_at: '2026-11-22T00:01:00Z',
      }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([]);
    }
    if (url.startsWith('https://fb-video-n3.freebeat.test/')) {
      const headers = new Headers(init.headers || {});
      seenHeaders.push(Object.fromEntries(headers.entries()));
      return cloudfrontUaGuard(headers, () => new Response(new Uint8Array([0, 0, 0, 24]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const histRes = await worker.fetch(apiReq('/api/video/history', { body: { offset: 0 } }), baseEnv);
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();
    const signedUrl = hist.generations[0].result_url;
    assert.ok(signedUrl.startsWith('/api/video/content/vid-ua-1?'));

    const streamRes = await worker.fetch(apiReq(signedUrl, { method: 'GET', token: '' }), baseEnv);
    assert.equal(streamRes.status, 200, 'must not forward the CDN 403 HTML as a 502');
    assert.equal(streamRes.headers.get('content-type'), 'video/mp4');

    assert.equal(seenHeaders.length, 1);
    assert.ok(seenHeaders[0]['user-agent']?.trim().length > 0, 'User-Agent must not be empty');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /api/image/content/:id sends a User-Agent so a UA-filtered CDN does not 403', async () => {
  const realFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'u@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/image_generations')) {
      return Response.json([{
        id: 'img-ua-1',
        user_id: 'user-1',
        provider: 'freebeat',
        model: '122',
        status: 'completed',
        image_url: 'https://fb-video-n3.freebeat.test/lmp/generated/cover.png',
        metadata: {},
        created_at: '2026-11-22T00:00:00Z',
        updated_at: '2026-11-22T00:00:30Z',
      }]);
    }
    if (url.startsWith('https://fb-video-n3.freebeat.test/')) {
      const headers = new Headers(init.headers || {});
      seenHeaders.push(Object.fromEntries(headers.entries()));
      return cloudfrontUaGuard(headers, () => new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const histRes = await worker.fetch(apiReq('/api/image/history', { body: {} }), baseEnv);
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();
    const signedUrl = hist.generations[0].download_url;
    assert.ok(signedUrl.startsWith('/api/image/content/img-ua-1?'));

    const dlRes = await worker.fetch(apiReq(signedUrl, { method: 'GET', token: '' }), baseEnv);
    assert.equal(dlRes.status, 200, 'must not forward the CDN 403 HTML as a 502');
    assert.equal(dlRes.headers.get('content-type'), 'image/png');

    assert.equal(seenHeaders.length, 1);
    assert.ok(seenHeaders[0]['user-agent']?.trim().length > 0, 'User-Agent must not be empty');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('GET /api/music/content/:id (the exact incident path) sends a User-Agent and Range so a UA-filtered CDN streams instead of 403/502', async () => {
  const realFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'u@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/music_generations')) {
      return Response.json([{
        id: 'mus-ua-1',
        user_id: 'user-1',
        provider: 'freebeat',
        model: '129',
        status: 'completed',
        audio_url: 'https://fb-video-n3.freebeat.test/lmp/generated/audio/track.mp3',
        cover_url: null,
        external_job_id: 'music:2501106',
        metadata: { audios: ['https://fb-video-n3.freebeat.test/lmp/generated/audio/track.mp3'] },
        created_at: '2026-11-22T00:00:00Z',
        updated_at: '2026-11-22T00:01:00Z',
      }]);
    }
    if (url.startsWith('https://fb-video-n3.freebeat.test/')) {
      const headers = new Headers(init.headers || {});
      seenHeaders.push(Object.fromEntries(headers.entries()));
      // Without the fix this is exactly the production failure: empty UA -> CloudFront 403 HTML ->
      // worker answers 502 {"error":"Failed to stream upstream music media"}.
      return cloudfrontUaGuard(headers, (ua) => {
        if (headers.get('range') === 'bytes=0-3') {
          return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), {
            status: 206,
            headers: { 'content-type': 'audio/mpeg', 'content-length': '4', 'content-range': 'bytes 0-3/10' },
          });
        }
        return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': '10' },
        });
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const signedPath = await (async () => {
      // Derive a validly-signed proxy URL the same way /api/music/status would.
      const statusLikeRes = await worker.fetch(apiReq('/api/music/content/mus-ua-1?kind=audio&index=0', {
        method: 'GET',
        token: 'user-token',
      }), baseEnv);
      // Unsigned-but-authenticated request is also a supported path (owner bearer token); assert it
      // doesn't 502 either, since that's the exact shape of the incident report.
      assert.notEqual(statusLikeRes.status, 502, 'must not forward the CDN 403 HTML as a 502');
      assert.equal(statusLikeRes.status, 200);
      return statusLikeRes;
    })();
    assert.equal(signedPath.headers.get('content-type'), 'audio/mpeg');

    // Range requests (used by audio players for seeking) must also carry the User-Agent.
    const rangeRes = await worker.fetch(new Request(`${BASE}/api/music/content/mus-ua-1?kind=audio&index=0`, {
      method: 'GET',
      headers: { authorization: 'Bearer user-token', range: 'bytes=0-3' },
    }), baseEnv);
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('content-range'), 'bytes 0-3/10');

    assert.equal(seenHeaders.length, 2);
    for (const headers of seenHeaders) {
      assert.ok(headers['user-agent']?.trim().length > 0, 'User-Agent must not be empty');
    }
    assert.equal(seenHeaders[1].range, 'bytes=0-3');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('control: a UA-filtered CDN really does 403 an empty-User-Agent request (sanity check for the mock)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://cdn.freebeat.test/no-ua-check.mp3') {
      const headers = new Headers(init.headers || {});
      return cloudfrontUaGuard(headers, () => new Response('ok', { status: 200 }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const blocked = await globalThis.fetch('https://cdn.freebeat.test/no-ua-check.mp3', { headers: {} });
    assert.equal(blocked.status, 403);
    const okRes = await globalThis.fetch('https://cdn.freebeat.test/no-ua-check.mp3', { headers: { 'user-agent': 'x' } });
    assert.equal(okRes.status, 200);
  } finally {
    globalThis.fetch = realFetch;
  }
});
