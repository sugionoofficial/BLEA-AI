import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const BASE = 'https://dashscope-intl.aliyuncs.com';

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

function installWorkerMock({
  prices = [{ provider: 'alibaba', model: 'wan3.0-video', modality: 'video', credits: 75, active: true }],
  spendOk = true,
  upstreamSubmitStatus = 200,
  upstreamSubmitBody = { output: { task_id: 'task-vc-1', task_status: 'PENDING' } },
  pollStatus = 'SUCCEEDED',
} = {}) {
  const realFetch = globalThis.fetch;
  const capture = { spends: [], refunds: [], upstreamCalls: 0, patchedRows: [] };
  let storedRow = null;

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com', app_metadata: { role: 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) {
      return Response.json([{ id: 'user-1', status: 'active' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'alibaba', api_key: 'sk-ali-test', base_url: BASE, label: 'Alibaba' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      if (method === 'PATCH') return new Response(null, { status: 204 });
      return Response.json([]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'alibaba', model: 'wan3.0-video', type: 'video', meta: {} },
        { provider: 'alibaba', model: 'wan2.2-i2v-plus', type: 'video', meta: {} },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) {
      const parsed = new URL(url);
      const provMatch = parsed.searchParams.get('provider')?.replace(/^eq\./, '');
      const modelMatch = parsed.searchParams.get('model')?.replace(/^eq\./, '');
      const filtered = prices.filter((p) => {
        if (provMatch && p.provider !== provMatch) return false;
        if (modelMatch && p.model !== modelMatch) return false;
        return true;
      });
      return Response.json(filtered);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) {
      capture.spends.push(jsonBody());
      return Response.json(spendOk);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) {
      capture.refunds.push(jsonBody());
      return Response.json(true);
    }
    if (url.startsWith(`${BASE}/api/v1/services/aigc/`) && method === 'POST') {
      capture.upstreamCalls += 1;
      return Response.json(upstreamSubmitBody, { status: upstreamSubmitStatus });
    }
    if (url === `${BASE}/api/v1/tasks/task-vc-1` && method === 'GET') {
      if (pollStatus === 'FAILED') {
        return Response.json({ output: { task_id: 'task-vc-1', task_status: 'FAILED', message: 'Upstream render crashed' } });
      }
      return Response.json({ output: { task_id: 'task-vc-1', task_status: 'SUCCEEDED', video_url: 'https://cdn-example.oss-ap-southeast-1.aliyuncs.com/out.mp4' } });
    }
    if (url === 'https://supabase.example/rest/v1/video_generations' && method === 'POST') {
      const p = jsonBody();
      storedRow = { id: p.id, created_at: '2026-11-25T00:00:00Z', updated_at: '2026-11-25T00:00:00Z', ...p };
      return Response.json([storedRow]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?select=') && method === 'GET') {
      return Response.json(storedRow ? [storedRow] : []);
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?') && method === 'PATCH') {
      const patch = jsonBody();
      capture.patchedRows.push({ url, patch });
      if (url.includes('credits_refunded=eq.0')) {
        if (!storedRow || storedRow.credits_refunded !== 0) return Response.json([]);
      }
      storedRow = { ...(storedRow || {}), ...patch };
      return Response.json([storedRow]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  return {
    capture,
    getRow: () => storedRow,
    restore() { globalThis.fetch = realFetch; },
  };
}

test('/api/video/models memperkaya model dengan tarif kredit video aktif', async () => {
  const mock = installWorkerMock({
    prices: [{ provider: 'alibaba', model: 'wan3.0-video', modality: 'video', credits: 75, active: true }],
  });
  try {
    const res = await worker.fetch(apiRequest('/api/video/models', { method: 'GET' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    const wan3 = data.models.find((m) => m.id === 'wan3.0-video');
    const wan22 = data.models.find((m) => m.id === 'wan2.2-i2v-plus');
    assert.equal(wan3.credits, 75);
    assert.equal(wan3.priced, true);
    assert.equal(wan3.priceLabel, '75 kredit');
    assert.equal(wan22.credits, null);
    assert.equal(wan22.priced, false);
    assert.equal(wan22.priceLabel, 'Tarif belum diatur');
  } finally {
    mock.restore();
  }
});

test('/api/video/generate menolak 409 jika model belum punya tarif kredit tanpa memanggil spend_credits atau upstream', async () => {
  const mock = installWorkerMock({ prices: [] });
  try {
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'Pemandangan kota malam', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /belum diatur admin/i);
    assert.equal(mock.capture.spends.length, 0);
    assert.equal(mock.capture.upstreamCalls, 0);
  } finally {
    mock.restore();
  }
});

test('/api/video/generate menolak 402 jika saldo kredit tidak cukup tanpa memanggil upstream', async () => {
  const mock = installWorkerMock({ spendOk: false });
  try {
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'Pemandangan kota malam', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(res.status, 402);
    const data = await res.json();
    assert.match(data.error, /tidak cukup/i);
    assert.equal(mock.capture.spends.length, 1);
    assert.equal(mock.capture.spends[0].p_amount, 75);
    assert.equal(mock.capture.upstreamCalls, 0);
  } finally {
    mock.restore();
  }
});

test('/api/video/generate mengembalikan kredit otomatis saat upstream gagal (HTTP 400)', async () => {
  const mock = installWorkerMock({
    upstreamSubmitStatus: 400,
    upstreamSubmitBody: { code: 'InvalidParameter', message: 'Bad request' },
  });
  try {
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'Pemandangan kota malam', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /Kredit BLEA dikembalikan/);
    assert.equal(mock.capture.spends.length, 1);
    assert.equal(mock.capture.refunds.length, 1);
    assert.equal(mock.capture.refunds[0].p_amount, 75);
    assert.equal(mock.capture.refunds[0].p_generation_id, mock.capture.spends[0].p_generation_id);
  } finally {
    mock.restore();
  }
});

test('/api/video/status melakukan refund sekali secara atomik saat job berubah menjadi failed', async () => {
  const mock = installWorkerMock({ pollStatus: 'FAILED' });
  try {
    const genRes = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'Pemandangan kota malam', resolution: '720p', duration: 5 },
    }), createEnv());
    assert.equal(genRes.status, 200);
    const genData = await genRes.json();
    assert.equal(genData.credits, 75);
    assert.equal(genData.generation.credits_charged, 75);
    assert.equal(genData.generation.credits_refunded, 0);

    const id = genData.generation.id;
    const poll1 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(id)}`, { method: 'GET' }), createEnv());
    assert.equal(poll1.status, 200);
    const p1Data = await poll1.json();
    assert.equal(p1Data.generation.status, 'failed');
    assert.equal(p1Data.generation.credits_refunded, 75);
    assert.equal(mock.capture.refunds.length, 1);
    assert.equal(mock.capture.refunds[0].p_amount, 75);

    const poll2 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(id)}`, { method: 'GET' }), createEnv());
    assert.equal(poll2.status, 200);
    assert.equal(mock.capture.refunds.length, 1);
  } finally {
    mock.restore();
  }
});

test('CreditsPage tidak lagi menampilkan Admin · Harga generasi; AdminPage Katalog Model menangani semua provider, kredit per model, massal & ON/OFF per kategori; GeneratePage enforce saldo', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://app.example/admin?tab=api-keys&sub=catalog' });
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const prevFetch = globalThis.fetch;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });

  const savedPayloads = [];
  const savedModelToggles = [];
  let pricesList = [
    { id: 'price-fb-1', provider: 'freebeat', model: '122', modality: 'image', credits: 15, active: true },
  ];

  const adminSession = {
    access_token: 'admin-jwt',
    user: { id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' }, user_metadata: {} },
  };
  let activeSession = adminSession;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { CreditsPage } = await vite.ssrLoadModule('/src/auth/CreditsPage.jsx');
  const { AdminPage } = await vite.ssrLoadModule('/src/auth/AdminPage.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  supabase.auth.getSession = async () => ({ data: { session: activeSession } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/admin-models') {
      return Response.json({
        models: [
          { id: 'wan2.2-i2v-plus', active: true, provider: 'alibaba' },
          { id: 'sora-2', active: true, provider: 'openai' },
        ],
        providers: [
          { provider: 'alibaba', label: 'Alibaba Model Studio', sources: ['api_key'] },
          { provider: 'cloudflare', label: 'Cloudflare Workers AI', sources: ['api_key'] },
          { provider: 'openai', label: 'OpenAI', sources: ['api_key'] },
          { provider: 'kling', label: 'Kling', sources: ['key_pool'] },
          { provider: 'freebeat', label: 'Freebeat (OAuth)', sources: ['oauth'] },
        ],
      });
    }
    if (url === '/api/catalog') {
      const reqBody = JSON.parse(init.body || '{}');
      if (reqBody.provider === 'openai') {
        return Response.json({
          models: [
            { id: 'sora-2', name: 'OpenAI Sora 2', provider: 'openai', category: 'Video', tags: ['Video'], isFree: false, online: true, priceLabel: 'Berbayar' },
            { id: 'sora-2-pro', name: 'OpenAI Sora 2 Pro', provider: 'openai', category: 'Video', tags: ['Video'], isFree: false, online: true, priceLabel: 'Berbayar' },
            { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'openai', category: 'Text', tags: ['Text'], isFree: false, online: true, priceLabel: 'API' },
          ],
        });
      }
      return Response.json({
        models: [
          { id: 'wan3.0-video', name: 'Wan 3.0 Video', provider: 'alibaba', category: 'Video', tags: ['Video'], isFree: false, online: true, priceLabel: 'Free Quota' },
          { id: 'wan2.7-image', name: 'Wan 2.7 Image', provider: 'alibaba', category: 'Image', tags: ['Image'], isFree: true, online: true, priceLabel: 'Free Quota' },
          { id: 'qwen-plus', name: 'Qwen Plus', provider: 'alibaba', category: 'Text', tags: ['Text'], isFree: true, online: true, priceLabel: 'Free Quota' },
        ],
      });
    }
    if (url === '/api/save-models') {
      const reqBody = JSON.parse(init.body || '{}');
      savedModelToggles.push(reqBody);
      return Response.json({ ok: true, activeCount: Array.isArray(reqBody.models) ? reqBody.models.length : 0 });
    }
    if (url === '/api/video/models') {
      return Response.json({
        ok: true,
        models: [
          {
            provider: 'alibaba',
            providerLabel: 'Alibaba Model Studio',
            id: 'wan3.0-video',
            name: 'Wan 3.0 Video',
            providerConfigured: true,
            activeInAdmin: true,
            credits: 120,
            priced: true,
            priceLabel: '120 kredit',
            aspectRatios: ['16:9'],
            resolutions: ['720p'],
            durations: [5],
            defaultDuration: 5,
          },
        ],
        providers: [{ id: 'alibaba', label: 'Alibaba Model Studio', configured: true }],
      });
    }
    if (url === '/api/video/history') return Response.json({ ok: true, generations: [], hasMore: false });
    if (url.includes('/rest/v1/profiles')) return Response.json([]);
    if (url.includes('/rest/v1/video_generations')) return Response.json([]);
    if (url.includes('/rest/v1/ai_conversations')) return Response.json([]);
    if (url.includes('/rest/v1/waitlist_signups')) return Response.json([]);
    if (url.includes('/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'alibaba', label: 'Alibaba Model Studio', api_key: 'sk-ali', base_url: 'https://dashscope.aliyuncs.com' },
        { provider: 'cloudflare', label: 'Cloudflare Workers AI', api_key: 'binding:AI', base_url: '' },
      ]);
    }
    if (url.includes('/rest/v1/credit_packages')) return Response.json([]);
    if (url.includes('/rest/v1/credit_model_prices')) {
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        savedPayloads.push(body);
        const rows = Array.isArray(body) ? body : [body];
        const inserted = rows.map((r, i) => ({ id: `price-new-${savedPayloads.length}-${i}`, ...r }));
        pricesList = [...pricesList, ...inserted];
        return Response.json(inserted);
      }
      if (method === 'DELETE') {
        return Response.json([]);
      }
      return Response.json(pricesList);
    }
    if (url.includes('/rest/v1/credit_payment_settings')) return Response.json(null);
    if (url.includes('/rest/v1/credit_wallets')) {
      const accept = String(init?.headers?.accept || init?.headers?.Accept || '');
      return Response.json(accept.includes('vnd.pgrst.object') ? { balance: 50 } : [{ user_id: 'user-1', balance: 50 }]);
    }
    if (url.includes('/rest/v1/credit_orders')) return Response.json([]);
    if (url.includes('/rest/v1/credit_payment_methods')) return Response.json([]);
    if (url.includes('/api/admin/users')) return Response.json({ admin_ids: [] });
    if (url.includes('/api/admin/freebeat')) return Response.json({ accounts: [] });
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  try {
    // 1. CreditsPage admin test: no Admin · Harga generasi section remains
    const root1 = createRoot(document.getElementById('root'));
    await React.act(async () => root1.render(
      React.createElement(MemoryRouter, { initialEntries: ['/credits'] },
        React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(CreditsPage))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 40)));

    assert.doesNotMatch(document.body.textContent, /Admin · Harga generasi/);
    assert.match(document.body.textContent, /Paket kredit/);
    assert.match(document.body.textContent, /Admin · Kelola paket/);
    await React.act(async () => root1.unmount());

    // 2. AdminPage Katalog Model test: all registered providers, no Model Manual, search, per-model credit edit, bulk credit, bulk category ON/OFF
    const rootAdmin = createRoot(document.getElementById('root'));
    await React.act(async () => rootAdmin.render(
      React.createElement(MemoryRouter, { initialEntries: ['/admin?tab=api-keys&sub=catalog'] },
        React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(AdminPage))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 60)));

    assert.doesNotMatch(document.body.textContent, /Model Manual/);
    const catalogSelect = document.querySelector('select[aria-label="Pilih katalog provider"]');
    assert.ok(catalogSelect, 'Dropdown provider Katalog Model harus ada');
    const catalogProviderValues = Array.from(catalogSelect.options).map((o) => o.value);
    assert.ok(catalogProviderValues.includes('alibaba'));
    assert.ok(catalogProviderValues.includes('cloudflare'));
    assert.ok(catalogProviderValues.includes('openai'), 'Provider selain Alibaba & Cloudflare harus ikut tampil');
    assert.ok(catalogProviderValues.includes('kling'), 'Provider dari key pool harus ikut tampil');
    assert.ok(catalogProviderValues.includes('freebeat'), 'Provider Freebeat OAuth harus ikut tampil');

    const nativeSelectSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    const nativeInputSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;

    // Switch catalog provider to openai
    await React.act(async () => {
      nativeSelectSetter.call(catalogSelect, 'openai');
      catalogSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await React.act(async () => new Promise((r) => setTimeout(r, 40)));

    assert.match(document.body.textContent, /sora-2-pro/);
    assert.match(document.body.textContent, /gpt-4o-mini/);

    // Edit credit directly on sora-2
    const editBtn = document.querySelector('button[aria-label="Edit kredit sora-2"]');
    assert.ok(editBtn);
    await React.act(async () => { editBtn.click(); });

    const inlineCreditInput = document.querySelector('input[aria-label="Biaya kredit sora-2"]');
    assert.ok(inlineCreditInput);
    await React.act(async () => {
      nativeInputSetter.call(inlineCreditInput, '85');
      inlineCreditInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const saveCreditBtn = Array.from(document.querySelectorAll('.admin-model-credit-actions button')).find((b) => b.textContent.includes('Simpan kredit'));
    assert.ok(saveCreditBtn);
    await React.act(async () => { saveCreditBtn.click(); });
    await React.act(async () => new Promise((r) => setTimeout(r, 30)));

    assert.ok(savedPayloads.some((p) => !Array.isArray(p) && p.provider === 'openai' && p.model === 'sora-2' && p.modality === 'video' && p.credits === 85));

    // Filter Video category and run bulk ON for category Video
    const videoChip = Array.from(document.querySelectorAll('.admin-model-chip')).find((b) => b.textContent.startsWith('Video'));
    assert.ok(videoChip);
    await React.act(async () => { videoChip.click(); });

    const bulkOnBtn = Array.from(document.querySelectorAll('.admin-model-bulk-group button')).find((b) => b.textContent.includes('Aktifkan Massal'));
    assert.ok(bulkOnBtn);
    await React.act(async () => { bulkOnBtn.click(); });
    await React.act(async () => new Promise((r) => setTimeout(r, 30)));
    assert.ok(savedModelToggles.some((payload) => payload.provider === 'openai' && payload.models.includes('sora-2') && payload.models.includes('sora-2-pro')));

    // Search for sora-2-pro and apply bulk credit to remaining unpriced filtered models
    const searchInput = document.querySelector('input[aria-label="Cari model di katalog"]');
    assert.ok(searchInput);
    await React.act(async () => {
      nativeInputSetter.call(searchInput, 'sora-2-pro');
      searchInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('.admin-model-row-wrap').length, 1);

    const bulkCreditInput = document.querySelector('input[aria-label="Jumlah kredit massal"]');
    await React.act(async () => {
      nativeInputSetter.call(bulkCreditInput, '140');
      bulkCreditInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const bulkFillBtn = Array.from(document.querySelectorAll('.admin-model-bulk-group button')).find((b) => b.textContent.includes('Isi kredit kosong'));
    assert.ok(bulkFillBtn);
    await React.act(async () => { bulkFillBtn.click(); });
    await React.act(async () => new Promise((r) => setTimeout(r, 30)));
    assert.ok(savedPayloads.some((p) => Array.isArray(p) && p.some((r) => r.provider === 'openai' && r.model === 'sora-2-pro' && r.modality === 'video' && r.credits === 140)));

    await React.act(async () => rootAdmin.unmount());

    // 3. GeneratePage credit display & balance enforcement test
    activeSession = {
      access_token: 'user-jwt',
      user: { id: 'user-1', email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} },
    };
    const root2 = createRoot(document.getElementById('root'));
    await React.act(async () => root2.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
        React.createElement(AuthProvider, { initialSession: activeSession }, React.createElement(GeneratePage))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 40)));

    assert.match(document.body.textContent, /Wan 3\.0 Video/);
    assert.match(document.body.textContent, /120 kredit/);
    assert.doesNotMatch(document.body.textContent, /120 kredit BLEA/);
    assert.doesNotMatch(document.body.textContent, /Saldo: 50 kredit/);
    assert.match(document.body.textContent, /Saldo kredit Anda \(50 kredit\) tidak cukup/);
    assert.doesNotMatch(document.body.textContent, /Alur video lama belum memotong kredit BLEA/);
    assert.equal(document.querySelector('button.generate-submit-btn').disabled, true);
    await React.act(async () => root2.unmount());
  } finally {
    supabase.auth.getSession = oldGet;
    supabase.auth.onAuthStateChange = oldOn;
    await supabase.auth.dispose();
    await vite.close();
    dom.window.close();
    globalThis.fetch = prevFetch;
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.localStorage = prevLocalStorage;
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});
