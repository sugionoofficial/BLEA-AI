import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import React from 'react';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import worker from '../src/worker.js';

const BASE = 'https://blea-ai.blea-ai.workers.dev';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const ADMIN_ID = '99999999-9999-4999-8999-999999999999';

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

function apiRequest(path, { method = 'POST', body, token = 'user-jwt', origin = BASE, headers: extraHeaders = {} } = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

function createMusicHarness({
  providerModels = [
    { provider: 'freebeat', model: '129', active: true },
    { provider: 'freebeat', model: '194', active: true },
    { provider: 'freebeat', model: '130', active: true },
  ],
  creditPrices = [
    { provider: 'freebeat', model: '129', modality: 'music', credits: 1000, active: true },
    { provider: 'freebeat', model: '194', modality: 'music', credits: 1500, active: true },
  ],
  spendOk = true,
  onMcpCall,
  onMediaFetch,
} = {}) {
  const env = createEnv();
  const realFetch = globalThis.fetch;
  const poolRows = [];
  const legacySessions = new Map();
  const musicRows = [];
  const spends = [];
  const refunds = [];
  const mcpCalls = [];
  const mediaFetches = [];
  let seqId = 1;

  globalThis.fetch = async (input, init = {}) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    const url = new URL(urlStr);
    const method = (init.method || 'GET').toUpperCase();
    const jsonBody = () => { try { return JSON.parse(init.body || '{}'); } catch { return {}; } };

    if (url.href === 'https://supabase.example/auth/v1/user') {
      const bearer = (init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      if (bearer === 'admin-jwt') {
        return Response.json({ id: ADMIN_ID, email: 'admin@example.com', app_metadata: { role: 'admin' } });
      }
      if (bearer === 'other-jwt') {
        return Response.json({ id: OTHER_USER_ID, email: 'other@example.com', app_metadata: { role: 'user' } });
      }
      return Response.json({ id: USER_ID, email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: { full_name: 'Kreator Musik' } });
    }
    if (url.pathname === '/rest/v1/profiles') {
      return Response.json([
        { id: USER_ID, status: 'active', email: 'creator@example.com', full_name: 'Kreator Musik' },
        { id: ADMIN_ID, status: 'active', email: 'admin@example.com', full_name: 'Admin BLEA' },
      ]);
    }
    if (url.pathname === '/rest/v1/provider_api_keys') return Response.json([]);
    if (url.pathname === '/rest/v1/provider_models') {
      const prov = url.searchParams.get('provider')?.replace(/^eq\./, '');
      const activeEq = url.searchParams.get('active')?.replace(/^eq\./, '');
      return Response.json(providerModels.filter((r) => {
        if (prov && r.provider !== prov) return false;
        if (activeEq === 'true' && r.active !== true) return false;
        return true;
      }));
    }
    if (url.pathname === '/rest/v1/credit_model_prices') {
      const prov = url.searchParams.get('provider')?.replace(/^eq\./, '');
      const model = url.searchParams.get('model')?.replace(/^eq\./, '');
      const modality = url.searchParams.get('modality')?.replace(/^eq\./, '');
      const activeEq = url.searchParams.get('active')?.replace(/^eq\./, '');
      return Response.json(creditPrices.filter((p) => {
        if (prov && p.provider !== prov) return false;
        if (model && p.model !== model) return false;
        if (modality && p.modality !== modality) return false;
        if (activeEq === 'true' && p.active !== true) return false;
        return true;
      }));
    }
    if (url.pathname === '/rest/v1/freebeat_oauth_accounts') {
      if (method === 'GET') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const enabledEq = url.searchParams.get('enabled')?.replace(/^eq\./, '');
        let rows = poolRows.slice();
        if (idEq) rows = rows.filter((r) => r.id === idEq);
        if (enabledEq === 'true') rows = rows.filter((r) => r.enabled !== false);
        rows.sort((a, b) => (a.priority || 0) - (b.priority || 0));
        return Response.json(rows);
      }
      if (method === 'POST') {
        const b = jsonBody();
        const created = {
          id: b.id || `aaaaaaaa-aaaa-4aaa-8aaa-${String(seqId++).padStart(12, '0')}`,
          account_email: b.account_email ?? '',
          account_label: b.account_label ?? '',
          connected_by: b.connected_by ?? ADMIN_ID,
          sealed_session: b.sealed_session,
          image_access: b.image_access === true,
          enabled: b.enabled !== false,
          priority: b.priority ?? 10,
          consecutive_failures: b.consecutive_failures ?? 0,
          last_error: b.last_error ?? null,
          issued_at: b.issued_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
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
    }
    if (url.pathname === '/rest/v1/freebeat_provider_sessions') {
      if (method === 'POST') {
        const b = jsonBody();
        legacySessions.set(b.user_id, b);
        return Response.json([b]);
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
    if (url.pathname === '/rest/v1/video_generations' || url.pathname === '/rest/v1/image_generations' || url.pathname === '/rest/v1/metadata_jobs') {
      return Response.json([]);
    }
    if (url.pathname === '/rest/v1/music_generations') {
      if (method === 'GET') {
        const rawStatus = url.searchParams.get('status') || '';
        const idEq = url.searchParams.get('id')?.startsWith('eq.') ? url.searchParams.get('id').slice(3) : null;
        const userEq = url.searchParams.get('user_id')?.startsWith('eq.') ? url.searchParams.get('user_id').slice(3) : null;
        const statusEq = rawStatus.startsWith('eq.') ? rawStatus.slice(3) : null;
        const statusIn = rawStatus.match(/^in\.\(([^)]+)\)$/)?.[1]?.split(',');
        let rows = musicRows.slice();
        if (idEq) rows = rows.filter((r) => r.id === idEq);
        if (userEq) rows = rows.filter((r) => r.user_id === userEq);
        if (statusEq) rows = rows.filter((r) => r.status === statusEq);
        if (statusIn) rows = rows.filter((r) => statusIn.includes(r.status));
        rows.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        return Response.json(rows);
      }
      if (method === 'POST') {
        const b = {
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          credits_refunded: 0,
          ...jsonBody(),
        };
        musicRows.push(b);
        return Response.json([b]);
      }
      if (method === 'PATCH') {
        const idEq = url.searchParams.get('id')?.replace(/^eq\./, '');
        const refundGuard = url.searchParams.get('credits_refunded');
        const statusIn = url.searchParams.get('status')?.match(/^in\.\(([^)]+)\)$/)?.[1]?.split(',');
        const b = jsonBody();
        const row = musicRows.find((r) => r.id === idEq);
        if (!row) return Response.json([]);
        if (refundGuard === 'eq.0' && Number(row.credits_refunded || 0) !== 0) return Response.json([]);
        if (statusIn && !statusIn.includes(row.status)) return Response.json([]);
        Object.assign(row, b);
        return Response.json([row]);
      }
    }
    if (url.href === 'https://freebeat.ai/oauth/register') return Response.json({ client_id: 'client-1' });
    if (url.href === 'https://freebeat.ai/oauth/token') {
      const params = new URLSearchParams(String(init.body || ''));
      const code = params.get('code') || '';
      const email = decodeURIComponent(code.replace(/^code-for-/, '')) || 'pool@freebeat.test';
      return Response.json({
        access_token: `tok-${email}`,
        refresh_token: `ref-${email}`,
        expires_in: 3600,
        scope: 'freebeat:read freebeat:generate',
      });
    }
    if (url.href === 'https://freebeat.ai/api/mcp') {
      const token = (init.headers?.authorization || '').replace(/^Bearer\s+/i, '');
      const rpc = jsonBody();
      if (rpc.method === 'initialize') {
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26' } }, {
          status: 200,
          headers: { 'content-type': 'application/json', 'mcp-session-id': `sess-${token}` },
        });
      }
      if (rpc.method === 'notifications/initialized') return new Response('', { status: 202 });
      const tool = rpc.params?.name;
      const args = rpc.params?.arguments || {};
      mcpCalls.push({ token, tool, args });
      if (onMcpCall) return onMcpCall({ token, tool, args, id: rpc.id });
      return mcpSuccess(rpc.id, {});
    }
    if (url.hostname === 'cdn.freebeat.test' || url.hostname === 'evil.example') {
      mediaFetches.push({ url: url.href, method, headers: init.headers || {} });
      if (onMediaFetch) return onMediaFetch({ url, method, headers: init.headers || {} });
      return new Response('not found', { status: 404 });
    }
    throw new Error(`Unexpected fetch: ${method} ${url.href}`);
  };

  return {
    env,
    poolRows,
    musicRows,
    spends,
    refunds,
    mcpCalls,
    mediaFetches,
    cleanup() { globalThis.fetch = realFetch; },
  };
}

async function connectPoolAccount(h, { email, label = '' }) {
  const startRes = await worker.fetch(apiRequest('/api/freebeat/start', {
    token: 'admin-jwt',
    body: { email, label, returnTo: '/admin?tab=freebeat-oauth' },
  }), h.env);
  assert.equal(startRes.status, 200);
  const { url } = await startRes.json();
  const state = new URL(url).searchParams.get('state');
  const pendingCookie = (startRes.headers.get('set-cookie') || '').split(';')[0];
  const cbRes = await worker.fetch(new Request(`${BASE}/api/freebeat/callback?code=${encodeURIComponent(`code-for-${email}`)}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: pendingCookie },
  }), h.env);
  assert.equal(cbRes.status, 303);
}

test('SQL migration 20261205000000_freebeat_consumer_music adds music modality, music_generations constraints, seed #129, and owner/admin RLS', async () => {
  const pmSql = await fs.readFile(new URL('../supabase/migrations/20261111000006_create_provider_models_and_uploads_bucket.sql', import.meta.url), 'utf8');
  const cwSql = await fs.readFile(new URL('../supabase/migrations/20261118000003_create_credit_wallets.sql', import.meta.url), 'utf8');
  const modSql = await fs.readFile(new URL('../supabase/migrations/20261131000000_expand_credit_model_prices_modality.sql', import.meta.url), 'utf8');
  const musicSql = await fs.readFile(new URL('../supabase/migrations/20261205000000_freebeat_consumer_music.sql', import.meta.url), 'utf8');

  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
      CREATE TABLE storage.objects (id uuid PRIMARY KEY, bucket_id text, name text);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $$;
      INSERT INTO auth.users (id) VALUES ('${USER_ID}'), ('${OTHER_USER_ID}'), ('${ADMIN_ID}');
      CREATE OR REPLACE FUNCTION public.set_projects_updated_at() RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean AS $$ SELECT coalesce(current_setting('request.jwt.claim.role', true) = 'admin', false); $$ LANGUAGE sql;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid; $$ LANGUAGE sql;
    `);
    await db.exec(pmSql);
    await db.exec(cwSql);
    await db.exec(modSql);
    await db.exec(musicSql);

    // Seed 129 active in provider_models and 1000 credits in credit_model_prices
    const seedRes = await db.query(`
      SELECT pm.provider, pm.model, pm.active AS pm_active, cmp.modality, cmp.credits, cmp.active AS cmp_active
      FROM public.provider_models pm
      JOIN public.credit_model_prices cmp ON cmp.provider = pm.provider AND cmp.model = pm.model
      WHERE pm.provider = 'freebeat' AND pm.model = '129';
    `);
    assert.equal(seedRes.rows.length, 1);
    assert.equal(seedRes.rows[0].pm_active, true);
    assert.equal(seedRes.rows[0].modality, 'music');
    assert.equal(seedRes.rows[0].credits, 1000);
    assert.equal(seedRes.rows[0].cmp_active, true);

    // Constraints on duration_seconds and status
    await assert.rejects(
      db.exec(`INSERT INTO public.music_generations (user_id, model, prompt, duration_seconds) VALUES ('${USER_ID}', '129', 'Beat', 5);`),
      /music_generations_duration_seconds_check/,
    );
    await assert.rejects(
      db.exec(`INSERT INTO public.music_generations (user_id, model, prompt, status) VALUES ('${USER_ID}', '129', 'Beat', 'weird');`),
      /music_generations_status_check/,
    );

    // Owner/admin RLS SELECT only (wrap each role switch in explicit BEGIN/COMMIT so SET LOCAL holds)
    await db.exec(`
      INSERT INTO public.music_generations (id, user_id, model, model_name, prompt, credits_charged, status)
      VALUES ('33333333-3333-4333-8333-333333333333', '${USER_ID}', '129', 'Lyria 3 Pro', 'Synth anthem', 1000, 'completed');
    `);
    await db.exec(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${USER_ID}', true); SELECT set_config('request.jwt.claim.role', 'user', true);`);
    const ownRows = await db.query(`SELECT id FROM public.music_generations`);
    await db.exec(`COMMIT;`);
    assert.equal(ownRows.rows.length, 1);

    await db.exec(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${OTHER_USER_ID}', true); SELECT set_config('request.jwt.claim.role', 'user', true);`);
    const otherRows = await db.query(`SELECT id FROM public.music_generations`);
    await db.exec(`COMMIT;`);
    assert.equal(otherRows.rows.length, 0);

    await db.exec(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${ADMIN_ID}', true); SELECT set_config('request.jwt.claim.role', 'admin', true);`);
    const adminRows = await db.query(`SELECT id FROM public.music_generations`);
    await assert.rejects(
      db.exec(`INSERT INTO public.music_generations (user_id, model, prompt) VALUES ('${ADMIN_ID}', '129', 'Blocked direct insert');`),
      /permission denied/,
    );
    await db.exec(`ROLLBACK;`);
    assert.equal(adminRows.rows.length, 1);
  } finally {
    await db.close();
  }
});

test('Worker filters music modality out of Chat, classifies Music in /api/catalog, and warns admin on unpriced active music models', async () => {
  const h = createMusicHarness({
    providerModels: [
      { provider: 'unorouter', model: 'gpt-oss-120b:free', active: true },
      { provider: 'freebeat', model: '129', active: true },
      { provider: 'freebeat', model: '130', active: true },
    ],
    creditPrices: [
      { provider: 'freebeat', model: '129', modality: 'music', credits: 1000, active: true },
    ],
    onMcpCall({ id, tool }) {
      if (tool === 'list_music_models') {
        return mcpSuccess(id, {
          models: [
            { model_id: 129, name: 'Lyria 3 Pro', available: true, pricing: { status: 'quoted', credits: 42 }, supports_duration: false },
            { model_id: 194, name: 'Suno v6', available: true, pricing: { status: 'quoted', credits: 73 }, supports_duration: false },
            { model_id: 130, name: 'MiniMax Music 3', available: true, pricing: { status: 'quoted', credits: 78 }, supports_duration: false },
          ],
        });
      }
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectPoolAccount(h, { email: 'pool1@freebeat.test' });

    // Chat /api/enabled-models must never show music models (#129, #130)
    const chatRes = await worker.fetch(apiRequest('/api/enabled-models', { method: 'GET', token: null }), h.env);
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.models.includes('129'), false);
    assert.equal(chatData.models.includes('130'), false);
    assert.ok(chatData.models.includes('gpt-oss-120b:free'));

    // /api/catalog?provider=freebeat maps music models under category "Music"
    const catRes = await worker.fetch(apiRequest('/api/catalog?provider=freebeat', { method: 'GET', token: 'admin-jwt' }), h.env);
    assert.equal(catRes.status, 200);
    const catData = await catRes.json();
    const m129 = catData.models.find((m) => m.id === '129');
    const m194 = catData.models.find((m) => m.id === '194');
    assert.equal(m129?.category, 'Music');
    assert.equal(m194?.category, 'Music');

    // Consumer /api/music/config omits unpriced #130, hides freebeat_unpriced, and exposes capability flags at top-level & params
    const userCfgRes = await worker.fetch(apiRequest('/api/music/config', { method: 'GET', token: 'user-jwt' }), h.env);
    assert.equal(userCfgRes.status, 200);
    const userCfg = await userCfgRes.json();
    assert.equal(userCfg.provider_ready, true);
    assert.deepEqual(userCfg.models.map((m) => m.model), ['129']);
    assert.equal(userCfg.models[0].credits, 1000);
    assert.equal(userCfg.models[0].supports_duration, false);
    assert.equal(userCfg.models[0].requires_lyrics, false);
    assert.equal(userCfg.models[0].params.supports_duration, false);
    assert.equal(userCfg.freebeat_unpriced, undefined);

    // Admin /api/music/config reveals freebeat_unpriced warning for #130
    const adminCfgRes = await worker.fetch(apiRequest('/api/music/config', { method: 'GET', token: 'admin-jwt' }), h.env);
    assert.equal(adminCfgRes.status, 200);
    const adminCfg = await adminCfgRes.json();
    assert.ok(adminCfg.freebeat_unpriced.some((m) => m.model === '130'));
  } finally {
    h.cleanup();
  }
});

test('Worker /api/music/generate validates parameters, fails over pool accounts, refunds on failure, and streams/refreshes /api/music/content/:id', async () => {
  let activeMcpResultUrl = 'https://cdn.freebeat.test/expired.mp3';
  let refreshed = false;

  const h = createMusicHarness({
    onMcpCall({ id, token, tool, args }) {
      if (tool === 'list_music_models') {
        return mcpSuccess(id, {
          models: [
            { model_id: 129, name: 'Lyria 3 Pro', available: true, pricing: { status: 'quoted', credits: 42 }, supports_duration: false, supports_lyrics: true, supports_instrumental: true, requires_lyrics: false },
            { model_id: 194, name: 'Suno v6', available: true, pricing: { status: 'quoted', credits: 73 }, supports_duration: false, supports_lyrics: true, supports_instrumental: true, requires_lyrics: false },
          ],
        });
      }
      if (tool === 'quote_generation') {
        assert.equal(args.tool, 'generate_music');
        if (args.parameters?.model_id === 194) return mcpSuccess(id, { status: 'quoted', credits: 73 });
        return mcpSuccess(id, { status: 'quoted', credits: 42 });
      }
      if (tool === 'generate_music') {
        assert.equal(typeof args.max_credits, 'number');
        assert.equal('accept_unknown_cost' in args, false);
        if (token === 'tok-acct1@freebeat.test') {
          return mcpBalanceExhausted(id, 'Out of credits on account 1');
        }
        return mcpSuccess(id, { task_id: 'mus-task-999', status: 'queued' });
      }
      if (tool === 'get_task_status') {
        return mcpSuccess(id, {
          status: 'completed',
          message: 'Task result ready. Next step: use get_task_result.',
          billing: { charged: 73, refunded: 0, net: 73 },
        });
      }
      if (tool === 'get_task_result') {
        if (refreshed) activeMcpResultUrl = 'https://cdn.freebeat.test/fresh.mp3';
        return mcpSuccess(id, {
          status: 'completed',
          result: {
            music_id: 2501106,
            title: 'Neon Highway',
            duration_ms: 142000,
            audio_url: activeMcpResultUrl,
            cover_url: 'https://cdn.freebeat.test/cover.jpg',
          },
          billing: { charged: 73, refunded: 0, net: 73 },
        });
      }
      return mcpSuccess(id, {});
    },
    onMediaFetch({ url, method, headers }) {
      if (url.pathname === '/expired.mp3') {
        refreshed = true;
        return new Response('Expired', { status: 403 });
      }
      if (url.pathname === '/fresh.mp3') {
        const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44]);
        if (headers.range === 'bytes=0-5') {
          return new Response(method === 'HEAD' ? null : bytes.slice(0, 6), {
            status: 206,
            headers: {
              'content-type': 'audio/mpeg',
              'content-length': '6',
              'content-range': 'bytes 0-5/10',
              'accept-ranges': 'bytes',
            },
          });
        }
        return new Response(method === 'HEAD' ? null : bytes, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length) },
        });
      }
      if (url.pathname === '/cover.jpg') {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });

  try {
    await connectPoolAccount(h, { email: 'acct1@freebeat.test' });
    await connectPoolAccount(h, { email: 'acct2@freebeat.test' });

    // Validation: cannot pass instrumental=true and lyrics together
    const badCombo = await worker.fetch(apiRequest('/api/music/generate', {
      body: { model: '194', prompt: 'Night drive', instrumental: true, lyrics: 'Hello' },
    }), h.env);
    assert.equal(badCombo.status, 400);

    // Validation: duration_seconds rejected when model reports supports_duration=false
    const badDur = await worker.fetch(apiRequest('/api/music/generate', {
      body: { model: '194', prompt: 'Night drive', duration_seconds: 60 },
    }), h.env);
    assert.equal(badDur.status, 400);

    // Validation: unpriced model 130 rejected 409 before spend_credits
    const unpricedRes = await worker.fetch(apiRequest('/api/music/generate', {
      body: { model: '130', prompt: 'Night drive' },
    }), h.env);
    assert.equal(unpricedRes.status, 409);
    assert.equal(h.spends.length, 0);

    // Happy path with pool failover: acct1 exhausts balance -> fails over to acct2 and succeeds
    const genRes = await worker.fetch(apiRequest('/api/music/generate', {
      body: { model: '194', prompt: 'Neon highway anthem', lyrics: '[Chorus]\nDrive all night' },
    }), h.env);
    assert.equal(genRes.status, 200);
    const genBody = await genRes.json();
    assert.equal(genBody.status, 'submitted');
    assert.equal(genBody.credits, 1500);
    assert.equal(h.spends.length, 1);
    assert.equal(h.spends[0].p_amount, 1500);
    assert.equal(h.refunds.length, 0);
    assert.equal(genBody.generation.model, '194');
    assert.equal(genBody.generation.model_name, 'Suno v6');

    const rowId = genBody.generation.id;

    // Poll /api/music/status -> completed with signed proxy URLs, raw CDN URLs NEVER exposed
    const stRes = await worker.fetch(apiRequest('/api/music/status', {
      body: { id: rowId },
    }), h.env);
    assert.equal(stRes.status, 200);
    const stText = await stRes.text();
    assert.equal(stText.includes('cdn.freebeat.test'), false, 'raw CDN URL must not leak to consumer');
    const stBody = JSON.parse(stText);
    assert.equal(stBody.generation.status, 'completed');
    assert.equal(stBody.generation.title, 'Neon Highway');
    assert.equal(stBody.generation.duration_ms, 142000);
    assert.equal(stBody.generation.music_id, '2501106');
    assert.match(stBody.generation.audio_stream_url, /^\/api\/music\/content\/.+\?kind=audio&index=0&exp=\d+&sig=/);
    assert.match(stBody.generation.download_url, /download=1/);
    assert.match(stBody.generation.cover_stream_url, /^\/api\/music\/content\/.+\?kind=cover&index=0&exp=\d+&sig=/);

    // Stream audio via signed proxy: upstream returns 403 for expired.mp3 -> refreshes via get_task_result -> serves fresh.mp3 with 206 Range
    const streamRes = await worker.fetch(new Request(`${BASE}${stBody.generation.audio_stream_url}`, {
      method: 'GET',
      headers: { range: 'bytes=0-5' },
    }), h.env);
    assert.equal(streamRes.status, 206);
    assert.equal(streamRes.headers.get('content-type'), 'audio/mpeg');
    assert.equal(streamRes.headers.get('content-range'), 'bytes 0-5/10');
    const bytes = new Uint8Array(await streamRes.arrayBuffer());
    assert.equal(bytes.length, 6);
    assert.equal(h.musicRows[0].audio_url, 'https://cdn.freebeat.test/fresh.mp3');

    // Download audio sets Content-Disposition attachment filename blea-music-...
    const dlRes = await worker.fetch(new Request(`${BASE}${stBody.generation.download_url}`), h.env);
    assert.equal(dlRes.status, 200);
    assert.match(dlRes.headers.get('content-disposition'), /^attachment; filename="blea-music-/);

    // Cover stream succeeds; tampered signature + wrong user denied
    const coverRes = await worker.fetch(new Request(`${BASE}${stBody.generation.cover_stream_url}`), h.env);
    assert.equal(coverRes.status, 200);
    assert.equal(coverRes.headers.get('content-type'), 'image/jpeg');

    const badSigRes = await worker.fetch(new Request(`${BASE}/api/music/content/${rowId}?kind=audio&index=0&exp=9999999999&sig=bad`), h.env);
    assert.equal(badSigRes.status, 401);

    const otherUserRes = await worker.fetch(apiRequest(`/api/music/content/${rowId}?kind=audio`, { method: 'GET', token: 'other-jwt' }), h.env);
    assert.equal(otherUserRes.status, 403);

    // /api/music/history lists completed track with signed proxy URLs
    const histRes = await worker.fetch(apiRequest('/api/music/history', { method: 'GET', token: 'user-jwt' }), h.env);
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json();
    assert.equal(histBody.generations.length, 1);
    assert.ok(histBody.generations[0].audio_stream_url.startsWith('/api/music/content/'));
  } finally {
    h.cleanup();
  }
});

test('Worker refunds BLEA credits atomically on failed poll and supports /api/generations/live + admin cancel for kind=music', async () => {
  const h = createMusicHarness({
    onMcpCall({ id, tool }) {
      if (tool === 'list_music_models') {
        return mcpSuccess(id, {
          models: [{ model_id: 129, name: 'Lyria 3 Pro', available: true, pricing: { status: 'quoted', credits: 42 }, supports_duration: false }],
        });
      }
      if (tool === 'quote_generation') return mcpSuccess(id, { status: 'quoted', credits: 42 });
      if (tool === 'generate_music') return mcpSuccess(id, { task_id: 'mus-task-fail', status: 'queued' });
      if (tool === 'get_task_status') return mcpSuccess(id, { status: 'failed', failure: { reason: 'content_policy' } });
      if (tool === 'get_task_result') return mcpSuccess(id, { status: 'failed', failure: { reason: 'content_policy' } });
      return mcpSuccess(id, {});
    },
  });

  try {
    await connectPoolAccount(h, { email: 'pool1@freebeat.test' });

    const genRes = await worker.fetch(apiRequest('/api/music/generate', {
      body: { model: '129', prompt: 'Song to cancel' },
    }), h.env);
    assert.equal(genRes.status, 200);
    const rowId = (await genRes.json()).generation.id;

    // Live queue before failure shows 1 music item; anonymized for other user, full for admin
    const liveOtherRes = await worker.fetch(apiRequest('/api/generations/live', { body: { poll: false }, token: 'other-jwt' }), h.env);
    assert.equal(liveOtherRes.status, 200);
    const liveOther = await liveOtherRes.json();
    assert.equal(liveOther.counts.music, 1);
    assert.equal(liveOther.items[0].kind, 'music');
    assert.equal(liveOther.items[0].model, 'Lyria 3 Pro');
    assert.equal(liveOther.items[0].prompt, undefined);

    // Admin cancels + refunds active music generation
    const cancelRes = await worker.fetch(apiRequest('/api/admin/generations/cancel', {
      body: { id: rowId, kind: 'music', reason: 'Stuck upstream' },
      token: 'admin-jwt',
    }), h.env);
    assert.equal(cancelRes.status, 200);
    const cancelBody = await cancelRes.json();
    assert.equal(cancelBody.refunded, 1000);
    assert.equal(cancelBody.generation.status, 'cancelled');
    assert.equal(h.refunds.length, 1);
    assert.equal(h.refunds[0].p_generation_id, rowId);

    // Second generation fails on poll -> atomic refund once
    const genRes2 = await worker.fetch(apiRequest('/api/music/generate', {
      body: { model: '129', prompt: 'Song that fails upstream' },
    }), h.env);
    const rowId2 = (await genRes2.json()).generation.id;
    const [st1, st2] = await Promise.all([
      worker.fetch(apiRequest('/api/music/status', { body: { id: rowId2 } }), h.env),
      worker.fetch(apiRequest('/api/music/status', { body: { id: rowId2 } }), h.env),
    ]);
    assert.equal(st1.status, 200);
    assert.equal(st2.status, 200);
    const st1Body = await st1.json();
    assert.equal(st1Body.generation.status, 'failed');
    assert.equal(h.refunds.length, 2, 'atomic credits_refunded=eq.0 claim must refund only once');
  } finally {
    h.cleanup();
  }
});

test('UI renders Generate musik tab, GenerateMusicPanel player, HistoryPage Musik filter, LiveQueuePage Musik stat, and AdminPage Music category', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const realFetch = globalThis.fetch;

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!dom.window.HTMLElement.prototype.scrollIntoView) {
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  }

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });

  const apiCalls = [];
  const musicItem = {
    id: '44444444-4444-4444-8444-444444444444',
    provider: 'freebeat',
    model: '129',
    model_name: 'Lyria 3 Pro',
    prompt: 'Synthwave highway',
    instrumental: false,
    title: 'Neon Road',
    duration_ms: 125000,
    music_id: '2501106',
    status: 'completed',
    credits_charged: 1000,
    credits_refunded: 0,
    created_at: '2026-11-22T12:00:00.000Z',
    has_audio: true,
    has_cover: true,
    audio_stream_url: '/api/music/content/44444444-4444-4444-8444-444444444444?kind=audio&index=0&exp=9999999999&sig=ok',
    download_url: '/api/music/content/44444444-4444-4444-8444-444444444444?kind=audio&index=0&download=1&exp=9999999999&sig=ok',
    cover_stream_url: '/api/music/content/44444444-4444-4444-8444-444444444444?kind=cover&index=0&exp=9999999999&sig=ok',
    cover_download_url: '/api/music/content/44444444-4444-4444-8444-444444444444?kind=cover&index=0&download=1&exp=9999999999&sig=ok',
  };

  let root = null;
  let supabaseRef = null;
  let oldGetSession = null;
  let oldOnAuth = null;
  try {
    const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
    const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
    const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
    const { HistoryPage } = await vite.ssrLoadModule('/src/auth/HistoryPage.jsx');
    const { LiveQueuePage } = await vite.ssrLoadModule('/src/auth/LiveQueuePage.jsx');
    const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
    supabaseRef = supabase;
    oldGetSession = supabase.auth.getSession;
    oldOnAuth = supabase.auth.onAuthStateChange;

    supabase.auth.getSession = async () => ({
      data: { session: { access_token: 'user-jwt', user: { id: USER_ID, email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} } } },
    });
    supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe: () => {} } } });
    supabase.rpc = async () => ({ data: 5000, error: null });
    supabase.from = () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: async () => ({ data: [], error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    };

    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      apiCalls.push(url);
      if (url.includes('/api/account')) return Response.json({ ok: true, status: 'active', blocked: false });
      if (url.includes('/api/video/models')) return Response.json({ ok: true, models: [] });
      if (url.includes('/api/video/history')) return Response.json({ ok: true, generations: [], hasMore: false });
      if (url.includes('/api/image/history')) return Response.json({ ok: true, generations: [] });
      if (url.includes('/api/metadata/history')) return Response.json({ ok: true, jobs: [] });
      if (url.includes('/api/music/config')) {
        return Response.json({
          ok: true,
          provider_ready: true,
          models: [{
            provider: 'freebeat',
            model: '129',
            name: 'Lyria 3 Pro',
            credits: 1000,
            ready: true,
            params: {
              supports_duration: true,
              supports_lyrics: true,
              supports_instrumental: false,
              requires_lyrics: true,
            },
          }],
        });
      }
      if (url.includes('/api/music/history')) return Response.json({ ok: true, generations: [musicItem] });
      if (url.includes('/api/music/generate')) {
        const body = JSON.parse(init.body || '{}');
        assert.equal(body.model, '129');
        return Response.json({
          ok: true,
          status: 'submitted',
          credits: 1000,
          generation: { ...musicItem, id: '55555555-5555-4555-8555-555555555555', status: 'processing', has_audio: false, has_cover: false },
        });
      }
      if (url.includes('/api/generations/live')) {
        return Response.json({
          ok: true,
          is_admin: false,
          server_time: new Date().toISOString(),
          counts: { total: 1, video: 0, image: 0, music: 1, metadata: 0, completed: 0, own: 1, stalled: 0 },
          items: [{
            id: '55555555-5555-4555-8555-555555555555',
            kind: 'music',
            provider: 'freebeat',
            model: 'Lyria 3 Pro',
            status: 'processing',
            credits_charged: 1000,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            is_own: true,
            owner_name: 'Kreator Musik',
            owner_email_masked: 'crea****@example.com',
            prompt: 'Lo-fi dream pop',
            has_external_job: true,
            can_poll: true,
            stalled: false,
          }],
        });
      }
      return Response.json({ ok: true });
    };

    const userSession = { access_token: 'user-jwt', user: { id: USER_ID, email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} } };

    // 1. GeneratePage -> switch to Generate musik tab
    root = createRoot(document.getElementById('root'));
    await React.act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: ['/generate'] }, React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(GeneratePage))));
    });
    const musicTab = [...document.querySelectorAll('button[role="tab"]')].find((b) => b.textContent.trim() === 'Generate musik');
    assert.ok(musicTab, 'GeneratePage must show Generate musik tab');
    await React.act(async () => { musicTab.click(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    assert.match(document.body.textContent, /Lyria 3 Pro/);
    assert.match(document.body.textContent, /Target durasi \(opsional, 10–300 detik\)/);
    assert.match(document.body.textContent, /Lirik lagu \(wajib\)/);
    assert.equal(document.body.textContent.includes('Instrumental (tanpa vokal)'), false);
    assert.equal(document.querySelectorAll('audio').length, 1);
    assert.match(document.body.textContent, /Neon Road/);
    await React.act(async () => { root.unmount(); });
    root = null;

    // 2. HistoryPage -> renders music filter & audio player
    root = createRoot(document.getElementById('root'));
    await React.act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: ['/history'] }, React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(HistoryPage))));
    });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    const musikFilterBtn = [...document.querySelectorAll('.history-filters button')].find((b) => b.textContent.trim() === 'Musik');
    assert.ok(musikFilterBtn, 'HistoryPage must include Musik filter');
    await React.act(async () => { musikFilterBtn.click(); });
    assert.equal(document.querySelectorAll('audio').length, 1);
    assert.match(document.body.textContent, /Neon Road/);
    await React.act(async () => { root.unmount(); });
    root = null;

    // 3. LiveQueuePage -> renders Musik Aktif stat & Musik pill
    root = createRoot(document.getElementById('root'));
    await React.act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: ['/live'] }, React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(LiveQueuePage))));
    });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    assert.match(document.body.textContent, /Musik Aktif/);
    assert.match(document.body.textContent, /Lyria 3 Pro/);
    await React.act(async () => { root.unmount(); });
    root = null;

    // 4. AdminPage source supports Music category & music modality
    const adminSource = await fs.readFile(new URL('../src/auth/AdminPage.jsx', import.meta.url), 'utf8');
    assert.ok(adminSource.includes("'Music'"), 'AdminPage must include Music in CATALOG_CATEGORIES');
    assert.ok(adminSource.includes("id: 'music'"), 'AdminPage must include music modality in CATALOG_MODALITIES');
  } finally {
    if (root) await React.act(async () => { root.unmount(); });
    if (supabaseRef) {
      supabaseRef.auth.getSession = oldGetSession;
      supabaseRef.auth.onAuthStateChange = oldOnAuth;
      await supabaseRef.auth.dispose();
    }
    await vite.close();
    dom.window.close();
    globalThis.fetch = realFetch;
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.localStorage = prevLocalStorage;
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});
