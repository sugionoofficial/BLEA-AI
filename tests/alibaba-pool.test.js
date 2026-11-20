import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Multi-akun Alibaba Cloud (provider_key_pool): failover otomatis saat video
// / chat memakai provider alibaba dan akun pertama gagal kuota/auth.
const BASE1 = 'https://ws-one.ap-southeast-1.maas.aliyuncs.com';
const BASE2 = 'https://ws-two.ap-southeast-1.maas.aliyuncs.com';
const POOL = [
  { id: 'pool-1', provider: 'alibaba', label: 'Akun 1', api_key: 'sk-one-test', base_url: BASE1, priority: 10, consecutive_failures: 0, cooldown_until: null },
  { id: 'pool-2', provider: 'alibaba', label: 'Akun 2', api_key: 'sk-two-test', base_url: BASE2, priority: 20, consecutive_failures: 0, cooldown_until: null },
];

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

function installMock({ poolRows = POOL, singleAl = [], capture = [], chatBehavior } = {}) {
  const realFetch = globalThis.fetch;
  let storedRow = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com', app_metadata: { role: 'admin' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) {
      return Response.json([{ id: 'user-123', status: 'active' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      if (method === 'PATCH') {
        const id = (new URL(url).searchParams.get('id') || '').replace(/^eq\./, '');
        capture.push({ type: 'pool-patch', id, body: JSON.parse(init.body || '{}') });
        return new Response(null, { status: 204 });
      }
      return Response.json(poolRows);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json(singleAl);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([{ provider: 'alibaba', model: 'qwen3.8-max' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages') && method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      return Response.json([{ id: 'msg-1', ...payload }]);
    }
    if (url === `${BASE1}/api/v1/services/aigc/video-generation/video-synthesis` && method === 'POST') {
      capture.push({ type: 'video-submit', base: 'one', headers: init.headers || {} });
      if (chatBehavior?.videoFirst429 !== false) {
        return new Response(JSON.stringify({ code: 'Throttling.QuotaExhausted', message: 'Free quota exhausted for this model' }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      return Response.json({ output: { task_id: 'task-one', task_status: 'PENDING' } });
    }
    if (url === `${BASE2}/api/v1/services/aigc/video-generation/video-synthesis` && method === 'POST') {
      capture.push({ type: 'video-submit', base: 'two', headers: init.headers || {} });
      return Response.json({ output: { task_id: 'task-two', task_status: 'PENDING' } });
    }
    if (url === `${BASE1}/compatible-mode/v1/chat/completions` && method === 'POST') {
      capture.push({ type: 'chat', base: 'one' });
      return new Response(JSON.stringify({ error: { message: 'Invalid API-key provided.', code: 'InvalidApiKey' } }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    if (url === `${BASE2}/compatible-mode/v1/chat/completions` && method === 'POST') {
      capture.push({ type: 'chat', base: 'two' });
      return Response.json({ choices: [{ message: { content: 'Halo dari akun Alibaba kedua!' } }] });
    }
    if (url === 'https://supabase.example/rest/v1/video_generations' && method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      storedRow = { id: 'gen-pool-1', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', ...payload };
      capture.push({ type: 'video-insert', body: payload });
      return Response.json([storedRow]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?select=')) {
      return Response.json(storedRow ? [storedRow] : []);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { restore() { globalThis.fetch = realFetch; } };
}

test('video: akun pertama 429 kuota habis → otomatis lanjut akun kedua', async () => {
  const capture = [];
  const mock = installMock({ capture });
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'Seekor rubah di hutan kabut', aspect_ratio: '16:9', resolution: '720p', duration: 5 },
      }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.generation.external_job_id, 'task-two');
    // provider_key_id disimpan di baris (sisi server), bukan di payload client.
    const inserted = capture.find((c) => c.type === 'video-insert');
    assert.equal(inserted?.body?.provider_key_id, 'pool-2');

    const submits = capture.filter((c) => c.type === 'video-submit');
    assert.equal(submits.length, 2);
    assert.equal(submits[0].headers.authorization, 'Bearer sk-one-test');
    assert.equal(submits[1].headers.authorization, 'Bearer sk-two-test');

    const patches = capture.filter((c) => c.type === 'pool-patch');
    const failedPatch = patches.find((p) => p.id.startsWith('pool-1'));
    assert.ok(failedPatch, 'pool-1 harus ditandai gagal/cooldown');
    assert.ok(failedPatch.body.consecutive_failures >= 1);
    assert.ok(failedPatch.body.cooldown_until, 'cooldown_until harus terisi');
    const okPatch = patches.find((p) => p.id.startsWith('pool-2'));
    assert.equal(okPatch?.body.consecutive_failures, 0);
  } finally {
    mock.restore();
  }
});

test('video: semua akun Alibaba 429 → 429 dengan pesan jelas, tanpa generasi tercatat', async () => {
  const capture = [];
  const realFetch = globalThis.fetch;
  const mock = installMock({ capture });
  // Akun kedua juga kena kuota: timpa handler untuk pool-2.
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (url === `${BASE2}/api/v1/services/aigc/video-generation/video-synthesis` && method === 'POST') {
      capture.push({ type: 'video-submit', base: 'two', headers: init.headers || {} });
      return new Response(JSON.stringify({ code: 'Throttling.QuotaExhausted', message: 'quota exhausted' }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return baseFetch(input, init);
  };
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', { body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'tes' } }),
      createEnv(),
    );
    assert.equal(res.status, 429);
    const data = await res.json();
    assert.match(data.error, /Semua akun Alibaba/);
    assert.equal(capture.filter((c) => c.type === 'video-insert').length, 0);
  } finally {
    globalThis.fetch = realFetch;
    mock.restore();
  }
});

test('chat: akun pertama 401 → otomatis lanjut akun kedua via compatible-mode', async () => {
  const capture = [];
  const mock = installMock({ capture });
  try {
    const res = await worker.fetch(
      apiRequest('/api/chat', {
        body: {
          conversationId: 'conv-alibaba-1',
          provider: 'alibaba',
          model: 'qwen3.8-max',
          messages: [{ role: 'user', content: 'Halo' }],
        },
      }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.reply, 'Halo dari akun Alibaba kedua!');
    const chats = capture.filter((c) => c.type === 'chat');
    assert.deepEqual(chats.map((c) => c.base), ['one', 'two']);
    const failedPatch = capture.find((c) => c.type === 'pool-patch' && c.id.startsWith('pool-1'));
    assert.ok(failedPatch, 'pool-1 ditandai gagal');
  } finally {
    mock.restore();
  }
});

test('catalog provider alibaba: Wan bawaan + model free quota per kategori', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('upstream tidak boleh dipanggil'); };
  try {
    const res = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'alibaba' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    const ids = data.models.map((m) => m.id);
    assert.ok(ids.includes('wan3.0-video'));
    assert.ok(ids.includes('qwen3.8-max'));
    assert.ok(ids.includes('qwen-image-3.0-pro'));
    assert.ok(ids.includes('qwen3-tts-flash'));
    const text = data.models.find((m) => m.id === 'qwen3.8-max');
    assert.equal(text.category, 'Text');
    assert.equal(text.priceLabel, 'Free Quota');
    assert.equal(text.isFree, true);
    const image = data.models.find((m) => m.id === 'qwen-image-3.0-pro');
    assert.equal(image.category, 'Image');
  } finally {
    globalThis.fetch = realFetch;
  }
});
