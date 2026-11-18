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
      assert.deepEqual(params.redirect_uris, ['https://blea-ai.blea-ai.workers.dev/api/freebeat/callback']);
      assert.equal(params.token_endpoint_auth_method, 'none');
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
