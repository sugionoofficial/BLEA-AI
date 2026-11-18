import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon', PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
const request = (path, { token, cookie, method = 'GET' } = {}) => new Request(`https://blea-ai.blea-ai.workers.dev${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) } });
const call = (path, options) => worker.fetch(request(path, options), env);

test('read-only Freebeat OAuth enforces admin, PKCE and browser state; MCP calls only balance', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let verifier;
  let rejectMcp = false;
  let rejectRevocation = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization?.replace('Bearer ', '');
      if (!['admin-token', 'other-admin', 'user-token'].includes(token)) return Response.json({}, { status: 401 });
      return Response.json({ id: token, app_metadata: { role: token === 'user-token' ? 'user' : 'admin' } });
    }
    if (url === 'https://freebeat.ai/oauth/register') {
      const params = JSON.parse(init.body);
      assert.deepEqual(params, {
        client_name: 'BLEA AI (uji MCP)',
        redirect_uris: ['https://blea-ai.blea-ai.workers.dev/api/freebeat/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: 'freebeat:read',
      });
      return Response.json({ client_id: 'client-123' });
    }
    if (url === 'https://freebeat.ai/oauth/token') {
      const body = new URLSearchParams(init.body);
      assert.equal(body.get('code'), 'valid-code');
      assert.equal(body.get('client_id'), 'client-123');
      assert.equal(body.get('grant_type'), 'authorization_code');
      verifier = body.get('code_verifier');
      return Response.json({ access_token: 'FREEBEAT-SENSITIVE-ACCESS-TOKEN', refresh_token: 'NEVER-STORE-REFRESH', token_type: 'Bearer', expires_in: 600 });
    }
    if (url === 'https://freebeat.ai/api/mcp') {
      if (rejectMcp) return Response.json({ error: 'secret should not appear' }, { status: 403 });
      assert.equal(init.headers.authorization, 'Bearer FREEBEAT-SENSITIVE-ACCESS-TOKEN');
      const body = JSON.parse(init.body); calls.push(body);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {} } }, { headers: { 'mcp-session-id': 'mcp-session' } });
      assert.equal(init.headers['Mcp-Session-Id'], 'mcp-session');
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      assert.equal(body.method, 'tools/call');
      assert.deepEqual(body.params, { name: 'get_credit_balance', arguments: {} });
      return new Response('event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"structuredContent":{"credits":500}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    if (url === 'https://freebeat.ai/oauth/revoke') return new Response(null, { status: rejectRevocation ? 503 : 200 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    assert.equal((await call('/api/freebeat/start', { method: 'POST' })).status, 401);
    assert.equal((await call('/api/freebeat/start', { token: 'user-token', method: 'POST' })).status, 403);
    const start = await call('/api/freebeat/start', { token: 'admin-token', method: 'POST' });
    assert.equal(start.status, 200);
    const pendingHeader = start.headers.get('set-cookie');
    assert.match(pendingHeader, /HttpOnly; Secure; SameSite=Lax/);
    const pendingCookie = pendingHeader.split(';')[0];
    const url = new URL((await start.json()).url);
    assert.equal(url.origin, 'https://freebeat.ai');
    assert.equal(url.searchParams.get('scope'), 'freebeat:read');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const state = url.searchParams.get('state');
    const mismatch = await call(`/api/freebeat/callback?code=valid-code&state=wrong`, { cookie: pendingCookie });
    assert.match(mismatch.headers.get('location'), /freebeat=invalid/);
    assert.equal(verifier, undefined);
    const callback = await call(`/api/freebeat/callback?code=valid-code&state=${state}`, { cookie: pendingCookie });
    assert.equal(callback.status, 303);
    assert.match(callback.headers.get('location'), /freebeat=connected/);
    assert.equal(Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url'), url.searchParams.get('code_challenge'));
    const headers = callback.headers.getSetCookie();
    assert.doesNotMatch(headers.join(';'), /FREEBEAT-SENSITIVE-ACCESS-TOKEN|NEVER-STORE-REFRESH/);
    const session = headers.find((h) => h.startsWith('__Host-blea_freebeat_session=')).split(';')[0];
    // Verify the encrypted session itself does not retain the upstream refresh token.
    const [iv, ciphertext] = session.slice(session.indexOf('=') + 1).split('.').map((part) => Buffer.from(part, 'base64url'));
    const encoded = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', encoded.encode(`blea-freebeat-mcp-v1:${env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY}`));
    const aes = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoded.encode('session') }, aes, ciphertext);
    const stored = JSON.parse(new TextDecoder().decode(plaintext));
    assert.deepEqual(Object.keys(stored).sort(), ['accessToken', 'clientId', 'expiresAt', 'imageAccess', 'uid']);
    assert.equal(stored.imageAccess, false);
    assert.equal(JSON.stringify(stored).includes('NEVER-STORE-REFRESH'), false);
    assert.equal((await (await call('/api/freebeat/status', { token: 'other-admin', cookie: session })).json()).connected, false);
    assert.equal((await call('/api/freebeat/balance', { token: 'other-admin', cookie: session, method: 'POST' })).status, 401);
    assert.equal((await call('/api/freebeat/balance', { token: 'user-token', cookie: session, method: 'POST' })).status, 403);
    assert.equal((await (await call('/api/freebeat/status', { token: 'admin-token', cookie: session })).json()).connected, true);
    const balance = await call('/api/freebeat/balance', { token: 'admin-token', cookie: session, method: 'POST' });
    assert.deepEqual((await balance.json()).balance, { credits: 500 });
    assert.deepEqual(calls.map((item) => item.method), ['initialize', 'notifications/initialized', 'tools/call']);
    rejectMcp = true;
    const denied = await call('/api/freebeat/balance', { token: 'admin-token', cookie: session, method: 'POST' });
    assert.equal(denied.status, 502);
    assert.match((await denied.json()).error, /periksa akses akun\/plan/);
    rejectRevocation = true;
    const revokeFailed = await call('/api/freebeat/disconnect', { token: 'admin-token', cookie: session, method: 'POST' });
    assert.equal((await revokeFailed.json()).revoked, false);
    assert.match(revokeFailed.headers.get('set-cookie'), /Max-Age=0/);
    rejectRevocation = false;
    const disconnect = await call('/api/freebeat/disconnect', { token: 'admin-token', cookie: session, method: 'POST' });
    assert.equal((await disconnect.json()).revoked, true);
    assert.match(disconnect.headers.get('set-cookie'), /Max-Age=0/);
  } finally { globalThis.fetch = realFetch; }
});

test('Freebeat connection cannot start without an encryption key', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
  try {
    const result = await worker.fetch(request('/api/freebeat/start', { token: 'admin', method: 'POST' }), { ...env, PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '' });
    assert.equal(result.status, 503);
    assert.match((await result.json()).error, /PROVIDER_CREDENTIAL_ENCRYPTION_KEY/);
  } finally { globalThis.fetch = realFetch; }
});

test('registration reports sanitized network, timeout and HTTP failures', async () => {
  const { startFreebeat } = await import('../src/lib/freebeatMcp.js');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(JSON.stringify(args));
  try {
    for (const [result, expected] of [
      [() => { throw Object.assign(new Error('secret-token-data'), { name: 'TypeError' }); }, 'FB-REGISTER-NETWORK'],
      [() => { throw Object.assign(new Error('secret-token-data'), { name: 'TimeoutError' }); }, 'FB-REGISTER-TIMEOUT'],
      [() => new Response('sensitive-provider-body', { status: 403 }), 'FB-REGISTER-HTTP'],
      [() => new Response('<html>sensitive-provider-body</html>', { status: 200 }), 'FB-REGISTER-RESPONSE'],
    ]) {
      globalThis.fetch = async () => result();
      await assert.rejects(startFreebeat(env, 'admin'), (error) => error.message.includes(expected) && !/secret-token-data|sensitive-provider-body/.test(error.message));
    }
    assert.doesNotMatch(logs.join(' '), /secret-token-data|sensitive-provider-body/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('OAuth registration follows only same-endpoint 307/308 redirects and refuses unsafe redirects', async () => {
  const { startFreebeat } = await import('../src/lib/freebeatMcp.js');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  const urls = [];
  try {
    globalThis.fetch = async (url, init) => {
      urls.push(String(url));
      assert.equal(init.redirect, 'manual');
      assert.equal(init.method, 'POST');
      if (urls.length === 1) return new Response(null, { status: 308, headers: { location: '/oauth/register/' } });
      return Response.json({ client_id: 'registered-client' });
    };
    assert.equal((await startFreebeat(env, 'admin')).status, 200);
    assert.deepEqual(urls, ['https://freebeat.ai/oauth/register', 'https://freebeat.ai/oauth/register/']);
    for (const [status, location] of [[307, 'https://evil.example/oauth/register'], [302, '/oauth/register/'], [308, '/oauth/register/?secret=x'], [307, '/other']]) {
      let count = 0;
      globalThis.fetch = async () => { count += 1; return new Response(null, { status, headers: { location } }); };
      await assert.rejects(startFreebeat(env, 'admin'), /FB-REGISTER-REDIRECT/);
      assert.equal(count, 1);
    }
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('callback reports a fixed safe diagnostic when token exchange fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
    if (url === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
    if (url === 'https://freebeat.ai/oauth/token') throw new Error('private-token-in-error');
    throw new Error('unexpected');
  };
  try {
    const start = await call('/api/freebeat/start', { token: 'admin-token', method: 'POST' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL((await start.json()).url).searchParams.get('state');
    const result = await call(`/api/freebeat/callback?code=very-secret-code&state=${state}`, { cookie });
    assert.match(result.headers.get('location'), /freebeat=failed-network/);
    assert.doesNotMatch(result.headers.get('location'), /private-token|very-secret-code/);
    assert.match(result.headers.get('set-cookie'), /Max-Age=0/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('OAuth token exchange never forwards code or verifier across origins', async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  const seen = [];
  globalThis.fetch = async (input) => {
    const url = String(input); seen.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
    if (url === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
    if (url === 'https://freebeat.ai/oauth/token') return new Response(null, { status: 307, headers: { location: 'https://evil.example/oauth/token' } });
    throw new Error('Unexpected fetch');
  };
  try {
    const start = await call('/api/freebeat/start', { token: 'admin-token', method: 'POST' });
    const pendingCookie = start.headers.get('set-cookie').split(';')[0];
    const state = new URL((await start.json()).url).searchParams.get('state');
    const result = await call(`/api/freebeat/callback?code=secret-code&state=${state}`, { cookie: pendingCookie });
    assert.match(result.headers.get('location'), /freebeat=failed-redirect/);
    assert.equal(seen.includes('https://evil.example/oauth/token'), false);
  } finally { globalThis.fetch = realFetch; console.warn = realWarn; }
});

test('registration surfaces only safe allowlisted OAuth errors, never provider descriptions or secrets', async () => {
  const { startFreebeat } = await import('../src/lib/freebeatMcp.js');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(JSON.stringify(args));
  try {
    globalThis.fetch = async () => Response.json({ error: 'invalid_redirect_uri', error_description: 'Only localhost accepted. secret-token-do-not-share' }, { status: 400 });
    await assert.rejects(startFreebeat(env, 'admin'), (err) => /invalid_redirect_uri/.test(err.message) && /localhost\/loopback/.test(err.message) && !err.message.includes('secret-token-do-not-share'));
    globalThis.fetch = async () => Response.json({ error: 'evil-secret-value', error_description: 'secret-token-do-not-share' }, { status: 400 });
    await assert.rejects(startFreebeat(env, 'admin'), (err) => /FB-REGISTER-HTTP/.test(err.message) && !/evil-secret-value|secret-token-do-not-share/.test(err.message));
    globalThis.fetch = async () => Response.json({ error: 'invalid_client_metadata', error_description: 'x'.repeat(18000) }, { status: 400 });
    await assert.rejects(startFreebeat(env, 'admin'), (err) => /FB-REGISTER-HTTP/.test(err.message) && !/invalid_client_metadata/.test(err.message));
    assert.doesNotMatch(logs.join(' '), /evil-secret-value|secret-token-do-not-share/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

// Simulate the complete OAuth handshake so tests exercise the same admin endpoint as the UI.
async function connectFixture() {
  const start = await call('/api/freebeat/start', { token: 'admin-token', method: 'POST' });
  assert.equal(start.status, 200);
  const pending = start.headers.get('set-cookie').split(';')[0];
  const state = new URL((await start.json()).url).searchParams.get('state');
  const callback = await call(`/api/freebeat/callback?code=test-code&state=${state}`, { cookie: pending });
  const sessionHeader = callback.headers.getSetCookie().find((h) => h.startsWith('__Host-blea_freebeat_session='));
  assert.ok(sessionHeader);
  return sessionHeader.split(';')[0];
}

function oauthFixture(url) {
  if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
  if (url === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
  if (url === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: 'SECRET-ACCESS-TOKEN', expires_in: 600 });
  return null;
}

function stageFor(body) {
  return body.method === 'initialize' ? 'init' : body.method === 'notifications/initialized' ? 'notify' : 'balance';
}
function successFor(body) {
  if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {} } });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  return Response.json({ jsonrpc: '2.0', id: 2, result: { structuredContent: { credits: 500 } } });
}

test('MCP diagnostic codes identify request stage, timeout, network, HTTP and redirect without exposing secrets', async () => {
  const originalFetch = globalThis.fetch, originalWarn = console.warn;
  const warnings = [];
  const urls = [];
  console.warn = (...args) => warnings.push(JSON.stringify(args));
  let failedStage = '', failure;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input); urls.push(url);
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Bearer SECRET-ACCESS-TOKEN');
    const body = JSON.parse(init.body);
    if (stageFor(body) === failedStage) return failure();
    return successFor(body);
  };
  try {
    const cookie = await connectFixture();
    for (const stage of ['init', 'notify', 'balance']) {
      failedStage = stage;
      for (const [kind, simulate] of [
        ['network', () => { throw new Error('SECRET-network-error'); }],
        ['timeout', () => { throw Object.assign(new Error('SECRET-timeout'), { name: 'TimeoutError' }); }],
        ['redirect', () => new Response('SECRET-redirect', { status: 307, headers: { location: 'https://evil.example/SECRET' } })],
        ['http', () => new Response('SECRET-response', { status: 403 })],
      ]) {
        failure = simulate;
        const res = await call('/api/freebeat/balance', { token: 'admin-token', cookie, method: 'POST' });
        const text = await res.text();
        assert.equal(res.status, 502);
        assert.ok(text.includes(`FB-MCP-${stage.toUpperCase()}-${kind.toUpperCase()}`), text);
        assert.doesNotMatch(text, /SECRET|evil\.example|ACCESS-TOKEN/);
      }
    }
    assert.equal(urls.includes('https://evil.example/SECRET'), false);
    assert.doesNotMatch(warnings.join(' '), /SECRET|evil\.example|ACCESS-TOKEN/);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('MCP accepts matching SSE event without waiting for stream closure and rejects malformed or oversized responses', async () => {
  const originalFetch = globalThis.fetch, originalWarn = console.warn;
  console.warn = () => {};
  let mode = 'open-stream';
  let cancelled = false;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    if (body.method !== 'initialize') return successFor(body);
    if (mode === 'open-stream') {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"id":999,"result":{}}\r\n\r\ndata: {"jsonrpc":"2.0","id":1,'));
          controller.enqueue(new TextEncoder().encode('"result":{"protocolVersion":"2025-03-26"}}\r\n\r\n'));
          // Deliberately leave the stream open.
        },
        cancel() { cancelled = true; },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (mode === 'oversize') return new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } });
    if (mode === 'rpc') return Response.json({ id: 1, error: { message: 'PRIVATE-PROVIDER-ERROR' } });
    if (mode === 'stream-error') return new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE-STREAM-ERROR')); } }), { headers: { 'content-type': 'application/json' } });
    if (mode === 'stream-timeout') return new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('PRIVATE-TIMEOUT'), { name: 'TimeoutError' })); } }), { headers: { 'content-type': 'application/json' } });
    return Response.json({ jsonrpc: '2.0', id: 999, result: { private: 'PRIVATE-RESPONSE' } });
  };
  try {
    const cookie = await connectFixture();
    const success = await call('/api/freebeat/balance', { token: 'admin-token', cookie, method: 'POST' });
    assert.deepEqual((await success.json()).balance, { credits: 500 });
    assert.equal(cancelled, true);
    for (const [testMode, expected] of [['oversize', 'SIZE'], ['rpc', 'RPC'], ['stream-error', 'NETWORK'], ['stream-timeout', 'TIMEOUT'], ['mismatch', 'RESPONSE']]) {
      mode = testMode;
      const res = await call('/api/freebeat/balance', { token: 'admin-token', cookie, method: 'POST' });
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.match(text, new RegExp(`FB-MCP-INIT-${expected}`));
      assert.doesNotMatch(text, /PRIVATE|SECRET/);
    }
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('admin image discovery uses only read-only MCP tools, filters schema and model data, and preserves session isolation', async () => {
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'user' ? 'user' : 'admin' } });
    }
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    providerCalls.push(body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    if (body.method === 'tools/list') {
      if (!body.params.cursor) return Response.json({ id: body.id, result: { tools: [
        { name: 'quote_generation', inputSchema: { type: 'object', description: 'SECRET PROVIDER BODY', required: ['tool_name', 'arguments'], properties: { tool_name: { type: 'string', enum: ['generate_image', 'SECRET_VALUE'] }, arguments: { type: 'object', properties: { model_id: { type: 'integer' }, prompt: { type: 'string', default: 'SECRET DEFAULT' } } } } } },
        { name: 'unrelated_tool', inputSchema: { type: 'object' } },
      ], nextCursor: 'secret-cursor' } });
      assert.equal(body.params.cursor, 'secret-cursor');
      return Response.json({ id: body.id, result: { tools: [{ name: 'generate_image', inputSchema: { type: 'object', properties: { max_credits: { type: 'integer' }, accept_unknown_cost: { type: 'boolean' } } } }] } });
    }
    assert.equal(body.method, 'tools/call');
    assert.deepEqual(body.params, { name: 'list_models', arguments: { type: 'image' } });
    return Response.json({ id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ models: [{ model_id: 108, display_name: 'Example image' }, { model_id: 'other-model', name: 'Other image', secret: 'SECRET-PRIVATE' }] }) }] } });
  };
  try {
    const cookie = await connectFixture();
    assert.equal((await call('/api/freebeat/image-schemas', { token: 'user', cookie, method: 'POST' })).status, 403);
    assert.equal((await call('/api/freebeat/image-models', { token: 'different-admin', cookie, method: 'POST' })).status, 401);
    assert.equal(providerCalls.length, 0);
    const schemaRes = await call('/api/freebeat/image-schemas', { token: 'admin-token', cookie, method: 'POST' });
    const schemaText = await schemaRes.text();
    assert.equal(schemaRes.status, 200);
    const schemas = JSON.parse(schemaText);
    assert.deepEqual(Object.keys(schemas.tools), ['quote_generation', 'generate_image']);
    assert.deepEqual(schemas.tools.quote_generation.required, ['tool_name', 'arguments']);
    assert.deepEqual(schemas.tools.quote_generation.properties.tool_name.known_enum_values, ['generate_image']);
    assert.equal(schemas.tools.quote_generation.properties.tool_name.enum_incomplete, true);
    assert.equal(schemas.tools.generate_image.properties.max_credits.type, 'integer');
    assert.equal(schemas.truncated, false);
    assert.doesNotMatch(schemaText, /SECRET|secret-cursor|unrelated_tool|ACCESS-TOKEN/);
    const modelRes = await call('/api/freebeat/image-models', { token: 'admin-token', cookie, method: 'POST' });
    const modelText = await modelRes.text();
    assert.equal(modelRes.status, 200);
    assert.deepEqual(JSON.parse(modelText).models, [{ model_id: 108, name: 'Example image' }, { model_id: 'other-model', name: 'Other image' }]);
    assert.doesNotMatch(modelText, /SECRET|ACCESS-TOKEN/);
    assert.deepEqual(providerCalls.map((body) => body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'initialize', 'notifications/initialized', 'tools/call']);
  } finally { globalThis.fetch = originalFetch; }
});

test('image discovery fails safely for invalid model shapes and repeating pagination cursor', async () => {
  const originalFetch = globalThis.fetch, originalWarn = console.warn;
  console.warn = () => {};
  let kind = 'models';
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    calls++;
    if (kind === 'schemas') return Response.json({ id: body.id, result: { tools: [], nextCursor: 'repeated' } });
    return Response.json({ id: body.id, result: { structuredContent: { unexpected: 'SECRET-DATA' } } });
  };
  try {
    const cookie = await connectFixture();
    let res = await call('/api/freebeat/image-models', { token: 'admin-token', cookie, method: 'POST' });
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /SECRET/);
    kind = 'schemas'; calls = 0;
    res = await call('/api/freebeat/image-schemas', { token: 'admin-token', cookie, method: 'POST' });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.match(text, /FB-MCP-INSPECT-RESPONSE/);
    assert.doesNotMatch(text, /repeated|SECRET/);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('image scope is optional, consented through a separate OAuth flow and tracked without saving refresh tokens', async () => {
  const originalFetch = globalThis.fetch;
  let returnedScope;
  let registrations = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'user' ? 'user' : 'admin' } });
    }
    if (url === 'https://freebeat.ai/oauth/register') {
      registrations++;
      const body = JSON.parse(init.body);
      assert.equal(body.scope, 'freebeat:read freebeat:generate');
      assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
      return Response.json({ client_id: 'client' });
    }
    if (url === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: 'SECRET-TOKEN', refresh_token: 'SECRET-REFRESH', expires_in: 600, ...(returnedScope === undefined ? {} : { scope: returnedScope }) });
    throw new Error('unexpected request');
  };
  try {
    assert.equal((await call('/api/freebeat/start-image', { method: 'POST' })).status, 401);
    assert.equal((await call('/api/freebeat/start-image', { token: 'user', method: 'POST' })).status, 403);
    assert.equal(registrations, 0);
    for (const [scope, expected, hasAccess] of [
      [undefined, 'connected', true],
      ['freebeat:read freebeat:generate', 'connected', true],
      ['freebeat:read', 'connected-limited', false],
      ['freebeat:generate', 'failed', false],
    ]) {
      returnedScope = scope;
      const start = await call('/api/freebeat/start-image', { token: 'admin-token', method: 'POST' });
      assert.equal(start.status, 200);
      const auth = new URL((await start.json()).url);
      assert.equal(auth.searchParams.get('scope'), 'freebeat:read freebeat:generate');
      const pending = start.headers.get('set-cookie').split(';')[0];
      const callback = await call(`/api/freebeat/callback?code=test&state=${auth.searchParams.get('state')}`, { cookie: pending });
      assert.ok(callback.headers.get('location').endsWith(`freebeat=${expected}`));
      assert.doesNotMatch(callback.headers.getSetCookie().join(';'), /SECRET-TOKEN|SECRET-REFRESH/);
      if (expected === 'failed') {
        assert.equal(callback.headers.getSetCookie().some((h) => h.startsWith('__Host-blea_freebeat_session=')), false);
        continue;
      }
      const session = callback.headers.getSetCookie().find((h) => h.startsWith('__Host-blea_freebeat_session=')).split(';')[0];
      const status = await (await call('/api/freebeat/status', { token: 'admin-token', cookie: session })).json();
      assert.equal(status.imageAccess, hasAccess);
      assert.equal((await (await call('/api/freebeat/status', { token: 'different-admin', cookie: session })).json()).imageAccess, false);
    }
  } finally { globalThis.fetch = originalFetch; }
});

function quoteRequest({ token = 'admin-token', cookie, origin = 'https://blea-ai.blea-ai.workers.dev', contentType = 'application/json', body = JSON.stringify({ model_id: 108, prompt: '  Sebuah kucing  ' }) } = {}) {
  return worker.fetch(new Request('https://blea-ai.blea-ai.workers.dev/api/freebeat/image-quote', {
    method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': contentType }, body,
  }), env);
}

test('image quote is read-only, admin-gated, validates input and returns only filtered diagnostic data', async () => {
  const originalFetch = globalThis.fetch, originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(JSON.stringify(args));
  const mcpCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'user' ? 'user' : 'admin' } });
    }
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body); mcpCalls.push(body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    assert.deepEqual(body.params, { name: 'quote_generation', arguments: { tool: 'generate_image', parameters: { model_id: 108, prompt: 'Sebuah kucing' } } });
    return Response.json({ id: body.id, result: { structuredContent: { tool: 'generate_image', credits: 12, actual_price: '12.5', available: true, token: 'SECRET-TOKEN', prompt: 'SECRET-PROMPT', message: 'SECRET-MESSAGE', billing: { estimated: 12 }, notes: ['SECRET-NOTE'] } } });
  };
  try {
    const cookie = await connectFixture();
    assert.equal((await quoteRequest({ token: null, cookie })).status, 401);
    assert.equal((await quoteRequest({ token: 'user', cookie })).status, 403);
    assert.equal((await quoteRequest({ token: 'another-admin', cookie })).status, 401);
    assert.equal((await quoteRequest({ cookie, origin: 'https://evil.example' })).status, 403);
    assert.equal((await quoteRequest({ cookie, origin: null })).status, 403);
    assert.equal((await quoteRequest({ cookie, contentType: 'text/plain' })).status, 400);
    assert.equal((await quoteRequest({ cookie, body: JSON.stringify({ model_id: 108, prompt: 'x', max_credits: 100 }) })).status, 400);
    assert.equal((await quoteRequest({ cookie, body: JSON.stringify({ model_id: '108', prompt: 'x' }) })).status, 400);
    assert.equal((await quoteRequest({ cookie, body: JSON.stringify({ model_id: 108, prompt: ' '.repeat(3) }) })).status, 400);
    assert.equal((await quoteRequest({ cookie, body: JSON.stringify({ model_id: 108, prompt: 'x'.repeat(2001) }) })).status, 400);
    assert.equal((await quoteRequest({ cookie, body: 'x'.repeat(16385) })).status, 400);
    assert.equal((await call('/api/freebeat/image-generate', { token: 'admin-token', cookie, method: 'POST' })).status, 404);
    assert.equal(mcpCalls.length, 0);
    const result = await quoteRequest({ cookie });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    const text = await result.text();
    assert.deepEqual(JSON.parse(text).quote, { tool: 'generate_image', credits: 12, actual_price: '12.5', available: true, message: '[teks disembunyikan]', billing: { estimated: 12 }, notes: ['[teks disembunyikan]'] });
    assert.doesNotMatch(text, /SECRET|Sebuah kucing/);
    assert.doesNotMatch(logs.join(' '), /SECRET|Sebuah kucing/);
    assert.deepEqual(mcpCalls.map((call) => call.method), ['initialize', 'notifications/initialized', 'tools/call']);
  } finally { globalThis.fetch = originalFetch; console.warn = originalWarn; }
});

test('quote diagnostic reveals only fixed recognized status words and never authorizes generation', async () => {
  const originalFetch = globalThis.fetch;
  let status = 'quoted';
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    assert.deepEqual(body.params, { name: 'quote_generation', arguments: { tool: 'generate_image', parameters: { model_id: 108, prompt: 'Sebuah kucing' } } });
    return Response.json({ id: body.id, result: { structuredContent: { status, credits: 23, source: 'PRIVATE-SOURCE', message: 'PRIVATE-MESSAGE', nested: { status }, arbitrary: status, token: 'PRIVATE-TOKEN' } } });
  };
  try {
    const cookie = await connectFixture();
    for (const [input, expected] of [['quoted', 'quoted'], ['OK', 'ok'], ['priced', 'priced'], ['unavailable', 'unavailable'], ['PRIVATE-TOKEN', '[teks disembunyikan]'], ['priced PRIVATE-TOKEN', '[teks disembunyikan]']]) {
      status = input;
      const res = await quoteRequest({ cookie });
      assert.equal(res.status, 200);
      const text = await res.text();
      const { quote } = JSON.parse(text);
      assert.equal(quote.status, expected);
      assert.equal(quote.nested.status, expected);
      assert.equal(quote.credits, 23);
      assert.equal(quote.source, '[teks disembunyikan]');
      assert.equal(quote.message, '[teks disembunyikan]');
      assert.equal(quote.arbitrary, input === 'unavailable' ? 'unavailable' : '[teks disembunyikan]');
      assert.doesNotMatch(text, /PRIVATE|Sebuah kucing/);
    }
    assert.equal(calls.filter((call) => call.method === 'tools/call').length, 6);
    assert.ok(calls.filter((call) => call.method === 'tools/call').every((call) => call.params.name === 'quote_generation'));
  } finally { globalThis.fetch = originalFetch; }
});

test('video discovery is read-only and admin-isolated, filtering tool schemas and model catalog', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'user' ? 'user' : 'admin' } });
    }
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body); calls.push(body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    if (body.method === 'tools/list') return Response.json({ id: body.id, result: { tools: [
      { name: 'generate_video', inputSchema: { type: 'object', description: 'SECRET-PRIVATE', required: ['model_id', 'prompt'], properties: { model_id: { type: 'integer' }, prompt: { type: 'string', default: 'SECRET' }, generation_type: { type: 'string', enum: ['text', 'image', 'transition', 'reference', 'SECRET-VALUE'] }, max_credits: { type: 'number' } } } },
      { name: 'quote_generation', inputSchema: { type: 'object', properties: { tool: { type: 'string', enum: ['generate_video', 'generate_image', 'SECRET-VALUE'] } } } },
      { name: 'generate_image', inputSchema: { type: 'object' } },
    ] } });
    assert.deepEqual(body.params, { name: 'list_models', arguments: { type: 'video' } });
    return Response.json({ id: body.id, result: { structuredContent: { models: [{ model_id: 50, name: 'Example Video', secret: 'SECRET' }] } } });
  };
  try {
    const cookie = await connectFixture();
    assert.equal((await call('/api/freebeat/video-models', { token: 'user', cookie, method: 'POST' })).status, 403);
    assert.equal((await call('/api/freebeat/video-schemas', { token: 'other-admin', cookie, method: 'POST' })).status, 401);
    assert.equal((await call('/api/freebeat/video-models', { method: 'POST' })).status, 401);
    assert.equal(calls.length, 0);
    const models = await call('/api/freebeat/video-models', { token: 'admin-token', cookie, method: 'POST' });
    assert.equal(models.status, 200);
    const modelText = await models.text();
    assert.deepEqual(JSON.parse(modelText).models, [{ model_id: 50, name: 'Example Video' }]);
    assert.doesNotMatch(modelText, /SECRET/);
    const schemas = await call('/api/freebeat/video-schemas', { token: 'admin-token', cookie, method: 'POST' });
    assert.equal(schemas.status, 200);
    const schemaText = await schemas.text();
    const tools = JSON.parse(schemaText).tools;
    assert.deepEqual(Object.keys(tools), ['generate_video', 'quote_generation']);
    assert.deepEqual(tools.generate_video.properties.generation_type.known_enum_values, ['text', 'image', 'transition', 'reference']);
    assert.equal(tools.generate_video.properties.generation_type.enum_incomplete, true);
    assert.deepEqual(tools.quote_generation.properties.tool.known_enum_values, ['generate_video', 'generate_image']);
    assert.doesNotMatch(schemaText, /SECRET|generate_image\":\{/);
    assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/call', 'initialize', 'notifications/initialized', 'tools/list']);
    assert.equal(calls.filter((c) => c.method === 'tools/call').every((c) => c.params.name === 'list_models'), true);
  } finally { globalThis.fetch = originalFetch; }
});

test('Wan video help and quote are admin-only, bounded read-only diagnostics with filtered output', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'user' ? 'user' : 'admin' } });
    }
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    calls.push(body.params);
    if (body.params.name === 'get_model_help') {
      assert.deepEqual(body.params.arguments, { type: 'video', model_id: 182 });
      return Response.json({ id: body.id, result: { structuredContent: { generation_types: ['image', 'text'], resolutions: ['720p', '1080p', 'SECRET'], duration: [5, 10], description: 'SECRET-MESSAGE', token: 'SECRET-TOKEN', url: 'https://SECRET.example' } } });
    }
    assert.deepEqual(body.params, { name: 'quote_generation', arguments: { tool: 'generate_video', parameters: { model_id: 182, prompt: 'Seekor kucing berjalan', generation_type: 'image', duration: 5, resolution: '480p', images: ['https://images.example/cat.png?signature=SECRET'] } } });
    return Response.json({ id: body.id, result: { structuredContent: { status: 'quoted', credits: 42, prompt: 'SECRET-PROMPT', images: ['https://images.example/SECRET'], message: 'SECRET-MESSAGE' } } });
  };
  const invoke = (action, { cookie, token = 'admin-token', origin = 'https://blea-ai.blea-ai.workers.dev', contentType = 'application/json', data = {} } = {}) => worker.fetch(new Request(`https://blea-ai.blea-ai.workers.dev/api/freebeat/${action}`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': contentType }, body: JSON.stringify(data) }), env);
  try {
    const cookie = await connectFixture();
    assert.equal((await invoke('video-help', { cookie, token: 'user' })).status, 403);
    assert.equal((await invoke('video-help', { cookie, token: 'other-admin' })).status, 401);
    assert.equal((await invoke('video-help', { cookie, origin: 'https://evil.example' })).status, 403);
    assert.equal((await invoke('video-help', { cookie, data: { model_id: 80 } })).status, 400);
    assert.equal((await invoke('video-quote', { cookie, contentType: 'text/plain' })).status, 400);
    for (const data of [
      { prompt: 'x', image_url: 'http://images.example/cat.png' },
      { prompt: 'x', image_url: 'https://127.0.0.1/cat.png' },
      { prompt: 'x', image_url: 'https://user:pass@images.example/cat.png' },
      { prompt: ' ', image_url: 'https://images.example/cat.png' },
      { prompt: 'x', image_url: 'https://images.example/cat.png', max_credits: 10 },
      { prompt: 'x', image_url: 'https://images.example/cat.png', model_id: 80 },
      { prompt: 'x', image_url: 'https://images.example/cat.png', duration: 10, resolution: '1080p' },
    ]) assert.equal((await invoke('video-quote', { cookie, data })).status, 400);
    assert.equal(calls.length, 0);
    const help = await invoke('video-help', { cookie });
    assert.equal(help.status, 200);
    assert.equal(help.headers.get('cache-control'), 'no-store');
    const helpText = await help.text();
    assert.doesNotMatch(helpText, /SECRET/);
    assert.deepEqual(JSON.parse(helpText).help.generation_types, ['image', 'text']);
    assert.deepEqual(JSON.parse(helpText).help.resolutions, ['720p', '1080p', '[teks disembunyikan]']);
    const quote = await invoke('video-quote', { cookie, data: { prompt: ' Seekor kucing berjalan ', image_url: ' https://images.example/cat.png?signature=SECRET ' } });
    assert.equal(quote.status, 200);
    const text = await quote.text();
    assert.doesNotMatch(text, /SECRET|Seekor kucing/);
    assert.equal(JSON.parse(text).quote.credits, 42);
    assert.deepEqual(calls.map((c) => c.name), ['get_model_help', 'quote_generation']);
  } finally { globalThis.fetch = originalFetch; }
});

test('Gemini video model help and quote use fixed read-only settings and remain admin isolated', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'user' ? 'user' : 'admin' } });
    }
    const oauth = oauthFixture(url);
    if (oauth) return oauth;
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    if (body.method === 'initialize' || body.method === 'notifications/initialized') return successFor(body);
    calls.push(body.params);
    if (body.params.name === 'get_model_help') {
      assert.deepEqual(body.params.arguments, { type: 'video', model_id: 192 });
      return Response.json({ id: body.id, result: { structuredContent: { available: true, generation_types: ['image'], token: 'SECRET', message: 'SECRET' } } });
    }
    assert.deepEqual(body.params, { name: 'quote_generation', arguments: { tool: 'generate_video', parameters: { model_id: 192, generation_type: 'image', duration: 5, resolution: '480p', prompt: 'Kucing berjalan', images: ['https://images.example/a.png?signature=SECRET'] } } });
    return Response.json({ id: body.id, result: { structuredContent: { status: 'quoted', credits: 25, prompt: 'SECRET', image_url: 'SECRET', message: 'SECRET' } } });
  };
  const invoke = (action, { cookie, token = 'admin-token', origin = 'https://blea-ai.blea-ai.workers.dev', data = {} } = {}) => worker.fetch(new Request(`https://blea-ai.blea-ai.workers.dev/api/freebeat/${action}`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), 'content-type': 'application/json' }, body: JSON.stringify(data) }), env);
  try {
    const cookie = await connectFixture();
    assert.equal((await invoke('video-gemini-help', { cookie, token: 'user' })).status, 403);
    assert.equal((await invoke('video-gemini-help', { cookie, token: 'other-admin' })).status, 401);
    assert.equal((await invoke('video-gemini-help', { cookie, origin: 'https://evil.example' })).status, 403);
    assert.equal((await invoke('video-gemini-help', { cookie, data: { model_id: 182 } })).status, 400);
    assert.equal((await invoke('video-gemini-quote', { cookie, data: { prompt: 'x', image_url: 'https://images.example/a.png', max_credits: 100 } })).status, 400);
    assert.equal((await invoke('video-gemini-quote', { cookie, data: { prompt: 'x', image_url: 'http://images.example/a.png' } })).status, 400);
    assert.equal(calls.length, 0);
    const help = await invoke('video-gemini-help', { cookie });
    assert.equal(help.status, 200); assert.equal(help.headers.get('cache-control'), 'no-store');
    const helpText = await help.text(); assert.doesNotMatch(helpText, /SECRET/);
    assert.equal(JSON.parse(helpText).model_id, 192);
    const quote = await invoke('video-gemini-quote', { cookie, data: { prompt: 'Kucing berjalan', image_url: 'https://images.example/a.png?signature=SECRET' } });
    const text = await quote.text();
    assert.equal(quote.status, 200); assert.doesNotMatch(text, /SECRET|Kucing berjalan/);
    assert.equal(JSON.parse(text).quote.credits, 25);
    assert.deepEqual(calls.map((c) => c.name), ['get_model_help', 'quote_generation']);
  } finally { globalThis.fetch = originalFetch; }
});
