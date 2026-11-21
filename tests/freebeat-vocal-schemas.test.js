import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const base = 'https://blea-ai.blea-ai.workers.dev';
const env = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
};

function api(path, { token = 'admin-token', cookie, method = 'POST', data, origin = base, headers = {} } = {}) {
  return worker.fetch(new Request(`${base}/api/freebeat/${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(data !== undefined ? { 'content-type': 'application/json', origin } : {}),
      ...headers,
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  }), env);
}

async function connectFixture() {
  const start = await api('start', { method: 'POST', data: {} });
  assert.equal(start.status, 200);
  const pending = start.headers.get('set-cookie').split(';')[0];
  const state = new URL((await start.json()).url).searchParams.get('state');
  const callback = await api(`callback?code=code&state=${state}`, { token: null, method: 'GET', cookie: pending });
  const session = callback.headers.getSetCookie().find((v) => v.startsWith('__Host-blea_freebeat_session='));
  assert.ok(session);
  return session.split(';')[0];
}

test('vocal-video-schemas enforces admin, Freebeat session, safe default mode, detailed consented mode, and pagination safety', async () => {
  const realFetch = globalThis.fetch;
  const mcpCalls = [];
  let repeatingCursor = false;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://supabase.example/auth/v1/user') {
      const bearer = init.headers.authorization?.replace('Bearer ', '');
      return Response.json({ id: bearer, app_metadata: { role: bearer === 'user-token' ? 'user' : 'admin' } });
    }
    if (url === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client' });
    if (url === 'https://freebeat.ai/oauth/token') {
      return Response.json({ access_token: 'PROVIDER-SECRET', expires_in: 600, scope: 'freebeat:read' });
    }
    assert.equal(url, 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    mcpCalls.push(body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(body.method, 'tools/list');
    if (repeatingCursor) {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [], nextCursor: 'stuck-cursor' } });
    }
    if (!body.params?.cursor) {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          nextCursor: 'page-2',
          tools: [
            {
              name: 'generate_singing_video',
              inputSchema: {
                type: 'object',
                description: 'Create singing video from https://internal.freebeat.local/hook?token=SECRET-URL and admin@secret.example',
                required: ['audio_url', 'image_url'],
                properties: {
                  audio_url: { type: 'string', description: 'Audio URL Bearer SECRET-JWT', maxLength: 2048 },
                  image_url: { type: 'string' },
                  aspect_ratio: { type: 'string', enum: ['16:9', '9:16', 'CUSTOM_ENUM_1'], default: '9:16' },
                  duration: { type: 'integer', minimum: 5, maximum: 60, default: 15 },
                },
              },
            },
            {
              name: 'secret_internal_tool',
              inputSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
            },
            {
              name: 'unrelated_tool',
              inputSchema: { type: 'object', properties: { secret_field: { type: 'string' } } },
            },
          ],
        },
      });
    }
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        tools: [
          {
            name: 'generate_lip_sync_video',
            inputSchema: {
              type: 'object',
              required: ['video_url', 'audio_url'],
              additionalProperties: false,
              properties: {
                video_url: { type: 'string', description: 'Source video URL' },
                audio_url: { type: 'string' },
                sync_mode: { type: 'string', enum: ['fast', 'accurate_custom'], default: 'fast' },
              },
            },
          },
          {
            name: 'quote_generation',
            inputSchema: {
              type: 'object',
              required: ['tool', 'parameters'],
              properties: {
                tool: { type: 'string', enum: ['generate_singing_video', 'generate_lip_sync_video', 'generate_dance_video'] },
                parameters: { type: 'object' },
              },
            },
          },
        ],
      },
    });
  };

  try {
    const cookie = await connectFixture();

    assert.equal((await api('vocal-video-schemas', { token: null, cookie })).status, 401);
    assert.equal((await api('vocal-video-schemas', { token: 'user-token', cookie })).status, 403);
    assert.equal((await api('vocal-video-schemas', { token: 'other-admin', cookie })).status, 401);
    assert.equal((await api('vocal-video-schemas', { cookie, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await api('vocal-video-schemas', { cookie, data: { acknowledge: 'yes' } })).status, 400);
    assert.equal((await api('vocal-video-schemas', { cookie, data: { extra: true } })).status, 400);
    assert.equal(mcpCalls.length, 0);

    // Safe default mode (no consent needed, read-only even with freebeat:read scope)
    const safeRes = await api('vocal-video-schemas', { cookie, data: {} });
    assert.equal(safeRes.status, 200);
    const safeText = await safeRes.text();
    const safeBody = JSON.parse(safeText);
    assert.equal(safeBody.mode, 'safe');
    assert.deepEqual(Object.keys(safeBody.tools), ['generate_singing_video', 'generate_lip_sync_video', 'quote_generation']);
    assert.deepEqual(safeBody.tools.generate_singing_video.required, ['audio_url', 'image_url']);
    assert.deepEqual(safeBody.tools.generate_singing_video.properties.aspect_ratio.known_enum_values, ['16:9', '9:16']);
    assert.equal(safeBody.tools.generate_singing_video.properties.aspect_ratio.enum_incomplete, true);
    assert.equal(safeBody.tools.generate_singing_video.description, undefined);
    assert.equal(safeBody.tools.generate_singing_video.properties.duration.minimum, undefined);
    assert.equal(safeBody.tools.generate_singing_video.properties.aspect_ratio.default, undefined);
    assert.deepEqual(safeBody.available_tools, ['generate_singing_video', 'unrelated_tool', 'generate_lip_sync_video', 'quote_generation']);
    assert.deepEqual(safeBody.missing_tools, ['upload_video', 'upload_audio', 'upload_image']);
    assert.doesNotMatch(safeText, /SECRET|CUSTOM_ENUM_1|accurate_custom|secret_internal_tool|secret_field/);

    // Detailed consented mode: includes sanitized description, full enums, bounds, defaults, and no-referrer
    const detailRes = await api('vocal-video-schemas', { cookie, data: { acknowledge: true } });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.headers.get('referrer-policy'), 'no-referrer');
    const detailText = await detailRes.text();
    const detailBody = JSON.parse(detailText);
    assert.equal(detailBody.mode, 'detailed');
    assert.match(detailBody.tools.generate_singing_video.description, /\[URL disembunyikan\].*\[email disembunyikan\]/);
    assert.match(detailBody.tools.generate_singing_video.properties.audio_url.description, /Bearer \[disembunyikan\]/);
    assert.deepEqual(detailBody.tools.generate_singing_video.properties.aspect_ratio.enum, ['16:9', '9:16', 'CUSTOM_ENUM_1']);
    assert.equal(detailBody.tools.generate_singing_video.properties.duration.minimum, 5);
    assert.equal(detailBody.tools.generate_singing_video.properties.duration.maximum, 60);
    assert.equal(detailBody.tools.generate_singing_video.properties.duration.default, 15);
    assert.equal(detailBody.tools.generate_lip_sync_video.additionalProperties, false);
    assert.deepEqual(detailBody.tools.generate_lip_sync_video.properties.sync_mode.enum, ['fast', 'accurate_custom']);
    assert.doesNotMatch(detailText, /SECRET-URL|SECRET-JWT|admin@secret\.example|PROVIDER-SECRET|secret_internal_tool/);
    assert.equal(mcpCalls.some((c) => c.method === 'tools/call'), false);

    // Repeating pagination cursor fails closed with FB-MCP-INSPECT-RESPONSE
    repeatingCursor = true;
    const loopRes = await api('vocal-video-schemas', { cookie, data: {} });
    assert.equal(loopRes.status, 502);
    const loopText = await loopRes.text();
    assert.match(loopText, /FB-MCP-INSPECT-RESPONSE/);
    assert.doesNotMatch(loopText, /stuck-cursor/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FreebeatVocalSchemaDiagnostic renders safe & detailed inspection, enforces consent, and clears on disconnect', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVocalSchemaDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVocalSchemaDiagnostic.jsx');

  const calls = [];
  let deferred = null;
  const request = async (...args) => {
    calls.push(args);
    if (deferred) return deferred.promise;
    const body = args[2] || {};
    return {
      ok: true,
      mode: body.acknowledge ? 'detailed' : 'safe',
      tools: {
        generate_singing_video: { type: 'object', required: ['audio_url'] },
        generate_lip_sync_video: { type: 'object', required: ['video_url', 'audio_url'] },
      },
      available_tools: ['generate_singing_video', 'generate_lip_sync_video'],
      missing_tools: ['upload_video', 'upload_audio', 'upload_image'],
      truncated: false,
    };
  };

  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

  try {
    await React.act(async () => root.render(React.createElement(FreebeatVocalSchemaDiagnostic, {
      connected: true,
      loading: false,
      request,
    })));

    assert.equal(button('Periksa skema Singing & Lip-Sync').disabled, false);
    assert.equal(button('Tampilkan skema lengkap (privat)').disabled, true);

    await React.act(async () => button('Periksa skema Singing & Lip-Sync').click());
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['vocal-video-schemas', 'POST', {}]);
    assert.match(document.body.textContent, /Ditemukan:.*generate_singing_video, generate_lip_sync_video/);
    assert.match(document.body.textContent, /Tidak ditemukan di tools\/list: upload_video/);
    assert.ok(document.querySelector('textarea[aria-label="Struktur tool Singing & Lip-Sync Video"]'));

    const checkbox = document.querySelector('input[type=checkbox]');
    await React.act(async () => checkbox.click());
    assert.equal(button('Tampilkan skema lengkap (privat)').disabled, false);

    await React.act(async () => button('Tampilkan skema lengkap (privat)').click());
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ['vocal-video-schemas', 'POST', { acknowledge: true }]);
    assert.match(document.body.textContent, /Mode: Lengka?p \(privat\)/);

    // Disconnect clears output and resets consent checkbox
    await React.act(async () => root.render(React.createElement(FreebeatVocalSchemaDiagnostic, {
      connected: false,
      loading: false,
      request,
    })));
    assert.equal(document.querySelector('textarea[aria-label="Struktur tool Singing & Lip-Sync Video"]'), null);
    assert.equal(document.querySelector('input[type=checkbox]').checked, false);

    // Reconnect, start an in-flight request, disconnect mid-request, then reconnect again: busy must be reset
    await React.act(async () => root.render(React.createElement(FreebeatVocalSchemaDiagnostic, {
      connected: true,
      loading: false,
      request,
    })));
    let resolvePending;
    deferred = { promise: new Promise((resolve) => { resolvePending = resolve; }) };
    await React.act(async () => { button('Periksa skema Singing & Lip-Sync').click(); });
    assert.ok(button('Memeriksa…'));
    await React.act(async () => root.render(React.createElement(FreebeatVocalSchemaDiagnostic, {
      connected: false,
      loading: false,
      request,
    })));
    await React.act(async () => {
      resolvePending({ ok: true, mode: 'safe', tools: { generate_singing_video: { type: 'object' } }, available_tools: [], missing_tools: [], truncated: false });
      await deferred.promise;
    });
    deferred = null;
    await React.act(async () => root.render(React.createElement(FreebeatVocalSchemaDiagnostic, {
      connected: true,
      loading: false,
      request,
    })));
    assert.equal(button('Periksa skema Singing & Lip-Sync').disabled, false);
    assert.equal(document.querySelector('input[type=checkbox]').disabled, false);
    assert.equal(document.querySelector('textarea[aria-label="Struktur tool Singing & Lip-Sync Video"]'), null);
  } finally {
    await React.act(async () => root.unmount());
    await vite.close();
    dom.window.close();
  }
});
