import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import worker from '../src/worker.js';
import { videoHeadroom } from '../src/lib/freebeatVideoTestSettings.js';

const base = 'https://blea-ai.blea-ai.workers.dev';
const env = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'FAKE-SERVICE-SECRET',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
};

function api(path, { token = 'admin', cookie, method = 'GET', data, origin = base } = {}) {
  return worker.fetch(new Request(`${base}/api/freebeat/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json', origin } : {}),
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  }), env);
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
  const rows = new Map();
  const calls = [];
  let scope = 'freebeat:read freebeat:generate';
  let quote = { status: 'quoted', credits: 855 };
  let generateMode = 'success';
  let taskStatus = { status: 'completed', message: 'Selesai di https://secret.internal/x?token=TOP' };
  let taskResult = {
    status: 'completed',
    result: { video_url: 'https://cdn.example/dance.mp4', cover_url: 'https://cdn.example/cover.jpg' },
    billing: { charged: 855, refunded: null, net: 855, refund_state: null },
  };
  let sessionPayload = {
    status: 'action_required',
    stage: 'choreography_plan',
    auto_mode: false,
    latest_message: 'Pilih gaya lampu panggung, jangan hubungi user@example.com',
    session_url: 'https://freebeat.ai/session/dance-abc',
    messages: [{ role: 'agent', text: 'Rencana panggung neon siap.' }],
    media_links: ['https://cdn.example/preview.mp4', 'javascript:alert(1)'],
  };

  return {
    rows,
    calls,
    setScope(v) { scope = v; },
    setQuote(v) { quote = v; },
    setGenerateMode(v) { generateMode = v; },
    setTaskStatus(v) { taskStatus = v; },
    setTaskResult(v) { taskResult = v; },
    setSessionPayload(v) { sessionPayload = v; },
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      if (url.href === 'https://supabase.example/auth/v1/user') {
        const bearer = init.headers.authorization.replace('Bearer ', '');
        return Response.json({ id: bearer, app_metadata: { role: bearer === 'user' ? 'user' : 'admin' } });
      }
      if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
      if (url.href === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: 'PROVIDER-SECRET', expires_in: 600, scope });
      if (url.pathname === '/rest/v1/freebeat_admin_dance_tests') {
        assert.equal(init.redirect, 'manual');
        if (init.method === 'POST') {
          const row = JSON.parse(init.body);
          if (rows.has(row.id) || [...rows.values()].some((r) => r.admin_id === row.admin_id && ['unknown', 'dispatching'].includes(r.status))) {
            return new Response(null, { status: 409 });
          }
          row.created_at = new Date().toISOString();
          rows.set(row.id, row);
          return Response.json([row]);
        }
        if (init.method === 'PATCH') {
          const id = url.searchParams.get('id').slice(3);
          const row = rows.get(id);
          if (!row || row.admin_id !== url.searchParams.get('admin_id').slice(3) || row.status !== 'dispatching') {
            return Response.json([]);
          }
          Object.assign(row, JSON.parse(init.body));
          return Response.json([row]);
        }
        const owner = url.searchParams.get('admin_id').slice(3);
        const id = url.searchParams.get('id')?.slice(3);
        return Response.json([...rows.values()].filter((row) => row.admin_id === owner && (!id || row.id === id)));
      }
      assert.equal(url.href, 'https://freebeat.ai/api/mcp');
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.method === 'initialize') return Response.json({ id: body.id, result: { protocolVersion: '2025-03-26' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') {
        return Response.json({
          id: body.id,
          result: {
            tools: [
              { name: 'upload_audio', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } } },
              { name: 'generate_dance_video', inputSchema: { type: 'object', required: ['music_id', 'auto_mode'], properties: { music_id: { type: 'string' }, auto_mode: { type: 'boolean' }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4', 'PRIVATE-ENUM'] } } } },
              { name: 'get_task_result', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
              { name: 'get_video_session', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
              { name: 'send_video_agent_message', inputSchema: { type: 'object', required: ['task_id', 'message'], properties: { task_id: { type: 'string' }, message: { type: 'string' }, auto_mode: { type: 'boolean' } } } },
            ],
          },
        });
      }
      const name = body.params.name;
      let data;
      if (name === 'upload_audio') {
        assert.deepEqual(body.params.arguments, { url: 'https://audio.example/song.mp3' });
        data = { music_id: 'music:777', status: 'ready' };
      } else if (name === 'quote_generation') {
        assert.equal(body.params.arguments.tool, 'generate_dance_video');
        data = quote;
      } else if (name === 'generate_dance_video') {
        if (generateMode === 'lost') throw new Error('NETWORK-LOST');
        if (generateMode === 'preparing') {
          data = { success: true, status: 'preparing', music_id: 98765, retry_after_seconds: 12 };
        } else {
          data = {
            task_id: 'dance:task-abc',
            status: 'running',
            session_url: 'https://freebeat.ai/session/dance-abc',
          };
        }
      } else if (name === 'get_task_status') {
        assert.deepEqual(body.params.arguments, { task_id: 'dance:task-abc' });
        data = taskStatus;
      } else if (name === 'get_task_result') {
        assert.deepEqual(body.params.arguments, { task_id: 'dance:task-abc' });
        data = taskResult;
      } else if (name === 'get_video_session') {
        assert.deepEqual(body.params.arguments, { task_id: 'dance:task-abc' });
        data = sessionPayload;
      } else if (name === 'send_video_agent_message') {
        data = { reply: 'Gunakan pencahayaan hangat. https://internal.invalid/leak', ...sessionPayload, auto_mode: true };
      } else {
        throw new Error(`Unexpected tool: ${name}`);
      }
      return Response.json({ id: body.id, result: { structuredContent: data } });
    },
  };
}

test('migration schema enforces dance at-most-once lock and mutual exclusion of unknown cost vs max_credits', async () => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema if not exists auth; create table auth.users (id uuid primary key);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261126000000_freebeat_admin_dance_tests.sql', import.meta.url), 'utf8'));
  const admin = '11111111-1111-4111-8111-111111111111';
  await db.query('insert into auth.users(id) values ($1)', [admin]);
  const hash = 'A'.repeat(43);

  await assert.rejects(db.query(
    'insert into public.freebeat_admin_dance_tests(id, admin_id, session_hash, music_id, aspect_ratio, auto_mode, quote_credits, max_credits, accept_unknown_cost, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', admin, hash, 'music:1', '9:16', true, null, 100, true, 'dispatching'],
  ));

  await db.query(
    'insert into public.freebeat_admin_dance_tests(id, admin_id, session_hash, music_id, aspect_ratio, auto_mode, quote_credits, max_credits, accept_unknown_cost, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', admin, hash, 'music:1', '9:16', true, 855, 900, false, 'unknown'],
  );

  await assert.rejects(db.query(
    'insert into public.freebeat_admin_dance_tests(id, admin_id, session_hash, music_id, aspect_ratio, auto_mode, quote_credits, max_credits, accept_unknown_cost, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    ['cccccccc-cccc-4ccc-8ccc-cccccccccccc', admin, hash, 'music:2', '9:16', true, null, null, true, 'dispatching'],
  ));
  await db.close();
});

test('dance workflow covers schemas, audio upload, max_credits approval, polling get_task_result, and agent session continuation', async () => {
  const original = globalThis.fetch;
  const f = fixture();
  globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setScope('freebeat:read');
    const readOnly = await connect();
    f.setScope('freebeat:read freebeat:generate');

    assert.equal((await api('dance-schemas', { token: 'user', cookie, method: 'POST', data: {} })).status, 403);
    const schemasRes = await api('dance-schemas', { cookie, method: 'POST', data: {} });
    assert.equal(schemasRes.status, 200);
    const schemas = await schemasRes.json();
    assert.deepEqual(schemas.tools.generate_dance_video.properties.aspect_ratio.known_enum_values, ['16:9', '9:16', '1:1', '4:3', '3:4']);
    assert.equal(schemas.tools.generate_dance_video.properties.aspect_ratio.enum_incomplete, true);

    const uploadRes = await api('dance-upload-audio', { cookie, method: 'POST', data: { audio_url: 'https://audio.example/song.mp3' } });
    assert.equal(uploadRes.status, 200);
    const uploaded = await uploadRes.json();
    assert.equal(uploaded.music_id, 'music:777');

    assert.equal((await api('dance-prepare', { cookie: readOnly, method: 'POST', data: { music_id: 'music:777', aspect_ratio: '9:16', auto_mode: false } })).status, 403);

    const prepRes = await api('dance-prepare', {
      cookie,
      method: 'POST',
      data: {
        music_id: 'music:777',
        aspect_ratio: '9:16',
        auto_mode: false,
        prompt: 'Rooftop choreography',
        image_urls: ['https://cdn.example/dancer.png'],
      },
    });
    assert.equal(prepRes.status, 200);
    const prep = await prepRes.json();
    assert.equal(prep.credits, 855);
    assert.equal(prep.max_credits, 855 + videoHeadroom(855));
    assert.equal(prep.accept_unknown_cost, false);

    // Quote change blocks submit before any generate_dance_video dispatch
    f.setQuote({ status: 'quoted', credits: 900 });
    assert.equal((await api('dance-submit', { cookie, method: 'POST', data: { approval: prep.approval, confirm: true } })).status, 409);
    assert.equal(f.calls.filter((c) => c.params?.name === 'generate_dance_video').length, 0);

    // Valid submit succeeds and records dance: task_id
    f.setQuote({ status: 'quoted', credits: 855 });
    const subRes = await api('dance-submit', { cookie, method: 'POST', data: { approval: prep.approval, confirm: true } });
    assert.equal(subRes.status, 200);
    const sub = await subRes.json();
    assert.equal(sub.status, 'submitted');
    assert.equal(sub.session_url, 'https://freebeat.ai/session/dance-abc');

    const genCall = f.calls.find((c) => c.params?.name === 'generate_dance_video');
    assert.deepEqual(genCall.params.arguments, {
      music_id: 'music:777',
      auto_mode: false,
      aspect_ratio: '9:16',
      prompt: 'Rooftop choreography',
      image_urls: ['https://cdn.example/dancer.png'],
      max_credits: 855 + videoHeadroom(855),
    });

    const testsRes = await api('dance-tests', { cookie });
    const list = (await testsRes.json()).tests;
    assert.equal(list.length, 1);
    assert.equal(list[0].canPoll, true);

    const pollRes = await api('dance-task', { cookie, method: 'POST', data: { id: sub.id } });
    assert.equal(pollRes.status, 200);
    const { task } = await pollRes.json();
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.videos, ['https://cdn.example/dance.mp4']);
    assert.equal(task.cover_url, 'https://cdn.example/cover.jpg');
    assert.doesNotMatch(task.message, /secret\.internal|token=TOP/);

    const sessRes = await api('dance-session', { cookie, method: 'POST', data: { id: sub.id } });
    assert.equal(sessRes.status, 200);
    const { session } = await sessRes.json();
    assert.deepEqual(session.media, ['https://cdn.example/preview.mp4']);
    assert.doesNotMatch(session.latest_message, /user@example\.com/);

    const msgRes = await api('dance-message', { cookie, method: 'POST', data: { id: sub.id, message: 'Gunakan cahaya hangat', auto_mode: true } });
    assert.equal(msgRes.status, 200);
    const msgBody = await msgRes.json();
    assert.doesNotMatch(msgBody.reply, /internal\.invalid/);
  } finally {
    globalThis.fetch = original;
  }
});

test('dance handles accept_unknown_cost consent, preparing status, and unknown dispatch lock cleanly', async () => {
  const original = globalThis.fetch;
  const f = fixture();
  globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();
    f.setQuote({ status: 'unavailable' });

    const prepRes = await api('dance-prepare', {
      cookie,
      method: 'POST',
      data: { music_id: '12345', aspect_ratio: '16:9', auto_mode: true },
    });
    assert.equal(prepRes.status, 200);
    const prep = await prepRes.json();
    assert.equal(prep.accept_unknown_cost, true);
    assert.equal(prep.max_credits, null);

    // Requires explicit confirm_unknown_cost=true
    assert.equal((await api('dance-submit', { cookie, method: 'POST', data: { approval: prep.approval, confirm: true } })).status, 400);

    // Preparing returns numeric music_id and releases lock cleanly
    f.setGenerateMode('preparing');
    const prepWait = await api('dance-submit', {
      cookie,
      method: 'POST',
      data: { approval: prep.approval, confirm: true, confirm_unknown_cost: true },
    });
    assert.equal(prepWait.status, 200);
    const prepData = await prepWait.json();
    assert.equal(prepData.status, 'preparing');
    assert.equal(prepData.music_id, '98765');
    assert.equal(prepData.retry_after_seconds, 12);

    // Verify lock is cleared ('reviewed') and retry dispatch with returned numeric music_id uses accept_unknown_cost
    const prep2 = await (await api('dance-prepare', {
      cookie,
      method: 'POST',
      data: { music_id: prepData.music_id, aspect_ratio: '16:9', auto_mode: true },
    })).json();
    f.setGenerateMode('lost');
    const lost = await (await api('dance-submit', {
      cookie,
      method: 'POST',
      data: { approval: prep2.approval, confirm: true, confirm_unknown_cost: true },
    })).json();
    assert.equal(lost.status, 'unknown');

    // Subsequent submit blocked by unique unresolved lock
    const blocked = await api('dance-submit', {
      cookie,
      method: 'POST',
      data: { approval: prep2.approval, confirm: true, confirm_unknown_cost: true },
    });
    assert.equal(blocked.status, 409);
  } finally {
    globalThis.fetch = original;
  }
});
