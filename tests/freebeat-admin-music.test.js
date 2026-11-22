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
  let quoteCredits = { 129: 42, 194: 73 };
  let generateMode = 'success';
  let taskStatus = { status: 'completed', message: 'Selesai https://internal.secret/?token=abc' };
  let taskResult = {
    status: 'completed',
    result: {
      music_id: 88991122,
      audio_url: 'https://cdn.example/music-out.mp3',
      cover_url: 'https://cdn.example/music-cover.jpg',
    },
    billing: { charged: 73, refunded: 0, net: 73 },
  };
  let catalogModels = [
    { model_id: 129, name: 'Lyria 3 Pro', available: true, pricing: { status: 'quoted', credits: 42 }, supports_duration: false, supports_lyrics: null, supports_instrumental: null, requires_lyrics: null },
    { model_id: 194, name: 'Suno v6', available: true, pricing: { status: 'quoted', credits: 73 }, supports_duration: false, supports_lyrics: null, supports_instrumental: null, requires_lyrics: null },
    { model_id: 999, name: 'Legacy Music', available: false, pricing: { status: 'unavailable', credits: null }, supports_duration: false },
    { model_id: 555, name: 'Timed Lyrics Model', available: true, pricing: { status: 'quoted', credits: 60 }, supports_duration: true, requires_lyrics: true, supports_instrumental: false },
  ];

  return {
    rows,
    calls,
    setScope(v) { scope = v; },
    setQuoteCredits(modelId, credits) { quoteCredits[modelId] = credits; },
    setGenerateMode(v) { generateMode = v; },
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
      if (url.pathname === '/rest/v1/freebeat_admin_music_tests') {
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
          if (!row || row.status !== 'dispatching') return Response.json([]);
          Object.assign(row, JSON.parse(init.body));
          return Response.json([row]);
        }
        if ((init.method || 'GET') === 'GET') {
          const idFilter = url.searchParams.get('id')?.slice(3);
          const adminFilter = url.searchParams.get('admin_id')?.slice(3);
          const list = [...rows.values()]
            .filter((r) => (!idFilter || r.id === idFilter) && (!adminFilter || r.admin_id === adminFilter))
            .sort((a, b) => b.created_at.localeCompare(a.created_at));
          return Response.json(list);
        }
      }
      assert.equal(url.href, 'https://freebeat.ai/api/mcp');
      const body = JSON.parse(init.body);
      calls.push(body);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      assert.equal(body.method, 'tools/call');
      const { name, arguments: args } = body.params;
      if (name === 'list_music_models') {
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ models: catalogModels }) }] } });
      }
      if (name === 'quote_generation') {
        assert.equal(args.tool, 'generate_music');
        const c = quoteCredits[args.parameters.model_id];
        if (c === null || c === undefined) {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable' }) }] } });
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'quoted', credits: c }) }] } });
      }
      if (name === 'generate_music') {
        assert.equal('accept_unknown_cost' in args, false);
        assert.equal(typeof args.max_credits, 'number');
        if (generateMode === 'rpc_error') {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'rate limit hit Bearer SECRET-KEY' }) }] } });
        }
        if (generateMode === 'malformed') {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'weird' }) }] } });
        }
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ task_id: 'music-task-001', status: 'queued' }) }] } });
      }
      if (name === 'get_task_status') {
        assert.equal(args.task_id, 'music-task-001');
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(taskStatus) }] } });
      }
      if (name === 'get_task_result') {
        assert.equal(args.task_id, 'music-task-001');
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(taskResult) }] } });
      }
      throw new Error(`Unexpected tool call: ${name}`);
    },
  };
}

test('SQL migration freebeat_admin_music_tests enforces single unresolved lock, task_id invariant, and role isolation', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261204000000_freebeat_admin_music_tests.sql', import.meta.url), 'utf8');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111');
    `);
    await db.exec(sql);

    const uid = '11111111-1111-4111-8111-111111111111';
    const hash = 'A'.repeat(43);

    // Insert unknown row -> succeeds
    await db.exec(`
      INSERT INTO public.freebeat_admin_music_tests (id, admin_id, session_hash, model_id, quote_credits, max_credits, status)
      VALUES ('22222222-2222-4222-8222-222222222222', '${uid}', '${hash}', 129, 42, 42, 'unknown');
    `);

    // Second unresolved row for same admin fails unique partial index
    await assert.rejects(
      db.exec(`
        INSERT INTO public.freebeat_admin_music_tests (id, admin_id, session_hash, model_id, quote_credits, max_credits, status)
        VALUES ('33333333-3333-4333-8333-333333333333', '${uid}', '${hash}', 194, 73, 73, 'dispatching');
      `),
      /freebeat_one_unresolved_music_test_per_admin/,
    );

    // submitted without task_id violates check constraint
    await assert.rejects(
      db.exec(`
        INSERT INTO public.freebeat_admin_music_tests (id, admin_id, session_hash, model_id, quote_credits, max_credits, status, task_id)
        VALUES ('44444444-4444-4444-8444-444444444444', '${uid}', '${hash}', 194, 73, 73, 'submitted', NULL);
      `),
    );

    // max_credits < quote_credits violates check constraint
    await assert.rejects(
      db.exec(`
        INSERT INTO public.freebeat_admin_music_tests (id, admin_id, session_hash, model_id, quote_credits, max_credits, status, task_id)
        VALUES ('55555555-5555-4555-8555-555555555555', '${uid}', '${hash}', 194, 73, 70, 'submitted', 't-1');
      `),
    );

    // duration_seconds outside 10..300 rejected
    await assert.rejects(
      db.exec(`
        INSERT INTO public.freebeat_admin_music_tests (id, admin_id, session_hash, model_id, duration_seconds, quote_credits, max_credits, status, task_id)
        VALUES ('66666666-6666-4666-8666-666666666666', '${uid}', '${hash}', 194, 5, 73, 73, 'submitted', 't-2');
      `),
    );

    // Marking row reviewed clears lock and lets new test submit
    await db.exec(`UPDATE public.freebeat_admin_music_tests SET status = 'reviewed' WHERE id = '22222222-2222-4222-8222-222222222222';`);
    await db.exec(`
      INSERT INTO public.freebeat_admin_music_tests (id, admin_id, session_hash, model_id, quote_credits, max_credits, status, task_id)
      VALUES ('77777777-7777-4777-8777-777777777777', '${uid}', '${hash}', 194, 73, 73, 'submitted', 'music-task-1');
    `);
  } finally {
    await db.close();
  }
});

test('music-quote, music-prepare, music-submit, music-tests, and music-task enforce auth, validation, 12000-char lyrics, quote re-check, and locking', async () => {
  const realFetch = globalThis.fetch;
  const mock = fixture();
  globalThis.fetch = mock.fetch;
  try {
    // 1. Auth & permission enforcement
    assert.equal((await api('music-quote', { token: null, method: 'POST', data: { model_id: 129, prompt: 'test' } })).status, 401);
    assert.equal((await api('music-quote', { token: 'user', method: 'POST', data: { model_id: 129, prompt: 'test' } })).status, 403);

    mock.setScope('freebeat:read');
    const readOnlyCookie = await connect();
    assert.equal((await api('music-quote', { cookie: readOnlyCookie, method: 'POST', data: { model_id: 129, prompt: 'clean synth beat' } })).status, 200);
    assert.equal((await api('music-prepare', { cookie: readOnlyCookie, method: 'POST', data: { model_id: 129, prompt: 'clean synth beat' } })).status, 403);

    mock.setScope('freebeat:read freebeat:generate');
    const cookie = await connect();

    // 2. Origin & parameter validation
    assert.equal((await api('music-quote', { cookie, origin: 'https://evil.example', method: 'POST', data: { model_id: 129, prompt: 'x' } })).status, 403);
    assert.equal((await api('music-quote', { cookie, method: 'POST', data: { model_id: 129, prompt: 'x', instrumental: true, lyrics: 'la la' } })).status, 400);
    assert.equal((await api('music-quote', { cookie, method: 'POST', data: { model_id: 129, prompt: 'x', duration_seconds: 30 } })).status, 400);
    assert.equal((await api('music-quote', { cookie, method: 'POST', data: { model_id: 999, prompt: 'x' } })).status, 409);
    assert.equal((await api('music-quote', { cookie, method: 'POST', data: { model_id: 555, prompt: 'x' } })).status, 400);
    assert.equal((await api('music-quote', { cookie, method: 'POST', data: { model_id: 555, prompt: 'x', lyrics: 'la', instrumental: true } })).status, 400);

    // 3. Large 12,000-character lyrics flows through quote -> prepare -> submit cleanly
    const longLyrics = `[Verse]\n${'Neon rain falls soft tonight '.repeat(425)}`.slice(0, 12000);
    const quoteRes = await api('music-quote', { cookie, method: 'POST', data: { model_id: 194, prompt: 'Synthwave ballad', lyrics: longLyrics } });
    assert.equal(quoteRes.status, 200);
    assert.equal((await quoteRes.json()).credits, 73);

    const prepRes = await api('music-prepare', { cookie, method: 'POST', data: { model_id: 194, prompt: 'Synthwave ballad', lyrics: longLyrics } });
    assert.equal(prepRes.status, 200);
    const prepBody = await prepRes.json();
    assert.equal(prepBody.credits, 73);
    assert.equal(prepBody.max_credits, 73);
    assert.ok(prepBody.approval.length > 16000);

    // Quote change between prepare and submit blocks with 409 without dispatching
    mock.setQuoteCredits(194, 85);
    const changedRes = await api('music-submit', { cookie, method: 'POST', data: { approval: prepBody.approval, confirm: true } });
    assert.equal(changedRes.status, 409);
    assert.equal(mock.rows.size, 0);

    // Reset quote to 73 and submit successfully
    mock.setQuoteCredits(194, 73);
    const submitRes = await api('music-submit', { cookie, method: 'POST', data: { approval: prepBody.approval, confirm: true, private_diagnostics: true } });
    assert.equal(submitRes.status, 200);
    const submitBody = await submitRes.json();
    assert.equal(submitBody.status, 'submitted');
    assert.equal(mock.rows.get(submitBody.id).task_id, 'music-task-001');
    assert.equal(mock.rows.get(submitBody.id).has_lyrics, true);
    assert.equal(mock.rows.get(submitBody.id).instrumental, false);

    // GET music-tests hides task_id
    const testsRes = await api('music-tests', { cookie });
    assert.equal(testsRes.status, 200);
    const testsText = await testsRes.text();
    assert.equal(testsText.includes('music-task-001'), false);
    const testsBody = JSON.parse(testsText);
    assert.equal(testsBody.tests.length, 1);
    assert.equal(testsBody.tests[0].canPoll, true);

    // Poll music-task returns music_id, audio links, billing, redacted message, and opt-in private_structure
    const pollRes = await api('music-task', { cookie, method: 'POST', data: { id: submitBody.id, private_result: true } });
    assert.equal(pollRes.status, 200);
    const pollText = await pollRes.text();
    assert.equal(pollText.includes('internal.secret'), false);
    const pollBody = JSON.parse(pollText);
    assert.equal(pollBody.task.status, 'completed');
    assert.equal(pollBody.task.music_id, 88991122);
    assert.deepEqual(pollBody.task.audios, ['https://cdn.example/music-out.mp3']);
    assert.equal(pollBody.task.cover_url, 'https://cdn.example/music-cover.jpg');
    assert.equal(pollBody.task.billing.charged, 73);
    assert.equal(pollBody.task.private_structure.result.music_id, 88991122);

    // New Freebeat session disables canPoll unless acknowledge: true is sent
    const newCookie = await connect();
    const list2 = await (await api('music-tests', { cookie: newCookie })).json();
    assert.equal(list2.tests[0].canPoll, false);
    assert.equal((await api('music-task', { cookie: newCookie, method: 'POST', data: { id: submitBody.id } })).status, 404);
    assert.equal((await api('music-task', { cookie: newCookie, method: 'POST', data: { id: submitBody.id, acknowledge: true } })).status, 200);

    // 4. Uncertain generate_music response locks subsequent submissions (409)
    mock.setGenerateMode('rpc_error');
    const prep2 = await (await api('music-prepare', { cookie: newCookie, method: 'POST', data: { model_id: 129, prompt: 'Lo-fi chillhop', instrumental: true } })).json();
    const unkRes = await api('music-submit', { cookie: newCookie, method: 'POST', data: { approval: prep2.approval, confirm: true, private_diagnostics: true } });
    assert.equal(unkRes.status, 200);
    const unkBody = await unkRes.json();
    assert.equal(unkBody.status, 'unknown');
    assert.equal(JSON.stringify(unkBody.initial_diagnostics).includes('SECRET-KEY'), false);
    assert.match(JSON.stringify(unkBody.initial_diagnostics), /Bearer \[disembunyikan\]/);

    // Subsequent submit with fresh receipt fails with 409 lock
    const prep3 = await (await api('music-prepare', { cookie: newCookie, method: 'POST', data: { model_id: 129, prompt: 'Another song' } })).json();
    const lockedRes = await api('music-submit', { cookie: newCookie, method: 'POST', data: { approval: prep3.approval, confirm: true } });
    assert.equal(lockedRes.status, 409);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FreebeatMusicDiagnostic JSDOM loads music models, quotes, prepares, submits, polls music_id/audio links, and clears on disconnect', async () => {
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
    const { FreebeatMusicDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatMusicDiagnostic.jsx');
    const calls = [];
    const request = async (action, method, payload) => {
      calls.push({ action, method, payload });
      if (action === 'music-models') {
        return {
          data: {
            models: [
              { model_id: 129, name: 'Lyria 3 Pro', available: true, pricing: { status: 'quoted', credits: 42 }, supports_duration: false },
              { model_id: 194, name: 'Suno v6', available: true, pricing: { status: 'quoted', credits: 73 }, supports_duration: false },
            ],
          },
        };
      }
      if (action === 'music-quote') {
        return {
          model: { model_id: 129, name: 'Lyria 3 Pro' },
          parameters: payload,
          credits: 42,
          quote: { status: 'quoted', credits: 42 },
        };
      }
      if (action === 'music-prepare') {
        return {
          approval: 'sealed-music-approval',
          model: { model_id: 129, name: 'Lyria 3 Pro' },
          parameters: payload,
          credits: 42,
          max_credits: 42,
          expiresAt: Date.now() + 300000,
        };
      }
      if (action === 'music-submit') {
        return { id: '22222222-2222-4222-8222-222222222222', status: 'submitted' };
      }
      if (action === 'music-tests') {
        return {
          tests: [{
            id: '22222222-2222-4222-8222-222222222222',
            model_id: 129,
            model_name: 'Lyria 3 Pro',
            instrumental: false,
            has_lyrics: false,
            max_credits: 42,
            status: 'submitted',
            created_at: '2026-11-22T14:00:00Z',
            canPoll: true,
          }],
        };
      }
      if (action === 'music-task') {
        return {
          task: {
            status: 'completed',
            music_id: 99887766,
            audios: ['https://cdn.example/final-track.mp3'],
            cover_url: 'https://cdn.example/final-cover.jpg',
            billing: { charged: 42, refunded: 0, net: 42 },
          },
        };
      }
      throw new Error(`Unexpected action: ${action}`);
    };

    root = createRoot(document.getElementById('root'));
    const renderView = (connected) => React.act(async () => {
      root.render(React.createElement(FreebeatMusicDiagnostic, { connected, imageAccess: true, loading: false, request }));
    });
    await renderView(true);

    // Load catalog
    const loadBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Muat katalog model musik'));
    await React.act(async () => { loadBtn.click(); });
    assert.match(document.body.textContent, /#194 Suno v6 — 73 kredit/);

    // Check quote -> prepare -> confirm -> submit
    const quoteBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Periksa quote musik'));
    await React.act(async () => { quoteBtn.click(); });
    assert.match(document.body.textContent, /Quote generate_music yang disaring/);

    const prepBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Siapkan persetujuan musik'));
    await React.act(async () => { prepBtn.click(); });
    assert.match(document.body.textContent, /Periksa dan setujui satu generate_music/);

    const confirmBox = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Saya menyetujui satu kali pengiriman'))?.querySelector('input[type="checkbox"]');
    assert.ok(confirmBox);
    await React.act(async () => { confirmBox.click(); });

    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Setujui dan kirim musik'));
    await React.act(async () => { submitBtn.click(); });
    assert.match(document.body.textContent, /Catatan uji musik admin/);

    // Poll status -> explicit external audio/cover links (never auto <audio> or <img>), shows music_id
    const pollBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Periksa status');
    assert.ok(pollBtn);
    await React.act(async () => { pollBtn.click(); });
    assert.match(document.body.textContent, /99887766/);
    assert.equal(document.querySelectorAll('audio, img').length, 0);
    const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    assert.ok(links.includes('https://cdn.example/final-track.mp3'));
    assert.ok(links.includes('https://cdn.example/final-cover.jpg'));

    // Disconnect clears everything
    await renderView(false);
    assert.equal(document.body.textContent.includes('Catatan uji musik admin'), false);
    assert.equal(document.body.textContent.includes('99887766'), false);
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
