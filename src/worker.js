// BLEA AI — Cloudflare Worker API routes (same-origin, no CORS)
//
// Proxies AI / provider calls server-side, replacing the Supabase edge function
// "ai-chat" (edge runtime on this project returns BOOT_ERROR for all functions).
//
// Routes (all accept POST, some GET):
//   /api/status        -> { ok, configured }            — provider_api_keys has unorouter key
//   /api/verify        -> { valid }                     — chatcompletions.dev key validation
//   /api/models        -> { models: [{id, label}] }     — provider_models where active
//   /api/enabled-models -> { models: [id] }             — active model IDs
//   /api/admin-models  -> { models: [...] }             — all provider_models
//   /api/save-models   -> { ok, saved, activeCount }    — upsert provider_models
//   /api/chat          -> { ok, reply, messageId }      — openrouter.ai proxy + DB save (auth required)
//
// Env vars (set in Wrangler):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL_ENV = (env) => (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');

async function supabaseFetch(env, path, { method = 'GET', token, body, headers = {} } = {}) {
  const url = `${SUPABASE_URL_ENV(env)}${path}`;
  const finalHeaders = {
    apikey: env.SUPABASE_ANON_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function getUser(env, token) {
  const res = await supabaseFetch(env, '/auth/v1/user', { token });
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data?.id ? data : null;
}

async function isAdmin(env, token) {
  const user = await getUser(env, token);
  return user?.app_metadata?.role === 'admin';
}

// Service-role PostgREST client (bypasses RLS — admin panel needs this)
async function servicePostgrest(env, path, options = {}) {
  const url = `${SUPABASE_URL_ENV(env)}/rest/v1${path}`;
  const headers = {
    apikey: env.SUPABASE_ANON_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz',
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'content-type': 'application/json',
    ...(options.headers || {}),
  };
  return fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function handleApi(request, url, env) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method;

  try {
    if (method === 'OPTIONS') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // ---- /status: is UnoRouter configured? ----
    if (path === 'status' && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_api_keys?select=api_key&provider=eq.unorouter&limit=1');
      const rows = await res.json().catch(() => []);
      const configured = !!rows?.[0]?.api_key;
      return jsonResponse({ ok: true, configured });
    }

    // ---- /verify: chat-completions validate API key ----
    if (path === 'verify' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      try {
        const r = await fetch('https://api.chatcompletions.dev/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (body.apiKey ?? '') },
          body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) return jsonResponse({ ok: true, valid: true, verifiedVia: 'chat', modelsCount: 0 });
        const text = await r.text().catch(() => '');
        return jsonResponse({ ok: false, valid: false, status: r.status, error: text.slice(0, 200) });
      } catch (e) {
        return jsonResponse({ ok: false, valid: false, error: String(e) });
      }
    }

    // ---- /models: active models for the chat dropdown (array of model IDs) ----
    if (path === 'models' && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_models?select=model&active=eq.true&order=created_at.desc');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      const models = (rows ?? []).map((m) => m.model);
      return jsonResponse({ models });
    }

    // ---- /enabled-models: active model IDs ----
    if (path === 'enabled-models' && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_models?select=model&active=eq.true&order=created_at.desc');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      return jsonResponse({ models: (rows ?? []).map((m) => m.model) });
    }

    // ---- /catalog: full free model list from UnoRouter (server-side, no API key needed) ----
    if (path === 'catalog' && (method === 'GET' || method === 'POST')) {
      try {
        const upstream = await fetch('https://api.unorouter.com/api/pricing', {
          signal: AbortSignal.timeout(30_000),
        });
        if (!upstream.ok) return jsonResponse({ error: 'Catalog fetch failed', status: upstream.status }, 502);
        const catalog = await upstream.json().catch(() => ({}));
        const rows = Array.isArray(catalog?.data) ? catalog.data : [];
        const models = rows
          .filter((row) => row.is_free && row.online)
          .map((row) => {
            let meta = {};
            try { meta = JSON.parse(row.metadata || '{}'); } catch {}
            const tags = String(row.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
            const mode = meta.mode;
            let category;
            if (mode === 'image') category = 'Image';
            else if (mode === 'embedding') category = 'Embedding';
            else if (mode === 'speech') category = 'Speech';
            else if (mode === 'video') category = 'Video';
            else if (tags.some((t) => t.toLowerCase() === 'text')) category = 'Text';
            else category = 'Other';
            return { id: row.model_name, category, tags, description: row.description || '' };
          });
        return jsonResponse({ models });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 502);
      }
    }

    // ---- /admin-models: full model list (admin) ----
    if (path === 'admin-models' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await isAdmin(env, token))) return jsonResponse({ error: 'admin required' }, 403);
      const res = await servicePostgrest(env, '/provider_models?select=provider,model,active&order=created_at.desc&limit=500');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      const models = (rows ?? []).map((m) => ({ id: m.model, active: m.active, provider: m.provider }));
      return jsonResponse({ models });
    }

    // ---- /save-models: upsert model enablement (admin) ----
    if (path === 'save-models' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await isAdmin(env, token))) return jsonResponse({ error: 'admin required' }, 403);
      const body = await request.json().catch(() => ({}));
      const provider = body.provider ?? 'unorouter';
      const activeIds = Array.isArray(body.models) ? body.models : [];
      // Upsert active list
      let saved = 0;
      for (const model of activeIds) {
        const res = await servicePostgrest(env, `/provider_models?provider=eq.${provider}&model=eq.${encodeURIComponent(model)}`, {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: { provider, model, active: true },
        });
        if (!res.ok) return jsonResponse({ error: 'DB write failed', status: res.status, failed: model }, 500);
        saved++;
      }
      // Deactivate models not in the active list
      const listRes = await servicePostgrest(env, `/provider_models?select=model&provider=eq.${provider}`);
      const existing = await listRes.json().catch(() => []);
      const stale = (existing ?? []).map((m) => m.model).filter((m) => !activeIds.includes(m));
      for (const model of stale) {
        await servicePostgrest(env, `/provider_models?provider=eq.${provider}&model=eq.${encodeURIComponent(model)}`, {
          method: 'PATCH',
          body: { active: false },
        });
      }
      return jsonResponse({ ok: true, saved, activeCount: activeIds.length });
    }

    // ---- /chat: call openrouter, save assistant reply to DB, return JSON (auth required) ----
    if (path === 'chat' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!token) return jsonResponse({ error: 'Missing token' }, 401);
      const user = await getUser(env, token);
      if (!user) return jsonResponse({ error: 'Invalid token' }, 401);
      const body = await request.json().catch(() => ({}));
      // Read admin-configured API key
      const keyRes = await servicePostgrest(env, '/provider_api_keys?select=api_key&provider=eq.unorouter&limit=1');
      const keyRows = await keyRes.json().catch(() => []);
      const apiKey = keyRows?.[0]?.api_key || 'use-free';
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
        if (!upstream.ok) {
          const text = await upstream.text().catch(() => '');
          return jsonResponse({ error: 'Upstream error', status: upstream.status, detail: text.slice(0, 500) }, 502);
        }
        const upstreamData = await upstream.json().catch(() => ({}));
        const reply = upstreamData?.choices?.[0]?.message?.content ?? '';
        // Save assistant message to DB
        const insertRes = await servicePostgrest(env, '/ai_messages', {
          method: 'POST',
          headers: { 'Prefer': 'return=representation' },
          body: {
            conversation_id: body.conversationId,
            user_id: user.id,
            role: 'assistant',
            content: reply,
          },
        });
        let messageId = '';
        if (insertRes.ok) {
          const inserted = await insertRes.json().catch(() => []);
          messageId = inserted?.[0]?.id ?? '';
        }
        return jsonResponse({ ok: true, reply, messageId });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 502);
      }
    }

    return jsonResponse({ error: 'Unknown path', path }, 404);
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      return handleApi(request, url, env);
    }
    // Static assets (SPA)
    return env.ASSETS.fetch(request);
  },
};
