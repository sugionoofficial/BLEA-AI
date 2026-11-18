import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { resolveProviderApiBase, validateProviderBaseUrl } from '../src/lib/videoCatalog.js';
import { parseUpstreamSsePayload, splitThinkingContent, thinkingStageLabel } from '../src/lib/chatStream.js';

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
        { provider: 'openrouter', model: 'anthropic/claude-sonnet-4' },
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
    assert.ok(data.modelItems.some((item) => item.id === 'anthropic/claude-sonnet-4' && item.provider === 'openrouter'));
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
        { provider: 'openrouter', api_key: 'or-secret-key', base_url: 'https://openrouter.ai/api/v1' },
      ]);
    }
    if (url === 'https://openrouter.ai/api/v1/chat/completions') {
      capturedAuth = init.headers.authorization;
      return Response.json({ choices: [{ message: { content: 'OpenRouter siap membantu.' } }] });
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
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'user', content: 'Tes OpenRouter' }],
      },
    }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.provider, 'openrouter');
    assert.equal(data.reply, 'OpenRouter siap membantu.');
    assert.equal(capturedAuth, 'Bearer or-secret-key');
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

