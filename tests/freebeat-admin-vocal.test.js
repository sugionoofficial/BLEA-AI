import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

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
  let quote = { status: 'quoted', credits: 640 };
  let uploadAudioPayload = { music_id: 2485485, status: 'ready' };
  let generateMode = 'success';
  let singingModeEnums = ['solo', 'duet'];
  let taskStatus = { status: 'completed', message: 'Selesai https://internal.secret/?token=abc' };
  let taskResult = {
    status: 'completed',
    result: { video_url: 'https://cdn.example/vocal-out.mp4', cover_url: 'https://cdn.example/vocal-cover.jpg' },
    billing: { charged: 640, refunded: null, net: 640 },
  };
  let sessionPayload = {
    status: 'action_required',
    stage: 'vocal_review',
    latest_message: 'Cek sinkronisasi bibir, hubungi creator@example.com',
    session_url: 'https://freebeat.ai/session/vocal-abc',
    messages: [{ role: 'agent', text: 'Preview klip vokal siap.' }],
    media_links: ['https://cdn.example/vocal-preview.mp4', 'javascript:alert(1)'],
  };

  return {
    rows,
    calls,
    setScope(v) { scope = v; },
    setQuote(v) { quote = v; },
    setUploadAudioPayload(v) { uploadAudioPayload = v; },
    setGenerateMode(v) { generateMode = v; },
    setSingingModeEnums(v) { singingModeEnums = v; },
    setTaskStatus(v) { taskStatus = v; },
    setTaskResult(v) { taskResult = v; },
    async fetch(input, init = {}) {
      const url = new URL(String(input));
      if (url.href === 'https://supabase.example/auth/v1/user') {
        const bearer = init.headers.authorization.replace('Bearer ', '');
        return Response.json({ id: bearer, app_metadata: { role: bearer === 'user' ? 'user' : 'admin' } });
      }
      if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
      if (url.href === 'https://freebeat.ai/oauth/token') return Response.json({ access_token: 'PROVIDER-SECRET', expires_in: 600, scope });
      if (url.pathname === '/rest/v1/freebeat_admin_vocal_tests') {
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
              { name: 'upload_video', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
              {
                name: 'generate_singing_video',
                inputSchema: {
                  type: 'object',
                  required: ['mode', 'image_urls', 'duration_seconds'],
                  properties: {
                    mode: { type: 'string', enum: singingModeEnums },
                    image_urls: { type: 'array', maxItems: 2, items: { type: 'string' } },
                    duration_seconds: { type: 'number', minimum: 1, maximum: 60 },
                    music_id: { type: 'integer' },
                    audio_url: { type: 'string' },
                    audio_start_seconds: { type: 'number', minimum: 0 },
                    aspect_ratio: { type: 'string', enum: ['9:16', '16:9', '1:1'] },
                    scene_prompt: { type: 'string' },
                  },
                },
              },
              {
                name: 'generate_lip_sync_video',
                inputSchema: {
                  type: 'object',
                  required: ['video_url', 'video_duration_ms'],
                  properties: {
                    video_url: { type: 'string' },
                    video_duration_ms: { type: 'integer', minimum: 1000, maximum: 120000 },
                    music_id: { type: 'integer' },
                    audio_url: { type: 'string' },
                    audio_duration_ms: { type: 'integer', minimum: 500 },
                    name: { type: 'string' },
                  },
                },
              },
              { name: 'get_task_status', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
              { name: 'get_task_result', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
              { name: 'get_video_session', inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } } },
              { name: 'send_video_agent_message', inputSchema: { type: 'object', required: ['task_id', 'message'], properties: { task_id: { type: 'string' }, message: { type: 'string' } } } },
            ],
          },
        });
      }
      const name = body.params.name;
      let data;
      if (name === 'get_balance') {
        data = { balance: 1500, credits: 1500 };
      } else if (name === 'upload_audio') {
        data = uploadAudioPayload;
      } else if (name === 'upload_video') {
        data = { video_url: 'https://freebeat.ai/media/uploaded-src.mp4', file_id: 'file_99', status: 'ready' };
      } else if (name === 'quote_generation') {
        data = quote;
      } else if (name === 'generate_singing_video' || name === 'generate_lip_sync_video') {
        if (generateMode === 'lost') throw new Error('NETWORK-LOST');
        if (generateMode === 'isError') {
          return Response.json({
            id: body.id,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'photo mode requires static.freebeat.ai url https://internal.secret/x?token=abc', code: 400 }) }],
            },
          });
        }
        if (generateMode === 'http400') {
          return new Response('Bad Request', { status: 400 });
        }
        if (generateMode === 'preparing') {
          data = { success: true, status: 'preparing', music_id: 998877, retry_after_seconds: 10 };
        } else {
          data = { task_id: `${name}:task-101`, status: 'running', session_url: 'https://freebeat.ai/session/vocal-abc' };
        }
      } else if (name === 'get_task_status') {
        data = taskStatus;
      } else if (name === 'get_task_result') {
        data = taskResult;
      } else if (name === 'get_video_session') {
        data = sessionPayload;
      } else if (name === 'send_video_agent_message') {
        data = { reply: 'Oke, render akhir dimulai.', session: { status: 'running', stage: 'render' } };
      }
      return Response.json({ id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
    },
  };
}

test('Freebeat vocal migrations SQL are valid in PGlite and seed singing & lip-sync credit prices', async () => {
  const db = new PGlite();
  await db.exec(`
    DO $$ BEGIN
      CREATE ROLE anon;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      CREATE ROLE authenticated;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    DO $$ BEGIN
      CREATE ROLE service_role;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS public.credit_model_prices (
      provider text NOT NULL,
      model text NOT NULL,
      modality text NOT NULL,
      credits integer NOT NULL,
      active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (provider, model, modality)
    );
  `);
  const vocalTestsSql = await readFile(new URL('../supabase/migrations/20261202000000_freebeat_admin_vocal_tests.sql', import.meta.url), 'utf8');
  const vocalPricesSql = await readFile(new URL('../supabase/migrations/20261203000000_freebeat_vocal_video_prices.sql', import.meta.url), 'utf8');
  await db.exec(vocalTestsSql);
  await db.exec(vocalPricesSql);

  const prices = await db.query('SELECT provider, model, modality, credits, active FROM public.credit_model_prices ORDER BY model');
  assert.deepEqual(prices.rows, [
    { provider: 'freebeat', model: 'generate_lip_sync_video', modality: 'video', credits: 3000, active: true },
    { provider: 'freebeat', model: 'generate_singing_video', modality: 'video', credits: 3000, active: true },
  ]);

  // Partial unique index prevents two unresolved rows for same admin
  await db.query(`INSERT INTO auth.users (id) VALUES ('00000000-0000-4000-8000-000000000099')`);
  await db.query(
    `INSERT INTO public.freebeat_admin_vocal_tests (id, admin_id, tool_name, status, session_hash, max_credits) VALUES ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000099', 'generate_singing_video', 'dispatching', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 500)`,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO public.freebeat_admin_vocal_tests (id, admin_id, tool_name, status, session_hash, max_credits) VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000099', 'generate_lip_sync_video', 'unknown', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 500)`,
    ),
  );
});

test('Admin vocal routes handle video upload, singing solo/duet mode resolution, lip-sync, poll, and session', async () => {
  const f = fixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.fetch;
  try {
    const cookie = await connect();

    // Non-admin blocked
    assert.equal((await api('vocal-quote', { token: 'user', cookie, method: 'POST', data: {} })).status, 403);

    // Upload video to Freebeat MCP
    const upVid = await api('vocal-upload-video', { cookie, method: 'POST', data: { video_url: 'https://storage.example/src.mp4' } });
    assert.equal(upVid.status, 200);
    const upVidBody = await upVid.json();
    assert.equal(upVidBody.video_url, 'https://freebeat.ai/media/uploaded-src.mp4');
    assert.equal(upVidBody.file_id, 'file_99');

    // Quote singing video (mode auto -> solo via schema)
    const quoteRes = await api('vocal-quote', {
      cookie,
      method: 'POST',
      data: {
        tool: 'generate_singing_video',
        mode: 'auto',
        image_urls: ['https://storage.example/singer.png'],
        duration_seconds: 15,
        audio_url: 'https://storage.example/song.mp3',
        aspect_ratio: '9:16',
        scene_prompt: 'Warm spotlight stage',
      },
    });
    assert.equal(quoteRes.status, 200);
    const quoteBody = await quoteRes.json();
    assert.equal(quoteBody.credits, 640);
    assert.equal(quoteBody.cost_mode, 'max_credits');
    assert.equal(quoteBody.parameters.mode, 'solo');

    // Upload audio to Freebeat MCP -> returns integer music_id
    const upAud = await api('vocal-upload-audio', { cookie, method: 'POST', data: { audio_url: 'https://storage.example/duet.mp3' } });
    assert.equal(upAud.status, 200);
    const upAudBody = await upAud.json();
    assert.equal(upAudBody.music_id, '2485485');

    // Prepare + submit singing video using integer music_id
    const prep = await api('vocal-prepare', {
      cookie,
      method: 'POST',
      data: {
        tool: 'generate_singing_video',
        mode: 'duet',
        image_urls: ['https://storage.example/s1.png', 'https://storage.example/s2.png'],
        duration_seconds: 15,
        music_id: Number(upAudBody.music_id),
        aspect_ratio: '16:9',
        scene_prompt: 'Concert stage duet',
      },
    });
    assert.equal(prep.status, 200);
    const prepBody = await prep.json();
    assert.equal(prepBody.parameters.mode, 'duet');
    assert.ok(prepBody.approval);

    // Reject missing confirmation
    assert.equal((await api('vocal-submit', { cookie, method: 'POST', data: { approval: prepBody.approval, confirm: false } })).status, 400);

    const sub = await api('vocal-submit', {
      cookie,
      method: 'POST',
      data: { approval: prepBody.approval, confirm: true },
    });
    assert.equal(sub.status, 200);
    const subBody = await sub.json();
    assert.equal(subBody.status, 'submitted');
    assert.ok(subBody.id);
    assert.equal(subBody.session_url, 'https://freebeat.ai/session/vocal-abc');
    // Check upload_audio -> numeric music_id forwarded instead of raw audio_url
    const genCall = f.calls.findLast((c) => c.params?.name === 'generate_singing_video');
    assert.equal(genCall.params.arguments.music_id, 2485485);
    assert.equal(genCall.params.arguments.audio_url, undefined);

    // Replay ticket blocked
    assert.equal((await api('vocal-submit', { cookie, method: 'POST', data: { approval: prepBody.approval, confirm: true } })).status, 409);

    // Lip-Sync video with unavailable quote (accept_unknown_cost) and non-numeric music_id -> fallback to audio_url
    f.setQuote({ status: 'unavailable' });
    f.setUploadAudioPayload({ status: 'ready' });
    const lipPrep = await api('vocal-prepare', {
      cookie,
      method: 'POST',
      data: {
        tool: 'generate_lip_sync_video',
        video_url: 'https://freebeat.ai/media/uploaded-src.mp4',
        video_duration_ms: 12500,
        audio_url: 'https://storage.example/voice.mp3',
        name: 'Clip Lip Sync 1',
      },
    });
    assert.equal(lipPrep.status, 200);
    const lipPrepBody = await lipPrep.json();
    assert.equal(lipPrepBody.accept_unknown_cost, true);
    assert.equal(lipPrepBody.parameters.audio_url, 'https://storage.example/voice.mp3');

    const lipSub = await api('vocal-submit', { cookie, method: 'POST', data: { approval: lipPrepBody.approval, confirm: true, confirm_unknown_cost: true } });
    assert.equal(lipSub.status, 200);
    const lipSubBody = await lipSub.json();
    assert.ok(lipSubBody.id);
    assert.equal(lipSubBody.status, 'submitted');
    const lipGenCall = f.calls.findLast((c) => c.params?.name === 'generate_lip_sync_video');
    assert.equal(lipGenCall.params.arguments.video_duration_ms, 12500);
    assert.equal(lipGenCall.params.arguments.audio_url, 'https://storage.example/voice.mp3');
    assert.equal(lipGenCall.params.arguments.accept_unknown_cost, true);

    // List tests, poll, session, message
    const listRes = await api('vocal-tests', { cookie });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.tests.length, 2);
    assert.ok(listBody.tests.some((t) => t.id === subBody.id && t.tool_name === 'generate_singing_video'));
    assert.ok(listBody.tests.some((t) => t.id === lipSubBody.id && t.tool_name === 'generate_lip_sync_video'));

    const pollRes = await api('vocal-task', { cookie, method: 'POST', data: { id: lipSubBody.id } });
    assert.equal(pollRes.status, 200);
    const pollBody = await pollRes.json();
    assert.deepEqual(pollBody.task.videos, ['https://cdn.example/vocal-out.mp4']);

    const sessRes = await api('vocal-session', { cookie, method: 'POST', data: { id: lipSubBody.id } });
    assert.equal(sessRes.status, 200);
    const sessBody = await sessRes.json();
    assert.doesNotMatch(sessBody.session.latest_message, /creator@example\.com/);
    assert.deepEqual(sessBody.session.media, ['https://cdn.example/vocal-preview.mp4']);

    const msgRes = await api('vocal-message', { cookie, method: 'POST', data: { id: lipSubBody.id, message: 'Lanjutkan render final' } });
    assert.equal(msgRes.status, 200);
    assert.match((await msgRes.json()).reply, /render akhir/i);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FreebeatSingingLipSyncDiagnostic JSDOM submits, polls, and resets state on disconnect', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  let root = null;

  try {
    const { FreebeatSingingLipSyncDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatSingingLipSyncDiagnostic.jsx');

    const calls = [];
    let resolveSlowQuote = null;
    const request = async (action, _token, payload) => {
      calls.push([action, payload]);
      if (action === 'vocal-quote') {
        return new Promise((resolve) => {
          resolveSlowQuote = resolve;
        });
      }
      if (action === 'vocal-prepare') {
        return {
          approval: 'ticket-1',
          tool: 'generate_singing_video',
          parameters: { mode: 'solo', image_urls: ['https://cdn.example/singer.png'], duration_seconds: 15 },
          credits: 500,
          max_credits: 550,
          accept_unknown_cost: false,
          cost_mode: 'max_credits',
          expiresAt: Date.now() + 60000,
        };
      }
      if (action === 'vocal-submit') {
        return {
          id: 'vocal-row-diag',
          status: 'unknown',
          initial_diagnostics: { received: true, messages: ['status: error', 'root_keys: code, detail'] },
        };
      }
      if (action === 'vocal-tests') {
        return { tests: [{ id: 'vocal-row-1', tool_name: 'generate_singing_video', status: 'submitted', task_id: 'task-1', canPoll: true, created_at: new Date().toISOString() }] };
      }
      return {};
    };

    root = createRoot(document.getElementById('root'));
    const renderComponent = (connected, visibilityVersion = 1) => React.act(async () => {
      root.render(React.createElement(FreebeatSingingLipSyncDiagnostic, {
        token: 'admin-jwt',
        userId: '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5',
        connected,
        imageAccess: true,
        hasSession: true,
        visibilityVersion,
        request,
      }));
    });

    await renderComponent(true, 1);

    const setInputValue = (el, val) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };

    // Add singer photo + audio URL so Periksa quote vokal enables
    const audioInput = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent.includes('URL HTTPS audio'))
      ?.querySelector('input');
    const imgUrlInput = Array.from(document.querySelectorAll('label'))
      .find((l) => l.textContent.includes('URL HTTPS foto penyanyi'))
      ?.querySelector('input');
    const addImgBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Tambah foto');
    assert.ok(audioInput && imgUrlInput && addImgBtn);

    await React.act(async () => {
      setInputValue(audioInput, 'https://cdn.example/song.mp3');
      setInputValue(imgUrlInput, 'https://cdn.example/singer.png');
    });
    await React.act(async () => { addImgBtn.click(); });

    // Trigger quote and disconnect mid-flight to verify requestVersionRef prevents stale results
    const quoteBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Periksa quote vokal'));
    assert.ok(quoteBtn && !quoteBtn.disabled);
    await React.act(async () => { quoteBtn.click(); });
    assert.ok(typeof resolveSlowQuote === 'function');
    await renderComponent(false, 2);
    await React.act(async () => {
      resolveSlowQuote({ credits: 500, quote: { status: 'quoted', credits: 500 } });
    });
    assert.equal(document.body.textContent.includes('"credits": 500'), false, 'Stale quote must not render after disconnect');

    // Reconnect and verify private_diagnostics checkbox + private diagnostic panel
    await renderComponent(true, 3);
    const prepBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Siapkan persetujuan vokal'));
    assert.ok(prepBtn && !prepBtn.disabled);
    await React.act(async () => { prepBtn.click(); });

    const confirmCbs = Array.from(document.querySelectorAll('.freebeat-confirm input[type="checkbox"]'));
    assert.ok(confirmCbs.length >= 2);
    const submitApproveCb = confirmCbs.find((cb) => cb.closest('label')?.textContent.includes('Saya menyetujui pengiriman satu kali'));
    const privDiagCb = confirmCbs.find((cb) => cb.closest('label')?.textContent.includes('tampilkan pesan respons awal secara privat'));
    assert.ok(submitApproveCb && privDiagCb);
    await React.act(async () => {
      submitApproveCb.click();
      privDiagCb.click();
    });

    const sendBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Setujui dan kirim video'));
    assert.ok(sendBtn && !sendBtn.disabled);
    await React.act(async () => { sendBtn.click(); });

    const submitCall = calls.find(([a]) => a === 'vocal-submit');
    assert.equal(submitCall[1].private_diagnostics, true);
    assert.match(document.body.textContent, /Pesan respons awal privat/);
    assert.match(document.body.textContent, /root_keys: code, detail/);

    const hideBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Sembunyikan respons awal'));
    assert.ok(hideBtn);
    await React.act(async () => { hideBtn.click(); });
    assert.equal(document.body.textContent.includes('Pesan respons awal privat'), false);
  } finally {
    if (root) await React.act(async () => { root.unmount(); });
    await vite.close();
    dom.window.close();
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});

test('vocal-submit private_diagnostics captures redacted isError and HTTP 400 failure details', async () => {
  const f = fixture();
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.fetch.bind(f);
  try {
    const cookie = await connect();

    // Non-boolean private_diagnostics rejected
    const badRes = await api('vocal-submit', {
      cookie,
      method: 'POST',
      data: { approval: 'abc', confirm: true, private_diagnostics: 'yes' },
    });
    assert.equal(badRes.status, 400);

    // 1) isError payload captured and sanitized when private_diagnostics: true
    f.setGenerateMode('isError');
    const prep1 = await api('vocal-prepare', {
      cookie,
      method: 'POST',
      data: { tool: 'generate_singing_video', mode: 'solo', image_urls: ['https://cdn.example/s1.png'], duration_seconds: 15, audio_url: 'https://cdn.example/song.mp3' },
    });
    assert.equal(prep1.status, 200);
    const prep1Body = await prep1.json();
    const sub1 = await api('vocal-submit', {
      cookie,
      method: 'POST',
      data: { approval: prep1Body.approval, confirm: true, private_diagnostics: true },
    });
    assert.equal(sub1.status, 200);
    const sub1Body = await sub1.json();
    assert.equal(sub1Body.status, 'unknown');
    assert.equal(sub1Body.initial_diagnostics.received, true);
    assert.ok(sub1Body.initial_diagnostics.messages.some((m) => m.includes('[URL disembunyikan]') && m.includes('static.freebeat.ai')));
    assert.equal(sub1Body.initial_diagnostics.messages.join(' ').includes('internal.secret'), false);

    // Unlock row in test fixture for second diagnostic scenario
    f.rows.get(sub1Body.id).status = 'reviewed';

    // 2) HTTP 400 captured in initial_diagnostics with received: false
    f.setGenerateMode('http400');
    const prep2 = await api('vocal-prepare', {
      cookie,
      method: 'POST',
      data: { tool: 'generate_singing_video', mode: 'solo', image_urls: ['https://cdn.example/s1.png'], duration_seconds: 15, audio_url: 'https://cdn.example/song.mp3' },
    });
    assert.equal(prep2.status, 200);
    const sub2 = await api('vocal-submit', {
      cookie,
      method: 'POST',
      data: { approval: (await prep2.json()).approval, confirm: true, private_diagnostics: true },
    });
    assert.equal(sub2.status, 200);
    const sub2Body = await sub2.json();
    assert.equal(sub2Body.status, 'unknown');
    assert.equal(sub2Body.initial_diagnostics.received, false);
    assert.match(sub2Body.initial_diagnostics.messages.join(' '), /HTTP 400.*FB-MCP-GENERATE-HTTP/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
