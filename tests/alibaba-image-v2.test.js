import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Batch kedua model gambar Alibaba (dari konsol free quota pengguna, 20/11/2026):
// qwen-image-2.0(-pro, dated variants), qwen-image-2.1-pro/turbo (wxh 512-2048, n<=6)
// dan wan2.6-t2i (wxh 1280-1440, n<=4). Dok verifikasi:
//  - alibabacloud.com/help/en/model-studio/qwen-image-api (sync/async, n 1-6, size "2048*2048")
//  - qwencloud.com api-reference Wan text-to-image V2 (wan2.6-t2i messages async, 1280*1280 default)
const BASE = 'https://ws-img2.ap-southeast-1.maas.aliyuncs.com';
const POOL = [
  { id: 'pool-q', provider: 'alibaba', label: 'Akun quota', api_key: 'sk-img-quota', base_url: BASE, priority: 10, consecutive_failures: 0, cooldown_until: null },
];
const PRICES = [
  { provider: 'alibaba', model: 'qwen-image-2.0-pro', credits: 100 },
  { provider: 'alibaba', model: 'qwen-image-2.1-turbo', credits: 60 },
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

function installMock(overrides = {}) {
  const realFetch = globalThis.fetch;
  const capture = { submits: [], spends: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com', app_metadata: { role: 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([{ id: 'user-123', status: 'active' }]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      if (method === 'PATCH') return new Response(null, { status: 204 });
      return Response.json(overrides.poolRows ?? POOL);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json(overrides.modelRows ?? ACTIVE_MODELS);
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) return Response.json(overrides.priceRows ?? PRICES);
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) { capture.spends.push(jsonBody()); return Response.json(true); }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) return Response.json(true);
    if (url.startsWith('https://supabase.example/rest/v1/image_generations')) {
      if (method === 'POST') { const p = jsonBody(); return Response.json([{ id: p.id, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', credits_refunded: 0, image_url: null, ...p }]); }
      if (method === 'PATCH') return Response.json([jsonBody()]);
      return Response.json([]);
    }
    if (url === `${BASE}/api/v1/services/aigc/image-generation/generation` && method === 'POST') {
      capture.submits.push({ headers: init.headers || {}, body: jsonBody() });
      return Response.json({ output: { task_id: 'task-v2-1', task_status: 'PENDING' } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { capture, restore() { globalThis.fetch = realFetch; } };
}

test('config: menampilkan qwen-image-2.0-pro, qwen-image-2.1-turbo, wan2.6-t2i dengan sizeMode wxh', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/image/config', { method: 'GET' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    const models = data.models || [];
    const qwen = models.find((m) => m.model === 'qwen-image-2.0-pro');
    assert.ok(qwen);
    assert.equal(qwen.params.sizeMode, 'wxh');
    assert.equal(qwen.params.minSide, 512);
    assert.equal(qwen.params.maxSide, 2048);
    assert.equal(qwen.params.defaultSize, '2048*2048');
    assert.equal(qwen.params.maxN, 6);
    const turbo = models.find((m) => m.model === 'qwen-image-2.1-turbo');
    assert.ok(turbo);
    assert.equal(turbo.credits, 60);
    const wan = models.find((m) => m.model === 'wan2.6-t2i');
    assert.ok(wan);
    assert.equal(wan.params.sizeMode, 'wxh');
    assert.equal(wan.params.minSide, 1280);
    assert.equal(wan.params.maxSide, 1440);
    assert.equal(wan.params.maxN, 4);
  } finally {
    mock.restore();
  }
});

test('generate qwen-image-2.0-pro: ukuran wxh bebas 512-2048 diterima, n=1..6', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'qwen-image-2.0-pro', prompt: 'Poster komik tiga anjing', size: '1536*1024', n: 6 } }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const submitted = mock.capture.submits[0];
    assert.equal(submitted.body.model, 'qwen-image-2.0-pro');
    assert.equal(submitted.body.parameters.size, '1536*1024');
    assert.equal(submitted.body.parameters.n, 6);
    assert.equal(submitted.body.parameters.prompt_extend, true);
    assert.equal(submitted.body.parameters.watermark, false);
  } finally {
    mock.restore();
  }
});

test('generate qwen-image-2.0-pro: ukuran di luar rentang ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'qwen-image-2.0-pro', prompt: 'tes', size: '2560*2560' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate qwen-image-2.0-pro: format ukuran salah ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'qwen-image-2.0-pro', prompt: 'tes', size: '2048x2048' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate wan2.6-t2i: sisi di bawah 1280 ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.6-t2i', prompt: 'toko bunga', size: '1024*1024' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate wan2.6-t2i: n>4 ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.6-t2i', prompt: 'toko bunga', n: 5 } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate wan2.6-t2i: submit sukses dengan default 1280*1280 dan n=4', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.6-t2i', prompt: 'toko bunga dengan pintu kayu', n: 4 } }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const submitted = mock.capture.submits[0];
    assert.equal(submitted.headers['X-DashScope-Async'], 'enable');
    assert.equal(submitted.body.parameters.size, '1280*1280');
    assert.equal(submitted.body.parameters.n, 4);
  } finally {
    mock.restore();
  }
});
