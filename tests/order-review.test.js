import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// /api/admin/review-order: Setujui/Tolak pesanan kredit WAJIB password aksi
// admin. Semua percobaan (berhasil/gagal) tercatat di admin_user_actions.
const ADMIN_ID = '10000000-0000-4000-8000-0000000000a1';
const USER_ID = '10000000-0000-4000-8000-0000000000b1';
const ORDER_ID = '30000000-0000-4000-8000-000000000001';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(body, token = 'admin-token') {
  return new Request('https://app.example/api/admin/review-order', {
    method: 'POST',
    headers: { origin: 'https://app.example', authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function installMock({ passwordValid = true, rpcResult = { status: 'approved', user_id: USER_ID }, rpcError = null, capture = [] } = {}) {
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
    if (url.startsWith('https://supabase.example/rest/v1/rpc/admin_review_credit_order')) {
      capture.push({ method, body: JSON.parse(init?.body || '{}') });
      if (rpcError) return new Response(JSON.stringify(rpcError), { status: 400, headers: { 'content-type': 'application/json' } });
      return Response.json(rpcResult);
    }
    if (url.startsWith('https://supabase.example/rest/v1/admin_user_actions')) return new Response('', { status: 201, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { restore() { globalThis.fetch = realFetch; } };
}

test('non-admin ditolak 403', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: true, password: 'rahasia-123' }, 'user-token'), createEnv());
    assert.equal(res.status, 403);
  } finally { mock.restore(); }
});

test('password salah ditolak 403', async () => {
  const mock = installMock({ passwordValid: false });
  try {
    const res = await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: true, password: 'salah-salah' }), createEnv());
    assert.equal(res.status, 403);
  } finally { mock.restore(); }
});

test('approve yang benar memanggil RPC privileged dengan admin pemanggil', async () => {
  const capture = [];
  const mock = installMock({ capture });
  try {
    const res = await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: true, password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'approved');
    assert.equal(capture.length, 1);
    assert.deepEqual(capture[0].body, { p_order_id: ORDER_ID, p_approve: true, p_admin_id: ADMIN_ID });
  } finally { mock.restore(); }
});

test('tolak pesanan berjalan dengan parameter approve=false', async () => {
  const capture = [];
  const mock = installMock({ capture, rpcResult: { status: 'rejected', user_id: USER_ID } });
  try {
    const res = await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: false, password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'rejected');
    assert.equal(capture[0].body.p_approve, false);
  } finally { mock.restore(); }
});

test('pesan error PostgREST diteruskan apa adanya (mis. tidak menunggu pemeriksaan)', async () => {
  const mock = installMock({ rpcError: { code: 'P0001', message: 'Pesanan tidak menunggu pemeriksaan' } });
  try {
    const res = await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: true, password: 'rahasia-123' }), createEnv());
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /tidak menunggu pemeriksaan/i);
  } finally { mock.restore(); }
});

test('validasi body: UUID salah, approve non-boolean, field asing', async () => {
  const mock = installMock();
  try {
    assert.equal((await worker.fetch(apiRequest({ order_id: 'bukan-uuid', approve: true, password: 'rahasia-123' }), createEnv())).status, 400);
    assert.equal((await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: 'yes', password: 'rahasia-123' }), createEnv())).status, 400);
    assert.equal((await worker.fetch(apiRequest({ order_id: ORDER_ID, approve: true, password: 'rahasia-123', status: 'approved' }), createEnv())).status, 400);
  } finally { mock.restore(); }
});
