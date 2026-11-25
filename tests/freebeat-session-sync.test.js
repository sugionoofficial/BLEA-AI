import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const base = 'https://blea-ai.blea-ai.workers.dev';
const accountId = '11111111-1111-4111-8111-111111111111';
const env = {
  SUPABASE_URL: 'https://supabase.example', SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'test-only-service-key',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
};
const encoder = new TextEncoder();
async function sealSession(session) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`blea-freebeat-mcp-v1:${env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY}`));
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('session') }, key, encoder.encode(JSON.stringify(session)));
  return `${Buffer.from(iv).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
}

async function harness({ eager = false, rotate = true, rejectedStatus = 401, wrongOwner = false, missingAccount = false, rejectFresh = false, rejectTool = false, expiredFresh = false } = {}) {
  const originalFetch = globalThis.fetch;
  const old = { uid: 'admin-1', sid: 'same-grant', accountId, accessToken: 'OLD-PRIVATE-TOKEN', clientId: 'client', imageAccess: true, issuedAt: Date.now(), expiresAt: Date.now() + 600000 };
  const fresh = { ...old, accessToken: 'NEW-PRIVATE-TOKEN', ...(wrongOwner ? { uid: 'other-admin' } : {}), ...(expiredFresh ? { expiresAt: Date.now() - 1 } : {}) };
  const sealedOld = await sealSession(old), sealedFresh = await sealSession(fresh);
  let current = eager ? sealedFresh : sealedOld;
  let removed = false;
  const inits = [], calls = [];
  let legacyReads = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (url.pathname === '/rest/v1/freebeat_oauth_accounts') return Response.json(removed ? [] : [{ id: accountId, sealed_session: current }]);
    if (url.pathname === '/rest/v1/freebeat_provider_sessions') { legacyReads += 1; return Response.json([{ sealed_session: sealedFresh }]); }
    if (url.hostname === 'supabase.example') return Response.json([]);
    if (url.href === 'https://freebeat.ai/api/mcp') {
      const body = JSON.parse(init.body);
      const token = init.headers.authorization;
      if (body.method === 'initialize') {
        inits.push(token);
        if (token === 'Bearer OLD-PRIVATE-TOKEN') {
          if (rotate) current = sealedFresh;
          if (missingAccount) removed = true;
          if (rejectedStatus === 'network') throw new TypeError('private-network-detail');
          return new Response('private-provider-body', { status: rejectedStatus });
        }
        if (rejectFresh) return new Response(null, { status: 403 });
        return Response.json({ id: body.id, result: { protocolVersion: '2025-03-26' } });
      }
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'tools/list') return Response.json({ id: body.id, result: { tools: [
        { name: 'generate_lip_sync_video', inputSchema: { properties: {} } },
        { name: 'generate_singing_video', inputSchema: { properties: {} } },
      ] } });
      calls.push({ name: body.params.name, token });
      if (rejectTool) return new Response(null, { status: 401 });
      assert.ok(['quote_generation', 'get_credit_balance', 'get_model_help'].includes(body.params.name), 'must never generate or upload');
      return Response.json({ id: body.id, result: { structuredContent: body.params.name === 'quote_generation' ? { status: 'quoted', credits: 100 } : { credits: 500 } } });
    }
    throw new Error(`Unexpected host: ${url.hostname}`);
  };
  return {
    inits, calls, legacyReads: () => legacyReads,
    request: (action) => worker.fetch(new Request(`${base}/api/freebeat/${action}`, {
      method: 'POST', headers: { authorization: 'Bearer admin-jwt', cookie: `__Host-blea_freebeat_session=${sealedOld}`, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify(action === 'vocal-quote' ? { tool: 'generate_lip_sync_video', video_url: 'https://cdn.example/source.mp4', video_duration_ms: 15000, music_id: 123 } : action === 'image-upload-quote' ? { image_url: 'https://cdn.example/source.png' } : action === 'video-model-help' ? { model_id: 106 } : action === 'video-model-quote' ? { model_id: 106, input_mode: 'keyframe', images: ['https://cdn.example/source.png'], prompt: 'A quiet scene', duration: 10, resolution: '768p', aspect_ratio: '16:9' } : {}),
    }), env),
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

test('admin balance and vocal quote adopt stored rotated tokens even with identical expiry', async () => {
  for (const action of ['balance', 'vocal-quote']) {
    const h = await harness({ eager: true });
    try {
      const res = await h.request(action);
      assert.equal(res.status, 200, await res.clone().text());
      assert.match(res.headers.get('set-cookie'), /HttpOnly/);
      assert.deepEqual(h.inits, ['Bearer NEW-PRIVATE-TOKEN']);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].token, 'Bearer NEW-PRIVATE-TOKEN');
      assert.doesNotMatch(await res.text(), /PRIVATE-TOKEN/);
    } finally { h.restore(); }
  }
});

test('a concurrent rotation is recovered once at initialize, never by replaying a tool call', async () => {
  for (const action of ['balance', 'vocal-quote']) for (const rejectedStatus of [401, 403]) {
    const h = await harness({ rejectedStatus });
    try {
      const res = await h.request(action);
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(h.inits, ['Bearer OLD-PRIVATE-TOKEN', 'Bearer NEW-PRIVATE-TOKEN']);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].token, 'Bearer NEW-PRIVATE-TOKEN');
      assert.equal(h.legacyReads(), 0);
    } finally { h.restore(); }
  }
});

test('no retry without a newer token or for non-auth failures; never adopt another owner/account', async () => {
  for (const options of [
    { rotate: false }, { rejectedStatus: 'network' }, { rejectedStatus: 402 }, { rejectedStatus: 500 },
    { wrongOwner: true }, { missingAccount: true }, { expiredFresh: true },
  ]) {
    const h = await harness(options);
    try {
      const res = await h.request('vocal-quote');
      assert.equal(res.status, (options.rejectedStatus ?? 401) === 401 ? 401 : 502);
      assert.equal(h.inits.length, 1);
      assert.equal(h.calls.length, 0);
      assert.equal(h.legacyReads(), 0);
      assert.doesNotMatch(await res.text(), /PRIVATE-TOKEN|private-provider-body|private-network-detail/);
    } finally { h.restore(); }
  }
});


test('recovery is bounded and a rejected tool call is never replayed', async () => {
  const bounded = await harness({ rejectFresh: true });
  try {
    const res = await bounded.request('vocal-quote');
    assert.equal(res.status, 502);
    assert.equal(bounded.inits.length, 2);
    assert.equal(bounded.calls.length, 0);
  } finally { bounded.restore(); }
  for (const action of ['balance', 'vocal-quote']) {
    const h = await harness({ eager: true, rejectTool: true });
    try {
      const res = await h.request(action);
      assert.equal(res.status, 401);
      assert.equal(h.inits.length, 1);
      assert.equal(h.calls.length, 1);
    } finally { h.restore(); }
  }
});


test('video model help and quote recover the handshake once and reuse that MCP session', async () => {
  for (const action of ['video-model-help', 'video-model-quote']) {
    const h = await harness();
    try {
      const res = await h.request(action);
      assert.equal(res.status, 200, await res.clone().text());
      assert.deepEqual(h.inits, ['Bearer OLD-PRIVATE-TOKEN', 'Bearer NEW-PRIVATE-TOKEN']);
      assert.deepEqual(h.calls.map((call) => call.name), action === 'video-model-help' ? ['get_model_help'] : ['get_model_help', 'quote_generation']);
      assert.ok(h.calls.every((call) => call.token === 'Bearer NEW-PRIVATE-TOKEN'));
      assert.equal(h.legacyReads(), 0);
    } finally { h.restore(); }
  }
});


test('image upload quote recovers only its handshake and never replays the quote tool', async () => {
  const h = await harness();
  try {
    const res = await h.request('image-upload-quote');
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(h.inits, ['Bearer OLD-PRIVATE-TOKEN', 'Bearer NEW-PRIVATE-TOKEN']);
    assert.deepEqual(h.calls, [{ name: 'quote_generation', token: 'Bearer NEW-PRIVATE-TOKEN' }]);
  } finally { h.restore(); }
  const rejected = await harness({ eager: true, rejectTool: true });
  try {
    assert.equal((await rejected.request('image-upload-quote')).status, 401);
    assert.equal(rejected.calls.length, 1);
    assert.equal(rejected.inits.length, 1);
  } finally { rejected.restore(); }
});
