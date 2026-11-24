import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { CLOUDFLARE_FREE_LLM_MODELS, resolveProviderApiBase, validateProviderBaseUrl } from '../src/lib/videoCatalog.js';
import { isUncertainReply, parseSearchRequests, parseUpstreamSsePayload, splitThinkingContent, thinkingStageLabel } from '../src/lib/chatStream.js';

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

test('/api/enabled-models filters out video & non-chat models, prioritizes reliable models, and returns modelItems with providers', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'unorouter', model: 'qwen3.7-flash:free' },
        { provider: 'unorouter', model: 'phonellm-mini-alpha-2:free' },
        { provider: 'unorouter', model: 'gpt-oss-120b:free' },
        { provider: 'unorouter', model: 'veo3.1' },
        { provider: 'unorouter', model: 'text-embedding-3-small' },
        { provider: 'pekpik', model: 'anthropic/claude-sonnet-4' },
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/enabled-models', { body: {} }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.models[0], 'gpt-oss-120b:free');
    assert.ok(data.models.includes('anthropic/claude-sonnet-4'));
    assert.equal(data.models.includes('veo3.1'), false);
    assert.equal(data.models.includes('text-embedding-3-small'), false);
    assert.ok(data.modelItems.some((item) => item.id === 'anthropic/claude-sonnet-4' && item.provider === 'pekpik'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat automatically falls back to another active chat model on 429 rate_limit_exceeded', async () => {
  const realFetch = globalThis.fetch;
  const requestedModels = [];
  const savedMessages = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'unorouter', api_key: 'uno-test-key', base_url: null }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'unorouter', model: 'veo3.1' },
        { provider: 'unorouter', model: 'gpt-oss-120b:free' },
        { provider: 'unorouter', model: 'gemini-2.5-flash:free' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      const payload = JSON.parse(init.body);
      savedMessages.push(payload);
      return Response.json([{ id: 'msg-fallback-1', ...payload }]);
    }
    if (url === 'https://api.unorouter.com/v1/chat/completions') {
      const payload = JSON.parse(init.body);
      requestedModels.push(payload.model);
      if (payload.model === 'gpt-oss-120b:free') {
        return new Response(JSON.stringify({
          error: {
            message: 'Model rate limit exceeded: free tier allows 5 request(s) every 1 min per account on gpt-oss-120b:free. Please retry in 39s.',
            code: 'rate_limit_exceeded',
          },
        }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      if (payload.model === 'gemini-2.5-flash:free') {
        return Response.json({ choices: [{ message: { content: 'Halo dari model cadangan!' } }] });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-1',
        model: 'gpt-oss-120b:free',
        messages: [{ role: 'user', content: 'Halo AI' }],
      },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.reply, 'Halo dari model cadangan!');
    assert.equal(data.model, 'gemini-2.5-flash:free');
    assert.equal(data.fallbackFrom, 'gpt-oss-120b:free');
    assert.equal(data.fallbackReason, 'rate_limit_exceeded');
    assert.deepEqual(requestedModels, ['gpt-oss-120b:free', 'gemini-2.5-flash:free']);
    assert.equal(savedMessages.length, 1);
    assert.equal(savedMessages[0].content, 'Halo dari model cadangan!');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat routes non-unorouter provider requests to configured provider endpoint', async () => {
  const realFetch = globalThis.fetch;
  let capturedAuth = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'unorouter', api_key: 'uno-key', base_url: null },
        { provider: 'pekpik', api_key: 'pekpik-secret-key', base_url: 'https://aiapiv2.pekpik.com' },
      ]);
    }
    if (url === 'https://aiapiv2.pekpik.com/v1/chat/completions') {
      capturedAuth = init.headers.authorization;
      return Response.json({ choices: [{ message: { content: 'PEKPIK siap membantu.' } }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-or-1' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-2',
        provider: 'pekpik',
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'Tes PEKPIK' }],
      },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.provider, 'pekpik');
    assert.equal(data.reply, 'PEKPIK siap membantu.');
    assert.equal(capturedAuth, 'Bearer pekpik-secret-key');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat returns HTTP 429 with retryAfterSec and Indonesian message when all candidate models are rate-limited', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'unorouter', api_key: 'uno-key', base_url: null }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'unorouter', model: 'gpt-oss-120b:free' },
        { provider: 'unorouter', model: 'mistral-small:free' },
      ]);
    }
    if (url === 'https://api.unorouter.com/v1/chat/completions') {
      return new Response(JSON.stringify({
        error: {
          message: 'Model rate limit exceeded: free tier allows 5 request(s) every 1 min per account. Please retry in 42s.',
          code: 'rate_limit_exceeded',
        },
      }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '42' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-3',
        model: 'gpt-oss-120b:free',
        messages: [{ role: 'user', content: 'Tes rate limit' }],
      },
    }), createEnv());
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '42');
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'rate_limit_exceeded');
    assert.equal(data.retryAfterSec, 42);
    assert.match(data.error, /42 detik/);
    assert.deepEqual(data.triedModels, ['gpt-oss-120b:free', 'mistral-small:free']);
    assert.equal(data.triedDetails.length, 2);
    assert.equal(data.triedDetails[1].model, 'mistral-small:free');
    assert.equal(data.triedDetails[1].status, 429);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat places system message first, diversifies fallback across families, and extracts reasoning/array replies', async () => {
  const realFetch = globalThis.fetch;
  const capturedPayloads = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'unorouter', api_key: 'uno-key', base_url: null }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'unorouter', model: 'qwen3.7-flash:free' },
        { provider: 'unorouter', model: 'deepseek-v4-flash-0731:free' },
        { provider: 'unorouter', model: 'deepseek-v4.1-flash-uncensored-fp8:free' },
        { provider: 'unorouter', model: 'gemini-2.5-flash:free' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-div-1' }]);
    }
    if (url === 'https://api.unorouter.com/v1/chat/completions') {
      const payload = JSON.parse(init.body);
      capturedPayloads.push(payload);
      if (payload.model === 'qwen3.7-flash:free') {
        return new Response(JSON.stringify({
          error: { message: 'The free tier allows 1 request(s) every 1 min per account', code: 'rate_limit_exceeded' },
        }), { status: 429, headers: { 'content-type': 'application/json' } });
      }
      if (payload.model === 'gemini-2.5-flash:free') {
        return Response.json({
          choices: [{ message: { content: [{ type: 'text', text: 'Jawaban dari Gemini' }] } }],
        });
      }
      return new Response(JSON.stringify({ error: { message: 'Model overloaded' } }), { status: 503, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-4',
        model: 'qwen3.7-flash:free',
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.model, 'gemini-2.5-flash:free');
    assert.equal(data.reply, 'Jawaban dari Gemini');
    assert.equal(capturedPayloads[0].messages[0].role, 'system');
    assert.equal(capturedPayloads[0].messages[1].role, 'user');
    assert.deepEqual(
      capturedPayloads.map((p) => p.model),
      ['qwen3.7-flash:free', 'gemini-2.5-flash:free'],
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PEKPIK OpenAI-compatible provider works in /api/status, /api/catalog, and /api/chat', async () => {
  assert.equal(resolveProviderApiBase('pekpik'), 'https://aiapiv2.pekpik.com/v1');

  const realFetch = globalThis.fetch;
  let capturedAuth = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'pekpik', api_key: 'sk-pekpik-test', base_url: null }]);
    }
    if (url === 'https://aiapiv2.pekpik.com/v1/models') {
      return Response.json({ data: [{ id: 'gemini-2.5-flash' }, { id: 'gpt-5.5' }, { id: 'text-embedding-3-small' }] });
    }
    if (url === 'https://aiapiv2.pekpik.com/v1/chat/completions') {
      capturedAuth = init.headers.authorization;
      return Response.json({ choices: [{ message: { content: 'Balasan dari PEKPIK!' } }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-pek-1' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const statusRes = await worker.fetch(apiRequest('/api/status', { body: {} }), createEnv());
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.configured, true);
    assert.deepEqual(statusData.providers, ['pekpik']);

    const catRes = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'pekpik' } }), createEnv());
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    assert.equal(catData.models.length, 3);
    assert.equal(catData.models.find((m) => m.id === 'text-embedding-3-small')?.category, 'Embedding');

    const chatRes = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-pek-1',
        provider: 'pekpik',
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Halo PEKPIK' }],
      },
    }), createEnv());
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.ok, true);
    assert.equal(chatData.provider, 'pekpik');
    assert.equal(chatData.reply, 'Balasan dari PEKPIK!');
    assert.equal(capturedAuth, 'Bearer sk-pekpik-test');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/save-models stays well under Cloudflare 50-subrequest limit even with 120+ stale models', async () => {
  const realFetch = globalThis.fetch;
  let subrequestCount = 0;
  const staleRows = Array.from({ length: 120 }, (_, i) => ({ model: `stale-model-${i}:free` }));
  const deactivatedBatches = [];
  globalThis.fetch = async (input, init = {}) => {
    subrequestCount += 1;
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    }
    if (url === 'https://supabase.example/rest/v1/provider_models' && init.method === 'POST') {
      return Response.json(JSON.parse(init.body));
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models?select=model') && (!init.method || init.method === 'GET')) {
      return Response.json([...staleRows, { model: 'keep-model:free' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models') && init.method === 'PATCH') {
      deactivatedBatches.push(url);
      return Response.json([]);
    }
    throw new Error(`Unexpected fetch: ${init.method || 'GET'} ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/save-models', {
      body: { provider: 'unorouter', models: ['keep-model:free'] },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.activeCount, 1);
    assert.ok(subrequestCount <= 12, `Expected <= 12 subrequests, got ${subrequestCount}`);
    assert.equal(deactivatedBatches.length, 5);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Cloudflare Workers AI native env.AI binding supports /api/status, /api/verify, /api/catalog, /api/enabled-models, /api/video/models isolation, and /api/chat', async () => {
  assert.equal(resolveProviderApiBase('cloudflare', ''), '');
  assert.equal(
    resolveProviderApiBase('cloudflare', 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/'),
    'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
  );

  const aiCalls = [];
  const envWithAi = {
    ...createEnv(),
    AI: {
      run: async (model, input) => {
        aiCalls.push({ model, input });
        if (model === '@cf/google/gemma-3-12b-it') {
          return { choices: [{ message: { content: 'Halo dari Gemma 3 via Workers AI!' } }] };
        }
        return { response: 'Halo dari Llama Workers AI!' };
      },
    },
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'cloudflare', api_key: 'binding:AI', base_url: null, label: 'Cloudflare Workers AI' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', active: true },
        { provider: 'cloudflare', model: '@cf/google/gemma-3-12b-it', active: true },
        { provider: 'cloudflare', model: '@cf/zai-org/glm-4.7-flash', active: true },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-cf-1' }]);
    }
    if (url === 'https://api.unorouter.com/api/pricing') {
      return Response.json({ data: [] });
    }
    if (url === 'https://api.unorouter.com/v1/chat/completions') {
      throw new Error('Should not hit UnoRouter for cloudflare binding');
    }
    throw new Error(`Unexpected fetch: ${init.method || 'GET'} ${url}`);
  };
  try {
    // 1. /api/status detects Workers AI binding cleanly and hides unconfigured binding:AI when AI is absent
    const statusBoundRes = await worker.fetch(apiRequest('/api/status', { body: {} }), envWithAi);
    const statusBound = await statusBoundRes.json();
    assert.equal(statusBound.configured, true);
    assert.equal(statusBound.workersAiBound, true);
    assert.ok(statusBound.providers.includes('cloudflare'));

    const statusUnboundRes = await worker.fetch(apiRequest('/api/status', { body: {} }), createEnv());
    const statusUnbound = await statusUnboundRes.json();
    assert.equal(statusUnbound.configured, false);
    assert.deepEqual(statusUnbound.providers, []);

    // 2. /api/verify verifies native env.AI binding
    const verifyRes = await worker.fetch(
      apiRequest('/api/verify', { body: { provider: 'cloudflare', apiKey: 'binding:AI' } }),
      envWithAi,
    );
    const verifyData = await verifyRes.json();
    assert.equal(verifyData.ok, true);
    assert.equal(verifyData.verifiedVia, 'binding');
    assert.ok(verifyData.modelsCount >= 10);

    // 3. /api/catalog returns curated free Cloudflare LLMs
    const catRes = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'cloudflare' } }), envWithAi);
    const catData = await catRes.json();
    assert.ok(catData.models.some((m) => m.id === '@cf/meta/llama-3.1-8b-instruct-fp8-fast' && m.isFree));
    assert.ok(catData.models.every((m) => m.category === 'Text'));

    // 4. /api/enabled-models lists Cloudflare models, while /api/video/models excludes @cf chat models
    const enabledRes = await worker.fetch(apiRequest('/api/enabled-models', { body: {} }), envWithAi);
    const enabledData = await enabledRes.json();
    assert.ok(enabledData.modelItems.some((m) => m.id === '@cf/meta/llama-3.1-8b-instruct-fp8-fast' && m.provider === 'cloudflare'));

    const videoRes = await worker.fetch(apiRequest('/api/video/models', { method: 'GET' }), envWithAi);
    const videoData = await videoRes.json();
    assert.equal(videoData.models.some((m) => String(m.id).startsWith('@cf/')), false);
    assert.equal(videoData.providers.some((p) => p.id === 'cloudflare'), false);

    // 5. /api/chat invokes env.AI.run, flattens multimodal arrays for text-only models, and extracts { response } & { choices }
    const chatRes1 = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-cf-1',
        provider: 'cloudflare',
        model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Jelaskan file ini' }, { type: 'image_url', image_url: { url: 'https://img.example/a.png' } }] },
        ],
      },
    }), envWithAi);
    assert.equal(chatRes1.status, 200);
    const chatData1 = await chatRes1.json();
    assert.equal(chatData1.ok, true);
    assert.equal(chatData1.provider, 'cloudflare');
    assert.equal(chatData1.reply, 'Halo dari Llama Workers AI!');
    const lastCall = aiCalls.at(-1);
    assert.equal(typeof lastCall.input.messages[1].content, 'string');
    assert.ok(lastCall.input.messages[1].content.includes('Jelaskan file ini'));
    assert.equal(lastCall.input.max_tokens, 4096);
    assert.equal(lastCall.input.temperature, 0.35);

    const chatRes2 = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-cf-2',
        provider: 'cloudflare',
        model: '@cf/google/gemma-3-12b-it',
        messages: [{ role: 'user', content: 'Halo Gemma' }],
      },
    }), envWithAi);
    const chatData2 = await chatRes2.json();
    assert.equal(chatData2.reply, 'Halo dari Gemma 3 via Workers AI!');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Cloudflare Workers AI supports REST Account ID endpoint and cross-provider 429 fallback onto env.AI', async () => {
  const realFetch = globalThis.fetch;
  let capturedCfAuth = '';
  let capturedCfPayload = null;
  const envWithAi = {
    ...createEnv(),
    AI: {
      run: async () => ({ response: 'Cadangan gratis dari Cloudflare Workers AI!' }),
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'unorouter', api_key: 'uno-key', base_url: null },
        { provider: 'cloudflare', api_key: 'cf-rest-token', base_url: 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'unorouter', model: 'gpt-oss-120b:free' },
        { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-cf-rest' }]);
    }
    if (url === 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions') {
      capturedCfAuth = init.headers.authorization;
      capturedCfPayload = JSON.parse(init.body);
      return Response.json({ choices: [{ message: { content: 'Balasan via REST Cloudflare!' } }] });
    }
    if (url === 'https://api.unorouter.com/v1/chat/completions') {
      return new Response(JSON.stringify({ error: { message: 'Rate limited', code: 'rate_limit_exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    // 1. Direct REST route when Account ID Base URL + token configured
    const restRes = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-cf-rest',
        provider: 'cloudflare',
        model: '@cf/openai/gpt-oss-20b',
        messages: [{ role: 'user', content: 'Tes REST CF' }],
      },
    }), createEnv());
    assert.equal(restRes.status, 200);
    const restData = await restRes.json();
    assert.equal(restData.reply, 'Balasan via REST Cloudflare!');
    assert.equal(capturedCfAuth, 'Bearer cf-rest-token');
    assert.equal(capturedCfPayload.max_tokens, 4096);
    assert.equal(capturedCfPayload.temperature, 0.35);

    // 2. Fallback from 429 UnoRouter onto Cloudflare Workers AI binding (when CF uses binding:AI)
    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
      if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
        return Response.json([
          { provider: 'unorouter', api_key: 'uno-key', base_url: null },
          { provider: 'cloudflare', api_key: 'binding:AI', base_url: null },
        ]);
      }
      if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
        return Response.json([
          { provider: 'unorouter', model: 'gpt-oss-120b:free' },
          { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' },
        ]);
      }
      if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) return Response.json([{ id: 'msg-fb' }]);
      if (url === 'https://api.unorouter.com/v1/chat/completions') {
        return new Response(JSON.stringify({ error: { message: 'Rate limited', code: 'rate_limit_exceeded' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    };
    const fbRes = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-fb-cf',
        provider: 'unorouter',
        model: 'gpt-oss-120b:free',
        messages: [{ role: 'user', content: 'Tes fallback' }],
      },
    }), envWithAi);
    assert.equal(fbRes.status, 200);
    const fbData = await fbRes.json();
    assert.equal(fbData.provider, 'cloudflare');
    assert.equal(fbData.model, '@cf/meta/llama-3.1-8b-instruct-fp8-fast');
    assert.equal(fbData.fallbackFrom, 'gpt-oss-120b:free');
    assert.equal(fbData.reply, 'Cadangan gratis dari Cloudflare Workers AI!');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Malformed or autofilled email base_url never throws TypeError: Invalid URL in resolveProviderApiBase or /api/chat', async () => {
  assert.equal(resolveProviderApiBase('cloudflare', 'creator@example.com'), '');
  assert.equal(resolveProviderApiBase('unorouter', 'creator@example.com'), 'https://api.unorouter.com/v1');
  assert.equal(resolveProviderApiBase('custom', 'creator@example.com'), '');
  assert.equal(validateProviderBaseUrl('creator@example.com', 'cloudflare').ok, false);
  assert.equal(validateProviderBaseUrl('https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1', 'cloudflare').ok, true);

  const realFetch = globalThis.fetch;
  const envWithAi = {
    ...createEnv(),
    AI: { run: async () => ({ response: 'Tetap jalan lewat env.AI binding!' }) },
  };
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'cloudflare', api_key: 'autofilled-secret', base_url: 'creator@example.com' },
        { provider: 'custom', api_key: 'sk-custom', base_url: 'creator@example.com' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) return Response.json([{ id: 'msg-safe-1' }]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const cfRes = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-safe-cf',
        provider: 'cloudflare',
        model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), envWithAi);
    assert.equal(cfRes.status, 200);
    const cfData = await cfRes.json();
    assert.equal(cfData.reply, 'Tetap jalan lewat env.AI binding!');

    const badRes = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-safe-custom',
        provider: 'custom',
        model: 'custom-model',
        autoFallback: false,
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    assert.equal(badRes.status, 502);
    const badData = await badRes.json();
    assert.equal(badData.ok, false);
    assert.match(badData.error, /Base URL.*tidak valid/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat stream:true emits normalized SSE events, supports 429 fallback before opening stream, and chatStream helpers parse <think> cleanly', async () => {
  const closedThink = splitThinkingContent('<think>analisis langkah 1\nlangkah 2</think>\n\nHalo dunia!');
  assert.equal(closedThink.thinking, 'analisis langkah 1\nlangkah 2');
  assert.equal(closedThink.answer, 'Halo dunia!');
  assert.equal(closedThink.isThinkingOpen, false);

  const openThink = splitThinkingContent('<think>sedang merangkai ide...');
  assert.equal(openThink.thinking, 'sedang merangkai ide...');
  assert.equal(openThink.answer, '');
  assert.equal(openThink.isThinkingOpen, true);

  assert.deepEqual(parseUpstreamSsePayload({ response: 'Kata ' }), { contentDelta: 'Kata ', reasoningDelta: '' });
  assert.deepEqual(
    parseUpstreamSsePayload({ choices: [{ delta: { reasoning_content: 'pikir', content: 'jawab' } }] }),
    { contentDelta: 'jawab', reasoningDelta: 'pikir' },
  );
  assert.match(thinkingStageLabel(0.5), /Sedang berpikir/);
  assert.match(thinkingStageLabel(7), /Masih memproses/);
  assert.deepEqual(parseSearchRequests('Butuh cek ini. ```search\n{"query":"Cloudflare Workers AI max tokens"}\n```'), ['Cloudflare Workers AI max tokens']);
  assert.deepEqual(parseSearchRequests('```search\nquery: cuaca Jakarta hari ini\n```'), ['cuaca Jakarta hari ini']);
  assert.equal(isUncertainReply('Maaf, saya tidak dapat memastikan informasi terkini.'), true);
  assert.equal(isUncertainReply('Berikut langkah-langkah yang bisa dicoba.'), false);
  for (const id of ['@cf/openai/gpt-oss-120b', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', '@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/qwen/qwen2.5-coder-32b-instruct']) {
    assert.equal(CLOUDFLARE_FREE_LLM_MODELS.find((model) => model.id === id)?.starter, true);
  }

  const encoder = new TextEncoder();
  const realFetch = globalThis.fetch;
  const savedMessages = [];
  const envWithStreamAi = {
    ...createEnv(),
    AI: {
      run: async (_model, input) => {
        assert.equal(input.stream, true);
        return new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"response":"Halo "}\n\n'));
            controller.enqueue(encoder.encode('data: {"response":"stream!"}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
      },
    },
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'unorouter', api_key: 'uno-key', base_url: null },
        { provider: 'cloudflare', api_key: 'binding:AI', base_url: null },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'unorouter', model: 'gpt-oss-120b:free' },
        { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast' },
      ]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      const payload = JSON.parse(init.body);
      savedMessages.push(payload);
      return Response.json([{ id: 'msg-stream-1', ...payload }]);
    }
    if (url === 'https://api.unorouter.com/v1/chat/completions') {
      return new Response(JSON.stringify({ error: { message: 'Rate limited', code: 'rate_limit_exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-stream-1',
        provider: 'unorouter',
        model: 'gpt-oss-120b:free',
        stream: true,
        messages: [{ role: 'user', content: 'Tes stream fallback' }],
      },
    }), envWithStreamAi);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const rawSse = await res.text();
    const events = rawSse
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => JSON.parse(l.slice(5).trim()));

    assert.equal(events[0].type, 'meta');
    assert.equal(events[0].provider, 'cloudflare');
    assert.equal(events[0].fallbackFrom, 'gpt-oss-120b:free');
    const deltas = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
    assert.equal(deltas, 'Halo stream!');
    const doneEv = events.find((e) => e.type === 'done');
    assert.equal(doneEv.ok, true);
    assert.equal(doneEv.messageId, 'msg-stream-1');
    assert.equal(doneEv.reply, 'Halo stream!');
    assert.equal(savedMessages.length, 1);
    assert.equal(savedMessages[0].content, 'Halo stream!');
  } finally {
    globalThis.fetch = realFetch;
  }
});


test('/api/chat autonomously searches diverse sources on an explicit search request then retries with source context', async () => {
  const realFetch = globalThis.fetch;
  const modelBodies = [];
  const searchHosts = new Set();
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'research-user' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([{ provider: 'unorouter', api_key: 'uno-key', base_url: null }]);
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) return Response.json([{ id: 'research-message' }]);
    if (url.startsWith('https://api.unorouter.com/v1/chat/completions')) {
      modelCalls += 1;
      const payload = JSON.parse(init.body);
      modelBodies.push(payload);
      return Response.json({ choices: [{ message: { content: modelCalls === 1
        ? '```search\n{"query":"Cloudflare Workers AI token limit"}\n```Saya akan memeriksa sumber.'
        : 'Workers AI membatasi token keluaran; atur max_tokens secara eksplisit. [Dokumentasi](https://developers.cloudflare.com/workers-ai/)' } }] });
    }
    const parsedUrl = new URL(url);
    searchHosts.add(parsedUrl.hostname);
    if (parsedUrl.hostname === 'html.duckduckgo.com') return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    if (parsedUrl.hostname === 'en.wikipedia.org') return Response.json({ query: { search: [{ title: 'Cloudflare Workers AI', snippet: 'An AI platform.' }] } });
    if (parsedUrl.hostname === 'id.wikipedia.org') return Response.json({ query: { search: [] } });
    if (parsedUrl.hostname === 'api.stackexchange.com') return Response.json({ items: [{ title: 'How to set max_tokens?', link: 'https://stackoverflow.com/questions/1', answer_count: 2, score: 5, is_answered: true }] });
    if (parsedUrl.hostname === 'api.github.com') return Response.json({ items: [{ full_name: 'cloudflare/workers-sdk', html_url: 'https://github.com/cloudflare/workers-sdk', description: 'Cloudflare Workers tools', stargazers_count: 100 }] });
    if (parsedUrl.hostname === 'api.duckduckgo.com' || parsedUrl.hostname === 'hn.algolia.com') return Response.json({});
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const response = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'research-conv', provider: 'unorouter', model: 'gpt-oss-120b:free',
        messages: [{ role: 'user', content: 'Bagaimana mengatasi batas token Cloudflare?' }],
      },
    }), createEnv());
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.reply, /atur max_tokens/);
    assert.equal(modelCalls, 2);
    assert.match(modelBodies[1].messages.at(-1).content, /Stack Overflow/);
    assert.match(modelBodies[1].messages.at(-1).content, /Wikipedia/);
    assert.ok(searchHosts.has('api.stackexchange.com'));
    assert.ok(searchHosts.has('api.github.com'));
    assert.ok(searchHosts.has('hn.algolia.com'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/chat stream mode buffers a search request, researches, then streams the final answer without leaking its control block', async () => {
  const realFetch = globalThis.fetch;
  const inputs = [];
  const envWithAi = {
    ...createEnv(),
    AI: {
      run: async (_model, input) => {
        inputs.push(input);
        if (input.stream) {
          const encoder = new TextEncoder();
          return new ReadableStream({ start(controller) {
            const responseText = '```search\n{"query":"Workers AI output tokens"}\n```Saya akan mengecek.';
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: responseText })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          } });
        }
        return { response: 'Atur max_tokens secara eksplisit. https://developers.cloudflare.com/workers-ai/' };
      },
    },
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'stream-research-user' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([{ provider: 'cloudflare', api_key: 'binding:AI', base_url: null }]);
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) return Response.json([{ id: 'stream-research-message' }]);
    const host = new URL(url).hostname;
    if (host === 'html.duckduckgo.com') return new Response('<html></html>');
    if (host === 'en.wikipedia.org') return Response.json({ query: { search: [{ title: 'Workers AI', snippet: 'Workers AI models accept max_tokens.' }] } });
    if (host === 'id.wikipedia.org') return Response.json({ query: { search: [] } });
    return Response.json({});
  };
  try {
    const response = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'stream-research-conv', provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b',
        stream: true, messages: [{ role: 'user', content: 'Apa batas output token?' }],
      },
    }), envWithAi);
    assert.equal(response.status, 200);
    const lines = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith('data:'));
    const events = lines.map((line) => JSON.parse(line.slice(5).trim()));
    const done = events.find((event) => event.type === 'done');
    assert.match(done.reply, /Atur max_tokens/);
    assert.equal(done.reply.includes('```search'), false);
    assert.equal(inputs.length, 2);
    assert.match(inputs[1].messages.at(-1).content, /Wikipedia/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/tempmail is server-gated to admins, keeps mailbox credentials private, and serves isolated per-user inbox data', async () => {
  const realFetch = globalThis.fetch;
  let savedAlias;
  const mailboxCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      const isAdmin = init.headers.authorization === 'Bearer admin-token';
      return Response.json({ id: isAdmin ? 'admin-user-1' : 'regular-user-1', app_metadata: { role: isAdmin ? 'admin' : 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/tempmail_user_aliases')) {
      if (init.method === 'POST') {
        savedAlias = JSON.parse(init.body)[0];
        return new Response(null, { status: 201 });
      }
      return Response.json(savedAlias ? [savedAlias] : []);
    }
    const parsed = new URL(url);
    if (parsed.hostname === 'api.mail.tm') {
      mailboxCalls.push({ url, method: init.method || 'GET' });
      if (parsed.pathname === '/domains') return Response.json({ 'hydra:member': [{ domain: 'mailtm.test', isActive: true, isPrivate: false }] });
      if (parsed.pathname === '/accounts') return Response.json({ id: 'account-id' }, { status: 201 });
      if (parsed.pathname === '/token') return Response.json({ token: 'private-mailbox-token' });
      if (parsed.pathname === '/messages' && !parsed.pathname.endsWith('/message-id-1')) return Response.json({ 'hydra:member': [{ id: 'message-id-1', subject: 'Verification code', from: { address: 'sender@example.com', name: 'Sender' }, intro: 'Your code is 123456', createdAt: '2026-11-18T00:00:00Z' }] });
      if (parsed.pathname === '/messages/message-id-1') return Response.json({ id: 'message-id-1', subject: 'Verification code', from: { address: 'sender@example.com' }, to: [{ address: savedAlias.email }], text: 'Your code is 123456', html: ['<p>Your code is 123456</p>'] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const denied = await worker.fetch(apiRequest('/api/tempmail?action=alias', { token: 'regular-token' }), createEnv());
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get('cache-control'), /no-store/);

    const created = await worker.fetch(apiRequest('/api/tempmail?action=create', { token: 'admin-token', body: {} }), createEnv());
    assert.equal(created.status, 200, await created.clone().text());
    const createdData = await created.json();
    assert.match(createdData.email, /@mailtm\.test$/);
    assert.equal(createdData.reused, false);
    assert.equal(JSON.stringify(createdData).includes('private-mailbox-token'), false);
    assert.equal(savedAlias.user_id, 'admin-user-1');
    assert.match(savedAlias.token, /private-mailbox-token/);

    const inbox = await worker.fetch(apiRequest(`/api/tempmail?action=messages&email=${encodeURIComponent(createdData.email)}`, { token: 'admin-token' }), createEnv());
    const inboxData = await inbox.json();
    assert.equal(inboxData.messages[0].subject, 'Verification code');
    assert.equal(inboxData.messages[0].preview, 'Your code is 123456');

    const message = await worker.fetch(apiRequest(`/api/tempmail?action=message&email=${encodeURIComponent(createdData.email)}&messageId=message-id-1`, { token: 'admin-token' }), createEnv());
    const messageData = await message.json();
    assert.equal(messageData.message.bodyText, 'Your code is 123456');
    assert.equal(messageData.message.bodyHtml, '<p>Your code is 123456</p>');

    const crossAccount = await worker.fetch(apiRequest('/api/tempmail?action=messages&email=other@mailtm.test', { token: 'admin-token' }), createEnv());
    assert.equal(crossAccount.status, 404);
    assert.ok(mailboxCalls.some((call) => call.url.includes('/messages?page=1')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/tempmail supports the GEN-Z.AI Gmail OAuth connect, plus-tag alias, filtered inbox, and disconnect flow', async () => {
  const realFetch = globalThis.fetch;
  const gmailRefreshSecret = 'a'.repeat(64);
  let savedConnection;
  let savedAlias;
  const workerFetches = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const parsed = new URL(url);
    workerFetches.push({ url: parsed.toString(), method: init.method || 'GET' });
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'gmail-admin', app_metadata: { role: 'admin' } });
    if (parsed.hostname === 'supabase.example' && parsed.pathname === '/rest/v1/tempmail_gmail_connections') {
      if (init.method === 'POST') {
        savedConnection = JSON.parse(init.body);
        return new Response(null, { status: 201 });
      }
      if (init.method === 'DELETE') { savedConnection = null; return new Response(null, { status: 204 }); }
      return Response.json(savedConnection ? [{ email: savedConnection.email, refresh_token_ciphertext: savedConnection.refresh_token_ciphertext, refresh_token_iv: savedConnection.refresh_token_iv }] : []);
    }
    if (parsed.hostname === 'supabase.example' && parsed.pathname === '/rest/v1/tempmail_user_aliases') {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        savedAlias = Array.isArray(body) ? body[0] : body;
        return Response.json([savedAlias], { status: 201 });
      }
      if (init.method === 'DELETE') { savedAlias = null; return new Response(null, { status: 204 }); }
      return Response.json(savedAlias ? [savedAlias] : []);
    }
    if (parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token') {
      const form = new URLSearchParams(init.body);
      if (form.get('grant_type') === 'authorization_code') return Response.json({ access_token: 'gmail-access', refresh_token: 'do-not-return-this-refresh-token' });
      return Response.json({ access_token: 'gmail-access' });
    }
    if (parsed.hostname === 'gmail.googleapis.com' && parsed.pathname === '/gmail/v1/users/me/profile') return Response.json({ emailAddress: 'owner@gmail.com' });
    if (parsed.hostname === 'gmail.googleapis.com' && parsed.pathname === '/gmail/v1/users/me/messages') return Response.json({ messages: [{ id: 'alias-message' }, { id: 'other-message' }] });
    if (parsed.hostname === 'gmail.googleapis.com' && parsed.pathname.endsWith('/messages/alias-message')) {
      if (parsed.searchParams.get('format') === 'metadata') return Response.json({ id: 'alias-message', snippet: 'Your code is 8321', payload: { headers: [{ name: 'To', value: 'owner+signup-2026@gmail.com' }, { name: 'Subject', value: 'Verify your account' }, { name: 'From', value: 'Service <no-reply@example.com>' }] } });
      return Response.json({ id: 'alias-message', payload: { headers: [{ name: 'To', value: 'owner+signup-2026@gmail.com' }, { name: 'Subject', value: 'Verify your account' }, { name: 'From', value: 'no-reply@example.com' }], mimeType: 'text/plain', body: { data: btoa('Your verification code is 8321') } } });
    }
    if (parsed.hostname === 'gmail.googleapis.com' && parsed.pathname.endsWith('/messages/other-message')) return Response.json({ id: 'other-message', payload: { headers: [{ name: 'To', value: 'owner@gmail.com' }, { name: 'Subject', value: 'Private account email' }] } });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  const env = {
    ...createEnv(),
    GMAIL_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
    GMAIL_CLIENT_SECRET: 'test-client-secret',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEY: gmailRefreshSecret,
  };
  try {
    const connect = await worker.fetch(apiRequest('/api/tempmail?action=gmail-connect', { token: 'admin-jwt', method: 'GET' }), env);
    assert.equal(connect.status, 200);
    const connectData = await connect.json();
    const authUrl = new URL(connectData.authUrl);
    assert.equal(authUrl.hostname, 'accounts.google.com');
    assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
    assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://app.example/api/tempmail-gmail-callback');
    const callbackUrl = `https://app.example/api/tempmail-gmail-callback?code=oauth-code&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`;
    const missingCookieCallback = await worker.fetch(new Request(callbackUrl));
    assert.equal(new URL(missingCookieCallback.headers.get('location')).searchParams.get('gmail'), 'error', 'OAuth callback must reject state not bound to the initiating browser');
    const cookie = connect.headers.get('set-cookie').split(';')[0];
    const callback = await worker.fetch(new Request(callbackUrl, { headers: { cookie } }), env);
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.headers.get('location')).pathname, '/tempmail');
    assert.equal(new URL(callback.headers.get('location')).searchParams.get('gmail'), 'connected', new URL(callback.headers.get('location')).searchParams.get('reason'));
    assert.equal(savedConnection.email, 'owner@gmail.com');
    assert.equal(savedConnection.refresh_token_ciphertext.includes('do-not-return-this-refresh-token'), false);

    const status = await worker.fetch(apiRequest('/api/tempmail?action=gmail-status', { token: 'admin-jwt', method: 'GET' }), env);
    assert.deepEqual(await status.json(), { configured: true, connected: true, email: 'owner@gmail.com' });

    const invalidTag = await worker.fetch(apiRequest('/api/tempmail?action=rotate&tag=bad%40gmail.com', { token: 'admin-jwt', body: {} }), env);
    assert.equal(invalidTag.status, 400);
    assert.equal(savedAlias, undefined);

    const generated = await worker.fetch(apiRequest('/api/tempmail?action=rotate&tag=signup-2026', { token: 'admin-jwt', body: {} }), env);
    assert.equal(generated.status, 200);
    const generatedData = await generated.json();
    assert.equal(generatedData.email, 'owner+signup-2026@gmail.com');
    assert.equal(savedAlias.provider, 'gmailapi');

    const inbox = await worker.fetch(apiRequest(`/api/tempmail?action=messages&email=${encodeURIComponent(generatedData.email)}`, { token: 'admin-jwt', method: 'GET' }), env);
    const inboxData = await inbox.json();
    assert.equal(inboxData.messages.length, 1, 'Only the plus alias recipient should be visible');
    assert.equal(inboxData.messages[0].subject, 'Verify your account');

    const message = await worker.fetch(apiRequest(`/api/tempmail?action=message&email=${encodeURIComponent(generatedData.email)}&messageId=alias-message`, { token: 'admin-jwt', method: 'GET' }), env);
    assert.equal((await message.json()).message.bodyText, 'Your verification code is 8321');

    const disconnected = await worker.fetch(apiRequest('/api/tempmail?action=gmail-disconnect', { token: 'admin-jwt', body: {} }), env);
    assert.equal(disconnected.status, 200);
    assert.equal((await disconnected.json()).disconnected, true);
    assert.equal(savedConnection, null);
    assert.equal(savedAlias, null);
    assert.ok(workerFetches.some((call) => call.url.includes('/gmail/v1/users/me/messages?')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Regresi: provider utama (pool OpenAI) ADA tetapi tidak ada akun yang bisa
// dipanggil — mis. seluruh akun kehabisan kredit. Dulu `/api/chat` langsung
// menjawab 503 dengan pesan pool dan TIDAK PERNAH mencoba provider lain,
// padahal alibaba sehat. Pengguna lalu mengira chat mati total.
test('/api/chat memakai provider lain saat pool OpenAI tidak punya akun yang bisa dipakai', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  const saved = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      // Tidak ada kunci `openai` di tabel: provider openai bergantung pada pool.
      return Response.json([
        // `base_url` boleh sudah memuat /v1; resolver menormalkannya.
        { provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      ]);
    }
    if (url.includes('/rest/v1/openai_accounts')) {
      // Akun ada, tetapi kehabisan kredit dan sudah permanen.
      return Response.json([{
        id: '99999999-9999-4999-8999-999999999999',
        account_email: 'habis@example.com',
        credential_kind: 'api_key',
        enabled: true,
        capabilities: ['chat'],
        daily_limit: 0,
        used_today: 1,
        quota_date: new Date().toISOString().slice(0, 10),
        last_error: 'You have no credits remaining. Add credits to continue using the API.',
        consecutive_failures: 1,
        cooldown_until: null,
      }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      return Response.json([{ id: 'k1', provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', enabled: true, priority: 10, consecutive_failures: 0 }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([{ provider: 'alibaba', model: 'qwen-plus' }]);
    }
    if (url.startsWith('https://dashscope-intl.aliyuncs.com/') && url.endsWith('/chat/completions')) {
      sent.push(JSON.parse(init.body).model);
      return Response.json({ choices: [{ message: { content: 'Jawaban dari alibaba.' } }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      saved.push(JSON.parse(init.body));
      return Response.json([{ id: 'msg-alibaba-1' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let res;
  let data;
  try {
    res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-openai-habis',
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    data = await res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 200, `harus dijawab provider lain, bukan error pool: ${JSON.stringify(data)}`);
  assert.equal(data.ok, true);
  assert.equal(data.reply, 'Jawaban dari alibaba.');
  assert.equal(data.provider, 'alibaba');
  // Jawaban harus terbaca sebagai cadangan, bukan seolah OpenAI yang menjawab.
  assert.equal(data.fallbackFrom, 'gpt-4o-mini');
  assert.equal(data.fallbackReason, 'openai_pool_needs_attention');
  assert.match(data.note, /openai/);
  assert.deepEqual(sent, ['qwen-plus']);
  assert.equal(saved.length, 1, 'pesan asisten tetap disimpan ke riwayat');
  assert.equal(saved[0].conversation_id, 'conv-openai-habis');
});

test('/api/chat tetap melaporkan pesan pool bila fallback dimatikan pengguna', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope.example' }]);
    }
    if (url.includes('/rest/v1/openai_accounts')) {
      return Response.json([{
        id: '88888888-8888-4888-8888-888888888888',
        credential_kind: 'api_key',
        enabled: true,
        capabilities: ['chat'],
        daily_limit: 0,
        used_today: 1,
        quota_date: new Date().toISOString().slice(0, 10),
        last_error: 'You have no credits remaining.',
        consecutive_failures: 1,
      }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let res;
  let data;
  try {
    res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-no-fallback',
        provider: 'openai',
        model: 'gpt-4o-mini',
        autoFallback: false,
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    data = await res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 503);
  assert.equal(data.code, 'openai_pool_needs_attention');
  assert.match(data.error, /kehabisan kredit OpenAI/);
});

// Regresi: cadangan DICOBA tetapi semuanya gagal. Dulu kegagalan itu ditelan
// (`continue`) sehingga respons hanya berisi pesan pool OpenAI — pengguna tidak
// bisa tahu bahwa alibaba sudah dicoba dan menolak dengan kode apa. Sekarang
// `triedDetails` harus memuat kegagalan cadangan tersebut.
test('/api/chat melaporkan provider cadangan yang ikut gagal saat pool OpenAI habis', async () => {
  const realFetch = globalThis.fetch;
  const sentModels = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      ]);
    }
    if (url.includes('/rest/v1/openai_accounts')) {
      return Response.json([{
        id: '77777777-7777-4777-8777-777777777777',
        account_email: 'habis@example.com',
        credential_kind: 'api_key',
        enabled: true,
        capabilities: ['chat'],
        daily_limit: 0,
        used_today: 1,
        quota_date: new Date().toISOString().slice(0, 10),
        last_error: 'You have no credits remaining. Add credits to continue using the API.',
        consecutive_failures: 1,
        cooldown_until: null,
      }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      return Response.json([{ id: 'k1', provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', enabled: true, priority: 10, consecutive_failures: 0 }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([{ provider: 'alibaba', model: 'qwen-plus' }]);
    }
    if (url.startsWith('https://dashscope-intl.aliyuncs.com/') && url.endsWith('/chat/completions')) {
      sentModels.push(JSON.parse(init.body).model);
      // Kunci alibaba ditolak: penyebab yang harus terbaca di layar.
      return new Response(JSON.stringify({ error: { message: 'Invalid API-key provided.', code: 'invalid_api_key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let res;
  let data;
  try {
    res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-cadangan-gagal',
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    data = await res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 503);
  assert.notEqual(data.ok, true);
  // Provider utama tetap dilaporkan sebagai sebab utama…
  assert.equal(data.code, 'openai_pool_needs_attention');
  assert.ok(sentModels.includes('qwen-plus'), 'cadangan benar-benar dipanggil');
  // …tetapi kegagalan cadangan TIDAK boleh hilang dari respons.
  const alibaba = (data.triedDetails || []).filter((entry) => entry.provider === 'alibaba');
  assert.ok(alibaba.length >= 1, `triedDetails harus memuat cadangan: ${JSON.stringify(data.triedDetails)}`);
  assert.equal(alibaba[0].status, 401);
  assert.match(String(alibaba[0].code), /invalid_api_key/);
});

// Regresi: katalog model bisa didominasi satu provider (102 model openai +
// 109 freebeat). Kueri kandidat lama memakai `limit=150`, jadi alibaba dan
// cloudflare TIDAK PERNAH masuk daftar kandidat dan fallback berakhir "tidak
// ada kandidat" tanpa satu pun percobaan. Tes ini meniru komposisi produksi.
test('/api/chat tetap menemukan kandidat cadangan walau katalog didominasi provider lain', async () => {
  const realFetch = globalThis.fetch;
  const sentModels = [];
  const openAiRows = Array.from({ length: 300 }, (_v, i) => ({ provider: 'openai', model: `gpt-4o-mini-${i}` }));
  const freebeatRows = Array.from({ length: 109 }, (_v, i) => ({ provider: 'freebeat', model: `${100 + i}` }));
  const alibabaRow = { provider: 'alibaba', model: 'qwen-plus' };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }]);
    }
    if (url.includes('/rest/v1/openai_accounts')) {
      return Response.json([{
        id: '66666666-6666-4666-8666-666666666666',
        account_email: 'habis@example.com',
        credential_kind: 'api_key',
        enabled: true,
        capabilities: ['chat'],
        daily_limit: 0,
        used_today: 1,
        quota_date: new Date().toISOString().slice(0, 10),
        last_error: 'You have no credits remaining. Add credits to continue using the API.',
        consecutive_failures: 1,
        cooldown_until: null,
      }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      return Response.json([{ id: 'k1', provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', enabled: true, priority: 10, consecutive_failures: 0 }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      // Patuhi `limit` seperti PostgREST, supaya batas kueri benar-benar diuji.
      const limit = Number(new URL(url).searchParams.get('limit')) || 1000;
      return Response.json([...openAiRows, ...freebeatRows, alibabaRow].slice(0, limit));
    }
    if (url.startsWith('https://dashscope-intl.aliyuncs.com/') && url.endsWith('/chat/completions')) {
      sentModels.push(JSON.parse(init.body).model);
      return Response.json({ choices: [{ message: { content: 'Jawaban qwen.' } }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-katalog-1' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let res;
  let data;
  try {
    res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-katalog-besar',
        provider: 'openai',
        model: 'gpt-4o-mini-0',
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    data = await res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 200, `fallback harus sampai ke alibaba, bukan "tidak ada kandidat": ${JSON.stringify(data)}`);
  assert.equal(data.provider, 'alibaba');
  assert.deepEqual(sentModels, ['qwen-plus']);
});

// Regresi: jalur yang dipakai web BLEA adalah `stream: true`. Dulu status
// fallback streaming hanya [400,404,429,502,503,504], sehingga kunci provider
// utama yang ditolak (401) atau kredit habis (402/403) TIDAK pernah dialihkan
// ke provider lain — chat tampak mati padahal alibaba sehat.
test('/api/chat stream:true dialihkan ke provider lain saat provider utama 401', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-1', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'openai', api_key: 'sk-openai-dead', base_url: 'https://api.openai.com' },
        { provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
      ]);
    }
    if (url.includes('/rest/v1/openai_accounts')) {
      // Pool OpenAI kosong → provider utama memakai kunci di provider_api_keys.
      return Response.json([]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_key_pool')) {
      return Response.json([{ id: 'k1', provider: 'alibaba', api_key: 'sk-alibaba-test', base_url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', enabled: true, priority: 10, consecutive_failures: 0 }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'openai', model: 'gpt-4o-mini' },
        { provider: 'alibaba', model: 'qwen-plus' },
      ]);
    }
    if (url === 'https://api.openai.com/v1/chat/completions') {
      sent.push('openai');
      return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.startsWith('https://dashscope-intl.aliyuncs.com/') && url.endsWith('/chat/completions')) {
      sent.push('alibaba');
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'Halo dari qwen.' } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    }
    if (url.startsWith('https://supabase.example/rest/v1/ai_messages')) {
      return Response.json([{ id: 'msg-stream-1' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let res;
  let text;
  try {
    res = await worker.fetch(apiRequest('/api/chat', {
      body: {
        conversationId: 'conv-stream-401',
        provider: 'openai',
        model: 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: 'Halo' }],
      },
    }), createEnv());
    text = await res.text();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(res.status, 200, text.slice(0, 300));
  assert.deepEqual(sent, ['openai', 'alibaba'], 'cadangan harus benar-benar dipanggil setelah 401');
  assert.match(text, /qwen-plus/, 'meta stream harus menyebut model cadangan');
  assert.match(text, /fallbackFrom/);
  assert.match(text, /Halo dari qwen\./);
});
