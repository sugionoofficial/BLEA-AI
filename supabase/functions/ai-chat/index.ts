// ai-chat edge function (v10) — UnoRouter proxy to openrouter.ai / chatcompletions.dev
// verify_jwt=false at gateway; function self-verifies JWT via supabase.auth.getUser
import { createClient } from '@supabase/supabase-js';

// Database + edge config
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Service-role client (bypasses RLS for DB reads/writes — admin panel needs this)
const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// CORS preflight — gateway does NOT answer OPTIONS, must be here
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
  'Access-Control-Max-Age': '86400',
};

// GET/POST /status — {configured: bool} — provider_api_keys has unorouter key
// GET/POST /models — {models: [{id, label}]} — provider_models where active=true
// GET/POST /enabled-models — {models: [id]} — active model IDs from provider_models
// GET/POST /admin-models — {models: [...]} — all provider_models (admin)
// POST /save-models — {ok, saved, activeCount} — upsert provider_models (+deactivate missing)
// POST /chat — SSE stream from openrouter (auth required)
// POST /verify — {valid} — chatcompletions.dev API key validation

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'text/plain' } });
    }

    const url = new URL(req.url);
    const path = url.pathname.split('/').filter(Boolean).pop() ?? '';

    // ---- /status: is UnoRouter configured? (provider_api_keys has a key) ----
    if (path === 'status' && (req.method === 'GET' || req.method === 'POST')) {
      const { data, error } = await adminClient
        .from('provider_api_keys')
        .select('api_key')
        .eq('provider', 'unorouter')
        .limit(1)
        .maybeSingle();
      const configured = !!data?.api_key;
      return new Response(JSON.stringify({ ok: true, configured }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      });
    }

    // ---- /verify: chat-completions validate API key (ground truth) ----
    if (path === 'verify' && req.method === 'POST') {
      const { apiKey } = await req.json().catch(() => ({}));
      try {
        const r = await fetch('https://api.chatcompletions.dev/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (apiKey ?? '') },
          body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) return new Response(JSON.stringify({ ok: true, valid: true, verifiedVia: 'chat', modelsCount: 0 }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
        const text = await r.text().catch(() => '');
        return new Response(JSON.stringify({ ok: false, valid: false, status: r.status, error: text.slice(0, 200) }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, valid: false, error: String(e) }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      }
    }

    // ---- /models: active models for the chat dropdown (array of model IDs) ----
    if (path === 'models' && (req.method === 'GET' || req.method === 'POST')) {
      const { data, error } = await adminClient
        .from('provider_models')
        .select('model')
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      const models = (data ?? []).map((m) => m.model);
      return new Response(JSON.stringify({ models }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
    }

    // ---- /enabled-models: active model IDs (AI Studio dropdown) ----
    if (path === 'enabled-models' && (req.method === 'GET' || req.method === 'POST')) {
      const { data, error } = await adminClient
        .from('provider_models')
        .select('model')
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ models: (data ?? []).map((m) => m.model) }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
    }

    // ---- /admin-models: full model list (admin panel) ----
    if (path === 'admin-models' && (req.method === 'GET' || req.method === 'POST')) {
      const { data, error } = await adminClient.from('provider_models').select('provider, model, active').order('created_at', { ascending: false }).limit(500);
      if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      const models = (data ?? []).map((m) => ({ id: m.model, active: m.active, provider: m.provider }));
      return new Response(JSON.stringify({ models }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
    }

    // ---- /save-models: upsert model enablement (POST body {provider, models: [ids]}) ----
    if (path === 'save-models' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const provider = body.provider ?? 'unorouter';
      const activeIds = Array.isArray(body.models) ? body.models : [];
      // Upsert active list
      let saved = 0;
      for (const model of activeIds) {
        const { error } = await adminClient.from('provider_models').upsert(
          { provider, model, active: true },
          { onConflict: 'provider, model' }
        );
        if (error) return new Response(JSON.stringify({ error: error.message, failed: model }), { status: 500, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
        saved++;
      }
      // Deactivate models not in the active list
      const { data: existing } = await adminClient.from('provider_models').select('model').eq('provider', provider);
      const stale = (existing ?? []).map((m) => m.model).filter((m) => !activeIds.includes(m));
      for (const model of stale) {
        await adminClient.from('provider_models').update({ active: false }).eq('provider', provider).eq('model', model);
      }
      return new Response(JSON.stringify({ ok: true, saved, activeCount: activeIds.length }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
    }

    // ---- /chat: call openrouter, save assistant reply to DB, return JSON (auth required) ----
    if (path === 'chat' && req.method === 'POST') {
      const authHeader = req.headers.get('authorization') ?? '';
      const token = authHeader.replace(/^Bearer\s+/i, '');
      if (!token) return new Response(JSON.stringify({ error: 'Missing token' }), { status: 401, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
      if (userErr || !userData?.user) return new Response(JSON.stringify({ error: 'Invalid token' }), { status: 401, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      const body = await req.json().catch(() => ({}));
      // Read admin-configured API key
      const { data: keyRow } = await adminClient.from('provider_api_keys').select('api_key').eq('provider', 'unorouter').limit(1).maybeSingle();
      const apiKey = keyRow?.api_key || 'use-free';
      const fetchBody = { ...body, api_key: apiKey, model: body.model, messages: body.messages, stream: false };
      delete fetchBody.apiKey;
      delete fetchBody.apiUrl;
      try {
        const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey, 'HTTP-Referer': 'https://blea-ai.blea-ai.workers.dev', 'X-Title': 'BLEA AI' },
          body: JSON.stringify(fetchBody),
          signal: AbortSignal.timeout(120_000),
        });
        if (!upstream.ok) { const text = await upstream.text().catch(() => ''); return new Response(JSON.stringify({ error: 'Upstream error', status: upstream.status, detail: text.slice(0, 500) }), { status: 502, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } }); }
        const upstreamData = await upstream.json().catch(() => ({}));
        const reply = upstreamData?.choices?.[0]?.message?.content ?? '';
        // Save assistant message to DB
        const { data: inserted } = await adminClient.from('ai_messages').insert({
          conversation_id: body.conversationId,
          user_id: userData.user.id,
          role: 'assistant',
          content: reply,
        }).select('id').single();
        return new Response(JSON.stringify({ ok: true, reply, messageId: inserted?.id ?? '' }), { status: 200, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
      }
    }

    return new Response(JSON.stringify({ error: 'Unknown path', path }), { status: 404, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS_HEADERS, 'content-type': 'application/json' } });
  }
});
