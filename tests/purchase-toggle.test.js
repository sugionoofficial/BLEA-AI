import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Toggle pembelian kredit: khusus admin, wajib password aksi admin, dan
// satu-satunya jalur yang boleh mengubah credit_payment_settings.purchases_enabled.
const ADMIN_ID = '10000000-0000-4000-8000-0000000000a1';
const USER_ID = '10000000-0000-4000-8000-0000000000b1';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(body, token = 'admin-token') {
  return new Request('https://app.example/api/admin/purchase-toggle', {
    method: 'POST',
    headers: { origin: 'https://app.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installMock({ passwordValid = true, settingsRows = [], capture = [] } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (url === 'https://supabase.example/auth/v1/user') {
      const bearer = (init?.headers?.authorization || '').replace('Bearer ', '');
      const admin = bearer === 'admin-token';
      return Response.json({ id: admin ? ADMIN_ID : USER_ID, email: admin ? 'admin@example.com' : 'user@example.com', app_metadata: { role: admin ? 'admin' : 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/verify_admin_action_password')) return Response.json(passwordValid);
    if (url.startsWith('https://supabase.example/rest/v1/credit_payment_settings') && method === 'GET') return Response.json(settingsRows);
    if (url.startsWith('https://supabase.example/rest/v1/credit_payment_settings') && method === 'PATCH') { capture.push({ method, body: JSON.parse(init?.body || '{}') }); return Response.json([{ singleton: true }]); }
    if (url.startsWith('https://supabase.example/rest/v1/credit_payment_settings') && method === 'POST') { capture.push({ method, body: JSON.parse(init?.body || '{}') }); return Response.json([{ singleton: true }]); }
    if (url.startsWith('https://supabase.example/rest/v1/admin_user_actions')) return new Response('', { status: 201, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { restore() { globalThis.fetch = realFetch; } };
}

test('non-admin ditolak 403', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest({ enabled: true, password: 'rahasia-123' }, 'user-token'), createEnv());
    assert.equal(res.status, 403);
  } finally { mock.restore(); }
});

test('password salah ditolak 403 dan dicatat', async () => {
  const mock = installMock({ passwordValid: false });
  try {
    const res = await worker.fetch(apiRequest({ enabled: true, password: 'salah-salah' }), createEnv());
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /password/i);
  } finally { mock.restore(); }
});

test('mengaktifkan pada tabel kosong membuat baris settings dengan instruksi default', async () => {
  const capture = [];
  const mock = installMock({ settingsRows: [], capture });
  try {
    const res = await worker.fetch(apiRequest({ enabled: true, password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.purchases_enabled, true);
    assert.equal(capture.length, 1);
    assert.equal(capture[0].method, 'POST');
    assert.equal(capture[0].body.purchases_enabled, true);
    assert.ok(capture[0].body.instructions.length > 10);
  } finally { mock.restore(); }
});

test('mengubah baris settings yang ada memakai PATCH dan mempertahankan instruksi', async () => {
  const capture = [];
  const mock = installMock({ settingsRows: [{ instructions: 'Transfer BCA 123', purchases_enabled: false }], capture });
  try {
    const res = await worker.fetch(apiRequest({ enabled: true, password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 200);
    assert.equal(capture.length, 1);
    assert.equal(capture[0].method, 'PATCH');
    assert.equal(capture[0].body.purchases_enabled, true);
    assert.equal(capture[0].body.instructions, undefined);
  } finally { mock.restore(); }
});

test('menonaktifkan pada tabel kosong tidak membuat baris baru', async () => {
  const capture = [];
  const mock = installMock({ settingsRows: [], capture });
  try {
    const res = await worker.fetch(apiRequest({ enabled: false, password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.unchanged, true);
    assert.equal(capture.length, 0);
  } finally { mock.restore(); }
});

test('field asing atau enabled non-boolean ditolak 400', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest({ enabled: 'yes', password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 400);
    const res2 = await worker.fetch(apiRequest({ enabled: true, password: 'rahasia-123', singleton: true }), createEnv());
    assert.equal(res2.status, 400);
  } finally { mock.restore(); }
});
