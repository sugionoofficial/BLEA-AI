import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';
import { freebeatUploadImages } from '../src/lib/freebeatMcp.js';

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

test('Read-only catalog endpoints enforce auth, origin, pagination bounds, secret stripping, and media URL preservation', async () => {
  const realFetch = globalThis.fetch;
  const mcpCalls = [];
  let textMode = 'models';

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
    if (body.method === 'tools/list') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          tools: [
            {
              name: 'list_models',
              inputSchema: {
                type: 'object',
                required: ['type'],
                properties: {
                  type: { type: 'string', enum: ['image', 'image_edit', 'video'] },
                },
              },
            },
          ],
        },
      });
    }
    assert.equal(body.method, 'tools/call');
    if (body.params.name === 'list_music_models') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              models: [
                {
                  model_id: 101,
                  name: 'Suno-like v4',
                  requires_lyrics: true,
                  supports_duration: false,
                  description: 'Internal docs https://internal.secret/docs owner@secret.example',
                  api_key: 'SHOULD-BE-STRIPPED',
                  cover_url: 'https://static.freebeat.ai/music/cover-101.png',
                },
              ],
            }),
          }],
        },
      });
    }
    if (body.params.name === 'list_effects') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              page: body.params.arguments.page,
              page_size: body.params.arguments.page_size,
              effects: [
                {
                  effect_id: 77,
                  name: 'Neon Cyber',
                  default_music_id: 888999,
                  image_url: 'https://static.freebeat.ai/effects/77.jpg',
                  preview_video_url: 'https://static.freebeatfit.com/effects/77.mp4',
                  reference_image_urls: ['https://static.freebeat.ai/effects/ref1.jpg', 'http://insecure.example/bad.jpg'],
                  description: 'See https://leak.example/secret for prompt info',
                  access_token: 'LEAK-TOKEN',
                },
              ],
            }),
          }],
        },
      });
    }
    if (body.params.name === 'list_models') {
      assert.equal(body.params.arguments.type, 'text');
      if (textMode === 'unsupported') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: false, message: 'Unsupported type text; check https://internal.secret/docs' }),
            }],
          },
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({
              models: [
                { model: 'openai/gpt-4o-mini', display_name: 'GPT-4o Mini', available: true },
                'anthropic/claude-3-5-haiku',
              ],
            }),
          }],
        },
      });
    }
    throw new Error(`Unexpected tool: ${body.params.name}`);
  };

  try {
    // 1. Auth & session checks
    assert.equal((await api('music-models', { token: null, data: {} })).status, 401);
    assert.equal((await api('music-models', { token: 'user-token', data: {} })).status, 403);
    assert.equal((await api('music-models', { data: {} })).status, 401);

    const cookie = await connectFixture();

    // 2. Cross-origin check
    const cross = await api('effects-list', { cookie, origin: 'https://evil.example', data: { page: 1 } });
    assert.equal(cross.status, 403);

    // 3. Music models inspection
    const musicRes = await api('music-models', { cookie, data: {} });
    assert.equal(musicRes.status, 200);
    assert.equal(musicRes.headers.get('referrer-policy'), 'no-referrer');
    const musicBody = await musicRes.json();
    assert.equal(musicBody.catalog, 'music');
    assert.equal(musicBody.count, 1);
    const m = musicBody.data.models[0];
    assert.equal(m.model_id, 101);
    assert.equal(m.requires_lyrics, true);
    assert.equal(m.supports_duration, false);
    assert.equal(m.cover_url, 'https://static.freebeat.ai/music/cover-101.png');
    assert.equal('api_key' in m, false);
    assert.equal(m.description.includes('internal.secret'), false);
    assert.equal(m.description.includes('owner@secret.example'), false);

    // 4. Effects list pagination validation + inspection
    const badPage = await api('effects-list', { cookie, data: { page: 0 } });
    assert.equal(badPage.status, 400);
    const badExtra = await api('effects-list', { cookie, data: { page: 1, prompt: 'hack' } });
    assert.equal(badExtra.status, 400);

    const effRes = await api('effects-list', { cookie, data: { page: 2, page_size: 15 } });
    assert.equal(effRes.status, 200);
    assert.equal(effRes.headers.get('referrer-policy'), 'no-referrer');
    const effBody = await effRes.json();
    assert.equal(effBody.catalog, 'effects');
    assert.equal(effBody.page, 2);
    assert.equal(effBody.page_size, 15);
    assert.equal(effBody.count, 1);
    const eff = effBody.data.effects[0];
    assert.equal(eff.effect_id, 77);
    assert.equal(eff.default_music_id, 888999);
    assert.equal(eff.image_url, 'https://static.freebeat.ai/effects/77.jpg');
    assert.equal(eff.preview_video_url, 'https://static.freebeatfit.com/effects/77.mp4');
    assert.deepEqual(eff.reference_image_urls, ['https://static.freebeat.ai/effects/ref1.jpg', null]);
    assert.equal('access_token' in eff, false);
    assert.equal(eff.description.includes('leak.example'), false);

    // 5. Text models inspection (supports slash IDs and `model` property)
    const textRes = await api('text-models', { cookie, data: {} });
    assert.equal(textRes.status, 200);
    const textBody = await textRes.json();
    assert.equal(textBody.catalog, 'text');
    assert.deepEqual(textBody.models, [
      { model_id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', member_only: false, available: true },
      { model_id: 'anthropic/claude-3-5-haiku', name: 'anthropic/claude-3-5-haiku', member_only: false, available: true },
    ]);

    // 6. Text models fallback when provider returns non-list message: exposes redacted data + safe list_models schema
    textMode = 'unsupported';
    const textFallbackRes = await api('text-models', { cookie, data: {} });
    assert.equal(textFallbackRes.status, 200);
    const textFallbackBody = await textFallbackRes.json();
    assert.deepEqual(textFallbackBody.models, []);
    assert.equal(textFallbackBody.data.success, false);
    assert.equal(textFallbackBody.data.message.includes('internal.secret'), false);
    assert.deepEqual(textFallbackBody.schema.properties.type.known_enum_values, ['image', 'image_edit', 'video']);

    // Verify no generate_* tool calls were ever invoked
    const calledTools = mcpCalls.filter((c) => c.method === 'tools/call').map((c) => c.params.name);
    assert.deepEqual(calledTools, ['list_music_models', 'list_effects', 'list_models', 'list_models']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('freebeatUploadImages skips already-hosted Freebeat URLs and uploads external HTTPS URLs in order', async () => {
  const realFetch = globalThis.fetch;
  const uploadedArgs = [];
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), 'https://freebeat.ai/api/mcp');
    const body = JSON.parse(init.body);
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26' } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(body.params.name, 'upload_image');
    uploadedArgs.push(body.params.arguments);
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({
            urls: body.params.arguments.urls.map((_, i) => `https://static.freebeat.ai/uploaded/img-${i + 1}.png`),
          }),
        }],
      },
    });
  };

  try {
    // All already hosted -> 0 MCP calls
    const already = await freebeatUploadImages('tok', ['https://static.freebeat.ai/effects/77.jpg']);
    assert.deepEqual(already, {
      urls: ['https://static.freebeat.ai/effects/77.jpg'],
      uploaded_count: 0,
    });
    assert.equal(uploadedArgs.length, 0);

    // Mixed hosted + external -> preserves exact ordering
    const mixed = await freebeatUploadImages('tok', [
      'https://cdn.example/a.png',
      'https://static.freebeat.ai/already.jpg',
      'https://cdn.example/b.png',
    ]);
    assert.equal(mixed.uploaded_count, 2);
    assert.deepEqual(mixed.urls, [
      'https://static.freebeat.ai/uploaded/img-1.png',
      'https://static.freebeat.ai/already.jpg',
      'https://static.freebeat.ai/uploaded/img-2.png',
    ]);
    assert.deepEqual(uploadedArgs, [{ urls: ['https://cdn.example/a.png', 'https://cdn.example/b.png'] }]);

    // Rejects invalid inputs
    await assert.rejects(() => freebeatUploadImages('tok', []), /1 hingga 5/);
    await assert.rejects(() => freebeatUploadImages('tok', ['http://insecure.example/x.png']), /HTTPS publik/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FreebeatCatalogInspector JSDOM inspects music, effects, and text catalogs and clears on disconnect', async () => {
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
    const { FreebeatCatalogInspector } = await vite.ssrLoadModule('/src/auth/FreebeatCatalogInspector.jsx');
    const calls = [];
    const request = async (action, method, body) => {
      calls.push({ action, method, body });
      if (action === 'music-models') return { catalog: 'music', count: 1, truncated: false, data: { models: [{ model_id: 9, name: 'MusicV4' }] } };
      if (action === 'effects-list') return { catalog: 'effects', page: body.page, page_size: body.page_size, count: 1, truncated: false, data: { effects: [{ effect_id: 33 }] } };
      if (action === 'text-models') return { catalog: 'text', models: [{ model_id: 'gpt-4o-mini', name: 'GPT-4o Mini' }], truncated: false };
      return {};
    };

    root = createRoot(document.getElementById('root'));
    const renderView = (connected) => React.act(async () => {
      root.render(React.createElement(FreebeatCatalogInspector, { connected, loading: false, request }));
    });
    await renderView(true);

    const musicBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Periksa model musik'));
    await React.act(async () => { musicBtn.click(); });
    assert.match(document.body.textContent, /MusicV4/);

    const effectsBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Periksa daftar efek'));
    await React.act(async () => { effectsBtn.click(); });
    assert.match(document.body.textContent, /"effect_id": 33/);

    const textBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Periksa model teks'));
    await React.act(async () => { textBtn.click(); });
    assert.match(document.body.textContent, /gpt-4o-mini/);

    // Disconnect clears all sensitive catalog state
    await renderView(false);
    assert.equal(document.body.textContent.includes('MusicV4'), false);
    assert.equal(document.body.textContent.includes('gpt-4o-mini'), false);
    assert.equal(document.body.textContent.includes('"effect_id": 33'), false);
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
