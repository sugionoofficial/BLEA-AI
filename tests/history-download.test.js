import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

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
  return new Request(`https://blea.example${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('Worker /api/video/content/:id: ?download=1 mengirim Content-Disposition attachment', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'u@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations')) {
      return Response.json([{
        id: 'vid-abc-123',
        user_id: 'user-1',
        provider: 'alibaba',
        model: 'wan2.2-i2v-plus',
        prompt: 'Kucing',
        status: 'completed',
        progress: 100,
        upstream_result_url: 'https://cdn.example/video.mp4',
        created_at: '2026-11-20T05:00:00Z',
        updated_at: '2026-11-20T05:01:00Z',
      }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([]);
    }
    if (url === 'https://cdn.example/video.mp4') {
      return new Response(new Uint8Array([0, 0, 0, 24]), {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': '4' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const histRes = await worker.fetch(apiReq('/api/video/history', { body: { offset: 0 } }), baseEnv);
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();
    const signedUrl = hist.generations[0].result_url;
    assert.ok(signedUrl.startsWith('/api/video/content/vid-abc-123?'));

    // Inline playback without download=1 keeps no attachment header
    const inlineRes = await worker.fetch(apiReq(signedUrl, { method: 'GET', token: '' }), baseEnv);
    assert.equal(inlineRes.status, 200);
    assert.equal(inlineRes.headers.get('content-disposition'), null);

    // Download mode (?download=1) sets Content-Disposition: attachment
    const dlRes = await worker.fetch(apiReq(`${signedUrl}&download=1`, { method: 'GET', token: '' }), baseEnv);
    assert.equal(dlRes.status, 200);
    assert.equal(dlRes.headers.get('content-type'), 'video/mp4');
    assert.match(dlRes.headers.get('content-disposition') || '', /^attachment; filename="blea-video-vid-abc-123\.mp4"$/);
    assert.equal(dlRes.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Array.from(new Uint8Array(await dlRes.arrayBuffer())), [0, 0, 0, 24]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Worker /api/image/history & /api/image/content/:id: signed attachment proxy (single & multi-image) + SSRF/auth guard', async () => {
  const realFetch = globalThis.fetch;
  const rows = [
    {
      id: 'img-single-1',
      user_id: 'user-1',
      provider: 'freebeat',
      model: '122',
      prompt: 'Senja',
      status: 'completed',
      image_url: 'https://cdn.example/one.png',
      metadata: {},
      credits_charged: 15,
      credits_refunded: 0,
      created_at: '2026-11-20T06:00:00Z',
      updated_at: '2026-11-20T06:00:30Z',
    },
    {
      id: 'img-multi-2',
      user_id: 'user-1',
      provider: 'alibaba',
      model: 'wan2.5-t2i-preview',
      prompt: 'Gunung',
      status: 'completed',
      image_url: 'https://cdn.example/m-1.webp',
      metadata: { image_urls: ['https://cdn.example/m-1.webp', 'https://cdn.example/m-2.jpg'] },
      credits_charged: 15,
      credits_refunded: 0,
      created_at: '2026-11-20T05:50:00Z',
      updated_at: '2026-11-20T05:50:30Z',
    },
  ];

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'u@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/image_generations')) {
      const m = /[?&]id=eq\.([^&]+)/.exec(url);
      if (m) {
        const targetId = decodeURIComponent(m[1]);
        if (targetId === 'img-ssrf') {
          return Response.json([{ id: 'img-ssrf', user_id: 'user-1', status: 'completed', image_url: 'https://127.0.0.1/secret.png', metadata: {} }]);
        }
        if (targetId === 'img-html') {
          return Response.json([{ id: 'img-html', user_id: 'user-1', status: 'completed', image_url: 'https://cdn.example/page.html', metadata: {} }]);
        }
        return Response.json(rows.filter((r) => r.id === targetId));
      }
      return Response.json(rows);
    }
    if (url === 'https://cdn.example/one.png') {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    }
    if (url === 'https://cdn.example/m-2.jpg') {
      return new Response(new Uint8Array([255, 216, 255, 224]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '4' },
      });
    }
    if (url === 'https://cdn.example/page.html') {
      return new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const histRes = await worker.fetch(apiReq('/api/image/history', { body: {} }), baseEnv);
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();
    assert.equal(hist.generations.length, 2);

    const single = hist.generations[0];
    assert.equal(single.image_url, 'https://cdn.example/one.png');
    assert.ok(single.download_url.startsWith('/api/image/content/img-single-1?index=0&'));

    const multi = hist.generations[1];
    assert.deepEqual(multi.image_urls, ['https://cdn.example/m-1.webp', 'https://cdn.example/m-2.jpg']);
    assert.equal(multi.download_urls.length, 2);

    // Signed download for single image works without bearer token and sets attachment
    const dl1 = await worker.fetch(apiReq(single.download_url, { method: 'GET', token: '' }), baseEnv);
    assert.equal(dl1.status, 200);
    assert.equal(dl1.headers.get('content-type'), 'image/png');
    assert.match(dl1.headers.get('content-disposition') || '', /^attachment; filename="blea-image-img-single-1\.png"$/);
    assert.equal(dl1.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Array.from(new Uint8Array(await dl1.arrayBuffer())), [137, 80, 78, 71]);

    // Signed download for 2nd image in multi-image set returns jpg attachment with suffix -2
    const dl2 = await worker.fetch(apiReq(multi.download_urls[1], { method: 'GET', token: '' }), baseEnv);
    assert.equal(dl2.status, 200);
    assert.equal(dl2.headers.get('content-type'), 'image/jpeg');
    assert.match(dl2.headers.get('content-disposition') || '', /^attachment; filename="blea-image-img-multi-2-2\.jpg"$/);

    // Tampering index against signature is rejected 401
    const tampered = single.download_url.replace('index=0', 'index=1');
    const tamperedRes = await worker.fetch(apiReq(tampered, { method: 'GET', token: '' }), baseEnv);
    assert.equal(tamperedRes.status, 401);

    // Unauthenticated without signature -> 401
    const unauthRes = await worker.fetch(apiReq('/api/image/content/img-single-1', { method: 'GET', token: '' }), baseEnv);
    assert.equal(unauthRes.status, 401);

    // SSRF localhost/loopback rejected with 400; non-image HTML rejected with 502
    const ssrfRes = await worker.fetch(apiReq('/api/image/content/img-ssrf', { method: 'GET', token: 'user-token' }), baseEnv);
    assert.equal(ssrfRes.status, 400);
    const htmlRes = await worker.fetch(apiReq('/api/image/content/img-html', { method: 'GET', token: 'user-token' }), baseEnv);
    assert.equal(htmlRes.status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('HistoryPage & GenerateImagePanel menampilkan tombol Unduh untuk setiap hasil yang berhasil', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/history' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const session = {
    access_token: 'mock-session',
    user: { id: 'user-1', email: 'user@example.com', app_metadata: { role: 'user' }, user_metadata: {} },
  };
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] },
  });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { HistoryPage } = await vite.ssrLoadModule('/src/auth/HistoryPage.jsx');
  const { GenerateImagePanel } = await vite.ssrLoadModule('/src/auth/GenerateImagePanel.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  const oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });

  const videos = [
    {
      id: 'vid-done-1',
      provider: 'alibaba',
      model: 'wan2.2-i2v-plus',
      prompt: 'Video berhasil',
      status: 'completed',
      result_url: '/api/video/content/vid-done-1?exp=9999999999999&sig=abc',
      created_at: '2026-11-20T07:00:00Z',
    },
    {
      id: 'vid-fail-2',
      provider: 'alibaba',
      model: 'wan2.2-i2v-plus',
      prompt: 'Video gagal',
      status: 'failed',
      result_url: null,
      created_at: '2026-11-20T06:30:00Z',
    },
  ];
  const images = [
    {
      id: 'img-done-1',
      provider: 'freebeat',
      model: '122',
      prompt: 'Gambar tunggal',
      status: 'completed',
      image_url: 'https://cdn.example/single.png',
      download_url: '/api/image/content/img-done-1?index=0&exp=9999999999999&sig=s1&download=1',
      credits_charged: 15,
      credits_refunded: 0,
      created_at: '2026-11-20T06:50:00Z',
    },
    {
      id: 'img-multi-2',
      provider: 'alibaba',
      model: 'wan2.5-t2i-preview',
      prompt: 'Gambar banyak',
      status: 'completed',
      image_url: 'https://cdn.example/m1.png',
      image_urls: ['https://cdn.example/m1.png', 'https://cdn.example/m2.jpg'],
      download_url: '/api/image/content/img-multi-2?index=0&exp=9999999999999&sig=m1&download=1',
      download_urls: [
        '/api/image/content/img-multi-2?index=0&exp=9999999999999&sig=m1&download=1',
        '/api/image/content/img-multi-2?index=1&exp=9999999999999&sig=m2&download=1',
      ],
      credits_charged: 15,
      credits_refunded: 0,
      created_at: '2026-11-20T06:40:00Z',
    },
  ];

  globalThis.fetch = async (url) => {
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/video/models') return Response.json({ ok: true, models: [{ provider: 'alibaba', id: 'wan2.2-i2v-plus', name: 'Wan 2.2 I2V Plus', providerConfigured: true, resolutions: ['720p'], aspectRatios: ['16:9'], durations: [5], defaultDuration: 5 }], providers: [{ id: 'alibaba', label: 'Alibaba', configured: true }] });
    if (url === '/api/video/history') return Response.json({ ok: true, generations: videos, hasMore: false });
    if (url === '/api/image/history') return Response.json({ ok: true, generations: images });
    if (url === '/api/image/config') return Response.json({ ok: true, model_id: 122, credits: 15, provider_ready: true, ceiling: 50, min_margin: 1 });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 100 });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/history'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(HistoryPage))),
    ));

    // Video completed card
    const vidCard = document.getElementById('history-item-vid-done-1');
    const vidDl = vidCard.querySelector('a.history-download-btn');
    assert.ok(vidDl, 'video berhasil harus punya tombol Unduh');
    assert.match(vidDl.textContent, /Unduh video/);
    assert.equal(vidDl.getAttribute('href'), '/api/video/content/vid-done-1?exp=9999999999999&sig=abc&download=1');
    assert.equal(vidDl.getAttribute('download'), 'blea-video-vid-done.mp4');
    assert.ok([...vidCard.querySelectorAll('a')].some((a) => /Buka video/.test(a.textContent)));

    // Failed video card must NOT have download link
    const failCard = document.getElementById('history-item-vid-fail-2');
    assert.equal(failCard.querySelector('a.history-download-btn'), null);

    // Single image completed card
    const imgCard = document.getElementById('history-item-img-done-1');
    const imgDl = imgCard.querySelector('a.history-download-btn');
    assert.ok(imgDl, 'gambar berhasil harus punya tombol Unduh');
    assert.match(imgDl.textContent, /Unduh gambar/);
    assert.equal(imgDl.getAttribute('href'), images[0].download_url);
    assert.equal(imgDl.getAttribute('download'), 'blea-image-img-done.png');

    // Multi-image completed card exposes download button per output image
    const multiCard = document.getElementById('history-item-img-multi-2');
    const multiDls = [...multiCard.querySelectorAll('a.history-download-btn')];
    assert.equal(multiDls.length, 2);
    assert.match(multiDls[0].textContent, /Unduh gambar #1/);
    assert.match(multiDls[1].textContent, /Unduh gambar #2/);
    assert.equal(multiDls[1].getAttribute('href'), images[1].download_urls[1]);
    assert.equal(multiDls[1].getAttribute('download'), 'blea-image-img-mult-2.jpg');

    // GenerateImagePanel history cards also expose download buttons
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate?mode=image'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(GenerateImagePanel))),
    ));
    const panelDls = [...document.querySelectorAll('.generate-history a.history-download-btn')];
    assert.equal(panelDls.length, 3);
    assert.match(panelDls[0].textContent, /Unduh gambar/);
    assert.equal(panelDls[0].getAttribute('href'), images[0].download_url);

    // GeneratePage preview & Riwayat Generate cards also include &download=1 download buttons
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(GeneratePage))),
    ));
    const videoPreviewDl = [...document.querySelectorAll('a.generate-secondary-btn')].find((a) => /Unduh Video/.test(a.textContent));
    assert.ok(videoPreviewDl, 'preview video harus punya tombol Unduh Video');
    assert.equal(videoPreviewDl.getAttribute('href'), '/api/video/content/vid-done-1?exp=9999999999999&sig=abc&download=1');
    const videoListDls = [...document.querySelectorAll('a.generate-history-download-btn')];
    assert.equal(videoListDls.length, 1);
    assert.equal(videoListDls[0].getAttribute('href'), '/api/video/content/vid-done-1?exp=9999999999999&sig=abc&download=1');
    assert.equal(videoListDls[0].getAttribute('download'), 'blea-video-vid-done.mp4');
  } finally {
    await React.act(async () => root.unmount());
    supabase.auth.getSession = oldGet;
    supabase.auth.onAuthStateChange = oldOn;
    globalThis.fetch = oldFetch;
    await supabase.auth.dispose();
    await vite.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.HTMLElement;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
