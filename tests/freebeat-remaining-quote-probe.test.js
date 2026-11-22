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

function api(path, { token = 'admin-token', cookie, method = 'POST', data, origin = base } = {}) {
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

test('remaining-quote-probe enforces auth, input bounds, and queries only quote_generation across all 5 new tools', async () => {
  const realFetch = globalThis.fetch;
  const mcpCalls = [];

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
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'quote_generation');

    const { tool, parameters } = body.params.arguments;
    if (tool === 'generate_music') {
      assert.equal('duration_seconds' in parameters, false);
      if (parameters.model_id === 194 && !parameters.lyrics) {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ error: 'lyrics required; see https://internal.secret/docs' }) }],
          },
        });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 'quoted', credits: parameters.model_id === 194 ? 73 : 42 }) }] },
      });
    }
    if (tool === 'generate_music_video') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 'quoted', credits: parameters.resolution === '1080p' ? 240 : 160 }) }] },
      });
    }
    if (tool === 'generate_lyric_video') {
      assert.ok(['768P', '2K'].includes(parameters.resolution));
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 'quoted', credits: parameters.resolution === '2K' ? 320 : 180 }) }] },
      });
    }
    if (tool === 'generate_effect') {
      assert.equal(parameters.reference_image_urls.length, 1);
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 'quoted', credits: parameters.watermark ? 90 : 110 }) }] },
      });
    }
    if (tool === 'generate_text') {
      return Response.json({
        jsonrpc: '2.0',
        id: body.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ status: 'unavailable' }) }] },
      });
    }
    throw new Error(`Unexpected tool quote: ${tool}`);
  };

  try {
    assert.equal((await api('remaining-quote-probe', { token: null, data: {} })).status, 401);
    assert.equal((await api('remaining-quote-probe', { token: 'user-token', data: {} })).status, 403);
    assert.equal((await api('remaining-quote-probe', { data: {} })).status, 401);

    const cookie = await connectFixture();
    assert.equal((await api('remaining-quote-probe', { cookie, origin: 'https://evil.example', data: {} })).status, 403);
    assert.equal((await api('remaining-quote-probe', { cookie, data: { group: 'invalid' } })).status, 400);
    assert.equal((await api('remaining-quote-probe', { cookie, data: { unknown_key: 1 } })).status, 400);
    assert.equal((await api('remaining-quote-probe', { cookie, data: { effect_image_url: 'http://insecure.example/a.png' } })).status, 400);

    // 1. All groups summary (10 probes)
    const allRes = await api('remaining-quote-probe', { cookie, data: { group: 'all' } });
    assert.equal(allRes.status, 200);
    assert.equal(allRes.headers.get('referrer-policy'), 'no-referrer');
    const allBody = await allRes.json();
    assert.equal(allBody.group, 'all');
    assert.equal(allBody.total_probed, 10);
    assert.equal(allBody.usable.length, 8);
    assert.equal(allBody.results.filter((r) => r.group === 'text').every((r) => r.usable === false && r.status === 'unavailable'), true);

    // 2. Music group specifically exercises lyrics vs prompt-only and redacts rpc_error URL
    const musicRes = await api('remaining-quote-probe', { cookie, data: { group: 'music', music_model_id: 193 } });
    assert.equal(musicRes.status, 200);
    const musicBody = await musicRes.json();
    assert.equal(musicBody.group, 'music');
    const rpcErr = musicBody.results.find((r) => r.status === 'rpc_error');
    assert.ok(rpcErr);
    assert.equal(rpcErr.usable, false);
    assert.equal(rpcErr.error.includes('internal.secret'), false);
    assert.match(rpcErr.error, /\[URL disembunyikan\]/);

    // Verify ONLY quote_generation was called (zero generation calls)
    const calledTools = mcpCalls.filter((c) => c.method === 'tools/call').map((c) => c.params.name);
    assert.equal(calledTools.every((name) => name === 'quote_generation'), true);
    assert.equal(calledTools.length, 17);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('FreebeatRemainingQuoteProbe JSDOM submits probe, renders results, and clears on disconnect', async () => {
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
    const { FreebeatRemainingQuoteProbe } = await vite.ssrLoadModule('/src/auth/FreebeatRemainingQuoteProbe.jsx');
    const calls = [];
    const request = async (action, method, payload) => {
      calls.push({ action, method, payload });
      return {
        group: payload.group,
        total_probed: 10,
        usable: [{ group: 'effect', label: 'generate_effect #459', tool: 'generate_effect', credits: 110 }],
        results: [{ group: 'effect', label: 'generate_effect #459', tool: 'generate_effect', usable: true, credits: 110, status: 'quoted' }],
      };
    };

    root = createRoot(document.getElementById('root'));
    const renderView = (connected) => React.act(async () => {
      root.render(React.createElement(FreebeatRemainingQuoteProbe, { connected, loading: false, request }));
    });
    await renderView(true);

    const submitBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Jalankan probe quote (0 kredit)'));
    assert.ok(submitBtn && !submitBtn.disabled);
    await React.act(async () => { submitBtn.click(); });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'remaining-quote-probe');
    assert.equal(calls[0].payload.music_model_id, 129);
    assert.equal(calls[0].payload.music_id, 1076592);
    assert.equal(calls[0].payload.effect_id, 459);
    assert.match(document.body.textContent, /Hasil quote_generation 5 tool baru/);
    assert.match(document.body.textContent, /generate_effect #459/);

    // Disconnect clears results
    await renderView(false);
    assert.equal(document.body.textContent.includes('Hasil quote_generation 5 tool baru'), false);
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
