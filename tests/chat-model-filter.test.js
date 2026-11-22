import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Halaman Chat hanya boleh menampilkan model yang benar-benar bisa menjawab.
// Katalog gambar/video (Freebeat numerik, z-image, wan-image, qwen-mt-image) dan
// model yang punya harga non-teks tidak boleh lolos ke /api/enabled-models.

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path) {
  return new Request(`https://app.example${path}`, { method: 'GET', headers: { origin: 'https://app.example' } });
}

function mockBackend({ models, prices }) {
  return async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json(models);
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) return Response.json(prices || []);
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('/api/enabled-models membuang katalog gambar/video Freebeat dan Alibaba dari daftar Chat', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockBackend({
    models: [
      { provider: 'unorouter', model: 'gpt-oss-120b:free', active: true },
      { provider: 'alibaba', model: 'qwen3.8-max', active: true },
      { provider: 'ollama', model: 'huihui_ai/qwen3-abliterated:4b', active: true },
      // Non-chat yang dulu lolos:
      { provider: 'freebeat', model: '122', active: true },
      { provider: 'freebeat', model: '209', active: true },
      { provider: 'alibaba', model: 'z-image-turbo', active: true },
      { provider: 'alibaba', model: 'qwen-mt-image-2.0', active: true },
      { provider: 'alibaba', model: 'wan2.7-image', active: true },
      { provider: 'alibaba', model: 'qwen-image-3.0', active: true },
    ],
    prices: [
      { provider: 'freebeat', model: '122', modality: 'image' },
      { provider: 'alibaba', model: 'z-image-turbo', modality: 'image' },
      { provider: 'alibaba', model: 'qwen-mt-image-2.0', modality: 'image' },
      { provider: 'alibaba', model: 'wan2.7-image', modality: 'image' },
      { provider: 'alibaba', model: 'qwen-image-3.0', modality: 'image' },
    ],
  });
  try {
    const res = await worker.fetch(apiRequest('/api/enabled-models'), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(
      [...data.models].sort(),
      ['gpt-oss-120b:free', 'huihui_ai/qwen3-abliterated:4b', 'qwen3.8-max'].sort(),
    );
    assert.equal(data.modelItems.some((item) => item.provider === 'freebeat'), false);
    assert.ok(data.modelItems.some((item) => item.id === 'huihui_ai/qwen3-abliterated:4b' && item.provider === 'ollama'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/enabled-models membuang model yang punya harga non-teks walau namanya tidak mencurigakan', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockBackend({
    models: [
      { provider: 'custom', model: 'aurora-render-v1', active: true },
      { provider: 'custom', model: 'aurora-chat-v1', active: true },
    ],
    prices: [
      { provider: 'custom', model: 'aurora-render-v1', modality: 'video' },
      // Harga teks/chat tidak mengeluarkan model dari daftar.
      { provider: 'custom', model: 'aurora-chat-v1', modality: 'text' },
    ],
  });
  try {
    const res = await worker.fetch(apiRequest('/api/enabled-models'), createEnv());
    const data = await res.json();
    assert.deepEqual(data.models, ['aurora-chat-v1']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/enabled-models tetap berfungsi bila tabel credit_model_prices tidak dapat dibaca', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'ollama', model: 'huihui_ai/qwen3-abliterated:4b', active: true },
        { provider: 'freebeat', model: '122', active: true },
      ]);
    }
    throw new Error(`DB down: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/enabled-models'), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    // Filter berbasis nama/provider tetap jalan tanpa data harga.
    assert.deepEqual(data.models, ['huihui_ai/qwen3-abliterated:4b']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/enabled-models memakai metadata katalog Alibaba: hanya blea "chat" yang tampil', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockBackend({
    models: [
      { provider: 'alibaba', model: 'qwen3.8-max', active: true },          // blea: chat
      { provider: 'alibaba', model: 'qwen3-livetranslate-flash', active: true }, // blea: chat
      { provider: 'alibaba', model: 'gui-plus', active: true },             // blea: null
      { provider: 'alibaba', model: 'qwen3-vl-plus', active: true },        // blea: null
      { provider: 'alibaba', model: 'model-baru-tanpa-metadata', active: true },
    ],
    prices: [],
  });
  try {
    const res = await worker.fetch(apiRequest('/api/enabled-models'), createEnv());
    const data = await res.json();
    assert.deepEqual(
      [...data.models].sort(),
      ['model-baru-tanpa-metadata', 'qwen3-livetranslate-flash', 'qwen3.8-max'].sort(),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
