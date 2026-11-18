import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const origin = 'https://blea-ai.blea-ai.workers.dev';
const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon', ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
const secret = 'session=VERY-PRIVATE-COOKIE; other=VALUE';
function call({ token = 'admin', cookie = secret, originHeader = origin, contentType = 'application/json', body } = {}) {
  return worker.fetch(new Request(`${origin}/api/freebeat/site-balance`, {
    method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(originHeader ? { origin: originHeader } : {}), 'content-type': contentType },
    body: body ?? JSON.stringify({ cookie }),
  }), env);
}

test('website balance test is admin-only, one-shot, fixed destination, and sanitizes results', async () => {
  const original = globalThis.fetch;
  let siteCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const token = init.headers.authorization.replace('Bearer ', '');
      return Response.json({ id: token, app_metadata: { role: token === 'admin' ? 'admin' : 'user' } });
    }
    assert.equal(url, 'https://freebeat.ai/api/proxy/v1/user/credits/findCredits');
    siteCalls++;
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.cookie, secret);
    assert.equal(init.headers.authorization, undefined);
    return Response.json({ code: 0, msg: 'sensitive-provider-message', data: { totalCredits: 800, free: '500', boost: '300', membership: '0', event: '0', private: 'SENSITIVE-DATA' }, cookie: secret });
  };
  try {
    assert.equal((await call({ token: null })).status, 401);
    assert.equal((await call({ token: 'user' })).status, 403);
    assert.equal((await call({ originHeader: 'https://evil.example' })).status, 403);
    assert.equal((await call({ originHeader: null })).status, 403);
    assert.equal((await call({ contentType: 'text/plain' })).status, 400);
    assert.equal((await call({ cookie: 'session=foo\r\nAuthorization: bearer' })).status, 400);
    assert.equal((await call({ cookie: 'Cookie: session=foo' })).status, 400);
    assert.equal((await call({ cookie: `session=${'x'.repeat(8193)}` })).status, 400);
    assert.equal((await call({ body: 'x'.repeat(16385) })).status, 400);
    assert.equal(siteCalls, 0);
    const res = await call();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('set-cookie'), null);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { ok: true, balance: { totalCredits: 800, free: 500, boost: 300, membership: 0, event: 0 } });
    assert.doesNotMatch(text, /VERY-PRIVATE|SENSITIVE|sensitive-provider-message/);
    assert.equal(siteCalls, 1);
  } finally { globalThis.fetch = original; }
});

test('website balance test rejects redirects, errors, malformed or oversized responses without leaking secrets', async () => {
  const original = globalThis.fetch;
  const originalLog = console.log, originalWarn = console.warn, originalError = console.error;
  const logs = [];
  console.log = console.warn = console.error = (...args) => logs.push(JSON.stringify(args));
  let upstream;
  let calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
    if (url !== 'https://freebeat.ai/api/proxy/v1/user/credits/findCredits') throw new Error('Unexpected destination');
    if (typeof upstream === 'function') return upstream();
    return upstream;
  };
  try {
    const cases = [
      () => new Response(null, { status: 307, headers: { location: 'https://evil.example/steal' } }),
      () => Response.json({ error: secret }, { status: 401 }),
      () => Response.json({ code: 4, msg: secret, data: { totalCredits: 999 } }),
      () => Response.json({ code: 0, data: { totalCredits: 'Infinity' }, msg: secret }),
      () => new Response(`{"secret":"${'x'.repeat(17000)}"}`),
      () => new Response('not json'),
      () => { throw new Error(secret); },
    ];
    for (const make of cases) {
      upstream = make;
      const res = await call();
      assert.equal(res.status, 502);
      assert.doesNotMatch(await res.text(), /VERY-PRIVATE|evil\.example|session=/);
      assert.equal(res.headers.get('set-cookie'), null);
    }
    assert.equal(calls.includes('https://evil.example/steal'), false);
    assert.doesNotMatch(logs.join(' '), /VERY-PRIVATE|session=/);
  } finally { globalThis.fetch = original; console.log = originalLog; console.warn = originalWarn; console.error = originalError; }
});
