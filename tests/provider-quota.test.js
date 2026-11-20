import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// /api/provider-quota: khusus admin; mengambil sisa kuota/saldo API key
// provider via endpoint resminya (tidak pernah membocorkan key).
const ADMIN_ID = '10000000-0000-4000-8000-0000000000q1';
const USER_ID = '10000000-0000-4000-8000-0000000000q2';
const BASE = 'https://ws-test.ap-southeast-1.maas.aliyuncs.com';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(body, token = 'admin-token') {
  return new Request('https://app.example/api/provider-quota', {
    method: 'POST',
    headers: { origin: 'https://app.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installMock({ keyRow, upstream } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (url === 'https://supabase.example/auth/v1/user') {
      const bearer = (init?.headers?.authorization || '').replace('Bearer ', '');
      const admin = bearer === 'admin-token';
      return Response.json({ id: admin ? ADMIN_ID : USER_ID, email: admin ? 'admin@example.com' : 'user@example.com', app_metadata: { role: admin ? 'admin' : 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json(keyRow ? [keyRow] : []);
    }
    if (upstream && url.startsWith(upstream.urlPrefix)) return upstream.respond();
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { restore() { globalThis.fetch = realFetch; } };
}

test('non-admin ditolak 403', async () => {
  const mock = installMock({ keyRow: null });
  try {
    const res = await worker.fetch(apiRequest({ provider: 'openrouter' }, 'user-token'), createEnv());
    assert.equal(res.status, 403);
  } finally { mock.restore(); }
});

test('provider tanpa API key tersimpan dilaporkan apa adanya', async () => {
  const mock = installMock({ keyRow: null });
  try {
    const res = await worker.fetch(apiRequest({ provider: 'openrouter' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.available, false);
    assert.match(data.error, /Belum ada API key/);
  } finally { mock.restore(); }
});

test('openrouter: limit & pemakaian dipetakan dari /api/v1/key', async () => {
  const mock = installMock({
    keyRow: { provider: 'openrouter', api_key: 'sk-or-test', base_url: 'https://openrouter.ai/api/v1', label: 'OR' },
    upstream: {
      urlPrefix: 'https://openrouter.ai/api/v1/key',
      respond: () => Response.json({ data: { label: 'sk-or-v1-abc', limit: 10, limit_remaining: 6.42, limit_reset: 'monthly', usage: 3.58, usage_daily: 0.12, usage_weekly: 0.87, usage_monthly: 3.58, is_free_tier: true, free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } }),
    },
  });
  try {
    const res = await worker.fetch(apiRequest({ provider: 'openrouter' }), createEnv());
    const data = await res.json();
    assert.equal(data.supported, true);
    assert.equal(data.limit, 10);
    assert.equal(data.limitRemaining, 6.42);
    assert.equal(data.limitReset, 'monthly');
    assert.equal(data.usageDaily, 0.12);
    assert.deepEqual(data.freeRequests, { used: 3, limit: 50, remaining: 47 });
  } finally { mock.restore(); }
});

test('unorouter: total_available dipetakan dari /api/usage/token/', async () => {
  const mock = installMock({
    keyRow: { provider: 'unorouter', api_key: 'sk-uno-test', base_url: 'https://api.unorouter.com', label: 'Uno' },
    upstream: {
      urlPrefix: 'https://api.unorouter.com/api/usage/token/',
      respond: () => Response.json({ object: 'token_usage', name: 'SillyTavern', total_granted: 500000, total_used: 231900, total_available: 268100, unlimited_quota: false, expires_at: 0 }),
    },
  });
  try {
    const res = await worker.fetch(apiRequest({ provider: 'unorouter' }), createEnv());
    const data = await res.json();
    assert.equal(data.supported, true);
    assert.equal(data.available, 268100);
    assert.equal(data.granted, 500000);
    assert.equal(data.unlimitedQuota, false);
    assert.equal(data.quotaPerUnit, 500000);
  } finally { mock.restore(); }
});

test('provider tanpa endpoint kuota (alibaba) dilaporkan supported=false + tautan konsol', async () => {
  const mock = installMock({ keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan' } });
  try {
    const res = await worker.fetch(apiRequest({ provider: 'alibaba' }), createEnv());
    const data = await res.json();
    assert.equal(data.supported, false);
    assert.match(data.consoleUrl, /alibabacloud/);
  } finally { mock.restore(); }
});

test('upstream 401 dilaporkan sebagai key ditolak', async () => {
  const mock = installMock({
    keyRow: { provider: 'openrouter', api_key: 'sk-or-test', base_url: 'https://openrouter.ai/api/v1', label: 'OR' },
    upstream: { urlPrefix: 'https://openrouter.ai/api/v1/key', respond: () => new Response('{"error":"unauthorized"}', { status: 401 }) },
  });
  try {
    const res = await worker.fetch(apiRequest({ provider: 'openrouter' }), createEnv());
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.status, 401);
  } finally { mock.restore(); }
});

test('provider tidak dikenal / karakter ilegal ditolak 400', async () => {
  const mock = installMock({ keyRow: null });
  try {
    assert.equal((await worker.fetch(apiRequest({ provider: '../etc' }), createEnv())).status, 400);
    assert.equal((await worker.fetch(apiRequest({}), createEnv())).status, 400);
  } finally { mock.restore(); }
});
