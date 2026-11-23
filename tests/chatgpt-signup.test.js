import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  SIGNUP_REQUEST_URL,
  buildSignupUrl,
  isPlusAddress,
  scoreVerificationMessage,
  signupConfig,
  validateSignupInput,
} from '../src/lib/chatgptSignup.js';

const BASE = 'https://app.example';
const ENV = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
};

function request(path, { method = 'GET', body, token = 'admin-jwt' } = {}) {
  return new Request(`${BASE}/api${path}`, {
    method,
    headers: {
      origin: BASE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('URL daftar memakai login_hint email TempMail dan bukan POST ke chatgpt.com', () => {
  const url = new URL(buildSignupUrl('sugionoofficial88+1@gmail.com', { authSessionLoggingId: '3aa1b9d5-3741-4c50-abb1-498284787a85' }));
  assert.equal(`${url.origin}${url.pathname}`, SIGNUP_REQUEST_URL);
  assert.equal(url.searchParams.get('screen_hint'), 'signup');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('login_hint'), 'sugionoofficial88+1@gmail.com');
  assert.equal(url.searchParams.get('auth_session_logging_id'), '3aa1b9d5-3741-4c50-abb1-498284787a85');
  assert.ok(!/password|token|cookie/i.test(url.toString()));

  const config = signupConfig({});
  // Klaim yang harus jujur: daftar otomatis dari server tidak didukung.
  assert.equal(config.supported.server_side_post, false);
  assert.equal(config.supported.headless_signup, false);
  assert.equal(config.supported.captcha_bypass, false);
  assert.equal(config.supported.capture_session_cookie, false);
  assert.ok(config.why_not_post.length >= 3);
});

test('validasi email pendaftaran menolak alamat rusak dan menandai +tag', () => {
  assert.deepEqual(validateSignupInput({ email: 'A@B.co' }), { email: 'a@b.co', auth_session_logging_id: '', plus_address: false });
  assert.equal(validateSignupInput({ email: 'a+tag@b.co' }).plus_address, true);
  assert.equal(isPlusAddress('a+tag@b.co'), true);
  assert.equal(isPlusAddress('a@b.co'), false);
  assert.throws(() => validateSignupInput({ email: 'bukan-email' }), /tidak valid/i);
  assert.throws(() => validateSignupInput({ email: 'a@b.co', auth_session_logging_id: 'x' }), /UUID/i);
});

test('pencocokan email verifikasi memakai pengirim, kata kunci, penerima, dan waktu', () => {
  const row = { email: 'kotak+1@mail.tm', created_at: '2026-11-23T10:00:00Z' };
  const good = scoreVerificationMessage({
    subject: 'Verify your email for OpenAI',
    from: 'noreply@tm.openai.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-23T10:00:40Z',
  }, row);
  assert.equal(good.matched, true);
  assert.ok(good.score >= 50);
  assert.ok(good.reasons.length >= 2);

  const unrelated = scoreVerificationMessage({
    subject: 'Promo akhir tahun',
    from: 'toko@example.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-23T10:00:40Z',
  }, row);
  assert.equal(unrelated.matched, false);

  // Email lama (sebelum pendaftaran dimulai) tidak boleh dianggap verifikasi.
  const old = scoreVerificationMessage({
    subject: 'ChatGPT verification code',
    from: 'noreply@openai.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-20T10:00:00Z',
  }, row);
  assert.ok(old.reasons.includes('diterima sebelum pendaftaran dimulai'));
});

test('/api/chatgpt-signup hanya untuk admin dan melaporkan bahwa POST server tidak didukung', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    }
    if (target.includes('/rest/v1/chatgpt_signup_attempts')) return Response.json([]);
    if (target.includes('/rest/v1/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm' }]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup'), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.supported.server_side_post, false);
    assert.equal(body.temp_email.email, 'kotak@mail.tm');
    assert.deepEqual(body.attempts, []);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('/api/chatgpt-signup menolak non-admin dan aksi asing', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: 'user-1', app_metadata: { role: 'user' } });
    }
    if (target.includes('/rest/v1/chatgpt_signup_attempts')) return Response.json([]);
    if (target.includes('/rest/v1/tempmail_user_aliases')) return Response.json([]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup'), ENV);
    assert.equal(res.status, 403);

    const bad = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'hack' } }), ENV);
    assert.equal(bad.status, 403);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
