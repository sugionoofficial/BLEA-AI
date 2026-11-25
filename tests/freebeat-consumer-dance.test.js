import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const BASE = 'https://blea-ai.blea-ai.workers.dev';

function createEnv(extra = {}) {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ...extra,
  };
}

function apiRequest(path, { method = 'POST', body, token = 'user-jwt', cookie } = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function createHarness({
  prices = [{ provider: 'freebeat', model: 'generate_dance_video', modality: 'video', credits: 3000, active: true }],
  hasProviderSession = true,
  imageAccess = true,
  spendOk = true,
  quote = { status: 'unknown' },
  generateMode = 'success',
  taskStatus = { status: 'completed', billing: { charged: 855, refunded: null, net: 855 } },
  taskResult = { status: 'completed', result: { video_url: 'https://cdn.example/dance-out.mp4', cover_url: 'https://cdn.example/cover.jpg' }, billing: { charged: 855, refunded: null, net: 855 } },
} = {}) {
  const env = createEnv();
  const realFetch = globalThis.fetch;
  let storedProviderSession = null;
  let storedRow = null;
  const spends = [];
  const refunds = [];
  const mcpCalls = [];
  let genMode = generateMode;
  let curTaskStatus = taskStatus;
  let curTaskResult = taskResult;

  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    const url = new URL(urlStr);
    const method = (init.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url.href === 'https://supabase.example/auth/v1/user') {
      const bearer = (init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      return Response.json({
        id: bearer === 'admin-jwt' ? 'admin-1' : 'user-1',
        email: bearer === 'admin-jwt' ? 'admin@example.com' : 'creator@example.com',
        app_metadata: { role: bearer === 'admin-jwt' ? 'admin' : 'user' },
      });
    }
    if (url.pathname === '/rest/v1/profiles') {
      return Response.json([{ id: 'user-1', status: 'active' }]);
    }
    if (url.pathname === '/rest/v1/provider_api_keys') {
      return Response.json([]);
    }
    if (url.pathname === '/rest/v1/provider_models') {
      const model = url.searchParams.get('model')?.replace(/^eq\./, '');
      return Response.json(model ? [{ model }] : []);
    }
    if (url.pathname === '/rest/v1/credit_model_prices') {
      const provMatch = url.searchParams.get('provider')?.replace(/^eq\./, '');
      const modelMatch = url.searchParams.get('model')?.replace(/^eq\./, '');
      const modMatch = url.searchParams.get('modality')?.replace(/^eq\./, '');
      const filtered = prices.filter((p) => {
        if (provMatch && p.provider !== provMatch) return false;
        if (modelMatch && p.model !== modelMatch) return false;
        if (modMatch && p.modality !== modMatch) return false;
        return p.active !== false;
      });
      return Response.json(filtered);
    }
    if (url.pathname === '/rest/v1/freebeat_provider_sessions') {
      if (method === 'POST') {
        storedProviderSession = jsonBody();
        return Response.json([storedProviderSession]);
      }
      if (!hasProviderSession) return Response.json([]);
      if (storedProviderSession) return Response.json([{ ...storedProviderSession, image_access: imageAccess }]);
      return Response.json([]);
    }
    if (url.pathname === '/rest/v1/rpc/spend_credits') {
      spends.push(jsonBody());
      return Response.json(spendOk);
    }
    if (url.pathname === '/rest/v1/rpc/refund_credits') {
      refunds.push(jsonBody());
      return Response.json(true);
    }
    if (url.pathname === '/rest/v1/video_generations' && method === 'POST') {
      const body = jsonBody();
      storedRow = { id: body.id, created_at: '2026-11-27T00:00:00Z', updated_at: '2026-11-27T00:00:00Z', ...body };
      return Response.json([storedRow]);
    }
    if (url.pathname === '/rest/v1/video_generations' && method === 'GET') {
      return Response.json(storedRow ? [storedRow] : []);
    }
    if (url.pathname === '/rest/v1/video_generations' && method === 'PATCH') {
      const patch = jsonBody();
      const refundGuard = url.searchParams.get('credits_refunded');
      if (refundGuard === 'eq.0') {
        if (!storedRow || storedRow.credits_refunded !== 0) return Response.json([]);
      }
      storedRow = { ...(storedRow || {}), ...patch, updated_at: '2026-11-27T00:01:00Z' };
      return Response.json([storedRow]);
    }

    if (url.href === 'https://freebeat.ai/oauth/register') {
      return Response.json({ client_id: 'client-1' });
    }
    if (url.href === 'https://freebeat.ai/oauth/token') {
      return Response.json({ access_token: 'FB-ACCESS-SECRET', expires_in: 600, scope: 'freebeat:read freebeat:generate' });
    }
    if (url.href === 'https://freebeat.ai/api/mcp') {
      const rpc = jsonBody();
      if (rpc.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26' } }, { headers: { 'Mcp-Session-Id': 'mcp-sess-1' } });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (rpc.method === 'tools/call') {
        const { name, arguments: args } = rpc.params;
        mcpCalls.push({ name, args });
        if (name === 'upload_audio') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ music_id: '2485485' }) }] } });
        }
        if (name === 'quote_generation') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(quote) }] } });
        }
        if (name === 'generate_dance_video') {
          if (genMode === 'error') {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'upstream rejected' }] } });
          }
          if (genMode === 'preparing') {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, status: 'preparing', music_id: '2485485', retry_after_seconds: 10 }) }] } });
          }
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ task_id: 'dance:M001CONSUMER999', session_url: 'https://freebeat.ai/session/dance-consumer' }) }] } });
        }
        if (name === 'get_task_status') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(curTaskStatus) }] } });
        }
        if (name === 'get_task_result') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(curTaskResult) }] } });
        }
        if (name === 'send_video_agent_message') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } });
        }
      }
    }
    if (url.href === 'https://cdn.example/dance-out.mp4') {
      return new Response('MP4-STREAM-BYTES', { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url.href}`);
  };

  async function seedAdminFreebeatSession() {
    if (!hasProviderSession) return;
    const startRes = await worker.fetch(apiRequest('/api/freebeat/start', { method: 'POST', token: 'admin-jwt' }), env);
    assert.equal(startRes.status, 200);
    const pendingCookie = startRes.headers.get('set-cookie').split(';')[0];
    const state = new URL((await startRes.json()).url).searchParams.get('state');
    const cbRes = await worker.fetch(apiRequest(`/api/freebeat/callback?code=code&state=${state}`, { method: 'GET', token: null, cookie: pendingCookie }), env);
    assert.equal(cbRes.status, 303);
  }

  return {
    env,
    spends,
    refunds,
    mcpCalls,
    getRow: () => storedRow,
    setGenerateMode: (v) => { genMode = v; },
    setTaskStatus: (v) => { curTaskStatus = v; },
    setTaskResult: (v) => { curTaskResult = v; },
    seedAdminFreebeatSession,
    restore() { globalThis.fetch = realFetch; },
  };
}

test('/api/video/models mengekspos freebeat:generate_dance_video dengan tarif 3000 kredit saat admin menghubungkan Freebeat', async () => {
  const h = createHarness();
  try {
    await h.seedAdminFreebeatSession();
    const res = await worker.fetch(apiRequest('/api/video/models', { method: 'GET' }), h.env);
    assert.equal(res.status, 200);
    const data = await res.json();
    const dance = data.models.find((m) => m.provider === 'freebeat' && m.id === 'generate_dance_video');
    assert.ok(dance);
    assert.equal(dance.credits, 3000);
    assert.equal(dance.priced, true);
    assert.equal(dance.activeInAdmin, true);
    assert.equal(dance.providerConfigured, true);
    assert.equal(dance.requiresAudio, true);
    assert.equal(dance.maxImages, 5);
    assert.deepEqual(dance.resolutions, ['720p']);
  } finally {
    h.restore();
  }
});

test('/api/video/generate menolak input dance video tidak valid & biaya belum diatur tanpa memotong kredit', async () => {
  const h = createHarness();
  try {
    await h.seedAdminFreebeatSession();
    const noAudio = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', prompt: 'Dance' },
    }), h.env);
    assert.equal(noAudio.status, 400);
    assert.equal(h.spends.length, 0);

    const tooManyImgs = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_dance_video',
        audio_url: 'https://cdn.example/song.mp3',
        reference_images: ['1', '2', '3', '4', '5', '6'].map((n) => `https://cdn.example/${n}.jpg`),
      },
    }), h.env);
    assert.equal(tooManyImgs.status, 400);
    assert.equal(h.spends.length, 0);
  } finally {
    h.restore();
  }

  const hNoPrice = createHarness({ prices: [] });
  try {
    await hNoPrice.seedAdminFreebeatSession();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' },
    }), hNoPrice.env);
    assert.equal(res.status, 409);
    assert.equal(hNoPrice.spends.length, 0);
  } finally {
    hNoPrice.restore();
  }
});

test('/api/video/generate menolak 409 jika quote provider melebihi plafon & 402 jika saldo kurang sebelum memanggil generate_dance_video', async () => {
  const hHighQuote = createHarness({ quote: { status: 'quoted', credits: 2500 } });
  try {
    await hHighQuote.seedAdminFreebeatSession();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' },
    }), hHighQuote.env);
    assert.equal(res.status, 409);
    assert.equal(hHighQuote.spends.length, 0);
    assert.equal(hHighQuote.mcpCalls.some((c) => c.name === 'generate_dance_video'), false);
  } finally {
    hHighQuote.restore();
  }

  const hLowBal = createHarness({ spendOk: false });
  try {
    await hLowBal.seedAdminFreebeatSession();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' },
    }), hLowBal.env);
    assert.equal(res.status, 402);
    assert.equal(hLowBal.spends.length, 1);
    assert.equal(hLowBal.spends[0].p_amount, 3000);
    assert.equal(hLowBal.mcpCalls.some((c) => c.name === 'generate_dance_video'), false);
  } finally {
    hLowBal.restore();
  }
});

test('/api/video/generate + /api/video/status + /api/video/content/:id alur penuh Dance Video sampai completed & video proxy stream', async () => {
  const h = createHarness();
  try {
    await h.seedAdminFreebeatSession();
    const genRes = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_dance_video',
        prompt: 'Neon rooftop dance',
        aspect_ratio: '9:16',
        audio_url: 'https://cdn.example/song.mp3',
        reference_images: ['https://cdn.example/dancer1.jpg', 'https://cdn.example/dancer2.jpg'],
      },
    }), h.env);
    assert.equal(genRes.status, 200);
    const genData = await genRes.json();
    assert.equal(genData.credits, 3000);
    assert.equal(genData.generation.provider, 'freebeat');
    assert.equal(genData.generation.model, 'generate_dance_video');
    assert.equal(genData.generation.status, 'in_progress');
    assert.equal(genData.generation.credits_charged, 3000);
    assert.equal(h.spends.length, 1);

    const dispatchCall = h.mcpCalls.find((c) => c.name === 'generate_dance_video');
    assert.ok(dispatchCall);
    assert.equal(dispatchCall.args.music_id, 2485485);
    assert.equal(dispatchCall.args.auto_mode, true);
    assert.equal(dispatchCall.args.aspect_ratio, '9:16');
    assert.equal(dispatchCall.args.accept_unknown_cost, true);
    assert.deepEqual(dispatchCall.args.image_urls, ['https://cdn.example/dancer1.jpg', 'https://cdn.example/dancer2.jpg']);

    const statusRes = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(genData.generation.id)}`, { method: 'GET' }), h.env);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.generation.status, 'completed');
    assert.ok(statusData.generation.result_url.startsWith(`/api/video/content/${genData.generation.id}?exp=`));
    assert.equal(h.refunds.length, 0);

    const streamRes = await worker.fetch(apiRequest(statusData.generation.result_url, { method: 'GET', token: null }), h.env);
    assert.equal(streamRes.status, 200);
    assert.equal(await streamRes.text(), 'MP4-STREAM-BYTES');
  } finally {
    h.restore();
  }
});

test('preparing audio di dispatch awal dilanjutkan saat /api/video/status & refund atomik saat failed / error dispatch', async () => {
  const hPrep = createHarness({ generateMode: 'preparing' });
  try {
    await hPrep.seedAdminFreebeatSession();
    const genRes = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' },
    }), hPrep.env);
    assert.equal(genRes.status, 200);
    const genData = await genRes.json();
    assert.equal(genData.generation.status, 'queued');

    hPrep.setGenerateMode('success');
    const poll1 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(genData.generation.id)}`, { method: 'GET' }), hPrep.env);
    assert.equal(poll1.status, 200);
    const p1 = await poll1.json();
    assert.equal(p1.generation.status, 'in_progress');
    assert.equal(hPrep.getRow().external_job_id, 'dance:M001CONSUMER999');

    hPrep.setTaskStatus({ status: 'failed', failure: { stage: 'render', reason: 'insufficient_credits' } });
    hPrep.setTaskResult({ status: 'failed', failure: { stage: 'render', reason: 'insufficient_credits' }, billing: { charged: 0, refunded: 855, net: 0 } });
    const pollFail1 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(genData.generation.id)}`, { method: 'GET' }), hPrep.env);
    assert.equal(pollFail1.status, 200);
    const pf1 = await pollFail1.json();
    assert.equal(pf1.generation.status, 'failed');
    assert.equal(pf1.generation.credits_refunded, 3000);
    assert.equal(hPrep.refunds.length, 1);
    assert.equal(hPrep.refunds[0].p_amount, 3000);

    const pollFail2 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(genData.generation.id)}`, { method: 'GET' }), hPrep.env);
    assert.equal(pollFail2.status, 200);
    assert.equal(hPrep.refunds.length, 1);
  } finally {
    hPrep.restore();
  }

  const hErr = createHarness({ generateMode: 'error' });
  try {
    await hErr.seedAdminFreebeatSession();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' },
    }), hErr.env);
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.match(data.error, /Kredit BLEA dikembalikan/);
    assert.equal(hErr.spends.length, 1);
    assert.equal(hErr.refunds.length, 1);
    assert.equal(hErr.refunds[0].p_amount, 3000);
  } finally {
    hErr.restore();
  }
});

test('action_required pada polling consumer dance mengirimkan auto-nudge satu kali', async () => {
  const h = createHarness({ taskStatus: { status: 'action_required' } });
  try {
    await h.seedAdminFreebeatSession();
    const genRes = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' },
    }), h.env);
    assert.equal(genRes.status, 200);
    const id = (await genRes.json()).generation.id;

    const p1 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(id)}`, { method: 'GET' }), h.env);
    assert.equal(p1.status, 200);
    assert.equal((await p1.json()).generation.status, 'in_progress');
    assert.equal(h.mcpCalls.filter((c) => c.name === 'send_video_agent_message').length, 1);

    const p2 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(id)}`, { method: 'GET' }), h.env);
    assert.equal(p2.status, 200);
    assert.equal(h.mcpCalls.filter((c) => c.name === 'send_video_agent_message').length, 1);
  } finally {
    h.restore();
  }
});

test('GeneratePage UI: mode Freebeat Dance Video menampilkan upload audio/URL lagu & 0-5 foto penari serta mengirim request yang tepat', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://app.example/generate' });
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const prevFetch = globalThis.fetch;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });

  const submitted = [];
  let userBalance = 2000;
  const userSession = {
    access_token: 'tok-1',
    user: { id: 'u1', email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} },
  };

  const React = await import('react');
  const { act } = React;
  const { createRoot } = await import('react-dom/client');
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  supabase.auth.getSession = async () => ({ data: { session: userSession } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/account')) return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url.includes('/rest/v1/credit_wallets')) return Response.json({ balance: userBalance });
    if (url.includes('/rest/v1/credit_payment_settings')) return Response.json(null);
    if (url.includes('/api/video/models')) {
      return Response.json({
        ok: true,
        models: [{
          id: 'generate_dance_video',
          name: 'Freebeat Music-to-Dance Video (720p)',
          provider: 'freebeat',
          providerLabel: 'Freebeat Dance (Music-to-Dance)',
          providerConfigured: true,
          activeInAdmin: true,
          online: true,
          credits: 3000,
          priced: true,
          priceLabel: '3000 kredit',
          aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4'],
          resolutions: ['720p'],
          durations: [15],
          supportsAudio: true,
          requiresAudio: true,
          maxImages: 5,
        }],
      });
    }
    if (url.includes('/api/video/history')) return Response.json({ ok: true, generations: [] });
    if (url.includes('/api/credits/balance')) return Response.json({ balance: userBalance });
    if (url.includes('/api/video/generate')) {
      const payload = JSON.parse(init.body || '{}');
      submitted.push(payload);
      return Response.json({
        ok: true,
        credits: 3000,
        generation: {
          id: 'gen-dance-ui-1',
          provider: 'freebeat',
          model: 'generate_dance_video',
          aspect_ratio: payload.aspect_ratio || '9:16',
          resolution: '720p',
          duration: 15,
          status: 'in_progress',
          progress: 10,
          credits_charged: 3000,
        },
      });
    }
    if (url.includes('/api/video/status')) {
      return Response.json({
        ok: true,
        generation: {
          id: 'gen-dance-ui-1',
          provider: 'freebeat',
          model: 'generate_dance_video',
          aspect_ratio: '9:16',
          resolution: '720p',
          duration: 15,
          status: 'in_progress',
          progress: 25,
        },
      });
    }
    return Response.json({});
  };

  let mountedRoot = null;
  try {
    mountedRoot = createRoot(dom.window.document.getElementById('root'));
    await act(async () => {
      mountedRoot.render(React.createElement(
        MemoryRouter,
        { initialEntries: ['/generate'] },
        React.createElement(
          AuthProvider,
          { initialSession: userSession },
          React.createElement(GeneratePage),
        ),
      ));
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    }

    const html = dom.window.document.body.textContent || '';
    assert.match(html, /Lagu \/ Audio \(Wajib\)/);
    assert.match(html, /Foto Karakter \/ Penari \(0\/5\)/);
    assert.match(html, /Music-to-Dance \(bukan Motion Transfer video\)/);
    assert.doesNotMatch(html, /First Frame/);
    assert.doesNotMatch(html, /Upload Video/);

    let submitBtn = Array.from(dom.window.document.querySelectorAll('button[type="submit"]'))[0];
    assert.equal(submitBtn.disabled, true);
    await act(async () => { mountedRoot.unmount(); });
    mountedRoot = null;

    userBalance = 5000;
    const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    mountedRoot = createRoot(dom.window.document.getElementById('root'));
    await act(async () => {
      mountedRoot.render(React.createElement(
        MemoryRouter,
        { initialEntries: ['/generate'] },
        React.createElement(
          AuthProvider,
          { initialSession: userSession },
          React.createElement(GeneratePage),
        ),
      ));
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    }

    const urlInput2 = dom.window.document.querySelector('input[aria-label="URL Lagu HTTPS"]');
    assert.ok(urlInput2);
    await act(async () => {
      nativeSetter.call(urlInput2, 'https://cdn.example/track.mp3');
      urlInput2.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    submitBtn = Array.from(dom.window.document.querySelectorAll('button[type="submit"]'))[0];
    assert.equal(submitBtn.disabled, false);
    await act(async () => { submitBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });

    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].provider, 'freebeat');
    assert.equal(submitted[0].model, 'generate_dance_video');
    assert.equal(submitted[0].audio_url, 'https://cdn.example/track.mp3');
    assert.deepEqual(submitted[0].reference_images, []);
  } finally {
    if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
    supabase.auth.getSession = oldGet;
    supabase.auth.onAuthStateChange = oldOn;
    await supabase.auth.dispose();
    await vite.close();
    dom.window.close();
    globalThis.fetch = prevFetch;
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.localStorage = prevLocalStorage;
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});
