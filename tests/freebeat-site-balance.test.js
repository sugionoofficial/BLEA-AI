import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { boundedJson } from '../src/lib/boundedJson.js';

test('removed website-cookie balance route does not contact Freebeat even for admins', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    // Inti test ini: rute yang sudah dihapus tidak boleh menghubungi Freebeat
    // atau membocorkan cookie. Sejak fix39 gerbang status akun menambahkan dua
    // panggilan Supabase (auth + profiles) sebelum rute menjawab 404.
    assert.ok(url.startsWith('https://supabase.example/'), `tidak boleh ada panggilan ke luar Supabase: ${url}`);
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([{ id: 'admin', status: 'active' }]);
    assert.equal(url, 'https://supabase.example/auth/v1/user');
    return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
  };
  try {
    const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon' };
    const request = new Request('https://blea.example/api/freebeat/site-balance', { method: 'POST', headers: { authorization: 'Bearer admin', origin: 'https://blea.example', 'content-type': 'application/json' }, body: JSON.stringify({ cookie: 'authToken=secret' }) });
    const result = await worker.fetch(request, env);
    assert.equal(result.status, 404);
    assert.doesNotMatch(await result.text(), /secret/);
    assert.deepEqual(calls, [
      'https://supabase.example/auth/v1/user',
      'https://supabase.example/rest/v1/profiles?id=eq.admin&select=status&limit=1',
      'https://supabase.example/auth/v1/user',
    ]);
    assert.equal(calls.some((url) => url.includes('freebeat.ai')), false, 'Freebeat tidak boleh dihubungi');
  } finally { globalThis.fetch = original; }
});

test('shared bounded JSON parser preserves limits and rejects malformed payloads', async () => {
  assert.deepEqual(await boundedJson(new Response('{"ok":true}')), { ok: true });
  await assert.rejects(boundedJson(new Response('a'.repeat(16385))), /too large/);
  await assert.rejects(boundedJson(new Response('x', { headers: { 'content-length': '16385' } })), /too large/);
  await assert.rejects(boundedJson(new Response('{broken')), SyntaxError);
  await assert.rejects(boundedJson(new Response(new Uint8Array([0xff]))), TypeError);
});
