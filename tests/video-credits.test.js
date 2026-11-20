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

test('CreditsPage & GeneratePage: pilih semua provider + tarif kredit video manual + penegakan saldo UI', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://app.example/credits' });
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
    if (url.includes('/rest/v1/credit_packages')) return Response.json([]);
    if (url.includes('/rest/v1/credit_model_prices')) {
      if (method === 'POST') {
        const body = JSON.parse(init.body || '{}');
        savedPayloads.push(body);
        const rows = Array.isArray(body) ? body : [body];
        pricesList = [...pricesList, ...rows.map((r, i) => ({ id: `price-new-${i}`, ...r }))];
        return Response.json(pricesList);
      }
      return Response.json(pricesList);
    }
    if (url.includes('/rest/v1/credit_payment_settings')) return Response.json(null);
    if (url.includes('/rest/v1/credit_wallets')) return Response.json({ balance: 50 });
    if (url.includes('/rest/v1/credit_orders')) return Response.json([]);
    if (url.includes('/rest/v1/profiles')) return Response.json([]);
    if (url.includes('/rest/v1/credit_payment_methods')) return Response.json([]);
    if (url.includes('/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'alibaba', model: 'wan2.2-i2v-plus' },
        { provider: 'openai', model: 'sora-2' },
      ]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };

  try {
    // 1. CreditsPage admin test
    const root1 = createRoot(document.getElementById('root'));
    await React.act(async () => root1.render(
      React.createElement(MemoryRouter, { initialEntries: ['/credits'] },
        React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(CreditsPage))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 40)));

    const providerSelect = document.querySelector('select[aria-label="Provider"]');
    assert.ok(providerSelect, 'Provider harus berupa <select> agar semua provider dapat dipilih');
    const providerValues = Array.from(providerSelect.options).map((o) => o.value);
    assert.ok(providerValues.includes('alibaba'));
    assert.ok(providerValues.includes('freebeat'));
    assert.ok(providerValues.includes('openai'));
    assert.ok(providerValues.includes('kling'));
    assert.ok(providerValues.includes('__custom__'));

    assert.match(document.body.textContent, /2 model video aktif belum punya tarif kredit/);
    const soraChip = Array.from(document.querySelectorAll('.credits-chip-btn')).find((b) => b.textContent.includes('openai / sora-2'));
    assert.ok(soraChip);
    await React.act(async () => {
      soraChip.click();
    });

    assert.equal(document.querySelector('select[aria-label="Provider"]').value, 'openai');
    assert.equal(document.querySelector('select[aria-label="ID model"]').value, 'sora-2');

    const creditInput = Array.from(document.querySelectorAll('form input[type="number"]')).find((el) => el.placeholder === 'mis. 50');
    assert.ok(creditInput);
    const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => {
      nativeSetter.call(creditInput, '85');
      creditInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

    await React.act(async () => {
      creditInput.closest('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await React.act(async () => new Promise((r) => setTimeout(r, 30)));

    assert.equal(savedPayloads.length, 1);
    assert.deepEqual(savedPayloads[0], {
      provider: 'openai',
      model: 'sora-2',
      modality: 'video',
      credits: 85,
      active: true,
    });
    await React.act(async () => root1.unmount());

    // 2. GeneratePage credit display & balance enforcement test
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
