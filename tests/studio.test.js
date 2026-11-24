import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { STUDIO_OPENAI_MODELS, studioModelItems, studioModelsForCapability, isStudioOpenAiModel } from '../src/lib/openaiModels.js';
import { SKILL_CATALOG, SKILL_CATALOG_COUNT, OUTPUT_CAPABILITIES, searchSkillCatalog, toolForCategory } from '../src/studio/skillCatalog.js';
import { assertStudioModel } from '../src/agent/modelRouting.js';
import { sealOpenAiToken } from '../src/lib/openaiPool.js';
import { capabilityForApiPath, canToolUseCapability } from '../src/lib/toolCapabilities.js';

const ENC_KEY = 'test-encryption-key-for-studio-suite-32b';

function createEnv(extra = {}) {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ...extra,
  };
}

function apiRequest(path, { method = 'GET', body, token = 'user-jwt' } = {}) {
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

// Stub upstream: Supabase auth/rest + chat gambar/video OpenAI lewat pool.
function stubUpstream({ accounts = [], accountsRows = null, imageOk = true, videoOk = true, generations = [] } = {}) {
  const state = { fetchCalls: [], inserts: [], patches: [], imageBodies: [], videoBodies: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    state.fetchCalls.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1', email: 'creator@example.com' });
    if (url.startsWith('https://supabase.example/rest/v1/openai_accounts')) {
      if (accountsRows) return Response.json(accountsRows);
      return Response.json(accounts);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/')) return Response.json(true);
    if (url.startsWith('https://supabase.example/rest/v1/studio_generations')) {
      if ((init.method || 'GET') === 'POST') {
        const row = { id: 'gen-1', ...JSON.parse(init.body), created_at: new Date().toISOString() };
        state.inserts.push(row);
        return Response.json([row]);
      }
      if ((init.method || 'GET') === 'PATCH') {
        state.patches.push({ url, body: JSON.parse(init.body) });
        return new Response(null, { status: 204 });
      }
      return Response.json(generations);
    }
    if (url.endsWith('/v1/images/generations')) {
      state.imageBodies.push(JSON.parse(init.body));
      return imageOk
        ? Response.json({ data: [{ url: 'https://cdn.example/img-1.png' }] })
        : new Response(JSON.stringify({ error: { message: 'quota habis' } }), { status: 429 });
    }
    if (url.endsWith('/v1/videos')) {
      state.videoBodies.push(JSON.parse(init.body));
      return videoOk
        ? Response.json({ id: 'video-abc', status: 'queued' })
        : new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 400 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { state, restore: () => { globalThis.fetch = realFetch; } };
}

// Baris openai_accounts seperti yang dikembalikan PostgREST (token tersegel
// dengan kunci enkripsi yang sama seperti di Worker).
async function account(overrides = {}) {
  const sealed = await sealOpenAiToken(createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }), 'sk-studio-test');
  return {
    id: '11111111-1111-1111-1111-111111111111',
    account_label: 'Akun Studio',
    account_email: 'studio@example.com',
    credential_kind: 'api_key',
    enabled: true,
    priority: 1,
    capabilities: ['chat', 'agent', 'image', 'video'],
    daily_limit: 50,
    used_today: 0,
    quota_date: null,
    cooldown_until: null,
    consecutive_failures: 0,
    api_base: 'https://api.openai.com',
    sealed_token: sealed,
    model_default: 'gpt-5.1',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

test('studio catalog: 30 kategori, 530 skill, dan tool tujuan yang valid', () => {
  assert.equal(SKILL_CATALOG.length, 30);
  const total = SKILL_CATALOG.reduce((sum, category) => sum + category.skills.length, 0);
  assert.equal(total, SKILL_CATALOG_COUNT);
  assert.equal(SKILL_CATALOG_COUNT, 530);
  for (const category of SKILL_CATALOG) {
    assert.ok(category.id && category.label, 'setiap kategori punya id & label');
    assert.ok(category.skills.length > 0, `${category.id} harus punya skill`);
    assert.ok(['chat', 'agent', 'image', 'video', 'audio', 'research', 'study'].includes(toolForCategory(category.id)));
  }
  assert.equal(new Set(SKILL_CATALOG.map((category) => category.id)).size, 30, 'id kategori unik');
});

test('studio catalog: pencarian skill mengembalikan kategori + skill yang cocok', () => {
  const rag = searchSkillCatalog('rag');
  assert.ok(rag.length > 0);
  assert.equal(rag[0].categoryId, 'ai');
  assert.ok(rag.some((hit) => /RAG/i.test(hit.skill)));
  assert.deepEqual(searchSkillCatalog('   '), []);
  const seo = searchSkillCatalog('seo');
  assert.ok(seo.some((hit) => hit.categoryId === 'marketing'));
});

test('studio output table: setiap output punya status live/partial', () => {
  assert.ok(OUTPUT_CAPABILITIES.length >= 13);
  for (const output of OUTPUT_CAPABILITIES) {
    assert.ok(output.label && output.icon && output.tool, 'setiap output punya label, ikon, dan tool');
    assert.ok(['live', 'partial'].includes(output.status), `${output.label} status harus live/partial`);
  }
  assert.ok(OUTPUT_CAPABILITIES.some((output) => /video/i.test(output.label) && output.status === 'partial'));
  assert.ok(OUTPUT_CAPABILITIES.some((output) => /Excel/i.test(output.label) && output.status === 'live'));
});

test('studio models: hanya model OpenAI, gambar/video tidak bocor ke ruang chat', () => {
  assert.ok(STUDIO_OPENAI_MODELS.length >= 10);
  for (const model of STUDIO_OPENAI_MODELS) assert.equal(isStudioOpenAiModel(model.id), true);
  assert.equal(isStudioOpenAiModel('qwen-max'), false);
  const chat = studioModelsForCapability('chat').map((model) => model.id);
  assert.ok(chat.includes('gpt-5.1'));
  assert.ok(!chat.includes('gpt-image-1'));
  const image = studioModelsForCapability('image').map((model) => model.id);
  assert.deepEqual(image, ['gpt-image-1']);
  const video = studioModelsForCapability('video').map((model) => model.id);
  assert.ok(video.includes('sora-2'));
  const items = studioModelItems(['agent'], {});
  assert.ok(items.length > 0);
  for (const item of items) assert.equal(item.provider, 'openai');
  // Override env hanya untuk ruang chat/agen, tidak pernah menambah model gambar.
  const override = studioModelsForCapability('image', { OPENAI_STUDIO_MODELS: 'gpt-4o' });
  assert.deepEqual(override, []);
});

test('studio routing: provider non-OpenAI ditolak di ruang Studio', () => {
  assert.equal(assertStudioModel({ provider: 'openai', model: 'gpt-5.1' }, { studioMode: true }), null);
  const mismatch = assertStudioModel({ provider: 'unorouter', model: 'qwen-max' }, { studioMode: true });
  assert.equal(mismatch.code, 'studio_provider_mismatch');
  const missing = assertStudioModel({ provider: '', model: '' }, { studioMode: true });
  assert.equal(missing.code, 'model_missing');
  // Di luar Studio perilaku lama tidak berubah (fallback katalog tetap jalan).
  assert.equal(assertStudioModel({ provider: 'alibaba', model: 'qwen-max' }, { studioMode: false }), null);
});

test('/api/studio/models menolak tanpa token', async () => {
  const stub = stubUpstream();
  try {
    const res = await worker.fetch(apiRequest('/api/studio/models', { token: '' }), createEnv());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    stub.restore();
  }
});

test('/api/studio/models melaporkan ready:false bila pool belum punya akun', async () => {
  const stub = stubUpstream({ accounts: [] });
  try {
    const res = await worker.fetch(apiRequest('/api/studio/models?capability=chat'), createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.provider, 'openai');
    assert.equal(data.ready, false);
    assert.ok(Array.isArray(data.models) && data.models.length > 0);
    assert.ok(data.modelItems.every((item) => item.provider === 'openai'));
    assert.ok(data.hint && data.hint.length > 0);
  } finally {
    stub.restore();
  }
});

test('/api/studio/image/generate menolak model di luar daftar gambar', async () => {
  const stub = stubUpstream({ accountsRows: [await account()] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/studio/image/generate', { method: 'POST', body: { prompt: 'kucing astronot', model: 'gpt-5.1' } }),
      createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }),
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /gpt-image-1/);
    assert.equal(stub.state.inserts.length, 0, 'permintaan tidak valid tidak boleh membuat baris');
  } finally {
    stub.restore();
  }
});

test('/api/studio/image/generate gagal rapi bila pool kosong', async () => {
  const stub = stubUpstream({ accounts: [] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/studio/image/generate', { method: 'POST', body: { prompt: 'kucing astronot' } }),
      createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }),
    );
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.match(data.error, /Akun OpenAI/);
  } finally {
    stub.restore();
  }
});

test('/api/studio/video/generate menolak model video tak dikenal', async () => {
  const stub = stubUpstream({ accountsRows: [await account()] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/studio/video/generate', { method: 'POST', body: { prompt: 'pantai', model: 'gpt-image-1' } }),
      createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }),
    );
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /sora-2/);
  } finally {
    stub.restore();
  }
});

test('studio media routes butuh login', async () => {
  const stub = stubUpstream({ accountsRows: [await account()] });
  try {
    for (const path of ['/api/studio/image/config', '/api/studio/video/config', '/api/studio/video/status']) {
      const res = await worker.fetch(apiRequest(path, { method: 'POST', body: {}, token: '' }), createEnv());
      assert.equal(res.status, 401, `${path} harus 401`);
    }
  } finally {
    stub.restore();
  }
});

test('/api/studio/image/generate memakai pool akun OpenAI dan mencatat hasil', async () => {
  const stub = stubUpstream({ accountsRows: [await account()] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/studio/image/generate', { method: 'POST', body: { prompt: 'kucing astronot', size: '1024x1024' } }),
      createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.generation.status, 'completed');
    assert.equal(data.generation.media_url, 'https://cdn.example/img-1.png');
    assert.equal(data.generation.openai_account_label, 'Akun Studio');
    assert.equal(stub.state.imageBodies[0].model, 'gpt-image-1');
    assert.equal(stub.state.imageBodies[0].prompt, 'kucing astronot');
    assert.ok(stub.state.patches.some((patch) => patch.body.status === 'completed'));
  } finally {
    stub.restore();
  }
});

test('/api/studio/video/generate menyimpan tugas Sora dan statusnya bisa dipoll', async () => {
  const stub = stubUpstream({ accountsRows: [await account()] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/studio/video/generate', { method: 'POST', body: { prompt: 'pantai senja', seconds: '8' } }),
      createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.generation.kind, 'video');
    assert.equal(data.generation.status, 'processing');
    assert.equal(data.generation.metadata.external_id, 'video-abc');
    assert.equal(stub.state.videoBodies[0].model, 'sora-2');
    assert.equal(stub.state.videoBodies[0].seconds, '8');
  } finally {
    stub.restore();
  }
});

test('/api/studio/image/config hanya menawarkan model gambar dan melaporkan kesiapan pool', async () => {
  const stub = stubUpstream({ accountsRows: [await account()] });
  try {
    const res = await worker.fetch(
      apiRequest('/api/studio/image/config', { method: 'POST', body: {} }),
      createEnv({ PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY }),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.provider, 'openai');
    assert.equal(data.ready, true);
    assert.ok(data.models.every((model) => ['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'].includes(model.id)));
  } finally {
    stub.restore();
  }
});

test('isolasi tool: rute media Studio hanya boleh dari ruang yang cocok', () => {
  assert.equal(capabilityForApiPath('/api/studio/image/generate'), 'image');
  assert.equal(capabilityForApiPath('studio/video/status'), 'video');
  assert.equal(canToolUseCapability('image', 'image'), true);
  assert.equal(canToolUseCapability('chat', 'image'), false);
  assert.equal(canToolUseCapability('video', 'image'), false);
});
