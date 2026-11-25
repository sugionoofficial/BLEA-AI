import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import worker from '../src/worker.js';
import { videoHeadroom } from '../src/lib/freebeatVideoTestSettings.js';

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
  let expectedModel = 182, expectedMax = 23, scope = 'freebeat:read freebeat:generate', quote = { status: 'quoted', credits: 23 }, generateMode = 'success', tokenValue = 'PROVIDER-SECRET', dbMode = 'ok', taskResult = null, createResult = null, uploadConfig = null, videoPreset = { duration: 5, resolution: '480p', aspect_ratio: '16:9' }, helpResult = null;
  return {
    rows, calls,
    setScope(value) { scope = value; },
    setVideoPreset(value) { videoPreset = value; },
    setHelp(value) { helpResult = value; },
    setModel(value, max = 23) { expectedModel = value; expectedMax = max; },
    setQuote(value) { quote = value; },
    setGenerateMode(value) { generateMode = value; },
    setToken(value) { tokenValue = value; },
    setDbMode(value) { dbMode = value; },
    setTaskResult(value) { taskResult = value; },
    setCreateResult(value) { createResult = value; },
    setUploadConfig(value) { uploadConfig = value; },
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      if (url.href === 'https://supabase.example/auth/v1/user') {
        const bearer = init.headers.authorization.replace('Bearer ', '');
        return Response.json({ id: bearer, app_metadata: { role: bearer === 'user' ? 'user' : 'admin' } });
      }
      if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
      if (url.href === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: tokenValue, expires_in: 600, scope });
      if (url.pathname === '/rest/v1/freebeat_admin_video_tests') {
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
      if (body.method === 'tools/list') {
        assert.ok(uploadConfig);
        const properties = { urls: { type: 'array', items: { type: 'string' } }, ...(uploadConfig.cap ? { max_credits: { type: 'number' } } : {}) };
        return Response.json({ id: body.id, result: { tools: [{ name: 'upload_image', inputSchema: { type: 'object', properties, required: ['urls'] } }] } });
      }
      let data;
      if (body.params.name === 'quote_generation' && body.params.arguments.tool === 'upload_image') {
        assert.deepEqual(body.params.arguments, { tool: 'upload_image', parameters: { urls: ['https://images.example/input.png'] } });
        if (uploadConfig.quoteHttp) return new Response(null, { status: uploadConfig.quoteHttp });
        if (uploadConfig.quoteError) return Response.json({ id: body.id, error: uploadConfig.quoteError });
        if (uploadConfig.quoteToolError) return Response.json({ id: body.id, result: { isError: true, structuredContent: uploadConfig.quoteToolError } });
        if (uploadConfig.quoteToolText) return Response.json({ id: body.id, result: { isError: true, content: [{ type: 'text', text: uploadConfig.quoteToolText }] } });
        data = uploadConfig.quote;
      } else if (body.params.name === 'upload_image') {
        assert.deepEqual(body.params.arguments, { urls: ['https://images.example/input.png'], ...(uploadConfig.host ? {} : { max_credits: 0 }) });
        if (uploadConfig.lost) throw new Error('PRIVATE-NETWORK-ERROR');
        data = uploadConfig.result || { success: true, image_urls: ['https://cdn.example/private?token=SECRET'], message: 'PRIVATE MESSAGE' };
      } else if (body.params.name === 'list_models') { assert.deepEqual(body.params.arguments, { type: 'video' }); data = { models: [{ model_id: 182, name: 'Wan 3.0' }, { model_id: '186', name: 'Model 186' }] }; }
      else if (body.params.name === 'get_model_help') { assert.deepEqual(body.params.arguments, { type: 'video', model_id: expectedModel }); data = helpResult || { model_id: expectedModel }; }
      else if (body.params.name === 'quote_generation') { assert.deepEqual(body.params.arguments, { tool: 'generate_video', parameters: { model_id: expectedModel, generation_type: 'image', ...videoPreset, prompt: 'test prompt', images: ['https://images.example/input.png'] } }); data = quote; }
      else if (body.params.name === 'generate_video') {
        // Payload dispatch mengikuti kontrak web Freebeat: aspect_ratio selalu
        // dikirim, dan max_credits = quote + headroom (VIDEO_CREDIT_HEADROOM)
        // agar pembulatan harga provider tidak menolak job dengan 0 kredit.
        assert.deepEqual(body.params.arguments, { model_id: expectedModel, generation_type: 'image', ...videoPreset, prompt: 'test prompt', images: ['https://images.example/input.png'], max_credits: expectedMax + videoHeadroom(expectedMax) });
        if (generateMode === 'lost') throw new Error('PRIVATE-NETWORK-ERROR');
        if (generateMode === 'rpc-error') return Response.json({ id: body.id, error: { code: -32000, message: 'Rejected https://secret.example/a?token=VALUE Bearer BADTOKEN' } });
        if (generateMode === 'sse-error') return new Response(`event: message\ndata: ${JSON.stringify({ id: body.id, error: { code: -32000, message: 'Rejected https://secret.example/a?token=VALUE Bearer BADTOKEN' } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        if (generateMode === 'tool-error') return Response.json({ id: body.id, result: { isError: true, content: [{ type: 'text', text: 'Invalid image; contact admin@example.com' }] } });
        if (generateMode === 'bad') data = { batch_id: 'not a valid id', secret: 'SECRET-DATA' };
        else data = createResult || { batch_id: 'batch-123', secret: 'SECRET-DATA' };
      } else if (body.params.name === 'get_task_status') {
        assert.deepEqual(body.params.arguments, { task_id: createResult?.batch_id || 'batch-123' });
        data = taskResult || { status: 'completed', items: [{ video_url: 'https://cdn.example/video.mp4' }, { video_url: 'javascript:alert(1)' }, { video_url: 'https://user:pass@example.com/img' }], billing: { charged: 23, refunded: null, net: 23, refund_state: 'none', secret: 'SECRET' }, token: 'SECRET' };
      } else throw new Error(`Unexpected tool ${body.params.name}`);
      return Response.json({ id: body.id, result: { structuredContent: data } });
    },
  };
}
async function prepare(cookie, token = 'admin', model_id = 182) {
  return api('video-prepare', { token, cookie, method: 'POST', data: { model_id, image_url: 'https://images.example/input.png', prompt: ' test prompt ' } });
}
async function submit(cookie, approval, extra = {}) {
  return api('video-submit', { cookie, method: 'POST', data: { approval, confirm: true, ...extra } });
}

test('admin video test binds explicit approval and cap to fresh quote, dispatches once and polls safely', async () => {
  const original = globalThis.fetch, f = fixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setScope('freebeat:read'); const readOnly = await connect(); f.setScope('freebeat:read freebeat:generate');
    assert.equal((await prepare(cookie, 'user')).status, 403);
    assert.equal((await prepare(cookie, 'other-admin')).status, 401);
    assert.equal((await prepare(readOnly)).status, 403);
    assert.equal((await api('video-prepare', { cookie, method: 'POST', origin: 'https://evil.example', data: { image_url: 'https://images.example/input.png', prompt: 'test prompt' } })).status, 403);
    f.setQuote({ status: 'unavailable' }); assert.equal((await prepare(cookie)).status, 409);
    f.setQuote({ status: 'quoted', credits: '23' }); assert.equal((await prepare(cookie)).status, 409);
    f.setQuote({ status: 'quoted', credits: 23 });
    const ready = await prepare(cookie); assert.equal(ready.status, 200);
    const { approval, credits, prompt, settings, image_url } = await ready.json();
    assert.equal(credits, 23); assert.equal(prompt, 'test prompt'); assert.equal(image_url, 'https://images.example/input.png'); assert.deepEqual(settings, { model_id: 182, generation_type: 'image', duration: 5, resolution: '480p', aspect_ratio: '16:9' });
    assert.doesNotMatch(approval, /test prompt|PROVIDER-SECRET/);
    assert.equal((await submit(cookie, approval, { confirm: false })).status, 400);
    assert.equal((await submit(cookie, approval, { max_credits: 999 })).status, 400);
    assert.equal((await submit(cookie, approval.slice(0, -2) + 'xx')).status, 400);
    f.setQuote({ status: 'quoted', credits: 24 });
    assert.equal((await submit(cookie, approval)).status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    f.setQuote({ status: 'quoted', credits: 23 });
    const results = await Promise.all([submit(cookie, approval), submit(cookie, approval)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    const accepted = await results.find((r) => r.status === 200).json();
    assert.equal(accepted.status, 'submitted');
    assert.equal((await submit(cookie, approval)).status, 409);
    const listed = await (await api('video-tests', { cookie })).json();
    assert.equal(listed.tests.length, 1); assert.equal(listed.tests[0].canPoll, true);
    assert.doesNotMatch(JSON.stringify(listed), /batch-123|PROVIDER-SECRET|test prompt/);
    const result = await api('video-task', { cookie, method: 'POST', data: { id: accepted.id } });
    const text = await result.text();
    assert.deepEqual(JSON.parse(text).task, { status: 'completed', videos: ['https://cdn.example/video.mp4'], billing: { charged: 23, refunded: null, net: 23, refund_state: 'none' }, failure: null, item_failures: [] });
    assert.doesNotMatch(text, /SECRET|javascript|user:pass|batch-123/);
    f.setTaskResult({ status: 'failed', billing: { charged: 0 }, failure: { stage: 'generation', reason: 'Secret message https://private.example?token=SECRET', retryable: false }, items: [{ failure: { stage: 'SECRET', reason: 'invalid_image', retryable: true } }, { failure: { reason: 'SECRET', retryable: 'yes' } }] });
    const failed = await api('video-task', { cookie, method: 'POST', data: { id: accepted.id } });
    const failedText = await failed.text();
    assert.doesNotMatch(failedText, /SECRET|private\.example|batch-123/);
    const failedTask = JSON.parse(failedText).task;
    assert.deepEqual(failedTask.failure, { stage: 'generation', stage_hidden: false, reason: null, reason_hidden: true, retryable: false });
    assert.deepEqual(failedTask.item_failures, [{ stage: null, stage_hidden: true, reason: 'invalid_image', reason_hidden: false, retryable: true }, { stage: null, stage_hidden: false, reason: null, reason_hidden: true, retryable: null }]);
    assert.deepEqual(failedTask.billing, { charged: 0, refunded: null, net: null, refund_state: null });
    const privateRequest = (options = {}) => api('video-private-failure', { cookie, method: 'POST', data: { id: accepted.id, acknowledge: true }, ...options });
    assert.equal((await privateRequest({ token: 'user' })).status, 403);
    assert.equal((await privateRequest({ token: 'other-admin' })).status, 401);
    assert.equal((await privateRequest({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await privateRequest({ data: { id: accepted.id, acknowledge: false } })).status, 400);
    assert.equal((await privateRequest({ data: { id: accepted.id, acknowledge: true, task_id: 'other' } })).status, 400);
    f.setTaskResult({ status: 'failed', failure: { reason: 'Input rejected. URL https://private.example/image?token=ABC' }, items: [{ failure: { reason: 'Bearer abcdefgh API_KEY=topsecret contact admin@example.com' } }] });
    const privateResponse = await privateRequest();
    assert.equal(privateResponse.status, 200);
    assert.equal(privateResponse.headers.get('cache-control'), 'no-store');
    const privateText = await privateResponse.text();
    assert.doesNotMatch(privateText, /private\.example|ABC|abcdefgh|topsecret|admin@example|batch-123|PROVIDER-SECRET/);
    assert.deepEqual(JSON.parse(privateText).reasons, ['Input rejected. URL [URL disembunyikan]', 'Bearer [disembunyikan] API_KEY=[disembunyikan] contact [email disembunyikan]']);
    // Status responses may use item error_message/error_code instead of failure.reason.
    f.setTaskResult({ status: 'failed', message: 'Batch failed', items: [{ error_code: 'invalid_image', error_message: 'Image rejected https://private.example/file?token=secret', message: 'Bearer verysecret' }, { error_code: 'invalid_image', failure: { reason: 'invalid_image' }, error_message: 'Contact admin@example.com' }] });
    const detailed = await privateRequest();
    const detailedText = await detailed.text();
    assert.doesNotMatch(detailedText, /private\.example|verysecret|admin@example|token=secret/);
    assert.deepEqual(JSON.parse(detailedText).reasons, ['Batch failed', 'invalid_image', 'Image rejected [URL disembunyikan]', 'Bearer [disembunyikan]', 'Contact [email disembunyikan]']);
    const filteredAgain = await api('video-task', { cookie, method: 'POST', data: { id: accepted.id } });
    assert.doesNotMatch(await filteredAgain.text(), /Batch failed|Image rejected|verysecret|admin@example/);
    f.setTaskResult({ status: 'completed' });
    assert.equal((await privateRequest()).status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    assert.equal((await api('video-task', { cookie, token: 'other-admin', method: 'POST', data: { id: accepted.id } })).status, 401);
    f.setToken('NEW-PROVIDER-SECRET'); const newCookie = await connect();
    assert.equal((await api('video-task', { cookie: newCookie, method: 'POST', data: { id: accepted.id } })).status, 404);
    // Dengan acknowledge, admin PEMILIK baris boleh memeriksa job dari sesi
    // Freebeat sebelumnya (baris lama tetap terdiagnosis). Status tugas di titik
    // ini 'completed', jadi alasan kegagalan memang tidak tersedia -> 409.
    // Admin lain tetap 401/404 karena filter admin_id di query.
    assert.equal((await api('video-private-failure', { cookie: newCookie, method: 'POST', data: { id: accepted.id, acknowledge: true } })).status, 409);
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
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, failure === 'insert-uncertain' ? 0 : 1);
      f.setDbMode('ok'); f.setGenerateMode('success');
      const next = await (await prepare(cookie)).json();
      assert.equal((await submit(cookie, next.approval)).status, 409);
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, failure === 'insert-uncertain' ? 0 : 1);
    }
  } finally { globalThis.fetch = original; console.warn = originalWarn; }
});

test('database locks unresolved admin tests and denies direct access to browser roles', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth; create table auth.users (id uuid primary key); insert into auth.users values ('10000000-0000-4000-8000-000000000001');`);
    await db.exec(await readFile(new URL('../supabase/migrations/20261118000005_create_freebeat_admin_video_tests.sql', import.meta.url), 'utf8'));
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from public.freebeat_admin_video_tests'), /permission denied/i);
    await db.exec('reset role');
    const id = '20000000-0000-4000-8000-000000000001', owner = '10000000-0000-4000-8000-000000000001', hash = 'a'.repeat(43);
    await db.query('insert into freebeat_admin_video_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'dispatching\')', [id, owner, hash]);
    await assert.rejects(db.query('insert into freebeat_admin_video_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'dispatching\')', ['20000000-0000-4000-8000-000000000002', owner, hash]), /unique/i);
    await assert.rejects(db.query("update freebeat_admin_video_tests set status='submitted' where id=$1", [id]), /check constraint/i);
    await db.query("update freebeat_admin_video_tests set status='submitted', task_id='batch-123' where id=$1", [id]);
    await db.query('insert into freebeat_admin_video_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'unknown\')', ['20000000-0000-4000-8000-000000000002', owner, hash]);
    await assert.rejects(db.query('insert into freebeat_admin_video_tests (id,admin_id,session_hash,model_id,quote_credits,max_credits,status) values ($1,$2,$3,80,23,23,\'dispatching\')', ['20000000-0000-4000-8000-000000000003', owner, hash]), /unique/i);
  } finally { await db.close(); }
});

test('expired, changed-session, invalid inputs and unavailable storage fail without generation', async () => {
  const original = globalThis.fetch, originalNow = Date.now, f = fixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    for (const body of [
      { image_url: 'https://images.example/input.png', prompt: 'test prompt' },
      { model_id: 186, image_url: 'https://images.example/input.png', prompt: 'test prompt', max_credits: 999 },
      { model_id: -1, image_url: 'https://images.example/input.png', prompt: 'test prompt' },
      { model_id: '186', image_url: 'https://images.example/input.png', prompt: 'test prompt' },
      { model_id: 182, image_url: 'http://images.example/input.png', prompt: 'test prompt' },
      { model_id: 182, image_url: 'https://images.example/input.png', prompt: ' '.repeat(10) },
      { model_id: 182, image_url: 'https://images.example/input.png', prompt: 'x'.repeat(2001) },
    ]) assert.equal((await api('video-prepare', { cookie, method: 'POST', data: body })).status, 400);
    // ID model arbitrer (mis. 987) tidak lagi ditolak di depan: settingnya
    // dinormalkan terhadap get_model_help hidup lalu di-quote, jadi penolakannya
    // datang dari provider. Jalur ini dicakup test model 186 di bawah.
    // duration/resolution yang tidak didukung model juga tidak lagi 400: nilainya
    // dinormalkan (adjusted) terhadap opsi dari get_model_help sebelum quote.
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
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
  } finally { globalThis.fetch = original; Date.now = originalNow; }
});

test('selected model 186 is bound to the fresh quote, approval, dispatch and durable record', async () => {
  const original = globalThis.fetch, f = fixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setModel(186, 135); f.setQuote({ status: 'quoted', credits: 135 });
    const ready = await prepare(cookie, 'admin', 186);
    assert.equal(ready.status, 200);
    const { approval, settings, credits } = await ready.json();
    assert.deepEqual(settings, { model_id: 186, generation_type: 'image', duration: 5, resolution: '480p', aspect_ratio: '16:9' });
    assert.equal(credits, 135);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    assert.equal((await submit(cookie, approval, { model_id: 182 })).status, 400);
    assert.equal((await submit(cookie, approval, { confirm: false })).status, 400);
    f.setQuote({ status: 'quoted', credits: 136 });
    assert.equal((await submit(cookie, approval)).status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    f.setQuote({ status: 'quoted', credits: 135 });
    const result = await submit(cookie, approval);
    assert.equal(result.status, 200);
    const submitted = await result.json();
    assert.equal(submitted.status, 'submitted');
    assert.equal(f.rows.get(submitted.id).model_id, 186);
    assert.equal(f.rows.get(submitted.id).max_credits, 135 + videoHeadroom(135));
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    assert.equal((await submit(cookie, approval)).status, 409);
  } finally { globalThis.fetch = original; }
});

test('unknown video dispatch blocks another model until reconciled', async () => {
  const original = globalThis.fetch, f = fixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setModel(186, 135); f.setQuote({ status: 'quoted', credits: 135 });
    const { approval } = await (await prepare(cookie, 'admin', 186)).json();
    f.setGenerateMode('lost');
    assert.equal((await (await submit(cookie, approval)).json()).status, 'unknown');
    f.setGenerateMode('success'); f.setModel(182); f.setQuote({ status: 'quoted', credits: 23 });
    const next = await (await prepare(cookie)).json();
    assert.equal((await submit(cookie, next.approval)).status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
  } finally { globalThis.fetch = original; }
});

test('initial create diagnostics are opt-in, transient, redacted, and keep the approved cap', async () => {
  const original = globalThis.fetch;
  try {
    for (const capture of [false, true]) {
      const f = fixture(); globalThis.fetch = f.fetch;
      const cookie = await connect();
      f.setCreateResult({ batch_id: 'batch-123', message: 'Batch notice https://private.example/image?token=SECRET', items: [{ error_code: 'invalid_image', message: 'Bearer SENSITIVE contact admin@example.com', error_message: 'Invalid input' }], token: 'PROVIDER-SECRET' });
      const { approval } = await (await prepare(cookie)).json();
      assert.equal((await submit(cookie, approval, { private_diagnostics: 'yes' })).status, 400);
      assert.equal((await submit(cookie, approval, { confirm: false, private_diagnostics: true })).status, 400);
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
      const res = await submit(cookie, approval, { private_diagnostics: capture });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      const text = await res.text();
      assert.doesNotMatch(text, /private\.example|SENSITIVE|admin@example|PROVIDER-SECRET|token=SECRET/);
      const result = JSON.parse(text); assert.equal(result.status, 'submitted');
      if (capture) assert.deepEqual(result.initial_diagnostics, { received: true, messages: ['Batch notice [URL disembunyikan]', 'invalid_image', 'Invalid input', 'Bearer [disembunyikan] contact [email disembunyikan]'] });
      else assert.equal(Object.hasOwn(result, 'initial_diagnostics'), false);
      assert.doesNotMatch(JSON.stringify([...f.rows.values()]), /Batch notice|Invalid input|SENSITIVE|private\.example/);
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    }
  } finally { globalThis.fetch = original; }
});

test('unrecognized, RPC error, and lost initial responses remain uncertain and keep the dispatch lock', async () => {
  const original = globalThis.fetch, warn = console.warn; console.warn = () => {};
  try {
    for (const mode of ['rejected', 'rpc-error', 'sse-error', 'tool-error', 'lost']) {
      const f = fixture(); globalThis.fetch = f.fetch;
      const cookie = await connect();
      const { approval } = await (await prepare(cookie)).json();
      if (mode === 'rejected') f.setCreateResult({ message: 'All items rejected', items: [{ error_message: 'Unsupported input' }] });
      else f.setGenerateMode(mode);
      const res = await submit(cookie, approval, { private_diagnostics: true });
      const text = await res.text();
      assert.doesNotMatch(text, /secret\.example|token=VALUE|BADTOKEN|admin@example|PRIVATE-NETWORK-ERROR/);
      const result = JSON.parse(text);
      assert.equal(result.status, 'unknown');
      assert.equal(result.initial_diagnostics.received, mode !== 'lost');
      if (mode === 'rejected') assert.deepEqual(result.initial_diagnostics.messages, ['All items rejected', 'Unsupported input']);
      if (mode === 'rpc-error' || mode === 'sse-error') assert.deepEqual(result.initial_diagnostics.messages, ['Rejected [URL disembunyikan] Bearer [disembunyikan]']);
      if (mode === 'tool-error') assert.deepEqual(result.initial_diagnostics.messages, ['Invalid image; contact [email disembunyikan]']);
      assert.equal(f.rows.get(result.id).status, 'unknown');
      f.setGenerateMode('success');
      const next = await (await prepare(cookie)).json();
      assert.equal((await submit(cookie, next.approval)).status, 409);
      assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    }
  } finally { globalThis.fetch = original; console.warn = warn; }
});

test('Freebeat image upload diagnostic fails closed without consent, zero quote and a supported zero cap', async () => {
  const original = globalThis.fetch, f = fixture(); globalThis.fetch = f.fetch;
  const call = (cookie, action, data = { image_url: 'https://images.example/input.png', acknowledge: true }, extra = {}) => api(action, { cookie, method: 'POST', data, ...extra });
  try {
    const cookie = await connect();
    f.setScope('freebeat:read'); const readOnly = await connect();
    f.setUploadConfig({ cap: false, quote: { status: 'quoted', credits: 0 } });
    assert.equal((await call(cookie, 'video-upload-image', { image_url: 'https://images.example/input.png' })).status, 400);
    assert.equal((await call(cookie, 'video-upload-image', undefined, { token: 'user' })).status, 403);
    assert.equal((await call(cookie, 'video-upload-image', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await call(readOnly, 'video-upload-image')).status, 403);
    assert.equal((await call(cookie, 'video-upload-image', { image_url: 'http://images.example/input.png', acknowledge: true })).status, 400);
    assert.equal(f.calls.filter((c) => c.params?.name === 'upload_image').length, 0);
    let response = await call(cookie, 'video-upload-check');
    assert.deepEqual(await response.json(), { ok: true, eligible: false, reason: 'cap_unavailable' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    f.setUploadConfig({ cap: true, quote: { status: 'unavailable' } });
    assert.deepEqual(await (await call(cookie, 'video-upload-image')).json(), { ok: true, eligible: false, reason: 'zero_quote_unavailable' });
    f.setUploadConfig({ cap: true, quote: { status: 'quoted', credits: 5 } });
    assert.deepEqual(await (await call(cookie, 'video-upload-image')).json(), { ok: true, eligible: false, reason: 'zero_quote_unavailable' });
    assert.equal(f.calls.filter((c) => c.params?.name === 'upload_image').length, 0);
    f.setUploadConfig({ cap: true, quote: { status: 'quoted', credits: 0 } });
    assert.deepEqual(await (await call(cookie, 'video-upload-check')).json(), { ok: true, eligible: true });
    assert.equal(f.calls.filter((c) => c.params?.name === 'upload_image').length, 0);
    f.setUploadConfig({ cap: true, quote: { status: 'quoted', credits: 1 } });
    assert.deepEqual(await (await call(cookie, 'video-upload-image')).json(), { ok: true, eligible: false, reason: 'zero_quote_unavailable' });
    assert.equal(f.calls.filter((c) => c.params?.name === 'upload_image').length, 0);
    f.setUploadConfig({ cap: true, quote: { status: 'quoted', credits: 0 } });
    response = await call(cookie, 'video-upload-image');
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), { ok: true, eligible: true, outcome: 'uploaded' });
    assert.doesNotMatch(text, /SECRET|PRIVATE|cdn\.example|images\.example/);
    assert.equal(f.calls.filter((c) => c.params?.name === 'upload_image').length, 1);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    assert.equal(f.rows.size, 0);
  } finally { globalThis.fetch = original; }
});

test('unconfirmed upload and unsafe response never reveal provider details and are not retried', async () => {
  const original = globalThis.fetch, warn = console.warn, f = fixture(); globalThis.fetch = f.fetch; console.warn = () => {};
  try {
    const cookie = await connect();
    for (const config of [{ lost: true }, { result: { success: true, image_urls: ['https://u:p@cdn.example/img'] } }]) {
      f.setUploadConfig({ cap: true, quote: { status: 'quoted', credits: 0 }, ...config });
      const response = await api('video-upload-image', { cookie, method: 'POST', data: { image_url: 'https://images.example/input.png', acknowledge: true } });
      const text = await response.text();
      assert.deepEqual(JSON.parse(text), { ok: true, eligible: true, outcome: 'unknown' });
      assert.doesNotMatch(text, /PRIVATE|cdn\.example|images\.example/);
    }
    assert.equal(f.calls.filter((c) => c.params?.name === 'upload_image').length, 2);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
  } finally { globalThis.fetch = original; console.warn = warn; }
});

test('Wan 3.0 supports keyframe (0-2 images -> text/image/transition) and omni_reference (1-3 images -> reference) with 480p/720p/1080p and up to 30s', async () => {
  const original = globalThis.fetch;
  const rows = new Map();
  const mcpCalls = [];
  let helpBody = {
    model_id: 182,
    modes: [
      { generation_type: 'text', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
      { generation_type: 'image', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
      { generation_type: 'transition', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
      { generation_type: 'reference', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
    ],
  };
  let nextQuoteCredits = 80;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
    }
    if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
    if (url.href === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: 'TOKEN', expires_in: 600, scope: 'freebeat:read freebeat:generate' });
    if (url.pathname === '/rest/v1/freebeat_admin_video_tests') {
      if (init.method === 'POST') {
        const row = JSON.parse(init.body);
        row.created_at = new Date().toISOString();
        rows.set(row.id, row);
        return Response.json([row]);
      }
      if (init.method === 'PATCH') {
        const id = url.searchParams.get('id').slice(3);
        const row = rows.get(id);
        Object.assign(row, JSON.parse(init.body));
        return Response.json([row]);
      }
      return Response.json([...rows.values()]);
    }
    assert.equal(url.href, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    mcpCalls.push(body);
    if (body.method === 'initialize') return Response.json({ id: body.id, result: { protocolVersion: '2025-03-26' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const tool = body.params?.name;
    if (tool === 'list_models') return Response.json({ id: body.id, result: { structuredContent: { models: [{ model_id: 182, name: 'Wan 3.0' }] } } });
    if (tool === 'get_model_help') {
      return Response.json({ id: body.id, result: { structuredContent: helpBody } });
    }
    if (tool === 'quote_generation') {
      return Response.json({ id: body.id, result: { structuredContent: { status: 'quoted', credits: nextQuoteCredits } } });
    }
    if (tool === 'generate_video') {
      return Response.json({ id: body.id, result: { structuredContent: { batch_id: `batch-${mcpCalls.length}` } } });
    }
    throw new Error(`Unexpected tool ${tool}`);
  };
  try {
    const cookie = await connect();

    // 1. Keyframe 0 images -> generation_type: 'text' (images omitted in MCP args), 1080 -> 1080p, duration 30
    const quoteText = await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: { model_id: 182, prompt: 'Wide desert sunrise', input_mode: 'keyframe', images: [], duration: 30, resolution: '1080', aspect_ratio: '16:9' },
    });
    assert.equal(quoteText.status, 200);
    const textBody = await quoteText.json();
    assert.deepEqual(textBody.settings, { model_id: 182, generation_type: 'text', duration: 30, resolution: '1080p', aspect_ratio: '16:9' });
    assert.deepEqual(textBody.supported.generations, ['text', 'image', 'transition', 'reference']);
    assert.deepEqual(textBody.supported.resolutions, ['480p', '720p', '1080p']);
    assert.equal(textBody.supported.maxDuration, 30);
    assert.deepEqual(mcpCalls.findLast((c) => c.params?.name === 'get_model_help').params.arguments, { type: 'video', model_id: 182 });
    assert.deepEqual(mcpCalls.findLast((c) => c.params?.name === 'quote_generation').params.arguments, {
      tool: 'generate_video',
      parameters: { model_id: 182, generation_type: 'text', duration: 30, resolution: '1080p', aspect_ratio: '16:9', prompt: 'Wide desert sunrise' },
    });

    // 2. Keyframe 2 images -> generation_type: 'transition', resolution '720' -> '720p', duration 20
    const quoteTransition = await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: {
        model_id: 182,
        prompt: 'Morph from sunrise to night',
        input_mode: 'keyframe',
        images: ['https://cdn.example/frame1.png', 'https://cdn.example/frame2.png'],
        duration: 20,
        resolution: '720',
        aspect_ratio: '9:16',
      },
    });
    assert.equal(quoteTransition.status, 200);
    assert.deepEqual((await quoteTransition.json()).settings, { model_id: 182, generation_type: 'transition', duration: 20, resolution: '720p', aspect_ratio: '9:16' });
    assert.deepEqual(mcpCalls.findLast((c) => c.params?.name === 'quote_generation').params.arguments.parameters.images, [
      'https://cdn.example/frame1.png',
      'https://cdn.example/frame2.png',
    ]);

    // 3. Keyframe 3 images rejected (max 2 for Keyframe)
    const badKeyframe = await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: {
        model_id: 182,
        prompt: 'Too many keyframes',
        input_mode: 'keyframe',
        images: ['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png'],
        duration: 10,
      },
    });
    assert.equal(badKeyframe.status, 400);

    // 4. Omni Reference rejects 0 images and >3 images
    assert.equal((await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: { model_id: 182, prompt: 'Missing refs', input_mode: 'omni_reference', images: [], duration: 10 },
    })).status, 400);
    assert.equal((await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: {
        model_id: 182,
        prompt: 'Four refs',
        input_mode: 'omni_reference',
        images: ['https://cdn.example/1.png', 'https://cdn.example/2.png', 'https://cdn.example/3.png', 'https://cdn.example/4.png'],
        duration: 10,
      },
    })).status, 400);

    // 5. Unsupported mode in get_model_help returns 409 cleanly
    helpBody = {
      model_id: 182,
      modes: [{ generation_type: 'image', min_duration: 5, max_duration: 15, resolutions: ['480p', '720p'] }],
    };
    const unsupportedMode = await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: {
        model_id: 182,
        prompt: 'Ref mode when model only lists image',
        input_mode: 'omni_reference',
        images: ['https://cdn.example/1.png'],
        duration: 10,
      },
    });
    assert.equal(unsupportedMode.status, 409);

    // Restore full Wan 3.0 help metadata
    helpBody = {
      model_id: 182,
      modes: [
        { generation_type: 'text', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        { generation_type: 'image', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        { generation_type: 'transition', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
        { generation_type: 'reference', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16', '1:1'] },
      ],
    };

    // 6. Omni Reference with 3 images, 480 -> 480p, 30s -> generation_type: 'reference', full prepare + submit
    nextQuoteCredits = 140;
    const refs = ['https://cdn.example/char.png', 'https://cdn.example/outfit.png', 'https://cdn.example/room.png'];
    const prepared = await api('video-prepare', {
      cookie,
      method: 'POST',
      data: {
        model_id: 182,
        prompt: 'Character walks through neon alley',
        input_mode: 'omni_reference',
        images: refs,
        duration: 30,
        resolution: '480',
        aspect_ratio: '16:9',
      },
    });
    assert.equal(prepared.status, 200);
    const ready = await prepared.json();
    assert.deepEqual(ready.settings, { model_id: 182, generation_type: 'reference', duration: 30, resolution: '480p', aspect_ratio: '16:9' });
    assert.deepEqual(ready.images, refs);
    assert.equal(ready.input_mode, 'omni_reference');

    const submitted = await submit(cookie, ready.approval);
    assert.equal(submitted.status, 200);
    assert.deepEqual(mcpCalls.findLast((c) => c.params?.name === 'generate_video').params.arguments, {
      model_id: 182,
      generation_type: 'reference',
      duration: 30,
      resolution: '480p',
      aspect_ratio: '16:9',
      prompt: 'Character walks through neon alley',
      images: refs,
      max_credits: 140 + videoHeadroom(140),
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('admin diagnostic allows member_only=true models like Wan 3.0 (182) for quote, prepare, and submit unless FREEBEAT_ALLOW_MEMBER_ONLY=0 or available=false', async () => {
  const original = globalThis.fetch;
  const rows = new Map();
  const mcpCalls = [];
  let modelMeta = { model_id: 182, name: 'Wan 3.0', member_only: true, available: true };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
    if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
    if (url.href === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: 'TOKEN', expires_in: 600, scope: 'freebeat:read freebeat:generate' });
    if (url.pathname === '/rest/v1/freebeat_admin_video_tests') {
      if (init.method === 'POST') {
        const row = JSON.parse(init.body);
        row.created_at = new Date().toISOString();
        rows.set(row.id, row);
        return Response.json([row]);
      }
      if (init.method === 'PATCH') {
        const id = url.searchParams.get('id').slice(3);
        const row = rows.get(id);
        Object.assign(row, JSON.parse(init.body));
        return Response.json([row]);
      }
      return Response.json([...rows.values()]);
    }
    assert.equal(url.href, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    mcpCalls.push(body);
    if (body.method === 'initialize') return Response.json({ id: body.id, result: { protocolVersion: '2025-03-26' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const tool = body.params?.name;
    if (tool === 'list_models') return Response.json({ id: body.id, result: { structuredContent: { models: [{ model_id: 182, name: 'Wan 3.0', member_only: modelMeta.member_only, available: modelMeta.available }] } } });
    if (tool === 'get_model_help') {
      return Response.json({
        id: body.id,
        result: {
          structuredContent: {
            model: { ...modelMeta },
            modes: [{ generation_type: 'image', min_duration: 2, max_duration: 30, resolutions: ['480p', '720p', '1080p'], aspect_ratios: ['16:9', '9:16'] }],
          },
        },
      });
    }
    if (tool === 'quote_generation') return Response.json({ id: body.id, result: { structuredContent: { status: 'quoted', credits: 50 } } });
    if (tool === 'generate_video') return Response.json({ id: body.id, result: { structuredContent: { batch_id: 'batch-member-ok' } } });
    throw new Error(`Unexpected tool ${tool}`);
  };
  try {
    const cookie = await connect();

    // Without FREEBEAT_ALLOW_MEMBER_ONLY set, member_only=true succeeds across quote, prepare, and submit
    const quoteRes = await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: { model_id: 182, prompt: 'Test Wan 3.0', input_mode: 'keyframe', images: ['https://cdn.example/frame.png'], duration: 5, resolution: '720p', aspect_ratio: '16:9' },
    });
    assert.equal(quoteRes.status, 200);
    const quoted = await quoteRes.json();
    assert.equal(quoted.member_only, true);
    assert.equal(quoted.quote.credits, 50);

    const prepRes = await api('video-prepare', {
      cookie,
      method: 'POST',
      data: { model_id: 182, prompt: 'Test Wan 3.0', input_mode: 'keyframe', images: ['https://cdn.example/frame.png'], duration: 5, resolution: '720p', aspect_ratio: '16:9' },
    });
    assert.equal(prepRes.status, 200);
    const prepared = await prepRes.json();
    assert.equal(prepared.member_only, true);

    const submitRes = await submit(cookie, prepared.approval);
    assert.equal(submitRes.status, 200);
    assert.equal((await submitRes.json()).status, 'submitted');
    assert.equal(mcpCalls.filter((c) => c.params?.name === 'generate_video').length, 1);

    // Explicit opt-out FREEBEAT_ALLOW_MEMBER_ONLY=0 blocks member_only=true with 409
    const optOutEnv = { ...env, FREEBEAT_ALLOW_MEMBER_ONLY: '0' };
    const optOutRes = await worker.fetch(new Request(`${base}/api/freebeat/video-model-quote`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin', cookie, 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ model_id: 182, prompt: 'Blocked test', input_mode: 'keyframe', images: ['https://cdn.example/frame.png'], duration: 5 }),
    }), optOutEnv);
    assert.equal(optOutRes.status, 409);

    // available: false remains blocked with 409
    modelMeta = { model_id: 182, name: 'Wan 3.0', member_only: false, available: false };
    const unavailableRes = await api('video-model-quote', {
      cookie,
      method: 'POST',
      data: { model_id: 182, prompt: 'Unavailable test', input_mode: 'keyframe', images: ['https://cdn.example/frame.png'], duration: 5 },
    });
    assert.equal(unavailableRes.status, 409);
  } finally {
    globalThis.fetch = original;
  }
});

test('Open RPC batch numeric error_code, used_credits, and zero-accepted submit summary surface cleanly without leaking prose', async () => {
  const original = globalThis.fetch;
  const f = fixture();
  globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setCreateResult({
      batch_id: 'OB001573701563149979648H5UE',
      accepted_count: 0,
      failed_count: 1,
      accepted_credits: 0,
      items: [{ accepted: false, code: 4031, message: 'Membership required https://private.example/upgrade?token=SECRET' }],
    });
    const { approval } = await (await prepare(cookie)).json();
    const submittedRes = await submit(cookie, approval, { private_diagnostics: true });
    assert.equal(submittedRes.status, 200);
    const submittedText = await submittedRes.text();
    assert.doesNotMatch(submittedText, /private\.example|token=SECRET/);
    const submitted = JSON.parse(submittedText);
    assert.equal(submitted.status, 'submitted');
    assert.deepEqual(submitted.batch_summary, { accepted_count: 0, failed_count: 1, accepted_credits: 0 });
    assert.deepEqual(submitted.initial_diagnostics, {
      received: true,
      messages: ['code: 4031', 'Membership required [URL disembunyikan]'],
    });

    f.setTaskResult({
      task_type: 'open_rpc_batch',
      status: 'failed',
      batch_id: 'OB001573701563149979648H5UE',
      message: 'Batch failed.',
      items: [{
        status: 'failed',
        used_credits: 0,
        error_code: 4031,
        error_message: 'Model requires active membership https://private.example/p?token=SECRET',
      }],
    });
    const pollRes = await api('video-task', { cookie, method: 'POST', data: { id: submitted.id } });
    assert.equal(pollRes.status, 200);
    const pollText = await pollRes.text();
    assert.doesNotMatch(pollText, /Model requires|private\.example|token=SECRET|Batch failed/);
    const { task } = JSON.parse(pollText);
    assert.deepEqual(task.billing, { charged: 0, refunded: null, net: null, refund_state: null });
    assert.deepEqual(task.failure, { stage: null, stage_hidden: false, reason: null, reason_hidden: true, retryable: null });
    assert.deepEqual(task.item_failures, [{ stage: null, stage_hidden: false, reason: null, reason_hidden: true, retryable: null, error_code: '4031' }]);

    const privRes = await api('video-private-failure', { cookie, method: 'POST', data: { id: submitted.id, acknowledge: true } });
    assert.equal(privRes.status, 200);
    const privText = await privRes.text();
    assert.doesNotMatch(privText, /private\.example|token=SECRET/);
    assert.deepEqual(JSON.parse(privText).reasons, ['Batch failed.', 'error_code: 4031', 'Model requires active membership [URL disembunyikan]']);

    f.setTaskResult({
      task_type: 'open_rpc_batch',
      status: 'failed',
      batch_id: 'OB001573701563149979648H5UE',
      items: [{ status: 'failed', used_credits: 0 }],
    });
    const fallbackPrivRes = await api('video-private-failure', { cookie, method: 'POST', data: { id: submitted.id, acknowledge: true } });
    assert.equal(fallbackPrivRes.status, 200);
    assert.deepEqual((await fallbackPrivRes.json()).reasons, ['Item #1: status=failed, used_credits=0']);
  } finally {
    globalThis.fetch = original;
  }
});




test('Hailuo web-observed model 106 is inspected/quoted via MCP without paid calls or catalog activation', async () => {
  const original = globalThis.fetch, f = fixture();
  let available = true;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === 'https://freebeat.ai/api/mcp') {
      const body = JSON.parse(init.body);
      if (body.params?.name === 'get_model_help') {
        f.calls.push(body);
        assert.deepEqual(body.params.arguments, { type: 'video', model_id: 106 });
        return Response.json({ id: body.id, result: { structuredContent: {
          model: { model_id: 106, available }, generation_types: ['image'], durations: [10],
          resolutions: ['768p'], aspect_ratios: ['16:9', '9:16'],
        } } });
      }
      if (body.params?.name === 'quote_generation') {
        f.calls.push(body);
        assert.deepEqual(body.params.arguments, { tool: 'generate_video', parameters: {
          model_id: 106, generation_type: 'image', duration: 10, resolution: '768p', aspect_ratio: '16:9',
          prompt: 'test prompt', images: ['https://images.example/input.png'],
        } });
        return Response.json({ id: body.id, result: { structuredContent: { status: 'quoted', credits: 220 } } });
      }
    }
    return f.fetch(input, init);
  };
  try {
    const cookie = await connect();
    const payload = { model_id: 106, input_mode: 'keyframe', duration: 10, resolution: '768p', aspect_ratio: '16:9', prompt: 'test prompt', images: ['https://images.example/input.png'] };
    assert.equal((await api('video-model-help', { cookie, token: 'user', method: 'POST', data: { model_id: 106 } })).status, 403);
    assert.equal((await api('video-model-help', { token: 'other-admin', cookie, method: 'POST', data: { model_id: 106 } })).status, 401);
    assert.equal((await api('video-model-quote', { cookie, method: 'POST', origin: 'https://evil.example', data: payload })).status, 403);
    assert.equal((await api('video-model-help', { cookie, method: 'POST', data: { model_id: 106 } })).status, 200);
    const result = await api('video-model-quote', { cookie, method: 'POST', data: payload });
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.settings.model_id, 106);
    assert.equal(data.settings.generation_type, 'image');
    assert.equal(data.quote.status, 'quoted');
    assert.equal(data.quote.credits, 220); // fixture only, not a live provider price
    available = false;
    const unavailable = await api('video-model-quote', { cookie, method: 'POST', data: payload });
    assert.equal(unavailable.status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'quote_generation').length, 1);
    assert.ok(f.calls.every((c) => !c.params?.name || ['get_model_help', 'quote_generation'].includes(c.params.name)));
    assert.equal(f.rows.size, 0);
  } finally { globalThis.fetch = original; }
});


test('admin image hosting returns only a validated Freebeat quote URL, rechecks cost, and never retries uncertain uploads', async () => {
  const original = globalThis.fetch, warn = console.warn, f = fixture(); globalThis.fetch = f.fetch; console.warn = () => {};
  const photo = { image_url: 'https://images.example/input.png' };
  try {
    const cookie = await connect();
    const call = (action, data = photo, extra = {}) => api(action, { cookie, method: 'POST', data, ...extra });
    const uploads = () => f.calls.filter((c) => c.params?.name === 'upload_image').length;
    f.setUploadConfig({ host: true, quote: { status: 'quoted', credits: 7 }, result: { success: true, image_urls: ['https://static.freebeat.ai/photo.png'], secret: 'DO_NOT_EXPOSE' } });
    assert.equal((await call('image-upload-host', photo)).status, 400);
    assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: -1 })).status, 400);
    assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 6 })).status, 409);
    assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 7 }, { token: 'user' })).status, 403);
    assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 7 }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(uploads(), 0);
    const quoted = await (await call('image-upload-quote')).json();
    assert.equal(quoted.credits, 7);
    assert.equal(uploads(), 0);
    let response = await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 7 });
    assert.equal(response.status, 200);
    const hosted = await response.json();
    assert.equal(hosted.outcome, 'uploaded');
    assert.equal(hosted.image_url, 'https://static.freebeat.ai/photo.png');
    assert.equal(hosted.quote_credits, 7);
    assert.doesNotMatch(JSON.stringify(hosted), /DO_NOT_EXPOSE/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(uploads(), 1);
    for (const result of [
      { success: true, urls: [{ url: 'https://static.freebeat.ai/photo.png' }] },
      { success: true, data: { image_url: 'https://cdn.freebeatfit.com/photo.png' } },
    ]) {
      f.setUploadConfig({ host: true, quote: { status: 'quoted', credits: 0 }, result });
      assert.equal((await (await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 0 })).json()).outcome, 'uploaded');
    }
    for (const config of [
      { lost: true },
      { result: { success: false, image_urls: ['https://static.freebeat.ai/photo.png'] } },
      { result: { success: true, image_urls: ['https://images.example/input.png'] } },
      { result: { success: true, image_urls: ['https://static.freebeat.ai.evil.example/photo.png'] } },
      { result: { success: true, image_urls: ['https://u:p@static.freebeat.ai/photo.png'] } },
      { result: { success: true, image_urls: ['https://static.freebeat.ai/photo.png', 'https://static.freebeat.ai/other.png'] } },
      { result: { success: true, message: 'https://static.freebeat.ai/not-a-structured-url.png' } },
    ]) {
      f.setUploadConfig({ host: true, quote: { status: 'quoted', credits: 7 }, ...config });
      const before = uploads();
      const body = await (await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 7 })).json();
      assert.equal(body.outcome, 'unknown');
      assert.equal(body.image_url, null);
      assert.equal(uploads(), before + 1, 'upload must not retry');
    }
    for (const quote of [{ status: 'quoted', credits: 8 }, { status: 'unavailable' }]) {
      f.setUploadConfig({ host: true, quote });
      const before = uploads();
      assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 7 })).status, 409);
      assert.equal(uploads(), before);
    }
    f.setScope('freebeat:read'); const readOnly = await connect();
    assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 7 }, { cookie: readOnly })).status, 403);
    assert.equal(f.calls.some((c) => c.params?.name === 'generate_video'), false);
  } finally { globalThis.fetch = original; console.warn = warn; }
});


test('upload quote rejection is diagnosed without leaking prose; unknown-price hosting requires separate consent and a supported failure category', async () => {
  const original = globalThis.fetch, warn = console.warn, f = fixture(); globalThis.fetch = f.fetch; console.warn = () => {};
  const photo = { image_url: 'https://images.example/input.png' };
  try {
    const cookie = await connect();
    const call = (action, data = photo) => api(action, { cookie, method: 'POST', data });
    const count = (name) => f.calls.filter((c) => c.params?.name === name || c.method === name).length;
    const consent = { ...photo, acknowledge: true, accept_unknown_cost: true };
    for (const code of [-32601, -32602]) {
      f.setUploadConfig({ host: true, quoteError: { code, message: 'PRIVATE-TOKEN https://private.example/photo' }, result: { success: true, image_urls: ['https://static.freebeat.ai/photo.png'] } });
      const body = await (await call('image-upload-quote')).json();
      assert.equal(body.credits, null);
      assert.equal(body.status, 'quote_rejected');
      assert.equal(body.unknown_cost_allowed, true);
      assert.deepEqual(body.diagnostic, { stage: 'upload_quote', kind: 'rpc_rejected', rpc_code: code });
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE|private.example/);
      const before = count('upload_image');
      assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 0 })).status, 409);
      assert.equal((await call('image-upload-host', { ...consent, expected_credits: 0 })).status, 400);
      assert.equal((await call('image-upload-host', { ...consent, accept_unknown_cost: 'true' })).status, 400);
      assert.equal(count('upload_image'), before);
      const inits = count('initialize');
      const result = await (await call('image-upload-host', consent)).json();
      assert.equal(result.quote_credits, null);
      assert.equal(result.accept_unknown_cost, true);
      assert.equal(result.outcome, 'uploaded');
      assert.equal(count('upload_image'), before + 1);
      assert.equal(count('initialize'), inits + 1, 'quote and upload must reuse the recovered session');
    }
    f.setUploadConfig({ host: true, quoteToolText: "Input should be 'generate_video'; input_value='upload_image'; PRIVATE-TOKEN https://private.example/photo", result: { success: true, image_urls: ['https://static.freebeat.ai/photo.png'] } });
    const rejected = await (await call('image-upload-quote')).json();
    assert.equal(rejected.unknown_cost_allowed, true);
    assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE|private.example/);
    assert.equal((await call('image-upload-host', consent)).status, 200);
    // The reported UI had quote_rejected without an RPC code: generic SDK
    // tool failures must not depend on English unsupported/enum vocabulary.
    for (const text of ['Unable to quote requested operation PRIVATE', 'Biaya tool ini belum tersedia PRIVATE']) {
      f.setUploadConfig({ host: true, quoteToolText: text, result: { success: true, image_urls: ['https://static.freebeat.ai/photo.png'] } });
      const before = count('upload_image');
      const body = await (await call('image-upload-quote')).json();
      assert.equal(body.unknown_cost_allowed, true);
      assert.deepEqual(body.diagnostic, { stage: 'upload_quote', kind: 'tool_rejected' });
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE/);
      assert.equal(count('upload_image'), before);
      assert.equal((await call('image-upload-host', { ...photo, acknowledge: true, expected_credits: 0 })).status, 409);
      assert.equal((await call('image-upload-host', consent)).status, 200);
      assert.equal(count('upload_image'), before + 1);
    }
    for (const config of [
      { quoteToolText: 'upload_image not supported: unauthorized PRIVATE' },
      { quoteToolText: 'Internal server error PRIVATE' },
      { quoteToolText: 'upload_image request timeout PRIVATE' },
      { quoteToolText: 'Authentication required PRIVATE' },
      { quoteToolError: { error: { message: 'permission denied PRIVATE' } } },
      { quoteToolError: { error: { message: 'Insufficient credits PRIVATE' } } },
      { quoteError: { code: -32603, message: 'PRIVATE' } },
      { quoteError: { code: -32000, message: 'Forbidden PRIVATE' } },
      { quoteError: { code: -32602, message: 'Unauthorized PRIVATE' } },
      { quoteError: { code: -32602, message: 'insufficient credits PRIVATE' } },
      { quoteToolError: { status: 'insufficient_credits', message: 'PRIVATE' } },
      { quote: { status: 'quoted', credits: 5 } },
      { quote: { status: 'quoted', credits: 101 } },
      { quoteHttp: 401 }, { quoteHttp: 403 }, { quoteHttp: 500 },
    ]) {
      f.setUploadConfig({ host: true, ...config });
      const before = count('upload_image');
      const res = await call('image-upload-host', consent);
      assert.notEqual(res.status, 200);
      assert.equal(count('upload_image'), before, 'unknown consent must not bypass auth, balance, generic failure, or a known quote');
      assert.doesNotMatch(await res.text(), /PRIVATE/);
    }
    assert.equal(count('generate_video'), 0);
  } finally { globalThis.fetch = original; console.warn = warn; }
});

const hailuoInput = { model_id: 106, generation_type: 'image', input_mode: 'keyframe', images: ['https://images.example/input.png'], prompt: ' test prompt ', duration: 10, resolution: '768p', aspect_ratio: '9:16' };
const hailuoHelp = { model: { model_id: 106, available: true, member_only: false }, generation_types: ['image', 'text'], durations: [], resolutions: ['1080p', '768p'], aspect_ratios: ['16:9', '9:16', '1:1'] };
function hailuoFixture() {
  const f = fixture();
  f.setModel(106, 130); f.setQuote({ status: 'quoted', credits: 130 });
  f.setVideoPreset({ duration: 10, resolution: '768p', aspect_ratio: '9:16' }); f.setHelp(hailuoHelp);
  return f;
}

test('narrow Hailuo prepare binds live 106 settings and cap without catalog activation; requotes and submits once', async () => {
  const original = globalThis.fetch, f = hailuoFixture(); globalThis.fetch = f.fetch;
  const ready = (cookie, data = hailuoInput, extra = {}) => api('hailuo-prepare', { cookie, method: 'POST', data, ...extra });
  try {
    const cookie = await connect();
    assert.equal((await ready(cookie, hailuoInput, { token: 'user' })).status, 403);
    assert.equal((await ready(cookie, hailuoInput, { token: 'other-admin' })).status, 401);
    assert.equal((await ready(cookie, hailuoInput, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ready(undefined)).status, 401);
    f.setScope('freebeat:read'); const readCookie = await connect();
    assert.equal((await ready(readCookie)).status, 403);
    f.setScope('freebeat:read freebeat:generate');
    const count = f.calls.length;
    for (const bad of [{ model_id: 182 }, { generation_type: 'text', images: [] }, { input_mode: 'multiframe', images: [...hailuoInput.images, ...hailuoInput.images] }, { duration: 5 }, { resolution: '480p' }, { aspect_ratio: '4:3' }, { max_credits: 999 }, { image_url: 'http://localhost/private' }]) {
      assert.equal((await ready(cookie, { ...hailuoInput, ...bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal(f.calls.length, count);
    const response = await ready(cookie); assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const receipt = await response.json();
    assert.equal(receipt.credits, 130); assert.equal(receipt.max_credits, 150);
    assert.equal(typeof receipt.expiresAt, 'number');
    assert.deepEqual(receipt.settings, { model_id: 106, generation_type: 'image', duration: 10, resolution: '768p', aspect_ratio: '9:16' });
    assert.deepEqual(receipt.images, hailuoInput.images); assert.equal(receipt.prompt, 'test prompt');
    assert.deepEqual(receipt.supported.durations, []); // missing enumeration is not arbitrary-duration permission
    assert.equal(f.calls.filter((c) => c.params?.name === 'list_models').length, 0);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    assert.equal(f.rows.size, 0);
    assert.equal((await api('video-prepare', { cookie, method: 'POST', data: hailuoInput })).status, 400); // generic guard unchanged
    assert.equal((await submit(cookie, receipt.approval, { confirm: false })).status, 400);
    f.setQuote({ status: 'quoted', credits: 131 });
    const changedQuote = await submit(cookie, receipt.approval);
    assert.equal(changedQuote.status, 409); assert.equal((await changedQuote.json()).video_dispatch, 'not_sent');
    f.setQuote({ status: 'quoted', credits: 130 });
    f.setHelp({ ...hailuoHelp, model: { model_id: 106, available: false } });
    const unavailable = await submit(cookie, receipt.approval);
    assert.equal(unavailable.status, 409); assert.equal((await unavailable.json()).video_dispatch, 'not_sent');
    f.setHelp(hailuoHelp);
    const responses = await Promise.all([submit(cookie, receipt.approval), submit(cookie, receipt.approval)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const accepted = await responses.find((r) => r.status === 200).json(); assert.equal(accepted.status, 'submitted');
    const duplicate = await submit(cookie, receipt.approval);
    assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).video_dispatch, undefined);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    const tests = await (await api('video-tests', { cookie })).json();
    assert.equal(tests.tests[0].model_id, 106); assert.equal(tests.tests[0].max_credits, 150);
    assert.equal(tests.tests[0].canPoll, true);
    const task = await (await api('video-task', { cookie, method: 'POST', data: { id: accepted.id } })).json();
    assert.deepEqual(task.task.videos, ['https://cdn.example/video.mp4']);
    assert.doesNotMatch(JSON.stringify({ tests, task }), /SECRET|batch-123|javascript/);
  } finally { globalThis.fetch = original; }
});

test('Hailuo blocks absent/changed live identity, options, membership policy and nonnumeric quotes before generation', async () => {
  const original = globalThis.fetch, f = hailuoFixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    const ready = () => api('hailuo-prepare', { cookie, method: 'POST', data: hailuoInput });
    for (const help of [{ model_id: 106 }, { ...hailuoHelp, model: { model_id: 182, available: true } }, { ...hailuoHelp, model: { model_id: 106 } }, { ...hailuoHelp, durations: [6] }, { ...hailuoHelp, resolutions: ['1080p'] }, { ...hailuoHelp, generation_types: ['text'] }, { ...hailuoHelp, aspect_ratios: ['1:1'] }]) {
      f.setHelp(help); assert.equal((await ready()).status, 409);
    }
    f.setHelp({ ...hailuoHelp, model: { ...hailuoHelp.model, member_only: true } });
    env.FREEBEAT_ALLOW_MEMBER_ONLY = '0'; assert.equal((await ready()).status, 409); delete env.FREEBEAT_ALLOW_MEMBER_ONLY;
    f.setHelp(hailuoHelp);
    for (const quote of [{ status: 'unavailable' }, { status: 'quoted', credits: '130' }, { status: 'quoted', credits: -1 }]) {
      f.setQuote(quote); assert.equal((await ready()).status, 409);
    }
    assert.equal(f.rows.size, 0);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    assert.equal(f.calls.filter((c) => c.params?.name === 'list_models').length, 0);
  } finally { globalThis.fetch = original; delete env.FREEBEAT_ALLOW_MEMBER_ONLY; }
});

test('uncertain Hailuo dispatch retains persistent lock and cannot be retried with another receipt', async () => {
  const original = globalThis.fetch, warn = console.warn, f = hailuoFixture(); globalThis.fetch = f.fetch; console.warn = () => {};
  try {
    const cookie = await connect();
    const ready = async () => (await api('hailuo-prepare', { cookie, method: 'POST', data: hailuoInput })).json();
    const receipt = await ready();
    f.setGenerateMode('lost');
    const result = await (await submit(cookie, receipt.approval)).json(); assert.equal(result.status, 'unknown');
    assert.equal([...f.rows.values()][0].status, 'unknown');
    assert.equal((await submit(cookie, receipt.approval)).status, 409);
    const otherReceipt = await ready();
    const locked = await submit(cookie, otherReceipt.approval);
    assert.equal(locked.status, 409); assert.equal((await locked.json()).video_dispatch, undefined);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    const tests = await (await api('video-tests', { cookie })).json();
    assert.equal(tests.tests[0].status, 'unknown'); assert.equal(tests.tests[0].canPoll, false);
  } finally { globalThis.fetch = original; console.warn = warn; }
});

const ltxInput = { ...hailuoInput, model_id: 97, duration: 6, resolution: '1080p', aspect_ratio: '16:9' };
const ltxHelp = { model: { model_id: 97, available: true }, generation_types: ['image'], durations: [6, 8], resolutions: ['1080p'], aspect_ratios: ['16:9', '9:16'] };
function ltxFixture() {
  const f = fixture(); f.setModel(97, 37); f.setQuote({ status: 'quoted', credits: 37 }); f.setHelp(ltxHelp);
  f.setVideoPreset({ duration: 6, resolution: '1080p', aspect_ratio: '16:9' }); return f;
}

test('LTX 97 preparation is admin-only, catalog-independent and requires explicit single-image settings', async () => {
  const original = globalThis.fetch, f = ltxFixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    const ready = (data = ltxInput, extra = {}) => api('ltx-prepare', { cookie, method: 'POST', data, ...extra });
    assert.equal((await ready(ltxInput, { token: 'user' })).status, 403);
    assert.equal((await ready(ltxInput, { token: 'other-admin' })).status, 401);
    assert.equal((await ready(ltxInput, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ready(ltxInput, { cookie: undefined })).status, 401);
    f.setScope('freebeat:read'); const readonly = await connect();
    assert.equal((await ready(ltxInput, { cookie: readonly })).status, 403);
    f.setScope('freebeat:read freebeat:generate');
    const count = f.calls.length;
    for (const patch of [{ model_id: 106 }, { model_id: 182 }, { duration: undefined }, { duration: 0 }, { duration: 601 }, { resolution: undefined }, { aspect_ratio: undefined }, { images: [] }, { images: [...ltxInput.images, ...ltxInput.images] }, { input_mode: 'omni_reference' }, { generation_type: 'text', images: [] }, { max_credits: 999 }, { images: ['http://localhost/photo.png'] }]) {
      assert.equal((await ready({ ...ltxInput, ...patch })).status, 400, JSON.stringify(patch));
    }
    assert.equal(f.calls.length, count);
    const response = await ready(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    const receipt = await response.json();
    assert.deepEqual(receipt.settings, { model_id: 97, generation_type: 'image', duration: 6, resolution: '1080p', aspect_ratio: '16:9' });
    assert.equal(receipt.credits, 37); assert.equal(receipt.max_credits, 47);
    assert.equal(receipt.prompt, 'test prompt'); assert.deepEqual(receipt.images, ltxInput.images);
    assert.equal(typeof receipt.expiresAt, 'number');
    assert.equal(f.rows.size, 0);
    assert.ok(f.calls.every((call) => !call.params?.name || ['get_model_help', 'quote_generation'].includes(call.params.name)));
    assert.equal((await api('video-prepare', { cookie, method: 'POST', data: ltxInput })).status, 400);
    assert.equal((await api('hailuo-prepare', { cookie, method: 'POST', data: ltxInput })).status, 400);
  } finally { globalThis.fetch = original; }
});

test('LTX live help identity/availability/options and numeric quote block preparation without dispatch', async () => {
  const original = globalThis.fetch, f = ltxFixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect(); const ready = () => api('ltx-prepare', { cookie, method: 'POST', data: ltxInput });
    for (const help of [{ model_id: 97 }, { ...ltxHelp, model: { model_id: 106, available: true } }, { ...ltxHelp, model: { model_id: 97, available: false } }, { ...ltxHelp, model: { model_id: 97 } }, { ...ltxHelp, durations: [8] }, { ...ltxHelp, resolutions: ['720p'] }, { ...ltxHelp, aspect_ratios: ['9:16'] }, { ...ltxHelp, generation_types: ['text'] }]) {
      f.setHelp(help); assert.equal((await ready()).status, 409);
    }
    f.setHelp({ ...ltxHelp, model: { ...ltxHelp.model, member_only: true } }); env.FREEBEAT_ALLOW_MEMBER_ONLY = '0';
    assert.equal((await ready()).status, 409); delete env.FREEBEAT_ALLOW_MEMBER_ONLY;
    f.setHelp(ltxHelp);
    for (const quote of [{ status: 'unavailable' }, { status: 'quoted', credits: '37' }, { status: 'quoted', credits: -1 }]) {
      f.setQuote(quote); assert.equal((await ready()).status, 409);
    }
    assert.equal(f.rows.size, 0); assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
  } finally { globalThis.fetch = original; delete env.FREEBEAT_ALLOW_MEMBER_ONLY; }
});

test('LTX exact receipt is requoted, session/expiry bound, rechecks help, dispatches once with cap and reads private failures', async () => {
  const original = globalThis.fetch, f = ltxFixture(); globalThis.fetch = f.fetch;
  try {
    const cookie = await connect(); const receipt = await (await api('ltx-prepare', { cookie, method: 'POST', data: ltxInput })).json();
    const other = await connect(); assert.equal((await submit(other, receipt.approval)).status, 400);
    const realNow = Date.now;
    try { Date.now = () => receipt.expiresAt + 1; const expired = await submit(cookie, receipt.approval); assert.equal(expired.status, 400); }
    finally { Date.now = realNow; }
    f.setQuote({ status: 'quoted', credits: 38 });
    const drift = await submit(cookie, receipt.approval); assert.equal(drift.status, 409); assert.equal((await drift.json()).video_dispatch, 'not_sent');
    f.setQuote({ status: 'quoted', credits: 37 });
    f.setHelp({ ...ltxHelp, resolutions: ['720p'] });
    const changed = await submit(cookie, receipt.approval); assert.equal(changed.status, 409); assert.equal((await changed.json()).video_dispatch, 'not_sent');
    f.setHelp({ ...ltxHelp, model: { model_id: 97, available: false } }); assert.equal((await submit(cookie, receipt.approval)).status, 409);
    assert.equal(f.rows.size, 0);
    f.setHelp(ltxHelp);
    const responses = await Promise.all([submit(cookie, receipt.approval), submit(cookie, receipt.approval)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const accepted = await responses.find((r) => r.status === 200).json(); assert.equal(accepted.status, 'submitted');
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
    assert.equal([...f.rows.values()][0].max_credits, 47);
    const history = await (await api('video-tests', { cookie })).json(); assert.equal(history.tests[0].model_id, 97);
    f.setTaskResult({ status: 'failed', billing: { charged: 0 }, items: [{ status: 'failed', error_message: 'No specific reason https://private.example?token=SECRET' }] });
    const task = await (await api('video-task', { cookie, method: 'POST', data: { id: accepted.id } })).json();
    assert.equal(task.task.status, 'failed'); assert.equal(task.task.billing.charged, 0); assert.equal(task.task.item_failures[0].reason_hidden, true);
    const detail = () => api('video-private-failure', { cookie, method: 'POST', data: { id: accepted.id, acknowledge: true } });
    const privateResult = await (await detail()).text(); assert.match(privateResult, /No specific reason/); assert.doesNotMatch(privateResult, /private\.example|SECRET/);
    assert.equal((await submit(cookie, receipt.approval)).status, 409);
  } finally { globalThis.fetch = original; }
});

test('LTX storage failures and uncertain dispatch never create a second paid request', async () => {
  const original = globalThis.fetch, warn = console.warn, f = ltxFixture(); globalThis.fetch = f.fetch; console.warn = () => {};
  try {
    const cookie = await connect(); const ready = async () => (await api('ltx-prepare', { cookie, method: 'POST', data: ltxInput })).json();
    const receipt = await ready(); f.setDbMode('unavailable'); assert.equal((await submit(cookie, receipt.approval)).status, 503);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 0);
    f.setDbMode('ok'); f.setGenerateMode('lost');
    const result = await (await submit(cookie, receipt.approval)).json(); assert.equal(result.status, 'unknown');
    assert.equal([...f.rows.values()][0].status, 'unknown');
    assert.equal((await submit(cookie, receipt.approval)).status, 409);
    const next = await ready(); const blocked = await submit(cookie, next.approval); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).video_dispatch, undefined);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_video').length, 1);
  } finally { globalThis.fetch = original; console.warn = warn; }
});
