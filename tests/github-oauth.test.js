import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon', GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  url = String(url);
  if (url.endsWith('/auth/v1/user')) {
    const token = options.headers.authorization?.replace('Bearer ', '');
    return Response.json(token === 'alice' || token === 'bob' ? { id: token } : {}, { status: token === 'alice' || token === 'bob' ? 200 : 401 });
  }
  if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'github-secret-token' });
  if (url === 'https://api.github.com/user') return Response.json({ login: 'github-alice' });
  if (url.startsWith('https://api.github.com/user/repos')) return Response.json([{ full_name: 'alice/project', default_branch: 'main' }]);
  throw new Error('Unexpected fetch: ' + url);
};
after(() => { globalThis.fetch = realFetch; });
const request = (path, { token, cookie, origin, method = 'POST', body } = {}) => new Request('https://blea.example' + path, {
  method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
});
const call = (path, options) => worker.fetch(request(path, options), env);

test('OAuth validates state, protects token and isolates BLEA users', async () => {
  assert.equal((await call('/api/auth/github/start')).status, 401);
  assert.equal((await call('/api/auth/github/start', { token: 'alice', origin: 'https://evil.example' })).status, 403);
  const start = await call('/api/auth/github/start', { token: 'alice' });
  assert.equal(start.status, 200);
  const stateCookie = start.headers.get('set-cookie').split(';')[0];
  assert.match(start.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const url = new URL((await start.json()).url);
  assert.equal(url.searchParams.get('scope'), 'repo');
  const state = url.searchParams.get('state');
  assert.ok(state);
  const bad = await call('/auth/github/callback?code=test&state=wrong', { method: 'GET', cookie: stateCookie });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /href="\/studio"/);
  const callback = await call(`/auth/github/callback?code=test&state=${state}`, { method: 'GET', cookie: stateCookie });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/studio');
  const header = callback.headers.get('set-cookie');
  assert.doesNotMatch(header, /github-secret-token/);
  const session = header.match(/__Host-blea_github=([^;,]+)/)[0];
  const alice = await call('/api/github/status', { token: 'alice', cookie: session });
  assert.equal((await alice.json()).login, 'github-alice');
  const bob = await call('/api/github/status', { token: 'bob', cookie: session });
  assert.equal((await bob.json()).connected, false);
  assert.equal((await call('/api/github/status', { cookie: session })).status, 401);
  const repos = await call('/api/repos', { token: 'alice', cookie: session });
  assert.equal((await repos.json()).repos[0].fullName, 'alice/project');
  assert.equal((await call('/api/github/tools/delete', { token: 'alice', cookie: session })).status, 403);
  assert.equal((await call('/api/github/tools/read', { token: 'alice', cookie: session })).status, 400);
  const logout = await call('/api/auth/github/logout', { token: 'alice', cookie: session });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
});

test('missing secret gives administrator guidance', async () => {
  const res = await worker.fetch(request('/api/auth/github/start', { token: 'alice' }), { ...env, GITHUB_CLIENT_SECRET: '' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /administrator/i);
});
