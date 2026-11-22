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

test('remaining-schemas enforces admin, Freebeat session, read-only tools/list for 7 unintegrated tools, safe & detailed modes, and pagination safety', async () => {
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
              name: 'list_music_models',
              inputSchema: {
                type: 'object',
                description: 'List music models at https://internal.freebeat.local/api?token=SECRET-TOKEN',
                properties: {
                  category: { type: 'string', enum: ['music', 'UNLISTED_CAT'] },
                },
              },
            },
            {
              name: 'generate_music',
              description: 'Tool description https://internal.freebeat.local/music-doc token=SECRET-TOOL-TOK',
              inputSchema: {
                type: 'object',
                required: ['prompt'],
                properties: {
                  prompt: { type: 'string', description: 'Music prompt Bearer SECRET-JWT', maxLength: 1000 },
                  instrumental: { type: 'boolean', default: false },
                  duration_seconds: { type: 'integer', minimum: 10, maximum: 240, default: 60 },
                },
              },
            },
            {
              name: 'generate_music_video',
              inputSchema: {
                type: 'object',
                required: ['audio_url'],
                properties: {
                  audio_url: { type: 'string' },
                  aspect_ratio: { type: 'string', enum: ['16:9', '9:16', 'SECRET_RATIO'] },
                },
              },
            },
            {
              name: 'generate_lyric_video',
              inputSchema: {
                type: 'object',
                required: ['audio_url', 'lyrics'],
                properties: {
                  audio_url: { type: 'string' },
                  lyrics: { type: 'string' },
                },
              },
            },
            {
              name: 'secret_internal_tool',
              inputSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
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
            name: 'list_effects',
            inputSchema: {
              type: 'object',
              properties: {
                filter: { type: 'string', description: 'Contact ops@secret.example for internal filter' },
              },
            },
          },
          {
            name: 'generate_effect',
            inputSchema: {
              type: 'object',
              required: ['effect_id', 'image_url'],
              additionalProperties: false,
              properties: {
                effect_id: { type: 'string' },
                image_url: { type: 'string' },
              },
            },
          },
          {
            name: 'generate_text',
            inputSchema: {
              type: 'object',
              required: ['prompt'],
              properties: {
                prompt: { type: 'string' },
                format: { type: 'string', enum: ['text', 'markdown', 'PRIVATE_FMT'], default: 'text' },
              },
            },
          },
          {
            name: 'quote_generation',
            inputSchema: {
              type: 'object',
              required: ['tool', 'parameters'],
              properties: {
                tool: {
                  type: 'string',
                  enum: [
                    'generate_music',
                    'generate_music_video',
                    'generate_lyric_video',
                    'generate_effect',
                    'generate_text',
                  ],
                },
                parameters: { type: 'object' },
              },
            },
          },
          {
            name: 'generate_image',
            inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
          },
        ],
      },
    });
  };

  try {
    const cookie = await connectFixture();

    assert.equal((await api('remaining-schemas', { token: null, cookie })).status, 401);
    assert.equal((await api('remaining-schemas', { token: 'user-token', cookie })).status, 403);
    assert.equal((await api('remaining-schemas', { token: 'other-admin', cookie })).status, 401);
    assert.equal((await api('remaining-schemas', { cookie, headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await api('remaining-schemas', { cookie, data: { acknowledge: 'yes' } })).status, 400);
    assert.equal((await api('remaining-schemas', { cookie, data: { extra: true } })).status, 400);
    assert.equal(mcpCalls.length, 0);

    // Safe default mode
    const safeRes = await api('remaining-schemas', { cookie, data: {} });
    assert.equal(safeRes.status, 200);
    const safeText = await safeRes.text();
    const safeBody = JSON.parse(safeText);
    assert.equal(safeBody.mode, 'safe');
    assert.deepEqual(Object.keys(safeBody.tools), [
      'list_music_models',
      'generate_music',
      'generate_music_video',
      'generate_lyric_video',
      'list_effects',
      'generate_effect',
      'generate_text',
      'quote_generation',
    ]);
    assert.deepEqual(safeBody.missing_tools, []);
    assert.deepEqual(safeBody.tools.quote_generation.properties.tool.known_enum_values, [
      'generate_music',
      'generate_music_video',
      'generate_lyric_video',
      'generate_effect',
      'generate_text',
    ]);
    assert.equal(safeBody.tools.quote_generation.properties.tool.enum_incomplete, false);
    assert.deepEqual(safeBody.tools.list_music_models.properties.category.known_enum_values, ['music']);
    assert.equal(safeBody.tools.list_music_models.properties.category.enum_incomplete, true);
    assert.equal(safeBody.tools.generate_music.properties.duration_seconds.minimum, undefined);
    assert.equal(safeBody.tools.generate_music.properties.instrumental.default, undefined);
    assert.equal(safeBody.tools.list_music_models.description, undefined);
    assert.equal(safeBody.tools.generate_music.tool_description, undefined);
    assert.equal(safeBody.tools.generate_image, undefined);
    assert.ok(safeBody.available_tools.includes('generate_image'));
    assert.doesNotMatch(safeText, /SECRET|UNLISTED_CAT|SECRET_RATIO|PRIVATE_FMT|secret_internal_tool|api_key/);

    // Detailed consented mode
    const detailRes = await api('remaining-schemas', { cookie, data: { acknowledge: true } });
    assert.equal(detailRes.status, 200);
    assert.equal(detailRes.headers.get('referrer-policy'), 'no-referrer');
    const detailText = await detailRes.text();
    const detailBody = JSON.parse(detailText);
    assert.equal(detailBody.mode, 'detailed');
    assert.match(detailBody.tools.generate_music.tool_description, /\[URL disembunyikan\]/);
    assert.match(detailBody.tools.generate_music.tool_description, /token=\[disembunyikan\]/);
    assert.doesNotMatch(detailBody.tools.generate_music.tool_description, /SECRET-TOOL-TOK/);
    assert.match(detailBody.tools.list_music_models.description, /\[URL disembunyikan\]/);
    assert.match(detailBody.tools.generate_music.properties.prompt.description, /Bearer \[disembunyikan\]/);
    assert.match(detailBody.tools.list_effects.properties.filter.description, /\[email disembunyikan\]/);
    assert.deepEqual(detailBody.tools.list_music_models.properties.category.enum, ['music', 'UNLISTED_CAT']);
    assert.deepEqual(detailBody.tools.generate_text.properties.format.enum, ['text', 'markdown', 'PRIVATE_FMT']);
    assert.equal(detailBody.tools.generate_music.properties.duration_seconds.minimum, 10);
    assert.equal(detailBody.tools.generate_music.properties.duration_seconds.maximum, 240);
    assert.equal(detailBody.tools.generate_music.properties.duration_seconds.default, 60);
    assert.equal(detailBody.tools.generate_music.properties.instrumental.default, false);
    assert.equal(detailBody.tools.generate_effect.additionalProperties, false);
    assert.doesNotMatch(detailText, /SECRET-TOKEN|SECRET-JWT|ops@secret\.example|PROVIDER-SECRET|secret_internal_tool/);
    assert.equal(mcpCalls.some((c) => c.method === 'tools/call'), false);

    // Repeating pagination cursor fails closed
    repeatingCursor = true;
    const loopRes = await api('remaining-schemas', { cookie, data: {} });
    assert.equal(loopRes.status, 502);
    const loopText = await loopRes.text();
    assert.match(loopText, /FB-MCP-INSPECT-RESPONSE/);
    assert.doesNotMatch(loopText, /stuck-cursor/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FreebeatRemainingSchemaDiagnostic renders safe & detailed inspection, warns on incomplete safe enums, and resets on disconnect', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });

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
        list_music_models: { type: 'object', properties: { style: { type: 'string', known_enum_values: [], enum_incomplete: true } } },
        generate_music: { type: 'object', required: ['prompt'] },
        generate_text: { type: 'object', required: ['prompt'] },
      },
      available_tools: ['list_music_models', 'generate_music', 'generate_text'],
      missing_tools: ['generate_music_video', 'generate_lyric_video', 'list_effects', 'generate_effect'],
      truncated: false,
    };
  };

  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);

  try {
    const { FreebeatRemainingSchemaDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatRemainingSchemaDiagnostic.jsx');

    await React.act(async () => root.render(React.createElement(FreebeatRemainingSchemaDiagnostic, {
      connected: true,
      loading: false,
      request,
    })));

    assert.equal(button('Periksa skema 7 tool baru').disabled, false);
    assert.equal(button('Tampilkan skema lengkap (privat)').disabled, true);

    await React.act(async () => button('Periksa skema 7 tool baru').click());
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['remaining-schemas', 'POST', {}]);
    assert.match(document.body.textContent, /Ditemukan:.*list_music_models, generate_music, generate_text/);
    assert.match(document.body.textContent, /Tidak ditemukan di tools\/list: generate_music_video/);
    assert.match(document.body.textContent, /Sebagian enum atau batas angka disembunyikan/);
    assert.ok(document.querySelector('textarea[aria-label="Struktur 7 tool Freebeat lainnya"]'));

    const checkbox = document.querySelector('input[type=checkbox]');
    await React.act(async () => checkbox.click());
    assert.equal(button('Tampilkan skema lengkap (privat)').disabled, false);

    await React.act(async () => button('Tampilkan skema lengkap (privat)').click());
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], ['remaining-schemas', 'POST', { acknowledge: true }]);
    assert.match(document.body.textContent, /Mode: Lengka?p \(privat\)/);
    assert.doesNotMatch(document.body.textContent, /Sebagian enum atau batas angka disembunyikan/);

    // Disconnect clears output and resets consent checkbox
    await React.act(async () => root.render(React.createElement(FreebeatRemainingSchemaDiagnostic, {
      connected: false,
      loading: false,
      request,
    })));
    assert.equal(document.querySelector('textarea[aria-label="Struktur 7 tool Freebeat lainnya"]'), null);
    assert.equal(document.querySelector('input[type=checkbox]').checked, false);

    // Reconnect, start an in-flight request, disconnect mid-request, then reconnect again: busy must be reset
    await React.act(async () => root.render(React.createElement(FreebeatRemainingSchemaDiagnostic, {
      connected: true,
      loading: false,
      request,
    })));
    let resolvePending;
    deferred = { promise: new Promise((resolve) => { resolvePending = resolve; }) };
    await React.act(async () => { button('Periksa skema 7 tool baru').click(); });
    assert.ok(button('Memeriksa…'));
    await React.act(async () => root.render(React.createElement(FreebeatRemainingSchemaDiagnostic, {
      connected: false,
      loading: false,
      request,
    })));
    await React.act(async () => {
      resolvePending({ ok: true, mode: 'safe', tools: { generate_music: { type: 'object' } }, available_tools: [], missing_tools: [], truncated: false });
      await deferred.promise;
    });
    deferred = null;
    await React.act(async () => root.render(React.createElement(FreebeatRemainingSchemaDiagnostic, {
      connected: true,
      loading: false,
      request,
    })));
    assert.equal(button('Periksa skema 7 tool baru').disabled, false);
    assert.equal(document.querySelector('input[type=checkbox]').disabled, false);
    assert.equal(document.querySelector('textarea[aria-label="Struktur 7 tool Freebeat lainnya"]'), null);
  } finally {
    await React.act(async () => root.unmount());
    await vite.close();
    dom.window.close();
  }
});
