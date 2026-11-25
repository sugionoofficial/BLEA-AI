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
    FREEBEAT_RETRY_DELAY_MS: '0',
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
  prices = [
    { provider: 'freebeat', model: 'generate_singing_video', modality: 'video', credits: 3000, active: true },
    { provider: 'freebeat', model: 'generate_lip_sync_video', modality: 'video', credits: 3000, active: true },
  ],
  spendOk = true,
  quote = { status: 'quoted', credits: 700 },
  generateMode = 'success',
  generateErrorResult = { isError: true, content: [{ type: 'text', text: 'upstream rejected' }] },
  generateHttpStatus = null,
  uploadVideoError = false,
  uploadVideoDurationMs = null,
  firstTokenExhausted = false,
  failover400AfterSpend = false,
  taskStatus = { status: 'completed', billing: { charged: 700, refunded: null, net: 700 } },
  taskResult = { status: 'completed', result: { video_url: 'https://cdn.example/vocal-final.mp4', cover_url: 'https://cdn.example/cover.jpg' }, billing: { charged: 700, refunded: null, net: 700 } },
} = {}) {
  const env = createEnv();
  const realFetch = globalThis.fetch;
  let nextToken = 'FB-TOKEN-1';
  let nextEmail = 'fb1@example.com';
  const poolRows = [];
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
    if (url.pathname === '/rest/v1/provider_api_keys') return Response.json([]);
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
    if (url.pathname === '/rest/v1/freebeat_oauth_accounts') {
      if (method === 'POST') {
        const body = jsonBody();
        const row = { id: `fb-pool-${poolRows.length + 1}`, consecutive_failures: 0, ...body };
        poolRows.push(row);
        return Response.json([row]);
      }
      if (method === 'PATCH') {
        const id = url.searchParams.get('id')?.replace(/^eq\./, '');
        const patch = jsonBody();
        const target = poolRows.find((r) => r.id === id);
        if (target) Object.assign(target, patch);
        return Response.json(target ? [target] : []);
      }
      const idFilter = url.searchParams.get('id')?.replace(/^eq\./, '');
      const emailFilter = url.searchParams.get('account_email')?.replace(/^ilike\./, '').toLowerCase();
      const subFilter = url.searchParams.get('oauth_subject')?.replace(/^eq\./, '');
      return Response.json(poolRows.filter((r) => {
        if (idFilter && r.id !== idFilter) return false;
        if (emailFilter && String(r.account_email || '').toLowerCase() !== emailFilter) return false;
        if (subFilter && r.oauth_subject !== subFilter) return false;
        return true;
      }));
    }
    if (url.pathname === '/rest/v1/freebeat_provider_sessions') {
      if (method === 'POST') {
        storedProviderSession = jsonBody();
        return Response.json([storedProviderSession]);
      }
      return Response.json(storedProviderSession ? [storedProviderSession] : []);
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
      storedRow = { id: body.id, created_at: '2026-12-01T00:00:00Z', updated_at: '2026-12-01T00:00:00Z', ...body };
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
      storedRow = { ...(storedRow || {}), ...patch, updated_at: '2026-12-01T00:01:00Z' };
      return Response.json([storedRow]);
    }

    if (url.href === 'https://freebeat.ai/oauth/register') {
      return Response.json({ client_id: 'client-1' });
    }
    if (url.href === 'https://freebeat.ai/oauth/token') {
      return Response.json({ access_token: nextToken, expires_in: 600, scope: 'freebeat:read freebeat:generate' });
    }
    if (url.href === 'https://freebeat.ai/oauth/userinfo') {
      return Response.json({ sub: nextToken, email: nextEmail });
    }
    if (url.href === 'https://freebeat.ai/api/mcp') {
      const auth = String(init.headers?.authorization || '');
      const rpc = jsonBody();
      if (rpc.method === 'initialize') {
        if (firstTokenExhausted && auth === 'Bearer FB-TOKEN-1') {
          return Response.json({ error: 'insufficient_credits' }, { status: 402 });
        }
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26' } }, { headers: { 'Mcp-Session-Id': 'mcp-sess-1' } });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (rpc.method === 'tools/list') {
        const isFirstToken = auth === 'Bearer FB-TOKEN-1';
        const singingMaxDur = (failover400AfterSpend && !isFirstToken) ? 10 : 60;
        return Response.json({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [
              {
                name: 'generate_singing_video',
                inputSchema: {
                  type: 'object',
                  required: ['mode', 'image_urls', 'duration_seconds'],
                  properties: {
                    mode: { type: 'string', enum: ['solo', 'duet'] },
                    image_urls: { type: 'array', maxItems: 2, items: { type: 'string' } },
                    duration_seconds: { type: 'number', minimum: 1, maximum: singingMaxDur },
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
                    video_duration_ms: { type: 'integer', minimum: 1000, maximum: 300000 },
                    music_id: { type: 'integer' },
                    audio_url: { type: 'string' },
                    audio_duration_ms: { type: 'integer', minimum: 500 },
                    name: { type: 'string' },
                  },
                },
              },
            ],
          },
        });
      }
      if (rpc.method === 'tools/call') {
        const { name, arguments: args } = rpc.params;
        mcpCalls.push({ token: auth.replace(/^Bearer\s+/i, ''), name, args });
        if (name === 'get_balance') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ balance: 1500, credits: 1500 }) }] } });
        }
        if (name === 'upload_audio') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ music_id: 2485485 }) }] } });
        }
        if (name === 'upload_video') {
          if (uploadVideoError) {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { isError: true, content: [{ type: 'text', text: 'upload_video failed' }] } });
          }
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  video_url: 'https://freebeat.ai/media/synced-source.mp4',
                  ...(uploadVideoDurationMs ? { video_duration_ms: uploadVideoDurationMs } : {}),
                }),
              }],
            },
          });
        }
        if (name === 'quote_generation') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(quote) }] } });
        }
        if (name === 'generate_singing_video' || name === 'generate_lip_sync_video') {
          if (failover400AfterSpend && auth === 'Bearer FB-TOKEN-1') {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: 402, message: 'insufficient credits' } }, { status: 402 });
          }
          if (generateHttpStatus) return new Response('private provider body', { status: generateHttpStatus });
          if (genMode === 'error') {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: generateErrorResult });
          }
          if (genMode === 'missing-task') {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: { success: true } } });
          }
          if (genMode === 'preparing') {
            return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ success: true, status: 'preparing', music_id: 2485485, retry_after_seconds: 10 }) }] } });
          }
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ task_id: `${name}:CONSUMER999`, session_url: 'https://freebeat.ai/session/vocal-consumer' }) }] } });
        }
        if (name === 'get_task_status') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(curTaskStatus) }] } });
        }
        if (name === 'get_task_result') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(curTaskResult) }] } });
        }
      }
    }
    if (url.href === 'https://cdn.example/vocal-final.mp4') {
      return new Response('VOCAL-MP4-BYTES', { status: 200, headers: { 'content-type': 'video/mp4' } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url.href}`);
  };

  async function seedFreebeatAccount(token = 'FB-TOKEN-1', email = 'fb1@example.com') {
    nextToken = token;
    nextEmail = email;
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
    seedFreebeatAccount,
    restore() { globalThis.fetch = realFetch; },
  };
}

test('/api/video/models mengekspos generate_singing_video & generate_lip_sync_video tanpa panggilan live ke freebeat.ai', async () => {
  const h = createHarness();
  try {
    await h.seedFreebeatAccount();
    const callsBefore = h.mcpCalls.length;
    const res = await worker.fetch(apiRequest('/api/video/models', { method: 'GET' }), h.env);
    assert.equal(res.status, 200);
    assert.equal(h.mcpCalls.length, callsBefore);
    const data = await res.json();
    const singing = data.models.find((m) => m.provider === 'freebeat' && m.id === 'generate_singing_video');
    const lipsync = data.models.find((m) => m.provider === 'freebeat' && m.id === 'generate_lip_sync_video');
    assert.ok(singing);
    assert.equal(singing.credits, 3000);
    assert.equal(singing.priced, true);
    assert.equal(singing.requiresImage, true);
    assert.equal(singing.maxImages, 5);
    assert.ok(lipsync);
    assert.equal(lipsync.credits, 3000);
    assert.equal(lipsync.requiresVideo, true);
    assert.equal(lipsync.requiresAudio, true);
  } finally {
    h.restore();
  }
});

test('/api/video/generate Singing Video: validasi, failover pool akun, resolve mode schema, status & refund otomatis', async () => {
  const hFailover = createHarness({ firstTokenExhausted: true });
  try {
    await hFailover.seedFreebeatAccount('FB-TOKEN-1', 'fb1@example.com');
    await hFailover.seedFreebeatAccount('FB-TOKEN-2', 'fb2@example.com');

    // Reject missing photo before spend_credits
    const missingImg = await worker.fetch(apiRequest('/api/video/generate', {
      body: { provider: 'freebeat', model: 'generate_singing_video', audio_url: 'https://cdn.example/song.mp3', duration: 15 },
    }), hFailover.env);
    assert.equal(missingImg.status, 400);
    assert.equal(hFailover.spends.length, 0);

    // Valid Singing Video succeeds on FB-TOKEN-2 after FB-TOKEN-1 fails 402
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_singing_video',
        mode: 'auto',
        prompt: 'Stage lights warm neon',
        aspect_ratio: '9:16',
        duration: 15,
        audio_url: 'https://cdn.example/song.mp3',
        audio_start_seconds: 12.5,
        reference_images: ['https://cdn.example/singer.jpg'],
      },
    }), hFailover.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.generation.model, 'generate_singing_video');
    assert.equal(body.generation.credits_charged, 3000);
    assert.equal(hFailover.spends.length, 1);

    const dispatchCall = hFailover.mcpCalls.find((c) => c.name === 'generate_singing_video');
    assert.ok(dispatchCall);
    assert.equal(dispatchCall.token, 'FB-TOKEN-2');
    assert.equal(dispatchCall.args.mode, 'solo');
    assert.equal(dispatchCall.args.audio_start_seconds, 12.5);
    assert.equal(dispatchCall.args.music_id, 2485485);
    assert.equal(dispatchCall.args.scene_prompt, 'Stage lights warm neon');

    // Poll completes & signs stream URL
    const stRes = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(body.generation.id)}`, { method: 'GET' }), hFailover.env);
    assert.equal(stRes.status, 200);
    const stBody = await stRes.json();
    assert.equal(stBody.generation.status, 'completed');
    assert.ok(stBody.generation.result_url.startsWith(`/api/video/content/${body.generation.id}?exp=`));
  } finally {
    hFailover.restore();
  }

  // Provider error refunds BLEA credits
  const hErr = createHarness({ generateMode: 'error' });
  try {
    await hErr.seedFreebeatAccount();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_singing_video',
        audio_url: 'https://cdn.example/song.mp3',
        reference_images: ['https://cdn.example/singer.jpg'],
        duration: 10,
      },
    }), hErr.env);
    assert.equal(res.status, 502);
    assert.equal(hErr.spends.length, 1);
    assert.equal(hErr.refunds.length, 1);
    assert.equal(hErr.refunds[0].p_amount, 3000);
  } finally {
    hErr.restore();
  }
});

test('/api/video/generate Lip-Sync Video: upload_video non-Freebeat, skip upload_video host Freebeat, clamp duration DB, preparing -> failed refund', async () => {
  // 1) upload_video failure stops before spend_credits
  const hUploadFail = createHarness({ uploadVideoError: true });
  try {
    await hUploadFail.seedFreebeatAccount();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_lip_sync_video',
        video_url: 'https://storage.example/face.mp4',
        video_duration_ms: 14000,
        audio_url: 'https://storage.example/voice.mp3',
      },
    }), hUploadFail.env);
    assert.equal(res.status, 502);
    assert.equal(hUploadFail.spends.length, 0);
  } finally {
    hUploadFail.restore();
  }

  // 2) Full lip-sync with DB duration clamp (150s -> 120 in DB, 150000 ms to MCP) & preparing resume -> failed refund
  const hPrep = createHarness({ generateMode: 'preparing' });
  try {
    await hPrep.seedFreebeatAccount();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_lip_sync_video',
        prompt: 'Lip sync test title',
        video_url: 'https://storage.example/face.mp4',
        video_duration_ms: 150000,
        audio_url: 'https://storage.example/voice.mp3',
      },
    }), hPrep.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.generation.model, 'generate_lip_sync_video');
    assert.equal(body.generation.duration, 120);
    assert.equal(hPrep.mcpCalls.filter((c) => c.name === 'upload_video').length, 1);

    hPrep.setGenerateMode('success');
    const p1 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(body.generation.id)}`, { method: 'GET' }), hPrep.env);
    assert.equal(p1.status, 200);
    assert.equal(hPrep.getRow().external_job_id, 'generate_lip_sync_video:CONSUMER999');

    hPrep.setTaskStatus({ status: 'failed', failure: { stage: 'render', reason: 'generation_failed' } });
    hPrep.setTaskResult({ status: 'failed', failure: { stage: 'render', reason: 'generation_failed' } });
    const pFail = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(body.generation.id)}`, { method: 'GET' }), hPrep.env);
    assert.equal(pFail.status, 200);
    const pfBody = await pFail.json();
    assert.equal(pfBody.generation.status, 'failed');
    assert.equal(pfBody.generation.credits_refunded, 3000);
    assert.equal(hPrep.refunds.length, 1);
  } finally {
    hPrep.restore();
  }

  // 3) Freebeat-hosted video_url skips upload_video
  const hSkipUpload = createHarness();
  try {
    await hSkipUpload.seedFreebeatAccount();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_lip_sync_video',
        video_url: 'https://static.freebeat.ai/media/already-hosted.mp4',
        video_duration_ms: 8500,
        audio_url: 'https://storage.example/voice.mp3',
      },
    }), hSkipUpload.env);
    assert.equal(res.status, 200);
    assert.equal(hSkipUpload.mcpCalls.filter((c) => c.name === 'upload_video').length, 0);
    const dispatch = hSkipUpload.mcpCalls.find((c) => c.name === 'generate_lip_sync_video');
    assert.equal(dispatch.args.video_url, 'https://static.freebeat.ai/media/already-hosted.mp4');
    assert.equal(dispatch.args.video_duration_ms, 8500);
  } finally {
    hSkipUpload.restore();
  }

  // 4) Pasted URL without explicit video_duration_ms adopts upload_video duration_ms
  const hRealDur = createHarness({ uploadVideoDurationMs: 22400 });
  try {
    await hRealDur.seedFreebeatAccount();
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_lip_sync_video',
        video_url: 'https://storage.example/pasted-face.mp4',
        duration: 5,
        audio_url: 'https://storage.example/voice.mp3',
      },
    }), hRealDur.env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.generation.duration, 22);
    const dispatch = hRealDur.mcpCalls.find((c) => c.name === 'generate_lip_sync_video');
    assert.equal(dispatch.args.video_duration_ms, 22400);
  } finally {
    hRealDur.restore();
  }

  // 5) 400 validation error during failover AFTER spend_credits MUST refund and fail row cleanly
  const hFailover400 = createHarness({ failover400AfterSpend: true });
  try {
    await hFailover400.seedFreebeatAccount('FB-TOKEN-1', 'fb1@example.com');
    await hFailover400.seedFreebeatAccount('FB-TOKEN-2', 'fb2@example.com');
    const res = await worker.fetch(apiRequest('/api/video/generate', {
      body: {
        provider: 'freebeat',
        model: 'generate_singing_video',
        duration: 15,
        audio_url: 'https://cdn.example/song.mp3',
        reference_images: ['https://cdn.example/singer.jpg'],
      },
    }), hFailover400.env);
    assert.equal(res.status, 400);
    assert.equal(hFailover400.spends.length, 1);
    assert.equal(hFailover400.refunds.length, 1);
    assert.equal(hFailover400.refunds[0].p_amount, 3000);
    assert.equal(hFailover400.getRow().status, 'failed');
    assert.equal(hFailover400.getRow().credits_refunded, 3000);
  } finally {
    hFailover400.restore();
  }
});

test('Lip-Sync dispatch failures retain safe HTTP/RPC/reason diagnostics without provider prose', async () => {
  const secret = 'private@example.com https://private.example/token sk_private_token';
  const cases = [
    { options: { generateMode: 'error' }, diagnostic: { kind: 'tool_rejected' }, tag: 'FB-VOCAL-TOOL-REJECTED' },
    {
      options: { generateMode: 'error', generateErrorResult: { isError: true, structuredContent: { failure: { reason: 'invalid_video' }, message: secret } } },
      diagnostic: { kind: 'tool_rejected', reason: 'invalid_video' }, tag: 'invalid_video',
    },
    {
      options: { generateMode: 'error', generateErrorResult: { isError: true, error: { code: -32602, message: secret, data: { reason: 'invalid_parameter' } } } },
      diagnostic: { kind: 'tool_rejected', rpc_code: -32602, reason: 'invalid_parameter' }, tag: 'RPC -32602',
    },
    {
      options: { generateMode: 'error', generateErrorResult: { isError: true, structuredContent: { error_code: secret, message: secret } } },
      diagnostic: { kind: 'tool_rejected' }, tag: 'FB-VOCAL-TOOL-REJECTED',
    },
    { options: { generateHttpStatus: 400 }, diagnostic: { kind: 'http', http_status: 400 }, tag: 'HTTP 400' },
    { options: { generateMode: 'missing-task' }, diagnostic: { kind: 'missing_task_id' }, tag: 'FB-VOCAL-MISSING-TASK-ID' },
  ];
  for (const { options, diagnostic, tag } of cases) {
    const h = createHarness(options);
    try {
      await h.seedFreebeatAccount();
      const res = await worker.fetch(apiRequest('/api/video/generate', {
        body: {
          provider: 'freebeat', model: 'generate_lip_sync_video',
          video_url: 'https://storage.example/face.mp4', video_duration_ms: 30000,
          audio_url: 'https://storage.example/voice.mp3', audio_duration_ms: 30000,
        },
      }), h.env);
      assert.equal(res.status, 502);
      const body = await res.text();
      assert.ok(body.includes(tag), body);
      assert.ok(!body.includes(secret));
      assert.ok(body.includes('Kredit BLEA dikembalikan'));
      assert.deepEqual(h.getRow().metadata.dispatch_failure, diagnostic);
      assert.ok(!JSON.stringify(h.getRow().metadata).includes(secret));
      assert.equal(h.getRow().metadata.dispatch_parameters.video_duration_ms, 30000);
      assert.equal(h.refunds.length, 1);
      assert.equal(h.spends.length, 1);
      assert.equal(h.mcpCalls.filter((c) => c.name === 'generate_lip_sync_video').length, 1);
    } finally { h.restore(); }
  }
});

test('GeneratePage UI: mendukung mode Singing Video dan Lip-Sync Video beserta field khusus masing-masing', async () => {
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
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { act } = React;

  const userSession = {
    access_token: 'user-token-ui',
    user: { id: 'u1', email: 'creator@example.com', user_metadata: { full_name: 'Kreator' }, app_metadata: {} },
  };
  const oldStorageFrom = supabase.storage.from;
  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  supabase.auth.getSession = async () => ({ data: { session: userSession }, error: null });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/account')) return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url.includes('/rest/v1/credit_wallets')) return Response.json({ balance: 5000 });
    if (url.includes('/rest/v1/credit_payment_settings')) return Response.json(null);
    if (url.includes('/api/video/models')) {
      return Response.json({
        ok: true,
        models: [
          {
            provider: 'freebeat',
            providerLabel: 'Freebeat',
            id: 'generate_singing_video',
            name: 'Freebeat Singing Video',
            credits: 3000,
            priced: true,
            activeInAdmin: true,
            providerConfigured: true,
            aspectRatios: ['9:16', '16:9', '1:1'],
            resolutions: ['720p'],
            durations: [15],
            supportsAudio: true,
            requiresAudio: true,
            requiresImages: true,
            maxImages: 2,
            singingModes: ['auto', 'duet'],
          },
          {
            provider: 'freebeat',
            providerLabel: 'Freebeat',
            id: 'generate_lip_sync_video',
            name: 'Freebeat Lip-Sync Video',
            credits: 3000,
            priced: true,
            activeInAdmin: true,
            providerConfigured: true,
            aspectRatios: [],
            resolutions: ['720p'],
            durations: [15],
            supportsAudio: true,
            requiresAudio: true,
            requiresVideo: true,
            maxImages: 0,
          },
        ],
      });
    }
    if (url.includes('/api/video/history')) return Response.json({ ok: true, generations: [] });
    if (url.includes('/api/credits/balance')) return Response.json({ balance: 5000 });
    if (url.includes('/api/video/generate')) {
      const payload = JSON.parse(init.body || '{}');
      submitted.push(payload);
      return Response.json({
        ok: true,
        credits: 3000,
        generation: {
          id: 'gen-vocal-ui-1',
          provider: 'freebeat',
          model: payload.model,
          status: 'in_progress',
          progress: 10,
          credits_charged: 3000,
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
        React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(GeneratePage)),
      ));
    });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    }

    // Verify Singing Video fields
    const singingHtml = dom.window.document.body.textContent || '';
    assert.match(singingHtml, /Singing Video \(Lagu & Foto Penyanyi\)/);
    assert.match(singingHtml, /Mode Bernyanyi/);
    assert.match(singingHtml, /Mulai audio \(detik, opsional\)/);
    assert.match(singingHtml, /Arahan Adegan \/ Prompt \(Opsional\)/);

    // Switch to Lip-Sync Video via ModelSelect native select or popover
    const lipOption = Array.from(dom.window.document.querySelectorAll('option')).find((opt) => opt.value.includes('generate_lip_sync_video'));
    if (lipOption && lipOption.parentElement) {
      await act(async () => {
        lipOption.parentElement.value = lipOption.value;
        lipOption.parentElement.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
    } else {
      const modelBtns = Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent.includes('Freebeat Singing Video'));
      assert.ok(modelBtns);
      await act(async () => { modelBtns.click(); });
      const pickLip = Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent.includes('Freebeat Lip-Sync Video'));
      assert.ok(pickLip);
      await act(async () => { pickLip.click(); });
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });

    const lipHtml = dom.window.document.body.textContent || '';
    assert.match(lipHtml, /Lip-Sync Video \(Video Sumber & Audio\)/);
    assert.match(lipHtml, /Video Sumber \(Wajib\)/);
    assert.match(lipHtml, /Judul Klip \(Opsional\)/);

    // A file below the application's 100 MB cap can still be rejected by
    // Storage's global setting. Handle both SDK return and rejected promise.
    let uploadCalls = 0;
    for (const shouldThrow of [false, true]) {
      supabase.storage.from = () => ({
        upload: async () => {
          uploadCalls += 1;
          const error = { statusCode: '413', message: 'The object exceeded the maximum allowed size' };
          if (shouldThrow) throw error;
          return { data: null, error };
        },
        getPublicUrl: () => assert.fail('rejected file must not become a media URL'),
      });
      const uploadInput = dom.window.document.querySelector('input[aria-label="Upload Video"]');
      assert.ok(uploadInput);
      Object.defineProperty(uploadInput, 'files', { configurable: true, value: [{
        name: 'source.mp4', type: 'video/mp4', size: 60 * 1024 * 1024,
      }] });
      await act(async () => {
        uploadInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
      assert.match(dom.window.document.body.textContent, /Ukuran video \(60\.0 MB\) ditolak/);
      assert.match(dom.window.document.body.textContent, /URL HTTPS publik/);
      assert.ok(!dom.window.document.body.textContent.includes('The object exceeded'));
      assert.ok(!dom.window.document.body.textContent.includes('Mengunggah...'));
      assert.equal(submitted.length, 0);
    }
    assert.equal(uploadCalls, 2);

    const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    const vidInput = dom.window.document.querySelector('input[aria-label="URL Video HTTPS"]');
    const audInput = dom.window.document.querySelector('input[aria-label="URL Lagu HTTPS"]');
    const durMsInput = dom.window.document.querySelector('input[aria-label="Durasi Video (ms)"]');
    assert.ok(vidInput && audInput && durMsInput);

    await act(async () => {
      nativeSetter.call(vidInput, 'https://cdn.example/face.mp4');
      vidInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      nativeSetter.call(audInput, 'https://cdn.example/voice.mp3');
      audInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      nativeSetter.call(durMsInput, '9500');
      durMsInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });

    const submitBtn = Array.from(dom.window.document.querySelectorAll('button[type="submit"]'))[0];
    assert.equal(submitBtn.disabled, false);
    await act(async () => { submitBtn.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 25)); });

    assert.equal(submitted.length, 1);
    assert.equal(submitted[0].model, 'generate_lip_sync_video');
    assert.equal(submitted[0].video_url, 'https://cdn.example/face.mp4');
    assert.equal(submitted[0].audio_url, 'https://cdn.example/voice.mp3');
    assert.equal(submitted[0].video_duration_ms, 9500);
  } finally {
    if (mountedRoot) await act(async () => { mountedRoot.unmount(); });
    supabase.storage.from = oldStorageFrom;
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
