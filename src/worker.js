// BLEA AI — Cloudflare Worker API routes (same-origin, no CORS)
//
// Proxies AI / provider calls server-side, replacing the Supabase edge function
// "ai-chat" (edge runtime on this project returns BOOT_ERROR for all functions).
//
// Routes (all accept POST, some GET):
//   /api/status        -> { ok, configured }            — provider_api_keys has unorouter key
//   /api/verify        -> { valid }                     — UnoRouter gateway key validation
//   /api/models        -> { models: [{id, label}] }     — provider_models where active
//   /api/enabled-models -> { models: [id] }             — active model IDs
//   /api/admin-models  -> { models: [...] }             — all provider_models
//   /api/save-models   -> { ok, saved, activeCount }    — upsert provider_models
//   /api/chat          -> { ok, reply, messageId }      — UnoRouter gateway proxy + DB save (auth required)
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

// BLEA AI — system prompt untuk mode agen (mandiri, cerdas, tanggap, akses
// internet, koneksi ke berbagai app). Disuntikkan ke /api/chat.
const AGENT_SYSTEM_PROMPT = [
  'Kamu adalah BLEA AI, agen mandiri di dalam BLEA AI Studio. Prinsip kerja:',
  '- Mandiri: bekerja sendiri, mengambil keputusan dan langkah yang diperlukan tanpa diminta langkah demi langkah.',
  '- Cerdas: analitis dan logis; jawaban akurat, terstruktur, dengan prioritas informasi yang penting.',
  '- Tanggap: pahami konteks percakapan; ikuti bahasa pengguna (Bahasa Indonesia bila pengguna berbicara Bahasa Indonesia); langsung pada inti.',
  '- Akses internet: kamu memiliki akses ke hasil pencarian web terkini (disertakan dalam pesan pengguna). Gunakan hasil tersebut untuk pertanyaan tentang berita, harga, peristiwa terbaru, atau informasi yang membutuhkan data terkini. Sebutkan sumber bila mengutip.',
  '- Koneksi ke berbagai app: kamu dapat terhubung ke aplikasi seperti Notion, Slack, dan GitHub. Bila pengguna meminta manajemen catatan, dokumen, saluran, atau repository, berikan bantuan sesuai kapabilitas aplikasi tersebut.',
  '- Format: jawaban normal berupa teks biasa tanpa blok. Bila kamu memberikan kode, script, atau prompt, bungkus dalam blok kode (```) — pengguna menampilkannya dalam blok merah yang dapat disalin.',
].join(' ');

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    .trim();
}

// Web search server-side: DuckDuckGo HTML (umum) + Wikipedia (fallback).
async function webSearch(query) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'user-agent': ua, accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const html = await res.text();
      const results = [];
      const re = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,500}?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = re.exec(html)) && results.length < 6) {
        let href = match[1];
        try {
          const parsed = new URL(href, 'https://duckduckgo.com');
          href = parsed.searchParams.get('uddg') || href;
        } catch {}
        const title = stripHtmlTags(match[2]);
        const snippet = stripHtmlTags(match[3]);
        if (title && href) results.push({ title, url: href, snippet, source: 'duckduckgo' });
      }
      if (results.length) return results;
    }
  } catch {}
  try {
    const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    const rows = data?.query?.search || [];
    return rows.map((row) => ({
      title: row.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(row.title.replace(/ /g, '_'))}`,
      snippet: stripHtmlTags(row.snippet || ''),
      source: 'wikipedia',
    }));
  } catch {}
  return [];
}

// GitHub OAuth — OAuth App dibuat manual di
// https://github.com/settings/developers (name: BLEA AI Studio,
// callback: https://blea-ai.blea-ai.workers.dev/auth/github/callback).
// Client ID di wrangler vars; client secret di Cloudflare secret
// GITHUB_CLIENT_SECRET. Scope: repo (full — read/write/push/PR/deploy).
const GITHUB_SCOPE = 'repo workflow';

// Prompt alat GitHub untuk agen — dikirim bila chat dengan github=true.
const GITHUB_TOOLS_PROMPT = [
  'Kamu memiliki alat GitHub yang dapat dijalankan. Bila perlu bertindak di GitHub (baca, tulis, hapus, commit, push, PR, merge, deploy), balas dengan blok alat, lalu jelaskan hasilnya secara natural.',
  'Format alat (blok ```tool, JSON):',
  '```tool',
  '{"name": "github_read", "arguments": {"path": "src/app.js"}}',
  '```',
  'Alat tersedia:',
  '- github_repos: {} — daftar repository pengguna',
  '- github_read: {path, branch?} — baca file/folder',
  '- github_write: {path, content, message?, branch?} — tulis/edit file (commit)',
  '- github_delete: {path, message?, branch?} — hapus file',
  '- github_commit: {message, entries: [{path, content, mode?, type?}], branch?} — commit batch',
  '- github_push: {branch, sha, force?} — push commit ke branch',
  '- github_pr: {head, base?, title, body?} — buat pull request',
  '- github_prs: {} — daftar pull request',
  '- github_pr_merge: {number, method?} — merge pull request',
  '- github_deploy: {ref?} — build & deploy (trigger CI workflow)',
  'Catatan: path relatif root repo; owner/repo default sugionoofficial/BLEA-AI; branch default main. Gunakan alat hanya bila pengguna meminta tindakan di GitHub.',
].join(' ');

function githubTokenFromCookie(request) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/blea_github_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

async function githubApi(request, path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  const token = githubTokenFromCookie(request);
  if (!token) return { ok: false, status: 401, data: { error: 'GitHub tidak terhubung' } };
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept,
      'content-type': 'application/json',
      'user-agent': 'blea-ai-studio',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function exchangeGithubCode(code, env) {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'blea-ai-studio' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.json().catch(() => ({}));
}

// Eksekusi alat GitHub agen. toolPath = nama alat.
async function executeGithubTool(request, toolPath, args, env) {
  const gh = (p, opts) => githubApi(request, p, opts);
  try {
    if (toolPath === 'repos') {
      const { ok, data } = await gh('/user/repos?per_page=100&sort=updated');
      return { ok, data: ok ? (data || []).map((r) => ({ full_name: r.full_name, default_branch: r.default_branch, pushed_at: r.pushed_at })) : data };
    }
    if (toolPath === 'read') {
      const relPath = String(args.path || '').replace(/^\/+/, '');
      const encoded = relPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      const ref = args.branch || args.ref || 'main';
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
      return { ok, data };
    }
    if (toolPath === 'write') {
      const relPath = String(args.path || '').replace(/^\/+/, '');
      const encoded = relPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      const ref = args.branch || args.ref || 'main';
      const { data: existing } = await gh(`/repos/${args.owner}/${args.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
      const content = Buffer.from(String(args.content ?? ''), 'utf8').toString('base64');
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/contents/${encoded}`, {
        method: 'PUT',
        body: {
          message: String(args.message || `Update ${relPath}`),
          content,
          branch: ref,
          ...(existing?.sha ? { sha: existing.sha } : {}),
        },
      });
      return { ok, data };
    }
    if (toolPath === 'delete') {
      const relPath = String(args.path || '').replace(/^\/+/, '');
      const encoded = relPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      const ref = args.branch || args.ref || 'main';
      const { data: existing } = await gh(`/repos/${args.owner}/${args.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`);
      if (!existing?.sha) return { ok: false, data: { error: 'File tidak ditemukan' } };
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/contents/${encoded}`, {
        method: 'DELETE',
        body: { message: String(args.message || `Delete ${relPath}`), sha: existing.sha, branch: ref },
      });
      return { ok, data };
    }
    if (toolPath === 'commit') {
      const branch = args.branch || args.ref || 'main';
      const { data: refData } = await gh(`/repos/${args.owner}/${args.repo}/git/ref/heads/${branch}`);
      const baseSha = refData?.object?.sha;
      if (!baseSha) return { ok: false, data: { error: `Branch ${branch} tidak ditemukan` } };
      const { data: baseCommit } = await gh(`/repos/${args.owner}/${args.repo}/git/commits/${baseSha}`);
      const { ok: treeOk, data: treeData } = await gh(`/repos/${args.owner}/${args.repo}/git/trees`, {
        method: 'POST',
        body: {
          base_tree: baseCommit?.tree?.sha,
          tree: (Array.isArray(args.entries) ? args.entries : []).map((entry) => ({
            path: entry.path,
            mode: entry.mode || '100644',
            type: entry.type || 'blob',
            ...(entry.content !== undefined ? { content: Buffer.from(String(entry.content), 'utf8').toString('base64') } : {}),
            ...(entry.sha ? { sha: entry.sha } : {}),
          })),
        },
      });
      const treeSha = treeData?.tree?.[0]?.sha;
      if (!treeSha) return { ok: false, data: { error: treeOk ? 'Tree kosong' : (treeData?.message || 'Tree gagal') } };
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/git/commits`, {
        method: 'POST',
        body: { message: String(args.message || 'Commit'), tree: treeSha, parents: [baseSha] },
      });
      return { ok, data };
    }
    if (toolPath === 'push') {
      const branch = args.branch || args.ref || 'main';
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/git/refs/heads/${branch}`, {
        method: 'PATCH',
        body: { sha: args.sha, force: !!args.force },
      });
      return { ok, data };
    }
    if (toolPath === 'pr') {
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/pulls`, {
        method: 'POST',
        body: {
          head: args.head,
          base: args.base || 'main',
          title: String(args.title || 'Update'),
          body: String(args.body || ''),
        },
      });
      return { ok, data };
    }
    if (toolPath === 'prs') {
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/pulls?state=all&per_page=20`);
      return { ok, data };
    }
    if (toolPath === 'pr_merge') {
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/pulls/${args.number}/merge`, {
        method: 'PUT',
        body: { merge_method: args.method || 'squash' },
      });
      return { ok, data };
    }
    if (toolPath === 'deploy') {
      const workflowId = args.workflow_id || 'main.yml';
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/actions/workflows/${workflowId}/dispatches`, {
        method: 'POST',
        body: { ref: args.ref || 'main' },
      });
      return { ok, data };
    }
    return { ok: false, data: { error: `Unknown tool: ${toolPath}` } };
  } catch (e) {
    return { ok: false, data: { error: String(e) } };
  }
}

function parseToolCalls(text) {
  const calls = [];
  const re = /```tool\s*(\{[\s\S]*?\})\s*```/g;
  let match;
  while ((match = re.exec(String(text || ''))) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed?.name) calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
    } catch { /* skip malformed */ }
  }
  return calls;
}

function summarizeTool(name, result) {
  if (!result?.ok) return String(result?.data?.error || result?.data?.message || 'gagal');
  const d = result.data;
  if (Array.isArray(d)) return `${d.length} entri`;
  switch (name) {
    case 'repos': return `${(d || []).length} repo`;
    case 'read': return d?.type === 'dir' || Array.isArray(d) ? 'folder' : `file (${d?.size || 0} bytes)`;
    case 'write': return `commit ${d?.commit?.sha ? d.commit.sha.slice(0, 7) : 'ok'}`;
    case 'delete': return 'file dihapus';
    case 'commit': return `commit ${d?.sha ? d.sha.slice(0, 7) : 'ok'}`;
    case 'push': return 'branch diperbarui';
    case 'pr': return `PR #${d?.number || '?'} — ${d?.title || ''}`;
    case 'prs': return `${(d || []).length} PR`;
    case 'pr_merge': return d?.merged ? `PR #${d?.number || '?'} dimerge` : 'gagal merge';
    case 'deploy': return 'deploy di-trigger';
    default: return 'ok';
  }
}

async function handleGithubCallback(request, url, env) {
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const fail = (message) => new Response(`<!doctype html><meta charset="utf-8"><h1>Koneksi GitHub gagal</h1><p>${message}</p><a href="/app/studio">Kembali ke AI Studio</a>`, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (error) return fail(error);
  if (!code) return fail('Missing code');
  const tokenData = await exchangeGithubCode(code, env);
  const accessToken = tokenData?.access_token;
  if (!accessToken) return fail(String(tokenData?.error_description || tokenData?.error || 'Token tidak diperoleh'));
  return new Response('<!doctype html><meta charset="utf-8"><h1>GitHub terhubung!</h1><a href="/app/studio">Lanjut ke AI Studio</a>', {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': `blea_github_token=${encodeURIComponent(accessToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    },
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
      // UnoRouter gateway (OpenAI-compatible) — key yang disimpan provider
      // 'unorouter' adalah gateway key, bukan OpenRouter key.
      const baseUrl = (body.baseUrl || 'https://api.unorouter.com/v1/chat/completions').replace(/\/+$/, '');
      try {
        const r = await fetch(baseUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (body.apiKey ?? '') },
          body: JSON.stringify({ model: 'gpt-oss-120b:free', messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) return jsonResponse({ ok: true, valid: true, verifiedVia: 'chat', modelsCount: 0 });
        const text = await r.text().catch(() => '');
        // 401 = key ditolak (invalid); 404 = key diterima tapi model tidak ada di gateway.
        const valid = r.status !== 401;
        return jsonResponse({ ok: valid, valid, status: r.status, error: text.slice(0, 200) });
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
      // Bulk upsert active models — PostgREST upsert to the resource root
      // (filters are NOT allowed on POST; match happens on PK provider+model).
      const rows = activeIds.map((model) => ({ provider, model, active: true }));
      if (rows.length) {
        const upRes = await servicePostgrest(env, '/provider_models', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
          body: rows,
        });
        if (!upRes.ok) {
          const detail = await upRes.text().catch(() => '');
          return jsonResponse({ error: 'DB write failed', status: upRes.status, detail: detail.slice(0, 200) }, 500);
        }
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
      return jsonResponse({ ok: true, saved: activeIds.length, activeCount: activeIds.length });
    }

    // ---- /search: web search untuk mode agen (internet access) ----
    if (path === 'search' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const query = String(body.query || '').trim();
      if (!query) return jsonResponse({ error: 'query required' }, 400);
      const results = await webSearch(query);
      return jsonResponse({ ok: true, results, query });
    }

    // ---- /repos: repo terhubung (GitHub API server-side, no CORS) ----
    if (path === 'repos' && method === 'POST') {
      try {
        const res = await fetch('https://api.github.com/repos/sugionoofficial/BLEA-AI', {
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'blea-ai-studio', accept: 'application/vnd.github+json' },
        });
        const repo = await res.json().catch(() => ({}));
        if (repo?.full_name) {
          return jsonResponse({
            ok: true,
            repo: {
              fullName: repo.full_name,
              defaultBranch: repo.default_branch,
              description: repo.description || '',
              pushedAt: repo.pushed_at || null,
            },
          });
        }
        return jsonResponse({ ok: true, repo: null });
      } catch {
        return jsonResponse({ ok: true, repo: null });
      }
    }

    // ---- /api/auth/github/start: URL otorisasi OAuth GitHub ----
    if (path === 'auth/github/start' && method === 'POST') {
      const clientId = env.GITHUB_CLIENT_ID;
      if (!clientId) {
        return jsonResponse({ error: 'GitHub OAuth App belum dikonfigurasi. Buat di https://github.com/settings/developers dan isi client_id.' }, 503);
      }
      const redirectUri = `${url.origin}/auth/github/callback`;
      const authUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(GITHUB_SCOPE)}`;
      return jsonResponse({ ok: true, url: authUrl });
    }

    // ---- /api/auth/github/logout: putus koneksi GitHub ----
    if (path === 'auth/github/logout' && method === 'POST') {
      return new Response('ok', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'set-cookie': 'blea_github_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax',
        },
      });
    }

    // ---- /api/github/status: koneksi + identitas akun ----
    if (path === 'github/status' && (method === 'GET' || method === 'POST')) {
      const { ok, data } = await githubApi(request, '/user');
      if (!ok) return jsonResponse({ ok: false, connected: false });
      return jsonResponse({ ok: true, connected: true, login: data?.login, name: data?.name, scopes: GITHUB_SCOPE });
    }

    // ---- /api/github/tools/{tool}: alat agen GitHub (real) ----
    if (path.startsWith('github/tools/') && method === 'POST') {
      const toolPath = path.slice('github/tools/'.length);
      const body = await request.json().catch(() => ({}));
      const args = {
        ...body,
        owner: body.owner || 'sugionoofficial',
        repo: body.repo || 'BLEA-AI',
      };
      const result = await executeGithubTool(request, toolPath, args, env);
      return jsonResponse(result);
    }

    // ---- /chat: call openrouter, save assistant reply to DB, return JSON (auth required) ----
    if (path === 'chat' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!token) return jsonResponse({ error: 'Missing token' }, 401);
      const user = await getUser(env, token);
      if (!user) return jsonResponse({ error: 'Invalid token' }, 401);
      const body = await request.json().catch(() => ({}));
      // Read admin-configured API key + gateway base URL (UnoRouter gateway —
      // OpenAI-compatible; TIDAK memanggil openrouter.ai langsung karena key
      // yang disimpan adalah UnoRouter gateway key).
      const keyRes = await servicePostgrest(env, '/provider_api_keys?select=api_key,base_url&provider=eq.unorouter&limit=1');
      const keyRows = await keyRes.json().catch(() => []);
      const apiKey = keyRows?.[0]?.api_key || 'use-free';
      const gatewayBase = (keyRows?.[0]?.base_url || 'https://api.unorouter.com').replace(/\/+$/, '');
      // base_url bisa berupa host (https://api.unorouter.com) atau URL lengkap
      // (https://api.unorouter.com/v1/chat/completions) — jangan dobel /v1/chat/completions.
      const chatUrl = gatewayBase.endsWith('/chat/completions')
        ? gatewayBase
        : `${gatewayBase}/v1/chat/completions`;
      const systemPrompt = body.github ? `${AGENT_SYSTEM_PROMPT}\n\n${GITHUB_TOOLS_PROMPT}` : AGENT_SYSTEM_PROMPT;
      const fetchBody = { ...body, model: body.model, messages: [...(body.messages || []), { role: 'system', content: systemPrompt }], stream: false };
      delete fetchBody.apiKey;
      delete fetchBody.apiUrl;
      try {
        const upstream = await fetch(chatUrl, {
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
        let finalReply = upstreamData?.choices?.[0]?.message?.content ?? '';
        // Tool loop: parse \`\`\`tool dari reply model, eksekusi alat
        // GitHub, lalu lanjut percakapan dengan hasil alat (maks 4 iterasi).
        const actions = [];
        if (body.github) {
          for (let round = 0; round < 4; round += 1) {
            const toolCalls = parseToolCalls(finalReply);
            if (!toolCalls.length) break;
            const toolResults = [];
            for (const call of toolCalls) {
              const args = { ...call.arguments, owner: call.arguments.owner || 'sugionoofficial', repo: call.arguments.repo || 'BLEA-AI' };
              const result = await executeGithubTool(request, call.name, args, env);
              const summary = summarizeTool(call.name, result);
              actions.push({ tool: call.name, ok: result.ok, result: summary });
              toolResults.push({ name: call.name, ok: result.ok, result: summary });
            }
            const toolMessage = `Alat telah dijalankan:\n${toolResults.map((r) => `- ${r.name}: ${r.ok ? 'berhasil' : 'gagal'} — ${r.result}`).join('\n')}\n\nLanjutkan: jelaskan hasilnya secara natural. Jika perlu tindakan lanjutan, gunakan blok alat lagi.`;
            const upstream2 = await fetch(chatUrl, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey, 'HTTP-Referer': 'https://blea-ai.blea-ai.workers.dev', 'X-Title': 'BLEA AI' },
              body: JSON.stringify({ ...fetchBody, messages: [...fetchBody.messages, { role: 'assistant', content: finalReply }, { role: 'user', content: toolMessage }], stream: false }),
              signal: AbortSignal.timeout(120_000),
            });
            const upstreamData2 = await upstream2.json().catch(() => ({}));
            finalReply = upstreamData2?.choices?.[0]?.message?.content ?? '';
          }
        }
        const reply = finalReply;
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
        return jsonResponse({ ok: true, reply, messageId, actions });
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
    if (url.pathname === '/auth/github/callback') {
      return handleGithubCallback(request, url, env);
    }
    // Static assets (SPA)
    return env.ASSETS.fetch(request);
  },
};
