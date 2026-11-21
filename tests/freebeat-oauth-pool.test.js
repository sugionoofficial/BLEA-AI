import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const BASE = 'https://blea-ai.blea-ai.workers.dev';
const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const ADMIN_UUID = '99999999-9999-4999-8999-999999999999';

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

function createPoolHarness({
  imagePrice = 15,
  dancePrice = 3000,
  spendOk = true,
  onMcpCall,
  onOAuthExchange,
} = {}) {
  const env = createEnv();
  const realFetch = globalThis.fetch;
  const poolRows = [];
  const legacySessions = new Map();
  const imageRows = [];
  const videoRows = [];
  const spends = [];
  const refunds = [];
  const mcpSequence = [];
  let seqId = 1;

  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    const url = new URL(urlStr);
    const method = (init.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url.href === 'https://supabase.example/auth/v1/user') {
      const bearer = (init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      return Response.json({
        id: bearer === 'admin-jwt' ? ADMIN_UUID : 'user-1',
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
      return Response.json([]);
    }
    if (url.pathname === '/rest/v1/credit_model_prices') {
      const prov = url.searchParams.get('provider')?.replace(/^eq\./, '');
      const model = url.searchParams.get('model')?.replace(/^eq\./, '');
      const modality = url.searchParams.get('modality')?.replace(/^eq\./, '');
      const all = [
        { provider: 'freebeat', model: '122', modality: 'image', credits: imagePrice, active: true },
        { provider: 'freebeat', model: 'generate_dance_video', modality: 'video', credits: dancePrice, active: true },
      ];
      return Response.json(all.filter((p) => {
        if (prov && p.provider !== prov) return false;
        if (model && p.model !== model) return false;
        if (modality && p.modality !== modality) return false;
        return true;
      }));
    }

    if (url.pathname === '/rest/v1/freebeat_oauth_accounts') {
      if (method === 'GET') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const emailIlike = url.searchParams.get('account_email')?.replace(/^ilike\./, '');
        const enabledEq = url.searchParams.get('enabled')?.replace(/^eq\./, '');
        let rows = poolRows.slice();
        if (idEq) rows = rows.filter((r) => r.id === idEq);
        if (emailIlike) rows = rows.filter((r) => String(r.account_email || '').toLowerCase() === emailIlike.toLowerCase());
        if (enabledEq === 'true') rows = rows.filter((r) => r.enabled !== false);
        const order = url.searchParams.get('order') || '';
        if (order.includes('priority.desc')) rows.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        else rows.sort((a, b) => (a.priority || 0) - (b.priority || 0));
        const limit = Number(url.searchParams.get('limit') || 50);
        return Response.json(rows.slice(0, limit));
      }
      if (method === 'POST') {
        const b = jsonBody();
        const created = {
          id: b.id || (seqId === 1 ? UUID_1 : seqId === 2 ? UUID_2 : `33333333-3333-4333-8333-${String(seqId).padStart(12, '0')}`),
          account_email: b.account_email ?? '',
          account_label: b.account_label ?? '',
          connected_by: b.connected_by ?? ADMIN_UUID,
          sealed_session: b.sealed_session,
          image_access: b.image_access === true,
          enabled: b.enabled !== false,
          priority: b.priority ?? 10,
          last_balance_credits: b.last_balance_credits ?? null,
          last_balance: b.last_balance ?? null,
          last_balance_checked_at: b.last_balance_checked_at ?? null,
          consecutive_failures: b.consecutive_failures ?? 0,
          last_error: b.last_error ?? null,
          last_used_at: null,
          last_success_at: null,
          issued_at: b.issued_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        seqId += 1;
        poolRows.push(created);
        return Response.json([created]);
      }
      if (method === 'PATCH') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const b = jsonBody();
        const updated = [];
        for (const r of poolRows) {
          if (idEq && r.id !== idEq) continue;
          Object.assign(r, b);
          updated.push(r);
        }
        return Response.json(updated);
      }
      if (method === 'DELETE') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const idx = poolRows.findIndex((r) => r.id === idEq);
        if (idx >= 0) poolRows.splice(idx, 1);
        return Response.json([]);
      }
    }

    if (url.pathname === '/rest/v1/freebeat_provider_sessions') {
      if (method === 'POST') {
        const b = jsonBody();
        legacySessions.set(b.user_id, b);
        return Response.json([b]);
      }
      if (method === 'DELETE') {
        const uid = url.searchParams.get('user_id')?.replace(/^eq\./, '');
        if (uid) legacySessions.delete(uid);
        return Response.json([]);
      }
      return Response.json([...legacySessions.values()]);
    }

    if (url.pathname === '/rest/v1/rpc/spend_credits') {
      spends.push(jsonBody());
      return Response.json(spendOk);
    }
    if (url.pathname === '/rest/v1/rpc/refund_credits') {
      refunds.push(jsonBody());
      return Response.json(true);
    }
    if (url.pathname === '/rest/v1/image_generations') {
      if (method === 'POST') {
        const b = { created_at: new Date().toISOString(), ...jsonBody() };
        imageRows.push(b);
        return Response.json([b]);
      }
      if (method === 'PATCH') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const b = jsonBody();
        const row = imageRows.find((r) => r.id === idEq);
        if (row) Object.assign(row, b);
        return Response.json(row ? [row] : []);
      }
    }
    if (url.pathname === '/rest/v1/video_generations') {
      if (method === 'GET') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        return Response.json(idEq ? videoRows.filter((r) => r.id === idEq) : videoRows);
      }
      if (method === 'POST') {
        const b = { created_at: new Date().toISOString(), ...jsonBody() };
        videoRows.push(b);
        return Response.json([b]);
      }
      if (method === 'PATCH') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const refundGuard = url.searchParams.get('credits_refunded');
        const b = jsonBody();
        const row = videoRows.find((r) => r.id === idEq);
        if (refundGuard === 'eq.0' && (!row || Number(row.credits_refunded || 0) !== 0)) {
          return Response.json([]);
        }
        if (row) Object.assign(row, b);
        return Response.json(row ? [row] : []);
      }
    }

    if (url.href === 'https://freebeat.ai/oauth/register') {
      return Response.json({ client_id: `client-${seqId}` });
    }
    if (url.href === 'https://freebeat.ai/oauth/token') {
      const form = new URLSearchParams(init.body || '');
      const custom = onOAuthExchange ? onOAuthExchange(form) : null;
      if (custom) return custom;
      return Response.json({
        access_token: `tok-${seqId}`,
        refresh_token: `ref-${seqId}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'freebeat:read freebeat:generate',
      });
    }
    if (url.href === 'https://freebeat.ai/oauth/revoke') {
      return Response.json({ ok: true });
    }

    if (url.href === 'https://freebeat.ai/api/mcp') {
      const token = (init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      const rpc = jsonBody();
      if (rpc.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': `sess-${token}` },
        });
      }
      if (rpc.method === 'notifications/initialized') {
        return new Response('', { status: 202 });
      }
      const tool = rpc.params?.name;
      mcpSequence.push({ token, tool, args: rpc.params?.arguments });
      if (onMcpCall) {
        return onMcpCall({ token, tool, args: rpc.params?.arguments || {}, id: rpc.id });
      }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { structuredContent: {} } });
    }

    throw new Error(`Unexpected fetch: ${method} ${url.href}`);
  };

  return {
    env,
    poolRows,
    legacySessions,
    imageRows,
    videoRows,
    spends,
    refunds,
    mcpSequence,
    cleanup() { globalThis.fetch = realFetch; },
  };
}

function mcpSuccess(id, structuredContent) {
  return Response.json({ jsonrpc: '2.0', id, result: { structuredContent } });
}

function mcpBalanceExhausted(id, message = 'Insufficient credits on Freebeat account') {
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: { isError: true, structuredContent: { error: 'insufficient_credits', message } },
  });
}

async function connectAccountViaOAuth(h, { email, label, returnTo = '/admin?tab=freebeat-oauth' }) {
  const startRes = await worker.fetch(apiRequest('/api/freebeat/start', {
    token: 'admin-jwt',
    body: { email, label, returnTo },
  }), h.env);
  assert.equal(startRes.status, 200);
  const startData = await startRes.json();
  const authUrl = new URL(startData.url);
  const state = authUrl.searchParams.get('state');
  const setCookie = startRes.headers.get('set-cookie') || '';
  const pendingCookie = setCookie.split(';')[0];

  const cbRes = await worker.fetch(new Request(`${BASE}/api/freebeat/callback?code=code-for-${encodeURIComponent(email)}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: pendingCookie },
  }), h.env);
  assert.equal(cbRes.status, 303);
  return { cbRes, location: cbRes.headers.get('location') };
}

test('migration 20261129000000_freebeat_oauth_accounts creates server-only table and backfills active provider session', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE FUNCTION public.set_projects_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, full_name text);
      CREATE TABLE public.freebeat_provider_sessions (
        user_id uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
        sealed_session text NOT NULL,
        image_access boolean NOT NULL DEFAULT false,
        issued_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO auth.users (id) VALUES ('${ADMIN_UUID}');
      INSERT INTO public.profiles (id, email, full_name) VALUES ('${ADMIN_UUID}', 'utama@gmail.com', 'Admin BLEA');
      INSERT INTO public.freebeat_provider_sessions (user_id, sealed_session, image_access) VALUES ('${ADMIN_UUID}', 'sealed-blob-1', true);
    `);

    const sql = await fs.readFile(new URL('../supabase/migrations/20261129000000_freebeat_oauth_accounts.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    const sql2 = await fs.readFile(new URL('../supabase/migrations/20261130000000_freebeat_oauth_email_source.sql', import.meta.url), 'utf8');
    await db.exec(sql2);

    const rows = (await db.query('SELECT * FROM public.freebeat_oauth_accounts')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].account_email, 'utama@gmail.com');
    assert.equal(rows[0].email_source, 'manual');
    assert.equal(rows[0].account_label, 'Admin BLEA');
    assert.equal(rows[0].image_access, true);
    assert.equal(rows[0].enabled, true);
    assert.equal(rows[0].priority, 10);

    const privCheck = await db.query(`
      SELECT has_table_privilege('anon', 'public.freebeat_oauth_accounts', 'SELECT') AS anon_sel,
             has_table_privilege('authenticated', 'public.freebeat_oauth_accounts', 'SELECT') AS auth_sel
    `);
    assert.equal(privCheck.rows[0].anon_sel, false);
    assert.equal(privCheck.rows[0].auth_sel, false);
  } finally {
    await db.close();
  }
});

test('multi-account Freebeat OAuth flow, CRUD, email labeling, priority reorder, balance check, and admin gating', async () => {
  const h = createPoolHarness({
    onMcpCall: ({ token, tool, id }) => {
      if (tool === 'get_credit_balance') {
        const credits = token === 'tok-1' ? 0 : 180;
        return mcpSuccess(id, { available_credits: credits, email: token === 'tok-1' ? 'akun1@gmail.com' : 'akun2@gmail.com' });
      }
      return mcpSuccess(id, {});
    },
  });

  try {
    // Non-admin ditolak
    const nonAdmin = await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'user-jwt' }), h.env);
    assert.equal(nonAdmin.status, 403);

    // Hubungkan 2 akun berbeda dengan email & label masing-masing
    const conn1 = await connectAccountViaOAuth(h, { email: 'akun1@gmail.com', label: 'Akun Satu', returnTo: '/admin?tab=freebeat-oauth' });
    assert.equal(conn1.location, `${BASE}/admin?tab=freebeat-oauth&freebeat=connected`);
    const conn2 = await connectAccountViaOAuth(h, { email: 'akun2@gmail.com', label: 'Akun Dua', returnTo: '/admin?tab=freebeat-oauth' });
    assert.equal(conn2.location, `${BASE}/admin?tab=freebeat-oauth&freebeat=connected`);

    const listRes = await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'admin-jwt' }), h.env);
    assert.equal(listRes.status, 200);
    const listData = await listRes.json();
    assert.equal(listData.maxCycles, 3);
    assert.equal(listData.accounts.length, 2);
    assert.equal(listData.accounts[0].account_email, 'akun1@gmail.com');
    assert.equal(listData.accounts[1].account_email, 'akun2@gmail.com');
    // Pastikan rahasia token tidak pernah bocor ke client admin
    const serialized = JSON.stringify(listData);
    assert.equal(serialized.includes('sealed_session'), false);
    assert.equal(serialized.includes('tok-1'), false);
    assert.equal(serialized.includes('ref-1'), false);

    // Cek semua saldo
    const balRes = await worker.fetch(apiRequest('/api/freebeat/accounts/balance', { method: 'POST', token: 'admin-jwt', body: {} }), h.env);
    assert.equal(balRes.status, 200);
    const balData = await balRes.json();
    assert.equal(balData.accounts[0].last_balance_credits, 0);
    assert.equal(balData.accounts[0].last_error, 'Saldo Freebeat habis (0 kredit)');
    assert.equal(balData.accounts[1].last_balance_credits, 180);

    // Reorder membalik urutan prioritas (Akun Dua naik ke #1)
    const reorderRes = await worker.fetch(apiRequest('/api/freebeat/accounts/reorder', {
      method: 'POST',
      token: 'admin-jwt',
      body: { orderedIds: [listData.accounts[1].id, listData.accounts[0].id] },
    }), h.env);
    assert.equal(reorderRes.status, 200);
    const reordered = await reorderRes.json();
    assert.equal(reordered.accounts[0].account_email, 'akun2@gmail.com');
    assert.equal(reordered.accounts[1].account_email, 'akun1@gmail.com');

    // Update email & toggle nonaktif
    const patchRes = await worker.fetch(apiRequest('/api/freebeat/accounts', {
      method: 'PATCH',
      token: 'admin-jwt',
      body: { id: listData.accounts[0].id, account_email: 'akun1-baru@gmail.com', enabled: false },
    }), h.env);
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json();
    assert.equal(patched.account.account_email, 'akun1-baru@gmail.com');
    assert.equal(patched.account.enabled, false);

    // Validasi tolak email invalid
    const badPatch = await worker.fetch(apiRequest('/api/freebeat/accounts', {
      method: 'PATCH',
      token: 'admin-jwt',
      body: { id: listData.accounts[0].id, account_email: 'bukan-email' },
    }), h.env);
    assert.equal(badPatch.status, 400);

    // Delete akun
    const delRes = await worker.fetch(apiRequest('/api/freebeat/accounts', {
      method: 'DELETE',
      token: 'admin-jwt',
      body: { id: listData.accounts[0].id },
    }), h.env);
    assert.equal(delRes.status, 200);
    const afterDel = await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'admin-jwt' }), h.env);
    assert.equal((await afterDel.json()).accounts.length, 1);
  } finally {
    h.cleanup();
  }
});

test('image generation rotates from exhausted Account #1 to Account #2 cleanly with single BLEA credit spend', async () => {
  let h;
  h = createPoolHarness({
    onMcpCall: ({ token, tool, id }) => {
      if (tool === 'list_models') return mcpSuccess(id, { models: [{ model_id: 122, name: 'Nano Banana 2 Lite', available: true, member_only: false }] });
      if (tool === 'quote_generation') {
        if (token === 'tok-1') return mcpBalanceExhausted(id);
        return mcpSuccess(id, { status: 'quoted', credits: 10 });
      }
      if (tool === 'generate_image') return mcpSuccess(id, { batch_id: 'img-batch-2' });
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'akun1@gmail.com', label: 'Akun #1' });
    await connectAccountViaOAuth(h, { email: 'akun2@gmail.com', label: 'Akun #2' });

    const res = await worker.fetch(apiRequest('/api/image/generate', {
      token: 'user-jwt',
      body: { provider: 'freebeat', model: '122', prompt: 'Matahari terbit di Jakarta' },
    }), h.env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.status, 'submitted');
    assert.equal(h.spends.length, 1);
    assert.equal(h.refunds.length, 0);
    assert.equal(h.imageRows[0].metadata.freebeat_account_email, 'akun2@gmail.com');
    assert.equal(h.poolRows[0].consecutive_failures, 1);
    assert.equal(h.poolRows[1].consecutive_failures, 0);
  } finally {
    h.cleanup();
  }
});

test('image generation retries up to 3 full round-robin cycles before succeeding or returning 503 SALDO GATEWAY HABIS with refund', async () => {
  // Skenario A: Sukses pada putaran ke-2 di akun ke-2 (#1 -> #2 -> #1 -> #2 sukses)
  let h = createPoolHarness({
    onMcpCall: ({ token, tool, id }) => {
      if (tool === 'list_models') return mcpSuccess(id, { models: [{ model_id: 122, name: 'Nano Banana 2 Lite', available: true, member_only: false }] });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'quoted', credits: 10 });
      if (tool === 'generate_image') {
        const genCalls = h.mcpSequence.filter((c) => c.tool === 'generate_image').length;
        if (genCalls < 4) return mcpBalanceExhausted(id);
        return mcpSuccess(id, { batch_id: 'img-cycle-2-ok' });
      }
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'akun1@gmail.com', label: 'Akun #1' });
    await connectAccountViaOAuth(h, { email: 'akun2@gmail.com', label: 'Akun #2' });

    const okRes = await worker.fetch(apiRequest('/api/image/generate', {
      token: 'user-jwt',
      body: { provider: 'freebeat', model: '122', prompt: 'Kucing cyberpunk' },
    }), h.env);
    assert.equal(okRes.status, 200);
    assert.deepEqual(h.mcpSequence.filter((c) => c.tool === 'generate_image').map((c) => c.token), ['tok-1', 'tok-2', 'tok-1', 'tok-2']);
    assert.equal(h.spends.length, 1);
    assert.equal(h.refunds.length, 0);
  } finally {
    h.cleanup();
  }

  // Skenario B: Semua akun kehabisan saldo selama 3 putaran penuh -> HTTP 503 + refund otomatis
  h = createPoolHarness({
    onMcpCall: ({ tool, id }) => {
      if (tool === 'list_models') return mcpSuccess(id, { models: [{ model_id: 122, name: 'Nano Banana 2 Lite', available: true, member_only: false }] });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'quoted', credits: 10 });
      if (tool === 'generate_image') return mcpBalanceExhausted(id);
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'akun1@gmail.com', label: 'Akun #1' });
    await connectAccountViaOAuth(h, { email: 'akun2@gmail.com', label: 'Akun #2' });

    const failRes = await worker.fetch(apiRequest('/api/image/generate', {
      token: 'user-jwt',
      body: { provider: 'freebeat', model: '122', prompt: 'Pemandangan gunung' },
    }), h.env);
    assert.equal(failRes.status, 503);
    const errBody = await failRes.json();
    assert.equal(errBody.error, 'SALDO GATEWAY HABIS, SILAHKAN HUBUNGI ADMIN.');
    assert.equal(errBody.code, 'gateway_balance_exhausted');
    // Tepat 3 putaran penuh: #1 -> #2 -> #1 -> #2 -> #1 -> #2
    assert.deepEqual(
      h.mcpSequence.filter((c) => c.tool === 'generate_image').map((c) => c.token),
      ['tok-1', 'tok-2', 'tok-1', 'tok-2', 'tok-1', 'tok-2'],
    );
    assert.equal(h.spends.length, 1);
    assert.equal(h.refunds.length, 1);
    assert.equal(h.imageRows[0].status, 'failed');
    assert.equal(h.imageRows[0].credits_refunded, 15);
  } finally {
    h.cleanup();
  }
});

test('dance video generation rotates across accounts with per-account upload_audio and refunds with 503 after 3 full exhausted cycles', async () => {
  let h = createPoolHarness({
    onMcpCall: ({ token, tool, id }) => {
      if (tool === 'upload_audio') return mcpSuccess(id, { music_id: `music-${token}`, audio_info: { duration: 15, title: 'Beat' } });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'unknown' });
      if (tool === 'generate_dance_video') {
        if (token === 'tok-1') return mcpBalanceExhausted(id);
        return mcpSuccess(id, { task_id: 'dance-task-acc2', session_url: 'https://freebeat.ai/session/2' });
      }
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'akun1@gmail.com', label: 'Dance #1' });
    await connectAccountViaOAuth(h, { email: 'akun2@gmail.com', label: 'Dance #2' });

    const okRes = await worker.fetch(apiRequest('/api/video/generate', {
      token: 'user-jwt',
      body: {
        provider: 'freebeat',
        model: 'generate_dance_video',
        audio_url: 'https://cdn.example/beat.mp3',
        prompt: 'Energic stage dance',
        aspect_ratio: '9:16',
      },
    }), h.env);
    assert.equal(okRes.status, 200);
    const okData = await okRes.json();
    assert.equal(okData.generation.external_job_id, 'dance-task-acc2');
    assert.equal(okData.generation.metadata.music_id, 'music-tok-2');
    assert.equal(h.spends.length, 1);
    assert.equal(h.refunds.length, 0);
  } finally {
    h.cleanup();
  }

  // 3-cycle exhaustion on dance video -> HTTP 503 SALDO GATEWAY HABIS + refund
  h = createPoolHarness({
    onMcpCall: ({ token, tool, id }) => {
      if (tool === 'upload_audio') return mcpSuccess(id, { music_id: `music-${token}`, audio_info: { duration: 15 } });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'unknown' });
      if (tool === 'generate_dance_video') return mcpBalanceExhausted(id);
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'akun1@gmail.com', label: 'Dance #1' });
    await connectAccountViaOAuth(h, { email: 'akun2@gmail.com', label: 'Dance #2' });

    const failRes = await worker.fetch(apiRequest('/api/video/generate', {
      token: 'user-jwt',
      body: {
        provider: 'freebeat',
        model: 'generate_dance_video',
        audio_url: 'https://cdn.example/beat.mp3',
        aspect_ratio: '9:16',
      },
    }), h.env);
    assert.equal(failRes.status, 503);
    const errData = await failRes.json();
    assert.equal(errData.error, 'SALDO GATEWAY HABIS, SILAHKAN HUBUNGI ADMIN.');
    assert.equal(errData.code, 'gateway_balance_exhausted');
    assert.deepEqual(
      h.mcpSequence.filter((c) => c.tool === 'generate_dance_video').map((c) => c.token),
      ['tok-1', 'tok-2', 'tok-1', 'tok-2', 'tok-1', 'tok-2'],
    );
    assert.equal(h.spends.length, 1);
    assert.equal(h.refunds.length, 1);
  } finally {
    h.cleanup();
  }
});

test('FreebeatOAuthPanel renders pool add form, failover policy, AdminPage nav group, and /admin/freebeat-oauth route', async () => {
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
    const { FreebeatOAuthPanel } = await vite.ssrLoadModule('/src/auth/FreebeatOAuthPanel.jsx');
    const adminSource = await fs.readFile(new URL('../src/auth/AdminPage.jsx', import.meta.url), 'utf8');
    const mainSource = await fs.readFile(new URL('../src/main.jsx', import.meta.url), 'utf8');
    const freebeatApiSource = await fs.readFile(new URL('../src/api/freebeat.js', import.meta.url), 'utf8');
    const freebeatPageSource = await fs.readFile(new URL('../src/auth/FreebeatPage.jsx', import.meta.url), 'utf8');

    assert.equal(adminSource.includes("id: 'freebeat-oauth'"), true);
    assert.equal(adminSource.includes('<FreebeatOAuthPanel'), true);
    assert.equal(mainSource.includes('/admin/freebeat-oauth'), true);
    assert.equal(freebeatApiSource.includes('accounts/reorder'), true);
    assert.equal(freebeatApiSource.includes('accounts/balance'), true);
    assert.equal(freebeatPageSource.includes('/admin?tab=freebeat-oauth'), true);

    const accountsHtml = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(FreebeatOAuthPanel, { subTab: 'accounts' })),
    );
    assert.equal(accountsHtml.includes('Pool Akun Freebeat OAuth'), true);
    assert.equal(accountsHtml.includes('Hubungkan Akun Freebeat (OAuth)'), true);
    assert.equal(accountsHtml.includes('3x Putaran'), true);
    assert.equal(accountsHtml.includes('Email akun Freebeat'), true);

    const failoverHtml = renderToStaticMarkup(
      React.createElement(MemoryRouter, null, React.createElement(FreebeatOAuthPanel, { subTab: 'failover' })),
    );
    assert.equal(failoverHtml.includes('SALDO GATEWAY HABIS, SILAHKAN HUBUNGI ADMIN.'), true);
    assert.equal(failoverHtml.includes('Round-Robin 3x Putaran'), true);
  } finally {
    await vite.close();
  }
});

test('OAuth callback updates account_email from JWT/userinfo over stale label and clears stale email if subject changes without email', async () => {
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const makeJwt = (claims) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.sig`;
  let exchangeMode = 'initial-sub1';
  const h = createPoolHarness({
    onOAuthExchange: () => {
      if (exchangeMode === 'initial-sub1') {
        return Response.json({
          access_token: makeJwt({ sub: 'fb-user-1', email: 'pertama@gmail.com' }),
          refresh_token: 'ref-a',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'freebeat:read freebeat:generate',
        });
      }
      if (exchangeMode === 'reauth-jwt-email') {
        return Response.json({
          access_token: makeJwt({ sub: 'fb-user-2', email: 'kedua-oauth@gmail.com' }),
          refresh_token: 'ref-b',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'freebeat:read freebeat:generate',
        });
      }
      if (exchangeMode === 'reauth-new-sub-no-email') {
        return Response.json({
          access_token: makeJwt({ sub: 'fb-user-3' }),
          refresh_token: 'ref-c',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'freebeat:read freebeat:generate',
        });
      }
      if (exchangeMode === 'reauth-diff-sub-no-email') {
        return Response.json({
          access_token: makeJwt({ sub: 'fb-user-4' }),
          refresh_token: 'ref-d',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'freebeat:read freebeat:generate',
        });
      }
      return null;
    },
  });

  // Stub OAuth userinfo for the userinfo-discovery scenario
  const innerFetch = globalThis.fetch;
  let userinfoEmail = null;
  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr === 'https://freebeat.ai/.well-known/oauth-authorization-server') {
      return Response.json({ userinfo_endpoint: 'https://freebeat.ai/oauth/userinfo' });
    }
    if (urlStr === 'https://freebeat.ai/oauth/userinfo') {
      if (userinfoEmail) return Response.json({ email: userinfoEmail, sub: 'fb-user-4' });
      return Response.json({}, { status: 404 });
    }
    return innerFetch(input, init);
  };

  try {
    // 1. Koneksi awal via JWT email
    await connectAccountViaOAuth(h, { email: 'label-awal@gmail.com', label: 'Pool #1' });
    let list = await (await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'admin-jwt' }), h.env)).json();
    assert.equal(list.accounts[0].account_email, 'pertama@gmail.com');
    assert.equal(list.accounts[0].email_source, 'oauth');
    const rowId = list.accounts[0].id;

    // 2. OAuth Ulang dengan accountId yang sama -> email dari OAuth menimpa email lama walau pending masih mengirim email lama
    exchangeMode = 'reauth-jwt-email';
    const start2 = await worker.fetch(apiRequest('/api/freebeat/start', {
      token: 'admin-jwt',
      body: { accountId: rowId, email: 'pertama@gmail.com', returnTo: '/admin?tab=freebeat-oauth' },
    }), h.env);
    const u2 = new URL((await start2.json()).url);
    const cookie2 = (start2.headers.get('set-cookie') || '').split(';')[0];
    await worker.fetch(new Request(`${BASE}/api/freebeat/callback?code=c2&state=${encodeURIComponent(u2.searchParams.get('state'))}`, {
      headers: { cookie: cookie2 },
    }), h.env);

    list = await (await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'admin-jwt' }), h.env)).json();
    assert.equal(list.accounts.length, 1);
    assert.equal(list.accounts[0].account_email, 'kedua-oauth@gmail.com');
    assert.equal(list.accounts[0].email_source, 'oauth');

    // 3. OAuth Ulang ke userinfo endpoint saat JWT tidak memuat email
    exchangeMode = 'reauth-new-sub-no-email';
    userinfoEmail = 'userinfo-ketiga@gmail.com';
    const start3 = await worker.fetch(apiRequest('/api/freebeat/start', {
      token: 'admin-jwt',
      body: { accountId: rowId, returnTo: '/admin?tab=freebeat-oauth' },
    }), h.env);
    const u3 = new URL((await start3.json()).url);
    const cookie3 = (start3.headers.get('set-cookie') || '').split(';')[0];
    await worker.fetch(new Request(`${BASE}/api/freebeat/callback?code=c3&state=${encodeURIComponent(u3.searchParams.get('state'))}`, {
      headers: { cookie: cookie3 },
    }), h.env);
    list = await (await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'admin-jwt' }), h.env)).json();
    assert.equal(list.accounts[0].account_email, 'userinfo-ketiga@gmail.com');
    assert.equal(list.accounts[0].email_source, 'oauth');

    // 4. Jika OAuth tidak mengembalikan email sama sekali tapi subject (sub) berubah, email lama dibersihkan agar tidak menyesatkan
    exchangeMode = 'reauth-diff-sub-no-email';
    userinfoEmail = null;
    const start4 = await worker.fetch(apiRequest('/api/freebeat/start', {
      token: 'admin-jwt',
      body: { accountId: rowId, returnTo: '/admin?tab=freebeat-oauth' },
    }), h.env);
    const u4 = new URL((await start4.json()).url);
    const cookie4 = (start4.headers.get('set-cookie') || '').split(';')[0];
    await worker.fetch(new Request(`${BASE}/api/freebeat/callback?code=c4&state=${encodeURIComponent(u4.searchParams.get('state'))}`, {
      headers: { cookie: cookie4 },
    }), h.env);
    list = await (await worker.fetch(apiRequest('/api/freebeat/accounts', { method: 'GET', token: 'admin-jwt' }), h.env)).json();
    assert.equal(list.accounts[0].account_email, '');
    assert.equal(list.accounts[0].email_source, 'unverified');
  } finally {
    globalThis.fetch = innerFetch;
    h.cleanup();
  }
});

test('dance video pre-flight skips low-balance Freebeat accounts (< 800 credits) before burning partial credits', async () => {
  // Skenario 1: Akun #1 saldo 345 (< 800), Akun #2 saldo 1500 -> generate_dance_video TIDAK pernah dipanggil di Akun #1, sukses di Akun #2
  let h = createPoolHarness({
    onMcpCall: ({ token, tool, id }) => {
      if (tool === 'get_credit_balance') {
        return mcpSuccess(id, { available_credits: token === 'tok-1' ? 345 : 1500 });
      }
      if (tool === 'upload_audio') return mcpSuccess(id, { music_id: `music-${token}` });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'unknown' });
      if (tool === 'generate_dance_video') {
        return mcpSuccess(id, { task_id: `dance-${token}`, session_url: 'https://freebeat.ai/session/2' });
      }
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'low@gmail.com', label: 'Saldo Rendah' });
    await connectAccountViaOAuth(h, { email: 'cukup@gmail.com', label: 'Saldo Cukup' });

    const res = await worker.fetch(apiRequest('/api/video/generate', {
      token: 'user-jwt',
      body: {
        provider: 'freebeat',
        model: 'generate_dance_video',
        audio_url: 'https://cdn.example/beat.mp3',
        aspect_ratio: '9:16',
      },
    }), h.env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.generation.external_job_id, 'dance-tok-2');
    // Akun #1 tidak pernah disentuh generate_dance_video agar 345 kredit tidak terbakar sia-sia
    assert.deepEqual(h.mcpSequence.filter((c) => c.tool === 'generate_dance_video').map((c) => c.token), ['tok-2']);
    assert.equal(h.poolRows[0].last_balance_credits, 345);
    assert.match(String(h.poolRows[0].last_error || ''), /345/);
    assert.equal(h.spends.length, 1);
    assert.equal(h.refunds.length, 0);
  } finally {
    h.cleanup();
  }

  // Skenario 2: Semua akun di bawah batas minimal dance (345 kredit) -> 503 tanpa membakar kredit Freebeat maupun memotong BLEA
  h = createPoolHarness({
    onMcpCall: ({ tool, id }) => {
      if (tool === 'get_credit_balance') return mcpSuccess(id, { available_credits: 345 });
      if (tool === 'upload_audio') return mcpSuccess(id, { music_id: 'music-tok-1' });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'unknown' });
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'low-only@gmail.com', label: 'Satu-satunya' });
    const failRes = await worker.fetch(apiRequest('/api/video/generate', {
      token: 'user-jwt',
      body: {
        provider: 'freebeat',
        model: 'generate_dance_video',
        audio_url: 'https://cdn.example/beat.mp3',
        aspect_ratio: '9:16',
      },
    }), h.env);
    assert.equal(failRes.status, 503);
    const body = await failRes.json();
    assert.equal(body.error, 'SALDO GATEWAY HABIS, SILAHKAN HUBUNGI ADMIN.');
    assert.equal(body.code, 'gateway_balance_exhausted');
    assert.equal(h.mcpSequence.filter((c) => c.tool === 'generate_dance_video').length, 0);
    assert.equal(h.spends.length, 0);
    assert.equal(h.refunds.length, 0);
  } finally {
    h.cleanup();
  }
});

test('action_required halts nudging immediately and refunds BLEA credits on insufficient Freebeat credits or after 3-nudge timeout', async () => {
  // Kasus 1: get_video_session melaporkan kredit tidak cukup -> 0 nudge + fail + refund atomik 3000 kredit
  let sessionMode = 'explicit-insufficient';
  let taskStatusPayload = { status: 'action_required', task_id: 'dance:M100', progress: 90 };
  const h = createPoolHarness({
    onMcpCall: ({ tool, id }) => {
      if (tool === 'get_credit_balance') {
        return mcpSuccess(id, { available_credits: sessionMode === 'low-balance-ambiguous' ? 345 : 1500 });
      }
      if (tool === 'upload_audio') return mcpSuccess(id, { music_id: 'm-1' });
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'unknown' });
      if (tool === 'generate_dance_video') return mcpSuccess(id, { task_id: 'dance:M100', session_url: 'https://freebeat.ai/session/100' });
      if (tool === 'get_task_status') return mcpSuccess(id, taskStatusPayload);
      if (tool === 'get_video_session') {
        if (sessionMode === 'explicit-insufficient') {
          return mcpSuccess(id, {
            status: 'action_required',
            messages: [{ role: 'assistant', content: 'Insufficient credits to continue this dance video. Please top up credits.' }],
          });
        }
        if (sessionMode === 'low-balance-ambiguous') {
          return mcpSuccess(id, {
            status: 'action_required',
            messages: [{ role: 'assistant', text: 'Please confirm to proceed with generating the next scene.' }],
          });
        }
        return mcpSuccess(id, {
          status: 'action_required',
          messages: [{ role: 'assistant', text: 'Choose choreography transition style.' }],
        });
      }
      if (tool === 'get_task_result') return mcpSuccess(id, { status: 'action_required' });
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectAccountViaOAuth(h, { email: 'dance-acc@gmail.com', label: 'Dance Pool' });
    const genRes = await worker.fetch(apiRequest('/api/video/generate', {
      token: 'user-jwt',
      body: { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3', aspect_ratio: '9:16' },
    }), h.env);
    assert.equal(genRes.status, 200);
    const job1 = (await genRes.json()).generation;

    const status1 = await worker.fetch(apiRequest(`/api/video/status?id=${encodeURIComponent(job1.id)}`, { method: 'GET', token: 'user-jwt' }), h.env);
    assert.equal(status1.status, 200);
    const s1 = await status1.json();
    assert.equal(s1.generation.status, 'failed');
    assert.equal(s1.generation.credits_refunded, 3000);
    assert.equal(h.mcpSequence.filter((c) => c.tool === 'send_video_agent_message').length, 0);
    assert.equal(h.refunds.length, 1);
    assert.equal(h.refunds[0].p_amount, 3000);
    assert.match(String(h.poolRows[0].last_error || ''), /Saldo Freebeat/);

    // Kasus 2: Pesan konfirmasi ambigu di get_video_session saat saldo akun tinggal 345 (< 400) -> tetap stop tanpa nudge & refund
    sessionMode = 'low-balance-ambiguous';
    h.videoRows.push({
      id: '11111111-1111-4111-8111-111111111112',
      user_id: 'user-1',
      provider: 'freebeat',
      model: 'generate_dance_video',
      prompt: 'Dance 2',
      aspect_ratio: '9:16',
      resolution: '720p',
      duration: 15,
      generate_audio: true,
      external_job_id: 'dance:M101',
      credits_charged: 3000,
      credits_refunded: 0,
      status: 'in_progress',
      progress: 90,
      metadata: { mode: 'dance_video', freebeat_account_id: h.poolRows[0].id },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const status2 = await worker.fetch(apiRequest('/api/video/status?id=11111111-1111-4111-8111-111111111112', { method: 'GET', token: 'user-jwt' }), h.env);
    assert.equal(status2.status, 200);
    const s2 = await status2.json();
    assert.equal(s2.generation.status, 'failed');
    assert.equal(s2.generation.credits_refunded, 3000);
    assert.equal(h.mcpSequence.filter((c) => c.tool === 'send_video_agent_message').length, 0);
    assert.equal(h.poolRows[0].last_balance_credits, 345);
    assert.equal(h.refunds.length, 2);

    // Kasus 3: Sudah 3 kali nudge > 60 detik lalu (tanpa pesan saldo, saldo akun cukup) -> fail otomatis agar job tidak nyangkut selamanya di 90%
    sessionMode = 'other-confirm';
    h.videoRows.push({
      id: '11111111-1111-4111-8111-111111111113',
      user_id: 'user-1',
      provider: 'freebeat',
      model: 'generate_dance_video',
      prompt: 'Dance 3',
      aspect_ratio: '9:16',
      resolution: '720p',
      duration: 15,
      generate_audio: true,
      external_job_id: 'dance:M102',
      credits_charged: 3000,
      credits_refunded: 0,
      status: 'in_progress',
      progress: 90,
      metadata: {
        mode: 'dance_video',
        freebeat_account_id: h.poolRows[0].id,
        auto_nudged: true,
        auto_nudge_count: 3,
        last_nudge_at: Date.now() - 120_000,
        agent_status: 'action_required',
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const { diagnosePendingGeneration } = await import('../src/lib/liveQueue.js');
    const notice = diagnosePendingGeneration('video', h.videoRows[2]);
    assert.match(String(notice || ''), /3 nudge otomatis/);

    const status3 = await worker.fetch(apiRequest('/api/video/status?id=11111111-1111-4111-8111-111111111113', { method: 'GET', token: 'user-jwt' }), h.env);
    assert.equal(status3.status, 200);
    const s3 = await status3.json();
    assert.equal(s3.generation.status, 'failed');
    assert.equal(s3.generation.credits_refunded, 3000);
    assert.equal(s3.generation.metadata.agent_status, 'action_required_timeout');
    assert.equal(h.mcpSequence.filter((c) => c.tool === 'send_video_agent_message').length, 0);
    assert.equal(h.refunds.length, 3);
  } finally {
    h.cleanup();
  }
});


