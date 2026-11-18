import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { boundedJson } from '../src/lib/boundedJson.js';

test('removed website-cookie balance route does not contact Freebeat even for admins', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    assert.equal(String(input), 'https://supabase.example/auth/v1/user');
    return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
  };
  try {
    const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon' };
    const request = new Request('https://blea.example/api/freebeat/site-balance', { method: 'POST', headers: { authorization: 'Bearer admin', origin: 'https://blea.example', 'content-type': 'application/json' }, body: JSON.stringify({ cookie: 'authToken=secret' }) });
    const result = await worker.fetch(request, env);
    assert.equal(result.status, 404);
    assert.doesNotMatch(await result.text(), /secret/);
    assert.deepEqual(calls, ['https://supabase.example/auth/v1/user']);
  } finally { globalThis.fetch = original; }
});

test('shared bounded JSON parser preserves limits and rejects malformed payloads', async () => {
  assert.deepEqual(await boundedJson(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(boundedJson(new Response('a'.repeat(16385))), /too large/);
  await assert.rejects(boundedJson(new Response('x', { headers: { 'content-length': '16385' } })), /too large/);
  await assert.rejects(boundedJson(new Response('{broken')), SyntaxError);
  await assert.rejects(boundedJson(new Response(new Uint8Array([0xff]))), TypeError);
});
