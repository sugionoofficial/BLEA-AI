import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const BASE_INTL = 'https://dashscope-intl.aliyuncs.com';
const BASE_CN = 'https://dashscope.aliyuncs.com';
const PRICES = [
  { provider: 'alibaba', model: 'wan2.5-t2i-preview', credits: 45 },
  { provider: 'alibaba', model: 'wan2.2-t2i-plus', credits: 40 },
  { provider: 'alibaba', model: 'wan2.1-t2i-plus', credits: 35 },
  { provider: 'alibaba', model: 'wan2.6-image', credits: 60 },
  { provider: 'alibaba', model: 'wan2.5-i2i-preview', credits: 55 },
  { provider: 'alibaba', model: 'z-image-turbo', credits: 30 },
  { provider: 'alibaba', model: 'wan2.7-image', credits: 80 },
  { provider: 'alibaba', model: 'wan2.6-t2i', credits: 50 },
];
const ACTIVE_MODELS = PRICES.map(({ provider, model }) => ({ provider, model }));

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

function installMock({ baseUrl = BASE_INTL, pollResponse = null, role = 'user', prices = PRICES, activeModels = ACTIVE_MODELS } = {}) {
  const realFetch = globalThis.fetch;
  const capture = { submits: [], spends: [], statusRow: null };
  let storedRow = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com', app_metadata: { role } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([{ id: 'user-123', status: 'active' }]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      if (method === 'PATCH') return new Response(null, { status: 204 });
      return Response.json([{ id: 'pool-1', provider: 'alibaba', label: 'Akun', api_key: 'sk-test', base_url: baseUrl, priority: 10, consecutive_failures: 0, cooldown_until: null }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_models?provider=eq.freebeat')) return Response.json([{ model: '122' }]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json(activeModels);
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) return Response.json(prices);
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) { capture.spends.push(jsonBody()); return Response.json(true); }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) return Response.json(true);
    if (url.startsWith('https://supabase.example/rest/v1/image_generations')) {
      if (method === 'POST') {
        const p = jsonBody();
        storedRow = { id: p.id, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', credits_refunded: 0, image_url: null, ...p };
        return Response.json([storedRow]);
      }
      if (method === 'PATCH') {
        storedRow = { ...(storedRow || {}), ...jsonBody() };
        return Response.json([storedRow]);
      }
      if (method === 'GET' && storedRow) return Response.json([storedRow]);
      return Response.json([]);
    }
    if (url.startsWith(`${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`) && method === 'POST') {
      capture.submits.push({ url, headers: init.headers || {}, body: jsonBody() });
      return Response.json({
        output: {
          choices: [{
            finish_reason: 'stop',
            message: { role: 'assistant', content: [{ image: 'https://cdn.example/z-sync.png' }] },
          }],
        },
      });
    }
    if (url.startsWith(`${baseUrl}/api/v1/services/aigc/`) && method === 'POST') {
      capture.submits.push({ url, headers: init.headers || {}, body: jsonBody() });
      return Response.json({ output: { task_id: 'task-all-1', task_status: 'PENDING' } });
    }
    if (url === `${baseUrl}/api/v1/tasks/task-all-1` && method === 'GET') {
      return Response.json(pollResponse || { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example/legacy-1.png' }, { url: 'https://cdn.example/legacy-2.png' }] } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { capture, restore() { globalThis.fetch = realFetch; } };
}

test('wan2.5-t2i-preview: pakai endpoint legacy text2image & poll output.results[].url + multi image_urls', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.5-t2i-preview', prompt: 'gunung berkabut pagi', size: '1280*1280', n: 2 },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(mock.capture.submits.length, 1);
    const req = mock.capture.submits[0];
    assert.equal(req.url, `${BASE_INTL}/api/v1/services/aigc/text2image/image-synthesis`);
    assert.equal(req.headers['X-DashScope-Async'], 'enable');
    assert.equal(req.body.model, 'wan2.5-t2i-preview');
    assert.deepEqual(req.body.input, { prompt: 'gunung berkabut pagi' });
    assert.deepEqual(req.body.parameters, { size: '1280*1280', n: 2, prompt_extend: true, watermark: false });

    const statusRes = await worker.fetch(apiRequest('/api/image/status', { body: { id: data.generation.id } }), createEnv());
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.generation.status, 'completed');
    assert.equal(statusData.generation.image_url, 'https://cdn.example/legacy-1.png');
    assert.deepEqual(statusData.generation.image_urls, ['https://cdn.example/legacy-1.png', 'https://cdn.example/legacy-2.png']);
  } finally {
    mock.restore();
  }
});

test('wan2.2-t2i-plus: tolak prompt >500 karakter dan ukuran melebihi 1440*1440', async () => {
  const mock = installMock();
  try {
    const longPrompt = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.2-t2i-plus', prompt: 'a'.repeat(501), size: '1024*1024' },
    }), createEnv());
    assert.equal(longPrompt.status, 400);

    const tooWide = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.2-t2i-plus', prompt: 'kota futuristik', size: '1441*1024' },
    }), createEnv());
    assert.equal(tooWide.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('wan2.1-t2i-plus: pakai wan2.1-t2i-plus di Singapore dan wanx2.1-t2i-plus di cn-beijing', async () => {
  const mockIntl = installMock({ baseUrl: BASE_INTL });
  try {
    const res = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-t2i-plus', prompt: 'taman sakura' },
    }), createEnv());
    assert.equal(res.status, 200);
    assert.equal(mockIntl.capture.submits[0].body.model, 'wan2.1-t2i-plus');
  } finally {
    mockIntl.restore();
  }

  const mockCn = installMock({ baseUrl: BASE_CN });
  try {
    const res = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.1-t2i-plus', prompt: 'taman sakura' },
    }), createEnv());
    assert.equal(res.status, 200);
    assert.equal(mockCn.capture.submits[0].body.model, 'wanx2.1-t2i-plus');
  } finally {
    mockCn.restore();
  }
});

test('z-image-turbo: sync multimodal-generation tanpa X-DashScope-Async, prompt <= 800, n = 1', async () => {
  const mock = installMock();
  try {
    const badN = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'z-image-turbo', prompt: 'kucing', n: 2 },
    }), createEnv());
    assert.equal(badN.status, 400);

    const badPrompt = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'z-image-turbo', prompt: 'x'.repeat(801) },
    }), createEnv());
    assert.equal(badPrompt.status, 400);
    assert.equal(mock.capture.spends.length, 0);

    const res = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'z-image-turbo', prompt: 'kucing minum kopi', size: '1024*1024', n: 1 },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'completed');
    assert.equal(data.generation.status, 'completed');
    assert.equal(data.generation.image_url, 'https://cdn.example/z-sync.png');
    const req = mock.capture.submits[0];
    assert.equal(req.url, `${BASE_INTL}/api/v1/services/aigc/multimodal-generation/generation`);
    assert.equal(req.headers['X-DashScope-Async'], undefined);
    assert.equal(req.body.parameters.prompt_extend, false);
    assert.equal(req.body.parameters.size, '1024*1024');
    assert.deepEqual(req.body.input, { messages: [{ role: 'user', content: [{ text: 'kucing minum kopi' }] }] });
  } finally {
    mock.restore();
  }
});

test('wan2.6-image: tanpa gambar pakai enable_interleave=true & max_images; dengan gambar pakai enable_interleave=false', async () => {
  const mock = installMock();
  try {
    const resInterleave = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.6-image', prompt: 'komik 4 panel tentang robot', size: '1280*1280', n: 4 },
    }), createEnv());
    assert.equal(resInterleave.status, 200);
    const req1 = mock.capture.submits[0];
    assert.equal(req1.url, `${BASE_INTL}/api/v1/services/aigc/image-generation/generation`);
    assert.equal(req1.body.parameters.enable_interleave, true);
    assert.equal(req1.body.parameters.n, 1);
    assert.equal(req1.body.parameters.max_images, 4);

    const resEdit = await worker.fetch(apiRequest('/api/image/generate', {
      body: {
        provider: 'alibaba',
        model: 'wan2.6-image',
        prompt: 'jadikan latar salju',
        size: '2K',
        n: 2,
        images: ['https://cdn.example/src-1.png'],
      },
    }), createEnv());
    assert.equal(resEdit.status, 200);
    const req2 = mock.capture.submits[1];
    assert.equal(req2.body.parameters.enable_interleave, false);
    assert.equal(req2.body.parameters.n, 2);
    assert.equal(req2.body.parameters.prompt_extend, true);
    assert.equal(req2.body.parameters.size, '2K');
    assert.deepEqual(req2.body.input.messages[0].content, [
      { image: 'https://cdn.example/src-1.png' },
      { text: 'jadikan latar salju' },
    ]);
  } finally {
    mock.restore();
  }
});

test('wan2.5-i2i-preview: wajib menyertakan gambar sumber dan kirim ke image2image/image-synthesis', async () => {
  const mock = installMock();
  try {
    const missingImg = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.5-i2i-preview', prompt: 'ubah gaya lukisan' },
    }), createEnv());
    assert.equal(missingImg.status, 400);
    assert.equal(mock.capture.spends.length, 0);

    const textOnlyReject = await worker.fetch(apiRequest('/api/image/generate', {
      body: { provider: 'alibaba', model: 'wan2.6-t2i', prompt: 'tes', images: ['https://cdn.example/src.png'] },
    }), createEnv());
    assert.equal(textOnlyReject.status, 400);
    assert.equal(mock.capture.spends.length, 0);

    const res = await worker.fetch(apiRequest('/api/image/generate', {
      body: {
        provider: 'alibaba',
        model: 'wan2.5-i2i-preview',
        prompt: 'ubah menjadi cat air',
        size: '1280*1280',
        n: 1,
        images: ['https://cdn.example/src-1.png', 'https://cdn.example/src-2.png'],
      },
    }), createEnv());
    assert.equal(res.status, 200);
    const req = mock.capture.submits[0];
    assert.equal(req.url, `${BASE_INTL}/api/v1/services/aigc/image2image/image-synthesis`);
    assert.equal(req.headers['X-DashScope-Async'], 'enable');
    assert.deepEqual(req.body.input, {
      prompt: 'ubah menjadi cat air',
      images: ['https://cdn.example/src-1.png', 'https://cdn.example/src-2.png'],
    });
  } finally {
    mock.restore();
  }
});

test('GenerateImagePanel: input upload hanya muncul saat model memiliki maxInputImages > 0', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] } });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GenerateImagePanel } = await vite.ssrLoadModule('/src/auth/GenerateImagePanel.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
  const session = { access_token: 'mock', user: { id: 'user-1', email: 'u@example.com', app_metadata: { role: 'user' }, user_metadata: {} } };
  const oldGet = supabase.auth.getSession, oldOn = supabase.auth.onAuthStateChange, oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  globalThis.fetch = async (url) => {
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/image/config') {
      return Response.json({
        ok: true,
        model_id: 122,
        credits: 15,
        provider_ready: true,
        models: [
          { provider: 'freebeat', model: '122', name: 'Freebeat: model 122', credits: 15, ready: true, params: null },
          { provider: 'alibaba', model: 'wan2.5-i2i-preview', name: 'Alibaba: Wan 2.5 I2I Preview', credits: 55, ready: true, params: { sizeMode: 'wxh', minProduct: 768 * 768, maxProduct: 1280 * 1280, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 4, maxInputImages: 4, requiresImageInput: true } },
        ],
      });
    }
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 500 });
    throw new Error(`Unexpected ${url}`);
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(GenerateImagePanel))),
    ));
    assert.equal(document.querySelector('input[type=file]'), null);
    const select = document.querySelector('select');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(select, 'alibaba:wan2.5-i2i-preview');
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.ok(document.querySelector('input[type=file]'));
    assert.match(document.body.textContent, /Gambar sumber \(wajib\)/);
  } finally {
    await React.act(async () => root.unmount());
    supabase.auth.getSession = oldGet; supabase.auth.onAuthStateChange = oldOn; globalThis.fetch = oldFetch;
    await supabase.auth.dispose();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('/api/image/config: admin melihat alibaba_unpriced bila model aktif belum punya harga; seluruh 21 model muncul setelah berharga', async () => {
  const { ALIBABA_FREE_QUOTA_MODELS } = await import('../src/lib/alibabaFreeQuota.js');
  const allImageIds = ALIBABA_FREE_QUOTA_MODELS.filter((m) => m.blea === 'image').map((m) => m.id);
  const allActive = allImageIds.map((model) => ({ provider: 'alibaba', model }));

  // 1. Admin tanpa harga kredit untuk Alibaba: models masih hanya Freebeat, tetapi admin mendapat alibaba_unpriced
  const mockAdminUnpriced = installMock({ role: 'admin', activeModels: allActive, prices: [] });
  try {
    const res = await worker.fetch(apiRequest('/api/image/config', { method: 'GET' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.models.filter((m) => m.provider === 'alibaba').length, 0);
    assert.equal(data.alibaba_unpriced.length, 21);
  } finally {
    mockAdminUnpriced.restore();
  }

  // 2. User biasa tidak mendapat detail alibaba_unpriced
  const mockUserUnpriced = installMock({ role: 'user', activeModels: allActive, prices: [] });
  try {
    const res = await worker.fetch(apiRequest('/api/image/config', { method: 'GET' }), createEnv());
    const data = await res.json();
    assert.equal(data.alibaba_unpriced, undefined);
  } finally {
    mockUserUnpriced.restore();
  }

  // 3. Semua 21 model aktif + berharga -> seluruh 21 muncul alongside Freebeat
  const allPrices = allImageIds.map((model) => ({ provider: 'alibaba', model, credits: 15 }));
  const mockAllPriced = installMock({ role: 'admin', activeModels: allActive, prices: allPrices });
  try {
    const res = await worker.fetch(apiRequest('/api/image/config', { method: 'GET' }), createEnv());
    const data = await res.json();
    assert.equal(data.alibaba_unpriced, undefined);
    assert.equal(data.models.filter((m) => m.provider === 'alibaba').length, 21);
    assert.ok(data.models.some((m) => m.provider === 'freebeat'));
  } finally {
    mockAllPriced.restore();
  }
});

test('GenerateImagePanel: tampilkan pengingat admin saat ada model Alibaba aktif tanpa harga kredit', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] } });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GenerateImagePanel } = await vite.ssrLoadModule('/src/auth/GenerateImagePanel.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
  const session = { access_token: 'mock', user: { id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' }, user_metadata: {} } };
  const oldGet = supabase.auth.getSession, oldOn = supabase.auth.onAuthStateChange, oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  globalThis.fetch = async (url) => {
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'admin' });
    if (url === '/api/image/config') {
      return Response.json({
        ok: true,
        model_id: 122,
        credits: 15,
        provider_ready: true,
        models: [
          { provider: 'freebeat', model: '122', name: 'Freebeat: model 122', credits: 15, ready: true, params: null },
        ],
        alibaba_unpriced: [
          { model: 'wan2.7-image', name: 'Alibaba: Wan 2.7 Image' },
          { model: 'qwen-image-3.0', name: 'Alibaba: Qwen-Image 3.0' },
        ],
      });
    }
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 500 });
    return Response.json({});
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(GenerateImagePanel))),
    ));
    assert.match(document.body.textContent, /2 model gambar Alibaba sudah aktif di Katalog Model tetapi belum punya harga kredit BLEA/);
    assert.ok(document.querySelector('a[href="/admin?tab=api-keys&sub=catalog"]'));
  } finally {
    await React.act(async () => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 25));
    supabase.auth.getSession = oldGet; supabase.auth.onAuthStateChange = oldOn; globalThis.fetch = oldFetch;
    await supabase.auth.dispose();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
