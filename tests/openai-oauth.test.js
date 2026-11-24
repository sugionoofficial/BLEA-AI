import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  buildResponsesBody,
  extractResponsesText,
  extractResponsesToolCalls,
  isSubscriptionLimitError,
  parseResponsesEvent,
  planModelFromCatalog,
  planUsageFailure,
  responsesToChatCompletion,
} from '../src/lib/openaiResponses.js';
import {
  completeOAuthAttempt,
  createOAuthAttempt,
  decodeJwtPayload,
  disconnectOAuthLink,
  OPENAI_DYNAMIC_CLIENT_ID,
  OPENAI_LOOPBACK_PATH,
  OPENAI_SCOPES,
} from '../src/lib/openaiOAuth.js';
import { sendOAuthResponses, pickOpenAiAccountsFor } from '../src/lib/openaiPool.js';
import { parseCallbackInput } from '../src/studio/oauthCallbackUrl.js';
import { listOAuthLinks, retainedClientId } from '../src/lib/openaiOAuth.js';
import { sealOpenAiToken } from '../src/lib/openaiPool.js';

const ENC_KEY = 'test-encryption-key-for-oauth-suite-32b';

function createEnv(extra = {}) {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    PROVIDER_CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ...extra,
  };
}

function apiRequest(path, { method = 'GET', body, token = 'user-jwt' } = {}) {
  return new Request(`https://app.example/api${path}`, {
    method,
    headers: {
      origin: 'https://app.example',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

// SSE sintetis berbentuk event Responses API.
function sseStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

test('buildResponsesBody memindahkan system ke instructions dan membuang field terlarang', () => {
  const body = buildResponsesBody({
    model: 'gpt-5.1',
    temperature: 0.3,
    top_p: 0.9,
    max_output_tokens: 512,
    metadata: { a: 1 },
    user: 'u1',
    messages: [
      { role: 'system', content: 'Kamu BLEA.' },
      { role: 'user', content: 'Halo' },
      { role: 'assistant', content: 'Hai' },
      { role: 'user', content: [{ type: 'text', text: 'Lihat ini' }, { type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] },
    ],
  }, { model: 'gpt-5.1' });

  assert.equal(body.model, 'gpt-5.1');
  assert.equal(body.store, false, 'store:false wajib di jalur paket OpenAI');
  assert.equal(body.stream, true, 'stream:true wajib di jalur paket OpenAI');
  assert.equal(body.instructions, 'Kamu BLEA.');
  assert.equal(body.temperature, undefined);
  assert.equal(body.top_p, undefined);
  assert.equal(body.max_output_tokens, undefined);
  assert.equal(body.metadata, undefined);
  assert.equal(body.user, undefined);
  assert.equal(body.input.length, 3, 'item system tidak boleh jadi pesan input');
  assert.deepEqual(body.input[2].content[1], { type: 'input_image', image_url: 'https://x.test/a.png' });
});

test('parseResponsesEvent menerjemahkan delta teks, penalaran, dan kegagalan', () => {
  assert.deepEqual(parseResponsesEvent({ type: 'response.output_text.delta', delta: 'Hi' }).events, [{ type: 'delta', text: 'Hi' }]);
  assert.deepEqual(
    parseResponsesEvent({ type: 'response.reasoning_summary_text.delta', delta: 'berpikir' }).events,
    [{ type: 'thinking', text: 'berpikir' }],
  );
  const failed = parseResponsesEvent({
    type: 'response.failed',
    response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'habis' } },
  });
  assert.equal(failed.done, true);
  assert.equal(failed.failed.code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal(isSubscriptionLimitError(failed.failed.code, ''), true);
  assert.equal(parseResponsesEvent({ type: 'response.completed', response: { id: 'r1' } }).done, true);
});

test('responsesToChatCompletion mengubah output Responses menjadi bentuk chat', () => {
  const response = {
    id: 'resp_1',
    model: 'gpt-5.1',
    output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Halo!' }] },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{"query":"blea"}' },
    ],
  };
  assert.equal(extractResponsesText(response), 'Halo!');
  assert.equal(extractResponsesToolCalls(response).length, 1);
  const chat = responsesToChatCompletion(response, 'gpt-5.1');
  assert.equal(chat.choices[0].message.content, 'Halo!');
  assert.equal(chat.choices[0].message.tool_calls[0].function.name, 'web_search');
  assert.equal(chat.choices[0].finish_reason, 'tool_calls');
});

test('sendOAuthResponses mengumpulkan stream Responses menjadi balasan utuh', async () => {
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.match(init.headers.authorization, /^Bearer oauth-access$/);
    sentBody = JSON.parse(init.body);
    return new Response(sseStream([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.reasoning_summary_text.delta', delta: 'mikir ' },
      { type: 'response.output_text.delta', delta: 'Halo ' },
      { type: 'response.output_text.delta', delta: 'dunia' },
      { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.1', output: [] } },
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await sendOAuthResponses({
      accessToken: 'oauth-access',
      model: 'gpt-5.1',
      payload: { messages: [{ role: 'user', content: 'Halo' }] },
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.choices[0].message.content, 'Halo dunia');
    assert.equal(result.data.blea_reasoning, 'mikir ');
    assert.equal(sentBody.store, false);
    assert.equal(sentBody.stream, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('sendOAuthResponses memetakan batas paket jadi 429', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseStream([
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable', message: 'paket tidak tersedia' } } },
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await sendOAuthResponses({ accessToken: 't', model: 'gpt-5.1', payload: { messages: [{ role: 'user', content: 'x' }] } });
    assert.equal(result.ok, false);
    assert.equal(result.status, 429, 'batas paket harus dianggap akun tidak siap, bukan galat permanen');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('state OAuth disimpan di server; redirect non-loopback ditolak', async () => {
  const realFetch = globalThis.fetch;
  const inserted = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith('/rest/v1/openai_oauth_links')) {
      inserted.push(JSON.parse(init.body));
      return Response.json([{ id: '11111111-1111-1111-1111-111111111111', ...JSON.parse(init.body) }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const user = { id: 'user-1' };
    await assert.rejects(
      createOAuthAttempt(createEnv(), user, {
        state: 'a'.repeat(24),
        nonce: 'b'.repeat(24),
        code_verifier: 'c'.repeat(64),
        redirect_uri: 'https://blea.ai/auth/callback',
      }),
      /127\.0\.0\.1/,
    );
    const created = await createOAuthAttempt(createEnv(), user, {
      state: 'a'.repeat(24),
      nonce: 'b'.repeat(24),
      code_verifier: 'c'.repeat(64),
      redirect_uri: `http://127.0.0.1:1455${OPENAI_LOOPBACK_PATH}`,
    });
    assert.equal(created.state, 'a'.repeat(24));
    assert.equal(inserted[0].redirect_uri, 'http://127.0.0.1:1455/auth/callback');
    assert.equal(inserted[0].status, 'pending');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('completeOAuthAttempt menukar kode dan mendaftarkan akun oauth ke pool', async () => {
  const realFetch = globalThis.fetch;
  const calls = { token: null, accountInsert: null, linkPatch: null };
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'me@example.com', sub: 'sub-1' })).toString('base64url')}.y`;
  globalThis.fetch = async (url, init = {}) => {
    // PATCH ke baris tunggal harus dicek lebih dulu: URL-nya juga berawalan
    // `openai_oauth_links?`, jadi urutan pencocokan menentukan hasil.
    if (url.includes('/rest/v1/openai_oauth_links?id=eq.')) {
      if ((init.method || 'GET') === 'PATCH') calls.linkPatch = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://supabase.example/rest/v1/openai_oauth_links?')) {
      return Response.json([{
        id: '11111111-1111-1111-1111-111111111111',
        status: 'pending',
        state: 'a'.repeat(24),
        nonce: 'b'.repeat(24),
        code_verifier: 'c'.repeat(64),
        redirect_uri: 'http://127.0.0.1:1455/auth/callback',
        requested_client_id: null,
      }]);
    }
    if (url.endsWith('https://auth.openai.com/api/accounts/oauth/token')) {
      calls.token = Object.fromEntries(new URLSearchParams(init.body));
      return Response.json({
        access_token: 'oa-access',
        refresh_token: 'oa-refresh',
        id_token: idToken,
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    }
    if (url.endsWith('/rest/v1/openai_accounts?select=*&order=priority.asc,created_at.asc&limit=200')) {
      return Response.json([]);
    }
    if (url.endsWith('/rest/v1/openai_accounts')) {
      calls.accountInsert = JSON.parse(init.body);
      return Response.json([{ id: '22222222-2222-2222-2222-222222222222', ...calls.accountInsert }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
      attempt_id: '11111111-1111-1111-1111-111111111111',
      state: 'a'.repeat(24),
      code: 'auth-code',
      client_id: 'oaiapp_test',
    });
    assert.equal(calls.token.grant_type, 'authorization_code');
    assert.equal(calls.token.code_verifier, 'c'.repeat(64), 'PKCE verifier ikut dikirim');
    assert.equal(calls.token.resource, 'https://api.openai.com/v1');
    assert.equal(result.link.plan_usage, true);
    assert.equal(result.link.email, 'me@example.com');
    assert.equal(calls.linkPatch.status, 'linked');
    assert.equal(calls.accountInsert.credential_kind, 'oauth');
    assert.deepEqual(calls.accountInsert.capabilities, ['chat', 'agent'], 'token OAuth tidak dipakai tool media');
    assert.equal(calls.accountInsert.oauth_client_id, 'oaiapp_test');
    assert.ok(calls.accountInsert.sealed_token && calls.accountInsert.sealed_token !== 'oa-access', 'token harus tersegel');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('completeOAuthAttempt menolak callback tanpa client_id terbitan', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.startsWith('https://supabase.example/rest/v1/openai_oauth_links?')) {
      return Response.json([{
        id: '11111111-1111-1111-1111-111111111111',
        status: 'pending',
        code_verifier: 'c'.repeat(64),
        redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: '11111111-1111-1111-1111-111111111111',
        code: 'auth-code',
        client_id: OPENAI_DYNAMIC_CLIENT_ID,
      }),
      /client_id terbitan/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('disconnectOAuthLink mencabut refresh token lalu menghapus baris', async () => {
  const realFetch = globalThis.fetch;
  const env = createEnv();
  const sealedRefresh = await sealOpenAiToken(env, 'oa-refresh');
  const seen = { revoke: null, deleted: false };
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes('/rest/v1/openai_oauth_links?id=eq.')) {
      if ((init.method || 'GET') === 'DELETE') seen.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://supabase.example/rest/v1/openai_oauth_links?')) {
      return Response.json([{
        id: '11111111-1111-1111-1111-111111111111',
        issued_client_id: 'oaiapp_test',
        sealed_refresh_token: sealedRefresh,
      }]);
    }
    if (url.endsWith('https://auth.openai.com/api/accounts/oauth/revoke')) {
      seen.revoke = Object.fromEntries(new URLSearchParams(init.body));
      return new Response('', { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await disconnectOAuthLink(env, { id: 'user-1' }, '11111111-1111-1111-1111-111111111111');
    assert.equal(seen.revoke.token, 'oa-refresh');
    assert.equal(seen.revoke.token_type_hint, 'refresh_token');
    assert.equal(seen.revoke.client_id, 'oaiapp_test');
    assert.equal(seen.deleted, true);
    assert.equal(result.revoked, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('akun oauth dipakai pool dan token kedaluwarsa di-refresh lebih dulu', async () => {
  const realFetch = globalThis.fetch;
  const env = createEnv();
  const sealedAccess = await sealOpenAiToken(env, 'stale-access');
  const sealedRefresh = await sealOpenAiToken(env, 'oa-refresh');
  const seen = { refresh: null, patched: null };
  globalThis.fetch = async (url, init = {}) => {
    if (url.includes('/rest/v1/openai_accounts?id=eq.')) {
      if ((init.method || 'GET') === 'PATCH') seen.patched = JSON.parse(init.body);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://supabase.example/rest/v1/openai_accounts?')) {
      return Response.json([{
        id: '22222222-2222-2222-2222-222222222222',
        account_label: 'OAuth',
        credential_kind: 'oauth',
        enabled: true,
        priority: 1,
        capabilities: ['chat'],
        daily_limit: 0,
        used_today: 0,
        quota_date: null,
        cooldown_until: null,
        sealed_token: sealedAccess,
        oauth_client_id: 'oaiapp_test',
        oauth_refresh_sealed: sealedRefresh,
        oauth_expires_at: new Date(Date.now() - 60_000).toISOString(),
      }]);
    }
    if (url.endsWith('https://auth.openai.com/api/accounts/oauth/token')) {
      seen.refresh = Object.fromEntries(new URLSearchParams(init.body));
      return Response.json({ access_token: 'fresh-access', refresh_token: 'rotated', expires_in: 3600 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const accounts = await pickOpenAiAccountsFor(env, { capability: 'chat', limit: 1 });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].oauth, true, 'akun OAuth harus ditandai supaya dipanggil lewat Responses API');
    assert.equal(accounts[0].apiKey, 'fresh-access', 'access token baru dipakai setelah refresh');
    assert.equal(seen.refresh.grant_type, 'refresh_token');
    assert.equal(seen.patched.oauth_expires_at !== undefined, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/openai-oauth butuh login dan mengembalikan konfigurasi resmi', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1', email: 'a@b.c' });
    if (url.endsWith('/rest/v1/profiles?select=status&limit=1')) return Response.json([{ status: 'active' }]);
    if (url.includes('/rest/v1/openai_oauth_links?')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const unauthorized = await worker.fetch(apiRequest('/openai-oauth', { token: '' }), createEnv());
    assert.equal(unauthorized.status, 401);

    const res = await worker.fetch(apiRequest('/openai-oauth'), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.config.resource, 'https://api.openai.com/v1');
    assert.equal(data.config.callback_path, '/auth/callback');
    assert.equal(data.config.client_id_first_time, OPENAI_DYNAMIC_CLIENT_ID);
    assert.equal(data.config.scopes, OPENAI_SCOPES);
    assert.deepEqual(data.links, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('decodeJwtPayload hanya membaca klaim, bukan memverifikasi', () => {
  const payload = { email: 'me@example.com', sub: 'abc' };
  const jwt = `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  assert.deepEqual(decodeJwtPayload(jwt), payload);
  assert.equal(decodeJwtPayload('bukan-jwt'), null);
});

// ---- Regresi dua bug nyata dari percobaan login pertama ---------------------
// 1. URL callback yang ditempel dari chat/HTML berisi `&amp;`, sehingga
//    `state` dan `client_id` terbaca null dan login berhenti dengan pesan
//    "state tidak cocok" yang menyesatkan.
test('parseCallbackInput menormalkan &amp; dan URL ter-encode', () => {
  const dirty = 'http://127.0.0.1:1455/auth/callback?code=ac.1.AACBHIQ&amp;scope=chatgpt.tokens.use.direct+openid&amp;state=gA9JD-UGGcJF40ZriI4PW5PYY_kf6A&amp;client_id=oaiapp_VnTWNNu';
  const clean = parseCallbackInput(dirty);
  const params = new URLSearchParams(clean.slice(1));
  assert.equal(params.get('code'), 'ac.1.AACBHIQ');
  assert.equal(params.get('state'), 'gA9JD-UGGcJF40ZriI4PW5PYY_kf6A');
  assert.equal(params.get('client_id'), 'oaiapp_VnTWNNu');
  assert.equal(params.get('scope'), 'chatgpt.tokens.use.direct openid');

  const encoded = parseCallbackInput('http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback%3Fcode%3Dac.1.X%26state%3Ds1%26client_id%3Doaiapp_A');
  assert.equal(new URLSearchParams(encoded.slice(1)).get('state'), 's1');

  assert.ok(parseCallbackInput('?code=ac.1.X&state=s1'));
  assert.equal(parseCallbackInput('halo dunia'), null);
  assert.equal(parseCallbackInput(''), null);
});

// 2. Percobaan `pending` yang lewat 30 menit tidak bisa diselesaikan lagi,
//    tetapi UI terus menampilkan "menunggu persetujuan". Sekarang ditandai
//    kedaluwarsa supaya pengguna tahu harus mengulang login.
test('listOAuthLinks menandai percobaan pending yang kedaluwarsa', async () => {
  const realFetch = globalThis.fetch;
  const old = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  globalThis.fetch = async (url) => {
    if (url.includes('/rest/v1/openai_oauth_links?')) {
      return Response.json([
        { id: 'a', status: 'pending', created_at: old },
        { id: 'b', status: 'pending', created_at: new Date().toISOString() },
        { id: 'c', status: 'linked', created_at: old },
      ]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const links = await listOAuthLinks(createEnv(), { id: 'user-1' });
    assert.equal(links[0].status, 'expired');
    assert.equal(links[0].stale, true);
    assert.equal(links[1].status, 'pending');
    assert.equal(links[2].status, 'linked', 'tautan yang sudah tersambung tidak ikut kedaluwarsa');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('completeOAuthAttempt bisa dipanggil dengan state saja (tanpa attempt_id)', async () => {
  const realFetch = globalThis.fetch;
  const calls = { token: null };
  const idToken = `x.${Buffer.from(JSON.stringify({ email: 'me@example.com', sub: 's1' })).toString('base64url')}.y`;
  globalThis.fetch = async (url, init = {}) => {
    // Pencarian baris lewat state (callback dari domain lain).
    if (url.includes('/rest/v1/openai_oauth_links?select=id,status,created_at')) {
      return Response.json([{ id: '11111111-1111-1111-1111-111111111111', status: 'pending', created_at: new Date().toISOString() }]);
    }
    if (url.includes('/rest/v1/openai_oauth_links?id=eq.')) {
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('https://supabase.example/rest/v1/openai_oauth_links?')) {
      return Response.json([{
        id: '11111111-1111-1111-1111-111111111111',
        status: 'pending',
        code_verifier: 'c'.repeat(64),
        redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      }]);
    }
    if (url.endsWith('https://auth.openai.com/api/accounts/oauth/token')) {
      calls.token = Object.fromEntries(new URLSearchParams(init.body));
      return Response.json({
        access_token: 'oauth-access-token',
        refresh_token: 'oauth-refresh-token',
        id_token: idToken,
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    }
    if (url.endsWith('/rest/v1/openai_accounts?select=*&order=priority.asc,created_at.asc&limit=200')) {
      return Response.json([]);
    }
    if (url.endsWith('/rest/v1/openai_accounts')) {
      return Response.json([{ id: '22222222-2222-2222-2222-222222222222', ...JSON.parse(init.body) }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
      state: 'gA9JD-UGGcJF40ZriI4PW5PYY_kf6A',
      code: 'ac.1.AACBHIQ',
      client_id: 'oaiapp_VnTWNNu',
    });
    assert.equal(calls.token.code_verifier, 'c'.repeat(64), 'PKCE verifier diambil dari baris server');
    assert.equal(result.link.plan_usage, true);
    assert.equal(result.account.credential_kind, 'oauth');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('completeOAuthAttempt menolak state yang tidak dikenal', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/rest/v1/openai_oauth_links?select=id,status,created_at')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, { state: 'tidak-ada', code: 'x', client_id: 'oaiapp_x' }),
      /tidak ditemukan atau sudah dipakai/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// 3. Callback bisa mendarat di origin yang tidak punya sesi login BLEA
//    (127.0.0.1:1455). Worker menolak 401, dan UI harus menjelaskan bahwa
//    penyelesaiannya dilakukan di halaman BLEA yang sudah login.
test('/api/openai-oauth/complete menolak 401 tanpa sesi BLEA', async () => {
  const res = await worker.fetch(
    apiRequest('/openai-oauth/complete', {
      method: 'POST',
      body: { state: 'VwqxTXi69L78pLlRyBJHeYPNmmsqlnQwbtXq1_iMzkA', code: 'ac.1.x', client_id: 'oaiapp_x' },
      token: '',
    }),
    createEnv(),
  );
  assert.equal(res.status, 401);
  const body = await res.json();
  // Pesan lama "Login diperlukan." dibaca pengguna sebagai *OpenAI* menolak.
  // 401 di sini selalu soal sesi BLEA, jadi kalimatnya harus menyebut itu.
  assert.equal(body.code, 'auth_required');
  assert.match(body.error, /token sesi BLEA/i);
  assert.match(body.error, /belum menyentuh OpenAI|belum login/i);
});

// Token ADA tetapi ditolak Supabase (kedaluwarsa/di-revoke) adalah keadaan
// berbeda dari "tidak ada token": yang pertama butuh masuk ulang, yang kedua
// halaman memang belum login. Pesannya tidak boleh menyamakan keduanya.
test('/api/openai-oauth menolak token yang dikirim tetapi tidak diterima', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v1/user')) {
      return new Response(JSON.stringify({ message: 'invalid JWT' }), { status: 401, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  let body;
  let status;
  try {
    const res = await worker.fetch(apiRequest('/openai-oauth', { token: 'jwt-kedaluwarsa' }), createEnv());
    status = res.status;
    body = await res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(status, 401);
  assert.equal(body.code, 'auth_required');
  assert.match(body.error, /Sesi BLEA tidak diterima/i);
  // Harus jelas bahwa OpenAI belum dilibatkan sama sekali.
  assert.match(body.error, /belum menyentuh OpenAI/);
});

// Regresi penempatan JSX: blok "Sudah menyetujui di OpenAI?" dulu tidak
// sengaja tersisip di cabang `if (callbackPage)`, sehingga kolomnya hanya
// muncul di halaman 127.0.0.1 — bukan di halaman Akun OpenAI tempat pengguna
// mencarinya. Tes ini merender halaman yang sebenarnya.
test('kolom tempel URL callback muncul di halaman Akun OpenAI', async () => {
  const { createServer } = await import('vite');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
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
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });
  try {
    const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
    const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
    const { OpenAiAccountsPage } = await vite.ssrLoadModule('/src/studio/OpenAiAccountsPage.jsx');
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(AuthProvider, { initialSession: null }, React.createElement(OpenAiAccountsPage))),
    );
    assert.ok(html.includes('Sudah menyetujui di OpenAI?'), 'judul kolom harus ada di halaman Akun OpenAI');
    assert.ok(html.includes('aria-label="URL callback OpenAI"'), 'input URL harus dirender');
    assert.ok(html.includes('Connect OpenAI'), 'tombol mulai login tetap ada');
    // `invalid_state` terjadi sebelum callback kita, jadi satu-satunya bantuan
    // yang bisa diberikan adalah diagnosa + redirect_uri yang benar-benar
    // dipakai. Keduanya harus tampil di halaman Akun OpenAI.
    assert.ok(html.includes('Ada kode error di halaman OpenAI?'), 'blok diagnosa error harus dirender');
    assert.ok(html.includes('http://127.0.0.1:'), 'redirect_uri yang dipakai harus terlihat');
  } finally {
    await vite.close();
  }
});

// ---- invalid_grant ---------------------------------------------------------
// OpenAI hanya menjawab {"error":"invalid_grant"} tanpa error_description, jadi
// penyebabnya harus dicegah dan dijejaki di sisi kita.
function oauthEnvWith({ attempt, tokenResponses = [] } = {}) {
  const state = { tokenCalls: [], patches: [], claims: 0, claimBody: null };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (url.includes('/rest/v1/openai_oauth_links?select=*')) return Response.json([attempt]);
    // Klaim penukaran sekali-pakai.
    if (url.includes('/rest/v1/openai_oauth_links?id=eq.') && method === 'PATCH' && url.includes('exchanged_code_fingerprint=is.null')) {
      state.claims += 1;
      state.claimBody = JSON.parse(init.body || '{}');
      return Response.json(state.claims > 1 ? [] : [{ id: attempt.id }]);
    }
    if (url.includes('/rest/v1/openai_oauth_links?id=eq.') && method === 'PATCH') {
      state.patches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/api/accounts/oauth/token')) {
      state.tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
      const next = tokenResponses.shift();
      return new Response(JSON.stringify(next.body), { status: next.status });
    }
    if (url.includes('/rest/v1/openai_accounts')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { state, restore: () => { globalThis.fetch = realFetch; } };
}

const baseAttempt = (overrides = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  status: 'pending',
  state: 'S'.repeat(32),
  code_verifier: 'V'.repeat(86),
  redirect_uri: 'http://127.0.0.1:1455/auth/callback',
  exchanged_code_fingerprint: null,
  ...overrides,
});

// Kode otorisasi hanya sah SEKALI, jadi percobaan ulang tanpa `resource` dulu
// tidak berguna: permintaan kedua untuk kode yang sama hampir pasti ditolak dan
// justru mengaburkan penyebab. Dokumen OpenAI juga meminta parameter yang SAMA
// saat authorize dan saat tukar kode.
test('penukaran kode dikirim sekali dengan parameter yang sama seperti authorize', async () => {
  const stub = oauthEnvWith({
    attempt: baseAttempt(),
    tokenResponses: [
      { status: 200, body: { access_token: 'oa-access-xx', refresh_token: 'oa-refresh-xx', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct', id_token: `x.${Buffer.from(JSON.stringify({ email: 'a@b.c' })).toString('base64url')}.y` } },
    ],
  });
  try {
    const result = await completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
      attempt_id: '11111111-1111-1111-1111-111111111111',
      state: 'S'.repeat(32),
      code: 'code-1',
      client_id: 'oaiapp_X',
    });
    assert.equal(stub.state.tokenCalls.length, 1, 'hanya satu permintaan tukar kode');
    assert.equal(stub.state.tokenCalls[0].resource, 'https://api.openai.com/v1');
    assert.equal(stub.state.tokenCalls[0].redirect_uri, 'http://127.0.0.1:1455/auth/callback');
    assert.equal(stub.state.tokenCalls[0].code_verifier, 'V'.repeat(86));
    assert.equal(result.link.plan_usage, true);
  } finally {
    stub.restore();
  }
});

// Pesan invalid_grant harus dibangun dari FAKTA percobaan ini, bukan tiga
// tebakan setara. Bukti yang tersedia sebelum penukaran: `scope` di callback,
// umur percobaan, dan klaim sekali-pakai.
test('invalid_grant: pesan memakai bukti (izin paket, umur, satu kali) + jejak teknis', async () => {
  const attempt = baseAttempt({ created_at: new Date(Date.now() - 71_000).toISOString() });
  const stub = oauthEnvWith({
    attempt,
    tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }],
  });
  let message = '';
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-2', client_id: 'oaiapp_X',
        scope: 'openid chatgpt.tokens.use.direct email offline_access',
      }).catch((error) => { message = String(error?.message || error); throw error; }),
      /invalid_grant\) tanpa menyebut sebab/,
    );
    // Izin paket terbukti dicentang → tidak boleh disarankan mencentangnya lagi.
    assert.match(message, /SUDAH dicentang/);
    assert.match(message, /berumur 7\d\d? detik/);
    assert.match(message, /SEKALI/);
    assert.match(message, /Plus\/Pro/);
    // Percobaan ulang tanpa resource sudah dihapus.
    assert.equal(stub.state.tokenCalls.length, 1);
    // `scope` callback disimpan bersama klaim sekali-pakai: bukti izin paket
    // tercatat SEBELUM penukaran, bukan disimpulkan setelah gagal.
    const claimed = stub.state.claimBody;
    assert.deepEqual(claimed.scopes, ['openid', 'chatgpt.tokens.use.direct', 'email', 'offline_access']);
    const failed = stub.state.patches.find((patch) => patch.status === 'failed');
    assert.ok(failed, 'kegagalan harus dicatat');
    assert.match(failed.error_message, /client=oaiapp_X/);
    assert.match(failed.error_message, /mode=issued/);
    assert.match(failed.error_message, /plan_scope=granted/);
    assert.match(failed.error_message, /age=\d+s/);
    assert.match(failed.error_message, /verify=[0-9a-f]{12}/);
    assert.ok(!failed.error_message.includes('code-2'), 'kode asli tidak boleh disimpan');
  } finally {
    stub.restore();
  }
});

test('invalid_grant tanpa izin paket di callback menyebut izin belum dicentang', async () => {
  const attempt = baseAttempt();
  const stub = oauthEnvWith({ attempt, tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }] });
  let message = '';
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-4', client_id: 'oaiapp_X',
      }).catch((error) => { message = String(error?.message || error); throw error; }),
    );
    assert.match(message, /izin paket TIDAK terlihat di callback/);
  } finally {
    stub.restore();
  }
});

test('kode yang sama tidak bisa ditukar dua kali', async () => {
  const attempt = baseAttempt({ exchanged_code_fingerprint: 'deadbeef1234' });
  const stub = oauthEnvWith({ attempt, tokenResponses: [] });
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-3', client_id: 'oaiapp_X',
      }),
      /sudah dipakai untuk kode lain|sudah pernah ditukar/,
    );
    assert.equal(stub.state.tokenCalls.length, 0, 'tidak boleh memanggil OpenAI');
  } finally {
    stub.restore();
  }
});

test('state yang tidak cocok ditolak sebelum memanggil OpenAI', async () => {
  const attempt = baseAttempt();
  const stub = oauthEnvWith({ attempt, tokenResponses: [] });
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'X'.repeat(32), code: 'code-4', client_id: 'oaiapp_X',
      }),
      /state callback tidak cocok/,
    );
    assert.equal(stub.state.tokenCalls.length, 0);
  } finally {
    stub.restore();
  }
});

// ---- Klien terbitan dipertahankan setelah gagal ---------------------------
// Panduan OpenAI: bila penukaran kode gagal, "discard that code and start a
// fresh authorization with the issued client ID retained". Dulu id terbitan
// dibuang, sehingga setiap percobaan ulang mendaftar lagi sebagai
// dynamic_agent_client dan gagal dengan cara yang sama.
test('issued client_id tetap tersimpan walau penukaran kode gagal', async () => {
  const attempt = baseAttempt();
  const stub = oauthEnvWith({
    attempt,
    tokenResponses: [
      { status: 400, body: { error: 'invalid_grant' } },
      { status: 400, body: { error: 'invalid_grant' } },
    ],
  });
  try {
    await assert.rejects(completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
      attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-9', client_id: 'oaiapp_RETAIN',
    }));
    const failed = stub.state.patches.find((patch) => patch.status === 'failed');
    assert.equal(failed.issued_client_id, 'oaiapp_RETAIN', 'client_id terbitan harus dipertahankan');
  } finally {
    stub.restore();
  }
});

test('retainedClientId mengembalikan id terbitan terakhir, bukan dynamic_agent_client', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/rest/v1/openai_oauth_links?')) {
      return Response.json([{ issued_client_id: 'oaiapp_LAST', account_email: 'me@example.com' }]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const kept = await retainedClientId(createEnv(), { id: 'user-1' });
    assert.equal(kept.client_id, 'oaiapp_LAST');
    assert.equal(kept.email, 'me@example.com');
  } finally {
    globalThis.fetch = realFetch;
  }

  globalThis.fetch = async () => Response.json([{ issued_client_id: 'dynamic_agent_client' }]);
  try {
    assert.equal(await retainedClientId(createEnv(), { id: 'user-1' }), null, 'dynamic_agent_client bukan id terbitan');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Client terbitan harus tetap dipakai pada pengulangan. Dulu `issued_client_id`
// hanya diisi saat GAGAL, sehingga percobaan berikutnya masih terlihat seperti
// pendaftaran pertama (requested_client_id null) dan panel tidak punya id
// terbitan untuk `retained_client`.
test('client terbitan dicatat sejak penukaran kode dimulai', async () => {
  const attempt = baseAttempt({ requested_client_id: null, issued_client_id: null });
  const stub = oauthEnvWith({
    attempt,
    tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }, { status: 400, body: { error: 'invalid_grant' } }],
  });
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-9', client_id: 'oaiapp_KEEP',
      }),
    );
    const recorded = stub.state.patches.find((patch) => patch.requested_client_id === 'oaiapp_KEEP');
    assert.ok(recorded, 'client terbitan harus dicatat di baris percobaan');
    // Jejak kegagalan harus menyebut redirect_uri dan mode, supaya penyebab
    // invalid_grant berikutnya bisa dianalisis (bukan ditebak).
    const failed = stub.state.patches.find((patch) => patch.status === 'failed');
    assert.match(failed.error_message, /mode=issued/);
    assert.match(failed.error_message, /redirect=http:\/\/127\.0\.0\.1:/);
  } finally {
    stub.restore();
  }
});

// `state` adalah parameter wajib di callback (dokumen OpenAI). Alur kita dulu
// menerima callback tanpa `state` (klausa `if (returnedState && …)`), sehingga
// penukaran bisa dikirim tanpa pembanding sama sekali. Ditolak SEBELUM memanggil
// OpenAI, dan tanpa mengklaim kode di baris percobaan.
test('callback tanpa state ditolak sebelum memanggil OpenAI dan tanpa mengklaim kode', async () => {
  const attempt = baseAttempt();
  const stub = oauthEnvWith({ attempt, tokenResponses: [] });
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, code: 'code-x', client_id: 'oaiapp_X',
      }),
      /tidak memuat parameter state/,
    );
    assert.equal(stub.state.tokenCalls.length, 0, 'OpenAI tidak boleh dipanggil');
    assert.equal(stub.state.claims, 0, 'kode tidak boleh diklaim tanpa state');
    assert.ok(!stub.state.patches.some((patch) => patch.status === 'failed'), 'baris tidak boleh ditandai gagal');
  } finally {
    stub.restore();
  }
});

// Dokumen OpenAI: "If the callback supplies a different client ID, reject the
// result rather than replacing the selected account's registration." Dulu
// client dari callback selalu menang, jadi percobaan yang authorize-nya memakai
// client A bisa ditukar dengan client B — jawabannya invalid_grant.
test('callback dengan client_id berbeda ditolak sebelum kode ditukar', async () => {
  const attempt = baseAttempt({ requested_client_id: 'oaiapp_A' });
  const stub = oauthEnvWith({ attempt, tokenResponses: [] });
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-y', client_id: 'oaiapp_B',
      }),
      /client_id oaiapp_B, padahal percobaan ini memakai oaiapp_A/,
    );
    assert.equal(stub.state.tokenCalls.length, 0, 'kode tidak boleh ditukar');
    assert.equal(stub.state.claims, 0, 'kode tidak boleh diklaim');
  } finally {
    stub.restore();
  }
});

// Saat authorize memakai client terbitan, tukar kode WAJIB memakai client yang
// sama. Trace menyimpan keduanya supaya kegagalan bisa dibaca tanpa menebak.
test('client authorize dan client tukar kode tercatat sama', async () => {
  const attempt = baseAttempt({ requested_client_id: 'oaiapp_SAME' });
  const stub = oauthEnvWith({
    attempt,
    tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }],
  });
  try {
    await assert.rejects(
      completeOAuthAttempt(createEnv(), { id: 'user-1' }, {
        attempt_id: attempt.id, state: 'S'.repeat(32), code: 'code-z', client_id: 'oaiapp_SAME',
      }),
    );
    assert.equal(stub.state.tokenCalls[0].client_id, 'oaiapp_SAME');
    const failed = stub.state.patches.find((patch) => patch.status === 'failed');
    assert.match(failed.error_message, /client=oaiapp_SAME authorize_client=oaiapp_SAME/);
  } finally {
    stub.restore();
  }
});

// --- Regresi jalur OAuth (paket akun) --------------------------------------

const PLAN_MODELS = (slugs) => ({ models: slugs.map((slug) => ({ slug, display_name: slug, visibility: 'list' })) });

test('model OAuth dipilih dari katalog akun, bukan ditebak', async () => {
  // Katalog per-akun: `gpt-5.1` tidak ada di akun ini.
  assert.equal(planModelFromCatalog(PLAN_MODELS(['gpt-6.2-sol', 'gpt-6.1-sol']), 'gpt-5.1'), 'gpt-6.2-sol');
  // Model pilihan pengguna dipertahankan bila memang tersedia.
  assert.equal(planModelFromCatalog(PLAN_MODELS(['gpt-5.1', 'gpt-6.2-sol']), 'gpt-5.1'), 'gpt-5.1');
  // `visibility` selain "list" tidak ditawarkan.
  assert.equal(planModelFromCatalog({ models: [{ slug: 'hidden-model', visibility: 'hidden' }, { slug: 'gpt-5.1' }] }, ''), 'gpt-5.1');
  // Katalog tak terbaca: JANGAN menukar pilihan pengguna.
  assert.equal(planModelFromCatalog({ models: [] }, 'gpt-5.1'), 'gpt-5.1');
});

test('model_not_found tidak langsung gagal: katalog akun dibaca lalu dicoba sekali lagi', async () => {
  const realFetch = globalThis.fetch;
  const sentModels = [];
  globalThis.fetch = async (url, init = {}) => {
    if (url.endsWith('/v1/models')) return Response.json(PLAN_MODELS(['gpt-6.2-sol']));
    if (url.endsWith('/v1/responses')) {
      sentModels.push(JSON.parse(init.body).model);
      if (sentModels.length === 1) {
        return new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'The model gpt-5.1 does not exist' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(sseStream([
        { type: 'response.output_text.delta', delta: 'ok' },
        { type: 'response.completed', response: { id: 'r', output: [] } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const result = await sendOAuthResponses({
      accessToken: 'oauth-access',
      model: 'gpt-5.1',
      payload: { messages: [{ role: 'user', content: 'Halo' }] },
    });
    assert.deepEqual(sentModels, ['gpt-5.1', 'gpt-6.2-sol']);
    assert.equal(result.ok, true, 'model yang tidak ada bukan akun rusak');
    assert.equal(result.data.model_used, 'gpt-6.2-sol');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('kode galat paket dibedakan dari billing dan rate limit', () => {
  // `usage_limit` di dalam nama kode membuatnya dulu tertangkap sebagai
  // "kredit habis" — padahal akun OAuth tidak punya saldo sama sekali.
  const limit = planUsageFailure(429, '{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}');
  assert.equal(limit.reason, 'usage_limit');
  assert.equal(limit.status, 429);

  const notEligible = planUsageFailure(403, '{"error":{"code":"subscription_sharing_user_not_eligible"}}');
  assert.equal(notEligible.reason, 'not_eligible');
  // Inti pelajarannya: mengulang OAuth TIDAK menolong, jadi pesannya harus
  // menawarkan jalan lain (API key / akun Plus-Pro).
  assert.match(notEligible.action, /Free\/Go/);
  assert.match(notEligible.action, /TIDAK akan mengubahnya/);
  assert.match(notEligible.action, /API key/);

  assert.equal(planUsageFailure(429, '{"error":{"code":"rate_limit_exceeded"}}'), null);
  assert.equal(planUsageFailure(429, 'You have no credits remaining'), null);
});
