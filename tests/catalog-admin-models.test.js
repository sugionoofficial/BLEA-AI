import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_ANON_KEY: 'anon-key',
    FREEBEAT_SESSION_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

function apiRequest(path, { method = 'POST', body = {}, token = 'admin-jwt' } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  });
}

test('/api/admin-models aggregates all registered providers across keys, key pool, freebeat oauth, models, and prices', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' } });
    }
    if (url.includes('/rest/v1/provider_models')) {
      return Response.json([
        { provider: 'alibaba', model: 'wan3.0-video', active: true },
        { provider: 'openai', model: 'sora-2', active: true },
      ]);
    }
    if (url.includes('/rest/v1/provider_api_keys')) {
      return Response.json([
        { provider: 'alibaba', label: 'Alibaba Model Studio', base_url: 'https://dashscope.aliyuncs.com', api_key: 'sk-a' },
        { provider: 'cloudflare', label: 'Cloudflare Workers AI', base_url: '', api_key: 'binding:AI' },
      ]);
    }
    if (url.includes('/rest/v1/provider_key_pool')) {
      return Response.json([
        { provider: 'kling', enabled: true },
      ]);
    }
    if (url.includes('/rest/v1/freebeat_oauth_accounts')) {
      return Response.json([
        { id: 'fb-1', enabled: true },
      ]);
    }
    if (url.includes('/rest/v1/freebeat_provider_sessions')) {
      return Response.json([]);
    }
    if (url.includes('/rest/v1/credit_model_prices')) {
      return Response.json([
        { provider: 'hailuo' },
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const res = await worker.fetch(apiRequest('/api/admin-models', { method: 'GET' }), createEnv());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.models.length, 2);
    const providerIds = body.providers.map((p) => p.provider);
    assert.ok(providerIds.includes('alibaba'));
    assert.ok(providerIds.includes('cloudflare'));
    assert.ok(providerIds.includes('openai'));
    assert.ok(providerIds.includes('kling'));
    assert.ok(providerIds.includes('freebeat'));
    assert.ok(providerIds.includes('hailuo'));
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('/api/catalog supports freebeat and built-in provider fallback with provider_key_pool', async () => {
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' } });
    }
    if (url.includes('/rest/v1/freebeat_oauth_accounts')) return Response.json([]);
    if (url.includes('/rest/v1/freebeat_provider_sessions')) return Response.json([]);
    if (url.includes('/rest/v1/provider_models')) return Response.json([]);
    if (url.includes('/rest/v1/credit_model_prices')) return Response.json([]);
    if (url.includes('/rest/v1/provider_api_keys')) return Response.json([]);
    if (url.includes('/rest/v1/provider_key_pool')) {
      return Response.json([{ api_key: 'sk-pool-openai', base_url: 'https://api.openai.com/v1' }]);
    }
    if (url === 'https://api.openai.com/v1/models') {
      return Response.json({ error: 'rate limited' }, { status: 429 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const fbRes = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'freebeat' } }), createEnv());
    assert.equal(fbRes.status, 200);
    const fbBody = await fbRes.json();
    const fbIds = fbBody.models.map((m) => m.id);
    assert.ok(fbIds.includes('122'));
    assert.ok(fbIds.includes('80'));
    assert.ok(fbIds.includes('202'));
    assert.ok(fbIds.includes('generate_dance_video'));

    const openaiRes = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'openai' } }), createEnv());
    assert.equal(openaiRes.status, 200);
    const openaiBody = await openaiRes.json();
    const openaiIds = openaiBody.models.map((m) => m.id);
    assert.ok(openaiIds.includes('sora-2'), 'Built-in video models must still surface in Katalog Model when upstream /models returns 429');
    assert.ok(openaiBody.warning);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
