import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import worker from '../src/worker.js';

const base = 'https://blea-ai.blea-ai.workers.dev';
const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'FAKE-SERVICE-SECRET', PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } };
function api(path, { token = 'admin', cookie, method = 'GET', data, origin = base } = {}) {
  return worker.fetch(new Request(`${base}/api/freebeat/${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(data !== undefined ? { 'content-type': 'application/json', origin } : {}) }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }), env);
}
async function connect(token = 'admin') {
  const res = await api('start', { token, method: 'POST' });
  assert.equal(res.status, 200);
  const pending = res.headers.get('set-cookie').split(';')[0];
  const state = new URL((await res.json()).url).searchParams.get('state');
  const callback = await api(`callback?code=code&state=${state}`, { token: null, cookie: pending });
  const session = callback.headers.getSetCookie().find((v) => v.startsWith('__Host-blea_freebeat_session='));
  assert.ok(session);
  return session.split(';')[0];
}
function fixture() {
  const rows = new Map(), calls = [];
  let scope = 'freebeat:read freebeat:generate', quote = { status: 'quoted', credits: 23 }, generateMode = 'success', tokenValue = 'PROVIDER-SECRET', dbMode = 'ok';
  return {
    rows, calls,
    setScope(value) { scope = value; },
    setQuote(value) { quote = value; },
    setGenerateMode(value) { generateMode = value; },
    setToken(value) { tokenValue = value; },
    setDbMode(value) { dbMode = value; },
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      if (url.href === 'https://supabase.example/auth/v1/user') {
        const bearer = init.headers.authorization.replace('Bearer ', '');
        return Response.json({ id: bearer, app_metadata: { role: bearer === 'user' ? 'user' : 'admin' } });
      }
      if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
      if (url.href === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: tokenValue, expires_in: 600, scope });
      if (url.pathname === '/rest/v1/freebeat_admin_image_tests') {
        assert.equal(init.redirect, 'manual');
        if (dbMode === 'unavailable') return new Response('SECRET-DB-BODY', { status: 503 });
        if (init.method === 'POST') {
          const row = JSON.parse(init.body);
          if (rows.has(row.id) || [...rows.values()].some((other) => other.admin_id === row.admin_id && ['unknown', 'dispatching'].includes(other.status))) return new Response(null, { status: 409 });
          row.created_at = new Date().toISOString(); rows.set(row.id, row);
          if (dbMode === 'insert-uncertain') throw new Error('SECRET-DB-TIMEOUT');
          return Response.json([row]);
        }
        if (init.method === 'PATCH') {
          if (dbMode === 'patch-fails') return new Response(null, { status: 503 });
          const id = url.searchParams.get('id').slice(3), row = rows.get(id);
          if (!row || row.admin_id !== url.searchParams.get('admin_id').slice(3) || row.status !== 'dispatching') return Response.json([]);
          Object.assign(row, JSON.parse(init.body)); return Response.json([row]);
        }
        const owner = url.searchParams.get('admin_id').slice(3);
        const id = url.searchParams.get('id')?.slice(3);
        return Response.json([...rows.values()].filter((row) => row.admin_id === owner && (!id || row.id === id)));
      }
      assert.equal(url.href, 'https://freebeat.ai/api/mcp');
      const body = JSON.parse(init.body); calls.push(body);
      if (body.method === 'initialize') return Response.json({ id: body.id, result: { protocolVersion: '2025-03-26' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      let data;
      if (body.params.name === 'list_models') data = { models: [{ model_id: 80, name: 'Nano Banana 2' }] };
      else if (body.params.name === 'get_model_help') { assert.deepEqual(body.params.arguments, { type: 'image', model_id: 80 }); data = { model_id: 80 }; }
      else if (body.params.name === 'quote_generation') { assert.deepEqual(body.params.arguments, { tool: 'generate_image', parameters: { model_id: 80, prompt: 'test prompt' } }); data = quote; }
      else if (body.params.name === 'generate_image') {
        assert.deepEqual(body.params.arguments, { model_id: 80, prompt: 'test prompt', max_credits: 23 });
        if (generateMode === 'lost') throw new Error('PRIVATE-NETWORK-ERROR');
        if (generateMode === 'bad') data = { batch_id: 'not a valid id', secret: 'SECRET-DATA' };
        else data = { batch_id: 'batch-123', secret: 'SECRET-DATA' };
      } else if (body.params.name === 'get_task_status') {
        assert.deepEqual(body.params.arguments, { task_id: 'batch-123' });
        data = { status: 'completed', items: [{ image_url: 'https://cdn.example/image.png' }, { image_url: 'javascript:alert(1)' }, { image_url: 'https://user:pass@example.com/img' }], billing: { charged: 23, refunded: null, net: 23, refund_state: 'none', secret: 'SECRET' }, token: 'SECRET' };
      } else throw new Error(`Unexpected tool ${body.params.name}`);
      return Response.json({ id: body.id, result: { structuredContent: data } });
    },
  };
}
async function prepare(cookie, token = 'admin') {
  return api('image-prepare', { token, cookie, method: 'POST', data: { model_id: 80, prompt: ' test prompt ' } });
}
async function submit(cookie, approval, extra = {}) {
  return api('image-submit', { cookie, method: 'POST', data: { approval, confirm: true, ...extra } });
}

test('admin image test binds explicit approval and cap to fresh quote, dispatches once and polls safely', async () => {
  const original = globalThis.fetch, f = fixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setScope('freebeat:read'); const readOnly = await connect(); f.setScope('freebeat:read freebeat:generate');
    assert.equal((await prepare(cookie, 'user')).status, 403);
    assert.equal((await prepare(cookie, 'other-admin')).status, 401);
    assert.equal((await prepare(readOnly)).status, 403);
    assert.equal((await api('image-prepare', { cookie, method: 'POST', origin: 'https://evil.example', data: { model_id: 80, prompt: 'test prompt' } })).status, 403);
    f.setQuote({ status: 'unavailable' }); assert.equal((await prepare(cookie)).status, 409);
    f.setQuote({ status: 'quoted', credits: '23' }); assert.equal((await prepare(cookie)).status, 409);
    f.setQuote({ status: 'quoted', credits: 23 });
    const ready = await prepare(cookie); assert.equal(ready.status, 200);
    const { approval, credits, prompt, model_id } = await ready.json();
    assert.equal(credits, 23); assert.equal(prompt, 'test prompt'); assert.equal(model_id, 80);
    assert.doesNotMatch(approval, /test prompt|PROVIDER-SECRET/);
    assert.equal((await submit(cookie, approval, { confirm: false })).status, 400);
    assert.equal((await submit(cookie, approval, { max_credits: 999 })).status, 400);
    assert.equal((await submit(cookie, approval.slice(0, -2) + 'xx')).status, 400);
    f.setQuote({ status: 'quoted', credits: 24 });
    assert.equal((await submit(cookie, approval)).status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_image').length, 0);
    f.setQuote({ status: 'quoted', credits: 23 });
    const results = await Promise.all([submit(cookie, approval), submit(cookie, approval)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_image').length, 1);
    const accepted = await results.find((r) => r.status === 200).json();
    assert.equal(accepted.status, 'submitted');
    assert.equal((await submit(cookie, approval)).status, 409);
    const listed = await (await api('image-tests', { cookie })).json();
    assert.equal(listed.tests.length, 1); assert.equal(listed.tests[0].canPoll, true);
    assert.doesNotMatch(JSON.stringify(listed), /batch-123|PROVIDER-SECRET|test prompt/);
    const result = await api('image-task', { cookie, method: 'POST', data: { id: accepted.id } });
    const text = await result.text();
    assert.deepEqual(JSON.parse(text).task, { status: 'completed', images: ['https://cdn.example/image.png'], billing: { charged: 23, refunded: null, net: 23, refund_state: 'none' } });
    assert.doesNotMatch(text, /SECRET|javascript|user:pass|batch-123/);
    assert.equal((await api('image-task', { cookie, token: 'other-admin', method: 'POST', data: { id: accepted.id } })).status, 401);
    f.setToken('NEW-PROVIDER-SECRET'); const newCookie = await connect();
    assert.equal((await api('image-task', { cookie: newCookie, method: 'POST', data: { id: accepted.id } })).status, 404);
  } finally { globalThis.fetch = original; }
});

test('uncertain dispatch or storage write never auto-retries and blocks later paid submissions', async () => {
  const original = globalThis.fetch, originalWarn = console.warn; console.warn = () => {};
  try {
    for (const failure of ['lost', 'bad', 'insert-uncertain', 'patch-fails']) {
      const f = fixture(); globalThis.fetch = f.fetch;
      const cookie = await connect();
      const { approval } = await (await prepare(cookie)).json();
      if (failure === 'lost' || failure === 'bad') f.setGenerateMode(failure);
      else f.setDbMode(failure);
      const submitted = await submit(cookie, approval);
      assert.equal(submitted.status, failure === 'insert-uncertain' ? 503 : 200);
      const response = await submitted.json();
      if (failure !== 'insert-uncertain') assert.equal(response.status, 'unknown');
      if (failure === 'patch-fails') assert.equal(response.recoveryTaskId, 'batch-123');
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_image').length, failure === 'insert-uncertain' ? 0 : 1);
      f.setDbMode('ok'); f.setGenerateMode('success');
      const next = await (await prepare(cookie)).json();
      assert.equal((await submit(cookie, next.approval)).status, 409);
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_image').length, failure === 'insert-uncertain' ? 0 : 1);
    }
  } finally { globalThis.fetch = original; console.warn = originalWarn; }
});

test('database locks unresolved admin tests and denies direct access to browser roles', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key); insert into auth.users values ('10000000-0000-4000-8000-000000000001');`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261118000004_create_freebeat_admin_image_tests.sql', import.meta.url), 'utf8'));
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from public.freebeat_admin_image_tests'), /permission denied/i);
    await db.exec('reset role');
    const id = '20000000-0000-4000-8000-000000000001', owner = '10000000-0000-4000-8000-000000000001', hash = 'a'.repeat(43);
    await db.query('insert into freebeat_admin_image_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'dispatching\')', [id, owner, hash]);
    await assert.rejects(db.query('insert into freebeat_admin_image_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'dispatching\')', ['20000000-0000-4000-8000-000000000002', owner, hash]), /unique/i);
    await assert.rejects(db.query("update freebeat_admin_image_tests set status='submitted' where id=$1", [id]), /check constraint/i);
    await db.query("update freebeat_admin_image_tests set status='submitted', task_id='batch-123' where id=$1", [id]);
    await db.query('insert into freebeat_admin_image_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'unknown\')', ['20000000-0000-4000-8000-000000000002', owner, hash]);
    await assert.rejects(db.query('insert into freebeat_admin_image_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'dispatching\')', ['20000000-0000-4000-8000-000000000003', owner, hash]), /unique/i);
  } finally { await db.close(); }
});

test('expired, changed-session, invalid inputs and unavailable storage fail without generation', async () => {
  const original = globalThis.fetch, originalNow = Date.now, f = fixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    for (const body of [
      { model_id: -1, prompt: 'test prompt' },
      { model_id: 80, prompt: ' '.repeat(10) },
      { model_id: 80, prompt: 'x'.repeat(2001) },
      { model_id: 80, prompt: 'test prompt', count: 5 },
    ]) assert.equal((await api('image-prepare', { cookie, method: 'POST', data: body })).status, 400);
    assert.equal((await api('image-prepare', { cookie, method: 'POST', data: { model_id: 999, prompt: 'test prompt' } })).status, 400);
    let { approval } = await (await prepare(cookie)).json();
    Date.now = () => originalNow() + 6 * 60 * 1000;
    assert.equal((await submit(cookie, approval)).status, 400);
    Date.now = originalNow;
    ({ approval } = await (await prepare(cookie)).json());
    f.setToken('A-DIFFERENT-SESSION');
    const newCookie = await connect();
    assert.equal((await submit(newCookie, approval)).status, 400);
    f.setDbMode('unavailable');
    const newApproval = (await (await prepare(newCookie)).json()).approval;
    assert.equal((await submit(newCookie, newApproval)).status, 503);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_image').length, 0);
  } finally { globalThis.fetch = original; Date.now = originalNow; }
});
