// Pool akun OpenAI yang ditambahkan MANUAL oleh admin (API key platform).
//
// Kenapa manual (dan bukan "BLEA mendaftarkan akun sendiri"):
//   OpenAI tidak punya API pendaftaran akun. Satu-satunya jalan adalah
//   mengotomasi halaman signup mereka — itu melanggar ToS, langsung ditahan
//   captcha, dan akun hasilnya biasanya dinonaktifkan. Jadi BLEA tidak
//   mendaftarkan akun apa pun: admin menambahkan akun yang SUDAH ia miliki,
//   lalu pool di bawah ini memakainya bergiliran seperti pool freebeat.
//
// Perilaku pool (sama dengan freebeat_oauth_accounts / provider_key_pool):
//   • urut prioritas naik, lalu yang paling sedikit dipakai hari ini;
//   • setiap akun punya `daily_limit` per tanggal WIB; habis → akun dilewati
//     dan permintaan jatuh ke akun berikutnya;
//   • akun yang kena 401/402/403/429 diberi `cooldown_until` (10→20→40 menit,
//     maks 60) dengan `consecutive_failures` sebagai penghitung;
//   • kredensial tersegel AES-GCM dengan PROVIDER_CREDENTIAL_ENCRYPTION_KEY
//     dan tidak pernah dikirim ke browser — yang keluar hanya `token_hint`.
//
// Isolasi kapabilitas: setiap akun membawa daftar `capabilities`. Worker hanya
// boleh memilih akun yang mencantumkan kapabilitas tool yang sedang berjalan
// (chat / agent / image / video / audio / metadata). Jadi akun untuk chat tidak
// akan pernah "kebetulan" dipakai tool gambar.
import { OPENAI_CAPABILITIES } from './openaiCapabilities.js';

import {
  buildResponsesBody,
  extractResponsesText,
  isSubscriptionLimitError,
  parseResponsesEvent,
} from './openaiResponses.js';

const TABLE = '/openai_accounts';
const DEFAULT_API_BASE = 'https://api.openai.com';
// Daftar kapabilitas pool = kapabilitas tool Studio (lihat openaiCapabilities.js).
export { OPENAI_CAPABILITIES };
// 'oauth' = hasil sign-in OAuth OpenAI: tidak ada API key sama sekali, token
// hanya bisa dipakai ke Responses API teks.
export const OPENAI_CREDENTIAL_KINDS = ['api_key', 'session', 'oauth'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encoder = new TextEncoder();
const COOLDOWN_BASE_MINUTES = 10;
const COOLDOWN_MAX_MINUTES = 60;

function supabaseBase(env) {
  return (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');
}

function fail(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

// ---- Penyegelan kredensial -------------------------------------------------
function b64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const byte of arr) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64(value) {
  const s = String(value).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function credentialKey(env) {
  const secret = String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!secret) throw fail('Secret PROVIDER_CREDENTIAL_ENCRYPTION_KEY belum tersedia pada Worker.', 503);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`blea-openai-pool-v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealOpenAiToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode('openai-credential') },
    await credentialKey(env),
    encoder.encode(String(token)),
  );
  return `${b64(iv)}.${b64(ciphertext)}`;
}

export async function unsealOpenAiToken(env, sealed) {
  try {
    const parts = String(sealed || '').split('.');
    if (parts.length !== 2 || String(sealed).length > 6000) return '';
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(parts[0]), additionalData: encoder.encode('openai-credential') },
      await credentialKey(env),
      unb64(parts[1]),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return '';
  }
}

// Empat karakter terakhir saja, supaya admin bisa membedakan dua kunci tanpa
// pernah melihat kunci penuh di layar.
export function tokenHint(token) {
  const clean = String(token || '').trim();
  if (clean.length <= 4) return '';
  return `••••${clean.slice(-4)}`;
}

// ---- Waktu kuota (zona WIB) -----------------------------------------------
export function jakartaDate(now = new Date()) {
  // WIB = UTC+7 tanpa DST, jadi pergeseran tetap lebih aman daripada Intl.
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
}

function isQuotaResetDue(row, today) {
  return String(row?.quota_date || '') !== today;
}

// ---- Akses tabel -----------------------------------------------------------
async function dbRequest(env, path, options = {}) {
  let res;
  try {
    res = await fetch(`${supabaseBase(env)}/rest/v1${path}`, {
      method: options.method || 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw fail('Penyimpanan BLEA tidak dapat dihubungi.', 503);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw fail(`Penyimpanan BLEA menolak permintaan (HTTP ${res.status}). ${detail.slice(0, 200)}`.trim(), 503);
  }
  return res;
}

async function dbJson(env, path, options = {}) {
  const res = await dbRequest(env, path, options);
  return await res.json().catch(() => null);
}

async function readRows(env) {
  const rows = await dbJson(env, `${TABLE}?select=*&order=priority.asc,created_at.asc&limit=200`);
  return Array.isArray(rows) ? rows : [];
}

// ---- Normalisasi & tampilan ------------------------------------------------
function credentialKindOf(row) {
  const kind = String(row?.credential_kind || 'api_key').toLowerCase();
  return OPENAI_CREDENTIAL_KINDS.includes(kind) ? kind : 'api_key';
}

function normalizeCapabilities(value) {
  const list = Array.isArray(value) ? value : String(value || '').replace(/[{}"]/g, ',').split(',');
  const clean = list.map((item) => String(item || '').trim().toLowerCase()).filter((item) => OPENAI_CAPABILITIES.includes(item));
  return [...new Set(clean.length ? clean : ['chat'])];
}

function effectiveUsedToday(row, today = jakartaDate()) {
  if (isQuotaResetDue(row, today)) return 0;
  const used = Number(row?.used_today);
  return Number.isFinite(used) && used > 0 ? Math.trunc(used) : 0;
}

function isCoolingDown(row, now = Date.now()) {
  const until = row?.cooldown_until ? Date.parse(row.cooldown_until) : NaN;
  return Number.isFinite(until) && until > now;
}

function quotaExhausted(row, today = jakartaDate()) {
  const limit = Number(row?.daily_limit);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return effectiveUsedToday(row, today) >= limit;
}

/** Baris aman untuk browser: tanpa kredensial. */
export function sanitizeOpenAiAccount(row, now = Date.now()) {
  if (!row) return null;
  const today = jakartaDate(new Date(now));
  const used = effectiveUsedToday(row, today);
  const limit = Number.isFinite(Number(row.daily_limit)) ? Number(row.daily_limit) : 0;
  const cooling = isCoolingDown(row, now);
  const exhausted = quotaExhausted(row, today);
  const credentialKind = credentialKindOf(row);
  const enabled = row.enabled !== false;
  const enabledKind = credentialKind === 'api_key' || credentialKind === 'oauth';
  const usable = enabled && !cooling && !exhausted && enabledKind;
  let state = 'siap';
  if (!enabled) state = 'nonaktif';
  else if (!enabledKind) state = 'tidak-bisa-dipanggil';
  else if (cooling) state = 'cooldown';
  else if (exhausted) state = 'kuota-habis';
  return {
    id: row.id,
    account_email: String(row.account_email || '').trim(),
    account_label: String(row.account_label || '').trim(),
    credential_kind: credentialKind,
    api_base: String(row.api_base || DEFAULT_API_BASE),
    model_default: String(row.model_default || 'gpt-4o-mini'),
    token_hint: String(row.token_hint || ''),
    enabled,
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100,
    daily_limit: limit,
    used_today: used,
    remaining: limit > 0 ? Math.max(0, limit - used) : null,
    quota_date: today,
    capabilities: normalizeCapabilities(row.capabilities),
    consecutive_failures: Number.isFinite(Number(row.consecutive_failures)) ? Number(row.consecutive_failures) : 0,
    cooldown_until: cooling ? row.cooldown_until : null,
    last_error: typeof row.last_error === 'string' && row.last_error ? row.last_error : null,
    last_ok_at: row.last_ok_at || null,
    last_test_at: row.last_test_at || null,
    last_test_ok: row.last_test_ok === null || row.last_test_ok === undefined ? null : row.last_test_ok === true,
    state,
    usable,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

/** Daftar akun untuk halaman admin (tanpa kredensial). */
export async function listOpenAiAccounts(env) {
  const rows = await readRows(env);
  const now = Date.now();
  return rows.map((row) => sanitizeOpenAiAccount(row, now));
}

/** Ringkasan singkat untuk indikator koneksi di Studio. */
export async function openAiPoolSummary(env) {
  try {
    const accounts = await listOpenAiAccounts(env);
    return {
      total: accounts.length,
      usable: accounts.filter((account) => account.usable).length,
      capabilities: [...new Set(accounts.filter((account) => account.usable).flatMap((account) => account.capabilities))],
    };
  } catch {
    return { total: 0, usable: 0, capabilities: [] };
  }
}

// ---- Validasi input --------------------------------------------------------
function cleanText(value, max, label) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(`${label} tidak valid.`, 400);
  const clean = value.trim();
  if (clean.length > max) throw fail(`${label} maksimal ${max} karakter.`, 400);
  return clean;
}

function normalizeApiBase(value) {
  const raw = cleanText(value, 300, 'Base URL') || DEFAULT_API_BASE;
  let url;
  try { url = new URL(raw); } catch { throw fail('Base URL tidak valid. Gunakan https://api.openai.com atau base OpenAI-compatible lain.', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw fail('Base URL harus HTTPS tanpa kredensial di dalam URL.', 400);
  }
  return url.toString().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

export function validateOpenAiAccountInput(input, { requireToken = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Data akun tidak valid.', 400);
  const out = {};
  if (input.account_email !== undefined) {
    const email = cleanText(input.account_email, 320, 'Email akun');
    if (email && !EMAIL_RE.test(email)) throw fail('Masukkan alamat email yang valid.', 400);
    out.account_email = email;
  }
  if (input.account_label !== undefined) out.account_label = cleanText(input.account_label, 100, 'Label akun');
  if (input.credential_kind !== undefined) {
    const kind = String(input.credential_kind || '').trim().toLowerCase();
    if (!OPENAI_CREDENTIAL_KINDS.includes(kind)) throw fail('Jenis kredensial harus api_key, session, atau oauth.', 400);
    out.credential_kind = kind;
  }
  if (input.api_base !== undefined) out.api_base = normalizeApiBase(input.api_base);
  if (input.model_default !== undefined) {
    const model = cleanText(input.model_default, 120, 'Model default');
    if (model && !/^[a-zA-Z0-9._:-]+$/.test(model)) throw fail('Nama model hanya boleh huruf, angka, titik, garis bawah, titik dua, dan strip.', 400);
    out.model_default = model || 'gpt-4o-mini';
  }
  if (input.capabilities !== undefined) {
    if (!Array.isArray(input.capabilities)) throw fail('Kapabilitas harus berupa daftar.', 400);
    const capabilities = normalizeCapabilities(input.capabilities);
    if (!capabilities.length) throw fail('Pilih minimal satu kapabilitas.', 400);
    out.capabilities = capabilities;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw fail('Status aktif tidak valid.', 400);
    out.enabled = input.enabled;
  }
  if (input.priority !== undefined) {
    if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100000) throw fail('Prioritas harus bilangan bulat 0–100000.', 400);
    out.priority = input.priority;
  }
  if (input.daily_limit !== undefined) {
    if (!Number.isSafeInteger(input.daily_limit) || input.daily_limit < 0 || input.daily_limit > 1_000_000) throw fail('Batas harian harus bilangan bulat 0–1000000 (0 = tanpa batas).', 400);
    out.daily_limit = input.daily_limit;
  }
  if (input.token !== undefined) {
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (!token && requireToken) throw fail('Kunci/Token akun wajib diisi.', 400);
    if (token) {
      // Token OAuth panjangnya tidak diatur BLEA, jadi
      // hanya batas atas yang ditegakkan. API key tetap 12–4000 karakter.
      const minLength = String(out.credential_kind || input.credential_kind || '').toLowerCase() === 'oauth' ? 1 : 12;
      if (token.length < minLength || token.length > 4000) throw fail(`Kunci/Token akun harus ${minLength}–4000 karakter.`, 400);
      out.token = token;
    }
  } else if (requireToken) {
    throw fail('Kunci/Token akun wajib diisi.', 400);
  }
  return out;
}

// ---- Mutasi ---------------------------------------------------------------
export async function createOpenAiAccount(env, input, userId = null) {
  const clean = validateOpenAiAccountInput(input, { requireToken: true });
  const sealed_token = await sealOpenAiToken(env, clean.token);
  delete clean.token;
  const existing = await readRows(env).catch(() => []);
  const maxPriority = existing.reduce((max, row) => Math.max(max, Number(row.priority) || 0), 0);
  const body = {
    account_email: '',
    account_label: '',
    credential_kind: 'api_key',
    api_base: DEFAULT_API_BASE,
    model_default: 'gpt-4o-mini',
    capabilities: ['chat'],
    enabled: true,
    priority: Math.min(100_000, maxPriority + 10),
    daily_limit: 200,
    ...clean,
    sealed_token,
    // Metadata OAuth (hanya bila akun ini hasil login OAuth OpenAI).
    ...(clean.credential_kind === 'oauth' ? {
      oauth_client_id: typeof input.oauth_client_id === 'string' ? input.oauth_client_id.slice(0, 120) : null,
      oauth_expires_at: input.oauth_expires_at || null,
      oauth_refresh_sealed: typeof input.oauth_refresh_sealed === 'string' ? input.oauth_refresh_sealed.slice(0, 6000) : null,
    } : {}),
    token_hint: tokenHint(String(input?.token || '')),
    used_today: 0,
    quota_date: jakartaDate(),
    consecutive_failures: 0,
    cooldown_until: null,
    last_error: null,
    ...(userId ? { created_by: userId } : {}),
  };
  const rows = await dbJson(env, TABLE, { method: 'POST', prefer: 'return=representation', body });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Akun gagal disimpan.', 500);
  return sanitizeOpenAiAccount(row);
}

export function isOpenAiAccountId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function updateOpenAiAccount(env, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !isOpenAiAccountId(input.id)) {
    throw fail('ID akun tidak valid.', 400);
  }
  const allowedKeys = new Set(['id', 'account_email', 'account_label', 'credential_kind', 'api_base', 'model_default', 'capabilities', 'enabled', 'priority', 'daily_limit', 'token', 'used_today']);
  const unknown = Object.keys(input).filter((key) => !allowedKeys.has(key));
  if (unknown.length) throw fail(`Parameter tidak dikenal: ${unknown.join(', ')}`, 400);
  const clean = validateOpenAiAccountInput(input);
  const patch = { ...clean, updated_at: new Date().toISOString() };
  if (input.used_today !== undefined) {
    // Satu-satunya nilai yang masuk akal dari UI: reset kuota harian ke 0.
    if (input.used_today !== 0) throw fail('Reset kuota hanya menerima nilai 0.', 400);
    patch.used_today = 0;
    patch.quota_date = jakartaDate();
  }
  if (clean.token) {
    patch.sealed_token = await sealOpenAiToken(env, clean.token);
    patch.token_hint = tokenHint(clean.token);
    // Kunci baru berarti akun ini layak dicoba lagi.
    patch.consecutive_failures = 0;
    patch.cooldown_until = null;
    patch.last_error = null;
    delete patch.token;
  }
  if (typeof input.token === 'string' && !input.token.trim()) throw fail('Kunci/Token kosong; hapus field token bila tidak ingin menggantinya.', 400);
  const rows = await dbJson(env, `${TABLE}?id=eq.${encodeURIComponent(input.id)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: patch,
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Akun tidak ditemukan.', 404);
  return sanitizeOpenAiAccount(row);
}

export async function deleteOpenAiAccount(env, id) {
  if (!isOpenAiAccountId(id)) throw fail('ID akun tidak valid.', 400);
  await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  return { ok: true, id };
}

// ---- Pemilihan akun (round-robin + kuota + cooldown) ----------------------
// ---- OAuth OpenAI -----------------------------------------------------------
// Access token OAuth hanya 1 jam; refresh token 30 hari bergulir. Baris akun
// menyimpan `oauth_client_id` (client_id terbitan OpenAI untuk akun itu) dan
// `oauth_expires_at`. Refresh dilakukan saat token hampir habis, bukan setiap
// permintaan, supaya tidak memutar refresh token tanpa perlu.
const OAUTH_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
const OAUTH_RESOURCE = 'https://api.openai.com/v1';
const OAUTH_EXPIRY_SKEW_MS = 60_000;

function isOAuthAccessExpired(row, now = Date.now()) {
  const expires = row?.oauth_expires_at ? Date.parse(row.oauth_expires_at) : NaN;
  if (!Number.isFinite(expires)) return false;
  return expires - OAUTH_EXPIRY_SKEW_MS <= now;
}

/**
 * Putar refresh token untuk satu akun OAuth dan simpan token baru (disegel).
 * Mengembalikan access token yang siap dipakai, atau string kosong bila gagal.
 * Refresh token lama dianggap mati begitu OpenAI mengembalikan yang baru.
 */
async function refreshOAuthAccessToken(env, row) {
  if (!row?.oauth_client_id) return '';
  const refreshToken = await unsealOpenAiToken(env, row.oauth_refresh_sealed);
  if (!refreshToken) return '';
  let res;
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: String(row.oauth_client_id),
        refresh_token: refreshToken,
        resource: OAUTH_RESOURCE,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return '';
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    // Refresh ditolak → akun butuh login ulang. Cooldown panjang, jangan
    // menandai "kunci salah" karena ini bukan masalah API key.
    await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        cooldown_until: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
        last_error: 'OAuth: refresh token ditolak, sambungkan ulang lewat tombol Connect.',
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    return '';
  }
  const sealedAccess = await sealOpenAiToken(env, data.access_token);
  const patch = {
    sealed_token: sealedAccess,
    oauth_expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (data.refresh_token) patch.oauth_refresh_sealed = await sealOpenAiToken(env, data.refresh_token);
  await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: patch,
  }).catch(() => {});
  return data.access_token;
}

/**
 * Kirim payload gaya Chat Completions ke Responses API memakai access token
 * OAuth. Karena jalur ini WAJIB streaming, hasilnya dikumpulkan penuh lalu
 * dikembalikan dalam bentuk balasan Chat Completions — jadi pemanggil (chat &
 * agen) tidak perlu tahu bedanya.
 *
 * `store:false` dan `stream:true` selalu dipasang oleh buildResponsesBody.
 */
export async function sendOAuthResponses({ accessToken, model, payload, timeoutMs = 180_000 }) {
  const body = buildResponsesBody(payload, { model });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${DEFAULT_API_BASE}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}`, accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      errorInfo: {
        message: timedOut
          ? `OpenAI tidak merespons dalam ${Math.round(timeoutMs / 1000)} detik.`
          : `Tidak dapat terhubung ke OpenAI: ${String(error?.message || error).slice(0, 160)}`,
        rawDetail: String(error?.message || error),
      },
    };
  }
  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    return {
      ok: false,
      status: res.status,
      errorInfo: { message: `OpenAI menolak permintaan (HTTP ${res.status}).`, rawDetail: text.slice(0, 400) },
    };
  }

  // Konsumsi SSE Responses → kumpulkan teks + function_call + error.
  const reader = res.body?.getReader?.();
  if (!reader) {
    clearTimeout(timer);
    return { ok: false, status: 502, errorInfo: { message: 'Stream OpenAI tidak tersedia.', rawDetail: '' } };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let thinking = '';
  let failed = null;
  let finalResponse = null;
  const toolCalls = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() || '');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue;
        const chunk = line.slice(5).trim();
        if (!chunk || chunk === '[DONE]') continue;
        let parsed;
        try { parsed = JSON.parse(chunk); } catch { continue; }
        const event = parseResponsesEvent(parsed);
        for (const item of event.events) {
          if (item.type === 'delta') text += item.text;
          if (item.type === 'thinking') thinking += item.text;
        }
        if (parsed?.type === 'response.output_item.done' && parsed.item?.type === 'function_call') {
          toolCalls.push({
            id: parsed.item.call_id || parsed.item.id || `call_${toolCalls.length}`,
            type: 'function',
            function: { name: String(parsed.item.name || ''), arguments: String(parsed.item.arguments || '{}') },
          });
        }
        if (event.response) finalResponse = event.response;
        if (event.failed) failed = event.failed;
        if (event.done) break;
      }
      if (done || failed) break;
      if (finalResponse) break;
    }
  } catch (error) {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    return { ok: false, status: 502, errorInfo: { message: `Stream OpenAI terputus: ${String(error?.message || error).slice(0, 160)}`, rawDetail: '' } };
  }
  clearTimeout(timer);
  await reader.cancel().catch(() => {});

  if (failed) {
    return {
      ok: false,
      status: isSubscriptionLimitError(failed.code, failed.message) ? 429 : 502,
      errorInfo: { message: failed.message, rawDetail: `${failed.code} ${failed.message}` },
    };
  }
  const finalText = text || extractResponsesText(finalResponse);
  if (!finalText && !toolCalls.length) {
    return { ok: false, status: 502, errorInfo: { message: 'Model mengembalikan respons kosong.', rawDetail: '' } };
  }
  return {
    ok: true,
    status: res.status,
    data: {
      id: finalResponse?.id || '',
      model: finalResponse?.model || model,
      choices: [{
        index: 0,
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: finalText,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
      }],
      ...(thinking ? { blea_reasoning: thinking } : {}),
    },
  };
}

/**
 * Akun berikutnya yang boleh dipakai untuk `capability`.
 * Urutan: prioritas naik → paling sedikit dipakai hari ini → paling lama dibuat.
 * Mengembalikan kredensial siap pakai (server-side saja) atau null.
 */
export async function pickOpenAiAccount(env, { capability = 'chat', exclude = [] } = {}) {
  const cap = String(capability || 'chat').toLowerCase();
  if (!OPENAI_CAPABILITIES.includes(cap)) return null;
  // `env.OPENAI_POOL_DISABLED` = tombol darurat: pool berhenti dipakai tanpa
  // menghapus akun, sehingga provider lain langsung kembali menjadi jalur utama.
  // Ini juga yang membuat worker jatuh ke perilaku lama bila tabel pool belum
  // dimigrasikan.
  if (env?.OPENAI_POOL_DISABLED === '1' || env?.OPENAI_POOL_DISABLED === 'true') return null;
  let rows;
  try {
    rows = await dbJson(
      env,
      `${TABLE}?select=id,account_email,account_label,credential_kind,api_base,model_default,sealed_token,oauth_expires_at,oauth_client_id,oauth_refresh_sealed,capabilities,enabled,priority,daily_limit,used_today,quota_date,cooldown_until,consecutive_failures&enabled=eq.true&order=priority.asc,created_at.asc&limit=100`,
    );
  } catch {
    return null;
  }
  if (!Array.isArray(rows) || !rows.length) return null;
  const now = Date.now();
  const today = jakartaDate(new Date(now));
  const skip = new Set(exclude);
  const candidates = rows
    .filter((row) => ['api_key', 'oauth'].includes(credentialKindOf(row)))
    .filter((row) => !skip.has(row.id))
    .filter((row) => (Array.isArray(row.capabilities) ? row.capabilities : normalizeCapabilities(row.capabilities)).includes(cap))
    .filter((row) => !isCoolingDown(row, now))
    .filter((row) => !quotaExhausted(row, today))
    .sort((a, b) => {
      const priority = (Number(a.priority) || 100) - (Number(b.priority) || 100);
      if (priority !== 0) return priority;
      const used = effectiveUsedToday(a, today) - effectiveUsedToday(b, today);
      if (used !== 0) return used;
      return Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0);
    });
  for (const row of candidates) {
    let token = await unsealOpenAiToken(env, row.sealed_token);
    if (!token) continue;
    // Token OAuth kedaluwarsa (1 jam) → putar refresh token sebelum dipakai.
    if (credentialKindOf(row) === 'oauth' && isOAuthAccessExpired(row)) {
      token = await refreshOAuthAccessToken(env, row).catch(() => '');
      if (!token) continue;
    }
    return {
      id: row.id,
      accountEmail: row.account_email || '',
      accountLabel: row.account_label || '',
      apiKey: token,
      apiBase: String(row.api_base || DEFAULT_API_BASE).replace(/\/+$/, ''),
      model: String(row.model_default || ''),
      capability: cap,
      // Akun OAuth tidak memakai API key/platform: token
      // hanya sah untuk Responses API teks dengan store:false & stream:true.
      oauth: credentialKindOf(row) === 'oauth',
    };
  }
  return null;
}

/** Semua akun yang bisa dipakai untuk satu kapabilitas, urut sesuai pool. */
export async function pickOpenAiAccountsFor(env, { capability = 'chat', limit = 5 } = {}) {
  const picked = [];
  const exclude = [];
  for (let i = 0; i < Math.max(1, Math.min(10, limit)); i += 1) {
    const account = await pickOpenAiAccount(env, { capability, exclude });
    if (!account) break;
    picked.push(account);
    exclude.push(account.id);
  }
  return picked;
}

/**
 * Panggil /chat/completions dengan failover lintas akun (round-robin).
 *
 * `send` adalah fungsi worker (sendChatCompletionRequest) yang diinject supaya
 * modul ini tidak bergantung pada worker.js. Untuk setiap akun pool:
 *   • sukses → catat pemakaian (kuota naik), kembalikan hasilnya;
 *   • gagal yang berarti akun bermasalah (401/402/403/429) → cooldown, catat,
 *     lalu lanjut ke akun berikutnya;
 *   • gagal karena permintaan salah (400 format) → berhenti, akun tidak disalahkan.
 * Bila pool kosong atau semua akun gagal, `attempt`/`account` berisi hasil
 * terakhir supaya pemanggil bisa melanjutkan ke provider lain.
 */
export async function sendWithOpenAiPool({
  env,
  capability = 'chat',
  model = '',
  payload,
  timeoutMs = 60_000,
  stream = false,
  send,
  maxAccounts = 4,
}) {
  const accounts = await pickOpenAiAccountsFor(env, { capability, limit: maxAccounts });
  if (!accounts.length) return { attempted: false, accounts: 0, attempt: null, account: null };
  let lastAttempt = null;
  let lastAccount = null;
  for (const account of accounts) {
    // Akun OAuth tidak punya API key dan hanya boleh memanggil Responses API
    // (store:false, stream:true). Akun API key tetap ke /chat/completions.
    const attempt = account.oauth
      ? await sendOAuthResponses({
        accessToken: account.apiKey,
        model: model || account.model || 'gpt-5.1',
        payload,
        timeoutMs,
      })
      : await send({
        provider: 'openai',
        model: model || account.model || 'gpt-4o-mini',
        apiKey: account.apiKey,
        baseUrl: `${account.apiBase}/v1`,
        payload,
        timeoutMs,
        env,
        stream,
      });
    const detail = [attempt?.errorInfo?.rawDetail, attempt?.errorInfo?.message].filter(Boolean).join(' ');
    if (attempt?.ok) {
      await recordOpenAiUsage(env, account.id, { ok: true, status: attempt.status, counted: true });
      return { attempted: true, accounts: accounts.length, attempt, account };
    }
    lastAttempt = attempt;
    lastAccount = account;
    await recordOpenAiUsage(env, account.id, {
      ok: false,
      status: attempt?.status || 0,
      error: detail || `HTTP ${attempt?.status || 0}`,
      counted: true,
    });
    if (!isOpenAiPoolFailure(attempt?.status, detail)) break;
  }
  return { attempted: true, accounts: accounts.length, attempt: lastAttempt, account: lastAccount };
}

// Kode yang berarti "akun ini tidak bisa dipakai sekarang" → cooldown + akun
// berikutnya. Kode lain (400 format, 404 model) bukan salah akun.
export function isOpenAiPoolFailure(status, detail = '') {
  if ([401, 402, 403, 429, 503].includes(Number(status))) return true;
  return /insufficient_quota|quota|rate.?limit|billing|exceeded|deactivated|invalid_api_key/i.test(String(detail || ''));
}

/**
 * Catat hasil pemakaian akun. Best-effort: kegagalan menulis status tidak
 * boleh menggagalkan permintaan pengguna.
 */
export async function recordOpenAiUsage(env, id, { ok = false, status = 0, error = '', counted = false } = {}) {
  if (!isOpenAiAccountId(id)) return;
  try {
    const rows = await dbJson(env, `${TABLE}?select=id,used_today,quota_date,daily_limit,consecutive_failures&id=eq.${encodeURIComponent(id)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return;
    const now = new Date();
    const today = jakartaDate(now);
    const used = counted ? (isQuotaResetDue(row, today) ? 0 : effectiveUsedToday(row, today)) + 1 : effectiveUsedToday(row, today);
    const patch = {
      used_today: used,
      quota_date: today,
      updated_at: now.toISOString(),
    };
    if (ok) {
      Object.assign(patch, { consecutive_failures: 0, cooldown_until: null, last_error: null, last_ok_at: now.toISOString() });
    } else if (isOpenAiPoolFailure(status, error)) {
      const failures = (Number(row.consecutive_failures) || 0) + 1;
      const minutes = Math.min(COOLDOWN_MAX_MINUTES, COOLDOWN_BASE_MINUTES * (2 ** Math.min(failures - 1, 3)));
      Object.assign(patch, {
        consecutive_failures: failures,
        cooldown_until: new Date(now.getTime() + minutes * 60_000).toISOString(),
        last_error: String(error || `HTTP ${status}`).slice(0, 300),
      });
    } else if (error) {
      patch.last_error = String(error).slice(0, 300);
    }
    await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
  } catch { /* status pool bersifat informatif, bukan jalur kritis */ }
}

// ---- Uji koneksi satu akun ------------------------------------------------
/**
 * Uji akun dengan panggilan resmi termurah: GET /v1/models.
 * Akun berjenis 'session' tidak diuji ke API publik — token sesi konsumen bukan
 * kredensial API, jadi hasilnya SELALU dilaporkan apa adanya, bukan dipaksa
 * "berhasil" agar halaman terlihat hijau.
 */
export async function testOpenAiAccount(env, id) {
  if (!isOpenAiAccountId(id)) throw fail('ID akun tidak valid.', 400);
  const rows = await dbJson(env, `${TABLE}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Akun tidak ditemukan.', 404);
  const nowIso = new Date().toISOString();
  const finish = async (ok, message, status = null) => {
    await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        last_test_at: nowIso,
        last_test_ok: ok,
        ...(ok ? { last_ok_at: nowIso, consecutive_failures: 0, cooldown_until: null, last_error: null } : {}),
        updated_at: nowIso,
      },
    }).catch(() => {});
    return { ok, message, status };
  };
  if (credentialKindOf(row) === 'session') {
    return await finish(false, 'Akun berjenis token sesi tidak bisa diuji lewat API resmi. Pakai tombol Connect (OAuth) atau API key platform.openai.com.', null);
  }
  if (credentialKindOf(row) === 'oauth') {
    // Uji jalur OAuth dengan /v1/models memakai access token; sekaligus
    // memastikan token belum kedaluwarsa (kalau ya, refresh dulu).
    let token = await unsealOpenAiToken(env, row.sealed_token);
    if (!token) return await finish(false, 'Token OAuth tidak bisa dibuka (kunci enkripsi Worker berubah). Sambungkan ulang akun.', null);
    if (isOAuthAccessExpired(row)) token = await refreshOAuthAccessToken(env, row).catch(() => '');
    if (!token) return await finish(false, 'Token OAuth kedaluwarsa dan refresh gagal. Sambungkan ulang akun lewat tombol Connect.', 401);
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/models', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return await finish(false, `Tidak bisa menghubungi OpenAI: ${String(error?.message || error).slice(0, 160)}`, null);
    }
    if (res.ok) {
      await res.body?.cancel?.().catch?.(() => {});
      return await finish(true, 'Token OAuth OpenAI diterima (Responses API teks).', res.status);
    }
    const text = await res.text().catch(() => '');
    return await finish(false, `OpenAI menolak token OAuth (HTTP ${res.status}). ${text.slice(0, 200)}`.trim(), res.status);
  }
  const token = await unsealOpenAiToken(env, row.sealed_token);
  if (!token) return await finish(false, 'Kredensial akun tidak bisa dibuka (kunci enkripsi Worker berubah). Masukkan ulang kunci.', null);
  const base = String(row.api_base || DEFAULT_API_BASE).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(`${base}/v1/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return await finish(false, `Tidak bisa menghubungi ${base}: ${String(error?.message || error).slice(0, 160)}`, null);
  }
  if (res.ok) {
    await res.body?.cancel().catch?.(() => {});
    return await finish(true, 'Kunci diterima API OpenAI.', res.status);
  }
  const text = await res.text().catch(() => '');
  return await finish(false, `API menolak kunci (HTTP ${res.status}). ${text.slice(0, 200)}`.trim(), res.status);
}
