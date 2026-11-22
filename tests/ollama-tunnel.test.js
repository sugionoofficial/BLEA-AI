import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { PROVIDER_PRESETS, resolveProviderApiBase, isValidHttpBaseUrl } from '../src/lib/videoCatalog.js';
import { formatProviderBadge } from '../src/lib/formatCredits.js';

// Cloudflare Worker tidak bisa memanggil localhost, jadi provider ollama harus
// selalu memakai base URL publik (Cloudflare Tunnel) yang diisi admin.
const TUNNEL = 'https://kucing-biru-abc123.trycloudflare.com';

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

test('preset ollama chat-only: tanpa default base URL, dinormalkan ke /v1, dan berlabel Ollama', () => {
  assert.equal(PROVIDER_PRESETS.ollama.id, 'ollama');
  assert.equal(PROVIDER_PRESETS.ollama.defaultBaseUrl, '');
  assert.equal(formatProviderBadge('ollama'), 'Ollama');

  // Tanpa base URL eksplisit tidak boleh jatuh ke API provider lain.
  assert.equal(resolveProviderApiBase('ollama'), '');
  assert.equal(resolveProviderApiBase('ollama', ''), '');
  assert.equal(resolveProviderApiBase('ollama', 'not a url'), '');

  assert.equal(resolveProviderApiBase('ollama', TUNNEL), `${TUNNEL}/v1`);
  assert.equal(resolveProviderApiBase('ollama', `${TUNNEL}/`), `${TUNNEL}/v1`);
  // Admin boleh menempelkan URL endpoint lengkap.
  assert.equal(resolveProviderApiBase('ollama', `${TUNNEL}/v1`), `${TUNNEL}/v1`);
  assert.equal(resolveProviderApiBase('ollama', `${TUNNEL}/v1/chat/completions`), `${TUNNEL}/v1`);
  assert.equal(isValidHttpBaseUrl(TUNNEL), true);
});

test('/api/status, /api/catalog, dan /api/chat bekerja dengan provider ollama lewat tunnel', async () => {
  const realFetch = globalThis.fetch;
  let capturedAuth = '';
  let capturedUrl = '';
  let capturedPayload = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'ollama', api_key: 'ollama', base_url: TUNNEL, label: 'Ollama Laptop' }]);
    }
    if (url === `${TUNNEL}/v1/models`) {
      return Response.json({ object: 'list', data: [{ id: 'qwen3.5:4b' }, { id: 'qwen3:4b' }] });
    }
    if (url === `${TUNNEL}/v1/chat/completions`) {
      capturedUrl = url;
      capturedAuth = init.headers.authorization;
      capturedPayload = JSON.parse(init.body || '{}');
      return Response.json({ choices: [{ message: { content: 'Halo dari Ollama lokal!' } }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-ollama-1' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const statusRes = await worker.fetch(apiRequest('/api/status', { body: {} }), createEnv());
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.configured, true);
    assert.deepEqual(statusData.providers, ['ollama']);

    const catRes = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'ollama' } }), createEnv());
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    assert.deepEqual(
      [...catData.models.map((m) => m.id)].sort((a, b) => a.localeCompare(b)),
      ['qwen3:4b', 'qwen3.5:4b'],
    );

    const chatRes = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-ollama-1',
        provider: 'ollama',
        model: 'qwen3.5:4b',
        messages: [{ role: 'user', content: 'Halo Ollama' }],
      },
    }), createEnv());
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.ok, true);
    assert.equal(chatData.provider, 'ollama');
    assert.equal(chatData.reply, 'Halo dari Ollama lokal!');
    assert.equal(capturedUrl, `${TUNNEL}/v1/chat/completions`);
    assert.equal(capturedAuth, 'Bearer ollama');
    // Tanpa OLLAMA_MAX_TOKENS, Worker tidak boleh memaksa max_tokens: nilai dari
    // request akan menimpa num_predict di Modelfile model.
    assert.equal('max_tokens' in capturedPayload, false);
    assert.equal(capturedPayload.stream, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat menolak provider ollama tanpa base URL alih-alih menebak endpoint provider lain', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'ollama', api_key: 'ollama', base_url: null, label: 'Ollama Laptop' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-ollama-2',
        provider: 'ollama',
        model: 'qwen3.5:4b',
        messages: [{ role: 'user', content: 'Halo' }],
        autoFallback: false,
      },
    }), createEnv());
    // Worker membungkus kegagalan attempt sebagai 502 dengan code http_400 —
    // yang penting: pesannya jelas dan tidak ada permintaan ke endpoint provider lain.
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'http_400');
    assert.match(data.error, /Base URL untuk provider/i);
    assert.deepEqual(data.triedModels, ['qwen3.5:4b']);
    assert.equal(calls.some((url) => url.includes('/chat/completions')), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/video/models tidak pernah menampilkan ollama sebagai provider video', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'ollama', api_key: 'ollama', base_url: TUNNEL, label: 'Ollama Laptop' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([{ provider: 'ollama', model: 'qwen3.5:4b', active: true }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/freebeat_')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/video/models', { body: {} }), createEnv());
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.providers.some((p) => p.id === 'ollama'), false);
    assert.equal(payload.models.some((m) => m.provider === 'ollama'), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('OLLAMA_MAX_TOKENS memberi cap terpusat hanya bila operator menyetelnya', async () => {
  const realFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'ollama', api_key: 'ollama-local', base_url: TUNNEL, label: 'Ollama' }]);
    }
    if (url === `${TUNNEL}/v1/chat/completions`) {
      captured = JSON.parse(init.body || '{}');
      return Response.json({ choices: [{ message: { content: 'ok' } }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) return Response.json([{ id: 'msg-1' }]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const env = { ...createEnv(), OLLAMA_MAX_TOKENS: '384' };
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-ollama-max',
        provider: 'ollama',
        model: 'huihui_ai/qwen3-abliterated:4b',
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), env);
    assert.equal(res.status, 200);
    assert.equal(captured.max_tokens, 384);
  } finally {
    globalThis.fetch = realFetch;
  }
});
