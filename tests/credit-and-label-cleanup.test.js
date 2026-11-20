import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';
import {
  formatCredits,
  formatProviderBadge,
  formatModelDisplayName,
} from '../src/lib/formatCredits.js';
import {
  PROVIDER_PRESETS,
  ALIBABA_VIDEO_MODEL_SPECS,
  BUILTIN_VIDEO_MODELS,
} from '../src/lib/videoCatalog.js';

test('formatCredits memformat angka ribuan dengan titik dan format badge/nama model bebas duplikasi', () => {
  assert.equal(formatCredits(0), '0');
  assert.equal(formatCredits(15), '15');
  assert.equal(formatCredits(999), '999');
  assert.equal(formatCredits(1000), '1.000');
  assert.equal(formatCredits(3000), '3.000');
  assert.equal(formatCredits(10000), '10.000');
  assert.equal(formatCredits(1250000), '1.250.000');
  assert.equal(formatCredits('3000'), '3.000');
  assert.equal(formatCredits(-1500), '-1.500');

  assert.equal(formatProviderBadge('alibaba', 'Alibaba Wan 3.0'), 'Alibaba');
  assert.equal(formatProviderBadge('freebeat', 'Freebeat Dance'), 'Freebeat');
  assert.equal(formatProviderBadge('openai', 'OpenAI Video'), 'OpenAI');
  assert.equal(formatProviderBadge('google'), 'Google');
  assert.equal(formatProviderBadge('custom_vendor', 'Vendor Khusus'), 'Vendor Khusus');

  assert.equal(formatModelDisplayName('Alibaba: Wan 3.0 Video', 'alibaba', 'Alibaba Wan 3.0'), 'Wan 3.0 Video');
  assert.equal(formatModelDisplayName('Alibaba Wan 3.0 Video', 'alibaba', 'Alibaba'), 'Wan 3.0 Video');
  assert.equal(formatModelDisplayName('Freebeat: model 122', 'freebeat', 'Freebeat'), 'Model 122');
  assert.equal(formatModelDisplayName('Freebeat Music-to-Dance Video (720p)', 'freebeat', 'Freebeat'), 'Music-to-Dance Video (720p)');
  assert.equal(formatModelDisplayName('Google: Gemini Omni 1.2 Flash', 'google'), 'Gemini Omni 1.2 Flash');
  assert.equal(formatModelDisplayName('ByteDance: Seedance 1.5 Pro', 'doubao'), 'Seedance 1.5 Pro');
  assert.equal(formatModelDisplayName('xAI: Grok Video 3', 'xai'), 'Grok Video 3');

  assert.equal(PROVIDER_PRESETS.alibaba.label, 'Alibaba');
  for (const spec of Object.values(ALIBABA_VIDEO_MODEL_SPECS)) {
    assert.doesNotMatch(spec.name, /^Alibaba:/i, `${spec.id} tidak boleh memakai awalan Alibaba:`);
  }
  for (const model of BUILTIN_VIDEO_MODELS) {
    assert.doesNotMatch(model.name, /^(?:Alibaba|Google|ByteDance|xAI):/i, `${model.id} tidak boleh memakai awalan provider`);
  }
});

test('Worker /api/video/models dan /api/image/config mengembalikan nama bersih tanpa awalan provider duplikat', async () => {
  const realFetch = globalThis.fetch;
  const env = {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'u-clean-1', email: 'creator@example.com', app_metadata: { role: 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) {
      return Response.json([{ id: 'u-clean-1', status: 'active' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'alibaba', api_key: 'sk-ali-test', base_url: 'https://dashscope-intl.aliyuncs.com', label: 'Alibaba Wan 3.0' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      return Response.json([]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'alibaba', model: 'wan3.0-video', active: true },
        { provider: 'alibaba', model: 'wan2.7-image', active: true },
        { provider: 'freebeat', model: 'generate_dance_video', active: true },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) {
      return Response.json([
        { provider: 'alibaba', model: 'wan3.0-video', modality: 'video', credits: 3000, active: true },
        { provider: 'alibaba', model: 'wan2.7-image', modality: 'image', credits: 80, active: true },
        { provider: 'freebeat', model: 'generate_dance_video', modality: 'video', credits: 3000, active: true },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/freebeat_image_settings')) {
      return Response.json([{ id: 1, model_id: 122, credits: 15 }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/freebeat_auth_sessions')) {
      return Response.json([{ id: 1, status: 'ready', cookie_header: 'sid=ok' }]);
    }
    return Response.json([]);
  };

  try {
    const reqInit = {
      method: 'GET',
      headers: { origin: 'https://app.example', authorization: 'Bearer user-jwt' },
    };
    const videoRes = await worker.fetch(new Request('https://app.example/api/video/models', reqInit), env);
    assert.equal(videoRes.status, 200);
    const videoData = await videoRes.json();
    const aliVideo = videoData.models.find((m) => m.provider === 'alibaba' && m.id === 'wan3.0-video');
    assert.equal(aliVideo.providerLabel, 'Alibaba');
    assert.equal(aliVideo.name, 'Wan 3.0 Video');
    const fbVideo = videoData.models.find((m) => m.provider === 'freebeat' && m.id === 'generate_dance_video');
    assert.equal(fbVideo.providerLabel, 'Freebeat');
    assert.equal(fbVideo.name, 'Music-to-Dance Video (720p)');

    const imageRes = await worker.fetch(new Request('https://app.example/api/image/config', reqInit), env);
    assert.equal(imageRes.status, 200);
    const imageData = await imageRes.json();
    const fbImg = imageData.models.find((m) => m.provider === 'freebeat');
    assert.equal(fbImg.name, 'Model 122');
    const aliImg = imageData.models.find((m) => m.provider === 'alibaba' && m.model === 'wan2.7-image');
    assert.equal(aliImg.name, 'Wan 2.7 Image');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('UI Generate Video, Generate Image, dan chip kredit pojok kanan atas memformat kredit & menyederhanakan label', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

  const userSession = {
    access_token: 'user-jwt',
    user: { id: 'u1', email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} },
  };
  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  const oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session: userSession } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });

  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input?.url || String(input));
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url.includes('/rest/v1/credit_wallets')) return Response.json({ balance: 10000 });
    if (url === '/api/video/models') {
      return Response.json({
        ok: true,
        models: [
          {
            id: 'wan3.0-video',
            name: 'Alibaba: Wan 3.0 Video',
            provider: 'alibaba',
            providerLabel: 'Alibaba Wan 3.0',
            credits: 3000,
            priced: true,
            providerConfigured: true,
            activeInAdmin: true,
            online: true,
            aspectRatios: ['16:9'],
            resolutions: ['720p'],
            durations: [5],
            supportsRatio: true,
          },
          {
            id: 'generate_dance_video',
            name: 'Freebeat Music-to-Dance Video (720p)',
            provider: 'freebeat',
            providerLabel: 'Freebeat Dance',
            credits: 3000,
            priced: true,
            providerConfigured: true,
            activeInAdmin: true,
            online: true,
            aspectRatios: ['9:16'],
            resolutions: ['720p'],
            durations: [15],
            supportsRatio: true,
            mediaMode: 'music_dance',
            requiresAudio: true,
          },
        ],
      });
    }
    if (url === '/api/video/history') return Response.json({ ok: true, generations: [] });
    if (url === '/api/image/config') {
      return Response.json({
        ok: true,
        model_id: 122,
        credits: 15,
        provider_ready: true,
        models: [
          { provider: 'freebeat', model: '122', name: 'Freebeat: model 122', credits: 15, ready: true, params: null },
          { provider: 'alibaba', model: 'wan2.7-image', name: 'Alibaba: Wan 2.7 Image', credits: 3000, ready: true, params: { sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1 } },
        ],
      });
    }
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    throw new Error(`Unexpected ${url}`);
  };

  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
        React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(GeneratePage))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 40)));

    // 1. Chip saldo pojok kanan atas memakai pemisah ribuan titik
    const chip = document.querySelector('.dropx-credit-chip');
    assert.ok(chip, 'Chip saldo kredit pojok kanan atas tampil');
    assert.equal(chip.querySelector('b')?.textContent, '10.000');
    assert.match(chip.getAttribute('aria-label') || '', /10\.000/);

    // 2. Blok Generate Video tidak mengulang pill kredit atau Saldo di atas dropdown
    const videoCard = document.querySelector('.generate-card');
    assert.ok(videoCard);
    assert.doesNotMatch(videoCard.textContent, /kredit BLEA/);
    assert.doesNotMatch(videoCard.textContent, /Saldo:/);
    assert.doesNotMatch(videoCard.textContent, /Alibaba Wan 3\.0/);
    assert.doesNotMatch(videoCard.textContent, /Alibaba:\s*Wan 3\.0 Video/);
    assert.doesNotMatch(videoCard.textContent, /Freebeat Music-to-Dance/);

    const videoTrigger = videoCard.querySelector('.generate-model-trigger');
    assert.match(videoTrigger.textContent, /Alibaba.*Wan 3\.0 Video.*3\.000 kredit/);

    // Buka popover model video dan cek kedua item rapi (badge + nama tanpa awalan duplikat + harga ribuan titik)
    await React.act(async () => videoTrigger.click());
    const videoOpts = [...document.querySelectorAll('.generate-model-option')];
    assert.equal(videoOpts.length, 2);
    assert.match(videoOpts[0].textContent, /Alibaba.*Wan 3\.0 Video.*3\.000 kredit/);
    assert.match(videoOpts[1].textContent, /Freebeat.*Music-to-Dance Video \(720p\).*3\.000 kredit/);
    await React.act(async () => videoTrigger.click());

    // 3. Beralih ke tab Generate gambar dan cek pembersihan + pemisah ribuan titik
    const imgTab = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Generate gambar'));
    assert.ok(imgTab);
    await React.act(async () => imgTab.click());
    await React.act(async () => new Promise((r) => setTimeout(r, 40)));

    const imgCard = document.querySelector('.generate-card');
    assert.ok(imgCard);
    assert.equal(imgCard.querySelector('.generate-card-sub')?.textContent, 'Dari teks');
    assert.doesNotMatch(imgCard.textContent, /per gambar/);
    assert.doesNotMatch(imgCard.textContent, /Freebeat:\s*model 122/i);
    assert.doesNotMatch(imgCard.textContent, /Alibaba:\s*Wan 2\.7 Image/);
    assert.equal(imgCard.querySelector('button.generate-submit-btn')?.textContent.trim(), 'Buat gambar');

    const imgTrigger = imgCard.querySelector('.generate-model-trigger');
    assert.match(imgTrigger.textContent, /Freebeat.*Model 122.*15 kredit/);
    await React.act(async () => imgTrigger.click());
    const imgOpts = [...document.querySelectorAll('.generate-model-option')];
    assert.equal(imgOpts.length, 2);
    assert.match(imgOpts[0].textContent, /Freebeat.*Model 122.*15 kredit/);
    assert.match(imgOpts[1].textContent, /Alibaba.*Wan 2\.7 Image.*3\.000 kredit/);
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
