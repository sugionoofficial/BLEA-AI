import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Alur gambar Alibaba (Model Studio ap-southeast-1, async image-generation API):
// config menampilkan model yang aktif & berharga → submit async task dengan
// X-DashScope-Async → poll GET {base}/api/v1/tasks/{task_id}. Semua jaringan
// di-mock; tidak ada kredit sungguhan.
const BASE = 'https://ws-img.ap-southeast-1.maas.aliyuncs.com';
const BASE2 = 'https://ws-img-2.ap-southeast-1.maas.aliyuncs.com';
const POOL = [
  { id: 'pool-a', provider: 'alibaba', label: 'Akun gambar 1', api_key: 'sk-img-one', base_url: BASE, priority: 10, consecutive_failures: 0, cooldown_until: null },
  { id: 'pool-b', provider: 'alibaba', label: 'Akun gambar 2', api_key: 'sk-img-two', base_url: BASE2, priority: 20, consecutive_failures: 0, cooldown_until: null },
];
const PRICES = [
  { provider: 'alibaba', model: 'wan2.7-image', credits: 80 },
  { provider: 'alibaba', model: 'qwen-image-3.0', credits: 122 },
];
const ACTIVE_MODELS = [
  { provider: 'alibaba', model: 'wan2.7-image' },
  { provider: 'alibaba', model: 'qwen-image-3.0' },
];

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path, { method = 'POST', body, token = 'user-jwt', headers = {} } = {}) {
  return new Request(`https://app.example${path}`, {
    method,
    headers: {
      origin: 'https://app.example',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// Mock dasar: akun aktif, pool dua akun, katalog & harga lengkap.
// Override via handlers: { onSpend, onSubmit, onPoll, onRefund, onInsert, poolRows, priceRows, modelRows, profilesStatus }
function installMock(overrides = {}) {
  const realFetch = globalThis.fetch;
  const capture = { submits: [], polls: [], poolPatches: [], refunds: [], spends: [], inserts: [], patches: [] };
  let storedRow = null;
  const poolRows = overrides.poolRows ?? POOL;
  const priceRows = overrides.priceRows ?? PRICES;
  const modelRows = overrides.modelRows ?? ACTIVE_MODELS;
  const profilesStatus = overrides.profilesStatus ?? 'active';

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com', app_metadata: { role: 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) {
      return Response.json([{ id: 'user-123', status: profilesStatus }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      if (method === 'PATCH') {
        const id = decodeURIComponent(new URL(url).searchParams.get('id') || '').replace(/^eq\./, '');
        capture.poolPatches.push({ id, body: jsonBody() });
        return new Response(null, { status: 204 });
      }
      return Response.json(poolRows);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json(overrides.singleKeys ?? []);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json(modelRows);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) {
      return Response.json(priceRows);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) {
      capture.spends.push(jsonBody());
      return Response.json(overrides.onSpend ? await overrides.onSpend(jsonBody()) : true);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) {
      capture.refunds.push(jsonBody());
      return Response.json(overrides.onRefund ? await overrides.onRefund(jsonBody()) : true);
    }
    if (url.startsWith('https://supabase.example/rest/v1/image_generations')) {
      if (method === 'POST') {
        const payload = jsonBody();
        capture.inserts.push(payload);
        storedRow = { id: payload.id, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', image_url: null, credits_refunded: 0, ...payload };
        return Response.json([storedRow]);
      }
      if (method === 'PATCH') {
        capture.patches.push(jsonBody());
        storedRow = { ...(storedRow || {}), ...jsonBody() };
        return Response.json([storedRow]);
      }
      // GET (dipakai rute /image/status untuk membaca baris pengguna)
      return Response.json([storedRow || overrides.storedRow || {}]);
    }
    if (url === `${BASE}/api/v1/services/aigc/image-generation/generation` && method === 'POST') {
      capture.submits.push({ base: 'one', headers: init.headers || {}, body: jsonBody() });
      if (overrides.onSubmit) return overrides.onSubmit('one', init, capture);
      return Response.json({ request_id: 'req-1', output: { task_id: 'task-img-1', task_status: 'PENDING' } });
    }
    if (url === `${BASE2}/api/v1/services/aigc/image-generation/generation` && method === 'POST') {
      capture.submits.push({ base: 'two', headers: init.headers || {}, body: jsonBody() });
      if (overrides.onSubmit) return overrides.onSubmit('two', init, capture);
      return Response.json({ request_id: 'req-2', output: { task_id: 'task-img-2', task_status: 'PENDING' } });
    }
    if (url === `${BASE}/api/v1/tasks/task-img-1` && method === 'GET') {
      capture.polls.push({ base: 'one' });
      return Response.json(overrides.onPoll ? overrides.onPoll('one') : { output: { task_id: 'task-img-1', task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example/hasil-1.png' }] } });
    }
    if (url === `${BASE2}/api/v1/tasks/task-img-2` && method === 'GET') {
      capture.polls.push({ base: 'two' });
      return Response.json(overrides.onPoll ? overrides.onPoll('two') : { output: { task_id: 'task-img-2', task_status: 'SUCCEEDED', results: [{ url: 'https://cdn.example/hasil-2.png' }] } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { capture, restore() { globalThis.fetch = realFetch; } };
}

test('config: menampilkan model Alibaba yang aktif & berharga di samping Freebeat', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/image/config', { method: 'GET' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    const providers = (data.models || []).map((m) => `${m.provider}:${m.model}`);
    assert.ok(providers.includes('freebeat:122') || providers.some((p) => p.startsWith('freebeat:')));
    assert.ok(providers.includes('alibaba:wan2.7-image'));
    assert.ok(providers.includes('alibaba:qwen-image-3.0'));
    const wan = data.models.find((m) => m.model === 'wan2.7-image');
    assert.equal(wan.credits, 80);
    assert.equal(wan.ready, true);
    assert.deepEqual(wan.params.sizes, ['1K', '2K']);
    const qwen = data.models.find((m) => m.model === 'qwen-image-3.0');
    assert.equal(qwen.params.maxN, 6);
  } finally {
    mock.restore();
  }
});

test('config: model tanpa harga kredit disembunyikan dari daftar', async () => {
  const mock = installMock({ priceRows: [PRICES[0]] }); // hanya wan2.7-image berharga
  try {
    const res = await worker.fetch(apiRequest('/api/image/config', { method: 'GET' }), createEnv());
    const data = await res.json();
    const alibaba = (data.models || []).filter((m) => m.provider === 'alibaba').map((m) => m.model);
    assert.deepEqual(alibaba, ['wan2.7-image']);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: submit async task dengan parameter terdokumentasi', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'Seekor rubah merah di hutan kabut saat fajar', size: '2K', n: 1 } }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, 'submitted');
    assert.equal(data.credits, 80);
    assert.equal(data.generation.provider, 'alibaba');
    assert.equal(data.generation.canPoll, true);
    const submitPatch = mock.capture.patches.find((patch) => patch.external_job_id === 'task-img-1');
    assert.ok(submitPatch, 'baris generasi harus menyimpan task_id sebagai external_job_id');

    assert.equal(mock.capture.submits.length, 1);
    const submitted = mock.capture.submits[0];
    assert.equal(submitted.headers['X-DashScope-Async'], 'enable');
    assert.equal(submitted.headers.authorization, 'Bearer sk-img-one');
    assert.equal(submitted.body.model, 'wan2.7-image');
    assert.deepEqual(submitted.body.input.messages[0].content, [{ text: 'Seekor rubah merah di hutan kabut saat fajar' }]);
    assert.equal(submitted.body.parameters.size, '2K');
    assert.equal(submitted.body.parameters.n, 1);
    assert.equal(submitted.body.parameters.watermark, false);

    assert.equal(mock.capture.spends.length, 1);
    assert.equal(mock.capture.spends[0].p_amount, 80);
    assert.equal(mock.capture.inserts[0].provider, 'alibaba');
    assert.equal(mock.capture.inserts[0].credits_charged, 80);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: akun pertama 429 kuota → failover ke akun kedua', async () => {
  const mock = installMock({
    onSubmit: (base) => base === 'one'
      ? new Response(JSON.stringify({ code: 'Throttling.QuotaExhausted', message: 'Free quota exhausted for this model' }), { status: 429, headers: { 'content-type': 'application/json' } })
      : Response.json({ output: { task_id: 'task-img-2', task_status: 'PENDING' } }),
  });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes failover' } }),
      createEnv(),
    );
    const data = await res.json();
    assert.equal(res.status, 200);
    const submitPatch = mock.capture.patches.find((patch) => patch.external_job_id === 'task-img-2');
    assert.ok(submitPatch, 'failover harus menyimpan task_id akun kedua');
    assert.equal(mock.capture.submits.length, 2);
    assert.equal(mock.capture.submits[1].headers.authorization, 'Bearer sk-img-two');
    const failedPatch = mock.capture.poolPatches.find((p) => p.id === 'pool-a');
    assert.ok(failedPatch, 'akun 1 harus ditandai gagal/cooldown');
    assert.ok(failedPatch.body.consecutive_failures >= 1);
    assert.ok(failedPatch.body.cooldown_until);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: kegagalan definitif (400 non-kuota) → tanpa retry, kredit dikembalikan', async () => {
  const mock = installMock({
    onSubmit: () => new Response(JSON.stringify({ code: 'InvalidParameter', message: 'size tidak didukung' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes tolak' } }),
      createEnv(),
    );
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(String(data.error), /Kredit BLEA dikembalikan/);
    assert.equal(mock.capture.submits.length, 1, 'kegagalan definitif tidak boleh diulang ke akun lain');
    assert.equal(mock.capture.refunds.length, 1);
    assert.equal(mock.capture.refunds[0].p_amount, 80);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: spend_credits gagal → 402, provider tidak dipanggil', async () => {
  const mock = installMock({ onSpend: () => false });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes saldo' } }),
      createEnv(),
    );
    assert.equal(res.status, 402);
    assert.equal(mock.capture.submits.length, 0);
    assert.equal(mock.capture.inserts.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: harga belum diatur admin → 409 dan debit tidak dipanggil', async () => {
  const mock = installMock({ priceRows: [] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes tanpa harga' } }),
      createEnv(),
    );
    assert.equal(res.status, 409);
    assert.equal(mock.capture.spends.length, 0);
    assert.equal(mock.capture.submits.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: model belum diaktifkan admin di katalog → 409', async () => {
  const mock = installMock({ modelRows: [] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes katalog' } }),
      createEnv(),
    );
    assert.equal(res.status, 409);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: size di luar daftar model ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes size', size: '4K' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: n melebihi batas model ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes n', n: 3 } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: parameter qwen-image-3.0 n=1..6 diterima', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'qwen-image-3.0', prompt: 'tes qwen', size: '1328*1328', n: 6 } }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const submitted = mock.capture.submits[0];
    assert.equal(submitted.body.parameters.size, '1328*1328');
    assert.equal(submitted.body.parameters.n, 6);
    assert.equal(submitted.body.parameters.prompt_extend, true);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: error provider tidak meneruskan URL/secret mentah', async () => {
  const mock = installMock({
    onSubmit: () => new Response(JSON.stringify({ code: 'InvalidParameter', message: 'lihat https://signed-cdn.example/secret?sig=ABCDEFGHIJKLMNOPQRSTUVWXYZ123 rejected' }), { status: 400, headers: { 'content-type': 'application/json' } }),
  });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes redaksi' } }),
      createEnv(),
    );
    const data = await res.json();
    assert.doesNotMatch(String(data.error), /signed-cdn\.example/);
    assert.doesNotMatch(String(data.error), /sig=ABCDEF/);
  } finally {
    mock.restore();
  }
});

test('status alibaba: poll SUCCEEDED memetakan ke completed dengan image_url', async () => {
  const storedRow = {
    id: 'gen-status-1', user_id: 'user-123', provider: 'alibaba', model: 'wan2.7-image',
    prompt: 'tes status', status: 'processing', external_job_id: 'task-img-1',
    provider_key_id: 'pool-a', credits_charged: 80, credits_refunded: 0,
    created_at: '2026-11-20T00:00:00Z', metadata: {},
  };
  const mock = installMock({ storedRow });
  try {
    const res = await worker.fetch(apiRequest('/api/image/status', { body: { id: 'gen-status-1' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.generation.status, 'completed');
    assert.equal(data.generation.image_url, 'https://cdn.example/hasil-1.png');
    assert.equal(data.generation.provider, 'alibaba');
    assert.equal(mock.capture.polls.length, 1);
    assert.equal(mock.capture.refunds.length, 0);
  } finally {
    mock.restore();
  }
});

test('status alibaba: poll FAILED memicu refund kredit', async () => {
  const storedRow = {
    id: 'gen-status-2', user_id: 'user-123', provider: 'alibaba', model: 'wan2.7-image',
    prompt: 'tes gagal', status: 'processing', external_job_id: 'task-img-1',
    provider_key_id: 'pool-a', credits_charged: 80, credits_refunded: 0,
    created_at: '2026-11-20T00:00:00Z', metadata: {},
  };
  const mock = installMock({
    storedRow,
    onPoll: () => ({ output: { task_id: 'task-img-1', task_status: 'FAILED', message: 'content moderated' } }),
  });
  try {
    const res = await worker.fetch(apiRequest('/api/image/status', { body: { id: 'gen-status-2' } }), createEnv());
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.generation.status, 'failed');
    assert.equal(mock.capture.refunds.length, 1);
    assert.equal(mock.capture.refunds[0].p_amount, 80);
  } finally {
    mock.restore();
  }
});

test('status alibaba: poll PENDING tetap processing tanpa refund', async () => {
  const storedRow = {
    id: 'gen-status-3', user_id: 'user-123', provider: 'alibaba', model: 'wan2.7-image',
    prompt: 'tes antre', status: 'processing', external_job_id: 'task-img-1',
    provider_key_id: 'pool-a', credits_charged: 80, credits_refunded: 0,
    created_at: '2026-11-20T00:00:00Z', metadata: {},
  };
  const mock = installMock({
    storedRow,
    onPoll: () => ({ output: { task_id: 'task-img-1', task_status: 'RUNNING' } }),
  });
  try {
    const res = await worker.fetch(apiRequest('/api/image/status', { body: { id: 'gen-status-3' } }), createEnv());
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.generation.status, 'processing');
    assert.equal(mock.capture.refunds.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: submit timeout jaringan → status unknown, tanpa refund otomatis', async () => {
  const mock = installMock({
    onSubmit: () => { throw new TypeError('fetch failed'); },
  });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes timeout' } }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'unknown');
    assert.equal(mock.capture.refunds.length, 0, 'kegagalan jaringan tidak boleh auto-refund');
  } finally {
    mock.restore();
  }
});

test('generate alibaba: model tidak dikenal ditolak 400 sebelum kredit terpotong', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan-99-ultra', prompt: 'tes model palsu' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(mock.capture.spends.length, 0);
    assert.equal(mock.capture.submits.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate alibaba: akun ditangguhkan ditolak 403 sebelum kredit terpotong', async () => {
  const mock = installMock({ profilesStatus: 'suspended' });
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'alibaba', model: 'wan2.7-image', prompt: 'tes suspend' } }),
      createEnv(),
    );
    assert.equal(res.status, 403);
    assert.equal(mock.capture.spends.length, 0);
  } finally {
    mock.restore();
  }
});

test('generate: freebeat tetap berjalan lewat rute yang sama', async () => {
  // Panel kini selalu mengirim provider; 'freebeat' harus diarahkan ke alur Freebeat.
  // Karena mock Freebeat penuh ada di tests/freebeat-mcp.test.js, cukup pastikan
  // rute memilih cabang Freebeat (bukan Alibaba) dengan memeriksa bahwa body
  // alibaba tidak dikirim ke endpoint Alibaba.
  const mock = installMock();
  try {
    const res = await worker.fetch(
      apiRequest('/api/image/generate', { body: { provider: 'freebeat', prompt: 'tes freebeat' } }),
      createEnv(),
    );
    assert.notEqual(res.status, 200); // Freebeat gagal karena tidak dimock penuh — yang penting bukan jalur Alibaba
    assert.equal(mock.capture.submits.length, 0, 'cabang freebeat tidak boleh memanggil endpoint Alibaba');
    assert.equal(mock.capture.spends.length, 0, 'cabang freebeat tidak boleh memakai RPC kredit jalur Alibaba');
  } finally {
    mock.restore();
  }
});
