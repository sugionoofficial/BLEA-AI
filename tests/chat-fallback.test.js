import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

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

test('/api/enabled-models filters out video & non-chat models and returns modelItems with providers', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json([
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
    assert.deepEqual(data.models, ['gpt-oss-120b:free', 'anthropic/claude-sonnet-4']);
    assert.deepEqual(data.modelItems, [
      { id: 'gpt-oss-120b:free', provider: 'unorouter' },
      { id: 'anthropic/claude-sonnet-4', provider: 'openrouter' },
    ]);
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
  } finally {
    globalThis.fetch = realFetch;
  }
});
