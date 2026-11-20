import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Gerbang status akun (fix39): akun suspended/banned ditolak di SEMUA jalur
// /api/* yang butuh login, kecuali 'account' (supaya UI bisa menampilkan
// alasannya) dan 'admin/users/action' (supaya admin bisa memulihkan status).

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
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Mock Supabase: token -> user id unik (gerbang meng-cache hasil per sidik
// token selama 30 detik, jadi tiap kasus memakai token berbeda), dan status
// akun dibaca dari tabel profiles.
function installMock({ status = 'active', statusMode = 'ok' } = {}) {
  const seen = { profiles: 0, providerKeys: 0, freebeat: 0, upstream: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      const bearer = (init?.headers?.authorization || '').replace('Bearer ', '');
      return Response.json({ id: `uid-${bearer}`, email: `${bearer}@example.com`, app_metadata: { role: bearer.startsWith('admin') ? 'admin' : 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) {
      seen.profiles += 1;
      if (statusMode === 'http-error') return new Response('SECRET-DB-BODY', { status: 503 });
      if (statusMode === 'throw') throw new Error('SECRET-DB-TIMEOUT');
      if (statusMode === 'bad-json') return new Response('bukan json', { status: 200, headers: { 'content-type': 'text/plain' } });
      return Response.json(status ? [{ id: 'x', status }] : []);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      seen.providerKeys += 1;
      return Response.json([]);
    }
    if (url.startsWith('https://freebeat.ai/')) {
      seen.freebeat += 1;
      throw new Error(`Gerbang seharusnya menahan sebelum Freebeat dipanggil: ${url}`);
    }
    seen.upstream += 1;
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { seen, restore() { globalThis.fetch = realFetch; } };
}

test('akun suspended ditolak di /api/chat sebelum API key provider disentuh', async () => {
  const mock = installMock({ status: 'suspended' });
  try {
    const res = await worker.fetch(apiRequest('/api/chat', { token: 'suspended-chat', body: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', messages: [{ role: 'user', content: 'halo' }] } }), createEnv());
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'account_suspended');
    assert.equal(data.account_status, 'suspended');
    assert.match(data.error, /ditangguhkan/);
    assert.equal(mock.seen.providerKeys, 0, 'API key provider tidak boleh dibaca untuk akun ditangguhkan');
    assert.equal(mock.seen.upstream, 0, 'tidak boleh ada panggilan ke provider');
  } finally {
    mock.restore();
  }
});

test('akun banned ditolak di /api/image/generate sebelum sesi Freebeat dibuka', async () => {
  const mock = installMock({ status: 'banned' });
  try {
    const res = await worker.fetch(apiRequest('/api/image/generate', { token: 'banned-image', body: { prompt: 'kucing' } }), createEnv());
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.equal(data.code, 'account_banned');
    assert.match(data.error, /diblokir/);
    assert.equal(mock.seen.freebeat, 0);
  } finally {
    mock.restore();
  }
});

test('akun active lolos gerbang dan dilayani seperti biasa', async () => {
  const mock = installMock({ status: 'active' });
  try {
    const res = await worker.fetch(apiRequest('/api/chat', { token: 'active-chat', body: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', messages: [{ role: 'user', content: 'halo' }] } }), createEnv());
    assert.notEqual(res.status, 403);
    const data = await res.json().catch(() => ({}));
    assert.notEqual(data.code, 'account_suspended');
    assert.equal(mock.seen.providerKeys > 0, true, 'jalur normal tetap membaca konfigurasi provider');
  } finally {
    mock.restore();
  }
});

test('status yang tidak terbaca tidak mengunci user (fail-open, bukan 500)', async () => {
  for (const statusMode of ['http-error', 'throw', 'bad-json']) {
    const mock = installMock({ statusMode });
    try {
      const res = await worker.fetch(apiRequest('/api/chat', { token: `failopen-${statusMode}`, body: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', messages: [{ role: 'user', content: 'halo' }] } }), createEnv());
      assert.notEqual(res.status, 403, `${statusMode}: tidak boleh 403`);
      assert.notEqual(res.status, 500, `${statusMode}: tidak boleh 500`);
    } finally {
      mock.restore();
    }
  }
});

test('/api/account tetap terbaca oleh akun suspended dan menjelaskan alasannya', async () => {
  const mock = installMock({ status: 'suspended' });
  try {
    const res = await worker.fetch(apiRequest('/api/account', { token: 'suspended-account', body: {} }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.blocked, true);
    assert.equal(data.status, 'suspended');
    assert.equal(data.code, 'account_suspended');
    assert.match(data.message, /ditangguhkan/);
    assert.equal(data.role, 'user');
  } finally {
    mock.restore();
  }
});

test('/api/admin/users/action dikecualikan supaya admin bisa memulihkan status', async () => {
  const mock = installMock({ status: 'suspended' });
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { token: 'admin-suspended', body: { action: 'status', target_id: 'uid-lain', status: 'active', password: 'salah' } }), createEnv());
    const data = await res.json().catch(() => ({}));
    assert.notEqual(data.code, 'account_suspended', 'gerbang tidak boleh menutup jalur pemulihan admin');
    assert.notEqual(res.status, 403, 'penolakan harus datang dari pemeriksaan admin itu sendiri, bukan gerbang');
  } finally {
    mock.restore();
  }
});

test('permintaan tanpa token tetap 401 dari handler, bukan 403 dari gerbang', async () => {
  const mock = installMock({ status: 'suspended' });
  try {
    const res = await worker.fetch(apiRequest('/api/chat', { token: '', body: { provider: 'openrouter', messages: [] } }), createEnv());
    assert.equal(res.status, 401);
    assert.equal(mock.seen.profiles, 0, 'tanpa token tidak perlu membaca profiles');
  } finally {
    mock.restore();
  }
});

test('hasil gerbang di-cache per token: permintaan kedua tidak membaca profiles lagi', async () => {
  const mock = installMock({ status: 'suspended' });
  try {
    const first = await worker.fetch(apiRequest('/api/chat', { token: 'cached-token', body: { provider: 'openrouter', messages: [] } }), createEnv());
    const second = await worker.fetch(apiRequest('/api/chat', { token: 'cached-token', body: { provider: 'openrouter', messages: [] } }), createEnv());
    assert.equal(first.status, 403);
    assert.equal(second.status, 403);
    assert.equal(mock.seen.profiles, 1, 'profiles cukup dibaca sekali dalam jendela cache');
  } finally {
    mock.restore();
  }
});
