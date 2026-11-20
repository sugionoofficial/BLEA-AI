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
  CLOUDFLARE_FREE_LLM_MODELS,
  PROVIDER_PRESETS,
  computeVideoSize,
  getAlibabaVideoModelSpec,
  getVideoModelProfile,
  isAlibabaVideoModelSupported,
  isValidHttpBaseUrl,
  isVideoCatalogModel,
  isVideoModelId,
  normalizeVideoStatus,
  resolveProviderApiBase,
} from './lib/videoCatalog.js';
import { ALIBABA_FREE_QUOTA_MODELS } from './lib/alibabaFreeQuota.js';
import { handleAdminUserAction, handleAdminUserRoles } from './lib/adminUserControls.js';
import { handleOrderReview, handlePurchaseToggle } from './lib/adminPurchases.js';
import {
  consumerDanceConfig,
  consumerDanceGenerate,
  consumerDanceStatus,
  consumerImageConfig,
  consumerImageGenerate,
  consumerImageHistory,
  consumerImageStatus,
  freebeatCallback,
  handleFreebeat,
  sanitizeImageRow,
} from './lib/freebeatMcp.js';
import { isUncertainReply, parseSearchRequests, parseUpstreamSsePayload, stripSearchBlocks } from './lib/chatStream.js';
import { createMailtmAlias, fetchMailtmMessage, fetchMailtmMessages, parseMailtmCredentials, refreshMailtmToken, serializeMailtmCredentials } from './lib/mailtmProvider.js';
import { buildGmailAuthUrl, createGmailApiAlias, deleteGmailConnection, getGmailConnection, getGmailMessage, handleGmailOAuthCallback, isGmailApiConfigured, listGmailMessages } from './lib/gmailProvider.js';

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

async function handleTempmail(request, url, env) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return jsonResponse({ error: 'Login diperlukan untuk menggunakan TempMail.' }, 401, { 'cache-control': 'no-store' });
  const user = await getUser(env, token);
  if (!user) return jsonResponse({ error: 'Sesi tidak valid atau kedaluwarsa. Silakan login kembali.' }, 401, { 'cache-control': 'no-store' });
  if (user.app_metadata?.role !== 'admin') return jsonResponse({ error: 'Fitur TempMail hanya tersedia untuk admin.' }, 403, { 'cache-control': 'no-store' });

  const action = String(url.searchParams.get('action') || 'alias').toLowerCase();
  const respond = (data, status = 200, headers = {}) => jsonResponse(data, status, { 'cache-control': 'no-store', ...headers });
  const aliasPath = `/tempmail_user_aliases?select=user_id,email,token,provider,created_at&user_id=eq.${encodeURIComponent(user.id)}&limit=1`;
  const readAlias = async () => {
    const response = await servicePostgrest(env, aliasPath);
    if (!response.ok) throw Object.assign(new Error('Gagal membaca alias TempMail. Pastikan tabel tempmail_user_aliases sudah dibuat.'), { status: 503 });
    const rows = await response.json().catch(() => []);
    return rows?.[0] || null;
  };
  const replaceAlias = async (nextAlias) => {
    const response = await servicePostgrest(env, '/tempmail_user_aliases?on_conflict=user_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: [{ user_id: user.id, email: nextAlias.email, token: nextAlias.token || '', provider: nextAlias.provider || 'gmailapi', created_at: new Date().toISOString() }],
    });
    if (response.status === 409) return null;
    if (!response.ok) throw Object.assign(new Error('Gagal menyimpan alias TempMail.'), { status: 503 });
    const rows = await response.json().catch(() => []);
    return rows?.[0] || nextAlias;
  };
  const deleteAlias = async () => {
    const response = await servicePostgrest(env, `/tempmail_user_aliases?user_id=eq.${encodeURIComponent(user.id)}`, { method: 'DELETE' });
    if (!response.ok) throw Object.assign(new Error('Gagal menghapus alias TempMail.'), { status: 503 });
  };
  const aliasBelongsToConnection = (alias, connection) => {
    const address = String(alias?.email || '').toLowerCase();
    const account = String(connection?.email || '').toLowerCase();
    const plus = address.indexOf('+');
    const at = address.lastIndexOf('@');
    const accountAt = account.lastIndexOf('@');
    return plus > 0 && at > plus && accountAt > 0
      && address.slice(0, plus) === account.slice(0, accountAt)
      && address.slice(at + 1) === account.slice(accountAt + 1);
  };
  const createGmailAliasForUser = async (connection, requestedTag = '') => {
    const custom = Boolean(String(requestedTag || '').trim());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const created = createGmailApiAlias(connection.email, requestedTag);
      const saved = await replaceAlias(created);
      if (saved) return saved;
      if (custom) break;
    }
    throw Object.assign(new Error('Akhiran Gmail ini sudah dipakai. Coba akhiran lain atau kosongkan kolom untuk angka acak.'), { status: 409 });
  };

  try {
    if (action === 'gmail-status') {
      if (!isGmailApiConfigured(env)) return respond({ configured: false, connected: false, email: null });
      const connection = await getGmailConnection(env, user.id);
      return respond({ configured: true, connected: Boolean(connection?.email), email: connection?.email || null });
    }
    if (action === 'gmail-connect') {
      if (request.method !== 'GET') return respond({ error: 'Method tidak diizinkan.' }, 405);
      if (!isGmailApiConfigured(env)) return respond({ error: 'Mode Hubungkan Gmail belum dikonfigurasi. Siapkan Google OAuth dan secret Gmail pada Cloudflare Worker.' }, 503);
      const { authUrl, cookie } = await buildGmailAuthUrl(env, user.id, url.toString());
      return respond({ authUrl }, 200, { 'set-cookie': cookie });
    }
    if (action === 'gmail-disconnect') {
      if (request.method !== 'POST') return respond({ error: 'Method tidak diizinkan.' }, 405);
      await deleteGmailConnection(env, user.id);
      await deleteAlias();
      return respond({ disconnected: true });
    }
    if (action === 'alias' || action === 'status') {
      const alias = await readAlias();
      return respond({ ok: true, alias: alias ? { email: alias.email, provider: alias.provider, createdAt: alias.created_at } : null });
    }
    if (action === 'create' || action === 'rotate') {
      if (request.method !== 'POST') return respond({ error: 'Method tidak diizinkan.' }, 405);
      if (isGmailApiConfigured(env)) {
        const connection = await getGmailConnection(env, user.id);
        if (!connection) return respond({ error: 'Hubungkan akun Gmail terlebih dahulu.' }, 400);
        const existing = await readAlias();
        if (action === 'create' && existing?.provider === 'gmailapi' && aliasBelongsToConnection(existing, connection)) {
          return respond({ ok: true, email: existing.email, provider: existing.provider, createdAt: existing.created_at, reused: true });
        }
        const saved = await createGmailAliasForUser(connection, action === 'rotate' ? url.searchParams.get('tag') || '' : '');
        return respond({ ok: true, email: saved.email, provider: saved.provider || 'gmailapi', createdAt: saved.created_at || new Date().toISOString(), reused: false });
      }
      const alias = await readAlias();
      if (action === 'create' && alias) return respond({ ok: true, email: alias.email, provider: alias.provider, createdAt: alias.created_at, reused: true });
      const created = await createMailtmAlias();
      const row = { user_id: user.id, email: created.email, token: created.token, provider: created.provider, created_at: new Date().toISOString() };
      const saveRes = await servicePostgrest(env, '/tempmail_user_aliases?on_conflict=user_id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: [row],
      });
      if (!saveRes.ok) return respond({ error: 'Mailbox dibuat, tetapi gagal menyimpan alias.' }, 503);
      const saved = (await saveRes.json().catch(() => []))?.[0] || row;
      return respond({ ok: true, email: saved.email, provider: saved.provider, createdAt: saved.created_at, reused: false });
    }
    if (action === 'messages' || action === 'message') {
      const alias = await readAlias();
      if (!alias) return respond({ error: 'Buat alamat TempMail terlebih dahulu.' }, 404);
      const requestedEmail = String(url.searchParams.get('email') || '');
      if (!requestedEmail || requestedEmail.toLowerCase() !== String(alias.email).toLowerCase()) return respond({ error: 'Alamat tidak ditemukan pada akun admin ini.' }, 404);
      let result;
      if (alias.provider === 'gmailapi') {
        const connection = await getGmailConnection(env, user.id);
        if (!connection || !aliasBelongsToConnection(alias, connection)) return respond({ error: 'Koneksi Gmail tidak cocok dengan akhiran yang aktif. Hubungkan ulang Gmail atau buat akhiran baru.' }, 409);
        if (action === 'messages') result = await listGmailMessages(env, connection, alias.email);
        else {
          const messageId = String(url.searchParams.get('messageId') || '');
          if (!messageId) return respond({ error: 'Parameter messageId wajib diisi.' }, 400);
          result = await getGmailMessage(env, connection, alias.email, messageId);
        }
      } else {
        const credentials = parseMailtmCredentials(alias.token);
        if (action === 'messages') result = await fetchMailtmMessages(credentials.token);
        else {
          const messageId = String(url.searchParams.get('messageId') || '');
          if (!messageId) return respond({ error: 'Parameter messageId wajib diisi.' }, 400);
          result = await fetchMailtmMessage(credentials.token, messageId);
        }
      }
      return respond(action === 'messages' ? { ok: true, messages: result } : { ok: true, message: result });
    }
    return respond({ error: 'Action TempMail tidak dikenal.' }, 400);
  } catch (error) {
    return respond({ error: String(error?.message || 'Layanan TempMail gagal. Coba lagi.'), ...(error?.hint ? { hint: error.hint } : {}) }, Number(error?.status) || 502);
  }
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

// ---- Pintu masuk status akun (fix39) --------------------------------------
// Akun yang di-suspend/banned ditolak di SEMUA jalur /api/* yang butuh login,
// bukan hanya di jalur berbayar. Jalur worker memakai service_role sehingga
// menembus RLS: policy database saja tidak cukup menahan akun yang diblokir.
// Hanya status yang TERBACA banned/suspended yang memblokir; kegagalan membaca
// database tidak boleh mengunci semua orang (semantik sama dengan
// assertAccountActive() di freebeatMcp.js).
const ACCOUNT_BLOCK_MESSAGE = {
  banned: 'Akun Anda diblokir. Hubungi admin BLEA.',
  suspended: 'Akun Anda sedang ditangguhkan sementara. Hubungi admin BLEA.',
};
// 'account' harus tetap terbaca supaya UI bisa menampilkan alasannya;
// 'admin/users/action' harus tetap terbuka supaya admin bisa memulihkan status.
const ACCOUNT_GATE_EXEMPT = new Set(['account', 'admin/users/action']);
const ACCOUNT_STATUS_TTL = 30_000;
const accountStatusCache = new Map();      // user_id  -> { status, at }
const accountTokenCache = new Map();       // sidik token -> { status, at }

function pruneAccountCache(cache) {
  if (cache.size <= 500) return;
  for (const [key, value] of cache) {
    if (Date.now() - value.at >= ACCOUNT_STATUS_TTL) cache.delete(key);
  }
}

// Sidik jari token (bukan token mentah) supaya gerbang tidak perlu memanggil
// /auth/v1/user dua kali pada setiap permintaan dalam jendela cache.
async function tokenFingerprint(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`blea-account-gate-v1:${token}`));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readAccountStatus(env, userId) {
  const cached = accountStatusCache.get(userId);
  if (cached && Date.now() - cached.at < ACCOUNT_STATUS_TTL) return cached.status;
  let status = null;
  try {
    const res = await servicePostgrest(env, `/profiles?id=eq.${encodeURIComponent(userId)}&select=status&limit=1`);
    const rows = await res.json().catch(() => null);
    if (Array.isArray(rows)) status = rows[0]?.status ?? null;
  } catch {
    status = null;
  }
  accountStatusCache.set(userId, { status, at: Date.now() });
  pruneAccountCache(accountStatusCache);
  return status;
}

function isBlockedAccountStatus(status) {
  return status === 'banned' || status === 'suspended';
}

async function accountGate(request, env, path) {
  if (ACCOUNT_GATE_EXEMPT.has(path)) return null;
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!token) return null;              // jalur tanpa login: handler-nya sendiri yang menolak
  let status = null;
  try {
    const fingerprint = await tokenFingerprint(token);
    const cached = accountTokenCache.get(fingerprint);
    if (cached && Date.now() - cached.at < ACCOUNT_STATUS_TTL) {
      status = cached.status;
    } else {
      const user = await getUser(env, token);
      if (!user?.id) return null;       // token tidak sah: biar handler mengembalikan 401
      status = await readAccountStatus(env, user.id);
      accountTokenCache.set(fingerprint, { status, at: Date.now() });
      pruneAccountCache(accountTokenCache);
    }
  } catch {
    return null;                        // gerbang tidak boleh menjatuhkan permintaan
  }
  if (!isBlockedAccountStatus(status)) return null;
  return jsonResponse({ error: ACCOUNT_BLOCK_MESSAGE[status], code: `account_${status}`, account_status: status }, 403);
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
  'Kamu adalah BLEA AI, agen mandiri dan cermat di BLEA AI Studio. Pahami maksud dan konteks percakapan, jawab dalam bahasa pengguna (Bahasa Indonesia bila pengguna memakai Bahasa Indonesia), dan berikan jawaban akurat, terstruktur, serta langsung pada inti.',
  'Berpikirlah secara analitis: pecah masalah menjadi langkah yang relevan, periksa asumsi, bedakan fakta dari perkiraan, dan jangan mengarang detail atau sumber. Berikan solusi praktis beserta alasan ringkasnya.',
  'Jika informasi dalam konteks cukup, jawab langsung tanpa pencarian. Jika pertanyaan bergantung pada informasi terkini, sumber khusus, atau kamu tidak yakin / tidak memiliki jawaban yang memadai, minta pencarian otomatis dengan satu blok persis seperti ```search\n{"query":"kata kunci pencarian spesifik"}\n``` lalu berikan jawaban sementara yang singkat. Jangan tampilkan instruksi pencarian kepada pengguna; sistem akan mencari beberapa sumber dan memintamu menyusun jawaban final berbasis temuannya. Jika hasil riset tetap tidak cukup, nyatakan ketidakpastian dengan jujur.',
  'Saat menerima konteks riset, bandingkan sumber dan tanggalnya, utamakan sumber primer/otoritatif, sertakan tautan sumber yang relevan, dan jangan klaim telah memverifikasi sesuatu yang tidak didukung hasil tersebut.',
  'Koneksi aplikasi hanya tersedia sesuai kapabilitas yang benar-benar aktif. Bila pengguna meminta manajemen catatan, dokumen, saluran, atau repository, jangan mengklaim tindakan telah dilakukan tanpa tool yang tersedia.',
  'Jawaban biasa gunakan teks yang mudah dibaca. Bila memberikan kode, script, atau prompt, bungkus dalam blok kode (```), bukan blok pencarian.',
].join(' ');

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')
    .trim();
}

// Multi-source web research. Each source is isolated so one outage never blocks the others.
async function webSearch(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const timeout = { signal: AbortSignal.timeout(8_000) };
  const json = async (url, options = {}) => {
    const response = await fetch(url, { ...timeout, ...options, headers: { accept: 'application/json', ...(options.headers || {}) } });
    if (!response.ok) return null;
    return response.json().catch(() => null);
  };
  const tasks = [
    (async () => {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
        ...timeout, headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 BLEA-AI/1.0' },
      });
      if (!response.ok) return [];
      const html = await response.text();
      const rows = [];
      const re = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,700}?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = re.exec(html)) && rows.length < 5) {
        let href = match[1];
        try { const parsed = new URL(href, 'https://duckduckgo.com'); href = parsed.searchParams.get('uddg') || href; } catch {}
        const title = stripHtmlTags(match[2]);
        if (title && /^https?:\/\//i.test(href)) rows.push({ title, url: href, snippet: stripHtmlTags(match[3]), source: 'Web · DuckDuckGo', sourceLabel: 'Web · DuckDuckGo' });
      }
      return rows;
    })().catch(() => []),
    json(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`).then((data) => {
      const rows = [];
      if (data?.AbstractText) rows.push({ title: data.Heading || q, url: data.AbstractURL || 'https://duckduckgo.com/', snippet: data.AbstractText, source: 'Ringkasan · DuckDuckGo', sourceLabel: 'Ringkasan · DuckDuckGo' });
      const visit = (topics) => (topics || []).forEach((item) => item.Topics ? visit(item.Topics) : item.Text && item.FirstURL && rows.push({ title: item.Text.split(' - ')[0], url: item.FirstURL, snippet: item.Text, source: 'Ringkasan · DuckDuckGo', sourceLabel: 'Ringkasan · DuckDuckGo' }));
      visit(data?.RelatedTopics);
      return rows.slice(0, 4);
    }).catch(() => []),
    ...['en', 'id'].map((lang) => json(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=${encodeURIComponent(q)}`).then((data) => (data?.query?.search || []).map((row) => ({ title: row.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(row.title.replace(/ /g, '_'))}`, snippet: stripHtmlTags(row.snippet || ''), source: `Wikipedia · ${lang.toUpperCase()}`, sourceLabel: `Wikipedia · ${lang.toUpperCase()}` }))).catch(() => [])),
    json(`https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&order=desc&sort=relevance&pagesize=4&q=${encodeURIComponent(q)}`).then((data) => (data?.items || []).map((row) => ({ title: row.title, url: row.link, snippet: `${row.is_answered ? 'Answered. ' : ''}${row.answer_count || 0} answers · score ${row.score || 0}`, source: 'Stack Overflow', sourceLabel: 'Stack Overflow' }))).catch(() => []),
    json(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=4`, { headers: { accept: 'application/vnd.github+json' } }).then((data) => (data?.items || []).map((row) => ({ title: row.full_name, url: row.html_url, snippet: row.description || `GitHub repository · ${row.stargazers_count} stars`, source: 'GitHub', sourceLabel: 'GitHub' }))).catch(() => []),
    json(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=4`).then((data) => (data?.hits || []).map((row) => ({ title: row.title || row.story_title, url: row.url || `https://news.ycombinator.com/item?id=${row.objectID}`, snippet: `${row.points || 0} points · ${row.num_comments || 0} comments`, source: 'Hacker News', sourceLabel: 'Hacker News' }))).catch(() => []),
  ];
  const groups = await Promise.all(tasks);
  const seen = new Set();
  return groups.flat().filter((row) => {
    if (!row?.title || !row?.url || seen.has(row.url)) return false;
    seen.add(row.url);
    return true;
  }).slice(0, 16).map((row) => ({ ...row, excerpt: row.excerpt || row.snippet || '' }));
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

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function hasWorkersAiBinding(env) {
  return Boolean(env?.AI && typeof env.AI.run === 'function');
}

function hasValidCloudflareRestBase(baseUrl) {
  const base = resolveProviderApiBase('cloudflare', baseUrl);
  if (!base || !isValidHttpBaseUrl(base)) return false;
  try {
    const parsed = new URL(base);
    return !/[<{]account[_-]?id[>}]/i.test(base) && /\/accounts\/[^/]+\/ai/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function hasCloudflareRestConfig(keyRow) {
  return Boolean(keyRow?.api_key && keyRow.api_key !== 'binding:AI' && hasValidCloudflareRestBase(keyRow.base_url));
}

function isChatCapableModelId(modelId) {
  const id = String(modelId || '').trim();
  if (!id || isVideoModelId(id)) return false;
  return !/(^|\/|-)(embedding|embed|rerank|whisper|tts|speech|dall-e|imagen|flux|stable-diffusion|midjourney|moderation|bge-|melo|aura|nova-|qwen-image|qwen3-asr|asr-flash)/i.test(id);
}

function scoreFallbackModel(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/^@cf\/openai\/gpt-oss-120b/.test(id)) return 150;
  if (/^@cf\/deepseek-ai\/deepseek-r1-distill-qwen-32b/.test(id)) return 145;
  if (/^@cf\/meta\/llama-4-scout-17b-16e-instruct/.test(id)) return 138;
  if (/^@cf\/qwen\/qwen2\.5-coder-32b-instruct/.test(id)) return 136;
  if (/^@cf\/(meta\/llama-3\.3-70b-instruct-fp8-fast|qwen\/qwen3-30b-a3b-fp8|openai\/gpt-oss-20b)/.test(id)) return 130;
  if (/^@cf\/(meta\/llama-3\.1-8b-instruct-fp8-fast|google\/gemma-3-12b-it|zai-org\/glm-4\.7-flash)/.test(id)) return 118;
  if (/^@cf\//.test(id)) return 112;
  if (/gemini-2\.5-flash:free|gemini-2\.5-flash-lite:free|gpt-oss-120b:free|mistral-small:free|llama-3\.3-70b:free/.test(id)) return 120;
  if (/qwen3\.6-27b:free|glm-5\.3-flash:free|nemotron-3-super-120b|gemini-3\.1-flash-lite:free/.test(id)) return 105;
  if (!id.endsWith(':free')) return 110;
  if (/alpha|uncensored|-0731|meromero|darksoul|chimerax|phonellm|qwen3\.7-flash:free|villanova|apnea/.test(id)) return 15;
  if (/coder|math|thinking|reasoning/.test(id)) return 30;
  if (/gemini|deepseek|qwen|mistral|nemotron|gpt-5|gpt-4|llama|glm/.test(id)) return 75;
  return 45;
}

function getModelFamily(modelId) {
  const id = String(modelId || '').toLowerCase();
  if (/gemini/.test(id)) return 'gemini';
  if (/gemma/.test(id)) return 'gemma';
  if (/deepseek/.test(id)) return 'deepseek';
  if (/qwen|qwq/.test(id)) return 'qwen';
  if (/mistral|codestral/.test(id)) return 'mistral';
  if (/llama/.test(id)) return 'llama';
  if (/glm/.test(id)) return 'glm';
  if (/granite/.test(id)) return 'granite';
  if (/nemotron/.test(id)) return 'nemotron';
  if (/gpt-/.test(id)) return 'gpt';
  if (/claude/.test(id)) return 'claude';
  if (/minimax/.test(id)) return 'minimax';
  return id.split(/[:-]/)[0] || 'other';
}

function extractAssistantReply(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  const rawContent = msg?.content;
  let text = '';
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = rawContent
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!text.trim() && typeof msg?.reasoning_content === 'string') {
    text = msg.reasoning_content;
  } else if (!text.trim() && typeof msg?.reasoning === 'string') {
    text = msg.reasoning;
  } else if (!text.trim() && typeof choice?.text === 'string') {
    text = choice.text;
  } else if (!text.trim() && typeof data?.response === 'string') {
    text = data.response;
  } else if (!text.trim() && typeof data?.result?.response === 'string') {
    text = data.result.response;
  } else if (!text.trim() && typeof data?.output_text === 'string') {
    text = data.output_text;
  } else if (!text.trim() && Array.isArray(data?.output)) {
    text = data.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => part?.text || '')
      .filter(Boolean)
      .join('\n');
  }
  return text.trim();
}

function normalizeMessagesForWorkersAi(messages, modelId) {
  const supportsVision = /llama-3\.2-11b-vision|llama-4-scout|gemma-3|gemma-4/i.test(String(modelId || ''));
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const role = String(m?.role || 'user');
    if (typeof m?.content === 'string') return { role, content: m.content };
    if (Array.isArray(m?.content)) {
      if (supportsVision) return { role, content: m.content };
      const flattened = m.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part?.type === 'text' && part.text) return part.text;
          if (part?.type === 'image_url' && part.image_url?.url) return `[Gambar: ${part.image_url.url}]`;
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return { role, content: flattened };
    }
    return { role, content: String(m?.content ?? '') };
  });
}

async function sendCloudflareBindingChat({ ai, model, payload, stream = false }) {
  try {
    const messages = normalizeMessagesForWorkersAi(payload.messages, model);
    const input = {
      messages,
      stream: Boolean(stream),
      temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.35,
      max_tokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : 4096,
    };
    let data;
    try {
      data = await ai.run(model, input);
    } catch (error) {
      if (!Number.isFinite(payload.max_tokens) && /max.?tokens|token limit|too many tokens|invalid.*token/i.test(String(error?.message || error))) {
        data = await ai.run(model, { ...input, max_tokens: 2048 });
      } else {
        throw error;
      }
    }
    if (stream && data && typeof data.getReader === 'function') {
      return { ok: true, status: 200, stream: data };
    }
    if (stream && data && typeof data[Symbol.asyncIterator] === 'function') {
      const encoder = new TextEncoder();
      const asyncStream = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of data) {
              const line = typeof chunk === 'string' ? chunk : JSON.stringify(chunk);
              controller.enqueue(encoder.encode(`data: ${line}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } finally {
            controller.close();
          }
        },
      });
      return { ok: true, status: 200, stream: asyncStream };
    }
    return { ok: true, status: 200, data: data || {} };
  } catch (e) {
    const msg = String(e?.message || e || 'Workers AI binding request failed');
    const status = /429|limit|quota|neuron/i.test(msg)
      ? 429
      : /401|403|unauthorized|forbidden/i.test(msg)
        ? 403
        : 502;
    return {
      ok: false,
      status,
      errorInfo: parseChatUpstreamError(msg, status),
    };
  }
}

function buildChatFallbackCandidates({ primaryProvider, primaryModel, keyByProvider, dbModelRows, env, poolByProvider }) {
  const seen = new Set([`${primaryProvider}:${primaryModel}`]);
  const raw = [];
  const workersAiBound = hasWorkersAiBinding(env);
  for (const row of dbModelRows || []) {
    const prov = String(row.provider || 'unorouter').trim().toLowerCase();
    const model = String(row.model || '').trim();
    if (!model || !isChatCapableModelId(model)) continue;
    const key = `${prov}:${model}`;
    if (seen.has(key)) continue;
    const keyRow = keyByProvider.get(prov);
    const poolRows = poolByProvider?.get(prov);
    if (poolRows?.length) {
      // Satu kandidat per akun pool: failover lintas-akun berlaku juga untuk
      // rantai fallback antar-model, bukan hanya permintaan utama.
      poolRows.forEach((poolRow, index) => {
        seen.add(`${key}#${index}`);
        raw.push({
          provider: prov,
          model,
          family: getModelFamily(model),
          apiKey: poolRow.api_key,
          baseUrl: poolRow.base_url || '',
          score: (prov !== primaryProvider ? 30 : 0) + scoreFallbackModel(model) - index,
        });
      });
      continue;
    }
    let apiKey = keyRow?.api_key || (prov === 'unorouter' && model.endsWith(':free') ? 'use-free' : '');
    if (prov === 'cloudflare') {
      if (!workersAiBound && !hasCloudflareRestConfig(keyRow)) continue;
      if (!apiKey && workersAiBound) apiKey = 'binding:AI';
    }
    if (!apiKey) continue;
    seen.add(key);
    raw.push({
      provider: prov,
      model,
      family: getModelFamily(model),
      apiKey,
      baseUrl: keyRow?.base_url || '',
      score: (prov !== primaryProvider ? 30 : 0) + scoreFallbackModel(model),
    });
  }
  raw.sort((a, b) => b.score - a.score);

  // Round-robin by provider:family so fallback spreads across distinct model backends first
  const primaryFamily = getModelFamily(primaryModel);
  const byBucket = new Map();
  for (const item of raw) {
    const bucketKey = `${item.provider}:${item.family}`;
    if (!byBucket.has(bucketKey)) byBucket.set(bucketKey, []);
    byBucket.get(bucketKey).push(item);
  }
  const bucketEntries = [...byBucket.entries()].sort((a, b) => {
    const aSame = a[0] === `${primaryProvider}:${primaryFamily}` ? 1 : 0;
    const bSame = b[0] === `${primaryProvider}:${primaryFamily}` ? 1 : 0;
    if (aSame !== bSame) return aSame - bSame;
    return (b[1][0]?.score || 0) - (a[1][0]?.score || 0);
  });

  const diversified = [];
  let remaining = true;
  while (remaining) {
    remaining = false;
    for (const [, list] of bucketEntries) {
      if (list.length) {
        diversified.push(list.shift());
        if (list.length) remaining = true;
      }
    }
  }
  return diversified;
}

// Alibaba: coba akun pool secara berurutan; kuota/rate-limit/auth gagal →
// akun ditandai cooldown & akun berikutnya dicoba. Mengembalikan { attempt, cand }.
async function sendWithAlibabaPool({ candidates, model, payload, timeoutMs = 60_000, env, stream = false }) {
  let lastAttempt = null;
  let lastCand = null;
  for (const cand of candidates) {
    const attempt = await sendChatCompletionRequest({
      provider: 'alibaba',
      model,
      apiKey: cand.api_key,
      baseUrl: cand.base_url,
      payload,
      timeoutMs,
      env,
      stream,
    });
    if (attempt.ok) {
      await markPoolKeyResult(env, cand, { success: true });
      return { attempt, cand };
    }
    lastAttempt = attempt;
    lastCand = cand;
    const errText = attempt.errorInfo?.rawDetail || '';
    if (isAlibabaQuotaError(attempt.status, errText)) {
      await markPoolKeyResult(env, cand, { success: false, error: `HTTP ${attempt.status}: ${errText}`.slice(0, 280) });
      continue;
    }
    return { attempt, cand };
  }
  return { attempt: lastAttempt, cand: lastCand };
}

async function sendChatCompletionRequest({ provider, model, apiKey, baseUrl, payload, timeoutMs = 60_000, env, stream = false }) {
  if (provider === 'cloudflare') {
    const restReady = apiKey && apiKey !== 'binding:AI' && hasValidCloudflareRestBase(baseUrl);
    if (!restReady) {
      if (hasWorkersAiBinding(env)) {
        return sendCloudflareBindingChat({ ai: env.AI, model, payload, stream });
      }
      return {
        ok: false,
        status: 400,
        errorInfo: parseChatUpstreamError(
          'Cloudflare Workers AI belum aktif. Deploy Worker dengan binding [ai] atau isi Base URL Account ID & API Token di Admin Panel.',
          400,
        ),
      };
    }
  }
  const resolvedBase = resolveProviderApiBase(provider, baseUrl);
  if (!resolvedBase || !isValidHttpBaseUrl(resolvedBase)) {
    return {
      ok: false,
      status: 400,
      errorInfo: parseChatUpstreamError(
        `Base URL untuk provider "${provider}" tidak valid. Periksa pengaturan di Admin Panel → Provider & API Key.`,
        400,
      ),
    };
  }
  const chatUrl = provider === 'alibaba'
    ? `${resolvedBase}/compatible-mode/v1/chat/completions`
    : `${resolvedBase}/chat/completions`;
  const upstream = await fetch(chatUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://blea-ai.blea-ai.workers.dev',
      'X-Title': 'BLEA AI',
    },
    body: JSON.stringify({
      ...payload,
      ...(provider === 'cloudflare' ? {
        temperature: Number.isFinite(payload.temperature) ? payload.temperature : 0.35,
        max_tokens: Number.isFinite(payload.max_tokens) ? payload.max_tokens : 4096,
      } : {}),
      model,
      stream: Boolean(stream),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok) {
    const rawText = await upstream.text().catch(() => '');
    const errorInfo = parseChatUpstreamError(rawText, upstream.status, upstream.headers.get('retry-after'));
    return { ok: false, status: upstream.status, errorInfo };
  }
  const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
  if (stream && contentType.includes('text/event-stream') && upstream.body) {
    return { ok: true, status: upstream.status, stream: upstream.body };
  }
  const data = await upstream.json().catch(() => ({}));
  return { ok: true, status: upstream.status, data };
}

function extractSseEventsFromLines(lines) {
  const events = [];
  let done = false;
  let streamError = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    const payloadStr = line.slice(5).trim();
    if (!payloadStr) continue;
    if (payloadStr === '[DONE]') {
      done = true;
      break;
    }
    let parsed = null;
    try { parsed = JSON.parse(payloadStr); } catch {}
    if (!parsed) continue;
    if (parsed.error) {
      streamError = parsed.error;
      continue;
    }
    const { contentDelta, reasoningDelta } = parseUpstreamSsePayload(parsed);
    if (reasoningDelta) events.push({ type: 'thinking', text: reasoningDelta });
    if (contentDelta) events.push({ type: 'delta', text: contentDelta });
  }
  return { events, done, streamError };
}

async function probeChatStreamAttempt(attempt) {
  if (!attempt.ok) return attempt;
  if (attempt.data) {
    const reply = extractAssistantReply(attempt.data);
    const msg = attempt.data?.choices?.[0]?.message;
    const reasoning = String(msg?.reasoning_content || msg?.reasoning || '').trim();
    if (!reply && !reasoning) {
      return {
        ok: false,
        status: 502,
        errorInfo: parseChatUpstreamError('Model mengembalikan respons kosong.', 502),
      };
    }
    return { ok: true, mode: 'json', reply: reply || reasoning, reasoning: reply ? reasoning : '' };
  }
  if (!attempt.stream || typeof attempt.stream.getReader !== 'function') {
    return {
      ok: false,
      status: 502,
      errorInfo: parseChatUpstreamError('Stream upstream tidak tersedia.', 502),
    };
  }

  const reader = attempt.stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const initialEvents = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          const tail = extractSseEventsFromLines(buffer.split(/\r?\n/));
          initialEvents.push(...tail.events);
          buffer = '';
          if (tail.streamError && !initialEvents.length) {
            const msg = typeof tail.streamError === 'string' ? tail.streamError : (tail.streamError.message || JSON.stringify(tail.streamError));
            return { ok: false, status: 502, errorInfo: parseChatUpstreamError(msg, 502) };
          }
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      const parsed = extractSseEventsFromLines(parts);
      initialEvents.push(...parsed.events);
      if (parsed.streamError && !initialEvents.length) {
        const msg = typeof parsed.streamError === 'string' ? parsed.streamError : (parsed.streamError.message || JSON.stringify(parsed.streamError));
        await reader.cancel().catch(() => {});
        return { ok: false, status: 502, errorInfo: parseChatUpstreamError(msg, 502) };
      }
      if (initialEvents.length > 0 || parsed.done) {
        return {
          ok: true,
          mode: 'stream',
          reader,
          decoder,
          buffer,
          initialEvents,
          streamDone: parsed.done,
        };
      }
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    return { ok: false, status: 502, errorInfo: parseChatUpstreamError(String(e), 502) };
  }

  if (initialEvents.length > 0) {
    return {
      ok: true,
      mode: 'stream',
      reader,
      decoder,
      buffer: '',
      initialEvents,
      streamDone: true,
    };
  }
  return {
    ok: false,
    status: 502,
    errorInfo: parseChatUpstreamError('Model mengembalikan stream kosong.', 502),
  };
}

async function materializeProbedStream(probed) {
  if (probed.mode === 'json') return probed;
  let reply = '';
  let reasoning = '';
  const apply = (events) => events.forEach((event) => {
    if (event.type === 'delta') reply += event.text;
    if (event.type === 'thinking') reasoning += event.text;
  });
  apply(probed.initialEvents || []);
  let { buffer = '', streamDone = false } = probed;
  const { reader, decoder } = probed;
  while (!streamDone) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) apply(extractSseEventsFromLines(buffer.split(/\r?\n/)).events);
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    const parsed = extractSseEventsFromLines(lines);
    apply(parsed.events);
    if (parsed.done) streamDone = true;
  }
  return { ok: true, mode: 'json', reply: reply.trim() || reasoning.trim(), reasoning: reply ? reasoning.trim() : '' };
}

function latestUserQuery(messages) {
  const latest = [...(messages || [])].reverse().find((message) => message?.role === 'user');
  const content = Array.isArray(latest?.content)
    ? latest.content.map((part) => part?.text || '').join(' ')
    : String(latest?.content || '');
  return content.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function formatResearchContext(results, query) {
  if (!results.length) return `Pencarian untuk "${query}" tidak menghasilkan sumber yang dapat digunakan. Jangan mengarang fakta atau sumber; jawab dengan batasan yang jelas.`;
  return [
    `Hasil riset multi-sumber untuk: "${query}". Sintesis dengan cermat, bandingkan temuan, dan kutip tautan yang benar-benar relevan.`,
    ...results.map((result, index) => `${index + 1}. [${result.sourceLabel || result.source || 'Sumber'}] ${result.title}\nURL: ${result.url}\nRingkasan: ${result.excerpt || result.snippet || 'Tidak ada ringkasan.'}`),
    'Tulis jawaban final yang langsung membantu. Jangan menyebut proses internal atau mengeluarkan blok ```search```.',
  ].join('\n\n');
}

function sseEncode(obj) {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function createChatSseResponse({
  probed,
  meta,
  env,
  conversationId,
  userId,
}) {
  const stream = new ReadableStream({
    async start(controller) {
      let fullReply = '';
      let fullReasoning = '';
      try {
        controller.enqueue(sseEncode({ type: 'meta', ...meta }));

        if (probed.mode === 'json') {
          if (probed.reasoning) {
            fullReasoning = probed.reasoning;
            controller.enqueue(sseEncode({ type: 'thinking', text: probed.reasoning }));
          }
          fullReply = probed.reply || '';
          if (fullReply) {
            controller.enqueue(sseEncode({ type: 'delta', text: fullReply }));
          }
        } else {
          for (const ev of probed.initialEvents) {
            if (ev.type === 'thinking') fullReasoning += ev.text;
            if (ev.type === 'delta') fullReply += ev.text;
            controller.enqueue(sseEncode(ev));
          }
          let { buffer, streamDone } = probed;
          const { reader, decoder } = probed;
          while (!streamDone) {
            const { value, done } = await reader.read();
            if (done) {
              buffer += decoder.decode();
              if (buffer.trim()) {
                const tail = extractSseEventsFromLines(buffer.split(/\r?\n/));
                for (const ev of tail.events) {
                  if (ev.type === 'thinking') fullReasoning += ev.text;
                  if (ev.type === 'delta') fullReply += ev.text;
                  controller.enqueue(sseEncode(ev));
                }
              }
              break;
            }
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop() || '';
            const parsed = extractSseEventsFromLines(parts);
            for (const ev of parsed.events) {
              if (ev.type === 'thinking') fullReasoning += ev.text;
              if (ev.type === 'delta') fullReply += ev.text;
              controller.enqueue(sseEncode(ev));
            }
            if (parsed.done) streamDone = true;
          }
        }

        const savedContent = fullReply.trim() || fullReasoning.trim();
        let messageId = '';
        if (savedContent && conversationId) {
          const insertRes = await servicePostgrest(env, '/ai_messages', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: {
              conversation_id: conversationId,
              user_id: userId,
              role: 'assistant',
              content: savedContent,
            },
          });
          if (insertRes.ok) {
            const inserted = await insertRes.json().catch(() => []);
            messageId = inserted?.[0]?.id ?? '';
          }
        }

        controller.enqueue(sseEncode({
          type: 'done',
          ok: true,
          reply: savedContent,
          reasoning: fullReasoning.trim(),
          messageId,
          actions: meta.actions || [],
          model: meta.model,
          provider: meta.provider,
          ...(meta.fallbackFrom ? { fallbackFrom: meta.fallbackFrom, fallbackReason: meta.fallbackReason } : {}),
        }));
      } catch (err) {
        controller.enqueue(sseEncode({ type: 'error', error: String(err?.message || err) }));
      } finally {
        if (probed.mode === 'stream' && probed.reader) {
          await probed.reader.cancel().catch(() => {});
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}

function parseChatUpstreamError(rawText, status, retryAfterHeader) {
  let parsed = {};
  try { parsed = JSON.parse(rawText); } catch {}
  const message = String(
    parsed?.error?.message
    || (typeof parsed?.error === 'string' ? parsed.error : '')
    || parsed?.message
    || rawText
    || '',
  ).trim();
  const code = String(parsed?.error?.code || parsed?.code || '').trim();

  let retryAfterSec = null;
  if (retryAfterHeader && /^\d+$/.test(String(retryAfterHeader).trim())) {
    retryAfterSec = Number(retryAfterHeader);
  } else {
    const match = message.match(/retry\s+in\s+(\d+)\s*s/i) || message.match(/(\d+)\s*(?:seconds?|detik)/i);
    if (match) retryAfterSec = Number(match[1]);
  }

  let friendlyMessage;
  if (status === 429 || code === 'rate_limit_exceeded') {
    friendlyMessage = retryAfterSec
      ? `Batas permintaan model tercapai (429). Coba lagi dalam ${retryAfterSec} detik atau pilih model lain.`
      : 'Batas permintaan model tercapai (429). Silakan tunggu sebentar atau pilih model lain.';
  } else if (status === 402) {
    friendlyMessage = 'Saldo atau kuota API provider tidak mencukupi untuk model ini.';
  } else if (status === 401 || status === 403) {
    friendlyMessage = 'API key provider tidak valid atau ditolak. Periksa pengaturan di Admin Panel.';
  } else if (status === 503 || status === 504 || status === 502) {
    friendlyMessage = 'Server model AI sedang sibuk atau sementara tidak tersedia. Coba lagi sebentar.';
  } else {
    friendlyMessage = message || `Permintaan AI gagal (HTTP ${status}).`;
  }

  return {
    code: code || `http_${status}`,
    retryAfterSec,
    friendlyMessage,
    rawDetail: message.slice(0, 500),
  };
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

function contentAttachmentFilename(prefix, id, contentType, fallbackExt, suffix = '') {
  const safeId = String(id || 'file').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'file';
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  let ext = fallbackExt;
  if (mime === 'video/webm') ext = 'webm';
  else if (mime === 'video/quicktime') ext = 'mov';
  else if (mime === 'video/mp4') ext = 'mp4';
  else if (mime === 'image/png') ext = 'png';
  else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';
  else if (mime === 'image/webp') ext = 'webp';
  else if (mime === 'image/gif') ext = 'gif';
  return `${prefix}-${safeId}${suffix}.${ext}`;
}

function isSafeRemoteMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

async function signImageContentUrl(id, index, env, ttlMs = 2 * 60 * 60 * 1000) {
  const exp = String(Date.now() + ttlMs);
  const msg = new TextEncoder().encode(`img:${id}:${index}:${exp}`);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', await videoMediaKey(env), msg));
  const sig = base64url(sigBytes);
  return `/api/image/content/${encodeURIComponent(id)}?index=${index}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}&download=1`;
}

async function verifyImageContentSig(id, index, exp, sig, env) {
  try {
    if (!id || !exp || !sig || !Number.isInteger(index) || index < 0 || index >= 20) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const msg = new TextEncoder().encode(`img:${id}:${index}:${exp}`);
    return await crypto.subtle.verify('HMAC', await videoMediaKey(env), unbase64url(sig), msg);
  } catch {
    return false;
  }
}

async function attachImageDownloadUrls(generation, env) {
  if (!generation || generation.status !== 'completed' || !generation.id) return generation;
  const urls = Array.isArray(generation.image_urls) && generation.image_urls.length > 0
    ? generation.image_urls
    : (generation.image_url ? [generation.image_url] : []);
  if (!urls.length) return generation;
  const downloadUrls = await Promise.all(urls.map((_, idx) => signImageContentUrl(generation.id, idx, env)));
  return {
    ...generation,
    download_url: downloadUrls[0],
    ...(urls.length > 1 ? { download_urls: downloadUrls } : {}),
  };
}

async function attachImageHistoryDownloads(result, env) {
  if (!result || !Array.isArray(result.generations)) return result;
  const generations = await Promise.all(result.generations.map((item) => attachImageDownloadUrls(item, env)));
  return { ...result, generations };
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
    credits_charged: Number(row.credits_charged || 0),
    credits_refunded: Number(row.credits_refunded || 0),
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

const WAN_VIDEO_SIZE_TABLE = {
  '480p': { '16:9': '832*480', '9:16': '480*832', '1:1': '624*624', '4:3': '832*480', '3:4': '480*832' },
  '720p': { '16:9': '1280*720', '9:16': '720*1280', '1:1': '960*960', '4:3': '1088*832', '3:4': '832*1088' },
  '1080p': { '16:9': '1920*1080', '9:16': '1080*1920', '1:1': '1440*1440', '4:3': '1632*1248', '3:4': '1248*1632' },
};

function mapWanVideoSize(resolution, aspectRatio) {
  const tier = WAN_VIDEO_SIZE_TABLE[String(resolution || '720p').toLowerCase()] || WAN_VIDEO_SIZE_TABLE['720p'];
  return tier[aspectRatio] || tier['16:9'];
}

function buildAlibabaVideoRequest({ model, apiBase, headers, payload }) {
  const spec = getAlibabaVideoModelSpec(model);
  if (!spec) {
    return { error: 'Model video ini belum diverifikasi untuk BLEA (belum ada adapter + pengujian).', status: 400 };
  }
  const upstreamModel = resolveAlibabaCnModelId(spec, apiBase);
  const prompt = String(payload.prompt || '').trim();
  const maxPrompt = spec.maxPrompt || 1500;
  if (prompt.length > maxPrompt) {
    return { error: `${spec.name}: panjang prompt maksimal ${maxPrompt} karakter.`, status: 400 };
  }

  const checkUrl = (value, label) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || trimmed.length > 2048) {
        return { error: `${label} wajib berupa tautan HTTPS yang valid.` };
      }
      return parsed.toString();
    } catch {
      return { error: `${label} wajib berupa tautan HTTPS yang valid.` };
    }
  };
  const checkList = (arr, label) => {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const item of arr) {
      if (!String(item || '').trim()) continue;
      const checked = checkUrl(item, label);
      if (typeof checked === 'object') return checked;
      out.push(checked);
    }
    return out;
  };

  const imageUrl = checkUrl(payload.image_url, 'First Frame / gambar');
  if (typeof imageUrl === 'object') return { error: imageUrl.error, status: 400 };
  const imageLastUrl = checkUrl(payload.image_last_url, 'Last Frame');
  if (typeof imageLastUrl === 'object') return { error: imageLastUrl.error, status: 400 };
  const videoUrl = checkUrl(payload.video_url, 'Video referensi');
  if (typeof videoUrl === 'object') return { error: videoUrl.error, status: 400 };
  const audioUrl = checkUrl(payload.audio_url, 'Audio referensi');
  if (typeof audioUrl === 'object') return { error: audioUrl.error, status: 400 };
  const refImages = checkList(payload.reference_images, 'Foto referensi');
  if (!Array.isArray(refImages)) return { error: refImages.error, status: 400 };
  const refVideos = checkList(payload.reference_videos, 'Video referensi');
  if (!Array.isArray(refVideos)) return { error: refVideos.error, status: 400 };
  const refAudios = checkList(payload.reference_audios, 'Audio referensi');
  if (!Array.isArray(refAudios)) return { error: refAudios.error, status: 400 };

  const defaultRes = spec.resolutions.includes('720p') ? '720p' : spec.resolutions[0];
  const resKey = String(payload.resolution ?? defaultRes).toLowerCase().trim();
  const aspectRatio = String(payload.aspect_ratio || spec.aspectRatios?.[0] || '16:9');
  const defaultDur = spec.durations.includes(5) ? 5 : spec.durations[0];
  const duration = payload.duration == null ? defaultDur : Number(payload.duration);
  const generateAudio = payload.generate_audio !== false;
  const submitUrl = `${apiBase}/api/v1/services/aigc/${spec.endpoint}`;
  const outHeaders = { ...headers, 'X-DashScope-Async': 'enable' };
  const pollBaseUrl = `${apiBase}/api/v1/tasks`;

  // 1. Wan 3.0 (dan prime): frame-mode ATAU reference-mode yang saling eksklusif.
  if (spec.family === 'wan3') {
    const frameMode = Boolean(imageUrl || imageLastUrl);
    const refVideoList = [...(videoUrl ? [videoUrl] : []), ...refVideos];
    const refAudioList = [...(audioUrl ? [audioUrl] : []), ...refAudios];
    const referenceCount = refImages.length + refVideoList.length + refAudioList.length;

    if (imageLastUrl && !imageUrl) {
      return { error: 'Last Frame membutuhkan First Frame. Unggah gambar pertama dulu.', status: 400 };
    }
    if (frameMode && referenceCount > 0) {
      return {
        error: 'Wan 3.0: mode First Frame / First+Last Frame tidak bisa digabung dengan media referensi (foto/video/audio). Hapus salah satu: gunakan mode frame saja, atau mode referensi (maks 10 foto + 5 video + 5 audio).',
        status: 400,
      };
    }
    if (refImages.length > 10) return { error: 'Wan 3.0: maksimal 10 foto referensi per permintaan.', status: 400 };
    if (refVideoList.length > 5) return { error: 'Wan 3.0: maksimal 5 video referensi (total durasi ≤15 detik).', status: 400 };
    if (refAudioList.length > 5) return { error: 'Wan 3.0: maksimal 5 audio referensi (total durasi ≤15 detik).', status: 400 };
    if (referenceCount > 20) return { error: 'Wan 3.0: maksimal 20 materi referensi (foto+video+audio) per permintaan.', status: 400 };

    const media = [];
    if (imageUrl) media.push({ type: 'first_frame', url: imageUrl });
    if (imageLastUrl) media.push({ type: 'last_frame', url: imageLastUrl });
    for (const url of refImages) media.push({ type: 'reference_image', url });
    for (const url of refVideoList) media.push({ type: 'reference_video', url });
    for (const url of refAudioList) media.push({ type: 'reference_audio', url });
    const resMap = { '480p': '480P', '720p': '720P', '1080p': '1080P', '4k': '1080P' };
    const wanRatio = ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive'].includes(aspectRatio) ? aspectRatio : 'adaptive';
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: { prompt: prompt || 'Generate a smooth, natural video.', ...(media.length ? { media } : {}) },
        parameters: {
          resolution: resMap[String(payload.resolution || '720p').toLowerCase()] || '720P',
          ratio: wanRatio,
          duration: Math.max(2, Math.min(30, Number.isFinite(duration) ? duration : 5)),
          prompt_extend: true,
        },
      },
    };
  }

  // Validasi resolusi & durasi untuk seluruh famili terverifikasi lain.
  if (!spec.resolutions.includes(resKey)) {
    return {
      error: `${spec.name} hanya mendukung resolusi ${spec.resolutions.map((r) => r.toUpperCase()).join(', ')}.`,
      status: 400,
    };
  }
  const fixedDurationSet = spec.durations.length <= 3 ? spec.durations : null;
  if (
    !Number.isInteger(duration)
    || duration < spec.minDuration
    || duration > spec.maxDuration
    || (fixedDurationSet && !fixedDurationSet.includes(duration))
  ) {
    return {
      error: fixedDurationSet
        ? `${spec.name} hanya mendukung durasi ${fixedDurationSet.join(' / ')} detik.`
        : `${spec.name} hanya mendukung durasi ${spec.minDuration}–${spec.maxDuration} detik.`,
      status: 400,
    };
  }
  const upperRes = resKey.toUpperCase();

  // 2. Wan T2V (2.6, 2.5, 2.2, 2.1): input.prompt + opsional audio_url; parameters.size W*H.
  if (spec.family === 'wan-t2v') {
    if (!prompt) return { error: `${spec.name} membutuhkan prompt teks.`, status: 400 };
    if (imageUrl || imageLastUrl || videoUrl || refImages.length || refVideos.length || refAudios.length) {
      return { error: `${spec.name} adalah model Text-to-Video (tidak menerima media gambar/video/referensi).`, status: 400 };
    }
    if (audioUrl && !spec.supportsAudioInput) {
      return { error: `${spec.name} tidak mendukung input audio referensi.`, status: 400 };
    }
    const body = {
      model: upstreamModel,
      input: { prompt, ...(spec.supportsAudioInput && audioUrl ? { audio_url: audioUrl } : {}) },
      parameters: {
        size: mapWanVideoSize(resKey, aspectRatio),
        ...(spec.durations.length > 1 || spec.id.startsWith('wan2.1') ? { duration } : {}),
        prompt_extend: true,
        ...(spec.supportsAudioOutput ? { audio: generateAudio } : {}),
        watermark: false,
      },
    };
    return { submitUrl, headers: outHeaders, pollBaseUrl, body };
  }

  // 3. Wan I2V (2.6, 2.5, 2.2, 2.1): input.img_url wajib; parameters.resolution.
  if (spec.family === 'wan-i2v') {
    if (!imageUrl) return { error: `${spec.name} wajib menyertakan gambar First Frame.`, status: 400 };
    if (imageLastUrl || videoUrl || refImages.length || refVideos.length || refAudios.length) {
      return { error: `${spec.name} hanya menerima 1 gambar First Frame (tidak menerima Last Frame, video, atau referensi tambahan).`, status: 400 };
    }
    if (audioUrl && !spec.supportsAudioInput) {
      return { error: `${spec.name} tidak mendukung input audio referensi.`, status: 400 };
    }
    const body = {
      model: upstreamModel,
      input: {
        ...(prompt ? { prompt } : {}),
        img_url: imageUrl,
        ...(spec.supportsAudioInput && audioUrl ? { audio_url: audioUrl } : {}),
      },
      parameters: {
        resolution: upperRes,
        ...(spec.durations.length > 1 || spec.id.startsWith('wan2.5') ? { duration } : spec.id.startsWith('wan2.1-i2v-turbo') ? { duration } : {}),
        prompt_extend: true,
        ...(spec.supportsAudioOutput ? { audio: generateAudio } : {}),
        watermark: false,
      },
    };
    return { submitUrl, headers: outHeaders, pollBaseUrl, body };
  }

  // 4. Wan 2.6 R2V: input.prompt + input.reference_urls[]; parameters.size + duration + audio.
  if (spec.family === 'wan-r2v') {
    if (!prompt) return { error: `${spec.name} membutuhkan prompt (gunakan character1, character2 untuk merujuk media).`, status: 400 };
    if (imageLastUrl || audioUrl || refAudios.length) {
      return { error: `${spec.name} tidak mendukung Last Frame atau audio terpisah.`, status: 400 };
    }
    const referenceUrls = [...refImages, ...(videoUrl ? [videoUrl] : []), ...refVideos];
    if (!referenceUrls.length && imageUrl) referenceUrls.push(imageUrl);
    if (!referenceUrls.length) return { error: `${spec.name} wajib menyertakan minimal 1 gambar atau video referensi.`, status: 400 };
    if (refImages.length > 3 && refVideos.length === 0) return { error: `${spec.name} maksimal 3 gambar referensi.`, status: 400 };
    if (referenceUrls.length > 5) return { error: `${spec.name} maksimal 5 media referensi.`, status: 400 };
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: { prompt, reference_urls: referenceUrls },
        parameters: {
          size: mapWanVideoSize(resKey, aspectRatio),
          duration,
          audio: generateAudio,
          watermark: false,
        },
      },
    };
  }

  // 5. Wan KF2V (2.2-kf2v-flash, 2.1-kf2v-plus): endpoint image2video/video-synthesis; first_frame_url + last_frame_url wajib.
  if (spec.family === 'wan-kf2v') {
    if (!imageUrl || !imageLastUrl) {
      return { error: `${spec.name} wajib menyertakan First Frame dan Last Frame.`, status: 400 };
    }
    if (videoUrl || audioUrl || refImages.length || refVideos.length || refAudios.length) {
      return { error: `${spec.name} hanya mendukung First Frame dan Last Frame.`, status: 400 };
    }
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: {
          ...(prompt ? { prompt } : {}),
          first_frame_url: imageUrl,
          last_frame_url: imageLastUrl,
        },
        parameters: {
          resolution: upperRes,
          prompt_extend: true,
          watermark: false,
        },
      },
    };
  }

  // 6. Wan Animate (wan2.2-animate-move / -mix): endpoint image2video/video-synthesis; image_url + video_url wajib; mode wan-std/wan-pro.
  if (spec.family === 'wan-animate') {
    if (!imageUrl || !videoUrl) {
      return { error: `${spec.name} wajib menyertakan gambar karakter dan video penggerak.`, status: 400 };
    }
    if (imageLastUrl || audioUrl || refImages.length || refVideos.length || refAudios.length) {
      return { error: `${spec.name} hanya menerima 1 gambar karakter dan 1 video referensi.`, status: 400 };
    }
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: { image_url: imageUrl, video_url: videoUrl, watermark: false },
        parameters: { mode: resKey === '1080p' ? 'wan-pro' : 'wan-std' },
      },
    };
  }

  // 7. Wan VACE (wan2.1-vace-plus): input.function (image_reference | video_repainting | video_extension).
  if (spec.family === 'wan-vace') {
    if (!prompt) return { error: `${spec.name} membutuhkan prompt teks.`, status: 400 };
    if (imageLastUrl || audioUrl || refAudios.length) {
      return { error: `${spec.name} tidak mendukung Last Frame atau audio terpisah.`, status: 400 };
    }
    const vaceRefImgs = [...refImages, ...(imageUrl && !refImages.length ? [imageUrl] : [])];
    const requestedFn = String(payload.vace_function || '').trim();
    if (videoUrl) {
      const fn = requestedFn === 'video_extension' ? 'video_extension' : 'video_repainting';
      return {
        submitUrl,
        headers: outHeaders,
        pollBaseUrl,
        body: {
          model: upstreamModel,
          input: fn === 'video_extension'
            ? { function: 'video_extension', prompt, first_clip_url: videoUrl }
            : { function: 'video_repainting', prompt, video_url: videoUrl, control_condition: String(payload.control_condition || 'depth') },
          parameters: { prompt_extend: true, watermark: false },
        },
      };
    }
    if (vaceRefImgs.length > 0) {
      if (vaceRefImgs.length > 4) return { error: `${spec.name} maksimal 4 gambar referensi.`, status: 400 };
      return {
        submitUrl,
        headers: outHeaders,
        pollBaseUrl,
        body: {
          model: upstreamModel,
          input: { function: 'image_reference', prompt, ref_images_url: vaceRefImgs },
          parameters: { prompt_extend: true, size: mapWanVideoSize('720p', aspectRatio), watermark: false },
        },
      };
    }
    return { error: `${spec.name} wajib menyertakan minimal 1 gambar referensi atau 1 video sumber.`, status: 400 };
  }

  // 8. HappyHorse T2V: input.prompt; tanpa media.
  if (spec.family === 'happyhorse-t2v') {
    if (!prompt) return { error: `${spec.name} membutuhkan prompt teks.`, status: 400 };
    if (imageUrl || imageLastUrl || videoUrl || audioUrl || refImages.length || refVideos.length || refAudios.length) {
      return { error: `${spec.name} adalah model Text-to-Video (tidak menerima media lampiran).`, status: 400 };
    }
    const hhRatio = spec.aspectRatios.includes(aspectRatio) ? aspectRatio : '16:9';
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: { prompt },
        parameters: { resolution: upperRes, ratio: hhRatio, duration, watermark: false },
      },
    };
  }

  // 9. HappyHorse I2V: wajib First Frame (type: first_frame); tolak reference_images/video/audio; tanpa ratio.
  if (spec.family === 'happyhorse-i2v') {
    if (!imageUrl || refImages.length || refVideos.length || refAudios.length || imageLastUrl || videoUrl || audioUrl) {
      return { error: `${spec.name} wajib menggunakan 1 gambar First Frame (hanya media type first_frame; tidak menerima reference_images, Last Frame, video, atau audio).`, status: 400 };
    }
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: {
          ...(prompt ? { prompt } : {}),
          media: [{ type: 'first_frame', url: imageUrl }],
        },
        parameters: { resolution: upperRes, duration, watermark: false },
      },
    };
  }

  // 10. HappyHorse R2V: wajib 1-9 gambar referensi (type: reference_image).
  if (spec.family === 'happyhorse-r2v') {
    if (!prompt) return { error: `${spec.name} membutuhkan prompt teks (rujuk [Image 1], [Image 2], ...).`, status: 400 };
    if (imageLastUrl || videoUrl || audioUrl || refVideos.length || refAudios.length) {
      return { error: `${spec.name} hanya mendukung gambar referensi (tidak mendukung video, audio, atau Last Frame).`, status: 400 };
    }
    const imgs = refImages.length ? refImages : (imageUrl ? [imageUrl] : []);
    if (!imgs.length || imgs.length > 9) {
      return { error: `${spec.name} wajib menyertakan 1–9 gambar referensi.`, status: 400 };
    }
    const hhRatio = spec.aspectRatios.includes(aspectRatio) ? aspectRatio : '16:9';
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: {
          prompt,
          media: imgs.map((url) => ({ type: 'reference_image', url })),
        },
        parameters: { resolution: upperRes, ratio: hhRatio, duration, watermark: false },
      },
    };
  }

  // 11. HappyHorse 1.0 Video Edit: wajib 1 video + 0-5 gambar referensi.
  if (spec.family === 'happyhorse-edit') {
    if (!videoUrl) return { error: `${spec.name} wajib menyertakan video sumber.`, status: 400 };
    if (imageLastUrl || audioUrl || refVideos.length || refAudios.length) {
      return { error: `${spec.name} hanya menerima 1 video sumber dan 0–5 gambar referensi.`, status: 400 };
    }
    const imgs = refImages.length ? refImages : (imageUrl ? [imageUrl] : []);
    if (imgs.length > 5) return { error: `${spec.name} maksimal 5 gambar referensi.`, status: 400 };
    return {
      submitUrl,
      headers: outHeaders,
      pollBaseUrl,
      body: {
        model: upstreamModel,
        input: {
          ...(prompt ? { prompt } : {}),
          media: [
            { type: 'video', url: videoUrl },
            ...imgs.map((url) => ({ type: 'reference_image', url })),
          ],
        },
        parameters: {
          resolution: upperRes,
          watermark: false,
          audio_setting: generateAudio ? 'auto' : 'origin',
        },
      },
    };
  }

  return { error: 'Adapter video Alibaba tidak ditemukan untuk model ini.', status: 400 };
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
  const asUrlList = (value, limit) => (Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim())
    .filter((item) => /^https:\/\//i.test(item))
    .slice(0, limit);
  const refImages = asUrlList(payload.reference_images, 10);
  const refVideos = asUrlList(payload.reference_videos, 5);
  const refAudios = asUrlList(payload.reference_audios, 5);

  // Google Veo & Gemini Omni on UnoRouter/Google/Vertex plugins require inline data URLs
  if (imageUrl && (provider === 'google' || lowerModel.includes('veo') || lowerModel.includes('gemini-omni'))) {
    imageUrl = await maybeInlineImage(imageUrl);
  }

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...(provider === 'unorouter' ? { 'HTTP-Referer': 'https://blea-ai.blea-ai.workers.dev', 'X-Title': 'BLEA AI' } : {}),
  };

  if (provider === 'alibaba') {
    return buildAlibabaVideoRequest({ model, apiBase, headers, payload });
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
    data?.output?.task_id
    || data?.output?.taskId
    || data?.id
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
    || data?.output?.video_urls?.[0]
    || data?.output?.results?.[0]?.video_url
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
  if (data.output?.message) return String(data.output.message);
  if (data.code && data.message && !data.output?.task_status) return `${data.code}: ${data.message}`;
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

// Katalog model gambar Alibaba Model Studio (ap-southeast-1) yang sudah
// diverifikasi (async image-generation API, messages format). Lanjutkan hanya
// model dengan parameter terdokumentasi; region lain menyerupai.
// sizeMode:
//   'preset' → size harus dari daftar `sizes` (mode lama)
//   'wxh'    → '<lebar>*<tinggi>' bebas 512–2048 (famili qwen-image-2.0)
//             atau rentang `minSide`–`maxSide` (wan2.6-t2i)
const ALIBABA_IMAGE_MODELS = [
  { id: 'wan2.7-image', name: 'Alibaba: Wan 2.7 Image', vendor: 'Alibaba', sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1, promptExtend: false, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 4 },
  { id: 'wan2.7-image-pro', name: 'Alibaba: Wan 2.7 Image Pro', vendor: 'Alibaba', sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1, promptExtend: false, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 4 },
  { id: 'qwen-image-3.0', name: 'Alibaba: Qwen-Image 3.0', vendor: 'Alibaba', sizes: ['1664*928', '1472*1104', '1328*1328', '1104*1472', '928*1664'], defaultSize: '1664*928', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-3.0-pro', name: 'Alibaba: Qwen-Image 3.0 Pro', vendor: 'Alibaba', sizes: ['1664*928', '1472*1104', '1328*1328', '1104*1472', '928*1664'], defaultSize: '1664*928', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  // Famili Qwen-Image-2.0 / 2.1 (sinkron & async messages; n 1-6). Dated variants = snapshot model yang sama.
  { id: 'qwen-image-2.0', name: 'Alibaba: Qwen-Image 2.0', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-2026-03-03', name: 'Alibaba: Qwen-Image 2.0 (2026-03-03)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro', name: 'Alibaba: Qwen-Image 2.0 Pro', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro-2026-03-03', name: 'Alibaba: Qwen-Image 2.0 Pro (2026-03-03)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro-2026-04-22', name: 'Alibaba: Qwen-Image 2.0 Pro (2026-04-22)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro-2026-06-22', name: 'Alibaba: Qwen-Image 2.0 Pro (2026-06-22)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.1-pro', name: 'Alibaba: Qwen-Image 2.1 Pro', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.1-turbo', name: 'Alibaba: Qwen-Image 2.1 Turbo', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  // Wan2.6-T2I: messages async; n 1-4; 1280*1280 s/d 1440*1440.
  { id: 'wan2.6-t2i', name: 'Alibaba: Wan 2.6 T2I', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 1280, maxSide: 1440, defaultSize: '1280*1280', maxN: 4, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 0 },
  // Wan 2.5 & lebih lama (text-to-image V2): HTTP async LEGACY —
  // POST /api/v1/services/aigc/text2image/image-synthesis, input.prompt STRING,
  // hasil output.results[].url. Ukuran wan2.5: total piksel 1280^2–1440^2, rasio [1:4, 4:1].
  { id: 'wan2.5-t2i-preview', name: 'Alibaba: Wan 2.5 T2I Preview', vendor: 'Alibaba', sizeMode: 'wxh', minProduct: 1280 * 1280, maxProduct: 1440 * 1440, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 2000, sizeHint: 'total 1280*1280–1440*1440 piksel, rasio 1:4–4:1', maxInputImages: 0 },
  // Wan 2.2: total piksel maks 1440*1440, sisi 512–1440, prompt 500 karakter.
  { id: 'wan2.2-t2i-plus', name: 'Alibaba: Wan 2.2 T2I Plus', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  { id: 'wan2.2-t2i-flash', name: 'Alibaba: Wan 2.2 T2I Flash', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  // Wan 2.1: Singapore menggunakan wan2.1-t2i-*; Beijing menggunakan wanx2.1-t2i-*.
  { id: 'wan2.1-t2i-plus', cnId: 'wanx2.1-t2i-plus', name: 'Alibaba: Wan 2.1 T2I Plus', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  { id: 'wan2.1-t2i-turbo', cnId: 'wanx2.1-t2i-turbo', name: 'Alibaba: Wan 2.1 T2I Turbo', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  // Wan2.6-Image: async messages (image-generation).
  // Tanpa gambar input: interleaved mode (enable_interleave=true, n=1, max_images 1-5, total 768^2–1280^2).
  // Dengan 1-4 gambar input: edit mode (enable_interleave=false, n 1-4, prompt_extend=true, size 1K/2K atau 768^2–2048^2).
  { id: 'wan2.6-image', name: 'Alibaba: Wan 2.6 Image', vendor: 'Alibaba', sizeMode: 'wxh', minProduct: 768 * 768, maxProduct: 1280 * 1280, editMaxProduct: 2048 * 2048, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 5, promptExtend: false, payloadMode: 'interleave', maxPromptChars: 2000, maxInputImages: 4, sizeHint: 'total 768*768–1280*1280 piksel (edit s/d 2048*2048 atau 1K/2K), rasio 1:4–4:1' },
  // Wan2.5-I2I-Preview: editing only (1-4 gambar sumber wajib), async image2image/image-synthesis,
  // total piksel 768^2–1280^2, rasio [1:4, 4:1], n 1-4.
  { id: 'wan2.5-i2i-preview', name: 'Alibaba: Wan 2.5 I2I Preview (Edit Gambar)', vendor: 'Alibaba', sizeMode: 'wxh', minProduct: 768 * 768, maxProduct: 1280 * 1280, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 4, promptExtend: true, payloadMode: 'legacy-i2i', maxPromptChars: 2000, maxInputImages: 4, requiresImageInput: true, sizeHint: 'wajib 1–4 gambar sumber · total 768*768–1280*1280 piksel, rasio 1:4–4:1' },
  // Z-Image-Turbo: SYNC (multimodal-generation), messages, prompt_extend default false,
  // prompt maks 800 karakter, n tetap 1; ukuran sisi 512–2048; hasil di output.choices[0].message.content[0].image.
  { id: 'z-image-turbo', name: 'Alibaba: Z-Image Turbo', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '1024*1024', maxN: 1, promptExtend: false, payloadMode: 'zimage', maxPromptChars: 800, sizeHint: 'sisi 512–2048 piksel', maxInputImages: 0 },
];

function validateAlibabaWxh(size, spec, override = {}) {
  const match = /^(\d{3,4})\*(\d{3,4})$/.exec(String(size || ''));
  if (!match) return false;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (w < 3 || h < 3) return false;
  const minSide = override.minSide ?? spec.minSide;
  const maxSide = override.maxSide ?? spec.maxSide;
  const minProduct = override.minProduct ?? spec.minProduct;
  const maxProduct = override.maxProduct ?? spec.maxProduct;
  const minRatio = override.minRatio ?? spec.minRatio;
  const maxRatio = override.maxRatio ?? spec.maxRatio;
  if (minSide && (w < minSide || h < minSide)) return false;
  if (maxSide && (w > maxSide || h > maxSide)) return false;
  const product = w * h;
  if (minProduct && product < minProduct) return false;
  if (maxProduct && product > maxProduct) return false;
  if (minRatio && w / h < minRatio) return false;
  if (maxRatio && w / h > maxRatio) return false;
  return true;
}

function alibabaWxhHint(spec) {
  if (spec.sizeHint) return spec.sizeHint;
  const bits = [];
  if (spec.minSide && spec.maxSide) bits.push(`sisi ${spec.minSide}–${spec.maxSide} piksel`);
  if (spec.minProduct && spec.maxProduct) {
    bits.push(`total ${spec.minProduct}–${spec.maxProduct} piksel`);
  } else if (spec.maxProduct) {
    bits.push(`total maks ${spec.maxProduct} piksel`);
  }
  if (spec.minRatio || spec.maxRatio) bits.push('rasio antara 1:4 dan 4:1');
  return bits.join(', ') || 'LEBAR*TINGGI';
}

function resolveAlibabaCnModelId(spec, baseUrl) {
  if (!spec?.cnId) return spec?.id || '';
  const lowerBase = String(baseUrl || '').toLowerCase();
  if (lowerBase.includes('cn-beijing') || /dashscope\.aliyuncs\.com/.test(lowerBase)) {
    return spec.cnId;
  }
  return spec.id;
}

// Upstream Alibaba bisa menyelipkan URL bertanda tangan / secret di teks error.
// Jangan pernah meneruskan mentah; buang semua URL dan potong panjangnya.
function redactUpstreamDetail(value, max = 200) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[tautan disembunyikan]')
    .replace(/[A-Za-z0-9_\-]{20,}/g, (token) => (token.length >= 32 ? '[token disembunyikan]' : token))
    .slice(0, max)
    .trim();
}

const ALIBABA_IMAGE_ERROR = (message, status = 400) => {
  const err = new Error(message);
  err.status = status;
  return err;
};

async function creditRpc(env, fn, body) {
  try {
    const res = await servicePostgrest(env, `/rpc/${fn}`, { method: 'POST', body });
    if (!res.ok) return false;
    const parsed = await res.json().catch(() => null);
    return parsed === true;
  } catch {
    return false;
  }
}

async function refundImageCredits(env, userId, amount, rowId, description) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return false;
  return creditRpc(env, 'refund_credits', { p_user_id: userId, p_amount: amount, p_description: description, p_generation_id: rowId });
}

async function refundVideoCredits(env, userId, amount, rowId, description) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return false;
  return creditRpc(env, 'refund_credits', { p_user_id: userId, p_amount: amount, p_description: description, p_generation_id: rowId });
}

// Model gambar Alibaba yang bisa dipilih pengguna: harus aktif di Katalog
// Model (provider alibaba, active) DAN punya harga kredit BLEA (modality
// image). Yang belum lengkap disembunyikan supaya tidak menampilkan tombol
// yang pasti gagal. Untuk admin, kembalikan juga daftar model aktif tanpa
// harga agar admin tahu kenapa belum muncul di Generate Gambar.
async function loadAlibabaImageCatalogState(env) {
  const [modelsRes, pricesRes] = await Promise.all([
    servicePostgrest(env, '/provider_models?select=model&provider=eq.alibaba&active=eq.true&limit=500'),
    servicePostgrest(env, '/credit_model_prices?provider=eq.alibaba&modality=eq.image&active=eq.true&select=model,credits&limit=500'),
  ]);
  const activeRows = modelsRes?.ok ? await modelsRes.json().catch(() => []) : [];
  const priceRows = pricesRes?.ok ? await pricesRes.json().catch(() => []) : [];
  const active = new Set((activeRows || []).map((row) => String(row?.model || '')));
  const prices = new Map((priceRows || []).map((row) => [String(row?.model || ''), Number(row?.credits)]));
  const candidates = await alibabaKeyCandidates(env).catch(() => []);
  const ready = candidates.length > 0;
  const models = ALIBABA_IMAGE_MODELS
    .filter((spec) => active.has(spec.id) && Number.isSafeInteger(prices.get(spec.id)) && prices.get(spec.id) > 0)
    .map((spec) => ({
      provider: 'alibaba',
      model: spec.id,
      name: spec.name,
      credits: prices.get(spec.id),
      ready,
      params: spec.sizeMode === 'wxh'
        ? {
            sizeMode: 'wxh',
            minSide: spec.minSide,
            maxSide: spec.maxSide,
            minProduct: spec.minProduct,
            maxProduct: spec.maxProduct,
            minRatio: spec.minRatio,
            maxRatio: spec.maxRatio,
            sizeHint: spec.sizeHint || null,
            defaultSize: spec.defaultSize,
            maxN: spec.maxN,
            maxPromptChars: spec.maxPromptChars || 2000,
            maxInputImages: spec.maxInputImages || 0,
            requiresImageInput: Boolean(spec.requiresImageInput),
            sizes: null,
          }
        : {
            sizeMode: 'preset',
            sizes: spec.sizes,
            defaultSize: spec.defaultSize,
            maxN: spec.maxN,
            maxPromptChars: spec.maxPromptChars || 2000,
            maxInputImages: spec.maxInputImages || 0,
            requiresImageInput: Boolean(spec.requiresImageInput),
          },
    }));
  const unpriced = ALIBABA_IMAGE_MODELS
    .filter((spec) => active.has(spec.id) && !(Number.isSafeInteger(prices.get(spec.id)) && prices.get(spec.id) > 0))
    .map((spec) => ({ model: spec.id, name: spec.name }));
  return { models, unpriced };
}

async function alibabaImageCatalog(env) {
  const { models } = await loadAlibabaImageCatalogState(env);
  return models;
}

function buildAlibabaImageUpstreamRequest(spec, { prompt, size, n, images, base }) {
  const upstreamModel = resolveAlibabaCnModelId(spec, base);
  if (spec.payloadMode === 'legacy') {
    return {
      url: `${base}/api/v1/services/aigc/text2image/image-synthesis`,
      headers: { 'X-DashScope-Async': 'enable' },
      isSync: false,
      body: {
        model: upstreamModel,
        input: { prompt },
        parameters: { size, n, prompt_extend: true, watermark: false },
      },
    };
  }
  if (spec.payloadMode === 'legacy-i2i') {
    return {
      url: `${base}/api/v1/services/aigc/image2image/image-synthesis`,
      headers: { 'X-DashScope-Async': 'enable' },
      isSync: false,
      body: {
        model: upstreamModel,
        input: { prompt, images },
        parameters: { size, n, prompt_extend: true, watermark: false },
      },
    };
  }
  if (spec.payloadMode === 'zimage') {
    return {
      url: `${base}/api/v1/services/aigc/multimodal-generation/generation`,
      headers: {},
      isSync: true,
      body: {
        model: upstreamModel,
        input: { messages: [{ role: 'user', content: [{ text: prompt }] }] },
        parameters: { prompt_extend: false, size },
      },
    };
  }
  const content = [...images.map((url) => ({ image: url })), { text: prompt }];
  if (spec.payloadMode === 'interleave') {
    if (images.length > 0) {
      return {
        url: `${base}/api/v1/services/aigc/image-generation/generation`,
        headers: { 'X-DashScope-Async': 'enable' },
        isSync: false,
        body: {
          model: upstreamModel,
          input: { messages: [{ role: 'user', content }] },
          parameters: { size, n, enable_interleave: false, prompt_extend: true, watermark: false },
        },
      };
    }
    return {
      url: `${base}/api/v1/services/aigc/image-generation/generation`,
      headers: { 'X-DashScope-Async': 'enable' },
      isSync: false,
      body: {
        model: upstreamModel,
        input: { messages: [{ role: 'user', content }] },
        parameters: { size, n: 1, max_images: n, enable_interleave: true, watermark: false },
      },
    };
  }
  return {
    url: `${base}/api/v1/services/aigc/image-generation/generation`,
    headers: { 'X-DashScope-Async': 'enable' },
    isSync: false,
    body: {
      model: upstreamModel,
      input: { messages: [{ role: 'user', content }] },
      parameters: { size, n, watermark: false, ...(spec.promptExtend ? { prompt_extend: true } : {}) },
    },
  };
}

async function alibabaImageGenerate(env, user, rawInput) {
  const fail = ALIBABA_IMAGE_ERROR;
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
  const allowed = new Set(['prompt', 'provider', 'model', 'size', 'n', 'images']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw fail('Permintaan tidak valid.', 400);
  }
  const modelId = String(input.model || '').trim();
  const spec = ALIBABA_IMAGE_MODELS.find((item) => item.id === modelId);
  if (!spec) throw fail('Model gambar Alibaba tidak dikenal.', 400);
  const maxPrompt = spec.maxPromptChars || 2000;
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > maxPrompt) throw fail(`Masukkan prompt sepanjang 1-${maxPrompt} karakter.`, 400);

  // Validasi input gambar referensi bila model mendukung / mewajibkannya.
  let images = [];
  if (input.images != null) {
    if (!Array.isArray(input.images)) throw fail('Format daftar gambar tidak valid.', 400);
    if (!spec.maxInputImages && input.images.length > 0) {
      throw fail(`Model ${spec.name} hanya mendukung teks ke gambar (tidak menerima gambar input).`, 400);
    }
    if (input.images.length > (spec.maxInputImages || 0)) {
      throw fail(`Maksimal ${spec.maxInputImages} gambar referensi untuk ${spec.name}.`, 400);
    }
    images = input.images.map((item) => {
      const value = typeof item === 'string' ? item.trim() : '';
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || value.length > 2048) {
          throw new Error('invalid');
        }
        return parsed.toString();
      } catch {
        throw fail('URL gambar referensi tidak valid (wajib HTTPS).', 400);
      }
    });
  }
  if (spec.requiresImageInput && images.length === 0) {
    throw fail(`Model ${spec.name} wajib menyertakan 1–${spec.maxInputImages} gambar sumber.`, 400);
  }

  // Akun ditangguhkan/diblokir ditolak sebelum kredit disentuh (konsisten dgn Freebeat).
  const profileRes = await servicePostgrest(env, `/profiles?id=eq.${encodeURIComponent(user.id)}&select=status&limit=1`).catch(() => null);
  const profileRows = profileRes?.ok ? await profileRes.json().catch(() => []) : [];
  const accountStatus = Array.isArray(profileRows) ? profileRows[0]?.status : null;
  if (accountStatus === 'banned') throw fail('Akun Anda diblokir. Hubungi admin BLEA.', 403);
  if (accountStatus === 'suspended') throw fail('Akun Anda sedang ditangguhkan sementara. Hubungi admin BLEA.', 403);

  // Model harus diaktifkan admin di Katalog Model (provider alibaba, active).
  const activeRes = await servicePostgrest(env, `/provider_models?select=model&provider=eq.alibaba&active=eq.true&model=eq.${encodeURIComponent(modelId)}&limit=1`).catch(() => null);
  const activeRows = activeRes?.ok ? await activeRes.json().catch(() => []) : [];
  if (!Array.isArray(activeRows) || activeRows.length === 0) {
    throw fail('Model ini belum diaktifkan admin di Katalog Model.', 409);
  }

  // Parameter resmi: size & n per model (wan2.6-image edit mode juga menerima 1K/2K dan maks n=4).
  const isInterleaveEdit = spec.payloadMode === 'interleave' && images.length > 0;
  const maxN = isInterleaveEdit ? 4 : spec.maxN;
  const size = input.size == null ? spec.defaultSize : String(input.size);
  if (isInterleaveEdit) {
    const validPreset = size === '1K' || size === '2K';
    const validWxh = validateAlibabaWxh(size, spec, { maxProduct: spec.editMaxProduct });
    if (!validPreset && !validWxh) {
      throw fail(`Ukuran tidak valid untuk ${spec.name} mode edit. Gunakan 1K, 2K, atau LEBAR*TINGGI (${alibabaWxhHint(spec)}).`, 400);
    }
  } else if (spec.sizeMode === 'wxh') {
    if (!validateAlibabaWxh(size, spec)) throw fail(`Ukuran tidak valid untuk ${spec.name}. Gunakan format LEBAR*TINGGI (${alibabaWxhHint(spec)}), mis. ${spec.defaultSize}.`, 400);
  } else if (!spec.sizes.includes(size)) {
    throw fail(`Ukuran tidak valid untuk ${spec.name}. Pilih: ${spec.sizes.join(', ')}.`, 400);
  }
  let n = 1;
  if (input.n != null) {
    n = Number(input.n);
    if (!Number.isSafeInteger(n) || n < 1 || n > maxN) throw fail(`Jumlah gambar harus 1-${maxN}.`, 400);
  }

  // Harga kredit BLEA wajib diatur admin (credit_model_prices, modality image).
  const priceRes = await servicePostgrest(env, `/credit_model_prices?provider=eq.alibaba&model=eq.${encodeURIComponent(modelId)}&modality=eq.image&active=eq.true&select=credits&limit=1`).catch(() => null);
  const priceRows = priceRes?.ok ? await priceRes.json().catch(() => []) : [];
  const price = Number(Array.isArray(priceRows) ? priceRows[0]?.credits : null);
  if (!Number.isSafeInteger(price) || price <= 0) throw fail('Harga kredit untuk model ini belum diatur admin; generasi tidak dikirim.', 409);

  const candidates = await alibabaKeyCandidates(env);
  if (!candidates.length) throw fail('Belum ada akun Alibaba Cloud yang dikonfigurasi admin.', 503);

  const rowId = crypto.randomUUID();
  const spent = await creditRpc(env, 'spend_credits', { p_user_id: user.id, p_amount: price, p_description: `Generasi gambar Alibaba model ${modelId}`, p_generation_id: rowId });
  if (!spent) throw fail('Kredit BLEA tidak cukup untuk generasi ini.', 402);

  const genMode = images.length > 0 ? 'edit' : 'text';
  const baseMetadata = {
    mode: genMode,
    provider: 'alibaba',
    size,
    n,
    ...(images.length ? { source_image_url: images[0], source_images: images } : {}),
  };

  const insertedRes = await servicePostgrest(env, '/image_generations', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: { id: rowId, user_id: user.id, provider: 'alibaba', model: modelId, prompt, credits_charged: price, status: 'processing', metadata: baseMetadata },
  }).catch(() => null);
  const inserted = insertedRes?.ok ? await insertedRes.json().catch(() => null) : null;
  if (!Array.isArray(inserted) || inserted.length !== 1) {
    await refundImageCredits(env, user.id, price, rowId, 'Refund: riwayat generasi gambar tidak tersimpan');
    throw fail('Riwayat generasi tidak dapat disimpan; kredit BLEA dikembalikan. Silakan coba lagi.', 503);
  }

  let uncertain = 0;
  let sawDefiniteFailure = false;
  let lastError = '';
  for (const cand of candidates) {
    const base = resolveProviderApiBase('alibaba', cand.base_url);
    if (!base) { sawDefiniteFailure = true; continue; }
    const req = buildAlibabaImageUpstreamRequest(spec, { prompt, size, n, images, base });
    let res = null;
    try {
      res = await fetch(req.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cand.api_key}`, ...req.headers },
        body: JSON.stringify(req.body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      uncertain += 1;
      await markPoolKeyResult(env, cand, { success: false, error: `jaringan: ${String(e).slice(0, 200)}` });
      continue;
    }
    const text = await res.text().catch(() => '');
    if (res.ok) {
      const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
      const taskId = String(data?.output?.task_id || data?.task_id || '').trim();
      const syncUrls = extractImageResultUrls(data);
      if (req.isSync && syncUrls.length > 0) {
        await markPoolKeyResult(env, cand, { success: true });
        const patch = {
          status: 'completed',
          image_url: syncUrls[0],
          provider_key_id: cand.id || null,
          error_message: null,
          metadata: { ...baseMetadata, base_url: base, ...(syncUrls.length > 1 ? { image_urls: syncUrls } : {}) },
          updated_at: new Date().toISOString(),
        };
        await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(rowId)}`, { method: 'PATCH', body: patch }).catch(() => {});
        return { status: 'completed', credits: price, mode: genMode, generation: sanitizeImageRow({ ...inserted[0], ...patch }) };
      }
      if (!taskId) {
        uncertain += 1;
        await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(rowId)}`, {
          method: 'PATCH',
          body: { status: 'unknown', error_message: req.isSync ? 'Respons provider tidak berisi URL gambar maupun task_id; kredit mungkin terpakai. Jangan ulangi.' : 'Respons provider tidak berisi task_id; kredit mungkin terpakai. Jangan ulangi.', updated_at: new Date().toISOString() },
        }).catch(() => {});
        return { status: 'unknown', credits: price, mode: genMode, generation: sanitizeImageRow({ ...inserted[0], status: 'unknown' }) };
      }
      await markPoolKeyResult(env, cand, { success: true });
      const patch = { external_job_id: taskId, status: 'processing', provider_key_id: cand.id || null, metadata: { ...baseMetadata, base_url: base }, updated_at: new Date().toISOString() };
      await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(rowId)}`, { method: 'PATCH', body: patch }).catch(() => {});
      return { status: 'submitted', credits: price, mode: genMode, generation: sanitizeImageRow({ ...inserted[0], ...patch }) };
    }
    if (isAlibabaQuotaError(res.status, text)) {
      await markPoolKeyResult(env, cand, { success: false, error: text.slice(0, 280) });
      sawDefiniteFailure = true;
      lastError = `HTTP ${res.status}`;
      continue;
    }
    // Tolakan definitif non-kuota (payload/model ditolak): mengulang ke akun lain percuma.
    const parsed = (() => { try { return JSON.parse(text); } catch { return {}; } })();
    lastError = redactUpstreamDetail(extractUpstreamError(parsed) || text.slice(0, 300));
    sawDefiniteFailure = true;
    break;
  }
  if (uncertain > 0) {
    // Sebuah percobaan gagal di jaringan/timeout — tidak bisa dipastikan apakah
    // tugas terdaftar di provider; jangan refund otomatis.
    await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(rowId)}`, {
      method: 'PATCH',
      body: { status: 'unknown', error_message: 'Hasil pengiriman tidak pasti; periksa status sebelum mengulang.', updated_at: new Date().toISOString() },
    }).catch(() => {});
    return { status: 'unknown', credits: price, mode: genMode, generation: sanitizeImageRow({ ...inserted[0], status: 'unknown' }) };
  }
  // Kegagalan definitif sebelum tugas terdaftar → refund kredit.
  const refunded = sawDefiniteFailure
    ? await refundImageCredits(env, user.id, price, rowId, 'Refund: generasi gambar Alibaba ditolak sebelum dikirim')
    : false;
  const message = `${lastError ? `Provider menolak permintaan: ${redactUpstreamDetail(lastError)}.` : 'Semua akun Alibaba gagal atau terkena kuota.'}${refunded ? ' Kredit BLEA dikembalikan.' : ''}`;
  await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    body: { status: 'failed', error_message: message.slice(0, 300), ...(refunded ? { credits_refunded: price } : {}), updated_at: new Date().toISOString() },
  }).catch(() => {});
  throw fail(message, 502);
}

function extractImageResultUrls(data) {
  const output = data?.output && typeof data.output === 'object' ? data.output : data || {};
  const found = [];
  const push = (val) => {
    const s = String(val || '').trim();
    if (/^https?:\/\//i.test(s) && !found.includes(s)) found.push(s);
  };
  if (Array.isArray(output?.choices)) {
    for (const choice of output.choices) {
      const content = choice?.message?.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          push(item?.image);
          push(item?.url);
        }
      }
    }
  }
  if (Array.isArray(output?.results)) {
    for (const item of output.results) {
      push(item?.url);
      push(item?.image_url);
      push(item?.image);
    }
  }
  push(output?.image_url);
  push(output?.url);
  push(data?.data?.url);
  return found;
}

function extractImageResultUrl(data) {
  return extractImageResultUrls(data)[0] || '';
}

async function alibabaImageStatus(env, user, row) {
  if (!['queued', 'processing'].includes(row.status) || !row.external_job_id) {
    return { generation: sanitizeImageRow(row), task: null };
  }
  // Akun yang submit dulu (provider_key_id), lalu kandidat pool lain sebagai cadangan.
  const seeded = [];
  if (row.provider_key_id) {
    const res = await servicePostgrest(env, `/provider_key_pool?select=id,provider,label,api_key,base_url,priority,consecutive_failures,cooldown_until&id=eq.${encodeURIComponent(row.provider_key_id)}&limit=1`).catch(() => null);
    const rows = res?.ok ? await res.json().catch(() => []) : [];
    if (rows?.[0]?.api_key) seeded.push(rows[0]);
  }
  for (const cand of await alibabaKeyCandidates(env).catch(() => [])) {
    if (!seeded.some((seed) => seed.id === cand.id)) seeded.push(cand);
  }
  let pollData = null;
  for (const cand of seeded) {
    const base = resolveProviderApiBase('alibaba', cand.base_url);
    if (!base) continue;
    let res = null;
    try {
      res = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(row.external_job_id)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${cand.api_key}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await markPoolKeyResult(env, cand, { success: false, error: 'poll jaringan gagal' });
      continue;
    }
    if (isAlibabaQuotaError(res.status, '')) {
      await markPoolKeyResult(env, cand, { success: false, error: `poll HTTP ${res.status}` });
      continue;
    }
    if (!res.ok) continue;
    pollData = await res.json().catch(() => ({}));
    await markPoolKeyResult(env, cand, { success: true });
    break;
  }
  if (!pollData) {
    return { generation: sanitizeImageRow(row), task: null, pollWarning: 'Semua akun Alibaba gagal polling.' };
  }
  const raw = String(pollData?.output?.task_status || pollData?.task_status || '').toUpperCase();
  let patch = null;
  if (raw === 'SUCCEEDED') {
    const urls = extractImageResultUrls(pollData);
    const url = urls[0] || '';
    const nextMeta = urls.length > 1
      ? { ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}), image_urls: urls }
      : undefined;
    patch = url
      ? { status: 'completed', image_url: url, ...(nextMeta ? { metadata: nextMeta } : {}), error_message: null, updated_at: new Date().toISOString() }
      : { status: 'failed', error_message: 'Tugas selesai tetapi URL gambar tidak ditemukan di respons provider.', updated_at: new Date().toISOString() };
  } else if (raw === 'FAILED' || raw === 'CANCELED' || raw === 'UNKNOWN') {
    const detail = redactUpstreamDetail(extractUpstreamError(pollData));
    patch = { status: 'failed', error_message: detail ? `Provider melaporkan generasi gagal: ${detail}` : 'Provider melaporkan generasi gagal.', updated_at: new Date().toISOString() };
  } else {
    patch = { status: 'processing', updated_at: new Date().toISOString() };
  }
  try {
    await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: patch });
  } catch { /* biarkan status lama; percobaan berikutnya memperbarui */ }
  if (patch.status === 'failed' && Number(row.credits_charged) > 0 && Number(row.credits_refunded || 0) === 0) {
    const refunded = await refundImageCredits(env, user.id, Number(row.credits_charged), row.id, 'Refund: generasi gambar gagal');
    if (refunded) {
      row.credits_refunded = Number(row.credits_charged);
      try {
        await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { credits_refunded: Number(row.credits_charged), updated_at: new Date().toISOString() } });
      } catch { /* ledger sudah benar */ }
    }
  }
  return { generation: sanitizeImageRow({ ...row, ...patch }), task: { status: raw.toLowerCase() || 'processing' } };
}

// ---- provider_key_pool: multi-akun Alibaba Cloud dengan failover ----
// Urutan: prioritas naik, lalu yang paling dulu dibuat. Akun yang sedang
// cooldown (kuota/rate limit/auth) dilewati sampai cooldown_until lewat.
async function loadProviderKeyPool(env, provider = 'alibaba') {
  try {
    const res = await servicePostgrest(
      env,
      `/provider_key_pool?select=id,provider,label,api_key,base_url,priority,consecutive_failures,cooldown_until&provider=eq.${encodeURIComponent(provider)}&enabled=eq.true&order=priority.asc,created_at.asc`,
    );
    if (!res.ok) return [];
    const rows = await res.json().catch(() => []);
    const now = Date.now();
    return (Array.isArray(rows) ? rows : []).filter(
      (row) => !row.cooldown_until || new Date(row.cooldown_until).getTime() <= now,
    );
  } catch {
    return [];
  }
}

// Kandidat = akun pool aktif; jika pool kosong, fallback ke baris tunggal
// provider_api_keys (perilaku lama) sebagai baris semu tanpa id (tidak pernah
// ditandai cooldown).
async function alibabaKeyCandidates(env) {
  const pool = await loadProviderKeyPool(env, 'alibaba');
  if (pool.length) return pool;
  const single = await fetchProviderKeyRecord(env, 'alibaba').catch(() => null);
  return single?.api_key
    ? [{ id: null, provider: 'alibaba', label: single.label || 'Provider key (tunggal)', api_key: single.api_key, base_url: single.base_url || '', priority: 100, consecutive_failures: 0 }]
    : [];
}

async function markPoolKeyResult(env, keyRow, result) {
  if (!keyRow?.id) return;
  const now = new Date();
  let patch;
  if (result?.success) {
    patch = { consecutive_failures: 0, cooldown_until: null, last_error: null, last_used_at: now.toISOString(), last_success_at: now.toISOString() };
  } else {
    const failures = (Number(keyRow.consecutive_failures) || 0) + 1;
    const cooldownMinutes = Math.min(60, 10 * (2 ** Math.min(failures - 1, 2)));
    patch = {
      consecutive_failures: failures,
      cooldown_until: new Date(now.getTime() + cooldownMinutes * 60_000).toISOString(),
      last_error: String(result?.error || '').slice(0, 300),
      last_used_at: now.toISOString(),
    };
  }
  try {
    await servicePostgrest(env, `/provider_key_pool?id=eq.${encodeURIComponent(keyRow.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: patch,
    });
  } catch { /* penandaan cooldown bersifat best-effort */ }
}

// Alibaba membalas kuota habis / rate limit / key ditolak dengan beragam kode;
// kelimpahan body diperiksa agar kuota terdeteksi meski statusnya 400.
function isAlibabaQuotaError(status, text) {
  if ([401, 402, 403, 429].includes(Number(status))) return true;
  return /quota|exhaust|throttl|rate.?limit|insufficient/i.test(String(text || ''));
}

async function handleApi(request, url, env) {
  const path = url.pathname.replace(/^\/api\/?/, '');
  const method = request.method;

  try {
    if (method === 'OPTIONS') {
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    const blockedAccount = await accountGate(request, env, path);
    if (blockedAccount) return blockedAccount;

    // ---- /account: status akun untuk UI. Satu-satunya jalur yang tetap bisa
    // dibaca akun yang ditangguhkan, supaya alasannya bisa ditampilkan. ----
    if (path === 'account' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      let user = null;
      try { user = token ? await getUser(env, token) : null; } catch { user = null; }
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      const status = await readAccountStatus(env, user.id);
      const blocked = isBlockedAccountStatus(status);
      return jsonResponse({
        ok: true,
        status: status || 'active',
        blocked,
        message: blocked ? ACCOUNT_BLOCK_MESSAGE[status] : null,
        code: blocked ? `account_${status}` : null,
        role: user.app_metadata?.role === 'admin' ? 'admin' : 'user',
      });
    }

    if (path === 'freebeat/callback' && method === 'GET') return freebeatCallback(request, env);
    if (path.startsWith('freebeat/')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';
      const user = token ? await getUser(env, token) : null;
      return handleFreebeat(request, url, env, user);
    }

    if (path === 'tempmail-gmail-callback' && method === 'GET') {
      return handleGmailOAuthCallback(request, env);
    }

    if (path === 'tempmail' && ['GET', 'POST'].includes(method)) {
      return handleTempmail(request, url, env);
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

      const wantDownload = url.searchParams.get('download') === '1';

      if (targetUrl.startsWith('data:')) {
        const comma = targetUrl.indexOf(',');
        const header = targetUrl.slice(5, comma);
        const mime = header.split(';')[0] || 'video/mp4';
        const raw = Uint8Array.from(atob(targetUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
        const headers = {
          'content-type': mime,
          'content-length': String(raw.byteLength),
          'cache-control': 'private, no-store',
          'x-content-type-options': 'nosniff',
        };
        if (wantDownload) {
          headers['content-disposition'] = `attachment; filename="${contentAttachmentFilename('blea-video', id, mime, 'mp4')}"`;
        }
        return new Response(method === 'HEAD' ? null : raw, {
          status: 200,
          headers,
        });
      }

      const upstreamHeaders = {};
      const range = request.headers.get('range');
      if (range && !wantDownload) upstreamHeaders.range = range;
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
      respHeaders.set('x-content-type-options', 'nosniff');
      if (wantDownload) {
        respHeaders.set('content-disposition', `attachment; filename="${contentAttachmentFilename('blea-video', id, respHeaders.get('content-type'), 'mp4')}"`);
      }
      return new Response(method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
        headers: respHeaders,
      });
    }

    // ---- GET/HEAD /api/image/content/:id: signed or authorized image download proxy ----
    if (path.startsWith('image/content/') && (method === 'GET' || method === 'HEAD')) {
      const id = decodeURIComponent(path.slice('image/content/'.length));
      if (!id) return jsonResponse({ error: 'Missing generation id' }, 400);

      const rawIndex = url.searchParams.get('index');
      const index = rawIndex === null || rawIndex === '' ? 0 : Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= 20) {
        return jsonResponse({ error: 'Invalid image index' }, 400);
      }

      const exp = url.searchParams.get('exp');
      const sig = url.searchParams.get('sig');
      const sigOk = await verifyImageContentSig(id, index, exp, sig, env);
      let user = null;
      if (!sigOk) {
        const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        user = bearer ? await getUser(env, bearer) : null;
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const rowRes = await servicePostgrest(
        env,
        `/image_generations?select=id,user_id,image_url,metadata,status&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      const rows = await rowRes.json().catch(() => []);
      const row = rows?.[0];
      if (!row) return jsonResponse({ error: 'Image not found' }, 404);
      if (!sigOk && row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }

      const candidateUrls = [];
      for (const candidate of [row.image_url, ...(Array.isArray(row.metadata?.image_urls) ? row.metadata.image_urls : [])]) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed && !candidateUrls.includes(trimmed)) candidateUrls.push(trimmed);
      }
      const targetUrl = candidateUrls[index];
      if (!targetUrl) return jsonResponse({ error: 'Image content URL unavailable' }, 404);

      const wantDownload = url.searchParams.get('download') !== '0';
      const suffix = candidateUrls.length > 1 ? `-${index + 1}` : '';

      if (targetUrl.startsWith('data:')) {
        const comma = targetUrl.indexOf(',');
        const header = targetUrl.slice(5, comma);
        const mime = (header.split(';')[0] || 'image/png').trim().toLowerCase();
        if (!mime.startsWith('image/') || mime === 'image/svg+xml') {
          return jsonResponse({ error: 'Unsupported image content type' }, 400);
        }
        const raw = Uint8Array.from(atob(targetUrl.slice(comma + 1)), (c) => c.charCodeAt(0));
        return new Response(method === 'HEAD' ? null : raw, {
          status: 200,
          headers: {
            'content-type': mime,
            'content-length': String(raw.byteLength),
            'content-disposition': `${wantDownload ? 'attachment' : 'inline'}; filename="${contentAttachmentFilename('blea-image', id, mime, 'png', suffix)}"`,
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      if (!isSafeRemoteMediaUrl(targetUrl)) {
        return jsonResponse({ error: 'Image content URL rejected' }, 400);
      }

      let currentUrl = targetUrl;
      let upstream = null;
      for (let hop = 0; hop <= 3; hop += 1) {
        upstream = await fetch(currentUrl, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        if (upstream.status >= 300 && upstream.status < 400) {
          const location = upstream.headers.get('location');
          if (!location || hop === 3) {
            return jsonResponse({ error: 'Failed to stream upstream image', status: upstream.status }, 502);
          }
          const resolved = new URL(location, currentUrl).toString();
          if (!isSafeRemoteMediaUrl(resolved)) {
            return jsonResponse({ error: 'Image redirect rejected' }, 400);
          }
          currentUrl = resolved;
          continue;
        }
        break;
      }

      if (!upstream || !upstream.ok) {
        const text = upstream ? await upstream.text().catch(() => '') : '';
        return jsonResponse({ error: 'Failed to stream upstream image', status: upstream?.status || 502, detail: text.slice(0, 300) }, 502);
      }

      const rawType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      let contentType = rawType;
      if (rawType === 'image/svg+xml') {
        return jsonResponse({ error: 'Unsupported image content type' }, 502);
      }
      if (!rawType.startsWith('image/')) {
        if (rawType && rawType !== 'application/octet-stream') {
          return jsonResponse({ error: 'Unexpected upstream content type' }, 502);
        }
        const pathLower = new URL(currentUrl).pathname.toLowerCase();
        contentType = pathLower.endsWith('.jpg') || pathLower.endsWith('.jpeg')
          ? 'image/jpeg'
          : pathLower.endsWith('.webp')
            ? 'image/webp'
            : pathLower.endsWith('.gif')
              ? 'image/gif'
              : 'image/png';
      }

      const respHeaders = new Headers();
      respHeaders.set('content-type', contentType);
      const len = upstream.headers.get('content-length');
      if (len) respHeaders.set('content-length', len);
      respHeaders.set(
        'content-disposition',
        `${wantDownload ? 'attachment' : 'inline'}; filename="${contentAttachmentFilename('blea-image', id, contentType, 'png', suffix)}"`,
      );
      respHeaders.set('cache-control', 'private, no-store');
      respHeaders.set('x-content-type-options', 'nosniff');
      return new Response(method === 'HEAD' ? null : upstream.body, {
        status: 200,
        headers: respHeaders,
      });
    }

    // ---- /status: configured providers & readiness ----
    if (path === 'status' && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url,label');
      const rows = await res.json().catch(() => []);
      const configuredSet = new Set();
      for (const r of rows || []) {
        if (!r?.api_key) continue;
        const prov = String(r.provider || '').toLowerCase();
        if (prov === 'cloudflare' && r.api_key === 'binding:AI' && !hasWorkersAiBinding(env) && !hasCloudflareRestConfig(r)) {
          continue;
        }
        configuredSet.add(r.provider);
      }
      if (hasWorkersAiBinding(env)) configuredSet.add('cloudflare');
      const configuredProviders = Array.from(configuredSet);
      const configured = configuredProviders.length > 0;
      return jsonResponse({ ok: true, configured, providers: configuredProviders, workersAiBound: hasWorkersAiBinding(env) });
    }

    // ---- /verify: validate API key for UnoRouter, Cloudflare Workers AI, or custom provider ----
    if (path === 'verify' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const provider = String(body.provider || 'unorouter').trim().toLowerCase();
      const keyRow = await fetchProviderKeyRecord(env, provider);

      if (provider === 'cloudflare') {
        const rawInputKey = String(body.apiKey ?? '').trim();
        const restKey = rawInputKey === 'binding:AI'
          ? ''
          : (rawInputKey || (keyRow?.api_key && keyRow.api_key !== 'binding:AI' ? keyRow.api_key : ''));
        const rawBase = body.baseUrl ?? keyRow?.base_url ?? '';
        const restBase = resolveProviderApiBase('cloudflare', rawBase);
        if (restKey) {
          if (!restBase || !hasValidCloudflareRestBase(rawBase)) {
            return jsonResponse({
              ok: false,
              valid: false,
              status: 400,
              error: 'Isi Base URL REST Cloudflare dengan Account ID Anda, misalnya https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1 (atau kosongkan API Key untuk memakai Workers AI Binding native env.AI).',
            });
          }
          try {
            const pingRes = await fetch(`${restBase}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${restKey}` },
              body: JSON.stringify({ model: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }),
              signal: AbortSignal.timeout(25_000),
            });
            if (pingRes.ok) {
              return jsonResponse({ ok: true, valid: true, verifiedVia: 'cloudflare_rest', modelsCount: CLOUDFLARE_FREE_LLM_MODELS.length });
            }
            const errText = await pingRes.text().catch(() => '');
            return jsonResponse({ ok: false, valid: false, status: pingRes.status, error: errText.slice(0, 200) });
          } catch (e) {
            return jsonResponse({ ok: false, valid: false, error: String(e) });
          }
        }
        if (hasWorkersAiBinding(env)) {
          try {
            await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fp8-fast', {
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 5,
            });
            return jsonResponse({ ok: true, valid: true, verifiedVia: 'binding', modelsCount: CLOUDFLARE_FREE_LLM_MODELS.length });
          } catch (e) {
            return jsonResponse({ ok: false, valid: false, error: `Workers AI binding error: ${String(e)}` });
          }
        }
        return jsonResponse({
          ok: false,
          valid: false,
          status: 400,
          error: 'Binding env.AI belum aktif di environment ini. Setelah deploy Worker terbaru dengan [ai] binding, tes otomatis berhasil — atau isi Base URL Account ID & Cloudflare API Token untuk jalur REST.',
        });
      }

      const apiBase = resolveProviderApiBase(provider, body.baseUrl || keyRow?.base_url);
      if (provider === 'alibaba') {
        if (!apiBase || !isValidHttpBaseUrl(apiBase)) {
          return jsonResponse({
            ok: false,
            valid: false,
            status: 400,
            error: 'Base URL Alibaba wajib diisi: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com',
          });
        }
        const alibabaKey = String(body.apiKey ?? keyRow?.api_key ?? '').trim();
        if (!alibabaKey) {
          return jsonResponse({ ok: false, valid: false, status: 400, error: 'Masukkan API key Alibaba terlebih dahulu.' });
        }
        try {
          // Sengaja mengirim body kosong: request akan gagal validasi SEBELUM ada
          // tugas/biaya, tapi autentikasi key tetap dievaluasi server Alibaba.
          const alibabaRes = await fetch(`${apiBase}/api/v1/services/aigc/video-generation/video-synthesis`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${alibabaKey}`, 'X-DashScope-Async': 'enable' },
            body: '{}',
            signal: AbortSignal.timeout(20_000),
          });
          const alibabaText = await alibabaRes.text().catch(() => '');
          if (alibabaRes.status === 401 || alibabaRes.status === 403) {
            return jsonResponse({ ok: false, valid: false, status: alibabaRes.status, error: alibabaText.slice(0, 200) });
          }
          return jsonResponse({ ok: true, valid: true, verifiedVia: 'alibaba_auth', modelsCount: 1 });
        } catch (e) {
          return jsonResponse({ ok: false, valid: false, error: String(e) });
        }
      }
      if (!apiBase || !isValidHttpBaseUrl(apiBase)) {
        return jsonResponse({
          ok: false,
          valid: false,
          status: 400,
          error: `Base URL untuk provider "${provider}" tidak valid. Gunakan URL lengkap dimulai dengan https://.`,
        });
      }
      const apiKey = body.apiKey ?? '';
      try {
        // Prefer standard GET /models (supported by OpenAI, xAI, UnoRouter, PEKPIK, etc.)
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
          body: JSON.stringify({ model: 'gpt-oss-120b:free', messages: [{ role: 'user', content: 'ping' }] }),
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

    // ---- /provider-quota: sisa kuota/saldo API key provider (khusus admin) ----
    if (path === 'provider-quota' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      if (user.app_metadata?.role !== 'admin') return jsonResponse({ error: 'Hanya admin yang dapat melihat kuota provider.' }, 403);
      const body = await request.json().catch(() => ({}));
      const provider = String(body.provider || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(provider)) return jsonResponse({ error: 'Provider tidak valid.' }, 400);

      const CONSOLE_URLS = {
        alibaba: 'https://modelstudio.console.alibabacloud.com/ap-southeast-1',
        openai: 'https://platform.openai.com/usage',
        google: 'https://aistudio.google.com',
        xai: 'https://console.x.ai',
        doubao: 'https://console.volcengine.com',
        kling: 'https://app.klingai.com',
        hailuo: 'https://platform.minimax.io',
        cloudflare: 'https://dash.cloudflare.com',
        unorouter: 'https://unorouter.com',
      };
      const keyRow = await fetchProviderKeyRecord(env, provider);
      const apiKey = String(keyRow?.api_key || '').trim();
      if (!apiKey) return jsonResponse({ ok: true, supported: true, available: false, error: 'Belum ada API key tersimpan untuk provider ini.' });
      if (provider === 'cloudflare') {
        return jsonResponse({ ok: true, supported: false, consoleUrl: CONSOLE_URLS.cloudflare, message: apiKey === 'binding:AI' ? 'Cloudflare Workers AI memakai Binding env.AI — kuota 10.000 Neurons/hari tidak bisa dicek via API; pantau di dashboard Cloudflare.' : 'Kuota Workers AI tidak bisa dicek lewat REST dengan API token biasa; pantau di dashboard Cloudflare.' });
      }

      const apiBase = resolveProviderApiBase(provider, keyRow?.base_url);

      // Gateway gaya one-api/new-api (UnoRouter, PEKPIK): GET {root}/api/usage/token/
      if (provider === 'unorouter' || provider === 'pekpik') {
        const root = (apiBase || PROVIDER_PRESETS[provider]?.defaultBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
        if (!root) return jsonResponse({ ok: true, supported: false, consoleUrl: CONSOLE_URLS[provider] || '', message: 'Base URL provider belum disetel.' });
        try {
          const res = await fetch(`${root}/api/usage/token/`, {
            headers: { authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(15_000),
          });
          const data = await res.json().catch(() => null);
          if (res.status === 401 || res.status === 403) return jsonResponse({ ok: false, status: res.status, error: `API key ${provider} ditolak.` });
          if (!res.ok || !data) return jsonResponse({ ok: true, supported: false, consoleUrl: CONSOLE_URLS[provider] || '', message: 'Provider ini tidak menyediakan kuota lewat API; pantau dari konsol provider.' });
          const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
          const granted = num(data.total_granted), used = num(data.total_used), available = num(data.total_available);
          const unlimited = data.unlimited_quota === true;
          return jsonResponse({
            ok: true, supported: true, provider,
            name: data.name || provider,
            granted, used, available,
            unlimitedQuota: unlimited,
            expiresAt: num(data.expires_at) || 0,
            quotaPerUnit: 500000,
          });
        } catch (e) { return jsonResponse({ ok: false, error: `Provider tidak dapat dihubungi (${String(e)}).` }); }
      }

      return jsonResponse({ ok: true, supported: false, consoleUrl: CONSOLE_URLS[provider] || '', message: 'Provider ini tidak mengekspos kuota lewat API key; pantau dari konsol provider.' });
    }

    // ---- /models & /enabled-models: active models for Chat AI ----
    if ((path === 'models' || path === 'enabled-models') && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      let chatRows = (rows ?? []).filter((m) => isChatCapableModelId(m.model));
      const workersAiBound = hasWorkersAiBinding(env);

      if (chatRows.some((m) => String(m.provider || '').toLowerCase() === 'cloudflare') && !workersAiBound) {
        const cfKeyRow = await fetchProviderKeyRecord(env, 'cloudflare').catch(() => null);
        if (!hasCloudflareRestConfig(cfKeyRow)) {
          chatRows = chatRows.filter((m) => String(m.provider || '').toLowerCase() !== 'cloudflare');
        }
      }

      if (workersAiBound && !chatRows.some((m) => String(m.provider || '').toLowerCase() === 'cloudflare')) {
        const anyCfRes = await servicePostgrest(env, '/provider_models?select=model&provider=eq.cloudflare&limit=1').catch(() => null);
        const anyCfRows = anyCfRes?.ok ? await anyCfRes.json().catch(() => []) : [];
        if (!anyCfRows?.length) {
          chatRows = [
            ...chatRows,
            ...CLOUDFLARE_FREE_LLM_MODELS.filter((m) => m.starter).map((m) => ({ provider: 'cloudflare', model: m.id })),
          ];
        }
      }

      const seen = new Set();
      const deduped = [];
      for (const m of chatRows) {
        const prov = m.provider || 'unorouter';
        const key = `${prov}:${m.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push({ id: m.model, provider: prov, score: scoreFallbackModel(m.model) + (prov !== 'unorouter' ? 5 : 0) });
      }
      deduped.sort((a, b) => b.score - a.score);
      const models = [];
      const modelItems = [];
      for (const item of deduped) {
        if (!models.includes(item.id)) models.push(item.id);
        modelItems.push({ id: item.id, provider: item.provider });
      }
      return jsonResponse({ models, modelItems });
    }

    // ---- /catalog: full catalog from UnoRouter (plus Video models free & paid), Cloudflare Workers AI, or generic provider /v1/models ----
    if (path === 'catalog' && (method === 'GET' || method === 'POST')) {
      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const provider = String(body.provider || url.searchParams.get('provider') || 'unorouter').toLowerCase();

      if (provider === 'cloudflare') {
        return jsonResponse({
          models: CLOUDFLARE_FREE_LLM_MODELS.map((m) => ({
            id: m.id,
            provider: 'cloudflare',
            category: 'Text',
            tags: m.tags,
            description: m.description,
            isFree: true,
            online: true,
            priceLabel: 'Gratis 10K Neurons/hr',
          })),
        });
      }

      if (provider === 'alibaba') {
        // Model Studio tidak menyediakan GET /models. Sajikan katalog bawaan:
        // Wan (video) + daftar free quota resmi (teks/gambar/video/speech).
        const builtin = BUILTIN_VIDEO_MODELS.filter((m) => m.provider === 'alibaba').map((m) => ({
          id: m.id,
          provider: 'alibaba',
          category: 'Video',
          blea: 'video',
          tags: ['Video', 'Alibaba'],
          description: m.description,
          isFree: m.isFree,
          online: true,
          priceLabel: m.priceLabel,
        }));
        const freeQuota = ALIBABA_FREE_QUOTA_MODELS
          .filter((m) => !builtin.some((row) => row.id === m.id))
          .map((m) => ({
            id: m.id,
            provider: 'alibaba',
            category: m.category,
            blea: m.blea || null,
            tags: [m.category, 'Alibaba', 'Free Quota'],
            description: `${m.name} — free quota: ${m.freeQuota}. ${m.note || ''}`.trim(),
            isFree: true,
            online: true,
            priceLabel: 'Free Quota',
          }));
        return jsonResponse({ models: [...builtin, ...freeQuota] });
      }

      if (provider !== 'unorouter') {
        try {
          const keyRow = await fetchProviderKeyRecord(env, provider);
          const apiBase = resolveProviderApiBase(provider, body.baseUrl || keyRow?.base_url);
          const headers = keyRow?.api_key ? { authorization: `Bearer ${keyRow.api_key}` } : {};
          const upstream = await fetch(`${apiBase}/models`, {
            headers,
            signal: AbortSignal.timeout(20_000),
          });
          if (!upstream.ok) return jsonResponse({ error: `Catalog ${provider} gagal dimuat (HTTP ${upstream.status}).`, status: upstream.status }, 502);
          const payload = await upstream.json().catch(() => ({}));
          const rawList = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []);
          const models = rawList
            .map((item) => {
              const id = typeof item === 'string' ? item : (item?.id || item?.model || '');
              if (!id) return null;
              const isVid = isVideoModelId(id);
              const isEmb = /embedding|embed/i.test(id);
              const isImg = /dall-e|imagen|flux|image/i.test(id);
              const category = isVid ? 'Video' : (isEmb ? 'Embedding' : (isImg ? 'Image' : 'Text'));
              return {
                id,
                provider,
                category,
                tags: [category, provider.toUpperCase()],
                description: item?.description || item?.owned_by || '',
                isFree: id.endsWith(':free') || provider === 'pekpik',
                online: true,
                priceLabel: id.endsWith(':free') ? 'Gratis' : (provider === 'pekpik' ? 'Free Tier' : 'API'),
              };
            })
            .filter(Boolean);
          return jsonResponse({ models });
        } catch (e) {
          return jsonResponse({ error: String(e) }, 502);
        }
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

      const activeIds = [...new Set((Array.isArray(body.models) ? body.models : []).map((m) => String(m || '').trim()).filter(Boolean))];
      const rows = activeIds.map((model) => ({ provider, model, active: true }));
      for (let i = 0; i < rows.length; i += 250) {
        const upRes = await servicePostgrest(env, '/provider_models', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
          body: rows.slice(i, i + 250),
        });
        if (!upRes.ok) {
          const detail = await upRes.text().catch(() => '');
          return jsonResponse({ error: 'DB write failed', status: upRes.status, detail: detail.slice(0, 200) }, 500);
        }
      }
      const listRes = await servicePostgrest(env, `/provider_models?select=model&provider=eq.${encodeURIComponent(provider)}&active=eq.true`);
      const existing = await listRes.json().catch(() => []);
      const activeSet = new Set(activeIds);
      const stale = (existing ?? []).map((m) => m.model).filter((m) => !activeSet.has(m));
      if (stale.length > 0) {
        let bulkDone = false;
        if (stale.length <= 200) {
          bulkDone = true;
          for (let i = 0; i < stale.length; i += 25) {
            const batch = stale.slice(i, i + 25);
            const inExpr = batch.map((m) => `"${String(m).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
            const patchRes = await servicePostgrest(
              env,
              `/provider_models?provider=eq.${encodeURIComponent(provider)}&model=in.(${encodeURIComponent(inExpr)})`,
              { method: 'PATCH', body: { active: false } },
            );
            if (!patchRes.ok) {
              bulkDone = false;
              break;
            }
          }
        }
        if (!bulkDone) {
          await servicePostgrest(
            env,
            `/provider_models?provider=eq.${encodeURIComponent(provider)}&active=eq.true`,
            { method: 'PATCH', body: { active: false } },
          );
          for (let i = 0; i < rows.length; i += 250) {
            await servicePostgrest(env, '/provider_models', {
              method: 'POST',
              headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
              body: rows.slice(i, i + 250),
            });
          }
        }
      }
      return jsonResponse({ ok: true, saved: activeIds.length, activeCount: activeIds.length });
    }

    // ---- /video/models: multi-provider video generation models & provider statuses ----
    // ---- /admin/users/action: saldo, suspend/banned, hapus akun (wajib password) ----
    if (path === 'admin/users/action' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      try {
        return jsonResponse({ ok: true, ...(await handleAdminUserAction(env, request, user)) });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Aksi admin gagal' }, err?.status || 500);
      }
    }

    // ---- /admin/users/roles: daftar ID akun admin (untuk kolom PEROAN) ----
    if (path === 'admin/users/roles' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      try {
        return jsonResponse({ ok: true, ...(await handleAdminUserRoles(env, request, user)) });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Memuat peran gagal' }, err?.status || 500);
      }
    }

    // ---- /admin/purchase-toggle: aktif/nonaktifkan pembelian kredit (wajib password) ----
    if (path === 'admin/purchase-toggle' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      try {
        return jsonResponse({ ok: true, ...(await handlePurchaseToggle(env, request, user)) });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Mengubah status pembelian gagal' }, err?.status || 500);
      }
    }

    // ---- /admin/review-order: setujui/tolak pesanan kredit (wajib password) ----
    if (path === 'admin/review-order' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      try {
        return jsonResponse({ ok: true, ...(await handleOrderReview(env, request, user)) });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Verifikasi pesanan gagal' }, err?.status || 500);
      }
    }

    // ---- /image/*: generate gambar Freebeat untuk semua user (kredit BLEA) ----
    if (path === 'image/config' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        const config = await consumerImageConfig(env);
        const aliState = await loadAlibabaImageCatalogState(env).catch(() => ({ models: [], unpriced: [] }));
        const models = [
          {
            provider: 'freebeat',
            model: String(config?.model_id ?? ''),
            name: `Freebeat: model ${config?.model_id ?? '—'}`,
            credits: Number.isSafeInteger(config?.credits) ? config.credits : null,
            ready: config?.provider_ready === true && Number.isSafeInteger(config?.credits),
            params: null,
          },
          ...aliState.models,
        ];
        const isCallerAdmin = user?.app_metadata?.role === 'admin';
        return jsonResponse({
          ok: true,
          ...config,
          models,
          ...(isCallerAdmin && aliState.unpriced.length > 0 ? { alibaba_unpriced: aliState.unpriced } : {}),
        });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Konfigurasi gambar tidak tersedia' }, err?.status || 500);
      }
    }

    if (path === 'image/generate' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        // Peek body tanpa mengonsumsi request (jalur Freebeat membaca ulang body).
        const contentType = request.headers.get('content-type') || '';
        const origin = request.headers.get('origin');
        if (origin !== new URL(request.url).origin) throw ALIBABA_IMAGE_ERROR('Permintaan harus berasal dari halaman BLEA ini.', 403);
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw ALIBABA_IMAGE_ERROR('Format permintaan tidak valid.', 400);
        const length = Number(request.headers.get('content-length') || 0);
        if (length && length > 65_536) throw ALIBABA_IMAGE_ERROR('Permintaan terlalu besar.', 413);
        const peek = await request.clone().json().catch(() => ({}));
        const provider = String(peek?.provider || 'freebeat').trim().toLowerCase();
        if (provider === 'alibaba' || provider === 'freebeat') {
          const result = provider === 'alibaba'
            ? await alibabaImageGenerate(env, user, peek)
            : await consumerImageGenerate(env, request, user);
          return jsonResponse({
            ok: true,
            ...result,
            ...(result?.generation ? { generation: await attachImageDownloadUrls(result.generation, env) } : {}),
          });
        }
        throw ALIBABA_IMAGE_ERROR('Provider gambar tidak dikenal.', 400);
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Generasi gambar gagal' }, err?.status || 500);
      }
    }

    if (path === 'image/status' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        const peek = await request.clone().json().catch(() => ({}));
        const id = typeof peek?.id === 'string' ? peek.id : '';
        let result = null;
        if (id) {
          const rowRes = await servicePostgrest(env, `/image_generations?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`).catch(() => null);
          const rows = rowRes?.ok ? await rowRes.json().catch(() => []) : [];
          const row = Array.isArray(rows) ? rows[0] : null;
          if (row?.provider === 'alibaba') {
            result = await alibabaImageStatus(env, user, row);
          }
        }
        if (!result) result = await consumerImageStatus(env, request, user);
        return jsonResponse({
          ok: true,
          ...result,
          ...(result?.generation ? { generation: await attachImageDownloadUrls(result.generation, env) } : {}),
        });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Status gambar tidak tersedia' }, err?.status || 500);
      }
    }

    if (path === 'image/history' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        return jsonResponse({ ok: true, ...(await attachImageHistoryDownloads(await consumerImageHistory(env, user), env)) });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Riwayat gambar tidak tersedia' }, err?.status || 500);
      }
    }

    if (path === 'video/models' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const [keysRes, modelsRes, pricesRes, danceCfg] = await Promise.all([
        servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url,label'),
        servicePostgrest(env, '/provider_models?select=provider,model,active&active=eq.true&order=created_at.desc&limit=500'),
        servicePostgrest(env, '/credit_model_prices?modality=eq.video&active=eq.true&select=provider,model,credits&limit=500').catch(() => null),
        consumerDanceConfig(env).catch(() => null),
      ]);
      const keyRows = await keysRes.json().catch(() => []);
      const dbModelRows = await modelsRes.json().catch(() => []);
      const videoPriceRows = pricesRes?.ok ? await pricesRes.json().catch(() => []) : [];
      const videoPriceMap = new Map(
        (Array.isArray(videoPriceRows) ? videoPriceRows : []).map((row) => [
          `${String(row?.provider || '').trim().toLowerCase()}:${String(row?.model || '').trim()}`,
          Number(row?.credits),
        ]),
      );

      const configuredByProvider = new Map();
      for (const row of keyRows || []) {
        configuredByProvider.set(row.provider, {
          id: row.provider,
          label: row.label || PROVIDER_PRESETS[row.provider]?.label || row.provider,
          configured: Boolean(row.api_key) && Boolean(resolveProviderApiBase(row.provider, row.base_url)),
          hasBaseUrl: Boolean(row.base_url),
        });
      }

      const merged = new Map();
      // 1. Active video models configured in Admin Panel (provider_models)
      for (const row of dbModelRows || []) {
        const provider = String(row.provider || '').trim().toLowerCase();
        if (!provider || provider === 'unorouter' || provider === 'freebeat') continue;
        const key = `${provider}:${row.model}`;
        if (provider === 'cloudflare' && !isVideoModelId(row.model)) continue;
        // Alibaba: provider_models memuat model chat/image/tts juga; hanya model
        // dengan adapter video terverifikasi yang boleh tampil sebagai 'video'.
        if (provider === 'alibaba' && !isAlibabaVideoModelSupported(row.model)) continue;
        const isVideo = isVideoModelId(row.model) || provider !== 'cloudflare';
        if (!isVideo) continue;
        // Skip clearly non-video chat/embedding models on other providers if obvious
        if (/(gpt-oss|deepseek|embed|whisper|rerank|coder|instruct|llama|gemma|qwen|glm|mistral|granite)/i.test(row.model)) continue;
        const profile = getVideoModelProfile(row.model, provider);
        const creditPrice = videoPriceMap.get(key);
        const priced = Number.isSafeInteger(creditPrice) && creditPrice > 0;
        merged.set(key, {
          ...profile,
          provider,
          providerLabel: configuredByProvider.get(provider)?.label || PROVIDER_PRESETS[provider]?.label || provider,
          providerConfigured: Boolean(configuredByProvider.get(provider)?.configured),
          activeInAdmin: true,
          online: true,
          credits: priced ? creditPrice : null,
          priced,
          isFree: priced ? false : profile.isFree,
          priceLabel: priced ? `${creditPrice} kredit` : 'Tarif belum diatur',
          description: profile.description,
        });
      }

      // 2. Built-in video catalog entries (ensures dropdown always has video options & capabilities)
      for (const item of BUILTIN_VIDEO_MODELS) {
        if (item.provider === 'unorouter') continue;
        const key = `${item.provider}:${item.id}`;
        if (merged.has(key)) continue;
        const provInfo = configuredByProvider.get(item.provider);
        const creditPrice = videoPriceMap.get(key);
        const priced = Number.isSafeInteger(creditPrice) && creditPrice > 0;
        merged.set(key, {
          ...item,
          providerLabel: provInfo?.label || PROVIDER_PRESETS[item.provider]?.label || item.provider,
          providerConfigured: Boolean(provInfo?.configured),
          activeInAdmin: false,
          online: true,
          credits: priced ? creditPrice : null,
          priced,
          isFree: priced ? false : item.isFree,
          priceLabel: priced ? `${creditPrice} kredit` : 'Tarif belum diatur',
          description: item.description,
        });
      }

      // 3. Freebeat MCP Dance Video (OAuth provider session + credit_model_prices)
      if (danceCfg && (Number.isSafeInteger(danceCfg.credits) || danceCfg.provider_ready)) {
        const danceCredits = Number.isSafeInteger(danceCfg.credits) ? danceCfg.credits : null;
        const dancePriced = Number.isSafeInteger(danceCredits) && danceCredits > 0;
        merged.set('freebeat:generate_dance_video', {
          id: 'generate_dance_video',
          name: 'Freebeat AI Dance Video (720p)',
          provider: 'freebeat',
          providerLabel: 'Freebeat AI Dance',
          providerConfigured: danceCfg.provider_ready === true,
          activeInAdmin: dancePriced,
          online: danceCfg.provider_ready === true,
          credits: dancePriced ? danceCredits : null,
          priced: dancePriced,
          isFree: false,
          priceLabel: dancePriced ? `${danceCredits} kredit` : 'Tarif belum diatur',
          aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4'],
          resolutions: ['720p'],
          durations: [15],
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: true,
          supportsAudioInput: true,
          supportsAudioOutput: true,
          requiresAudio: true,
          maxImages: 5,
          description: 'Buat video dance koreografi otomatis dari lagu (MP3/WAV/link musik) & hingga 5 foto penari (720p, estimasi 15–60 menit).',
        });
      }

      const models = Array.from(merged.values()).sort((a, b) => {
        if (a.activeInAdmin !== b.activeInAdmin) return a.activeInAdmin ? -1 : 1;
        if (a.providerConfigured !== b.providerConfigured) return a.providerConfigured ? -1 : 1;
        if (a.priced !== b.priced) return a.priced ? -1 : 1;
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      const providers = Array.from(configuredByProvider.values()).filter((p) => !['cloudflare', 'unorouter', 'freebeat'].includes(p.id));
      if (danceCfg && (Number.isSafeInteger(danceCfg.credits) || danceCfg.provider_ready)) {
        providers.push({ id: 'freebeat', label: 'Freebeat AI Dance', configured: danceCfg.provider_ready === true, hasBaseUrl: false });
      }
      for (const preset of Object.values(PROVIDER_PRESETS)) {
        if (preset.id === 'custom' || preset.id === 'cloudflare' || preset.id === 'unorouter') continue;
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

      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const requestedOffset = Number(body.offset ?? url.searchParams.get('offset') ?? 0);
      if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 100000) {
        return jsonResponse({ error: 'Invalid history offset' }, 400);
      }
      const res = await servicePostgrest(
        env,
        `/video_generations?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc,id.desc&limit=41&offset=${requestedOffset}`,
      );
      if (!res.ok) return jsonResponse({ error: 'Failed to load video history' }, 500);
      const rows = await res.json().catch(() => []);
      const generations = await Promise.all((rows || []).slice(0, 40).map((row) => sanitizeGenerationRow(row, env)));
      return jsonResponse({ ok: true, generations, hasMore: rows.length > 40 });
    }

    // ---- /video/generate: submit async video generation job & persist in Supabase ----
    if (path === 'video/generate' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const payload = await request.json().catch(() => ({}));
      const provider = String(payload.provider || '').trim().toLowerCase();
      const model = String(payload.model || '').trim();
      const prompt = String(payload.prompt || '').trim();
      const imageUrl = String(payload.image_url || '').trim();
      const videoUrl = String(payload.video_url || '').trim();
      const audioUrl = String(payload.audio_url || '').trim();

      // Validasi input murah lebih dulu: permintaan yang pasti ditolak tidak
      // perlu membebani database, dan penolakannya tidak bergantung pada
      // ketersediaan tabel profil.
      if (!provider || provider === 'unorouter' || (provider === 'freebeat' && model !== 'generate_dance_video')) {
        return jsonResponse({ error: 'Provider video tidak tersedia. Pilih provider yang didukung.' }, 400);
      }
      if (!model) return jsonResponse({ error: 'Pilih model video terlebih dahulu.' }, 400);
      if (provider === 'freebeat') {
        try {
          const out = await consumerDanceGenerate(env, user, payload);
          return jsonResponse({ ok: true, credits: out.credits, generation: await sanitizeGenerationRow(out.row, env) });
        } catch (err) {
          return jsonResponse({
            error: err?.message || 'Gagal memulai generasi dance video.',
            ...(err?.code ? { code: err.code } : {}),
            ...(err?.credits_required ? { credits_required: err.credits_required } : {}),
          }, err?.status || 502);
        }
      }
      if (provider === 'alibaba' && !isAlibabaVideoModelSupported(model)) {
        return jsonResponse({ error: 'Model video ini belum diverifikasi untuk BLEA (belum ada adapter + pengujian). Pilih model video Alibaba yang didukung.' }, 400);
      }
      const hasReferencePayload = ['reference_images', 'reference_videos', 'reference_audios']
        .some((key) => Array.isArray(payload[key]) && payload[key].some((item) => String(item || '').trim()));
      if (!prompt && !imageUrl && !videoUrl && !audioUrl && !hasReferencePayload) {
        return jsonResponse({ error: 'Masukkan prompt atau unggah minimal satu media (gambar, video, atau audio).' }, 400);
      }

      // Lapis kedua setelah accountGate(): jalur berbayar tetap memeriksa status
      // akun sendiri (cache 30 detik membuatnya nyaris gratis).
      const videoAccountStatus = await readAccountStatus(env, user.id);
      if (isBlockedAccountStatus(videoAccountStatus)) {
        return jsonResponse({ error: ACCOUNT_BLOCK_MESSAGE[videoAccountStatus], code: `account_${videoAccountStatus}`, account_status: videoAccountStatus }, 403);
      }

      const isAlibabaGenerate = provider === 'alibaba';
      const keyCandidates = isAlibabaGenerate
        ? await alibabaKeyCandidates(env)
        : [await fetchProviderKeyRecord(env, provider)].filter((row) => row?.api_key);
      if (!keyCandidates.length) {
        return jsonResponse({
          error: isAlibabaGenerate
            ? 'API key Alibaba belum dikonfigurasi. Tambahkan akun di Admin Panel → Alibaba Cloud.'
            : `Provider "${PROVIDER_PRESETS[provider]?.label || provider}" belum memiliki API key. Konfigurasikan di Admin Panel -> API Key.`,
        }, 400);
      }

      const builtRequests = [];
      const triedAccounts = [];
      for (const candidate of keyCandidates) {
        if (!resolveProviderApiBase(provider, candidate.base_url)) {
          if (!isAlibabaGenerate) return jsonResponse({ error: 'Base URL provider video belum valid.' }, 400);
          triedAccounts.push({ label: candidate.label || 'akun', reason: 'base_url tidak valid' });
          continue;
        }
        const req = await buildUpstreamVideoRequest({ provider, baseUrl: candidate.base_url, apiKey: candidate.api_key, payload });
        if (req?.error) {
          // Input tidak valid — bukan masalah key, tidak perlu rotasi akun atau potong kredit.
          return jsonResponse({ error: req.error }, req.status || 400);
        }
        builtRequests.push({ candidate, req });
      }
      if (!builtRequests.length) {
        return jsonResponse({ error: 'Base URL provider video belum valid.' }, 400);
      }

      // Tarif kredit BLEA wajib diatur admin (credit_model_prices, modality = 'video').
      const priceRes = await servicePostgrest(
        env,
        `/credit_model_prices?provider=eq.${encodeURIComponent(provider)}&model=eq.${encodeURIComponent(model)}&modality=eq.video&active=eq.true&select=credits&limit=1`,
      ).catch(() => null);
      const priceRows = priceRes?.ok ? await priceRes.json().catch(() => []) : [];
      const videoCredits = Number(Array.isArray(priceRows) ? priceRows[0]?.credits : null);
      if (!Number.isSafeInteger(videoCredits) || videoCredits <= 0) {
        return jsonResponse({
          error: `Harga kredit untuk model video "${model}" (${provider}) belum diatur admin. Atur dulu di Kredit → Admin · Harga generasi.`,
          code: 'video_price_missing',
        }, 409);
      }

      const genId = crypto.randomUUID();
      const spent = await creditRpc(env, 'spend_credits', {
        p_user_id: user.id,
        p_amount: videoCredits,
        p_description: `Generasi video ${provider} model ${model}`,
        p_generation_id: genId,
      });
      if (!spent) {
        return jsonResponse({
          error: `Kredit BLEA tidak cukup untuk generasi ini (butuh ${videoCredits} kredit).`,
          code: 'insufficient_credits',
          credits_required: videoCredits,
        }, 402);
      }

      let keyRow = null;
      let upstreamReq = null;
      let upstreamRes = null;
      let rawText = '';
      let upstreamData = {};
      for (const { candidate, req } of builtRequests) {
        let res = null;
        try {
          res = await fetch(req.submitUrl, {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify(req.body),
            signal: AbortSignal.timeout(60_000),
          });
        } catch (e) {
          if (isAlibabaGenerate) {
            await markPoolKeyResult(env, candidate, { success: false, error: String(e) });
            triedAccounts.push({ label: candidate.label || 'akun Alibaba', reason: 'jaringan gagal' });
            continue;
          }
          const refunded = await refundVideoCredits(env, user.id, videoCredits, genId, `Refund: generasi video ${provider} (${model}) gagal dihubungi`);
          return jsonResponse({ error: `Gagal menghubungi provider (${provider}): ${String(e)}${refunded ? ' Kredit BLEA dikembalikan.' : ''}` }, 502);
        }
        const text = await res.text().catch(() => '');
        const data = (() => { try { return JSON.parse(text); } catch { return {}; } })();
        if (res.ok) {
          keyRow = candidate;
          upstreamReq = req;
          upstreamRes = res;
          rawText = text;
          upstreamData = data;
          await markPoolKeyResult(env, candidate, { success: true });
          break;
        }
        if (isAlibabaGenerate && isAlibabaQuotaError(res.status, text)) {
          await markPoolKeyResult(env, candidate, { success: false, error: text.slice(0, 280) });
          triedAccounts.push({ label: candidate.label || 'akun Alibaba', reason: `HTTP ${res.status}` });
          continue;
        }
        // Error non-kuota: tampilkan apa adanya (perilaku lama).
        keyRow = candidate;
        upstreamReq = req;
        upstreamRes = res;
        rawText = text;
        upstreamData = data;
        break;
      }

      if (isAlibabaGenerate && !keyRow) {
        const refunded = await refundVideoCredits(env, user.id, videoCredits, genId, `Refund: semua akun Alibaba (${model}) gagal / kuota penuh`);
        return jsonResponse({
          ok: false,
          error: `Semua akun Alibaba (${triedAccounts.length || keyCandidates.length}) gagal atau terkena kuota/rate limit. Tambah akun lain di Admin Panel → Alibaba Cloud atau tunggu kuota reset.${refunded ? ' Kredit BLEA dikembalikan.' : ''}`,
          detail: triedAccounts.map((t) => `${t.label}: ${t.reason}`).join('; ').slice(0, 400),
        }, 429);
      }

      if (!upstreamRes.ok) {
        const refunded = await refundVideoCredits(env, user.id, videoCredits, genId, `Refund: generasi video ${provider} (${model}) ditolak (HTTP ${upstreamRes.status})`);
        const detail = redactUpstreamDetail(extractUpstreamError(upstreamData) || rawText.slice(0, 300), 300);
        const statusMsg = upstreamRes.status === 402
          ? 'Saldo / kuota provider tidak mencukupi untuk model ini.'
          : upstreamRes.status === 429
            ? 'Provider sedang sibuk atau terkena batas rate limit. Coba beberapa saat lagi.'
            : upstreamRes.status === 401 || upstreamRes.status === 403
              ? `API key untuk provider "${provider}" tidak valid atau tidak memiliki izin.`
              : (detail || `Permintaan generate gagal (HTTP ${upstreamRes.status}).`);
        return jsonResponse({
          ok: false,
          error: `${statusMsg}${refunded ? ' Kredit BLEA dikembalikan.' : ''}`,
          upstreamStatus: upstreamRes.status,
          detail,
        }, upstreamRes.status >= 400 && upstreamRes.status < 500 ? upstreamRes.status : 502);
      }

      const externalJobId = extractVideoJobId(upstreamData);
      const status = normalizeVideoStatus(upstreamData?.status || upstreamData?.data?.status || upstreamData?.output?.task_status || 'queued');
      const progress = extractProgressPercent(upstreamData, status);
      const pollingUrl = String(
        upstreamData?.polling_url
        || (externalJobId ? `${upstreamReq.pollBaseUrl}/${encodeURIComponent(externalJobId)}` : ''),
      ).trim();
      const apiBase = resolveProviderApiBase(provider, keyRow.base_url);
      const immediateContentUrl = status === 'completed'
        ? extractUpstreamVideoUrl(upstreamData, apiBase, externalJobId)
        : '';

      const immediateRefund = status === 'failed'
        ? await refundVideoCredits(env, user.id, videoCredits, genId, `Refund: generasi video ${provider} (${model}) langsung gagal`)
        : false;

      const insertBody = {
        id: genId,
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
        provider_key_id: keyRow?.id || null,
        credits_charged: videoCredits,
        credits_refunded: immediateRefund ? videoCredits : 0,
        status,
        progress,
        upstream_result_url: immediateContentUrl || null,
        error_message: status === 'failed' ? (redactUpstreamDetail(extractUpstreamError(upstreamData), 300) || 'Generasi gagal') : null,
        metadata: {
          mode: videoUrl ? 'video_to_video' : imageUrl ? 'image_to_video' : audioUrl ? 'audio_to_video' : 'text_to_video',
          ...(payload.image_last_url ? { image_last_url: payload.image_last_url } : {}),
          ...(Array.isArray(payload.reference_images) && payload.reference_images.length ? { reference_images: payload.reference_images.slice(0, 10) } : {}),
          ...(Array.isArray(payload.reference_videos) && payload.reference_videos.length ? { reference_videos: payload.reference_videos.slice(0, 5) } : {}),
          ...(Array.isArray(payload.reference_audios) && payload.reference_audios.length ? { reference_audios: payload.reference_audios.slice(0, 5) } : {}),
        },
      };

      const insertRes = await servicePostgrest(env, '/video_generations', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: insertBody,
      });
      if (!insertRes.ok) {
        if (!immediateRefund) {
          await refundVideoCredits(env, user.id, videoCredits, genId, 'Refund: riwayat generasi video tidak tersimpan');
        }
        const detail = await insertRes.text().catch(() => '');
        return jsonResponse({ error: 'Gagal menyimpan riwayat generate', detail: detail.slice(0, 200) }, 500);
      }
      const inserted = await insertRes.json().catch(() => []);
      const row = inserted?.[0] || insertBody;
      const generation = await sanitizeGenerationRow(row, env);
      return jsonResponse({ ok: true, credits: videoCredits, generation });
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

      let keyRow = null;
      let apiBase = '';
      let pollUrl = '';
      let pollRes = null;
      let nextStatus = row.status;
      let nextProgress = Number(row.progress || 0);
      let upstreamUrl = row.upstream_result_url;
      let errMsg = row.error_message;
      let extraPatch = {};

      if (row.provider === 'freebeat') {
        let dancePoll;
        try {
          dancePoll = await consumerDanceStatus(env, row);
        } catch (err) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env), pollWarning: err?.message || 'Freebeat status gagal diperiksa.' });
        }
        if (dancePoll.pollWarning && dancePoll.nextStatus === row.status && !dancePoll.externalJobId) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env), pollWarning: dancePoll.pollWarning });
        }
        nextStatus = dancePoll.nextStatus;
        nextProgress = dancePoll.nextProgress;
        upstreamUrl = dancePoll.upstreamUrl || row.upstream_result_url;
        errMsg = dancePoll.errMsg || row.error_message;
        extraPatch = {
          ...(dancePoll.externalJobId ? { external_job_id: dancePoll.externalJobId } : {}),
          ...(dancePoll.pollingUrl ? { polling_url: dancePoll.pollingUrl } : {}),
          ...(dancePoll.metadata ? { metadata: dancePoll.metadata } : {}),
        };
      } else if (row.provider === 'alibaba') {
        // Task milik workspace akun tertentu: coba akun yang submit dulu
        // (provider_key_id tersimpan), lalu akun pool lain sebagai cadangan.
        const seeded = [];
        if (row.provider_key_id) {
          try {
            const res = await servicePostgrest(env, `/provider_key_pool?select=id,provider,label,api_key,base_url,priority,consecutive_failures,cooldown_until&id=eq.${encodeURIComponent(row.provider_key_id)}&limit=1`);
            const rows = res.ok ? await res.json().catch(() => []) : [];
            if (rows?.[0]?.api_key) seeded.push(rows[0]);
          } catch { /* abaikan — coba kandidat pool */ }
        }
        for (const cand of await alibabaKeyCandidates(env)) {
          if (!seeded.some((rowSeed) => rowSeed.id === cand.id)) seeded.push(cand);
        }
        if (!seeded.length || !row.external_job_id) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env) });
        }
        for (const cand of seeded) {
          const base = resolveProviderApiBase('alibaba', cand.base_url);
          if (!base) continue;
          let res = null;
          try {
            res = await fetch(`${base}/api/v1/tasks/${encodeURIComponent(row.external_job_id)}`, {
              method: 'GET',
              headers: { authorization: `Bearer ${cand.api_key}` },
              signal: AbortSignal.timeout(30_000),
            });
          } catch {
            await markPoolKeyResult(env, cand, { success: false, error: 'poll jaringan gagal' });
            continue;
          }
          if (isAlibabaQuotaError(res.status, '')) {
            await markPoolKeyResult(env, cand, { success: false, error: `poll HTTP ${res.status}` });
            continue;
          }
          pollRes = res;
          keyRow = cand;
          apiBase = base;
          if (res.ok) await markPoolKeyResult(env, cand, { success: true });
          break;
        }
        if (!pollRes) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env), pollWarning: 'Semua akun Alibaba gagal polling.' });
        }
      } else {
        keyRow = await fetchProviderKeyRecord(env, row.provider || 'unorouter');
        if (!keyRow?.api_key) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env) });
        }
        apiBase = resolveProviderApiBase(row.provider || 'unorouter', keyRow.base_url);
        pollUrl = row.polling_url || (row.external_job_id ? `${apiBase}/videos/${encodeURIComponent(row.external_job_id)}` : '');
        if (!pollUrl) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env) });
        }
        pollRes = await fetch(pollUrl, {
          method: 'GET',
          headers: { authorization: `Bearer ${keyRow.api_key}` },
          signal: AbortSignal.timeout(30_000),
        });
      }
      if (row.provider !== 'freebeat') {
        if (!pollRes.ok) {
          return jsonResponse({ ok: true, generation: await sanitizeGenerationRow(row, env), pollWarning: `HTTP ${pollRes.status}` });
        }

        const pollData = await pollRes.json().catch(() => ({}));
        nextStatus = normalizeVideoStatus(pollData?.status || pollData?.data?.status || pollData?.output?.task_status || row.status);
        nextProgress = extractProgressPercent(pollData, nextStatus);
        upstreamUrl = nextStatus === 'completed'
          ? extractUpstreamVideoUrl(pollData, apiBase, row.external_job_id)
          : row.upstream_result_url;
        errMsg = nextStatus === 'failed'
          ? (redactUpstreamDetail(extractUpstreamError(pollData), 300) || 'Generasi video gagal di server provider.')
          : row.error_message;
      }

      const charged = Number(row.credits_charged || 0);
      const shouldRefund = ['failed', 'cancelled', 'expired'].includes(nextStatus)
        && charged > 0
        && Number(row.credits_refunded || 0) === 0;
      const patchQuery = shouldRefund
        ? `/video_generations?id=eq.${encodeURIComponent(row.id)}&credits_refunded=eq.0`
        : `/video_generations?id=eq.${encodeURIComponent(row.id)}`;
      const patchRes = await servicePostgrest(
        env,
        patchQuery,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: {
            status: nextStatus,
            progress: nextProgress,
            ...(upstreamUrl ? { upstream_result_url: upstreamUrl } : {}),
            ...(errMsg ? { error_message: errMsg } : {}),
            ...extraPatch,
            ...(shouldRefund ? { credits_refunded: charged } : {}),
          },
        },
      );
      const patched = patchRes.ok ? await patchRes.json().catch(() => []) : [];
      if (shouldRefund && Array.isArray(patched) && patched.length > 0) {
        const refunded = await refundVideoCredits(
          env,
          row.user_id,
          charged,
          row.id,
          `Refund: generasi video ${row.provider} (${row.model}) ${nextStatus}`,
        );
        if (!refunded && patched[0]) {
          patched[0].credits_refunded = 0;
          await servicePostgrest(env, `/video_generations?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH',
            body: { credits_refunded: 0 },
          }).catch(() => {});
        }
      }
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

    // ---- /chat: call UnoRouter / configured provider with automatic 429 fallback, save assistant reply to DB ----
    if (path === 'chat' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!token) return jsonResponse({ error: 'Missing token' }, 401);
      const user = await getUser(env, token);
      if (!user) return jsonResponse({ error: 'Invalid token' }, 401);
      const body = await request.json().catch(() => ({}));
      const keyRes = await servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url');
      const keyRows = await keyRes.json().catch(() => []);
      const keyByProvider = new Map((keyRows || []).map((r) => [String(r.provider || 'unorouter').toLowerCase(), r]));
      const primaryProvider = String(body.provider || 'unorouter').trim().toLowerCase();
      const requestedModel = String(body.model || 'gpt-oss-120b:free').trim();
      const alibabaCandidates = primaryProvider === 'alibaba' ? await alibabaKeyCandidates(env) : [];
      if (alibabaCandidates.length) {
        keyByProvider.set('alibaba', { provider: 'alibaba', api_key: alibabaCandidates[0].api_key, base_url: alibabaCandidates[0].base_url });
      }
      const alibabaPoolMap = alibabaCandidates.length ? new Map([['alibaba', alibabaCandidates]]) : undefined;
      const primaryKeyRow = primaryProvider === 'alibaba' ? (alibabaCandidates[0] || null) : keyByProvider.get(primaryProvider);
      let primaryApiKey = primaryKeyRow?.api_key || (primaryProvider === 'unorouter' ? 'use-free' : '');
      if (primaryProvider === 'cloudflare' && !primaryApiKey && hasWorkersAiBinding(env)) {
        primaryApiKey = 'binding:AI';
      }
      if (!primaryApiKey) {
        return jsonResponse({ error: `API key untuk provider "${primaryProvider}" belum dikonfigurasi.` }, 400);
      }

      const repository = typeof body.repository === 'string' && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(body.repository) ? body.repository : '';
      const githubEnabled = !!(body.github && repository && await githubToken(request, env, user));
      const [selectedOwner, selectedName] = repository.split('/');
      const systemPrompt = githubEnabled ? `${AGENT_SYSTEM_PROMPT}\n\n${GITHUB_TOOLS_PROMPT}\nRepository yang dipilih pengguna: ${repository}. Gunakan hanya repository ini.` : AGENT_SYSTEM_PROMPT;
      const incomingMessages = Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role && m.content !== undefined) : [];
      const fetchBody = { ...body, model: requestedModel, messages: [{ role: 'system', content: systemPrompt }, ...incomingMessages], stream: false };
      delete fetchBody.github;
      delete fetchBody.repository;
      delete fetchBody.apiKey;
      delete fetchBody.apiUrl;
      delete fetchBody.provider;
      delete fetchBody.autoFallback;
      delete fetchBody.conversationId;

      const wantStream = Boolean(body.stream) && !githubEnabled;

      try {
        let activeProvider = primaryProvider;
        let activeModel = requestedModel;
        let activeApiKey = primaryApiKey;
        let activeBaseUrl = primaryKeyRow?.base_url || '';
        let fallbackFrom = '';
        let fallbackReason = '';
        let cachedDbModels = null;

        const triedModels = [requestedModel];
        const triedDetails = [];

        if (wantStream) {
          let alibabaPrimaryCand = null;
          const primaryAttempt = activeProvider === 'alibaba'
            ? (await sendWithAlibabaPool({ candidates: alibabaCandidates, model: activeModel, payload: fetchBody, timeoutMs: 120_000, env, stream: true }).then((out) => { alibabaPrimaryCand = out.cand; return out.attempt; }))
            : await sendChatCompletionRequest({
              provider: activeProvider,
              model: activeModel,
              apiKey: activeApiKey,
              baseUrl: activeBaseUrl,
              payload: fetchBody,
              timeoutMs: 120_000,
              env,
              stream: true,
            });
          if (alibabaPrimaryCand) { activeApiKey = alibabaPrimaryCand.api_key; activeBaseUrl = alibabaPrimaryCand.base_url; }
          let probed = await probeChatStreamAttempt(primaryAttempt);
          if (!probed.ok) {
            const reasonCode = probed.errorInfo?.code || `http_${probed.status}`;
            triedDetails.push({
              model: activeModel,
              provider: activeProvider,
              status: probed.status,
              code: reasonCode,
              retryAfterSec: probed.errorInfo?.retryAfterSec ?? null,
              detail: probed.errorInfo?.rawDetail || '',
            });
            const canRetryStreamFallback = [400, 404, 429, 502, 503, 504].includes(probed.status) && body.autoFallback !== false;
            if (canRetryStreamFallback) {
              const modelsRes = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc&limit=150');
              cachedDbModels = modelsRes.ok ? await modelsRes.json().catch(() => []) : [];
              const candidates = buildChatFallbackCandidates({
                primaryProvider,
                primaryModel: requestedModel,
                keyByProvider,
                dbModelRows: cachedDbModels,
                env,
                poolByProvider: alibabaPoolMap,
              }).slice(0, 6);
              for (const cand of candidates) {
                triedModels.push(cand.model);
                const altAttempt = await sendChatCompletionRequest({
                  provider: cand.provider,
                  model: cand.model,
                  apiKey: cand.apiKey,
                  baseUrl: cand.baseUrl,
                  payload: fetchBody,
                  timeoutMs: 18_000,
                  env,
                  stream: true,
                });
                const altProbed = await probeChatStreamAttempt(altAttempt);
                if (altProbed.ok) {
                  probed = altProbed;
                  activeProvider = cand.provider;
                  activeModel = cand.model;
                  activeApiKey = cand.apiKey;
                  activeBaseUrl = cand.baseUrl;
                  fallbackFrom = requestedModel;
                  fallbackReason = reasonCode;
                  break;
                }
                triedDetails.push({
                  model: cand.model,
                  provider: cand.provider,
                  status: altProbed.status,
                  code: altProbed.errorInfo?.code || `http_${altProbed.status}`,
                  retryAfterSec: altProbed.errorInfo?.retryAfterSec ?? null,
                  detail: altProbed.errorInfo?.rawDetail || '',
                });
              }
            }
          }

          if (probed.ok && body.research !== false) {
            probed = await materializeProbedStream(probed);
            const searchRequests = parseSearchRequests(probed.reply);
            if (searchRequests.length || isUncertainReply(probed.reply)) {
              const query = searchRequests[0] || latestUserQuery(incomingMessages);
              if (query) {
                const researchResults = await webSearch(query);
                if (researchResults.length || searchRequests.length) {
                  const researchMessages = [
                    ...fetchBody.messages,
                    { role: 'assistant', content: stripSearchBlocks(probed.reply) || 'Saya perlu memeriksa beberapa sumber sebelum menjawab.' },
                    { role: 'user', content: formatResearchContext(researchResults, query) },
                  ];
                  const researched = await sendChatCompletionRequest({
                    provider: activeProvider, model: activeModel, apiKey: activeApiKey,
                    baseUrl: activeBaseUrl, payload: { ...fetchBody, messages: researchMessages },
                    timeoutMs: 60_000, env,
                  });
                  if (researched.ok) {
                    const researchedReply = extractAssistantReply(researched.data);
                    if (researchedReply) probed = { ok: true, mode: 'json', reply: stripSearchBlocks(researchedReply), reasoning: probed.reasoning || '' };
                  }
                }
              }
            }
          }

          if (probed.ok) {
            if (probed.mode === 'json') probed.reply = stripSearchBlocks(probed.reply);
            return createChatSseResponse({
              probed,
              meta: {
                model: activeModel,
                provider: activeProvider,
                ...(fallbackFrom ? { fallbackFrom, fallbackReason } : {}),
              },
              env,
              conversationId: body.conversationId,
              userId: user.id,
            });
          }

          const errInfo = probed.errorInfo || parseChatUpstreamError('', probed.status || 502);
          const rateLimitedEntries = triedDetails.filter((d) => d.status === 429 || d.code === 'rate_limit_exceeded');
          const allRateLimited = triedDetails.length > 1 && rateLimitedEntries.length === triedDetails.length;
          const retryCandidates = rateLimitedEntries.map((d) => d.retryAfterSec).filter((n) => Number.isFinite(n) && n > 0);
          const bestRetryAfter = retryCandidates.length ? Math.min(...retryCandidates) : errInfo.retryAfterSec;
          const finalStatus = [401, 402, 403, 404, 429].includes(probed.status) ? probed.status : (rateLimitedEntries.length ? 429 : 502);
          const errorMessage = allRateLimited
            ? (bestRetryAfter
              ? `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Coba lagi dalam ${bestRetryAfter} detik, pilih model lain, atau tambah saldo/provider di Admin.`
              : `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Tunggu sebentar atau tambah saldo/provider di Admin.`)
            : errInfo.friendlyMessage;
          return jsonResponse(
            {
              ok: false,
              error: errorMessage,
              code: errInfo.code,
              status: finalStatus,
              retryAfterSec: bestRetryAfter,
              detail: errInfo.rawDetail,
              triedModels,
              triedDetails,
            },
            finalStatus,
            bestRetryAfter ? { 'retry-after': String(bestRetryAfter) } : {},
          );
        }

        let alibabaPrimaryCand2 = null;
        let attempt = activeProvider === 'alibaba'
          ? (await sendWithAlibabaPool({ candidates: alibabaCandidates, model: activeModel, payload: fetchBody, timeoutMs: 120_000, env, stream: false }).then((out) => { alibabaPrimaryCand2 = out.cand; return out.attempt; }))
          : await sendChatCompletionRequest({
            provider: activeProvider,
            model: activeModel,
            apiKey: activeApiKey,
            baseUrl: activeBaseUrl,
            payload: fetchBody,
            timeoutMs: 120_000,
            env,
          });
        if (alibabaPrimaryCand2) { activeApiKey = alibabaPrimaryCand2.api_key; activeBaseUrl = alibabaPrimaryCand2.base_url; }
        let finalReply = attempt.ok ? extractAssistantReply(attempt.data) : '';
        if (!attempt.ok || !finalReply) {
          const reasonCode = attempt.ok ? 'empty_reply' : (attempt.errorInfo?.code || `http_${attempt.status}`);
          const detailText = attempt.ok ? 'Model mengembalikan respons kosong.' : (attempt.errorInfo?.rawDetail || '');
          triedDetails.push({
            model: activeModel,
            provider: activeProvider,
            status: attempt.ok ? 502 : attempt.status,
            code: reasonCode,
            retryAfterSec: attempt.errorInfo?.retryAfterSec ?? null,
            detail: detailText,
          });
        }

        const canRetryFallback = (!attempt.ok ? [400, 404, 429, 502, 503, 504].includes(attempt.status) : !finalReply) && body.autoFallback !== false;
        if ((!attempt.ok || !finalReply) && canRetryFallback) {
          const modelsRes = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc&limit=150');
          cachedDbModels = modelsRes.ok ? await modelsRes.json().catch(() => []) : [];
          const candidates = buildChatFallbackCandidates({
            primaryProvider,
            primaryModel: requestedModel,
            keyByProvider,
            dbModelRows: cachedDbModels,
            env,
            poolByProvider: alibabaPoolMap,
          }).slice(0, 6);

          const primaryReason = attempt.ok ? 'empty_reply' : (attempt.errorInfo?.code || `http_${attempt.status}`);
          for (const cand of candidates) {
            triedModels.push(cand.model);
            const altRes = await sendChatCompletionRequest({
              provider: cand.provider,
              model: cand.model,
              apiKey: cand.apiKey,
              baseUrl: cand.baseUrl,
              payload: fetchBody,
              timeoutMs: 18_000,
              env,
            });
            const altReply = altRes.ok ? extractAssistantReply(altRes.data) : '';
            if (altRes.ok && altReply) {
              attempt = altRes;
              finalReply = altReply;
              activeProvider = cand.provider;
              activeModel = cand.model;
              activeApiKey = cand.apiKey;
              activeBaseUrl = cand.baseUrl;
              fallbackFrom = requestedModel;
              fallbackReason = primaryReason;
              break;
            }
            triedDetails.push({
              model: cand.model,
              provider: cand.provider,
              status: altRes.ok ? 502 : altRes.status,
              code: altRes.ok ? 'empty_reply' : (altRes.errorInfo?.code || `http_${altRes.status}`),
              retryAfterSec: altRes.errorInfo?.retryAfterSec ?? null,
              detail: altRes.ok ? 'Model mengembalikan respons kosong.' : (altRes.errorInfo?.rawDetail || ''),
            });
          }
        }

        if (attempt.ok && finalReply && body.research !== false && !githubEnabled) {
          const searchRequests = parseSearchRequests(finalReply);
          if (searchRequests.length || isUncertainReply(finalReply)) {
            const query = searchRequests[0] || latestUserQuery(incomingMessages);
            if (query) {
              const researchResults = await webSearch(query);
              if (researchResults.length || searchRequests.length) {
                const researchMessages = [
                  ...fetchBody.messages,
                  { role: 'assistant', content: stripSearchBlocks(finalReply) || 'Saya perlu memeriksa beberapa sumber sebelum menjawab.' },
                  { role: 'user', content: formatResearchContext(researchResults, query) },
                ];
                const researched = await sendChatCompletionRequest({
                  provider: activeProvider, model: activeModel, apiKey: activeApiKey,
                  baseUrl: activeBaseUrl, payload: { ...fetchBody, messages: researchMessages },
                  timeoutMs: 60_000, env,
                });
                if (researched.ok) {
                  const researchedReply = extractAssistantReply(researched.data);
                  if (researchedReply) finalReply = stripSearchBlocks(researchedReply);
                }
              }
            }
          }
        }

        if (attempt.ok && finalReply) finalReply = stripSearchBlocks(finalReply);

        if (!attempt.ok || !finalReply) {
          const errInfo = attempt.errorInfo || parseChatUpstreamError('', attempt.status || 502);
          const rateLimitedEntries = triedDetails.filter((d) => d.status === 429 || d.code === 'rate_limit_exceeded');
          const allRateLimited = triedDetails.length > 1 && rateLimitedEntries.length === triedDetails.length;
          const retryCandidates = rateLimitedEntries.map((d) => d.retryAfterSec).filter((n) => Number.isFinite(n) && n > 0);
          const bestRetryAfter = retryCandidates.length ? Math.min(...retryCandidates) : errInfo.retryAfterSec;
          const finalStatus = [401, 402, 403, 404, 429].includes(attempt.status) ? attempt.status : (rateLimitedEntries.length ? 429 : 502);
          const errorMessage = allRateLimited
            ? (bestRetryAfter
              ? `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Coba lagi dalam ${bestRetryAfter} detik, pilih model lain, atau tambah saldo/provider di Admin.`
              : `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Tunggu sebentar atau tambah saldo/provider di Admin.`)
            : errInfo.friendlyMessage;
          return jsonResponse(
            {
              ok: false,
              error: errorMessage,
              code: errInfo.code,
              status: finalStatus,
              retryAfterSec: bestRetryAfter,
              detail: errInfo.rawDetail,
              triedModels,
              triedDetails,
            },
            finalStatus,
            bestRetryAfter ? { 'retry-after': String(bestRetryAfter) } : {},
          );
        }
        const actions = [];
        if (githubEnabled) {
          let roundMessages = [...fetchBody.messages];
          for (let round = 0; round < 4; round += 1) {
            const toolCalls = parseToolCalls(finalReply).slice(0, 6);
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
            roundMessages = [...roundMessages, { role: 'assistant', content: finalReply }, { role: 'user', content: toolMessage }];
            let roundRes = await sendChatCompletionRequest({
              provider: activeProvider,
              model: activeModel,
              apiKey: activeApiKey,
              baseUrl: activeBaseUrl,
              payload: { ...fetchBody, messages: roundMessages },
              timeoutMs: 60_000,
              env,
            });
            if (!roundRes.ok && [429, 503, 502].includes(roundRes.status) && body.autoFallback !== false) {
              if (!cachedDbModels) {
                const modelsRes = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc&limit=150');
                cachedDbModels = modelsRes.ok ? await modelsRes.json().catch(() => []) : [];
              }
              const alt = buildChatFallbackCandidates({
                primaryProvider: activeProvider,
                primaryModel: activeModel,
                keyByProvider,
                dbModelRows: cachedDbModels,
                env,
                poolByProvider: alibabaPoolMap,
              })[0];
              if (alt) {
                const altRoundRes = await sendChatCompletionRequest({
                  provider: alt.provider,
                  model: alt.model,
                  apiKey: alt.apiKey,
                  baseUrl: alt.baseUrl,
                  payload: { ...fetchBody, messages: roundMessages },
                  timeoutMs: 40_000,
                  env,
                });
                if (altRoundRes.ok) {
                  roundRes = altRoundRes;
                  fallbackFrom = fallbackFrom || activeModel;
                  activeProvider = alt.provider;
                  activeModel = alt.model;
                  activeApiKey = alt.apiKey;
                  activeBaseUrl = alt.baseUrl;
                }
              }
            }
            if (!roundRes.ok) break;
            finalReply = extractAssistantReply(roundRes.data) || '';
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
        return jsonResponse({
          ok: true,
          reply,
          messageId,
          actions,
          model: activeModel,
          provider: activeProvider,
          ...(fallbackFrom ? { fallbackFrom, fallbackReason } : {}),
        });
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
