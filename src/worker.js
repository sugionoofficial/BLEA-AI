// BLEA AI — Cloudflare Worker API routes (same-origin, no CORS)
//
// Proxies AI / provider calls server-side, replacing the Supabase edge function
// "ai-chat" (edge runtime on this project returns BOOT_ERROR for all functions).
//
// Routes (all accept POST, some GET):
//   /api/status            -> { ok, configured, providers }
//   /api/verify            -> { ok, valid, ... }
//   /api/models            -> { models: [id] }
//   /api/enabled-models    -> { models: [id] }
//   /api/catalog           -> { models: [...] }
//   /api/admin-models      -> { models: [...] }
//   /api/save-models       -> { ok, saved, activeCount }
//   /api/chat              -> { ok, reply, messageId }
//   /api/video/models      -> { ok, models, providers }
//   /api/video/generate    -> { ok, generation }
//   /api/video/status      -> { ok, generation }
//   /api/video/history     -> { ok, generations }
//   /api/video/content/:id -> proxied video stream (signed URL or auth token)
//
// Env vars (set in Wrangler):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import {
  BUILTIN_VIDEO_MODELS,
  PROVIDER_PRESETS,
  computeVideoSize,
  getVideoModelProfile,
  isVideoCatalogModel,
  isVideoModelId,
  normalizeVideoStatus,
  resolveProviderApiBase,
} from './lib/videoCatalog.js';

const SUPABASE_URL_ENV = (env) => (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');

async function supabaseFetch(env, path, { method = 'GET', token, body, headers = {} } = {}) {
  const url = `${SUPABASE_URL_ENV(env)}${path}`;
  const finalHeaders = {
    apikey: env.SUPABASE_ANON_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...headers,
  };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  return fetch(url, {
    method,
    headers: finalHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
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

// Service-role PostgREST client (bypasses RLS — admin panel & server jobs need this)
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

// GitHub OAuth
const GITHUB_SCOPE = 'repo';

const GITHUB_TOOLS_PROMPT = [
  'Kamu memiliki alat GitHub hanya baca. Gunakan hanya bila diminta pengguna.',
  'Format: blok kode tool berisi JSON, misalnya {"name":"github_read","arguments":{"path":"README.md"}}.',
  'Alat tersedia: github_read {path, branch?}, github_prs {}. Repository ditentukan oleh pilihan pengguna.',
  'Hasil alat hanya berupa ringkasan metadata, bukan isi file. Tindakan yang mengubah data belum tersedia.',
].join(' ');

const GH_COOKIE = '__Host-blea_github';
const STATE_COOKIE = '__Host-blea_github_state';
const cookieOptions = 'Path=/; Secure; HttpOnly; SameSite=Lax';
function cookieValue(request, name) {
  return (request.headers.get('cookie') || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(name + '='))?.slice(name.length + 1) || '';
}
function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64url(value) {
  const s = value.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
async function sessionKey(env) {
  if (!env.GITHUB_CLIENT_SECRET) throw new Error('GitHub belum dikonfigurasi oleh administrator');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blea-github-session-v1:' + env.GITHUB_CLIENT_SECRET));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sessionKey(env), new TextEncoder().encode(JSON.stringify(value)));
  return base64url(iv) + '.' + base64url(new Uint8Array(encrypted));
}
async function unseal(value, env) {
  try {
    const [iv, ciphertext] = value.split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(iv) }, await sessionKey(env), unbase64url(ciphertext));
    const data = JSON.parse(new TextDecoder().decode(plain));
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}
async function requestUser(request, env) {
  const token = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token ? getUser(env, token) : null;
}
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  return !origin || origin === url.origin;
}
async function githubToken(request, env, user) {
  const session = await unseal(cookieValue(request, GH_COOKIE), env);
  return session?.uid === user?.id ? session.token : null;
}
async function githubApi(request, path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}, env, user) {
  const token = await githubToken(request, env, user);
  if (!token) return { ok: false, status: 401, data: { error: 'GitHub tidak terhubung untuk akun ini' } };
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept, 'content-type': 'application/json', 'user-agent': 'blea-ai-studio', 'X-GitHub-Api-Version': '2022-11-28' },
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

async function executeGithubTool(request, toolPath, args, env, user) {
  const gh = (p, opts) => githubApi(request, p, opts, env, user);
  try {
    if (toolPath === 'repos') {
      const { ok, data } = await gh('/user/repos?per_page=100&sort=updated');
      return { ok, data: ok ? (data || []).map((r) => ({ full_name: r.full_name, default_branch: r.default_branch, pushed_at: r.pushed_at })) : data };
    }
    if (toolPath === 'read') {
      const relPath = String(args.path || '').replace(/^\/+/, '');
      const encoded = relPath.split('/').map((part) => encodeURIComponent(part)).join('/');
      const ref = args.branch || args.ref;
      const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
      const { ok, data } = await gh(`/repos/${args.owner}/${args.repo}/contents/${encoded}${query}`);
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
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; base-uri 'none'" });
  headers.append('set-cookie', `${STATE_COOKIE}=; ${cookieOptions}; Max-Age=0`);
  const fail = () => new Response('<!doctype html><meta charset="utf-8"><h1>Koneksi GitHub gagal</h1><p>Silakan ulangi proses koneksi dari AI Studio.</p><a href="/studio">Kembali ke AI Studio</a>', { status: 400, headers });
  const state = await unseal(cookieValue(request, STATE_COOKIE), env);
  if (!state || !url.searchParams.get('state') || state.nonce !== url.searchParams.get('state') || url.searchParams.get('error') || !url.searchParams.get('code')) return fail();
  const tokenData = await exchangeGithubCode(url.searchParams.get('code'), env);
  if (!tokenData?.access_token) return fail();
  const session = await seal({ uid: state.uid, token: tokenData.access_token, exp: Date.now() + 30 * 86400_000 }, env);
  headers.append('set-cookie', `${GH_COOKIE}=${session}; ${cookieOptions}; Max-Age=2592000`);
  headers.append('set-cookie', 'blea_github_token=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
  headers.set('location', '/studio');
  return new Response(null, { status: 303, headers });
}

async function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------- Signed short-lived video content proxy URLs ----------
async function videoMediaKey(env) {
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.GITHUB_CLIENT_SECRET || env.SUPABASE_ANON_KEY || 'blea-video-media-dev';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('blea-video-media-v1:' + secret));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signVideoContentUrl(id, env, ttlMs = 2 * 60 * 60 * 1000) {
  const exp = String(Date.now() + ttlMs);
  const msg = new TextEncoder().encode(`${id}:${exp}`);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', await videoMediaKey(env), msg));
  const sig = base64url(sigBytes);
  return `/api/video/content/${encodeURIComponent(id)}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
}

async function verifyVideoContentSig(id, exp, sig, env) {
  try {
    if (!id || !exp || !sig) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const msg = new TextEncoder().encode(`${id}:${exp}`);
    return await crypto.subtle.verify('HMAC', await videoMediaKey(env), unbase64url(sig), msg);
  } catch {
    return false;
  }
}

async function sanitizeGenerationRow(row, env) {
  if (!row) return null;
  const clean = {
    id: row.id,
    user_id: row.user_id,
    provider: row.provider,
    model: row.model,
    prompt: row.prompt,
    aspect_ratio: row.aspect_ratio,
    resolution: row.resolution,
    duration: row.duration,
    generate_audio: row.generate_audio,
    image_url: row.image_url,
    video_url: row.video_url,
    audio_url: row.audio_url,
    external_job_id: row.external_job_id,
    status: row.status,
    progress: row.progress ?? 0,
    result_url: row.result_url,
    error_message: row.error_message,
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (clean.status === 'completed' && clean.id) {
    clean.result_url = await signVideoContentUrl(clean.id, env);
  }
  return clean;
}

// Inline external HTTPS image into data:<mime>;base64,... for models (Google Veo / Gemini Omni)
// whose UnoRouter plugin requires base64/data URL instead of an HTTPS URL.
async function maybeInlineImage(imageUrl) {
  const url = String(imageUrl || '').trim();
  if (!url || url.startsWith('data:')) return url;
  if (!/^https:\/\//i.test(url)) return url;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return url;
    const contentType = (res.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(contentType) ? contentType : 'image/png';
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > 15 * 1024 * 1024) return url;
    return `data:${mime};base64,${bytesToBase64(buf)}`;
  } catch {
    return url;
  }
}

async function buildUpstreamVideoRequest({ provider, baseUrl, apiKey, payload }) {
  const model = String(payload.model || '').trim();
  const prompt = String(payload.prompt || '').trim();
  const aspectRatio = String(payload.aspect_ratio || '16:9');
  const resolution = String(payload.resolution || '720p');
  const duration = Math.max(1, Math.min(120, Number(payload.duration) || 5));
  const generateAudio = payload.generate_audio !== false;
  const size = computeVideoSize(aspectRatio, resolution);
  const apiBase = resolveProviderApiBase(provider, baseUrl);
  const lowerModel = model.toLowerCase();

  let imageUrl = String(payload.image_url || '').trim();
  const imageLastUrl = String(payload.image_last_url || '').trim();
  const videoUrl = String(payload.video_url || '').trim();
  const audioUrl = String(payload.audio_url || '').trim();

  // Google Veo & Gemini Omni on UnoRouter/Google/Vertex plugins require inline data URLs
  if (imageUrl && provider !== 'openrouter' && (provider === 'google' || lowerModel.includes('veo') || lowerModel.includes('gemini-omni'))) {
    imageUrl = await maybeInlineImage(imageUrl);
  }

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...(provider === 'unorouter' ? { 'HTTP-Referer': 'https://blea-ai.blea-ai.workers.dev', 'X-Title': 'BLEA AI' } : {}),
    ...(provider === 'openrouter' ? { 'HTTP-Referer': 'https://blea-ai.blea-ai.workers.dev', 'X-Title': 'BLEA AI' } : {}),
  };

  if (provider === 'openrouter') {
    const body = {
      model,
      prompt: prompt || 'Generate a smooth, natural video guided by the attached media references.',
      duration,
      resolution: resolution.toLowerCase(),
      aspect_ratio: aspectRatio,
      generate_audio: generateAudio,
    };
    if (imageUrl) {
      body.frame_images = [
        { type: 'image_url', image_url: { url: imageUrl }, frame_type: 'first_frame' },
        ...(imageLastUrl ? [{ type: 'image_url', image_url: { url: imageLastUrl }, frame_type: 'last_frame' }] : []),
      ];
    }
    const refs = [];
    if (videoUrl) refs.push({ type: 'video_url', video_url: { url: videoUrl } });
    if (audioUrl) refs.push({ type: 'audio_url', audio_url: { url: audioUrl } });
    if (refs.length) body.input_references = refs;
    return {
      submitUrl: `${apiBase}/videos`,
      headers,
      body,
      pollBaseUrl: `${apiBase}/videos`,
    };
  }

  if (provider === 'xai') {
    const isEdit = Boolean(videoUrl && !imageUrl);
    const body = {
      model,
      prompt: prompt || 'Create a cinematic video based on the provided media.',
      aspect_ratio: aspectRatio,
      resolution: resolution.toLowerCase(),
      duration,
      generate_audio: generateAudio,
      ...(imageUrl ? { image: { url: imageUrl } } : {}),
      ...(videoUrl ? { video: { url: videoUrl } } : {}),
      ...(audioUrl ? { reference_audios: [{ url: audioUrl }] } : {}),
    };
    return {
      submitUrl: `${apiBase}/videos/${isEdit ? 'edits' : 'generations'}`,
      headers,
      body,
      pollBaseUrl: `${apiBase}/videos`,
    };
  }

  // Unified OpenAI-Video / UnoRouter new-api (/v1/videos) protocol
  const metadata = {
    aspect_ratio: aspectRatio,
    resolution: resolution.toLowerCase(),
  };
  if (imageUrl) metadata.first_frame_image = imageUrl;
  if (imageLastUrl) metadata.last_frame_image = imageLastUrl;
  if (videoUrl) metadata.reference_video = videoUrl;
  if (audioUrl) metadata.reference_audio = audioUrl;

  const images = [];
  if (imageUrl) images.push(imageUrl);
  if (imageLastUrl) images.push(imageLastUrl);

  const body = {
    model,
    prompt: prompt || 'Generate a smooth video matching the attached reference media.',
    aspect_ratio: aspectRatio,
    resolution: resolution.toLowerCase(),
    duration,
    seconds: duration,
    size,
    generate_audio: generateAudio,
    ...(imageUrl ? { input_reference: imageUrl, image: imageUrl, images } : {}),
    ...(videoUrl ? { video_url: videoUrl } : {}),
    ...(audioUrl ? { audio_url: audioUrl, reference_audios: [{ url: audioUrl }] } : {}),
    metadata,
  };

  return {
    submitUrl: `${apiBase}/videos`,
    headers,
    body,
    pollBaseUrl: `${apiBase}/videos`,
  };
}

function extractVideoJobId(data) {
  return String(
    data?.id
    || data?.task_id
    || data?.request_id
    || data?.data?.id
    || data?.data?.task_id
    || '',
  ).trim();
}

function extractUpstreamVideoUrl(data, apiBase, jobId) {
  const direct = (
    (Array.isArray(data?.urls) && data.urls[0])
    || (Array.isArray(data?.unsigned_urls) && data.unsigned_urls[0])
    || data?.video?.url
    || data?.url
    || data?.video_url
    || data?.output?.video_url
    || data?.data?.video_url
    || data?.data?.url
    || (Array.isArray(data?.data) && data.data[0]?.url)
    || ''
  );
  if (direct) return String(direct).trim();
  if (jobId && apiBase) return `${apiBase}/videos/${encodeURIComponent(jobId)}/content`;
  return '';
}

function extractUpstreamError(data) {
  if (!data) return '';
  if (typeof data.error === 'string') return data.error;
  if (data.error?.message) return String(data.error.message);
  if (data.fail_reason) return String(data.fail_reason);
  if (data.message && !data.id && !data.task_id) return String(data.message);
  return '';
}

function extractProgressPercent(data, normalizedStatus) {
  if (normalizedStatus === 'completed') return 100;
  const raw = data?.progress ?? data?.data?.progress;
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, Math.min(100, Math.round(raw)));
  if (typeof raw === 'string') {
    const parsed = Number(raw.replace('%', '').trim());
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(100, Math.round(parsed)));
  }
  return normalizedStatus === 'in_progress' ? 45 : 10;
}

async function fetchProviderKeyRecord(env, provider) {
  const res = await servicePostgrest(
    env,
    `/provider_api_keys?select=provider,api_key,base_url,label&provider=eq.${encodeURIComponent(provider)}&limit=1`,
  );
  const rows = await res.json().catch(() => []);
  return rows?.[0] || null;
}

async function handleApi(request, url, env) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method;

  try {
    if (method === 'OPTIONS') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // ---- GET/HEAD /api/video/content/:id: signed or authorized video stream proxy ----
    if (path.startsWith('video/content/') && (method === 'GET' || method === 'HEAD')) {
      const id = decodeURIComponent(path.slice('video/content/'.length));
      if (!id) return jsonResponse({ error: 'Missing generation id' }, 400);

      const exp = url.searchParams.get('exp');
      const sig = url.searchParams.get('sig');
      const sigOk = await verifyVideoContentSig(id, exp, sig, env);
      let user = null;
      if (!sigOk) {
        const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        user = bearer ? await getUser(env, bearer) : null;
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const rowRes = await servicePostgrest(
        env,
        `/video_generations?select=id,user_id,provider,external_job_id,polling_url,upstream_result_url,status&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      const rows = await rowRes.json().catch(() => []);
      const row = rows?.[0];
      if (!row) return jsonResponse({ error: 'Video not found' }, 404);
      if (!sigOk && row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }

      const keyRow = await fetchProviderKeyRecord(env, row.provider || 'unorouter');
      const apiBase = resolveProviderApiBase(row.provider || 'unorouter', keyRow?.base_url);
      let targetUrl = row.upstream_result_url;
      if (!targetUrl && row.external_job_id) {
        targetUrl = `${apiBase}/videos/${encodeURIComponent(row.external_job_id)}/content`;
      }
      if (!targetUrl) return jsonResponse({ error: 'Video content URL unavailable' }, 404);

      if (targetUrl.startsWith('data:')) {
        const comma = targetUrl.indexOf(',');
        const header = targetUrl.slice(5, comma);
        const mime = header.split(';')[0] || 'video/mp4';
        const raw = Uint8Array.from(atob(targetUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
        return new Response(method === 'HEAD' ? null : raw, {
          status: 200,
          headers: {
            'content-type': mime,
            'content-length': String(raw.byteLength),
            'cache-control': 'private, no-store',
          },
        });
      }

      const upstreamHeaders = {};
      const range = request.headers.get('range');
      if (range) upstreamHeaders.range = range;
      try {
        const targetHost = new URL(targetUrl).host;
        const apiHost = new URL(apiBase).host;
        if (keyRow?.api_key && targetHost === apiHost) {
          upstreamHeaders.authorization = `Bearer ${keyRow.api_key}`;
        }
      } catch {}

      const upstream = await fetch(targetUrl, {
        method,
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(60_000),
      });
      if (!upstream.ok && upstream.status !== 206) {
        const text = await upstream.text().catch(() => '');
        return jsonResponse({ error: 'Failed to stream upstream video', status: upstream.status, detail: text.slice(0, 300) }, 502);
      }
      const respHeaders = new Headers();
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) respHeaders.set(h, v);
      }
      if (!respHeaders.has('content-type')) respHeaders.set('content-type', 'video/mp4');
      respHeaders.set('cache-control', 'private, no-store');
      return new Response(method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });
    }

    // ---- /status: configured providers & UnoRouter status ----
    if (path === 'status' && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url,label');
      const rows = await res.json().catch(() => []);
      const configuredProviders = (rows || []).filter((r) => !!r.api_key).map((r) => r.provider);
      const configured = configuredProviders.includes('unorouter');
      return jsonResponse({ ok: true, configured, providers: configuredProviders });
    }

    // ---- /verify: validate API key for UnoRouter, OpenRouter, or custom provider ----
    if (path === 'verify' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const provider = String(body.provider || 'unorouter').trim().toLowerCase();
      const keyRow = await fetchProviderKeyRecord(env, provider);
      const apiBase = resolveProviderApiBase(provider, body.baseUrl || keyRow?.base_url);
      const apiKey = body.apiKey ?? '';
      try {
        // Prefer standard GET /models (supported by OpenRouter, OpenAI, xAI, UnoRouter)
        const modelsRes = await fetch(`${apiBase}/models`, {
          method: 'GET',
          headers: { authorization: 'Bearer ' + apiKey },
          signal: AbortSignal.timeout(20_000),
        });
        if (modelsRes.ok) {
          const parsed = await modelsRes.json().catch(() => ({}));
          const count = Array.isArray(parsed?.data) ? parsed.data.length : (Array.isArray(parsed?.models) ? parsed.models.length : 0);
          return jsonResponse({ ok: true, valid: true, verifiedVia: 'models', modelsCount: count });
        }
        if (modelsRes.status === 401 || modelsRes.status === 403) {
          const text = await modelsRes.text().catch(() => '');
          return jsonResponse({ ok: false, valid: false, status: modelsRes.status, error: text.slice(0, 200) });
        }
        // Fallback chat ping for gateways without GET /v1/models
        const pingUrl = `${apiBase}/chat/completions`;
        const r = await fetch(pingUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
          body: JSON.stringify({ model: provider === 'openrouter' ? 'openai/gpt-4o-mini' : 'gpt-oss-120b:free', messages: [{ role: 'user', content: 'ping' }] }),
          signal: AbortSignal.timeout(30_000),
        });
        if (r.ok) return jsonResponse({ ok: true, valid: true, verifiedVia: 'chat', modelsCount: 0 });
        const text = await r.text().catch(() => '');
        const valid = r.status !== 401 && r.status !== 403;
        return jsonResponse({ ok: valid, valid, status: r.status, error: text.slice(0, 200) });
      } catch (e) {
        return jsonResponse({ ok: false, valid: false, error: String(e) });
      }
    }

    // ---- /models & /enabled-models: active models for Chat AI ----
    if ((path === 'models' || path === 'enabled-models') && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      const models = (rows ?? []).filter((m) => !isVideoModelId(m.model)).map((m) => m.model);
      return jsonResponse({ models });
    }

    // ---- /catalog: full catalog from UnoRouter (plus Video models free & paid) or OpenRouter ----
    if (path === 'catalog' && (method === 'GET' || method === 'POST')) {
      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const provider = String(body.provider || url.searchParams.get('provider') || 'unorouter').toLowerCase();

      if (provider === 'openrouter') {
        try {
          const upstream = await fetch('https://openrouter.ai/api/v1/videos/models', {
            signal: AbortSignal.timeout(20_000),
          });
          const payload = upstream.ok ? await upstream.json().catch(() => ({})) : {};
          const list = Array.isArray(payload?.data) ? payload.data : [];
          const models = list.map((item) => ({
            id: item.id,
            provider: 'openrouter',
            category: 'Video',
            tags: ['Video', 'OpenRouter'],
            description: item.description || item.name || '',
            isFree: false,
            online: true,
            priceLabel: item.pricing_skus?.['per-video-second'] ? `$${item.pricing_skus['per-video-second']}/s` : 'Berbayar',
          }));
          if (models.length) return jsonResponse({ models });
        } catch {}
        return jsonResponse({
          models: BUILTIN_VIDEO_MODELS.filter((m) => m.provider === 'openrouter').map((m) => ({
            id: m.id,
            provider: 'openrouter',
            category: 'Video',
            tags: ['Video', m.vendor],
            description: m.description,
            isFree: m.isFree,
            online: true,
            priceLabel: m.priceLabel,
          })),
        });
      }

      try {
        const upstream = await fetch('https://api.unorouter.com/api/pricing', {
          signal: AbortSignal.timeout(30_000),
        });
        if (!upstream.ok) return jsonResponse({ error: 'Catalog fetch failed', status: upstream.status }, 502);
        const catalog = await upstream.json().catch(() => ({}));
        const rows = Array.isArray(catalog?.data) ? catalog.data : [];
        const models = rows
          .map((row) => {
            let meta = {};
            try { meta = JSON.parse(row.metadata || '{}'); } catch {}
            const tags = String(row.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
            const isVideo = isVideoCatalogModel(row, meta);
            if (!isVideo && !(row.is_free && row.online)) return null;
            const mode = String(meta.mode || '').toLowerCase();
            let category;
            if (isVideo) category = 'Video';
            else if (mode === 'image') category = 'Image';
            else if (mode === 'embedding') category = 'Embedding';
            else if (mode === 'speech') category = 'Speech';
            else if (tags.some((t) => t.toLowerCase() === 'text')) category = 'Text';
            else category = 'Other';
            const price = Number(row.model_price);
            const priceLabel = row.is_free ? 'Gratis' : (Number.isFinite(price) && price > 0 ? `$${price}/s` : 'Berbayar');
            return {
              id: row.model_name,
              provider: 'unorouter',
              category,
              tags,
              description: row.description || '',
              isFree: Boolean(row.is_free),
              online: Boolean(row.online),
              priceLabel,
            };
          })
          .filter(Boolean);
        return jsonResponse({ models });
      } catch (e) {
        return jsonResponse({ error: String(e) }, 502);
      }
    }

    // ---- /admin-models: full model list across all providers (admin) ----
    if (path === 'admin-models' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await isAdmin(env, token))) return jsonResponse({ error: 'admin required' }, 403);
      const res = await servicePostgrest(env, '/provider_models?select=provider,model,active&order=created_at.desc&limit=500');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      const models = (rows ?? []).map((m) => ({ id: m.model, active: m.active, provider: m.provider }));
      return jsonResponse({ models });
    }

    // ---- /save-models: upsert model enablement per provider (admin) ----
    if (path === 'save-models' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await isAdmin(env, token))) return jsonResponse({ error: 'admin required' }, 403);
      const body = await request.json().catch(() => ({}));
      const provider = String(body.provider ?? 'unorouter').trim().toLowerCase();

      if (body.mode === 'upsert_one' && body.model) {
        const modelId = String(body.model).trim();
        const active = body.active !== false;
        const upRes = await servicePostgrest(env, '/provider_models', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: [{ provider, model: modelId, active }],
        });
        if (!upRes.ok) {
          const detail = await upRes.text().catch(() => '');
          return jsonResponse({ error: 'DB write failed', status: upRes.status, detail: detail.slice(0, 200) }, 500);
        }
        return jsonResponse({ ok: true, saved: 1, model: modelId, provider, active });
      }

      const activeIds = Array.isArray(body.models) ? body.models : [];
      const rows = activeIds.map((model) => ({ provider, model, active: true }));
      if (rows.length) {
        const upRes = await servicePostgrest(env, '/provider_models', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: rows,
        });
        if (!upRes.ok) {
          const detail = await upRes.text().catch(() => '');
          return jsonResponse({ error: 'DB write failed', status: upRes.status, detail: detail.slice(0, 200) }, 500);
        }
      }
      const listRes = await servicePostgrest(env, `/provider_models?select=model&provider=eq.${encodeURIComponent(provider)}`);
      const existing = await listRes.json().catch(() => []);
      const stale = (existing ?? []).map((m) => m.model).filter((m) => !activeIds.includes(m));
      for (const model of stale) {
        await servicePostgrest(env, `/provider_models?provider=eq.${encodeURIComponent(provider)}&model=eq.${encodeURIComponent(model)}`, {
          method: 'PATCH',
          body: { active: false },
        });
      }
      return jsonResponse({ ok: true, saved: activeIds.length, activeCount: activeIds.length });
    }

    // ---- /video/models: multi-provider video generation models & provider statuses ----
    if (path === 'video/models' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const [keysRes, modelsRes] = await Promise.all([
        servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url,label'),
        servicePostgrest(env, '/provider_models?select=provider,model,active&active=eq.true&order=created_at.desc&limit=500'),
      ]);
      const keyRows = await keysRes.json().catch(() => []);
      const dbModelRows = await modelsRes.json().catch(() => []);

      const configuredByProvider = new Map();
      for (const row of keyRows || []) {
        configuredByProvider.set(row.provider, {
          id: row.provider,
          label: row.label || PROVIDER_PRESETS[row.provider]?.label || row.provider,
          configured: Boolean(row.api_key),
          hasBaseUrl: Boolean(row.base_url),
        });
      }

      // Optional live catalog enrichment from UnoRouter & OpenRouter (best-effort)
      const liveCatalogMap = new Map();
      try {
        const unoRes = await fetch('https://api.unorouter.com/api/pricing', { signal: AbortSignal.timeout(8_000) });
        if (unoRes.ok) {
          const catalog = await unoRes.json().catch(() => ({}));
          for (const row of Array.isArray(catalog?.data) ? catalog.data : []) {
            let meta = {};
            try { meta = JSON.parse(row.metadata || '{}'); } catch {}
            if (!isVideoCatalogModel(row, meta)) continue;
            const price = Number(row.model_price);
            liveCatalogMap.set(`unorouter:${row.model_name}`, {
              online: Boolean(row.online),
              isFree: Boolean(row.is_free),
              priceLabel: row.is_free ? 'Gratis' : (Number.isFinite(price) && price > 0 ? `$${price}/s` : 'Berbayar'),
              description: row.description || '',
            });
          }
        }
      } catch {}

      const merged = new Map();
      // 1. Active video models configured in Admin Panel (provider_models)
      for (const row of dbModelRows || []) {
        const provider = row.provider || 'unorouter';
        const key = `${provider}:${row.model}`;
        const isVideo = isVideoModelId(row.model) || liveCatalogMap.has(key) || provider !== 'unorouter';
        if (!isVideo) continue;
        // Skip clearly non-video chat/embedding models on other providers if obvious
        if (provider !== 'unorouter' && /(gpt-oss|deepseek|embed|whisper|rerank|coder|instruct|llama)/i.test(row.model)) continue;
        const profile = getVideoModelProfile(row.model, provider);
        const live = liveCatalogMap.get(key);
        merged.set(key, {
          ...profile,
          provider,
          providerLabel: configuredByProvider.get(provider)?.label || PROVIDER_PRESETS[provider]?.label || provider,
          providerConfigured: Boolean(configuredByProvider.get(provider)?.configured),
          activeInAdmin: true,
          online: live ? live.online : true,
          isFree: live ? live.isFree : profile.isFree,
          priceLabel: live ? live.priceLabel : profile.priceLabel,
          description: live?.description || profile.description,
        });
      }

      // 2. Discoverable OpenRouter video models if OpenRouter is configured
      if (configuredByProvider.get('openrouter')?.configured) {
        try {
          const orRes = await fetch('https://openrouter.ai/api/v1/videos/models', { signal: AbortSignal.timeout(8_000) });
          if (orRes.ok) {
            const orData = await orRes.json().catch(() => ({}));
            for (const item of Array.isArray(orData?.data) ? orData.data : []) {
              const key = `openrouter:${item.id}`;
              const profile = getVideoModelProfile(item.id, 'openrouter');
              const existing = merged.get(key);
              merged.set(key, {
                ...profile,
                ...(existing || {}),
                id: item.id,
                name: item.name || profile.name,
                provider: 'openrouter',
                providerLabel: configuredByProvider.get('openrouter')?.label || 'OpenRouter',
                providerConfigured: true,
                activeInAdmin: Boolean(existing?.activeInAdmin),
                online: true,
                aspectRatios: Array.isArray(item.supported_aspect_ratios) && item.supported_aspect_ratios.length
                  ? item.supported_aspect_ratios : profile.aspectRatios,
                resolutions: Array.isArray(item.supported_resolutions) && item.supported_resolutions.length
                  ? item.supported_resolutions : profile.resolutions,
                durations: Array.isArray(item.supported_durations) && item.supported_durations.length
                  ? item.supported_durations : profile.durations,
                priceLabel: item.pricing_skus?.['per-video-second']
                  ? `$${item.pricing_skus['per-video-second']}/s` : profile.priceLabel,
                description: item.description || profile.description,
              });
            }
          }
        } catch {}
      }

      // 3. Built-in video catalog entries (ensures dropdown always has video options & capabilities)
      for (const item of BUILTIN_VIDEO_MODELS) {
        const key = `${item.provider}:${item.id}`;
        if (merged.has(key)) continue;
        const live = liveCatalogMap.get(key);
        const provInfo = configuredByProvider.get(item.provider);
        merged.set(key, {
          ...item,
          providerLabel: provInfo?.label || PROVIDER_PRESETS[item.provider]?.label || item.provider,
          providerConfigured: Boolean(provInfo?.configured),
          activeInAdmin: false,
          online: live ? live.online : true,
          isFree: live ? live.isFree : item.isFree,
          priceLabel: live ? live.priceLabel : item.priceLabel,
          description: live?.description || item.description,
        });
      }

      const models = Array.from(merged.values()).sort((a, b) => {
        if (a.activeInAdmin !== b.activeInAdmin) return a.activeInAdmin ? -1 : 1;
        if (a.providerConfigured !== b.providerConfigured) return a.providerConfigured ? -1 : 1;
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const providers = Array.from(configuredByProvider.values());
      for (const preset of Object.values(PROVIDER_PRESETS)) {
        if (preset.id === 'custom') continue;
        if (!configuredByProvider.has(preset.id)) {
          providers.push({ id: preset.id, label: preset.label, configured: false, hasBaseUrl: false });
        }
      }

      return jsonResponse({ ok: true, models, providers });
    }

    // ---- /video/history: list current user's video generations with fresh signed playback URLs ----
    if (path === 'video/history' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const res = await servicePostgrest(
        env,
        `/video_generations?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=40`,
      );
      if (!res.ok) return jsonResponse({ error: 'Failed to load video history' }, 500);
      const rows = await res.json().catch(() => []);
      const generations = await Promise.all((rows || []).map((row) => sanitizeGenerationRow(row, env)));
      return jsonResponse({ ok: true, generations });
    }

    // ---- /video/generate: submit async video generation job & persist in Supabase ----
    if (path === 'video/generate' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const payload = await request.json().catch(() => ({}));
      const provider = String(payload.provider || 'unorouter').trim().toLowerCase();
      const model = String(payload.model || '').trim();
      const prompt = String(payload.prompt || '').trim();
      const imageUrl = String(payload.image_url || '').trim();
      const videoUrl = String(payload.video_url || '').trim();
      const audioUrl = String(payload.audio_url || '').trim();

      if (!model) return jsonResponse({ error: 'Pilih model video terlebih dahulu.' }, 400);
      if (!prompt && !imageUrl && !videoUrl && !audioUrl) {
        return jsonResponse({ error: 'Masukkan prompt atau unggah minimal satu media (gambar, video, atau audio).' }, 400);
      }

      const keyRow = await fetchProviderKeyRecord(env, provider);
      if (!keyRow?.api_key) {
        return jsonResponse({
          error: `Provider "${PROVIDER_PRESETS[provider]?.label || provider}" belum memiliki API key. Konfigurasikan di Admin Panel -> API Key.`,
        }, 400);
      }

      const upstreamReq = await buildUpstreamVideoRequest({
        provider,
        baseUrl: keyRow.base_url,
        apiKey: keyRow.api_key,
        payload,
      });

      let upstreamRes;
      try {
        upstreamRes = await fetch(upstreamReq.submitUrl, {
          method: 'POST',
          headers: upstreamReq.headers,
          body: JSON.stringify(upstreamReq.body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        return jsonResponse({ error: `Gagal menghubungi provider (${provider}): ${String(e)}` }, 502);
      }

      const rawText = await upstreamRes.text().catch(() => '');
      let upstreamData = {};
      try { upstreamData = JSON.parse(rawText); } catch {}

      if (!upstreamRes.ok) {
        const detail = extractUpstreamError(upstreamData) || rawText.slice(0, 300);
        const statusMsg = upstreamRes.status === 402
          ? 'Saldo / kuota provider tidak mencukupi untuk model ini.'
          : upstreamRes.status === 429
            ? 'Provider sedang sibuk atau terkena batas rate limit. Coba beberapa saat lagi.'
            : upstreamRes.status === 401 || upstreamRes.status === 403
              ? `API key untuk provider "${provider}" tidak valid atau tidak memiliki izin.`
              : (detail || `Permintaan generate gagal (HTTP ${upstreamRes.status}).`);
        return jsonResponse({
          ok: false,
          error: statusMsg,
          upstreamStatus: upstreamRes.status,
          detail,
        }, upstreamRes.status >= 400 && upstreamRes.status < 500 ? upstreamRes.status : 502);
      }

      const externalJobId = extractVideoJobId(upstreamData);
      const status = normalizeVideoStatus(upstreamData?.status || upstreamData?.data?.status || 'queued');
      const progress = extractProgressPercent(upstreamData, status);
      const pollingUrl = String(
        upstreamData?.polling_url
        || (externalJobId ? `${upstreamReq.pollBaseUrl}/${encodeURIComponent(externalJobId)}` : ''),
      ).trim();
      const apiBase = resolveProviderApiBase(provider, keyRow.base_url);
      const immediateContentUrl = status === 'completed'
        ? extractUpstreamVideoUrl(upstreamData, apiBase, externalJobId)
        : '';

      const insertBody = {
        user_id: user.id,
        provider,
        model,
        prompt,
        aspect_ratio: String(payload.aspect_ratio || '16:9'),
        resolution: String(payload.resolution || '720p'),
        duration: Math.max(1, Math.min(120, Number(payload.duration) || 5)),
        generate_audio: payload.generate_audio !== false,
        image_url: imageUrl || null,
        video_url: videoUrl || null,
        audio_url: audioUrl || null,
        external_job_id: externalJobId || null,
        polling_url: pollingUrl || null,
        status,
        progress,
        upstream_result_url: immediateContentUrl || null,
        error_message: status === 'failed' ? (extractUpstreamError(upstreamData) || 'Generasi gagal') : null,
        metadata: {
          mode: videoUrl ? 'video_to_video' : imageUrl ? 'image_to_video' : audioUrl ? 'audio_to_video' : 'text_to_video',
          ...(payload.image_last_url ? { image_last_url: payload.image_last_url } : {}),
        },
      };

      const insertRes = await servicePostgrest(env, '/video_generations', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: insertBody,
      });
      if (!insertRes.ok) {
        const detail = await insertRes.text().catch(() => '');
        return jsonResponse({ error: 'Gagal menyimpan riwayat generate', detail: detail.slice(0, 200) }, 500);
      }
      const inserted = await insertRes.json().catch(() => []);
      const row = inserted?.[0] || insertBody;
      const generation = await sanitizeGenerationRow(row, env);
      return jsonResponse({ ok: true, generation });
    }

    // ---- /video/status: poll upstream job status & update Supabase row ----
    if (path === 'video/status' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const id = String(body.id || url.searchParams.get('id') || '').trim();
      if (!id) return jsonResponse({ error: 'id required' }, 400);

      const rowRes = await servicePostgrest(
        env,
        `/video_generations?select=*&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      const rows = await rowRes.json().catch(() => []);
      const row = rows?.[0];
      if (!row) return jsonResponse({ error: 'Generation not found' }, 404);
      if (row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }

      if (['completed', 'failed', 'cancelled', 'expired'].includes(row.status)) {
        return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env) });
      }

      const keyRow = await fetchProviderKeyRecord(env, row.provider || 'unorouter');
      if (!keyRow?.api_key) {
        return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env) });
      }

      const apiBase = resolveProviderApiBase(row.provider || 'unorouter', keyRow.base_url);
      const pollUrl = row.polling_url || (row.external_job_id ? `${apiBase}/videos/${encodeURIComponent(row.external_job_id)}` : '');
      if (!pollUrl) {
        return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env) });
      }

      const pollRes = await fetch(pollUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${keyRow.api_key}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!pollRes.ok) {
        return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env), pollWarning: `HTTP ${pollRes.status}` });
      }

      const pollData = await pollRes.json().catch(() => ({}));
      const nextStatus = normalizeVideoStatus(pollData?.status || pollData?.data?.status || row.status);
      const nextProgress = extractProgressPercent(pollData, nextStatus);
      const upstreamUrl = nextStatus === 'completed'
        ? extractUpstreamVideoUrl(pollData, apiBase, row.external_job_id)
        : row.upstream_result_url;
      const errMsg = nextStatus === 'failed'
        ? (extractUpstreamError(pollData) || 'Generasi video gagal di server provider.')
        : row.error_message;

      const patchRes = await servicePostgrest(
        env,
        `/video_generations?id=eq.${encodeURIComponent(row.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: {
            status: nextStatus,
            progress: nextProgress,
            ...(upstreamUrl ? { upstream_result_url: upstreamUrl } : {}),
            ...(errMsg ? { error_message: errMsg } : {}),
          },
        },
      );
      const patched = patchRes.ok ? await patchRes.json().catch(() => []) : [];
      const updated = patched?.[0] || {
        ...row,
        status: nextStatus,
        progress: nextProgress,
        upstream_result_url: upstreamUrl,
        error_message: errMsg,
      };
      return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(updated, env) });
    }

    // ---- /search: web search untuk mode agen (internet access) ----
    if (path === 'search' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const query = String(body.query || '').trim();
      if (!query) return jsonResponse({ error: 'query required' }, 400);
      const results = await webSearch(query);
      return jsonResponse({ ok: true, results, query });
    }

    // GitHub routes
    if (path === 'repos' || path.startsWith('auth/github/') || path === 'github/status' || path.startsWith('github/tools/')) {
      if (!sameOrigin(request, url)) return jsonResponse({ error: 'Origin tidak diizinkan' }, 403);
      const user = await requestUser(request, env);
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      if (path === 'auth/github/start' && method === 'POST') {
        if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return jsonResponse({ error: 'GitHub belum dikonfigurasi. Hubungi administrator BLEA AI.' }, 503);
        const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const state = await seal({ uid: user.id, nonce, exp: Date.now() + 10 * 60_000 }, env);
        const auth = new URL('https://github.com/login/oauth/authorize');
        auth.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${url.origin}/auth/github/callback`, scope: GITHUB_SCOPE, state: nonce }).toString();
        return new Response(JSON.stringify({ ok: true, url: auth.toString() }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': `${STATE_COOKIE}=${state}; ${cookieOptions}; Max-Age=600` } });
      }
      if (path === 'auth/github/logout' && method === 'POST') {
        const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
        headers.append('set-cookie', `${GH_COOKIE}=; ${cookieOptions}; Max-Age=0`);
        headers.append('set-cookie', `${STATE_COOKIE}=; ${cookieOptions}; Max-Age=0`);
        headers.append('set-cookie', 'blea_github_token=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
        return new Response(JSON.stringify({ ok: true }), { headers });
      }
      if (path === 'github/status' && (method === 'GET' || method === 'POST')) {
        const { ok, data } = await githubApi(request, '/user', {}, env, user);
        return jsonResponse(ok ? { ok: true, connected: true, login: data?.login, name: data?.name } : { ok: false, connected: false });
      }
      if (path === 'repos' && method === 'POST') {
        const result = await githubApi(request, '/user/repos?per_page=100&sort=updated', {}, env, user);
        return jsonResponse(result.ok ? { ok: true, repos: result.data.map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch })) } : { ok: false, repos: [] }, result.ok ? 200 : result.status);
      }
      if (path.startsWith('github/tools/') && method === 'POST') {
        const tool = path.slice('github/tools/'.length);
        if (!['repos', 'read', 'prs'].includes(tool)) return jsonResponse({ error: 'Tindakan yang mengubah GitHub belum tersedia.' }, 403);
        const args = await request.json().catch(() => ({}));
        if (tool !== 'repos' && (!args.owner || !args.repo)) return jsonResponse({ error: 'Pilih repository terlebih dahulu.' }, 400);
        return jsonResponse(await executeGithubTool(request, tool, args, env, user));
      }
    }

    // ---- /chat: call UnoRouter / provider, save assistant reply to DB, return JSON (auth required) ----
    if (path === 'chat' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!token) return jsonResponse({ error: 'Missing token' }, 401);
      const user = await getUser(env, token);
      if (!user) return jsonResponse({ error: 'Invalid token' }, 401);
      const body = await request.json().catch(() => ({}));
      const keyRes = await servicePostgrest(env, '/provider_api_keys?select=api_key,base_url&provider=eq.unorouter&limit=1');
      const keyRows = await keyRes.json().catch(() => []);
      const apiKey = keyRows?.[0]?.api_key || 'use-free';
      const chatUrl = `${resolveProviderApiBase('unorouter', keyRows?.[0]?.base_url)}/chat/completions`;
      const repository = typeof body.repository === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(body.repository) ? body.repository : '';
      const githubEnabled = !!(body.github && repository && await githubToken(request, env, user));
      const [selectedOwner, selectedName] = repository.split('/');
      const systemPrompt = githubEnabled ? `${AGENT_SYSTEM_PROMPT}\n\n${GITHUB_TOOLS_PROMPT}\nRepository yang dipilih pengguna: ${repository}. Gunakan hanya repository ini.` : AGENT_SYSTEM_PROMPT;
      const fetchBody = { ...body, model: body.model, messages: [...(body.messages || []), { role: 'system', content: systemPrompt }], stream: false };
      delete fetchBody.github;
      delete fetchBody.repository;
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
        const actions = [];
        if (githubEnabled) {
          for (let round = 0; round < 4; round += 1) {
            const toolCalls = parseToolCalls(finalReply);
            if (!toolCalls.length) break;
            const toolResults = [];
            for (const call of toolCalls) {
              const args = { ...(call.arguments || {}), owner: selectedOwner, repo: selectedName };
              const tool = String(call.name).replace(/^github_/, '');
              const allowed = ['read', 'prs'].includes(tool);
              const result = allowed ? await executeGithubTool(request, tool, args, env, user) : { ok: false, data: { error: 'Tindakan ditolak: hanya akses baca repository yang dipilih tersedia.' } };
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
        const insertRes = await servicePostgrest(env, '/ai_messages', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
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
    return env.ASSETS.fetch(request);
  },
};
