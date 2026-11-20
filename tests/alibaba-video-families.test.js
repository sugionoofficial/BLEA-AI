import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const BASE_INTL = 'https://dashscope-intl.aliyuncs.com';
const BASE_CN = 'https://dashscope.aliyuncs.com';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path, { method = 'POST', body, token = 'user-jwt' } = {}) {
  return new Request(`https://app.example${path}`, {
    method,
    headers: {
      origin: 'https://app.example',
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function installMock({ baseUrl = BASE_INTL, upstreamError = null } = {}) {
  const realFetch = globalThis.fetch;
  const submits = [];
  let storedRow = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com', app_metadata: { role: 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([{ id: 'user-123', status: 'active' }]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'alibaba', api_key: 'sk-test-video', base_url: baseUrl, label: 'Alibaba' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) {
      return Response.json([{ credits: 50 }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) {
      return Response.json(true);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) {
      return Response.json(true);
    }
    if (url.startsWith(`${baseUrl}/api/v1/services/aigc/`) && method === 'POST') {
      submits.push({ url, headers: init.headers || {}, body: jsonBody() });
      if (upstreamError) {
        return new Response(JSON.stringify(upstreamError.body), { status: upstreamError.status, headers: { 'content-type': 'application/json' } });
      }
      return Response.json({ output: { task_id: 'task-fam-1', task_status: 'PENDING' } });
    }
    if (url === 'https://supabase.example/rest/v1/video_generations' && method === 'POST') {
      const payload = jsonBody();
      storedRow = { ...payload, id: 'gen-fam-1', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z' };
      return Response.json([storedRow]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { submits, restore() { globalThis.fetch = realFetch; } };
}

test('Wan T2V: size W*H resmi, audio pada 2.6, tolak media, mapping wanx2.1 di Beijing', async () => {
  const mockIntl = installMock({ baseUrl: BASE_INTL });
  try {
    const res26 = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'alibaba',
        model: 'wan2.6-t2v',
        prompt: 'Kota neon hujan deras',
        aspect_ratio: '9:16',
        resolution: '1080p',
        duration: 12,
        audio_url: 'https://cdn.example/bgm.mp3',
        generate_audio: true,
      },
    }), createEnv());
    assert.equal(res26.status, 200);
    const req26 = mockIntl.submits[0];
    assert.equal(req26.url, `${BASE_INTL}/api/v1/services/aigc/video-generation/video-synthesis`);
    assert.equal(req26.headers['X-DashScope-Async'], 'enable');
    assert.equal(req26.body.model, 'wan2.6-t2v');
    assert.deepEqual(req26.body.input, { prompt: 'Kota neon hujan deras', audio_url: 'https://cdn.example/bgm.mp3' });
    assert.equal(req26.body.parameters.size, '1080*1920');
    assert.equal(req26.body.parameters.duration, 12);
    assert.equal(req26.body.parameters.audio, true);

    const rejectImg = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.2-t2v-plus', prompt: 'tes', image_url: 'https://cdn.example/a.png', resolution: '480p' },
    }), createEnv());
    assert.equal(rejectImg.status, 400);

    const res21Intl = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-t2v-plus', prompt: 'gunung', aspect_ratio: '16:9', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(res21Intl.status, 200);
    assert.equal(mockIntl.submits[1].body.model, 'wan2.1-t2v-plus');
    assert.equal(mockIntl.submits[1].body.parameters.size, '1280*720');
  } finally {
    mockIntl.restore();
  }

  const mockCn = installMock({ baseUrl: BASE_CN });
  try {
    const res21Cn = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-t2v-plus', prompt: 'gunung', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(res21Cn.status, 200);
    assert.equal(mockCn.submits[0].body.model, 'wanx2.1-t2v-plus');
  } finally {
    mockCn.restore();
  }
});

test('Wan I2V: wajib img_url, batasi wan2.2-i2v-flash 480P/720P, mapping Beijing wanx2.1-i2v-turbo', async () => {
  const mock = installMock({ baseUrl: BASE_CN });
  try {
    const missing = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.6-i2v', prompt: 'gerak halus' },
    }), createEnv());
    assert.equal(missing.status, 400);

    const badResFlash = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.2-i2v-flash', prompt: 'tes', image_url: 'https://cdn.example/a.png', resolution: '1080p', duration: 5 },
    }), createEnv());
    assert.equal(badResFlash.status, 400);

    const ok26 = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.6-i2v', prompt: 'kamera zoom', image_url: 'https://cdn.example/a.png', resolution: '1080p', duration: 8, generate_audio: false },
    }), createEnv());
    assert.equal(ok26.status, 200);
    assert.deepEqual(mock.submits[0].body.input, { prompt: 'kamera zoom', img_url: 'https://cdn.example/a.png' });
    assert.equal(mock.submits[0].body.parameters.resolution, '1080P');
    assert.equal(mock.submits[0].body.parameters.audio, false);

    const ok21 = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-i2v-turbo', prompt: 'kucing', image_url: 'https://cdn.example/cat.png', resolution: '720p', duration: 3 },
    }), createEnv());
    assert.equal(ok21.status, 200);
    assert.equal(mock.submits[1].body.model, 'wanx2.1-i2v-turbo');
    assert.equal(mock.submits[1].body.parameters.duration, 3);
  } finally {
    mock.restore();
  }
});

test('Wan R2V, KF2V, Animate, dan VACE: endpoint & struktur payload sesuai dokumen resmi', async () => {
  const mock = installMock({ baseUrl: BASE_CN });
  try {
    // 1. Wan 2.6 R2V
    const r2v = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'alibaba',
        model: 'wan2.6-r2v',
        prompt: 'character1 berjalan di pantai',
        aspect_ratio: '16:9',
        resolution: '720p',
        duration: 6,
        reference_videos: ['https://cdn.example/char.mp4'],
      },
    }), createEnv());
    assert.equal(r2v.status, 200);
    assert.equal(mock.submits[0].url, `${BASE_CN}/api/v1/services/aigc/video-generation/video-synthesis`);
    assert.deepEqual(mock.submits[0].body.input, { prompt: 'character1 berjalan di pantai', reference_urls: ['https://cdn.example/char.mp4'] });
    assert.equal(mock.submits[0].body.parameters.size, '1280*720');

    // 2. Wan KF2V (image2video/video-synthesis + first_frame_url + last_frame_url wajib)
    const kfMissingLast = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.2-kf2v-flash', prompt: 'transisi', image_url: 'https://cdn.example/f1.png' },
    }), createEnv());
    assert.equal(kfMissingLast.status, 400);

    const kfOk = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-kf2v-plus', prompt: 'bunga mekar', image_url: 'https://cdn.example/f1.png', image_last_url: 'https://cdn.example/f2.png', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(kfOk.status, 200);
    assert.equal(mock.submits[1].url, `${BASE_CN}/api/v1/services/aigc/image2video/video-synthesis`);
    assert.equal(mock.submits[1].body.model, 'wanx2.1-kf2v-plus');
    assert.deepEqual(mock.submits[1].body.input, { prompt: 'bunga mekar', first_frame_url: 'https://cdn.example/f1.png', last_frame_url: 'https://cdn.example/f2.png' });

    // 3. Wan Animate (image2video/video-synthesis + mode wan-std/wan-pro)
    const aniOk = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.2-animate-move', image_url: 'https://cdn.example/char.png', video_url: 'https://cdn.example/dance.mp4', resolution: '1080p' },
    }), createEnv());
    assert.equal(aniOk.status, 200);
    assert.equal(mock.submits[2].url, `${BASE_CN}/api/v1/services/aigc/image2video/video-synthesis`);
    assert.deepEqual(mock.submits[2].body.input, { image_url: 'https://cdn.example/char.png', video_url: 'https://cdn.example/dance.mp4', watermark: false });
    assert.deepEqual(mock.submits[2].body.parameters, { mode: 'wan-pro' });

    // 4. Wan VACE (image_reference & video_repainting)
    const vaceImg = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-vace-plus', prompt: 'boneka panda berjalan', reference_images: ['https://cdn.example/panda.png'], resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(vaceImg.status, 200);
    assert.equal(mock.submits[3].body.model, 'wanx2.1-vace-plus');
    assert.deepEqual(mock.submits[3].body.input, { function: 'image_reference', prompt: 'boneka panda berjalan', ref_images_url: ['https://cdn.example/panda.png'] });

    const vaceVid = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-vace-plus', prompt: 'ubah jadi lukisan minyak', video_url: 'https://cdn.example/clip.mp4', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(vaceVid.status, 200);
    assert.equal(mock.submits[4].body.input.function, 'video_repainting');
    assert.equal(mock.submits[4].body.input.video_url, 'https://cdn.example/clip.mp4');
  } finally {
    mock.restore();
  }
});

test('HappyHorse T2V, I2V, R2V, Video-Edit + redaksi error upstream', async () => {
  const mock = installMock();
  try {
    const t2v = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'happyhorse-1.1-t2v', prompt: 'kereta kardus malam hari', aspect_ratio: '21:9', resolution: '1080p', duration: 10 },
    }), createEnv());
    assert.equal(t2v.status, 200);
    assert.deepEqual(mock.submits[0].body.parameters, { resolution: '1080P', ratio: '21:9', duration: 10, watermark: false });

    const i2v = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'happyhorse-1.1-i2v', prompt: 'kucing berlari', image_url: 'https://cdn.example/cat.png', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(i2v.status, 200);
    assert.deepEqual(mock.submits[1].body.input, { prompt: 'kucing berlari', media: [{ type: 'first_frame', url: 'https://cdn.example/cat.png' }] });
    assert.equal(mock.submits[1].body.parameters.ratio, undefined);

    const r2v = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'happyhorse-1.1-r2v', prompt: 'wanita [Image 1] pegang kipas [Image 2]', reference_images: ['https://cdn.example/1.jpg', 'https://cdn.example/2.jpg'], resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(r2v.status, 200);
    assert.deepEqual(mock.submits[2].body.input.media, [
      { type: 'reference_image', url: 'https://cdn.example/1.jpg' },
      { type: 'reference_image', url: 'https://cdn.example/2.jpg' },
    ]);

    const edit = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'happyhorse-1.0-video-edit', prompt: 'ganti latar pantai', video_url: 'https://cdn.example/in.mp4', reference_images: ['https://cdn.example/bg.jpg'], resolution: '720p', generate_audio: false },
    }), createEnv());
    assert.equal(edit.status, 200);
    assert.deepEqual(mock.submits[3].body.input.media, [
      { type: 'video', url: 'https://cdn.example/in.mp4' },
      { type: 'reference_image', url: 'https://cdn.example/bg.jpg' },
    ]);
    assert.equal(mock.submits[3].body.parameters.audio_setting, 'origin');
  } finally {
    mock.restore();
  }

  // Redaksi URL & token di pesan error video upstream
  const mockErr = installMock({
    upstreamError: {
      status: 400,
      body: { code: 'InvalidParameter', message: 'Invalid image https://secret.oss.aliyuncs.com/path?OSSAccessKeyId=ABCDEFGH1234567890ABCDEFGH1234567890' },
    },
  });
  try {
    const errRes = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'happyhorse-1.1-i2v', prompt: 'tes', image_url: 'https://cdn.example/cat.png' },
    }), createEnv());
    assert.equal(errRes.status, 400);
    const errData = await errRes.json();
    assert.equal(String(errData.error).includes('secret.oss.aliyuncs.com'), false);
    assert.equal(String(errData.error).includes('OSSAccessKeyId'), false);
  } finally {
    mockErr.restore();
  }
});

test('GeneratePage: kontrol media menyesuaikan model Alibaba yang dipilih', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] } });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
  const session = { access_token: 'mock', user: { id: 'u1', email: 'u@example.com', app_metadata: { role: 'user' }, user_metadata: {} } };
  const oldGet = supabase.auth.getSession, oldOn = supabase.auth.onAuthStateChange, oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  globalThis.fetch = async (url) => {
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/video/models') {
      return Response.json({
        ok: true,
        models: [
          { id: 'wan2.6-t2v', name: 'Alibaba: Wan 2.6 T2V', provider: 'alibaba', providerConfigured: true, activeInAdmin: true, aspectRatios: ['16:9', '9:16'], resolutions: ['720p', '1080p'], durations: [5, 10], supportsImage: false, supportsVideo: false, supportsAudioInput: true, supportsAudioOutput: true, supportsAudio: true },
          { id: 'happyhorse-1.1-i2v', name: 'Alibaba: HappyHorse 1.1 I2V', provider: 'alibaba', providerConfigured: true, activeInAdmin: true, aspectRatios: [], resolutions: ['720p', '1080p'], durations: [3, 5, 10], supportsImage: true, supportsVideo: false, supportsAudioInput: false, supportsAudioOutput: true, supportsAudio: true },
          { id: 'wan2.2-animate-move', name: 'Alibaba: Wan 2.2 Animate Move', provider: 'alibaba', providerConfigured: true, activeInAdmin: true, aspectRatios: [], resolutions: ['720p', '1080p'], durations: [5], supportsImage: true, supportsVideo: true, supportsAudioInput: false, supportsAudioOutput: false, supportsAudio: false },
        ],
      });
    }
    if (url === '/api/video/history') return Response.json({ ok: true, generations: [] });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 100 });
    return Response.json({});
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(GeneratePage))),
    ));
    const modelSelect = document.getElementById('gen-model');
    // 1. wan2.6-t2v: tidak ada First Frame input, audio opsional tampil
    assert.equal(document.querySelector('input[aria-label="First Frame"]'), null);
    assert.ok(document.querySelector('input[aria-label="Upload Audio"]'));

    // 2. happyhorse-1.1-i2v: First Frame (Wajib) tampil, Rasio disabled ("Mengikuti media sumber")
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(modelSelect, 'alibaba::happyhorse-1.1-i2v');
      modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.ok(document.querySelector('input[aria-label="First Frame"]'));
    assert.equal(document.getElementById('gen-ratio').disabled, true);

    // 3. wan2.2-animate-move: Gambar Karakter (Wajib) + Video Penggerak (Wajib) + 720P (wan-std)
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(modelSelect, 'alibaba::wan2.2-animate-move');
      modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.ok(document.querySelector('input[aria-label="First Frame"]'));
    assert.ok(document.querySelector('input[aria-label="Upload Video"]'));
    assert.match(document.getElementById('gen-resolution').textContent, /wan-std/);
  } finally {
    await React.act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 25));
    supabase.auth.getSession = oldGet; supabase.auth.onAuthStateChange = oldOn; globalThis.fetch = oldFetch;
    await supabase.auth.dispose();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
