import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// 2026-11-20: regresi adapter video Alibaba.
// - Model non-video (wan2.7-image, gui-plus, qwen-image-3.0) dan ID salah ejaan
//   (wan2.1-kf2iv-plus) tidak boleh tampil di /api/video/models maupun dikirim
//   ke /api/video/generate.
// - happyhorse-1.1-i2v hanya menerima first_frame (`image_url`); permintaan dengan
//   `reference_images` tanpa `image_url` harus ditolak 400 sebelum memanggil Alibaba.

const BASE = 'https://ws-unverified.ap-southeast-1.maas.aliyuncs.com';

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

test('video/models: alibaba hanya menampilkan model dengan adapter terverifikasi', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-123', app_metadata: { role: 'user' } });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: BASE, label: 'Alibaba' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'alibaba', model: 'happyhorse-1.1-i2v', active: true },
        { provider: 'alibaba', model: 'happyhorse-1.1-t2v', active: true },
        { provider: 'alibaba', model: 'wan2.1-kf2iv-plus', active: true },
        { provider: 'alibaba', model: 'wan2.7-image', active: true },
        { provider: 'alibaba', model: 'wan2.7-image-pro', active: true },
        { provider: 'alibaba', model: 'gui-plus', active: true },
        { provider: 'alibaba', model: 'qwen-image-3.0', active: true },
        { provider: 'alibaba', model: 'wan3.0-video', active: true },
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/video/models', { method: 'GET' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    const alibaba = (data.models || []).filter((m) => m.provider === 'alibaba').map((m) => m.id || m.model);
    assert.deepEqual(alibaba, ['happyhorse-1.1-i2v', 'happyhorse-1.1-t2v', 'wan3.0-video']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('video/generate: id belum diverifikasi / salah ejaan (wan2.1-kf2iv-plus, wan2.7-image, gui-plus) ditolak 400 pre-upstream', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-123', app_metadata: { role: 'user' } });
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([{ id: 'user-123', status: 'active' }]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([{ provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: BASE, label: 'Alibaba' }]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    for (const model of ['wan2.1-kf2iv-plus', 'wan2.7-image', 'gui-plus', 'qwen-image-3.0']) {
      const res = await worker.fetch(
        apiRequest('/api/video/generate', {
          body: { provider: 'alibaba', model, prompt: 'uji blokir' },
        }),
        createEnv(),
      );
      assert.equal(res.status, 400, model);
      const data = await res.json();
      assert.match(String(data.error), /belum diverifikasi/);
    }
    assert.equal(calls.some((url) => url.startsWith(BASE)), false, 'provider tidak boleh dipanggil');
    assert.equal(calls.some((url) => url.includes('/video_generations')), false, 'tidak boleh ada baris generasi tercatat');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('video/generate: happyhorse-1.1-i2v dengan reference_images tanpa image_url ditolak 400 pre-upstream', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-123', app_metadata: { role: 'user' } });
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([{ id: 'user-123', status: 'active' }]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([{ provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: BASE, label: 'Alibaba' }]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: {
          provider: 'alibaba',
          model: 'happyhorse-1.1-i2v',
          prompt: 'topledekan video',
          reference_images: ['https://lwknqvgnxgecptkvtkfb.supabase.co/storage/v1/object/public/x/gambar.jpeg'],
        },
      }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(String(data.error), /first_frame/i);
    assert.equal(calls.some((url) => url.startsWith(BASE)), false, 'provider tidak boleh dipanggil');
    assert.equal(calls.some((url) => url.includes('/video_generations')), false, 'tidak boleh ada baris generasi tercatat');
  } finally {
    globalThis.fetch = realFetch;
  }
});
