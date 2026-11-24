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
  BUILTIN_CATALOG_PROVIDER_MODELS,
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
import { isSafeRemoteMediaUrl, UPSTREAM_MEDIA_USER_AGENT } from './lib/safeUrl.js';
import { handleMediaResolve, handleMediaProxy } from './lib/socialMediaResolver.js';
import { handleAdminUserAction, handleAdminUserRoles } from './lib/adminUserControls.js';
import { handleOrderReview, handlePurchaseToggle } from './lib/adminPurchases.js';
import {
  LIVE_RECENT_COMPLETED_MS,
  compareRaceItems,
  diagnosePendingGeneration,
  formatLiveQueueItem,
  patchImageGeneration as patchImageGenerationRow,
} from './lib/liveQueue.js';
import {
  consumerDanceGenerate,
  consumerDanceStatus,
  consumerFreebeatVideoConfigs,
  consumerImageConfig,
  consumerImageGenerate,
  consumerImageHistory,
  consumerImageStatus,
  consumerMusicConfig,
  consumerMusicGenerate,
  consumerMusicHistory,
  consumerMusicStatus,
  consumerVocalGenerate,
  fetchFreebeatCatalogModels,
  freebeatCallback,
  handleFreebeat,
  pollFreebeatImageRow,
  pollFreebeatMusicRow,
  refreshMusicRowUrls,
  sanitizeImageRow,
  sanitizeMusicRow,
} from './lib/freebeatMcp.js';
import { isUncertainReply, parseSearchRequests, parseUpstreamSsePayload, stripSearchBlocks } from './lib/chatStream.js';
import {
  OPENAI_CAPABILITIES,
  openAiFailureMessage,
  openAiPoolBlockedMessage,
  openAiPoolSummary,
  createOpenAiAccount,
  deleteOpenAiAccount,
  listOpenAiAccounts,
  pickOpenAiAccountsFor,
  sendOAuthResponses,
  sendWithOpenAiPool,
  testOpenAiAccount,
  updateOpenAiAccount,
} from './lib/openaiPool.js';
import { agentToolsForStudioTool, capabilityForApiPath, toolCapabilityViolation } from './lib/toolCapabilities.js';
import { studioModelItems } from './lib/openaiModels.js';
import {
  completeOAuthAttempt,
  createOAuthAttempt,
  disconnectOAuthLink,
  listOAuthLinks,
  retainedClientId,
  OPENAI_AGENT_NAME_HINT,
  OPENAI_DYNAMIC_CLIENT_ID,
  OPENAI_LOOPBACK_PATH,
  OPENAI_RESOURCE,
  OPENAI_SCOPES,
  refreshOAuthLink,
} from './lib/openaiOAuth.js';
import {
  generateStudioImage,
  generateStudioVideo,
  recordStudioText,
  studioMediaConfig,
  studioVideoStatus,
} from './lib/studioGenerations.js';
import { handleAgentTurn } from './agent/agentRoute.js';
import { handleTranscribe } from './agent/transcribeRoute.js';
import { buildAgentSystemPrompt } from './agent/prompts.js';
import { availableSkills, loadSkillSection } from './agent/skills/loadSkill.js';
import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  buildAttachmentContent,
  findAgentTool,
  normalizeAgentAttachments,
  normalizeClipProposal,
  normalizeVideoAnalysis,
  normalizeVideoTranscript,
  parseAgentToolCall,
  stripAgentToolCalls,
} from './agent/tools.js';
import { createMailtmAlias, fetchMailtmMessage, fetchMailtmMessages, parseMailtmCredentials, refreshMailtmToken, serializeMailtmCredentials } from './lib/mailtmProvider.js';
import { handleOpenAiSignup } from './lib/openaiSignupRoute.js';
import { buildUserscriptResponse } from './lib/openaiSignupUserscript.js';
import { buildGmailAuthUrl, createGmailApiAlias, deleteGmailConnection, getGmailConnection, getGmailMessage, handleGmailOAuthCallback, isGmailApiConfigured, listGmailMessages } from './lib/gmailProvider.js';
import {
  handleMetadataContent,
  handleMetadataHistory,
  handleMetadataProcess,
  handleMetadataScan,
  handleMetadataStart,
  handleMetadataStatus,
  sanitizeMetadataJobRow,
} from './lib/metadataJobs.js';

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

/** Apakah alias `nama+tag@domain` benar-benar milik mailbox Gmail yang terhubung. */
function aliasBelongsToGmailConnection(alias, connection) {
  const address = String(alias?.email || '').toLowerCase();
  const account = String(connection?.email || '').toLowerCase();
  const plus = address.indexOf('+');
  const at = address.lastIndexOf('@');
  const accountAt = account.lastIndexOf('@');
  return plus > 0 && at > plus && accountAt > 0
    && address.slice(0, plus) === account.slice(0, accountAt)
    && address.slice(at + 1) === account.slice(accountAt + 1);
}

/**
 * Pembaca inbox TempMail untuk satu user admin, dipakai /api/openai-signup
 * supaya logika alias/penyedia tidak diduplikasi di dua tempat.
 * Email yang diminta WAJIB sama dengan alias aktif milik user tersebut.
 */
async function tempmailInboxReader(env, user) {
  const response = await servicePostgrest(env, `/tempmail_user_aliases?select=user_id,email,token,provider&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (!response.ok) throw Object.assign(new Error('Gagal membaca alias TempMail. Pastikan tabel tempmail_user_aliases sudah dibuat.'), { status: 503 });
  const alias = (await response.json().catch(() => []))?.[0] || null;
  return async (email) => {
    if (!alias) throw Object.assign(new Error('Buat alamat TempMail terlebih dahulu.'), { status: 404 });
    const requested = String(email || '').trim().toLowerCase();
    if (!requested || requested !== String(alias.email || '').toLowerCase()) {
      throw Object.assign(new Error('Alamat tidak ditemukan pada akun admin ini.'), { status: 404 });
    }
    if (alias.provider === 'gmailapi') {
      const connection = await getGmailConnection(env, user.id);
      if (!connection || !aliasBelongsToGmailConnection(alias, connection)) {
        throw Object.assign(new Error('Koneksi Gmail tidak cocok dengan akhiran yang aktif. Hubungkan ulang Gmail atau buat akhiran baru.'), { status: 409 });
      }
      // Mode longgar: pendaftaran butuh melihat email verifikasi walau Gmail
      // membuang plus-tag dari alamat tujuan.
      return listGmailMessages(env, connection, alias.email, { matchMode: 'loose' });
    }
    const credentials = parseMailtmCredentials(alias.token);
    return fetchMailtmMessages(credentials.token);
  };
}

/**
 * Pembaca SATU pesan (isi lengkap) dengan pemeriksaan pemilik alias yang sama.
 * Dipakai untuk mengambil kode verifikasi: OpenAI mengirim kode di badan
 * email, bukan tautan, dan `preview`/snippet inbox tidak selalu memuatnya.
 */
async function tempmailMessageReader(env, user) {
  const response = await servicePostgrest(env, `/tempmail_user_aliases?select=user_id,email,token,provider&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  if (!response.ok) throw Object.assign(new Error('Gagal membaca alias TempMail. Pastikan tabel tempmail_user_aliases sudah dibuat.'), { status: 503 });
  const alias = (await response.json().catch(() => []))?.[0] || null;
  return async (email, messageId) => {
    if (!alias) throw Object.assign(new Error('Buat alamat TempMail terlebih dahulu.'), { status: 404 });
    const requested = String(email || '').trim().toLowerCase();
    if (!requested || requested !== String(alias.email || '').toLowerCase()) {
      throw Object.assign(new Error('Alamat tidak ditemukan pada akun admin ini.'), { status: 404 });
    }
    const id = String(messageId || '').trim();
    if (!id) throw Object.assign(new Error('ID pesan wajib diisi.'), { status: 400 });
    if (alias.provider === 'gmailapi') {
      const connection = await getGmailConnection(env, user.id);
      if (!connection || !aliasBelongsToGmailConnection(alias, connection)) {
        throw Object.assign(new Error('Koneksi Gmail tidak cocok dengan akhiran yang aktif. Hubungkan ulang Gmail atau buat akhiran baru.'), { status: 409 });
      }
      return getGmailMessage(env, connection, alias.email, id);
    }
    const credentials = parseMailtmCredentials(alias.token);
    return fetchMailtmMessage(credentials.token, id);
  };
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
  // Dipakai juga oleh /api/openai-signup: pencocokan pesan verifikasi hanya
  // boleh memakai alias milik admin ini.
  const aliasBelongsToConnection = aliasBelongsToGmailConnection;
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
        // Tetap mode ketat: halaman TempMail hanya menampilkan pesan untuk
        // alias +tag. Mode longgar dipakai khusus pembaca pendaftaran, yang
        // perlu email verifikasi walau Gmail membuang tag dari alamat tujuan.
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
// ---- Isolasi kapabilitas per tool Studio -------------------------------
// Klien mengirim header `x-blea-studio-tool` berisi id tool yang sedang
// dibuka. Worker menolak panggilan API yang kapabilitasnya tidak dideklarasikan
// tool itu (lihat src/lib/toolCapabilities.js). Ini lapisan kedua: UI tidak
// menampilkan tombol lintas-tool, dan lapisan ini menahan permintaan yang
// dibuat manual/dimanipulasi.
const STUDIO_TOOL_HEADER = 'x-blea-studio-tool';
function studioToolHeader(request) {
  const value = request.headers.get(STUDIO_TOOL_HEADER);
  return value && /^[a-z0-9-]{1,40}$/i.test(value) ? value.toLowerCase() : '';
}
function studioToolGuard(request, path) {
  const toolId = studioToolHeader(request);
  if (!toolId) return null;
  const violation = toolCapabilityViolation(toolId, path);
  if (!violation) return null;
  return jsonResponse({ error: violation.message, code: violation.code }, 403, { 'cache-control': 'no-store' });
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
  // ID numerik murni adalah katalog gambar/video Freebeat (122, 209, ...),
  // bukan model chat.
  if (/^\d+$/.test(id)) return false;
  return !/(^|\/|-)(embedding|embed|rerank|whisper|tts|speech|dall-e|imagen|flux|stable-diffusion|midjourney|moderation|bge-|melo|aura|nova-|qwen-image|qwen-mt-image|z-image|image|t2i|i2i|dance|vocal|lip-?sync|asr|music|suno)/i.test(id);
}

// Provider yang seluruh katalognya gambar/video — tidak pernah untuk Chat.
const NON_CHAT_PROVIDERS = new Set(['freebeat']);

// Katalog free quota Alibaba menandai kemampuan tiap model lewat `blea`:
// 'chat' = bisa dipakai di AI Studio, 'image'/'video' = adapter Generate,
// null = katalog saja. Model Alibaba yang tercatat tanpa blea 'chat' tidak
// boleh muncul di pemilih model Chat.
const ALIBABA_CATALOG_BY_ID = new Map(ALIBABA_FREE_QUOTA_MODELS.map((m) => [String(m.id).trim(), m]));

function isAlibabaChatCatalogModel(modelId) {
  const row = ALIBABA_CATALOG_BY_ID.get(String(modelId || '').trim());
  if (!row) return true; // tidak ada metadata resmi → jangan menebak
  return row.blea === 'chat';
}

// Modality harga yang menandakan model bukan teks/chat.
const NON_CHAT_MODALITIES = new Set(['image', 'image_edit', 'image_edit_2k', 'video', 'music', 'speech', 'embedding']);

// Model yang punya harga eksplisit non-teks di credit_model_prices tidak boleh
// muncul di daftar Chat, walau namanya tidak cocok dengan pola di atas.
function collectPricedNonChatModels(priceRows) {
  const keys = new Set();
  for (const row of priceRows || []) {
    const modality = String(row?.modality || '').toLowerCase().trim();
    if (!NON_CHAT_MODALITIES.has(modality)) continue;
    const provider = String(row?.provider || '').toLowerCase().trim();
    const model = String(row?.model || '').trim();
    if (provider && model) keys.add(`${provider}::${model}`);
  }
  return keys;
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

/**
 * Kandidat cadangan ketika provider utama TIDAK BISA DIPAKAI SAMA SEKALI
 * (pool OpenAI ada tetapi tidak ada akun yang bisa dipanggil, atau kredensial
 * provider kosong).
 *
 * Kenapa perlu: jalur awal `/api/chat` langsung mengembalikan 4xx/503 dengan
 * pesan pool sebelum rantai fallback pernah dibangun. Akibatnya pengguna dengan
 * akun OpenAI bermasalah tidak pernah sampai ke provider lain yang sehat
 * (mis. alibaba), padahal `autoFallback` aktif. Dulu kandidat hanya dibangun
 * dari `provider_models` milik provider utama — di sini SEMUA model aktif
 * dipertimbangkan, karena provider utama jelas tidak menghasilkan apa pun.
 */
function buildAnyProviderChatCandidates({ primaryProvider, primaryModel, keyByProvider, dbModelRows, env, poolByProvider }) {
  const all = buildChatFallbackCandidates({
    primaryProvider,
    primaryModel,
    keyByProvider,
    dbModelRows,
    env,
    poolByProvider,
  });
  return all.slice(0, 6);
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
  const envMaxTokens = Number(env?.OLLAMA_MAX_TOKENS);
  const ollamaMaxTokens = Number.isFinite(envMaxTokens) && envMaxTokens > 0 ? Math.trunc(envMaxTokens) : 0;
  let upstream;
  try {
    upstream = await fetch(chatUrl, {
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
      // Batas panjang keluaran Ollama TIDAK dipaksa di sini: nilai dari request
      // akan menimpa PARAMETER num_predict pada Modelfile, sehingga operator
      // kehilangan kendali. Pakai OLLAMA_MAX_TOKENS bila ingin cap terpusat,
      // atau setel num_predict di Modelfile modelnya.
      ...(provider === 'ollama' && !Number.isFinite(payload.max_tokens) && ollamaMaxTokens ? { max_tokens: ollamaMaxTokens } : {}),
      model,
      stream: Boolean(stream),
    }),
    signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Gagal konek (provider mati, tunnel putus, DNS gagal) atau timeout bukan
    // lagi melempar error ke handler: kembalikan status yang bisa di-fallback
    // (502/504) supaya chat otomatis beralih ke model lain bila diizinkan.
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    const detail = timedOut
      ? `Provider "${provider}" tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik.`
      : `Tidak dapat terhubung ke provider "${provider}": ${String(err?.message || err)}`;
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      errorInfo: parseChatUpstreamError(detail, timedOut ? 504 : 502),
    };
  }
  if (!upstream.ok) {
    const rawText = await upstream.text().catch(() => '');
    const errorInfo = parseChatUpstreamError(rawText, upstream.status, upstream.headers.get('retry-after'), provider);
    return { ok: false, status: upstream.status, errorInfo };
  }
  const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
  if (stream && contentType.includes('text/event-stream') && upstream.body) {
    return { ok: true, status: upstream.status, stream: upstream.body };
  }
  const data = await upstream.json().catch(() => ({}));
  return { ok: true, status: upstream.status, data };
}

// Model self-host (Ollama) berjalan di CPU pengguna sendiri: memuat bobot 3-4 GB
// ke RAM dan menghasilkan token pertama bisa jauh lebih lambat daripada API cloud.
// Timeout 120 detik bawaan terlalu pendek untuk kondisi itu.
function chatUpstreamTimeoutMs(provider, stream = false) {
  if (String(provider || '').trim().toLowerCase() === 'ollama') {
    return stream ? 300_000 : 480_000;
  }
  return 120_000;
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
    // Akun OAuth (Responses API) menaruh ringkasan penalaran di field sendiri.
    const reasoning = String(msg?.reasoning_content || msg?.reasoning || attempt.data?.blea_reasoning || '').trim();
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
  studioTool = '',
  prompt = '',
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
        // Ruang Studio: simpan jawaban ke halaman Hasil & Unduhan.
        if (savedContent && studioTool) {
          await recordStudioText(env, userId, {
            tool: studioTool,
            model: meta.model || '',
            prompt: prompt || '',
            output: savedContent,
            metadata: { provider: meta.provider || '', room: studioTool },
          }).catch(() => null);
        }
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

// Provider yang seluruh modelnya berasal dari SATU pool kredensial. Untuk
// provider seperti ini, "pilih model lain" bukan saran yang berguna: model lain
// memakai akun yang sama, jadi pengguna akan melihat galat yang sama.
const POOLED_CREDENTIAL_PROVIDERS = new Set(['openai']);

function parseChatUpstreamError(rawText, status, retryAfterHeader, provider = '') {
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

  // 429 punya dua arti yang obatnya berbeda jauh:
  //   • batas LAJU (rate_limit_exceeded) → tunggu sebentar;
  //   • kuota/billing habis (insufficient_quota) → isi saldo.
  // Dulu keduanya disatukan sebagai "batas permintaan… pilih model lain",
  // sehingga akun OpenAI yang billing-nya habis tampak seperti masalah ramai.
  const quotaExhausted = /insufficient_quota|billing|exceeded your current quota|credit balance/i.test(`${code} ${message}`);
  const pooled = POOLED_CREDENTIAL_PROVIDERS.has(String(provider || '').toLowerCase());
  let friendlyMessage;
  if (quotaExhausted && (status === 429 || status === 402)) {
    friendlyMessage = pooled
      ? 'Kuota/kredit akun OpenAI di pool habis. Isi saldo di platform.openai.com → Billing, atau tambahkan akun lain lewat Buka Studio → Akun OpenAI.'
      : 'Saldo atau kuota API provider tidak mencukupi untuk model ini.';
  } else if (status === 429 || code === 'rate_limit_exceeded') {
    if (pooled) {
      friendlyMessage = retryAfterSec
        ? `Akun OpenAI kena batas laju permintaan (429). Coba lagi dalam ${retryAfterSec} detik; akun pool dipakai bergiliran.`
        : 'Akun OpenAI kena batas laju permintaan (429). Tunggu sekitar satu menit lalu coba lagi; akun pool dipakai bergiliran.';
    } else {
      friendlyMessage = retryAfterSec
        ? `Batas permintaan model tercapai (429). Coba lagi dalam ${retryAfterSec} detik atau pilih model lain.`
        : 'Batas permintaan model tercapai (429). Silakan tunggu sebentar atau pilih model lain.';
    }
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
    // `rawDetail` ikut membawa kode resmi OpenAI (mis. credit_balance_exhausted)
    // karena `type`-nya sering hanya `insufficient_quota` — tidak cukup untuk
    // membedakan saldo nol dari batas belanja.
    rawDetail: [message, code && !message.includes(code) ? `code: ${code}` : ''].filter(Boolean).join(' ').slice(0, 500),
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
  else if (mime === 'audio/mpeg' || mime === 'audio/mp3') ext = 'mp3';
  else if (mime === 'audio/wav' || mime === 'audio/x-wav') ext = 'wav';
  else if (mime === 'audio/ogg') ext = 'ogg';
  else if (mime === 'audio/mp4' || mime === 'audio/m4a' || mime === 'audio/x-m4a') ext = 'm4a';
  else if (mime === 'audio/aac') ext = 'aac';
  else if (mime === 'audio/flac') ext = 'flac';
  return `${prefix}-${safeId}${suffix}.${ext}`;
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

async function signMusicContentUrl(id, kind, index, env, { download = false, ttlMs = 2 * 60 * 60 * 1000 } = {}) {
  const exp = String(Date.now() + ttlMs);
  const msg = new TextEncoder().encode(`mus:${id}:${kind}:${index}:${exp}`);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', await videoMediaKey(env), msg));
  const sig = base64url(sigBytes);
  return `/api/music/content/${encodeURIComponent(id)}?kind=${encodeURIComponent(kind)}&index=${index}&exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}${download ? '&download=1' : ''}`;
}

async function verifyMusicContentSig(id, kind, index, exp, sig, env) {
  try {
    if (!id || (kind !== 'audio' && kind !== 'cover') || !exp || !sig || !Number.isInteger(index) || index < 0 || index >= 10) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const msg = new TextEncoder().encode(`mus:${id}:${kind}:${index}:${exp}`);
    return await crypto.subtle.verify('HMAC', await videoMediaKey(env), unbase64url(sig), msg);
  } catch {
    return false;
  }
}

async function attachMusicMediaUrls(generation, env) {
  if (!generation || generation.status !== 'completed' || !generation.id) return generation;
  const audioCount = Math.max(0, Number(generation.audio_count || (generation.has_audio ? 1 : 0)));
  const audioStreamUrls = audioCount > 0
    ? await Promise.all(Array.from({ length: Math.min(audioCount, 10) }, (_, idx) => signMusicContentUrl(generation.id, 'audio', idx, env, { download: false })))
    : [];
  const audioDownloadUrls = audioCount > 0
    ? await Promise.all(Array.from({ length: Math.min(audioCount, 10) }, (_, idx) => signMusicContentUrl(generation.id, 'audio', idx, env, { download: true })))
    : [];
  const coverUrl = generation.has_cover
    ? await signMusicContentUrl(generation.id, 'cover', 0, env, { download: false })
    : null;
  const coverDownloadUrl = generation.has_cover
    ? await signMusicContentUrl(generation.id, 'cover', 0, env, { download: true })
    : null;
  return {
    ...generation,
    audio_stream_url: audioStreamUrls[0] || null,
    download_url: audioDownloadUrls[0] || null,
    ...(audioStreamUrls.length > 1 ? { audio_stream_urls: audioStreamUrls, download_urls: audioDownloadUrls } : {}),
    cover_stream_url: coverUrl,
    cover_download_url: coverDownloadUrl,
  };
}

async function attachMusicHistoryMedia(result, env) {
  if (!result || !Array.isArray(result.generations)) return result;
  const generations = await Promise.all(result.generations.map((item) => attachMusicMediaUrls(item, env)));
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
    const res = await fetch(url, { headers: { 'user-agent': UPSTREAM_MEDIA_USER_AGENT }, signal: AbortSignal.timeout(10_000) });
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
  { id: 'wan2.7-image', name: 'Wan 2.7 Image', vendor: 'Alibaba', sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1, promptExtend: false, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 4 },
  { id: 'wan2.7-image-pro', name: 'Wan 2.7 Image Pro', vendor: 'Alibaba', sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1, promptExtend: false, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 4 },
  { id: 'qwen-image-3.0', name: 'Qwen-Image 3.0', vendor: 'Alibaba', sizes: ['1664*928', '1472*1104', '1328*1328', '1104*1472', '928*1664'], defaultSize: '1664*928', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-3.0-pro', name: 'Qwen-Image 3.0 Pro', vendor: 'Alibaba', sizes: ['1664*928', '1472*1104', '1328*1328', '1104*1472', '928*1664'], defaultSize: '1664*928', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  // Famili Qwen-Image-2.0 / 2.1 (sinkron & async messages; n 1-6). Dated variants = snapshot model yang sama.
  { id: 'qwen-image-2.0', name: 'Qwen-Image 2.0', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-2026-03-03', name: 'Qwen-Image 2.0 (2026-03-03)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro', name: 'Qwen-Image 2.0 Pro', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro-2026-03-03', name: 'Qwen-Image 2.0 Pro (2026-03-03)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro-2026-04-22', name: 'Qwen-Image 2.0 Pro (2026-04-22)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.0-pro-2026-06-22', name: 'Qwen-Image 2.0 Pro (2026-06-22)', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.1-pro', name: 'Qwen-Image 2.1 Pro', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  { id: 'qwen-image-2.1-turbo', name: 'Qwen-Image 2.1 Turbo', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '2048*2048', maxN: 6, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 3 },
  // Wan2.6-T2I: messages async; n 1-4; 1280*1280 s/d 1440*1440.
  { id: 'wan2.6-t2i', name: 'Wan 2.6 T2I', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 1280, maxSide: 1440, defaultSize: '1280*1280', maxN: 4, promptExtend: true, payloadMode: 'messages', maxPromptChars: 2000, maxInputImages: 0 },
  // Wan 2.5 & lebih lama (text-to-image V2): HTTP async LEGACY —
  // POST /api/v1/services/aigc/text2image/image-synthesis, input.prompt STRING,
  // hasil output.results[].url. Ukuran wan2.5: total piksel 1280^2–1440^2, rasio [1:4, 4:1].
  { id: 'wan2.5-t2i-preview', name: 'Wan 2.5 T2I Preview', vendor: 'Alibaba', sizeMode: 'wxh', minProduct: 1280 * 1280, maxProduct: 1440 * 1440, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 2000, sizeHint: 'total 1280*1280–1440*1440 piksel, rasio 1:4–4:1', maxInputImages: 0 },
  // Wan 2.2: total piksel maks 1440*1440, sisi 512–1440, prompt 500 karakter.
  { id: 'wan2.2-t2i-plus', name: 'Wan 2.2 T2I Plus', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  { id: 'wan2.2-t2i-flash', name: 'Wan 2.2 T2I Flash', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  // Wan 2.1: Singapore menggunakan wan2.1-t2i-*; Beijing menggunakan wanx2.1-t2i-*.
  { id: 'wan2.1-t2i-plus', cnId: 'wanx2.1-t2i-plus', name: 'Wan 2.1 T2I Plus', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  { id: 'wan2.1-t2i-turbo', cnId: 'wanx2.1-t2i-turbo', name: 'Wan 2.1 T2I Turbo', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 1440, maxProduct: 1440 * 1440, defaultSize: '1024*1024', maxN: 4, promptExtend: true, payloadMode: 'legacy', maxPromptChars: 500, sizeHint: 'sisi 512–1440 piksel, total maks 1440*1440', maxInputImages: 0 },
  // Wan2.6-Image: async messages (image-generation).
  // Tanpa gambar input: interleaved mode (enable_interleave=true, n=1, max_images 1-5, total 768^2–1280^2).
  // Dengan 1-4 gambar input: edit mode (enable_interleave=false, n 1-4, prompt_extend=true, size 1K/2K atau 768^2–2048^2).
  { id: 'wan2.6-image', name: 'Wan 2.6 Image', vendor: 'Alibaba', sizeMode: 'wxh', minProduct: 768 * 768, maxProduct: 1280 * 1280, editMaxProduct: 2048 * 2048, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 5, promptExtend: false, payloadMode: 'interleave', maxPromptChars: 2000, maxInputImages: 4, sizeHint: 'total 768*768–1280*1280 piksel (edit s/d 2048*2048 atau 1K/2K), rasio 1:4–4:1' },
  // Wan2.5-I2I-Preview: editing only (1-4 gambar sumber wajib), async image2image/image-synthesis,
  // total piksel 768^2–1280^2, rasio [1:4, 4:1], n 1-4.
  { id: 'wan2.5-i2i-preview', name: 'Wan 2.5 I2I Preview (Edit Gambar)', vendor: 'Alibaba', sizeMode: 'wxh', minProduct: 768 * 768, maxProduct: 1280 * 1280, minRatio: 0.25, maxRatio: 4, defaultSize: '1280*1280', maxN: 4, promptExtend: true, payloadMode: 'legacy-i2i', maxPromptChars: 2000, maxInputImages: 4, requiresImageInput: true, sizeHint: 'wajib 1–4 gambar sumber · total 768*768–1280*1280 piksel, rasio 1:4–4:1' },
  // Z-Image-Turbo: SYNC (multimodal-generation), messages, prompt_extend default false,
  // prompt maks 800 karakter, n tetap 1; ukuran sisi 512–2048; hasil di output.choices[0].message.content[0].image.
  { id: 'z-image-turbo', name: 'Z-Image Turbo', vendor: 'Alibaba', sizeMode: 'wxh', minSide: 512, maxSide: 2048, defaultSize: '1024*1024', maxN: 1, promptExtend: false, payloadMode: 'zimage', maxPromptChars: 800, sizeHint: 'sisi 512–2048 piksel', maxInputImages: 0 },
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
        await patchImageGeneration(env, rowId, patch);
        return { status: 'completed', credits: price, mode: genMode, generation: sanitizeImageRow({ ...inserted[0], ...patch }) };
      }
      if (!taskId) {
        uncertain += 1;
        await patchImageGeneration(env, rowId, {
          status: 'unknown',
          error_message: req.isSync ? 'Respons provider tidak berisi URL gambar maupun task_id; kredit mungkin terpakai. Jangan ulangi.' : 'Respons provider tidak berisi task_id; kredit mungkin terpakai. Jangan ulangi.',
          updated_at: new Date().toISOString(),
        });
        return { status: 'unknown', credits: price, mode: genMode, generation: sanitizeImageRow({ ...inserted[0], status: 'unknown' }) };
      }
      await markPoolKeyResult(env, cand, { success: true });
      const patch = { external_job_id: taskId, status: 'processing', provider_key_id: cand.id || null, metadata: { ...baseMetadata, base_url: base }, updated_at: new Date().toISOString() };
      await patchImageGeneration(env, rowId, patch);
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

async function patchImageGeneration(env, rowId, patch) {
  return patchImageGenerationRow(env, rowId, patch, (p, opts) => servicePostgrest(env, p, opts));
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
  } else if (raw === 'CANCELED' || raw === 'CANCELLED') {
    patch = { status: 'cancelled', error_message: 'Provider membatalkan generasi gambar.', updated_at: new Date().toISOString() };
  } else if (raw === 'FAILED' || raw === 'UNKNOWN') {
    const detail = redactUpstreamDetail(extractUpstreamError(pollData));
    patch = { status: 'failed', error_message: detail ? `Provider melaporkan generasi gagal: ${detail}` : 'Provider melaporkan generasi gagal.', updated_at: new Date().toISOString() };
  } else {
    patch = { status: 'processing', updated_at: new Date().toISOString() };
  }
  await patchImageGeneration(env, row.id, patch);
  const ownerId = row.user_id || user?.id;
  if (['failed', 'cancelled'].includes(patch.status) && ownerId && Number(row.credits_charged) > 0 && Number(row.credits_refunded || 0) === 0) {
    const refundDesc = patch.status === 'cancelled' ? 'Refund: generasi gambar dibatalkan provider' : 'Refund: generasi gambar gagal';
    const refunded = await refundImageCredits(env, ownerId, Number(row.credits_charged), row.id, refundDesc);
    if (refunded) {
      row.credits_refunded = Number(row.credits_charged);
      await patchImageGeneration(env, row.id, { credits_refunded: Number(row.credits_charged), updated_at: new Date().toISOString() });
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

    // Gerbang isolasi tool: hanya berlaku bila klien menyatakan ruang Studio-nya.
    // Tanpa header (jalur lama, /generate, /history) semuanya tetap berjalan
    // seperti sebelumnya.
    const toolViolation = studioToolGuard(request, path);
    if (toolViolation) return toolViolation;

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

    // ---- /openai-signup: "Daftar akun OpenAI pakai email TempMail" (admin) ----
    //
    // Sengaja TIDAK mem-POST formulir dari server: Workerd diblokir ke domain
    // OpenAI dan pendaftaran otomatis melanggar ToS. Rute ini menyiapkan URL
    // login resmi platform.openai.com, mencatat langkah manual, dan
    // mencocokkan email verifikasi di inbox TempMail. Detail: openaiSignup.js
    // ---- /openai-signup/userscript: unduh userscript pengisi email ----
    // Tampermonkey memasang langsung dari URL ini; pengguna tidak perlu
    // menyalin-tempel skrip (itu titik gagal yang membuat panel terasa rusak).
    if (path === 'openai-signup/userscript' && method === 'GET') {
      if (!sameOrigin(request, url)) return jsonResponse({ error: 'Origin tidak diizinkan' }, 403);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401, { 'cache-control': 'no-store' });
      if (user.app_metadata?.role !== 'admin') return jsonResponse({ error: 'Pemasangan userscript hanya untuk admin.' }, 403, { 'cache-control': 'no-store' });
      const aliasRes = await servicePostgrest(env, `/tempmail_user_aliases?select=email&user_id=eq.${encodeURIComponent(user.id)}&limit=1`).catch(() => null);
      const alias = aliasRes?.ok ? (await aliasRes.json().catch(() => []))?.[0] : null;
      const email = String(url.searchParams.get('email') || alias?.email || '').trim();
      try {
        return buildUserscriptResponse(email, url.origin);
      } catch (error) {
        return jsonResponse({ error: error?.message || 'Userscript tidak bisa dibuat.' }, Number(error?.status) || 400);
      }
    }

    if (path === 'openai-signup') {
      if (!sameOrigin(request, url)) return jsonResponse({ error: 'Origin tidak diizinkan' }, 403);
      if (!['GET', 'POST'].includes(method)) return jsonResponse({ error: 'Method tidak diizinkan.' }, 405);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      const result = await handleOpenAiSignup(request, env, user, {
        listInbox: user ? await tempmailInboxReader(env, user).catch(() => null) : null,
        readMessage: user ? await tempmailMessageReader(env, user).catch(() => null) : null,
      });
      return jsonResponse(result.body, result.status, { 'cache-control': 'no-store' });
    }

    // ---- POST /api/media/resolve: tautan Facebook/TikTok -> link siap pakai ----
    // (dipakai field URL audio/video di /generate: getmyfb.com / ssstik.io scraping).
    if (path === 'media/resolve' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      try {
        return jsonResponse(await handleMediaResolve(request, env, user));
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Gagal memproses tautan' }, err?.status || 502);
      }
    }

    // ---- GET/HEAD /api/media/proxy: stream media Facebook/TikTok yang sudah di-resolve ----
    // (bertanda tangan, bukan bearer, supaya elemen <video>/<audio> native bisa memuatnya).
    if (path === 'media/proxy' && (method === 'GET' || method === 'HEAD')) {
      return handleMediaProxy(request, url, env);
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

      const upstreamHeaders = { 'user-agent': UPSTREAM_MEDIA_USER_AGENT, accept: 'video/*,*/*;q=0.8' };
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
          headers: { 'user-agent': UPSTREAM_MEDIA_USER_AGENT, accept: 'image/*' },
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

    // ---- GET/HEAD /api/music/content/:id: signed or authorized audio/cover stream proxy ----
    if (path.startsWith('music/content/') && (method === 'GET' || method === 'HEAD')) {
      const id = decodeURIComponent(path.slice('music/content/'.length));
      if (!id) return jsonResponse({ error: 'Missing generation id' }, 400);

      const rawKind = (url.searchParams.get('kind') || 'audio').trim().toLowerCase();
      const kind = rawKind === 'cover' ? 'cover' : (rawKind === 'audio' ? 'audio' : null);
      if (!kind) return jsonResponse({ error: 'Invalid media kind' }, 400);

      const rawIndex = url.searchParams.get('index');
      const index = rawIndex === null || rawIndex === '' ? 0 : Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= 10) {
        return jsonResponse({ error: 'Invalid media index' }, 400);
      }

      const exp = url.searchParams.get('exp');
      const sig = url.searchParams.get('sig');
      const sigOk = await verifyMusicContentSig(id, kind, index, exp, sig, env);
      let user = null;
      if (!sigOk) {
        const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        user = bearer ? await getUser(env, bearer) : null;
        if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
      }

      const rowRes = await servicePostgrest(
        env,
        `/music_generations?select=id,user_id,audio_url,cover_url,external_job_id,metadata,status&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      const rows = await rowRes.json().catch(() => []);
      const row = rows?.[0];
      if (!row) return jsonResponse({ error: 'Music not found' }, 404);
      if (!sigOk && row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
        return jsonResponse({ error: 'Forbidden' }, 403);
      }

      const resolveMusicTarget = (srcRow) => {
        if (kind === 'cover') return typeof srcRow?.cover_url === 'string' && srcRow.cover_url.trim() ? srcRow.cover_url.trim() : null;
        const candidates = [];
        for (const cand of [srcRow?.audio_url, ...(Array.isArray(srcRow?.metadata?.audios) ? srcRow.metadata.audios : [])]) {
          if (typeof cand !== 'string') continue;
          const trimmed = cand.trim();
          if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
        }
        return candidates[index] || null;
      };

      let targetUrl = resolveMusicTarget(row);
      if (!targetUrl && row.external_job_id) {
        const refreshed = await refreshMusicRowUrls(env, row).catch(() => null);
        if (refreshed) targetUrl = resolveMusicTarget({ ...row, ...refreshed });
      }
      if (!targetUrl) return jsonResponse({ error: 'Music content URL unavailable' }, 404);

      const wantDownload = url.searchParams.get('download') === '1';
      const range = request.headers.get('range');
      const fetchSafeUpstream = async (startUrl) => {
        if (!isSafeRemoteMediaUrl(startUrl)) return { rejected: true, status: 400 };
        let currentUrl = startUrl;
        let res = null;
        for (let hop = 0; hop <= 3; hop += 1) {
          res = await fetch(currentUrl, {
            method,
            headers: {
              'user-agent': UPSTREAM_MEDIA_USER_AGENT,
              accept: kind === 'cover' ? 'image/*' : 'audio/*,*/*;q=0.8',
              ...(range && !wantDownload && kind === 'audio' ? { range } : {}),
            },
            redirect: 'manual',
            signal: AbortSignal.timeout(45_000),
          });
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get('location');
            if (!location || hop === 3) return { res, finalUrl: currentUrl, redirectFailed: true };
            const resolved = new URL(location, currentUrl).toString();
            if (!isSafeRemoteMediaUrl(resolved)) return { rejected: true, status: 400 };
            currentUrl = resolved;
            continue;
          }
          break;
        }
        return { res, finalUrl: currentUrl };
      };

      let fetched = await fetchSafeUpstream(targetUrl);
      if (!fetched.rejected && fetched.res && [403, 404, 410].includes(fetched.res.status) && row.external_job_id) {
        const refreshed = await refreshMusicRowUrls(env, row).catch(() => null);
        const refreshedUrl = refreshed ? resolveMusicTarget({ ...row, ...refreshed }) : null;
        if (refreshedUrl && refreshedUrl !== targetUrl) {
          targetUrl = refreshedUrl;
          fetched = await fetchSafeUpstream(refreshedUrl);
        }
      }
      if (fetched.rejected) {
        return jsonResponse({ error: 'Music content URL rejected' }, 400);
      }
      const upstream = fetched.res;
      if (fetched.redirectFailed || !upstream || (!upstream.ok && upstream.status !== 206)) {
        const text = upstream ? await upstream.text().catch(() => '') : '';
        return jsonResponse({ error: 'Failed to stream upstream music media', status: upstream?.status || 502, detail: text.slice(0, 300) }, 502);
      }

      const rawType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (kind === 'cover' && rawType === 'image/svg+xml') {
        return jsonResponse({ error: 'Unsupported cover content type' }, 502);
      }
      let contentType = rawType;
      if (!contentType || contentType === 'application/octet-stream') {
        const pathLower = new URL(fetched.finalUrl || targetUrl).pathname.toLowerCase();
        if (kind === 'cover') {
          contentType = pathLower.endsWith('.png') ? 'image/png' : pathLower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        } else {
          contentType = pathLower.endsWith('.wav') ? 'audio/wav' : pathLower.endsWith('.ogg') ? 'audio/ogg' : pathLower.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg';
        }
      }

      const respHeaders = new Headers();
      for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) respHeaders.set(h, v);
      }
      respHeaders.set('content-type', contentType);
      respHeaders.set('cache-control', 'private, no-store');
      respHeaders.set('x-content-type-options', 'nosniff');
      if (wantDownload) {
        respHeaders.set(
          'content-disposition',
          `attachment; filename="${contentAttachmentFilename(kind === 'cover' ? 'blea-cover' : 'blea-music', id, contentType, kind === 'cover' ? 'jpg' : 'mp3')}"`,
        );
      }
      return new Response(method === 'HEAD' ? null : upstream.body, {
        status: upstream.status,
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
      // OpenAI memakai pool akun (Studio → Akun OpenAI). Tanpa ini, halaman
      // status/chat menganggap OpenAI belum terhubung walau poolnya siap.
      const openAiPool = await openAiPoolSummary(env).catch(() => null);
      if (openAiPool?.usable > 0) configuredSet.add('openai');
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

    // ---- /studio/image|video: generasi media lewat pool akun OpenAI ----
    //
    // Tidak memotong kredit BLEA: yang berbayar adalah akun OpenAI milik admin,
    // dan yang dibatasi adalah kuota harian per akun (lihat openaiPool.js).
    if ((path === 'studio/image/config' || path === 'studio/video/config') && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      const kind = path.startsWith('studio/video') ? 'video' : 'image';
      return jsonResponse({ ok: true, ...(await studioMediaConfig(env, kind)) });
    }

    if (path === 'studio/image/generate' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      try {
        const body = await request.json().catch(() => ({}));
        return jsonResponse({ ok: true, ...(await generateStudioImage(env, user, body)) });
      } catch (error) {
        return jsonResponse({ error: error?.message || 'Generasi gambar gagal.' }, error?.status || 502);
      }
    }

    if (path === 'studio/video/generate' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      try {
        const body = await request.json().catch(() => ({}));
        return jsonResponse({ ok: true, ...(await generateStudioVideo(env, user, body)) });
      } catch (error) {
        return jsonResponse({ error: error?.message || 'Generasi video gagal.' }, error?.status || 502);
      }
    }

    if (path === 'studio/video/status' && (method === 'POST' || method === 'GET')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const id = String(body.id || url.searchParams.get('id') || '');
      try {
        return jsonResponse({ ok: true, ...(await studioVideoStatus(env, user, id)) });
      } catch (error) {
        return jsonResponse({ error: error?.message || 'Status video tidak tersedia.' }, error?.status || 500);
      }
    }

    // ---- /studio/models: model OpenAI untuk Studio ----
    //
    // Sengaja TERPISAH dari /api/enabled-models. Studio memakai model OpenAI
    // (pool akun manual di /studio/openai-accounts), bukan katalog provider
    // yang terdaftar di Admin Panel. `ready` hanya true bila ada minimal satu
    // akun API key yang siap, supaya UI bisa jujur soal keadaan koneksi.
    if ((path === 'studio/models' || path === 'studio/ping') && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401, { 'cache-control': 'no-store' });
      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const capability = String(body.capability || url.searchParams.get('capability') || 'chat').toLowerCase();
      const summary = await openAiPoolSummary(env);
      const ready = summary.usable > 0;
      const models = studioModelItems([capability, 'chat'], env);
      // Saat pool tidak siap, sebut SEBABNYA (kredit habis, kunci ditolak,
      // cooldown) — bukan "belum ada akun", karena akunnya jelas ada.
      const blocked = ready ? null : await openAiPoolBlockedMessage(env, capability).catch(() => null);
      const payload = {
        ok: true,
        ready,
        provider: 'openai',
        capability,
        models,
        modelItems: models,
        pool: summary,
        source: 'pool akun OpenAI: OAuth Connect OpenAI + API key (/studio/openai-accounts)',
        ...(ready ? {} : {
          code: blocked?.code || 'openai_pool_empty',
          hint: blocked?.error
            || 'Belum ada akun OpenAI yang siap. Buka Studio → Akun OpenAI lalu tambahkan akun atau tekan “Connect OpenAI”.',
        }),
      };
      if (path === 'studio/ping') {
        // Ping ringan: panggil endpoint resmi termurah (/v1/models) memakai akun
        // pertama yang siap, tanpa menaikkan kuota harian akun.
        const picked = await pickOpenAiAccountsFor(env, { capability: 'chat', limit: 1 });
        if (!picked.length) return jsonResponse({ ...payload, ok: false, ping: { ok: false, message: 'Tidak ada akun pool yang siap dipakai.' } });
        const account = picked[0];
        let ping;
        try {
          const res = await fetch(`${account.apiBase}/v1/models`, {
            method: 'GET',
            headers: { authorization: `Bearer ${account.apiKey}`, accept: 'application/json' },
            signal: AbortSignal.timeout(12_000),
          });
          await res.body?.cancel?.().catch?.(() => {});
          ping = {
            ok: res.ok,
            status: res.status,
            account: account.accountLabel || account.accountEmail || account.id.slice(0, 8),
            message: res.ok ? 'Model OpenAI bisa dihubungi.' : `API menolak kunci (HTTP ${res.status}).`,
          };
        } catch (error) {
          ping = { ok: false, status: 0, account: account.accountLabel || '', message: String(error?.message || error).slice(0, 200) };
        }
        return jsonResponse({ ...payload, ok: ping.ok, ping }, ping.ok ? 200 : 502);
      }
      return jsonResponse(payload);
    }

    // ---- /models & /enabled-models: active models for Chat AI ----
    if ((path === 'models' || path === 'enabled-models') && (method === 'GET' || method === 'POST')) {
      const res = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc');
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      const priceRes = await servicePostgrest(
        env,
        '/credit_model_prices?select=provider,model,modality&active=eq.true&limit=1000',
      ).catch(() => null);
      const priceRows = priceRes?.ok ? await priceRes.json().catch(() => []) : [];
      const pricedNonChat = collectPricedNonChatModels(priceRows);
      let chatRows = (rows ?? []).filter((m) => {
        const provider = String(m?.provider || 'unorouter').toLowerCase().trim();
        if (NON_CHAT_PROVIDERS.has(provider)) return false;
        if (provider === 'alibaba' && !isAlibabaChatCatalogModel(m.model)) return false;
        if (!isChatCapableModelId(m.model)) return false;
        return !pricedNonChat.has(`${provider}::${String(m.model || '').trim()}`);
      });
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
            name: m.name || m.id,
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
          name: m.name || m.id,
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
            name: m.name || m.id,
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

      if (provider === 'freebeat') {
        const models = await fetchFreebeatCatalogModels(env).catch(() => []);
        const [pmRes, priceRes] = await Promise.all([
          servicePostgrest(env, '/provider_models?select=model,active&provider=eq.freebeat&limit=200').catch(() => null),
          servicePostgrest(env, '/credit_model_prices?select=model,modality&provider=eq.freebeat&limit=200').catch(() => null),
        ]);
        const pmRows = pmRes?.ok ? await pmRes.json().catch(() => []) : [];
        const priceRows = priceRes?.ok ? await priceRes.json().catch(() => []) : [];
        const byId = new Map(models.map((m) => [String(m.id), m]));
        for (const r of [...(Array.isArray(pmRows) ? pmRows : []), ...(Array.isArray(priceRows) ? priceRows : [])]) {
          const id = String(r?.model || '').trim();
          if (!id || byId.has(id)) continue;
          const cat = r?.modality === 'video' || /video/i.test(id) ? 'Video' : r?.modality === 'music' ? 'Music' : 'Image';
          const entry = {
            id,
            name: id,
            provider: 'freebeat',
            category: cat,
            tags: [cat, 'Freebeat'],
            description: `Model Freebeat ${id}`,
            isFree: false,
            online: true,
            priceLabel: 'Kredit BLEA',
          };
          byId.set(id, entry);
          models.push(entry);
        }
        return jsonResponse({ models });
      }

      if (provider !== 'unorouter') {
        const builtinForProvider = [
          ...BUILTIN_VIDEO_MODELS
            .filter((m) => m.provider === provider)
            .map((m) => ({
              id: m.id,
              name: m.name || m.id,
              provider,
              category: 'Video',
              blea: 'video',
              tags: ['Video', PROVIDER_PRESETS[provider]?.label || provider.toUpperCase()],
              description: m.description || m.name || '',
              isFree: Boolean(m.isFree),
              online: true,
              priceLabel: m.priceLabel || 'Video',
            })),
          ...(BUILTIN_CATALOG_PROVIDER_MODELS[provider] || []).map((m) => ({
            id: m.id,
            name: m.name || m.id,
            provider,
            category: m.category || 'Text',
            tags: [m.category || 'Text', PROVIDER_PRESETS[provider]?.label || provider.toUpperCase()],
            description: m.description || m.name || '',
            isFree: Boolean(m.isFree),
            online: true,
            priceLabel: m.priceLabel || 'API',
          })),
        ];
        let upstreamModels = [];
        let upstreamError = '';
        let upstreamStatus = 502;
        try {
          const [keyRow, poolRes] = await Promise.all([
            fetchProviderKeyRecord(env, provider).catch(() => null),
            servicePostgrest(env, `/provider_key_pool?select=api_key,base_url&provider=eq.${encodeURIComponent(provider)}&enabled=eq.true&order=priority.asc&limit=1`).catch(() => null),
          ]);
          const poolRows = poolRes?.ok ? await poolRes.json().catch(() => []) : [];
          // Provider `openai` menyimpan kredensial di POOL akun (Studio → Akun
          // OpenAI), bukan di provider_api_keys. Tanpa cabang ini, "Muat daftar
          // model" hanya menampilkan daftar bawaan walau akunnya ada.
          const accountRow = provider === 'openai' && !keyRow?.api_key
            ? (await pickOpenAiAccountsFor(env, { capability: 'chat', limit: 1 }).catch(() => []))[0]
            : null;
          const activeKey = keyRow?.api_key || poolRows?.[0]?.api_key || accountRow?.apiKey || '';
          const rawBase = body.baseUrl || keyRow?.base_url || poolRows?.[0]?.base_url || (accountRow ? `${accountRow.apiBase}/v1` : '');
          const apiBase = resolveProviderApiBase(provider, rawBase);
          if (apiBase) {
            const headers = activeKey ? { authorization: `Bearer ${activeKey}` } : {};
            const upstream = await fetch(`${apiBase}/models`, {
              headers,
              signal: AbortSignal.timeout(20_000),
            });
            if (upstream.ok) {
              const payload = await upstream.json().catch(() => ({}));
              const rawList = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload?.models) ? payload.models : []);
              upstreamModels = rawList
                .map((item) => {
                  const id = typeof item === 'string' ? item : (item?.id || item?.model || '');
                  if (!id) return null;
                  const isVid = isVideoModelId(id);
                  const isSpeech = /tts|whisper|speech|audio/i.test(id);
                  const isEmb = /embedding|embed/i.test(id);
                  const isImg = /dall-e|imagen|flux|image/i.test(id);
                  const category = isVid ? 'Video' : (isSpeech ? 'Speech' : (isEmb ? 'Embedding' : (isImg ? 'Image' : 'Text')));
                  return {
                    id,
                    name: item?.name || id,
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
            } else {
              upstreamStatus = upstream.status;
              upstreamError = `Catalog ${provider} gagal dimuat (HTTP ${upstream.status}).`;
            }
          } else if (!builtinForProvider.length) {
            upstreamError = `Base URL untuk provider "${provider}" belum valid.`;
          }
        } catch (e) {
          upstreamError = String(e);
        }
        const mergedMap = new Map();
        for (const m of [...builtinForProvider, ...upstreamModels]) {
          if (!mergedMap.has(m.id)) mergedMap.set(m.id, m);
        }
        const models = Array.from(mergedMap.values());
        if (!models.length && upstreamError) {
          return jsonResponse({ error: upstreamError, status: upstreamStatus }, 502);
        }
        return jsonResponse({ models, ...(upstreamError ? { warning: upstreamError } : {}) });
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

    // ---- /openai-oauth: "Connect OpenAI" (TANPA API key) ----
    //
    // Alur resmi Sign in with OpenAI. OAuth diselesaikan di browser pengguna
    // (redirect_uri wajib http://127.0.0.1:<port>/auth/callback, PKCE, tanpa
    // client secret), lalu tokennya dikirim sekali ke sini untuk disegel dan
    // didaftarkan ke pool. Browser tidak pernah menyimpan token; yang hidup di
    // klien hanya `state`, `nonce`, dan `code_verifier` sementara.
    if (path === 'openai-oauth' || path.startsWith('openai-oauth/')) {
      if (!sameOrigin(request, url)) return jsonResponse({ error: 'Origin tidak diizinkan' }, 403);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) {
        // 401 di sini SELALU soal sesi BLEA, bukan OpenAI — tetapi pesan lama
        // ("Login diperlukan.") dibaca pengguna sebagai "OpenAI menolak".
        // Dua keadaan dibedakan supaya tidak ada yang menebak: token tidak
        // terkirim (halaman belum/login kedaluwarsa di perangkat ini), atau
        // token terkirim tetapi tidak diterima Supabase.
        return jsonResponse({
          error: token
            ? 'Sesi BLEA tidak diterima server (token kedaluwarsa atau akun tidak aktif). Muat ulang halaman; bila tetap, keluar lalu masuk lagi. Ini belum menyentuh OpenAI sama sekali.'
            : 'Permintaan tidak membawa token sesi BLEA. Halaman ini belum login (atau sesinya baru kedaluwarsa) — masuk dulu, lalu tekan tombol Connect lagi.',
          code: 'auth_required',
        }, 401, { 'cache-control': 'no-store' });
      }
      const action = path.slice('openai-oauth'.length).replace(/^\//, '');
      try {
        if (!action && method === 'GET') {
          return jsonResponse({
            ok: true,
            enabled: true,
            links: await listOAuthLinks(env, user),
            // Id terbitan yang harus dipakai pada login berikutnya (kalau ada).
            retained_client: await retainedClientId(env, user),
            config: {
              authorize_endpoint: 'https://auth.openai.com/api/accounts/authorize',
              token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
              scopes: OPENAI_SCOPES,
              resource: OPENAI_RESOURCE,
              callback_path: OPENAI_LOOPBACK_PATH,
              client_id_first_time: OPENAI_DYNAMIC_CLIENT_ID,
              agent_name_hint: OPENAI_AGENT_NAME_HINT,
              note: 'Tanpa API key. Kuota mengikuti paket OpenAI pemilik akun; hanya untuk chat & agen (Responses API teks).',
            },
          }, 200, { 'cache-control': 'no-store' });
        }
        if (action === 'start' && method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse({ ok: true, ...(await createOAuthAttempt(env, user, body)) }, 201, { 'cache-control': 'no-store' });
        }
        if (action === 'complete' && method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse({ ok: true, ...(await completeOAuthAttempt(env, user, body)) }, 200, { 'cache-control': 'no-store' });
        }
        if (action === 'refresh' && method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse({ ok: true, ...(await refreshOAuthLink(env, String(body.id || ''))) }, 200, { 'cache-control': 'no-store' });
        }
        if (action === 'disconnect' && method === 'POST') {
          const body = await request.json().catch(() => ({}));
          return jsonResponse({ ok: true, ...(await disconnectOAuthLink(env, user, String(body.id || ''))) }, 200, { 'cache-control': 'no-store' });
        }
        return jsonResponse({ error: 'Aksi OAuth OpenAI tidak dikenal.' }, 404);
      } catch (error) {
        return jsonResponse({ error: error?.message || 'Alur Connect OpenAI gagal.' }, error?.status || 500, { 'cache-control': 'no-store' });
      }
    }

    // ---- /openai-accounts: pool akun OpenAI manual (admin) ----
    //
    // Sama seperti pool freebeat: kredensial hanya ada di server, browser cuma
    // menerima sidik jari (token_hint). Semua aksi di sini wajib admin.
    if (path === 'openai-accounts' || path.startsWith('openai-accounts/')) {
      if (!sameOrigin(request, url)) return jsonResponse({ error: 'Origin tidak diizinkan' }, 403);
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const admin = token ? await isAdmin(env, token) : false;
      if (!admin) return jsonResponse({ error: 'Pool akun OpenAI hanya untuk admin.' }, 403, { 'cache-control': 'no-store' });
      const action = path.slice('openai-accounts'.length).replace(/^\//, '');
      try {
        if (!action && method === 'GET') {
          return jsonResponse({
            ok: true,
            accounts: await listOpenAiAccounts(env),
            capabilities: OPENAI_CAPABILITIES,
            policy: {
              order: 'prioritas naik → paling sedikit dipakai hari ini → paling lama dibuat',
              quotaReset: 'tenggat harian dihitung pada tanggal Asia/Jakarta',
              cooldown: '401/402/403/429 → cooldown 10–60 menit lalu lanjut akun berikutnya',
            },
          });
        }
        if (!action && method === 'POST') {
          const token2 = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
          let userId = null;
          try {
            const caller = token2 ? await getUser(env, token2) : null;
            userId = caller?.id ?? null;
          } catch { userId = null; }
          const body = await request.json().catch(() => null);
          return jsonResponse({ ok: true, account: await createOpenAiAccount(env, body, userId) }, 201);
        }
        if (!action && method === 'PATCH') {
          const body = await request.json().catch(() => null);
          return jsonResponse({ ok: true, account: await updateOpenAiAccount(env, body) });
        }
        if (!action && method === 'DELETE') {
          const body = await request.json().catch(() => null);
          if (!body || typeof body !== 'object' || Object.keys(body).some((key) => key !== 'id')) {
            return jsonResponse({ error: 'Hanya parameter id yang diterima.' }, 400);
          }
          return jsonResponse(await deleteOpenAiAccount(env, body.id));
        }
        if (action === 'test' && method === 'POST') {
          const body = await request.json().catch(() => null);
          const result = await testOpenAiAccount(env, body?.id);
          return jsonResponse({ ok: true, result });
        }
        if (action === 'summary' && (method === 'GET' || method === 'POST')) {
          return jsonResponse({ ok: true, ...(await openAiPoolSummary(env)) });
        }
        return jsonResponse({ error: 'Aksi pool akun OpenAI tidak dikenal.' }, 404);
      } catch (error) {
        return jsonResponse({ error: error?.message || 'Pool akun OpenAI gagal diproses.' }, error?.status || 500);
      }
    }

    // ---- /admin-models: full model list & registered providers (admin) ----
    if (path === 'admin-models' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      if (!(await isAdmin(env, token))) return jsonResponse({ error: 'admin required' }, 403);
      const [res, keysRes, poolRes, fbAccRes, fbSessRes, priceProvRes, oaRes] = await Promise.all([
        servicePostgrest(env, '/provider_models?select=provider,model,active&order=created_at.desc&limit=500'),
        servicePostgrest(env, '/provider_api_keys?select=provider,label,base_url,api_key&order=provider').catch(() => null),
        servicePostgrest(env, '/provider_key_pool?select=provider,enabled&limit=200').catch(() => null),
        servicePostgrest(env, '/freebeat_oauth_accounts?select=id,enabled&limit=10').catch(() => null),
        servicePostgrest(env, '/freebeat_provider_sessions?select=user_id&limit=1').catch(() => null),
        servicePostgrest(env, '/credit_model_prices?select=provider&limit=500').catch(() => null),
        // Pool akun OpenAI = kredensial provider `openai`, yang tidak pernah
        // ditulis ke provider_api_keys.
        servicePostgrest(env, '/openai_accounts?select=id,enabled&limit=200').catch(() => null),
      ]);
      // Pool akun OpenAI (Studio → Akun OpenAI) adalah kredensial provider
      // `openai`. Tanpa baris di provider_api_keys, provider ini dulu tidak
      // pernah muncul di pemilih katalog Admin — padahal akunnya ada.
      const openAiPoolRows = oaRes?.ok ? await oaRes.json().catch(() => []) : [];
      if (!res.ok) return jsonResponse({ error: 'DB read failed', status: res.status }, 500);
      const rows = await res.json().catch(() => []);
      const models = (rows ?? []).map((m) => ({ id: m.model, active: m.active, provider: m.provider }));

      const providerMap = new Map();
      const upsertProv = (idRaw, labelRaw, source) => {
        const id = String(idRaw || '').trim().toLowerCase();
        if (!id) return;
        const defaultLabel = id === 'freebeat'
          ? 'Freebeat (OAuth)'
          : (PROVIDER_PRESETS[id]?.label || id);
        const existing = providerMap.get(id);
        providerMap.set(id, {
          provider: id,
          label: existing?.label || String(labelRaw || '').trim() || defaultLabel,
          sources: [...new Set([...(existing?.sources || []), source])],
        });
      };

      const keyRows = keysRes?.ok ? await keysRes.json().catch(() => []) : [];
      for (const row of Array.isArray(keyRows) ? keyRows : []) {
        upsertProv(row.provider, row.label, 'api_key');
      }
      const poolRows = poolRes?.ok ? await poolRes.json().catch(() => []) : [];
      for (const row of Array.isArray(poolRows) ? poolRows : []) {
        upsertProv(row.provider, '', 'key_pool');
      }
      if (Array.isArray(openAiPoolRows) && openAiPoolRows.length) {
        upsertProv('openai', PROVIDER_PRESETS.openai?.label || 'OpenAI', 'pool');
      }
      const fbAccRows = fbAccRes?.ok ? await fbAccRes.json().catch(() => []) : [];
      const fbSessRows = fbSessRes?.ok ? await fbSessRes.json().catch(() => []) : [];
      if ((Array.isArray(fbAccRows) && fbAccRows.length > 0) || (Array.isArray(fbSessRows) && fbSessRows.length > 0)) {
        upsertProv('freebeat', 'Freebeat (OAuth)', 'oauth');
      }
      for (const row of Array.isArray(rows) ? rows : []) {
        upsertProv(row.provider, '', 'models');
      }
      const priceRows = priceProvRes?.ok ? await priceProvRes.json().catch(() => []) : [];
      for (const row of Array.isArray(priceRows) ? priceRows : []) {
        upsertProv(row.provider, '', 'prices');
      }

      return jsonResponse({ models, providers: Array.from(providerMap.values()) });
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
            name: `Model ${config?.model_id ?? '—'}`,
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
        return jsonResponse({
          error: err?.message || 'Generasi gambar gagal',
          ...(err?.code ? { code: err.code } : {}),
        }, err?.status || 500);
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

    // ---- /music/*: generate musik Freebeat untuk semua user (kredit BLEA) ----
    if (path === 'music/config' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        const config = await consumerMusicConfig(env);
        const isCallerAdmin = user?.app_metadata?.role === 'admin';
        return jsonResponse({
          ok: true,
          provider_ready: config.provider_ready,
          models: config.models,
          ceiling: config.ceiling,
          min_margin: config.min_margin,
          ...(isCallerAdmin && config.unpriced?.length > 0 ? { freebeat_unpriced: config.unpriced } : {}),
        });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Konfigurasi musik tidak tersedia' }, err?.status || 500);
      }
    }

    if (path === 'music/generate' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        const result = await consumerMusicGenerate(env, request, user);
        return jsonResponse({
          ok: true,
          ...result,
          ...(result?.generation ? { generation: await attachMusicMediaUrls(result.generation, env) } : {}),
        });
      } catch (err) {
        return jsonResponse({
          error: err?.message || 'Generasi musik gagal',
          ...(err?.code ? { code: err.code } : {}),
        }, err?.status || 500);
      }
    }

    if (path === 'music/status' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        const result = await consumerMusicStatus(env, request, user);
        return jsonResponse({
          ok: true,
          ...result,
          ...(result?.generation ? { generation: await attachMusicMediaUrls(result.generation, env) } : {}),
        });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Status musik tidak tersedia' }, err?.status || 500);
      }
    }

    if (path === 'music/history' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      try {
        return jsonResponse({ ok: true, ...(await attachMusicHistoryMedia(await consumerMusicHistory(env, user), env)) });
      } catch (err) {
        return jsonResponse({ error: err?.message || 'Riwayat musik tidak tersedia' }, err?.status || 500);
      }
    }

    if (path === 'video/models' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const [keysRes, modelsRes, pricesRes, freebeatCfgs] = await Promise.all([
        servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url,label'),
        servicePostgrest(env, '/provider_models?select=provider,model,active&active=eq.true&order=created_at.desc&limit=500'),
        servicePostgrest(env, '/credit_model_prices?modality=eq.video&active=eq.true&select=provider,model,credits&limit=500').catch(() => null),
        consumerFreebeatVideoConfigs(env).catch(() => null),
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
          label: row.provider === 'alibaba' ? 'Alibaba' : (row.label || PROVIDER_PRESETS[row.provider]?.label || row.provider),
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

      // 3. Freebeat MCP Video Tools (Dance, Singing, Lip-Sync — OAuth provider session + credit_model_prices)
      const danceCfg = freebeatCfgs?.generate_dance_video || null;
      const singingCfg = freebeatCfgs?.generate_singing_video || null;
      const lipSyncCfg = freebeatCfgs?.generate_lip_sync_video || null;
      const anyFreebeatVideoReady = Boolean(freebeatCfgs?.provider_ready);
      let hasAnyFreebeatVideo = false;

      if (danceCfg && (Number.isSafeInteger(danceCfg.credits) || danceCfg.provider_ready)) {
        hasAnyFreebeatVideo = true;
        const danceCredits = Number.isSafeInteger(danceCfg.credits) ? danceCfg.credits : null;
        const dancePriced = Number.isSafeInteger(danceCredits) && danceCredits > 0;
        merged.set('freebeat:generate_dance_video', {
          id: 'generate_dance_video',
          name: 'Music-to-Dance Video (720p)',
          provider: 'freebeat',
          providerLabel: 'Freebeat',
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
          description: 'Koreografi dance AI otomatis dari lagu/audio (MP3/WAV/link musik) & hingga 5 foto karakter/penari (bukan motion transfer video). Resolusi 720p, estimasi 15–60 menit.',
        });
      }

      if (singingCfg && (Number.isSafeInteger(singingCfg.credits) || singingCfg.provider_ready)) {
        hasAnyFreebeatVideo = true;
        const singingCredits = Number.isSafeInteger(singingCfg.credits) ? singingCfg.credits : null;
        const singingPriced = Number.isSafeInteger(singingCredits) && singingCredits > 0;
        merged.set('freebeat:generate_singing_video', {
          id: 'generate_singing_video',
          name: 'Singing Video (AI Vocal & MV)',
          provider: 'freebeat',
          providerLabel: 'Freebeat',
          providerConfigured: singingCfg.provider_ready === true,
          activeInAdmin: singingPriced,
          online: singingCfg.provider_ready === true,
          credits: singingPriced ? singingCredits : null,
          priced: singingPriced,
          isFree: false,
          priceLabel: singingPriced ? `${singingCredits} kredit` : 'Tarif belum diatur',
          aspectRatios: ['9:16', '16:9', '1:1'],
          resolutions: ['720p'],
          durations: [5, 10, 15, 20, 30],
          singingModes: Array.isArray(singingCfg.singingModes) && singingCfg.singingModes.length ? singingCfg.singingModes : ['auto', 'duet'],
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: true,
          supportsAudioInput: true,
          supportsAudioOutput: true,
          requiresAudio: true,
          requiresImage: true,
          maxImages: singingCfg.maxImages || 5,
          mediaMode: 'singing_video',
          description: 'Video bernyanyi AI (solo atau duet) dari 1–5 foto karakter & file lagu/audio (MP3/WAV/link musik). Pilih rasio 9:16, 16:9, atau 1:1 dan durasi video.',
        });
      }

      if (lipSyncCfg && (Number.isSafeInteger(lipSyncCfg.credits) || lipSyncCfg.provider_ready)) {
        hasAnyFreebeatVideo = true;
        const lipSyncCredits = Number.isSafeInteger(lipSyncCfg.credits) ? lipSyncCfg.credits : null;
        const lipSyncPriced = Number.isSafeInteger(lipSyncCredits) && lipSyncCredits > 0;
        merged.set('freebeat:generate_lip_sync_video', {
          id: 'generate_lip_sync_video',
          name: 'Lip-Sync Video',
          provider: 'freebeat',
          providerLabel: 'Freebeat',
          providerConfigured: lipSyncCfg.provider_ready === true,
          activeInAdmin: lipSyncPriced,
          online: lipSyncCfg.provider_ready === true,
          credits: lipSyncPriced ? lipSyncCredits : null,
          priced: lipSyncPriced,
          isFree: false,
          priceLabel: lipSyncPriced ? `${lipSyncCredits} kredit` : 'Tarif belum diatur',
          aspectRatios: [],
          supportsRatio: false,
          resolutions: ['720p'],
          durations: [5, 10, 15, 20, 30],
          supportsImage: false,
          supportsVideo: true,
          supportsAudio: true,
          supportsAudioInput: true,
          supportsAudioOutput: true,
          requiresVideo: true,
          requiresAudio: true,
          maxImages: 0,
          mediaMode: 'lip_sync_video',
          description: 'Sinkronkan gerakan bibir video sumber (MP4/MOV/WebM) dengan audio suara atau lagu (MP3/WAV/link musik).',
        });
      }

      const models = Array.from(merged.values()).sort((a, b) => {
        if (a.activeInAdmin !== b.activeInAdmin) return a.activeInAdmin ? -1 : 1;
        if (a.providerConfigured !== b.providerConfigured) return a.providerConfigured ? -1 : 1;
        if (a.priced !== b.priced) return a.priced ? -1 : 1;
        if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      // 'ollama' chat-only: jangan pernah ditampilkan sebagai provider video.
      const providers = Array.from(configuredByProvider.values()).filter((p) => !['cloudflare', 'unorouter', 'freebeat', 'ollama'].includes(p.id));
      if (hasAnyFreebeatVideo) {
        providers.push({ id: 'freebeat', label: 'Freebeat', configured: anyFreebeatVideoReady, hasBaseUrl: false });
      }
      for (const preset of Object.values(PROVIDER_PRESETS)) {
        if (preset.id === 'custom' || preset.id === 'cloudflare' || preset.id === 'unorouter' || preset.id === 'ollama') continue;
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

    // ---- /library: satu daftar hasil dari semua tool Studio ------------------
    //
    // Riwayat (/history) dibangun untuk pemutaran ulang per jenis; halaman ini
    // dibangun untuk "ambil hasilnya": setiap baris membawa teks yang bisa
    // disalin dan tautan unduhan bertanda tangan yang bisa diklik.
    if (path === 'library' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Login diperlukan' }, 401);
      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const limit = Math.min(60, Math.max(1, Number(body.limit ?? url.searchParams.get('limit') ?? 40)));
      const tool = String(body.tool ?? url.searchParams.get('tool') ?? 'all').toLowerCase();
      const uid = `/user_id=eq.${encodeURIComponent(user.id)}`;
      const wanted = (kind) => tool === 'all' || tool === kind;
      const readRows2 = async (query) => {
        const res = await servicePostgrest(env, query).catch(() => null);
        if (!res || !res.ok) return [];
        const rows = await res.json().catch(() => []);
        return Array.isArray(rows) ? rows : [];
      };
      const [imageRows, videoRows, musicRows, metadataRows, conversationRows, studioRows] = await Promise.all([
        wanted('image') ? readRows2(`/image_generations?select=*&${uid}&order=created_at.desc&limit=${limit}`) : [],
        wanted('video') ? readRows2(`/video_generations?select=*&${uid}&order=created_at.desc&limit=${limit}`) : [],
        wanted('music') ? readRows2(`/music_generations?select=*&${uid}&order=created_at.desc&limit=${limit}`) : [],
        wanted('metadata') ? readRows2(`/metadata_jobs?select=*&${uid}&order=created_at.desc&limit=${limit}`) : [],
        wanted('chat') ? readRows2(`/ai_messages?select=id,conversation_id,role,content,created_at&${uid}&role=eq.assistant&order=created_at.desc&limit=${limit}`) : [],
        readRows2(`/studio_generations?select=*&${uid}&order=created_at.desc&limit=${limit}`),
      ]);

      const items = [];
      for (const row of imageRows) {
        const clean = sanitizeImageRow(row);
        const withDownload = await attachImageDownloadUrls(clean, env);
        items.push({
          id: `image:${row.id}`,
          tool: 'image',
          tool_label: 'Buat Gambar',
          title: clean.prompt || 'Gambar tanpa prompt',
          text: clean.prompt || '',
          status: clean.status,
          media_kind: 'image',
          preview_url: clean.image_url || '',
          download_url: withDownload.download_url || '',
          extra_downloads: withDownload.download_urls || [],
          created_at: clean.created_at,
          credits: clean.credits_charged || 0,
          error: clean.error_message || null,
        });
      }
      for (const row of videoRows) {
        const status = row.status || 'queued';
        items.push({
          id: `video:${row.id}`,
          tool: 'video',
          tool_label: 'Buat Video',
          title: row.prompt || 'Video tanpa prompt',
          text: row.prompt || '',
          status,
          media_kind: 'video',
          preview_url: status === 'completed' ? (row.result_url || row.video_url || '') : '',
          download_url: status === 'completed' ? await signVideoContentUrl(row.id, env) : '',
          extra_downloads: [],
          created_at: row.created_at,
          credits: Number(row.credits_charged) || 0,
          error: row.error_message || null,
        });
      }
      for (const row of musicRows) {
        const clean = sanitizeMusicRow(row);
        const audioCount = Number(clean.audio_count) || (clean.has_audio ? 1 : 0);
        items.push({
          id: `music:${row.id}`,
          tool: 'music',
          tool_label: 'Buat Musik',
          title: clean.prompt || clean.title || 'Musik tanpa prompt',
          text: clean.prompt || '',
          status: clean.status,
          media_kind: 'audio',
          preview_url: clean.status === 'completed' ? String(row.audio_url || '') : '',
          download_url: clean.status === 'completed' && audioCount
            ? await signMusicContentUrl(row.id, 'audio', 0, env, { download: true })
            : '',
          extra_downloads: [],
          created_at: clean.created_at,
          credits: 0,
          error: clean.error_message || null,
        });
      }
      for (const row of metadataRows) {
        items.push({
          id: `metadata:${row.id}`,
          tool: 'metadata',
          tool_label: 'Cek Metadata',
          title: row.filename || 'Berkas tanpa nama',
          text: [
            `Berkas: ${row.filename || '-'}`,
            `Jenis: ${row.media_kind || '-'}`,
            `Metadata AI terdeteksi: ${row.ai_detected ? 'ya' : 'tidak'}`,
            (Array.isArray(row.detected_tools) && row.detected_tools.length) ? `Generator: ${row.detected_tools.join(', ')}` : '',
            `Field dihapus: ${Number(row.removed_count) || 0}`,
            `Ukuran: ${Number(row.original_size) || 0} → ${Number(row.cleaned_size) || 0} byte`,
          ].filter(Boolean).join('\n'),
          status: row.status,
          media_kind: 'file',
          preview_url: '',
          download_url: row.status === 'completed' && row.cleaned_path ? `/api/metadata/content/${encodeURIComponent(row.id)}?download=1` : '',
          extra_downloads: [],
          created_at: row.created_at,
          credits: Number(row.credits_charged) || 0,
          error: row.error_message || null,
        });
      }
      for (const row of conversationRows) {
        const text = String(row.content || '');
        items.push({
          id: `chat:${row.id}`,
          tool: 'chat',
          tool_label: 'Chat & Tulis',
          title: text.replace(/\s+/g, ' ').slice(0, 90) || 'Jawaban chat',
          text,
          status: 'completed',
          media_kind: 'text',
          preview_url: '',
          download_url: '',
          extra_downloads: [],
          created_at: row.created_at,
          credits: 0,
          error: null,
        });
      }

      // Hasil dari pool akun OpenAI (gambar/video/teks Studio).
      const STUDIO_TOOL_LABEL = { chat: 'Chat & Tulis', agent: 'Agen Otonom', image: 'Buat Gambar', video: 'Buat Video', audio: 'Audio', library: 'Hasil' };
      for (const row of studioRows) {
        if (!wanted(row.kind === 'text' ? (row.tool === 'agent' ? 'agent' : 'chat') : row.kind)) continue;
        const isText = row.kind === 'text';
        items.push({
          id: `studio:${row.id}`,
          tool: row.tool || 'chat',
          tool_label: STUDIO_TOOL_LABEL[row.tool] || 'Studio',
          title: (isText ? String(row.output_text || '').replace(/\s+/g, ' ').slice(0, 90) : row.prompt) || 'Hasil Studio',
          text: isText ? String(row.output_text || '') : String(row.prompt || ''),
          status: row.status,
          media_kind: row.kind === 'text' ? 'text' : row.kind,
          preview_url: row.status === 'completed' ? String(row.media_url || '') : '',
          download_url: row.status === 'completed' ? String(row.download_url || row.media_url || '') : '',
          extra_downloads: [],
          created_at: row.created_at,
          credits: 0,
          error: row.error_message || null,
          model: row.model || '',
        });
      }

      items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      return jsonResponse({
        ok: true,
        items: items.slice(0, limit * 2),
        counts: {
          image: imageRows.length,
          video: videoRows.length,
          music: musicRows.length,
          metadata: metadataRows.length,
          chat: conversationRows.length,
          agent: studioRows.filter((row) => row.tool === 'agent').length,
        },
      });
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
      if (!provider || provider === 'unorouter' || (provider === 'freebeat' && !['generate_dance_video', 'generate_singing_video', 'generate_lip_sync_video'].includes(model))) {
        return jsonResponse({ error: 'Provider video tidak tersedia. Pilih provider yang didukung.' }, 400);
      }
      if (!model) return jsonResponse({ error: 'Pilih model video terlebih dahulu.' }, 400);
      if (provider === 'freebeat') {
        try {
          const out = model === 'generate_dance_video'
            ? await consumerDanceGenerate(env, user, payload)
            : await consumerVocalGenerate(env, user, payload);
          return jsonResponse({ ok: true, credits: out.credits, generation: await sanitizeGenerationRow(out.row, env) });
        } catch (err) {
          return jsonResponse({
            error: err?.message || 'Gagal memulai generasi video Freebeat.',
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
          error: `Harga kredit untuk model video "${model}" (${provider}) belum diatur admin. Atur dulu di Admin → API Key → Katalog Model.`,
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

      const result = await pollVideoGenerationRow(env, row);
      return jsonResponse({ ok: true, ...result });
    }

    // ---- /generations/live: live active processes across platform (anonymized for regular users, full + cancelable for admin) ----
    if (path === 'generations/live' && (method === 'GET' || method === 'POST')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);

      const body = method === 'POST' ? await request.json().catch(() => ({})) : {};
      const shouldPoll = body?.poll === true || url.searchParams.get('poll') === '1' || url.searchParams.get('poll') === 'true';
      const isAdmin = user?.app_metadata?.role === 'admin';

      const mergeUniqueById = (activeRows, completedRows, cutoffMs) => {
        const seen = new Set();
        const out = [];
        for (const row of activeRows) {
          if (!row?.id || seen.has(row.id)) continue;
          seen.add(row.id);
          out.push(row);
        }
        for (const row of completedRows) {
          if (!row?.id || seen.has(row.id)) continue;
          if (row.status !== 'completed') continue;
          const doneMs = Date.parse(row.updated_at || '') || 0;
          if (doneMs < cutoffMs) continue;
          seen.add(row.id);
          out.push(row);
        }
        return out;
      };

      const fetchLiveRows = async () => {
        const now = Date.now();
        const recentCutoffMs = now - LIVE_RECENT_COMPLETED_MS;
        const recentCutoffIso = new Date(recentCutoffMs).toISOString();
        const [vidActiveRes, imgActiveRes, musActiveRes, vidDoneRes, imgDoneRes, musDoneRes, metaActiveRes, metaDoneRes] = await Promise.all([
          servicePostgrest(env, '/video_generations?select=*&status=in.(queued,in_progress)&order=created_at.desc,id.desc&limit=100'),
          servicePostgrest(env, '/image_generations?select=*&status=in.(queued,processing,unknown)&order=created_at.desc,id.desc&limit=100'),
          servicePostgrest(env, '/music_generations?select=*&status=in.(queued,processing,unknown)&order=created_at.desc,id.desc&limit=100').catch(() => null),
          servicePostgrest(env, `/video_generations?select=*&status=eq.completed&updated_at=gte.${encodeURIComponent(recentCutoffIso)}&order=updated_at.desc,id.desc&limit=20`),
          servicePostgrest(env, `/image_generations?select=*&status=eq.completed&updated_at=gte.${encodeURIComponent(recentCutoffIso)}&order=updated_at.desc,id.desc&limit=20`),
          servicePostgrest(env, `/music_generations?select=*&status=eq.completed&updated_at=gte.${encodeURIComponent(recentCutoffIso)}&order=updated_at.desc,id.desc&limit=20`).catch(() => null),
          servicePostgrest(env, '/metadata_jobs?select=*&status=in.(queued,processing)&order=created_at.desc,id.desc&limit=100').catch(() => null),
          servicePostgrest(env, `/metadata_jobs?select=*&status=eq.completed&updated_at=gte.${encodeURIComponent(recentCutoffIso)}&order=updated_at.desc,id.desc&limit=20`).catch(() => null),
        ]);
        const activeVideos = vidActiveRes?.ok ? await vidActiveRes.json().catch(() => []) : [];
        const activeImages = imgActiveRes?.ok ? await imgActiveRes.json().catch(() => []) : [];
        const activeMusic = musActiveRes?.ok ? await musActiveRes.json().catch(() => []) : [];
        const doneVideos = vidDoneRes?.ok ? await vidDoneRes.json().catch(() => []) : [];
        const doneImages = imgDoneRes?.ok ? await imgDoneRes.json().catch(() => []) : [];
        const doneMusic = musDoneRes?.ok ? await musDoneRes.json().catch(() => []) : [];
        const activeMeta = metaActiveRes?.ok ? await metaActiveRes.json().catch(() => []) : [];
        const doneMeta = metaDoneRes?.ok ? await metaDoneRes.json().catch(() => []) : [];
        return {
          videos: mergeUniqueById(Array.isArray(activeVideos) ? activeVideos : [], Array.isArray(doneVideos) ? doneVideos : [], recentCutoffMs),
          images: mergeUniqueById(Array.isArray(activeImages) ? activeImages : [], Array.isArray(doneImages) ? doneImages : [], recentCutoffMs),
          musicJobs: mergeUniqueById(Array.isArray(activeMusic) ? activeMusic : [], Array.isArray(doneMusic) ? doneMusic : [], recentCutoffMs),
          metadataJobs: mergeUniqueById(Array.isArray(activeMeta) ? activeMeta : [], Array.isArray(doneMeta) ? doneMeta : [], recentCutoffMs),
        };
      };

      let { videos, images, musicJobs, metadataJobs } = await fetchLiveRows();
      if (shouldPoll) {
        const now = Date.now();
        const staleCandidates = [
          ...videos
            .filter((row) => ['queued', 'in_progress'].includes(row.status) && (row.external_job_id || row.polling_url || (row.provider === 'freebeat' && row.metadata?.preparing_music_id)))
            .map((row) => ({ kind: 'video', row, ts: Date.parse(row.updated_at || row.created_at || '') || 0 })),
          ...images
            .filter((row) => ['queued', 'processing'].includes(row.status) && row.external_job_id)
            .map((row) => ({ kind: 'image', row, ts: Date.parse(row.updated_at || row.created_at || '') || 0 })),
          ...musicJobs
            .filter((row) => ['queued', 'processing'].includes(row.status) && row.external_job_id)
            .map((row) => ({ kind: 'music', row, ts: Date.parse(row.updated_at || row.created_at || '') || 0 })),
        ]
          .filter((entry) => now - entry.ts >= 2500)
          .sort((a, b) => a.ts - b.ts)
          .slice(0, 6);

        if (staleCandidates.length > 0) {
          await Promise.allSettled(staleCandidates.map((entry) => {
            if (entry.kind === 'video') return pollVideoGenerationRow(env, entry.row);
            if (entry.kind === 'music') return pollFreebeatMusicRow(env, entry.row);
            if (entry.row.provider === 'freebeat') return pollFreebeatImageRow(env, entry.row);
            return alibabaImageStatus(env, { id: entry.row.user_id }, entry.row);
          }));
          ({ videos, images, musicJobs, metadataJobs } = await fetchLiveRows());
        }
      }

      const profileMap = new Map();
      const userIds = Array.from(new Set(
        [...videos, ...images, ...musicJobs, ...metadataJobs]
          .map((row) => String(row?.user_id || '').trim())
          .filter((id) => LIVE_UUID_RE.test(id)),
      ));
      if (userIds.length > 0) {
        const profRes = await servicePostgrest(
          env,
          `/profiles?select=id,email,full_name&id=in.(${userIds.join(',')})&limit=200`,
        ).catch(() => null);
        const profiles = profRes?.ok ? await profRes.json().catch(() => []) : [];
        for (const profile of profiles || []) {
          if (profile?.id) {
            profileMap.set(profile.id, {
              email: profile.email || null,
              full_name: profile.full_name || '',
            });
          }
        }
      }

      const nowMs = Date.now();
      const viewerName = String(user?.user_metadata?.full_name || '').trim();
      const items = [
        ...videos.map((row) => formatLiveQueueItem(row, 'video', { isAdmin, viewerId: user.id, viewerName, profileMap, nowMs })),
        ...images.map((row) => formatLiveQueueItem(row, 'image', { isAdmin, viewerId: user.id, viewerName, profileMap, nowMs })),
        ...musicJobs.map((row) => formatLiveQueueItem(row, 'music', { isAdmin, viewerId: user.id, viewerName, profileMap, nowMs })),
        ...metadataJobs.map((row) => formatLiveQueueItem(row, 'metadata', { isAdmin, viewerId: user.id, viewerName, profileMap, nowMs })),
      ].sort((a, b) => compareRaceItems(a, b, nowMs));

      const activeItems = items.filter((item) => item.status !== 'completed');
      const completedItems = items.filter((item) => item.status === 'completed');

      return jsonResponse({
        ok: true,
        is_admin: isAdmin,
        server_time: new Date(nowMs).toISOString(),
        counts: {
          total: activeItems.length,
          video: activeItems.filter((item) => item.kind === 'video').length,
          image: activeItems.filter((item) => item.kind === 'image').length,
          music: activeItems.filter((item) => item.kind === 'music').length,
          metadata: activeItems.filter((item) => item.kind === 'metadata').length,
          completed: completedItems.length,
          own: items.filter((item) => item.is_own).length,
          stalled: activeItems.filter((item) => item.stalled).length,
        },
        items,
      });
    }

    // ---- /admin/generations/cancel: admin-only cancel active/hanging generation + refund unrefunded credits ----
    if (path === 'admin/generations/cancel' && method === 'POST') {
      const origin = request.headers.get('origin');
      if (!origin || origin !== url.origin) {
        return jsonResponse({ error: 'Permintaan harus berasal dari halaman BLEA ini.' }, 403);
      }
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      if (!user) return jsonResponse({ error: 'Missing or invalid token' }, 401);
      if (user?.app_metadata?.role !== 'admin') {
        return jsonResponse({ error: 'Akses khusus admin diperlukan untuk membatalkan proses.' }, 403);
      }

      const body = await request.json().catch(() => ({}));
      const id = String(body?.id || '').trim();
      const kind = String(body?.kind || '').trim().toLowerCase();
      const reason = String(body?.reason || '').trim().slice(0, 200);
      if (!LIVE_UUID_RE.test(id)) return jsonResponse({ error: 'ID generasi tidak valid.' }, 400);
      if (kind !== 'video' && kind !== 'image' && kind !== 'music' && kind !== 'metadata') {
        return jsonResponse({ error: 'Jenis generasi harus video, image, music, atau metadata.' }, 400);
      }

      const table = kind === 'video'
        ? 'video_generations'
        : kind === 'music'
          ? 'music_generations'
          : kind === 'metadata'
            ? 'metadata_jobs'
            : 'image_generations';
      const activeStatuses = kind === 'video'
        ? 'queued,in_progress'
        : kind === 'metadata'
          ? 'queued,processing'
          : 'queued,processing,unknown';
      const rowRes = await servicePostgrest(env, `/${table}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
      const rows = rowRes?.ok ? await rowRes.json().catch(() => []) : [];
      const row = rows?.[0];
      if (!row) return jsonResponse({ error: 'Proses generasi tidak ditemukan.' }, 404);

      if (['completed', 'failed', 'cancelled', 'expired'].includes(row.status)) {
        return jsonResponse({ error: 'Proses ini sudah selesai atau dibatalkan sebelumnya.' }, 409);
      }

      const charged = Number(row.credits_charged || 0);
      const shouldRefund = charged > 0 && Number(row.credits_refunded || 0) === 0;
      const cancelNote = reason ? `Dibatalkan oleh admin: ${reason}` : 'Dibatalkan oleh admin.';
      const nowIso = new Date().toISOString();
      const patchQuery = `/${table}?id=eq.${encodeURIComponent(id)}&status=in.(${activeStatuses})${shouldRefund ? '&credits_refunded=eq.0' : ''}`;
      const patchBody = {
        status: 'cancelled',
        error_message: cancelNote.slice(0, 300),
        updated_at: nowIso,
        ...(kind === 'video' || kind === 'metadata' ? { progress: 0 } : {}),
        ...(shouldRefund ? { credits_refunded: charged } : {}),
      };
      const patchRes = await servicePostgrest(env, patchQuery, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: patchBody,
      });
      if (!patchRes?.ok) {
        const errText = patchRes ? await patchRes.text().catch(() => '') : '';
        return jsonResponse({ error: 'Gagal memperbarui status pembatalan di database.', detail: errText.slice(0, 200) }, 500);
      }
      const patched = await patchRes.json().catch(() => []);
      if (!Array.isArray(patched) || patched.length === 0) {
        return jsonResponse({ error: 'Status proses berubah secara bersamaan; muat ulang daftar proses.' }, 409);
      }

      let refundedAmount = 0;
      if (shouldRefund) {
        const desc = kind === 'metadata'
          ? `Refund: pembersihan metadata (${row.filename || 'media'}) dibatalkan oleh admin`
          : `Refund: proses ${kind} ${row.provider} (${row.model}) dibatalkan oleh admin`;
        const refunded = kind === 'video'
          ? await refundVideoCredits(env, row.user_id, charged, row.id, desc)
          : (kind === 'metadata' || kind === 'music')
            ? await creditRpc(env, 'refund_credits', { p_user_id: row.user_id, p_amount: charged, p_description: desc, p_generation_id: row.id })
            : await refundImageCredits(env, row.user_id, charged, row.id, desc);
        if (refunded) {
          refundedAmount = charged;
        } else {
          patched[0].credits_refunded = 0;
          await servicePostgrest(env, `/${table}?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { credits_refunded: 0, updated_at: new Date().toISOString() },
          }).catch(() => {});
        }
      }

      return jsonResponse({
        ok: true,
        id: row.id,
        kind,
        refunded: refundedAmount,
        generation: kind === 'video'
          ? await sanitizeGenerationRow(patched[0], env)
          : kind === 'music'
            ? sanitizeMusicRow(patched[0])
            : kind === 'metadata'
              ? await sanitizeMetadataJobRow(patched[0], env)
              : sanitizeImageRow(patched[0]),
      });
    }

    // ---- /metadata/*: scan & lossless AI metadata removal ----
    if (path.startsWith('metadata/content/') && (method === 'GET' || method === 'HEAD')) {
      return handleMetadataContent({ request, url, env, path, getUser, jsonResponse, servicePostgrest });
    }
    if (path === 'metadata/scan' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      return handleMetadataScan({ request, env, user, jsonResponse, servicePostgrest });
    }
    if (path === 'metadata/start' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      return handleMetadataStart({ request, env, user, jsonResponse, servicePostgrest, creditRpc });
    }
    if (path === 'metadata/process' && method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      return handleMetadataProcess({ request, env, user, jsonResponse, servicePostgrest, creditRpc });
    }
    if (path === 'metadata/history' && (method === 'POST' || method === 'GET')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      return handleMetadataHistory({ request, env, user, jsonResponse, servicePostgrest });
    }
    if (path === 'metadata/status' && (method === 'POST' || method === 'GET')) {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
      const user = token ? await getUser(env, token) : null;
      return handleMetadataStatus({ request, env, user, jsonResponse, servicePostgrest });
    }

    // ---- /search: web search untuk mode agen (internet access) ----
    if (path === 'search' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const query = String(body.query || '').trim();
      if (!query) return jsonResponse({ error: 'query required' }, 400);
      const results = await webSearch(query);
      return jsonResponse({ ok: true, results, query });
    }

    // ---- /agent: satu giliran agen (model → alat → jawaban), SSE ----
    // Halaman /agent. Tool loop ada di server supaya kunci provider tidak
    // pernah sampai ke browser dan loop tidak bisa dimanipulasi dari klien.
    if (path === 'agent/skills' && (method === 'GET' || method === 'POST')) {
      return jsonResponse({
        ok: true,
        source: { repo: 'anthropics/skills', license: 'Apache-2.0' },
        skills: availableSkills().map(({ id, name, description, triggers }) => ({ id, name, description, triggers })),
        tools: AGENT_TOOL_NAMES,
      });
    }

    if (path === 'agent/transcribe' && method === 'POST') {
      return handleTranscribe(request, env, { getUser });
    }

    if (path === 'agent' && method === 'POST') {
      // Alat yang boleh dijalankan loop agen diikuti ruang Studio yang membuka
      // giliran ini. Ruang riset tidak bisa menyuruh agen mengusulkan klip,
      // dan ruang klip tidak bisa menyuruhnya menulis dokumen.
      const studioTool = studioToolHeader(request);
      const scopedAgentTools = agentToolsForStudioTool(studioTool);
      const scopedAgentToolNames = Array.isArray(scopedAgentTools)
        ? AGENT_TOOL_NAMES.filter((name) => scopedAgentTools.includes(name))
        : AGENT_TOOL_NAMES;
      if (Array.isArray(scopedAgentTools) && !scopedAgentToolNames.length) {
        return jsonResponse({ error: `Ruang "${studioTool}" tidak memakai alat agen.` }, 403);
      }
      return handleAgentTurn(request, url, env, {
        getUser,
        servicePostgrest,
        webSearch,
        sendChatCompletionRequest,
        // Dipakai agen saat akun pool berupa OAuth (tanpa API key).
        sendOAuthResponses,
        chatUpstreamTimeoutMs,
        // Studio memakai model OpenAI (pool akun manual). Ruang lain tetap
        // memakai katalog provider seperti sebelumnya.
        assertStudioProvider: (provider, model) => {
          if (!studioTool) return null;
          if (provider === 'openai') return null;
          return {
            code: 'studio_provider_mismatch',
            message: `Ruang "${studioTool}" hanya memakai model OpenAI (openai), bukan "${provider}" (${model}).`,
          };
        },
        recordTurnText: async (payload) => (studioTool
          ? recordStudioText(env, user.id, { ...payload, metadata: { room: studioTool } })
          : null),
        pickPoolAccounts: (capability = 'agent', options = {}) => pickOpenAiAccountsFor(env, {
          capability,
          limit: Number(options?.limit) || 4,
        }),
        // Dipakai hanya untuk pesan error: membedakan "pool kosong" dari
        // "akun ada tapi tidak bisa dipakai". Tanpa angka ini, akun yang sehat
        // tampil seolah belum dikonfigurasi.
        poolBlockedMessage: (capability = 'agent') => openAiPoolBlockedMessage(env, capability),
        poolFailureMessage: (details, options) => openAiFailureMessage(details, options),
        // Ruang yang punya loop agen memakai kapabilitas `agent`; ruang teks
        // biasa memakai `chat`. Dipakai untuk memilih akun pool yang tepat.
        studioToolUsesAgentTools: (id) => {
          const tools = agentToolsForStudioTool(id);
          return Array.isArray(tools) && tools.length > 0;
        },
        buildFallbackCandidates: ({ primaryProvider, primaryModel, keyByProvider }) => buildChatFallbackCandidates({
          primaryProvider,
          primaryModel,
          keyByProvider,
          dbModelRows: [],
          env,
        }),
        hasWorkersAiBinding,
        buildSystemPrompt: buildAgentSystemPrompt,
        availableSkillIds: availableSkills().map((skill) => skill.id),
        loadSkillSection,
        runTool: (tool, args, ctx) => {
          if (!scopedAgentToolNames.includes(tool.name)) {
            return `Alat gagal: "${tool.name}" tidak tersedia di ruang ${studioTool || 'ini'}. Alat yang tersedia: ${scopedAgentToolNames.join(', ')}.`;
          }
          return tool.run(args, ctx);
        },
        extractAssistantReply,
        parseAgentToolCall,
        stripAgentToolCalls,
        findTool: (name) => (scopedAgentToolNames.includes(name) ? findAgentTool(name) : null),
        availableToolNames: scopedAgentToolNames,
        describeToolCall: (name, args) => AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.describe(args) || '',
        summarizeToolResult: (name, result, args) => AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name)?.summarize(result, args) || '',
        normalizeAgentAttachments,
        normalizeClipProposal,
        normalizeVideoAnalysis,
        normalizeVideoTranscript,
        buildAttachmentContent,
        // Harga giliran opsional (credit_model_prices, modality 'agent_turn').
        chargeCredits: (envRef, userId, amount, description, generationId) => creditRpc(envRef, 'spend_credits', {
          p_user_id: userId,
          p_amount: amount,
          p_description: description,
          p_generation_id: generationId,
        }),
        refundCredits: (envRef, userId, amount, generationId, description) => creditRpc(envRef, 'refund_credits', {
          p_user_id: userId,
          p_amount: amount,
          p_description: description,
          p_generation_id: generationId,
        }),
      });
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
      const alibabaPoolMap = new Map(alibabaCandidates.length ? [['alibaba', alibabaCandidates]] : []);
      // Pool akun OpenAI manual (dikelola di /studio/openai-accounts) ikut
      // menjadi kandidat provider `openai` — termasuk untuk rantai fallback,
      // supaya akun yang ditambahkan admin benar-benar terpakai.
      const openaiCandidates = env.OPENAI_POOL_DISABLED === '1' || env.OPENAI_POOL_DISABLED === 'true'
        ? []
        : await pickOpenAiAccountsFor(env, { capability: 'chat', limit: 4 }).catch(() => []);
      if (openaiCandidates.length) {
        if (!keyByProvider.get('openai')?.api_key) {
          keyByProvider.set('openai', {
            provider: 'openai',
            api_key: openaiCandidates[0].apiKey,
            base_url: `${openaiCandidates[0].apiBase}/v1`,
            label: 'Pool akun OpenAI (manual)',
          });
        }
        alibabaPoolMap.set('openai', openaiCandidates.map((account) => ({
          api_key: account.apiKey,
          base_url: `${account.apiBase}/v1`,
          label: account.accountLabel || account.accountEmail || 'Pool OpenAI',
        })));
      }
      const primaryKeyRow = primaryProvider === 'alibaba' ? (alibabaCandidates[0] || null) : keyByProvider.get(primaryProvider);
      let primaryApiKey = primaryKeyRow?.api_key || (primaryProvider === 'unorouter' ? 'use-free' : '');
      if (primaryProvider === 'cloudflare' && !primaryApiKey && hasWorkersAiBinding(env)) {
        primaryApiKey = 'binding:AI';
      }
      if (!primaryApiKey) {
        // Provider `openai` memakai pool akun; pesan generik di sini dulu
        // membuat akun yang sehat tampak belum dikonfigurasi.
        const blocked = primaryProvider === 'openai'
          ? await openAiPoolBlockedMessage(env, 'chat').catch(() => null)
          : null;
        // JANGAN langsung menyerah: provider utama memang tidak bisa dipakai,
        // tetapi provider lain mungkin sehat. Tanpa ini, pengguna dengan akun
        // OpenAI bermasalah tidak pernah sampai ke fallback (mis. alibaba).
        if (body.autoFallback !== false) {
          const rescue = await tryFallbackWithoutPrimary({
            env,
            primaryProvider,
            requestedModel,
            keyByProvider,
            poolByProvider: alibabaPoolMap,
            fetchBody: {
              ...body,
              model: requestedModel,
              messages: [{ role: 'system', content: AGENT_SYSTEM_PROMPT }, ...(Array.isArray(body.messages) ? body.messages : [])],
              stream: false,
            },
            conversationId: body.conversationId,
            userId: user.id,
            reason: blocked?.code || (primaryProvider === 'openai' ? 'openai_pool_empty' : 'provider_not_configured'),
          });
          if (rescue) return jsonResponse(rescue, 200, { 'cache-control': 'no-store' });
        }
        if (blocked) {
          // `hint` diteruskan: untuk kasus paket OAuth, satu-satunya jalan
          // keluar berbeda (API key berbayar), dan UI membutuhkannya tanpa
          // harus menebak dari kalimat.
          return jsonResponse({ error: blocked.error, code: blocked.code, hint: blocked.hint, pool: blocked.pool }, blocked.status);
        }
        if (primaryProvider === 'openai') {
          return jsonResponse({
            error: 'Belum ada akun OpenAI di pool. Tambahkan API key di Studio → Akun OpenAI.',
            code: 'openai_pool_empty',
          }, 400);
        }
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
        let activeIsOAuth = false;
        let fallbackFrom = '';
        let fallbackReason = '';
        let cachedDbModels = null;

        const triedModels = [requestedModel];
        const triedDetails = [];

        // Kegagalan per akun pool OpenAI (kalau ada). Dipakai untuk pesan akhir:
        // sebab yang benar (batas laju / billing / kunci) jauh lebih berguna
        // daripada "pilih model lain", karena semua model OpenAI memakai pool
        // kredensial yang sama.
        let poolFailures = [];
        if (wantStream) {
          let alibabaPrimaryCand = null;
          let probed = null;
          if (activeProvider === 'openai') {
            // Round-robin lintas akun pool OpenAI manual: akun yang kuota
            // hariannya habis atau sedang cooldown dilewati di dalam pool.
            const pooled = await sendWithOpenAiPool({
              env,
              capability: 'chat',
              model: activeModel,
              payload: fetchBody,
              timeoutMs: chatUpstreamTimeoutMs(activeProvider, true),
              stream: true,
              send: sendChatCompletionRequest,
            });
            poolFailures = Array.isArray(pooled.failures) ? pooled.failures : [];
            if (pooled.attempt) {
              probed = await probeChatStreamAttempt(pooled.attempt);
              if (pooled.account) {
                activeApiKey = pooled.account.apiKey;
                activeBaseUrl = `${pooled.account.apiBase}/v1`;
                // Akun OAuth hanya boleh lewat Responses API; jangan sampai
                // tokennya ikut terkirim ke /chat/completions pada putaran
                // riset di bawah.
                activeIsOAuth = Boolean(pooled.account.oauth);
              }
            }
          }
          if (!probed) {
            const primaryAttempt = activeProvider === 'alibaba'
              ? (await sendWithAlibabaPool({ candidates: alibabaCandidates, model: activeModel, payload: fetchBody, timeoutMs: 120_000, env, stream: true }).then((out) => { alibabaPrimaryCand = out.cand; return out.attempt; }))
              : await sendChatCompletionRequest({
                provider: activeProvider,
                model: activeModel,
                apiKey: activeApiKey,
                baseUrl: activeBaseUrl,
                payload: fetchBody,
                timeoutMs: chatUpstreamTimeoutMs(activeProvider, true),
                env,
                stream: true,
              });
            if (alibabaPrimaryCand) { activeApiKey = alibabaPrimaryCand.api_key; activeBaseUrl = alibabaPrimaryCand.base_url; }
            probed = await probeChatStreamAttempt(primaryAttempt);
          }
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
                  const researched = activeIsOAuth
                    ? await sendOAuthResponses({
                      accessToken: activeApiKey,
                      model: activeModel,
                      payload: { ...fetchBody, messages: researchMessages },
                      timeoutMs: chatUpstreamTimeoutMs(activeProvider),
                    })
                    : await sendChatCompletionRequest({
                      provider: activeProvider, model: activeModel, apiKey: activeApiKey,
                      baseUrl: activeBaseUrl, payload: { ...fetchBody, messages: researchMessages },
                      timeoutMs: chatUpstreamTimeoutMs(activeProvider), env,
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
              studioTool: studioToolHeader(request),
              prompt: latestUserQuery(incomingMessages),
            });
          }

          const errInfo = probed.errorInfo || parseChatUpstreamError('', probed.status || 502, null, activeProvider);
          const rateLimitedEntries = triedDetails.filter((d) => d.status === 429 || d.code === 'rate_limit_exceeded');
          const allRateLimited = triedDetails.length > 1 && rateLimitedEntries.length === triedDetails.length;
          const retryCandidates = rateLimitedEntries.map((d) => d.retryAfterSec).filter((n) => Number.isFinite(n) && n > 0);
          let bestRetryAfter = retryCandidates.length ? Math.min(...retryCandidates) : errInfo.retryAfterSec;
          let finalStatus = [401, 402, 403, 404, 429].includes(probed.status) ? probed.status : (rateLimitedEntries.length ? 429 : 502);
          let errorCode = errInfo.code;
          let errorMessage = allRateLimited
            ? (bestRetryAfter
              ? `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Coba lagi dalam ${bestRetryAfter} detik, pilih model lain, atau tambah saldo/provider di Admin.`
              : `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Tunggu sebentar atau tambah saldo/provider di Admin.`)
            : errInfo.friendlyMessage;
          // Pool OpenAI: sebut sebab per akun. "Pilih model lain" tidak pernah
          // menolong di sini karena semua model OpenAI memakai akun yang sama.
          if (primaryProvider === 'openai' && poolFailures.length) {
            const poolMessage = openAiFailureMessage(poolFailures, { model: requestedModel });
            errorCode = poolMessage.code;
            finalStatus = poolMessage.status;
            errorMessage = poolMessage.error;
            if (poolMessage.kind === 'rate_limit') bestRetryAfter = bestRetryAfter || 60;
          }
          return jsonResponse(
            {
              ok: false,
              error: errorMessage,
              code: errorCode,
              status: finalStatus,
              retryAfterSec: bestRetryAfter,
              detail: errInfo.rawDetail,
              triedModels,
              triedDetails,
              ...(poolFailures.length ? { poolFailures } : {}),
            },
            finalStatus,
            bestRetryAfter ? { 'retry-after': String(bestRetryAfter) } : {},
          );
        }

        let alibabaPrimaryCand2 = null;
        let attempt = null;
        if (activeProvider === 'openai') {
          const pooled = await sendWithOpenAiPool({
            env,
            capability: 'chat',
            model: activeModel,
            payload: fetchBody,
            timeoutMs: chatUpstreamTimeoutMs(activeProvider),
            send: sendChatCompletionRequest,
          });
          poolFailures = Array.isArray(pooled.failures) ? pooled.failures : [];
          if (pooled.attempt) {
            attempt = pooled.attempt;
            if (pooled.account) {
              activeApiKey = pooled.account.apiKey;
              activeBaseUrl = `${pooled.account.apiBase}/v1`;
            }
          }
        }
        if (!attempt) attempt = activeProvider === 'alibaba'
          ? (await sendWithAlibabaPool({ candidates: alibabaCandidates, model: activeModel, payload: fetchBody, timeoutMs: 120_000, env, stream: false }).then((out) => { alibabaPrimaryCand2 = out.cand; return out.attempt; }))
          : await sendChatCompletionRequest({
            provider: activeProvider,
            model: activeModel,
            apiKey: activeApiKey,
            baseUrl: activeBaseUrl,
            payload: fetchBody,
            timeoutMs: chatUpstreamTimeoutMs(activeProvider),
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
                  timeoutMs: chatUpstreamTimeoutMs(activeProvider), env,
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
          const errInfo = attempt.errorInfo || parseChatUpstreamError('', attempt.status || 502, null, activeProvider);
          const rateLimitedEntries = triedDetails.filter((d) => d.status === 429 || d.code === 'rate_limit_exceeded');
          const allRateLimited = triedDetails.length > 1 && rateLimitedEntries.length === triedDetails.length;
          const retryCandidates = rateLimitedEntries.map((d) => d.retryAfterSec).filter((n) => Number.isFinite(n) && n > 0);
          let bestRetryAfter = retryCandidates.length ? Math.min(...retryCandidates) : errInfo.retryAfterSec;
          let finalStatus = [401, 402, 403, 404, 429].includes(attempt.status) ? attempt.status : (rateLimitedEntries.length ? 429 : 502);
          let errorCode = errInfo.code;
          let errorMessage = allRateLimited
            ? (bestRetryAfter
              ? `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Coba lagi dalam ${bestRetryAfter} detik, pilih model lain, atau tambah saldo/provider di Admin.`
              : `Batas permintaan paket gratis tercapai pada ${triedModels.length} model (429). Tunggu sebentar atau tambah saldo/provider di Admin.`)
            : errInfo.friendlyMessage;
          // Pool OpenAI ada isinya tetapi TIDAK ADA akun yang bisa dipanggil
          // (kredit habis / kunci mati / paket OAuth ditolak). Dulu jawabannya
          // langsung pesan pool, padahal provider lain mungkin sehat — chat
          // jadi tampak mati total padahal hanya satu provider yang bermasalah.
          if (primaryProvider === 'openai' && body.autoFallback !== false) {
            const blocked = await openAiPoolBlockedMessage(env, 'chat').catch(() => null);
            if (blocked) {
              const rescue = await tryFallbackWithoutPrimary({
                env,
                primaryProvider: 'openai',
                requestedModel,
                keyByProvider,
                poolByProvider: alibabaPoolMap,
                fetchBody,
                conversationId: body.conversationId,
                userId: user.id,
                reason: blocked.code,
              });
              if (rescue) return jsonResponse(rescue, 200, { 'cache-control': 'no-store' });
            }
          }
          // Sama seperti jalur streaming: untuk pool OpenAI, sebut sebabnya.
          if (primaryProvider === 'openai' && poolFailures.length) {
            const poolMessage = openAiFailureMessage(poolFailures, { model: requestedModel });
            errorCode = poolMessage.code;
            finalStatus = poolMessage.status;
            errorMessage = poolMessage.error;
            if (poolMessage.kind === 'rate_limit') bestRetryAfter = bestRetryAfter || 60;
          }
          return jsonResponse(
            {
              ok: false,
              error: errorMessage,
              code: errorCode,
              status: finalStatus,
              retryAfterSec: bestRetryAfter,
              detail: errInfo.rawDetail,
              triedModels,
              triedDetails,
              ...(poolFailures.length ? { poolFailures } : {}),
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
              timeoutMs: chatUpstreamTimeoutMs(activeProvider),
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
        // Hasil chat dari ruang Studio ikut dicatat supaya muncul di halaman
        // Hasil & Unduhan bersama output tool lain.
        const studioToolForRecord = studioToolHeader(request);
        if (reply && studioToolForRecord) {
          await recordStudioText(env, user.id, {
            tool: studioToolForRecord,
            model: activeModel,
            prompt: latestUserQuery(incomingMessages),
            output: reply,
            metadata: { provider: activeProvider, room: studioToolForRecord },
          }).catch(() => null);
        }
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

/**
 * Jalankan satu putaran fallback ketika provider utama TIDAK BISA DIPAKAI
 * sama sekali (kredensial kosong / pool OpenAI tidak punya akun yang bisa
 * dipanggil).
 *
 * Kenapa ada: jalur utama `/api/chat` dulu langsung mengembalikan 4xx/503
 * sebelum rantai fallback dibangun, sehingga pengguna dengan akun OpenAI
 * bermasalah tidak pernah sampai ke provider sehat (mis. alibaba) walau
 * `autoFallback` aktif. Fungsi ini memakai kandidat yang sama dengan jalur
 * biasa supaya perilakunya konsisten: satu model dicoba per kandidat, pesan
 * asisten tetap disimpan, dan jawabannya menyebut `fallbackFrom`/`fallbackReason`.
 *
 * Mengembalikan null bila tidak ada kandidat yang berhasil — pemanggil lalu
 * memakai pesan error aslinya.
 */
async function tryFallbackWithoutPrimary({
  env,
  primaryProvider,
  requestedModel,
  keyByProvider,
  poolByProvider,
  fetchBody,
  conversationId = '',
  userId = '',
  reason = 'primary_unavailable',
}) {
  const modelsRes = await servicePostgrest(env, '/provider_models?select=provider,model&active=eq.true&order=created_at.desc&limit=150');
  const dbModelRows = modelsRes.ok ? await modelsRes.json().catch(() => []) : [];
  const candidates = buildAnyProviderChatCandidates({
    primaryProvider,
    primaryModel: requestedModel,
    keyByProvider,
    dbModelRows,
    env,
    poolByProvider,
  });
  for (const cand of candidates) {
    const alt = await sendChatCompletionRequest({
      provider: cand.provider,
      model: cand.model,
      apiKey: cand.apiKey,
      baseUrl: cand.baseUrl,
      payload: { ...fetchBody, model: cand.model },
      timeoutMs: 18_000,
      env,
    });
    if (!alt.ok) continue;
    const reply = extractAssistantReply(alt.data) || '';
    if (!reply) continue;
    // Simpan pesan asisten supaya riwayat percakapan tetap utuh, sama seperti
    // jalur normal.
    const insertRes = await servicePostgrest(env, '/ai_messages', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: {
        conversation_id: conversationId,
        user_id: userId,
        role: 'assistant',
        content: reply,
      },
    }).catch(() => null);
    let messageId = '';
    if (insertRes?.ok) {
      const inserted = await insertRes.json().catch(() => []);
      messageId = inserted?.[0]?.id ?? '';
    }
    return {
      ok: true,
      reply,
      messageId,
      model: cand.model,
      provider: cand.provider,
      fallbackFrom: requestedModel,
      fallbackReason: reason,
      note: `Provider utama (${primaryProvider}) tidak bisa dipakai; jawaban ini berasal dari ${cand.provider}.`,
    };
  }
  return null;
}

async function pollVideoGenerationRow(env, row) {
  if (!row) return { generation: null, pollWarning: 'Generation not found' };
  if (['completed', 'failed', 'cancelled', 'expired'].includes(row.status)) {
    return { generation: await sanitizeGenerationRow(row, env) };
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
      return { generation: await sanitizeGenerationRow(row, env), pollWarning: err?.message || 'Freebeat status gagal diperiksa.' };
    }
    if (dancePoll.pollWarning && dancePoll.nextStatus === row.status && !dancePoll.externalJobId && !dancePoll.metadata) {
      return { generation: await sanitizeGenerationRow(row, env), pollWarning: dancePoll.pollWarning };
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
      return { generation: await sanitizeGenerationRow(row, env) };
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
      return { generation: await sanitizeGenerationRow(row, env), pollWarning: 'Semua akun Alibaba gagal polling.' };
    }
  } else {
    keyRow = await fetchProviderKeyRecord(env, row.provider || 'unorouter');
    if (!keyRow?.api_key) {
      return { generation: await sanitizeGenerationRow(row, env) };
    }
    apiBase = resolveProviderApiBase(row.provider || 'unorouter', keyRow.base_url);
    pollUrl = row.polling_url || (row.external_job_id ? `${apiBase}/videos/${encodeURIComponent(row.external_job_id)}` : '');
    if (!pollUrl) {
      return { generation: await sanitizeGenerationRow(row, env) };
    }
    pollRes = await fetch(pollUrl, {
      method: 'GET',
      headers: { authorization: `Bearer ${keyRow.api_key}` },
      signal: AbortSignal.timeout(30_000),
    });
  }

  if (row.provider !== 'freebeat') {
    if (!pollRes.ok) {
      return { generation: await sanitizeGenerationRow(row, env), pollWarning: `HTTP ${pollRes.status}` };
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
  const nowIso = new Date().toISOString();
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
        updated_at: nowIso,
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
        body: { credits_refunded: 0, updated_at: new Date().toISOString() },
      }).catch(() => {});
    }
  }
  const updated = patched?.[0] || {
    ...row,
    status: nextStatus,
    progress: nextProgress,
    upstream_result_url: upstreamUrl,
    error_message: errMsg,
    ...extraPatch,
    updated_at: nowIso,
  };
  return { generation: await sanitizeGenerationRow(updated, env) };
}

const LIVE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
