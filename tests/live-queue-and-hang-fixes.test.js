import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import worker, {
  diagnosePendingGeneration,
  formatLiveQueueItem,
  patchImageGeneration,
} from '../src/worker.js';
import { consumerDanceStatus } from '../src/lib/freebeatMcp.js';
import { formatElapsedHuman, formatElapsedRuntime, getElapsedMs } from '../src/lib/formatRuntime.js';

const BASE = 'https://blea-ai.blea-ai.workers.dev';
const ADMIN_ID = '26d3eba0-0114-44cd-8488-85be44ef4381';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const VID_ID = 'be504e34-ebef-43c9-a3a0-6c5235e84949';
const IMG_STUCK_ID = 'fba0bc31-5529-4f52-8f91-13893b866028';
const IMG_ACTIVE_ID = '52486688-1b0b-4d57-ac15-b1be5a995400';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path, { method = 'POST', body, token = 'user-jwt', origin = BASE } = {}) {
  const headers = {
    ...(origin ? { origin } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
  };
  return new Request(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('formatElapsedRuntime & formatElapsedHuman format sub-hour, multi-hour, and edge inputs cleanly', () => {
  const base = Date.parse('2026-11-20T19:00:00.000Z');
  assert.equal(getElapsedMs(base, base - 5000), 0);
  assert.equal(getElapsedMs('not-a-date', base), 0);
  assert.equal(formatElapsedRuntime(base, base + 42_000), '00:42');
  assert.equal(formatElapsedRuntime(base, base + (14 * 60 + 8) * 1000), '14:08');
  assert.equal(formatElapsedRuntime(base, base + (2 * 3600 + 5 * 60 + 9) * 1000), '02:05:09');
  assert.equal(formatElapsedHuman(base, base + 42_000), '42 dtk');
  assert.equal(formatElapsedHuman(base, base + (14 * 60 + 8) * 1000), '14 mnt 08 dtk');
  assert.equal(formatElapsedHuman(base, base + (2 * 3600 + 5 * 60 + 9) * 1000), '2 jam 05 mnt');
});

test('diagnosePendingGeneration and formatLiveQueueItem anonymize other users while exposing full details to owner/admin', () => {
  const now = Date.parse('2026-11-20T20:00:00.000Z');
  const videoRow = {
    id: VID_ID,
    user_id: ADMIN_ID,
    provider: 'freebeat',
    model: 'generate_dance_video',
    prompt: 'Secret admin choreography prompt',
    status: 'in_progress',
    progress: 90,
    external_job_id: 'dance:M001',
    credits_charged: 3000,
    credits_refunded: 0,
    created_at: '2026-11-20T19:28:15.000Z',
    updated_at: '2026-11-20T19:42:10.000Z',
    metadata: { auto_nudged: true },
  };
  const stuckImageRow = {
    id: IMG_STUCK_ID,
    user_id: USER_ID,
    provider: 'alibaba',
    model: 'wan2.6-image',
    prompt: 'User own prompt',
    status: 'processing',
    external_job_id: null,
    credits_charged: 15,
    credits_refunded: 0,
    created_at: '2026-11-20T19:50:00.000Z',
    updated_at: '2026-11-20T19:50:00.000Z',
  };

  assert.match(diagnosePendingGeneration('video', videoRow, now), /90%.*5 menit/);
  assert.match(diagnosePendingGeneration('image', stuckImageRow, now), /Task ID upstream belum tersimpan/);

  const emailMap = new Map([
    [ADMIN_ID, 'sugionoofficial88@gmail.com'],
    [USER_ID, 'creator@example.com'],
  ]);

  // Regular user viewing admin's video -> anonymized
  const otherForUser = formatLiveQueueItem(videoRow, 'video', { isAdmin: false, viewerId: USER_ID, emailMap, nowMs: now });
  assert.equal(otherForUser.is_own, false);
  assert.equal('prompt' in otherForUser, false);
  assert.equal('user_email' in otherForUser, false);
  assert.equal('user_id' in otherForUser, false);
  assert.equal('external_job_id' in otherForUser, false);
  assert.equal('can_cancel' in otherForUser, false);

  // Regular user viewing own image -> full prompt visible, still no admin fields
  const ownForUser = formatLiveQueueItem(stuckImageRow, 'image', { isAdmin: false, viewerId: USER_ID, emailMap, nowMs: now });
  assert.equal(ownForUser.is_own, true);
  assert.equal(ownForUser.prompt, 'User own prompt');
  assert.equal('can_cancel' in ownForUser, false);

  // Admin viewing both -> emails, external_job_id, and can_cancel present
  const videoForAdmin = formatLiveQueueItem(videoRow, 'video', { isAdmin: true, viewerId: ADMIN_ID, emailMap, nowMs: now });
  assert.equal(videoForAdmin.user_email, 'sugionoofficial88@gmail.com');
  assert.equal(videoForAdmin.external_job_id, 'dance:M001');
  assert.equal(videoForAdmin.can_cancel, true);
});

test('patchImageGeneration retries without provider_key_id if initial PATCH fails on older schema', async () => {
  const realFetch = globalThis.fetch;
  const patches = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    patches.push(body);
    if (Object.prototype.hasOwnProperty.call(body, 'provider_key_id')) {
      return new Response(JSON.stringify({ code: 'PGRST204', message: 'provider_key_id not found' }), { status: 400 });
    }
    return new Response(JSON.stringify([{ id: IMG_STUCK_ID, ...body }]), { status: 200 });
  };
  try {
    const ok = await patchImageGeneration(createEnv(), IMG_STUCK_ID, {
      external_job_id: 'ali-task-999',
      status: 'processing',
      provider_key_id: 'pool-key-1',
    });
    assert.equal(ok, true);
    assert.equal(patches.length, 2);
    assert.equal(patches[0].provider_key_id, 'pool-key-1');
    assert.equal('provider_key_id' in patches[1], false);
    assert.equal(patches[1].external_job_id, 'ali-task-999');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/generations/live enforces auth + user privacy and /api/admin/generations/cancel cancels & refunds atomically without double-refund', async () => {
  const realFetch = globalThis.fetch;
  const env = createEnv();

  const dbVideos = [
    {
      id: VID_ID,
      user_id: ADMIN_ID,
      provider: 'freebeat',
      model: 'generate_dance_video',
      prompt: 'Admin dance test prompt',
      status: 'in_progress',
      progress: 90,
      external_job_id: 'dance:M001',
      credits_charged: 3000,
      credits_refunded: 0,
      created_at: '2026-11-20T19:28:15.000Z',
      updated_at: '2026-11-20T19:42:10.000Z',
      metadata: { auto_nudged: true },
    },
  ];
  const dbImages = [
    {
      id: IMG_STUCK_ID,
      user_id: ADMIN_ID,
      provider: 'alibaba',
      model: 'wan2.6-image',
      prompt: 'Admin stuck image',
      status: 'processing',
      external_job_id: null,
      credits_charged: 15,
      credits_refunded: 0,
      created_at: '2026-11-20T19:10:00.000Z',
      updated_at: '2026-11-20T19:10:00.000Z',
    },
    {
      id: IMG_ACTIVE_ID,
      user_id: USER_ID,
      provider: 'alibaba',
      model: 'wan2.7-image',
      prompt: 'User active image',
      status: 'processing',
      external_job_id: 'ali-task-active',
      provider_key_id: null,
      credits_charged: 15,
      credits_refunded: 0,
      created_at: '2026-11-20T19:50:00.000Z',
      updated_at: '2026-11-20T19:50:00.000Z',
    },
  ];
  const refunds = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url.href === 'https://supabase.example/auth/v1/user') {
      const bearer = (init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (bearer === 'admin-jwt') {
        return Response.json({ id: ADMIN_ID, email: 'sugionoofficial88@gmail.com', app_metadata: { role: 'admin' } });
      }
      return Response.json({ id: USER_ID, email: 'creator@example.com', app_metadata: { role: 'user' } });
    }
    if (url.pathname === '/rest/v1/profiles') {
      return Response.json([
        { id: ADMIN_ID, email: 'sugionoofficial88@gmail.com', status: 'active' },
        { id: USER_ID, email: 'creator@example.com', status: 'active' },
      ]);
    }
    if (url.pathname === '/rest/v1/provider_key_pool') {
      return Response.json([{
        id: 'pool-1',
        provider: 'alibaba',
        api_key: 'ali-secret-key',
        base_url: 'https://dashscope-intl.aliyuncs.com',
        priority: 1,
        consecutive_failures: 0,
        cooldown_until: null,
      }]);
    }
    if (url.pathname === '/rest/v1/video_generations') {
      const idFilter = url.searchParams.get('id')?.replace(/^eq\./, '');
      const statusFilter = url.searchParams.get('status');
      if (method === 'GET') {
        let rows = dbVideos;
        if (idFilter) rows = rows.filter((r) => r.id === idFilter);
        if (statusFilter === 'in.(queued,in_progress)') {
          rows = rows.filter((r) => ['queued', 'in_progress'].includes(r.status));
        }
        return Response.json(rows);
      }
      if (method === 'PATCH') {
        const patch = jsonBody();
        const row = dbVideos.find((r) => r.id === idFilter);
        if (!row) return Response.json([]);
        if (statusFilter === 'in.(queued,in_progress)' && !['queued', 'in_progress'].includes(row.status)) {
          return Response.json([]);
        }
        if (url.searchParams.get('credits_refunded') === 'eq.0' && row.credits_refunded !== 0) {
          return Response.json([]);
        }
        Object.assign(row, patch);
        return Response.json([row]);
      }
    }
    if (url.pathname === '/rest/v1/image_generations') {
      const idFilter = url.searchParams.get('id')?.replace(/^eq\./, '');
      const statusFilter = url.searchParams.get('status');
      if (method === 'GET') {
        let rows = dbImages;
        if (idFilter) rows = rows.filter((r) => r.id === idFilter);
        if (statusFilter === 'in.(queued,processing,unknown)') {
          rows = rows.filter((r) => ['queued', 'processing', 'unknown'].includes(r.status));
        }
        return Response.json(rows);
      }
      if (method === 'PATCH') {
        const patch = jsonBody();
        const row = dbImages.find((r) => r.id === idFilter);
        if (!row) return Response.json([]);
        if (statusFilter === 'in.(queued,processing,unknown)' && !['queued', 'processing', 'unknown'].includes(row.status)) {
          return Response.json([]);
        }
        if (url.searchParams.get('credits_refunded') === 'eq.0' && row.credits_refunded !== 0) {
          return Response.json([]);
        }
        Object.assign(row, patch);
        return Response.json([row]);
      }
    }
    if (url.pathname === '/rest/v1/rpc/refund_credits') {
      refunds.push(jsonBody());
      return Response.json(true);
    }
    if (url.hostname === 'dashscope-intl.aliyuncs.com' && url.pathname === '/api/v1/tasks/ali-task-active') {
      return Response.json({
        output: {
          task_status: 'SUCCEEDED',
          results: [{ url: 'https://cdn.example/ali-finished.png' }],
        },
      });
    }
    return realFetch(input, init);
  };

  try {
    // 1. Unauthenticated rejected
    const unauth = await worker.fetch(apiRequest('/api/generations/live', { token: '' }), env);
    assert.equal(unauth.status, 401);

    // 2. Regular user sees global active jobs with admin's job anonymized and own job visible
    const userLiveRes = await worker.fetch(apiRequest('/api/generations/live', { token: 'user-jwt', body: { poll: false } }), env);
    assert.equal(userLiveRes.status, 200);
    const userLive = await userLiveRes.json();
    assert.equal(userLive.is_admin, false);
    assert.equal(userLive.items.length, 3);
    const adminJobForUser = userLive.items.find((it) => it.id === VID_ID);
    const ownJobForUser = userLive.items.find((it) => it.id === IMG_ACTIVE_ID);
    assert.equal(adminJobForUser.is_own, false);
    assert.equal('prompt' in adminJobForUser, false);
    assert.equal('user_email' in adminJobForUser, false);
    assert.equal('can_cancel' in adminJobForUser, false);
    assert.equal(ownJobForUser.is_own, true);
    assert.equal(ownJobForUser.prompt, 'User active image');

    // 3. Regular user cannot call admin cancel
    const userCancelRes = await worker.fetch(apiRequest('/api/admin/generations/cancel', {
      token: 'user-jwt',
      body: { id: IMG_STUCK_ID, kind: 'image' },
    }), env);
    assert.equal(userCancelRes.status, 403);

    // 4. Cross-origin admin cancel rejected
    const csrfCancelRes = await worker.fetch(apiRequest('/api/admin/generations/cancel', {
      token: 'admin-jwt',
      origin: 'https://evil.example',
      body: { id: IMG_STUCK_ID, kind: 'image' },
    }), env);
    assert.equal(csrfCancelRes.status, 403);

    // 5. Admin live poll resolves pollable Alibaba image (ali-task-active -> completed) while showing emails & cancel capability for remaining stuck rows
    const adminLiveRes = await worker.fetch(apiRequest('/api/generations/live', {
      token: 'admin-jwt',
      body: { poll: true },
    }), env);
    assert.equal(adminLiveRes.status, 200);
    const adminLive = await adminLiveRes.json();
    assert.equal(adminLive.is_admin, true);
    assert.equal(adminLive.items.find((it) => it.id === IMG_ACTIVE_ID), undefined); // resolved to completed!
    assert.equal(dbImages.find((it) => it.id === IMG_ACTIVE_ID).status, 'completed');
    const stuckImgAdmin = adminLive.items.find((it) => it.id === IMG_STUCK_ID);
    assert.equal(stuckImgAdmin.user_email, 'sugionoofficial88@gmail.com');
    assert.equal(stuckImgAdmin.stalled, true);
    assert.equal(stuckImgAdmin.can_cancel, true);

    // 6. Admin cancels stuck video (3000 credits) & stuck image (15 credits), refunding exact unrefunded credits
    const cancelVid = await worker.fetch(apiRequest('/api/admin/generations/cancel', {
      token: 'admin-jwt',
      body: { id: VID_ID, kind: 'video', reason: 'Macet 90% di Freebeat' },
    }), env);
    assert.equal(cancelVid.status, 200);
    const cancelVidData = await cancelVid.json();
    assert.equal(cancelVidData.refunded, 3000);
    assert.equal(cancelVidData.generation.status, 'cancelled');

    const cancelImg = await worker.fetch(apiRequest('/api/admin/generations/cancel', {
      token: 'admin-jwt',
      body: { id: IMG_STUCK_ID, kind: 'image', reason: 'Task ID null' },
    }), env);
    assert.equal(cancelImg.status, 200);
    const cancelImgData = await cancelImg.json();
    assert.equal(cancelImgData.refunded, 15);
    assert.equal(cancelImgData.generation.status, 'cancelled');

    // 7. Re-cancelling same job is rejected (409) with zero double refund
    const doubleCancel = await worker.fetch(apiRequest('/api/admin/generations/cancel', {
      token: 'admin-jwt',
      body: { id: VID_ID, kind: 'video' },
    }), env);
    assert.equal(doubleCancel.status, 409);
    assert.equal(refunds.length, 2);
    assert.equal(refunds[0].p_amount, 3000);
    assert.equal(refunds[1].p_amount, 15);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('consumerDanceStatus throttles up to 3 action_required nudges and records metadata.agent_status', async () => {
  const realFetch = globalThis.fetch;
  const env = createEnv();
  const nudges = [];
  let storedProviderSession = null;
  let pollMode = 'action_required';

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url.href === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: ADMIN_ID, email: 'admin@example.com', app_metadata: { role: 'admin' } });
    }
    if (url.pathname === '/rest/v1/freebeat_provider_sessions') {
      if (method === 'POST') {
        storedProviderSession = jsonBody();
        return Response.json([storedProviderSession]);
      }
      return Response.json(storedProviderSession ? [storedProviderSession] : []);
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
      const toolName = rpc?.params?.name;
      if (toolName === 'get_task_status') {
        const resPayload = pollMode === 'cancelled'
          ? { status: 'cancelled', message: 'Cancelled upstream' }
          : { status: 'action_required', task_id: 'dance:M0015', progress: 90 };
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(resPayload) }] } });
      }
      if (toolName === 'get_task_result') {
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'cancelled', failure: { stage: 'queue' } }) }] } });
      }
      if (toolName === 'send_video_agent_message') {
        nudges.push(rpc.params.arguments);
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } });
      }
    }
    return realFetch(input, init);
  };

  try {
    // Seed valid sealed freebeat_provider_sessions via OAuth start/callback
    const startRes = await worker.fetch(apiRequest('/api/freebeat/start', { method: 'POST', token: 'admin-jwt' }), env);
    assert.equal(startRes.status, 200);
    const pendingCookie = startRes.headers.get('set-cookie').split(';')[0];
    const state = new URL((await startRes.json()).url).searchParams.get('state');
    const cbRes = await worker.fetch(
      new Request(`${BASE}/api/freebeat/callback?code=code&state=${state}`, { method: 'GET', headers: { cookie: pendingCookie } }),
      env,
    );
    assert.equal(cbRes.status, 303);

    const row = {
      id: VID_ID,
      provider: 'freebeat',
      status: 'in_progress',
      progress: 90,
      external_job_id: 'dance:M0015',
      metadata: {
        auto_nudged: true,
        auto_nudge_count: 1,
        last_nudge_at: Date.now() - 45_000,
      },
    };
    // 45s elapsed since 1st nudge -> sends 2nd nudge
    const res1 = await consumerDanceStatus(env, row);
    assert.equal(nudges.length, 1);
    assert.equal(res1.metadata.auto_nudge_count, 2);
    assert.equal(res1.metadata.agent_status, 'action_required');
    assert.equal(res1.nextStatus, 'in_progress');

    // Immediate poll within 30s cooldown -> skips nudge
    const res2 = await consumerDanceStatus(env, { ...row, metadata: res1.metadata });
    assert.equal(nudges.length, 1);
    assert.equal(res2.metadata.auto_nudge_count, 2);

    // Upstream cancelled -> propagates cancelled immediately
    pollMode = 'cancelled';
    const res3 = await consumerDanceStatus(env, row);
    assert.equal(res3.nextStatus, 'cancelled');
    assert.equal(res3.metadata.agent_status, 'cancelled');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('LiveQueuePage renders user privacy message for regular users and admin mode badge for admins', async () => {
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [
        {
          find: /^react-router-dom$/,
          replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname,
        },
      ],
    },
  });
  try {
    const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
    const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
    const { LiveQueuePage } = await vite.ssrLoadModule('/src/auth/LiveQueuePage.jsx');

    const userSession = {
      access_token: 'user-token',
      user: { id: USER_ID, email: 'creator@example.com', user_metadata: {}, app_metadata: {} },
    };
    const adminSession = {
      access_token: 'admin-token',
      user: { id: ADMIN_ID, email: 'admin@example.com', user_metadata: {}, app_metadata: { role: 'admin' } },
    };

    const userHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/live'] },
        React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(LiveQueuePage)),
      ),
    );
    assert.ok(userHtml.includes('Proses Live'));
    assert.ok(userHtml.includes('Live Queue'));
    assert.ok(userHtml.includes('pengguna lain disamarkan'));
    assert.equal(userHtml.includes('Mode Admin'), false);

    const adminHtml = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/live'] },
        React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(LiveQueuePage)),
      ),
    );
    assert.ok(adminHtml.includes('Mode Admin'));
    assert.ok(adminHtml.includes('Pembatalan &amp; Refund Aktif'));
  } finally {
    await vite.close();
  }
});
