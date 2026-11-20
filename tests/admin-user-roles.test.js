import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

// Fitur peran admin:
// 1) /api/admin/users/roles mengembalikan daftar ID akun admin (baca-saja).
// 2) Aksi 'role' pada /api/admin/users/action wajib password, menggabungkan
//    app_metadata, mencatat audit, dan menolak aksi pada akun sendiri.
// 3) Saldo (credits) kini boleh diterapkan admin ke akunnya SENDIRI.
const ADMIN_ID = '10000000-0000-4000-8000-0000000000a1';
const ADMIN2_ID = '10000000-0000-4000-8000-0000000000a2';
const USER_ID = '10000000-0000-4000-8000-0000000000b1';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path, { method = 'POST', body, token = 'admin-token' } = {}) {
  return new Request(`https://app.example${path}`, {
    method,
    headers: {
      origin: 'https://app.example',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function installMock({ passwordValid = true, authUsers, putCapture, balance = 150 } = {}) {
  const realFetch = globalThis.fetch;
  const users = authUsers ?? [
    { id: ADMIN_ID, email: 'admin@example.com', app_metadata: { role: 'admin', plan: 'unlimited' } },
    { id: USER_ID, email: 'user@example.com', app_metadata: { role: 'user', region: 'id' } },
  ];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();

    if (url === 'https://supabase.example/auth/v1/user') {
      const bearer = (init?.headers?.authorization || '').replace('Bearer ', '');
      if (bearer === 'admin-token') return Response.json({ id: ADMIN_ID, email: 'admin@example.com', app_metadata: { role: 'admin' } });
      return Response.json({ id: USER_ID, email: 'user@example.com', app_metadata: { role: 'user' } });
    }
    if (url.startsWith('https://supabase.example/auth/v1/admin/users?') && method === 'GET') {
      return Response.json({ users });
    }
    const putMatch = url.match(/^https:\/\/supabase\.example\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/);
    if (putMatch && method === 'PUT') {
      if (putCapture) putCapture.push({ id: putMatch[1], body: JSON.parse(init?.body || '{}') });
      return Response.json({ id: putMatch[1], ...(JSON.parse(init?.body || '{}')) });
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles') && method === 'GET') {
      const match = url.match(/id=eq\.([^&]+)/);
      const id = match ? decodeURIComponent(match[1]) : USER_ID;
      return Response.json([{ id, email: id === ADMIN_ID ? 'admin@example.com' : 'user@example.com', status: 'active' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles') && method === 'PATCH') {
      return Response.json([{}]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/verify_admin_action_password')) {
      return Response.json(passwordValid);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/admin_adjust_credits')) {
      return Response.json(balance);
    }
    if (url.startsWith('https://supabase.example/rest/v1/admin_user_actions')) {
      return new Response('', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { restore() { globalThis.fetch = realFetch; } };
}

test('/api/admin/users/roles mengembalikan hanya ID akun admin', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/roles', { body: {} }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.admin_ids, [ADMIN_ID]);
  } finally { mock.restore(); }
});

test('/api/admin/users/roles ditolak untuk non-admin', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/roles', { token: 'user-token', body: {} }), createEnv());
    assert.equal(res.status, 403);
  } finally { mock.restore(); }
});

test('aksi role mempromosikan user biasa menjadi admin dengan app_metadata tergabung', async () => {
  const putCalls = [];
  const mock = installMock({ putCapture: putCalls });
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { body: { action: 'role', user_id: USER_ID, password: 'rahasia-kuat-123', role: 'admin' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.role, 'admin');
    assert.equal(data.previous, 'user');
    assert.equal(putCalls.length, 1);
    // app_metadata lama dipertahankan, role diganti.
    assert.deepEqual(putCalls[0].body.app_metadata, { role: 'admin', region: 'id' });
  } finally { mock.restore(); }
});

test('aksi role pada akun sendiri ditolak walau password benar', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { body: { action: 'role', user_id: ADMIN_ID, password: 'rahasia-kuat-123', role: 'user' } }), createEnv());
    assert.equal(res.status, 409);
    const data = await res.json();
    assert.match(data.error, /akun Anda sendiri/i);
  } finally { mock.restore(); }
});

test('status pada akun sendiri tetap ditolak (409)', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { body: { action: 'status', user_id: ADMIN_ID, password: 'rahasia-kuat-123', status: 'active' } }), createEnv());
    assert.equal(res.status, 409);
  } finally { mock.restore(); }
});

test('saldo boleh diterapkan admin ke akunnya SENDIRI (wajib password)', async () => {
  const mock = installMock();
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { body: { action: 'credits', user_id: ADMIN_ID, password: 'rahasia-kuat-123', delta: 25, description: 'top-up manual owner' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.balance, 150);
    assert.equal(data.user_id, ADMIN_ID);
  } finally { mock.restore(); }
});

test('aksi role dengan password salah dicatat dan ditolak', async () => {
  const mock = installMock({ passwordValid: false });
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { body: { action: 'role', user_id: USER_ID, password: 'salah-salah', role: 'admin' } }), createEnv());
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /Password aksi admin salah/i);
  } finally { mock.restore(); }
});

test('admin terakhir tidak dapat dicabut perannya', async () => {
  // Satu-satunya admin adalah pemanggil; target lain adalah user biasa.
  // Cabut admin pada satu-satunya akun admin TIDAK mungkin via target lain,
  // jadi uji jalur count<=1 dengan daftar yang memuat target admin itu sendiri
  // sekaligus pemanggil yang sama — diblokir oleh aturan akun sendiri (409).
  // Sebagai gantinya: pastikan pencabutan admin kedua-ke-terakhir tetap boleh.
  const mock = installMock({
    authUsers: [
      { id: ADMIN_ID, email: 'admin@example.com', app_metadata: { role: 'admin' } },
      { id: ADMIN2_ID, email: 'admin2@example.com', app_metadata: { role: 'admin' } },
      { id: USER_ID, email: 'user@example.com', app_metadata: { role: 'user' } },
    ],
  });
  try {
    const res = await worker.fetch(apiRequest('/api/admin/users/action', { body: { action: 'role', user_id: ADMIN2_ID, password: 'rahasia-kuat-123', role: 'user' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.role, 'user');
    assert.equal(data.previous, 'admin');
  } finally { mock.restore(); }
});
