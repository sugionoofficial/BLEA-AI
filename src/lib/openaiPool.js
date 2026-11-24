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
  openAiResponsesModelCatalog,
  parseResponsesEvent,
  planModelFromCatalog,
  planUsageFailure,
} from './openaiResponses.js';

// Dipakai juga saat pendaftaran OAuth (openaiOAuth.js) untuk memilih model dari
// katalog akun, dan oleh Uji. Diekspor ulang supaya hanya ada satu sumber.
export { openAiResponsesModelCatalog, planModelFromCatalog, planUsageFailure };

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
// Cooldown untuk 429 = batas laju, bukan kunci mati. Cukup untuk melewati
// jendela rate limit, tanpa membuat akun tampak "kuota habis" selama sejam.
const RATE_LIMIT_COOLDOWN_MINUTES = 1;
// Berapa kali kegagalan sejenis harus berulang sebelum akun berhenti dicoba
// sampai keadaan itu diperbaiki. Billing = 1 karena pesan OpenAI definitif
// ("you have no credits remaining"); kunci ditolak butuh 3 karena kunci
// pengganti kadang butuh waktu menyebar di sisi OpenAI.
const BILLING_STALE_FAILURES = 1;
// Model termurah untuk uji saldo. Override lewat env bila akun tidak punya akses
// ke model ini, supaya "Uji" tidak menjadi palsu-gagal.
const PROBE_MODEL = 'gpt-4o-mini';
// Model probe yang TIDAK ADA di akun menjawab 404 `model_not_found`, bukan
// kredit habis. Dulu hasil itu diabaikan dan Uji tetap melaporkan "berhasil"
// walau chat-nya sendiri gagal. Sekarang model akun dicoba lebih dulu.
const MODEL_MISSING_RE = /model_not_found|does not exist|unsupported_model|unknown model|invalid model|not have access to model/i;
const AUTH_STALE_FAILURES = 3;

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

// Parameter AES-GCM. HARUS tetap seperti ini: token yang sudah tersegel di
// database hanya bisa dibuka dengan kunci + additionalData yang sama persis.
// `v1` dan `AAD_V1` sengaja dipertahankan supaya akun lama tidak perlu diisi
// ulang; format baru pakai `v2` + `AAD_V2`.
const KEY_INFO_V1 = 'blea-openai-pool-v1';
const KEY_INFO_V2 = 'blea-openai-pool-v2';
const AAD_V1 = 'openai-credential';
const AAD_V2 = 'blea:openai:credential:v2';
// Derivation string SEBELUM rename produk. Nilainya tidak boleh diubah: token
// yang disegel sebelum rename hanya bisa dibuka dengan ini. Disimpan sebagai
// base64 karena isinya nama lama, bukan rahasia. Setiap kali berhasil dibuka,
// segelnya ditulis ulang ke format sekarang (readOpenAiSealedField), jadi
// konstanta ini hanya dipakai sekali per baris dan bisa dihapus setelah tidak
// ada lagi baris berformat lama.
const KEY_INFO_V0 = atob('YmxlYS1jaGF0Z3B0LXBvb2wtdjE=');
const AAD_V0 = atob('Y2hhdGdwdC1jcmVkZW50aWFs');

async function importCredentialKey(secret, info) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${info}:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encryptionSecret(env) {
  const secret = String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!secret) throw fail('Secret PROVIDER_CREDENTIAL_ENCRYPTION_KEY belum tersedia pada Worker.', 503);
  return secret;
}

export async function sealOpenAiToken(env, token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(AAD_V2) },
    await importCredentialKey(encryptionSecret(env), KEY_INFO_V2),
    encoder.encode(String(token)),
  );
  return `${b64(iv)}.${b64(ciphertext)}`;
}

/**
 * Buka token tersegel. Menerima format sekarang (v2) DAN format lama (v1) —
 * urutan percobaan: v2/AAD_V2 → v1/AAD_V1 → v1/AAD_V2.
 *
 * Kenapa tiga percobaan: ciphertext lama terikat pada kunci dan additionalData
 * saat disegel. Bila salah satu berubah tanpa jalur baca lama, hasilnya string
 * kosong — dan gejalanya menyesatkan ("API key belum dikonfigurasi") padahal
 * akun ada. Membaca lama lalu menulis ulang ke format sekarang membuat satu
 * kali gagal-baca pun tidak menghilangkan kredensial.
 */
export async function unsealOpenAiToken(env, sealed) {
  const parts = String(sealed || '').split('.');
  if (parts.length !== 2 || String(sealed).length > 6000) return '';
  const secret = String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!secret) return '';
  let iv;
  let data;
  try {
    iv = unb64(parts[0]);
    data = unb64(parts[1]);
  } catch {
    return '';
  }
  const attempts = [
    { info: KEY_INFO_V2, aad: AAD_V2 },
    { info: KEY_INFO_V1, aad: AAD_V1 },
    { info: KEY_INFO_V1, aad: AAD_V2 },
    { info: KEY_INFO_V0, aad: AAD_V0 },
  ];
  for (const attempt of attempts) {
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(attempt.aad) },
        await importCredentialKey(secret, attempt.info),
        data,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      // Coba format berikutnya. Gagal semua = segel tidak bisa dibuka dengan
      // secret ini (mis. secret Worker diganti).
    }
  }
  return '';
}

/**
 * Baca token sekaligus menaikkan segel lama ke format sekarang. `id` + kolom
 * tujuan opsional: bila penguraian berhasil lewat format lama, baris diperbarui
 * supaya pemanggilan berikutnya tidak lagi mencoba jalur kompatibilitas.
 */
export async function readOpenAiSealedField(env, sealed, { table, id, column } = {}) {
  const token = await unsealOpenAiToken(env, sealed);
  if (!token || !table || !id || !column) return token;
  try {
    const resealed = await sealOpenAiToken(env, token);
    if (resealed !== sealed) {
      await dbJson(env, `${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        prefer: 'return=minimal',
        body: { [column]: resealed },
      });
    }
  } catch {
    // Naik-format bersifat pemeliharaan: kegagalannya tidak boleh menggagalkan
    // permintaan yang tokennya sudah berhasil dibuka.
  }
  return token;
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

/**
 * Kenapa akun ini masih dilewati walau `cooldown_until` sudah lewat.
 *
 * Cooldown adalah satuan WAKTU, sedangkan "kredit habis" dan "kunci ditolak"
 * adalah keadaan yang tidak berubah hanya karena waktu berjalan. Dulu keduanya
 * bergantung pada `cooldown_until` saja: begitu jamnya lewat, akun dianggap
 * siap, dipanggil lagi, gagal 429 lagi, lalu di-cooldown lagi — dari layar
 * kelihatan seperti "akun sedang cooldown" terus tanpa sebab yang jelas.
 *
 * Mengembalikan null bila tidak ada penghalang lama.
 */
export function stalePoolBlock(row, now = Date.now()) {
  if (withinCooldownWindow(row, now)) return null; // masih cooldown biasa, itu sebabnya
  if (!row?.last_error) return null;
  const message = String(row.last_error).slice(0, 300);
  const failures = Number(row?.consecutive_failures) || 0;
  // Jalur paket akun (OAuth): `not_eligible` berarti akun/workspace ini tidak
  // boleh membagikan paketnya. Sekali saja sudah cukup — mengulang login tidak
  // mengubah keputusan OpenAI, jadi menunggu cooldown juga tidak ada gunanya.
  if (classifyOpenAiFailure(403, row.last_error) === 'plan_not_eligible') {
    return { kind: 'plan_not_eligible', reason: 'plan_not_eligible', message };
  }
  const kind = classifyOpenAiFailure(429, row.last_error);
  if (kind === 'billing' && failures >= BILLING_STALE_FAILURES) {
    return { kind, reason: 'billing', message };
  }
  if (kind === 'auth' && failures >= AUTH_STALE_FAILURES) {
    return { kind, reason: 'auth', message };
  }
  return null;
}

/**
 * Cooldown yang masih berlaku untuk penjadwalan. `stalePoolBlock` membuat akun
 * dengan kredit habis/kunci mati TIDAK pernah dipilih lagi sampai diperbaiki —
 * jadi satu akun bermasalah tidak lagi menghabiskan satu percobaan pengguna
 * setiap kali cooldown-nya habis.
 */
function withinCooldownWindow(row, now = Date.now()) {
  const until = row?.cooldown_until ? Date.parse(row.cooldown_until) : NaN;
  return Number.isFinite(until) && until > now;
}

function isCoolingDown(row, now = Date.now()) {
  if (withinCooldownWindow(row, now)) return true;
  return stalePoolBlock(row, now) !== null;
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
  const blocked = stalePoolBlock(row, now);
  const cooling = isCoolingDown(row, now) && !blocked;
  const exhausted = quotaExhausted(row, today);
  const credentialKind = credentialKindOf(row);
  const enabled = row.enabled !== false;
  const enabledKind = credentialKind === 'api_key' || credentialKind === 'oauth';
  const usable = enabled && !cooling && !blocked && !exhausted && enabledKind;
  // Urutan penting: keadaan PERMANEN (kredit habis / kunci ditolak) lebih dulu
  // daripada cooldown. "Cooldown" membuat admin menunggu, padahal menunggu
  // tidak akan memulihkan kredit.
  let state = 'siap';
  if (!enabled) state = 'nonaktif';
  else if (!enabledKind) state = 'tidak-bisa-dipanggil';
  else if (exhausted) state = 'kuota-habis';
  else if (blocked?.kind === 'billing') state = 'kredit-habis';
  else if (blocked?.kind === 'auth') state = 'kunci-ditolak';
  else if (blocked?.kind === 'plan_not_eligible') state = 'paket-tidak-boleh';
  else if (cooling) state = 'cooldown';
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
    // Penghalang permanen: UI memakainya untuk menampilkan sebab + tombol
    // perbaikan, bukan sekadar "cooldown".
    blocked_reason: blocked?.reason || null,
    // Akun OAuth: pakai katalog milik akun, bukan tebakan. `api_key` false.
    oauth: credentialKind === 'oauth',
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

function emptyStaleCounts() {
  return {
    stale_accounts: [],
    retry_after_sec: 0,
    last_error: '',
  };
}

// Catat akun yang terhalang permanen (kredit habis / kunci ditolak) supaya
// pesan error menyebut SEBAB + tindakannya, bukan "cooldown".
function registerStale(counts, row, kind) {
  counts.stale_accounts.push({
    id: row.id,
    label: String(row.account_label || row.account_email || String(row.id || '').slice(0, 8)),
    reason: kind,
    error: String(row.last_error || '').slice(0, 300),
  });
  if (!counts.last_error && row.last_error) counts.last_error = String(row.last_error).slice(0, 300);
}

/**
 * Diagnosa kenapa sebuah kapabilitas tidak bisa dipakai. Hanya menghitung,
 * tidak membuka token, jadi aman dipanggil saat menyusun pesan error.
 * `sealed_missing` menandakan segel ada di DB tetapi tidak bisa dibuka dengan
 * secret Worker sekarang — kasus yang dulu menyamar sebagai "belum
 * dikonfigurasi".
 */
export async function openAiPoolDiagnostic(env, capability = 'chat') {
  const cap = String(capability || 'chat').toLowerCase();
  let rows;
  try {
    rows = await readRows(env);
  } catch {
    return { readable: false, total: 0, match_capability: 0, enabled: 0, unsupported_kind: 0, cooling: 0, quota_exhausted: 0, sealed_missing: 0, usable: 0 };
  }
  const now = Date.now();
  const today = jakartaDate(new Date(now));
  const counts = {
    readable: true, total: rows.length, match_capability: 0, enabled: 0,
    unsupported_kind: 0, cooling: 0, quota_exhausted: 0, sealed_missing: 0, usable: 0,
    // Penghalang yang TIDAK hilang hanya karena waktu berjalan.
    billing: 0, unauthorized: 0, plan_not_eligible: 0,
    ...emptyStaleCounts(),
  };
  for (const row of rows) {
    const caps = Array.isArray(row.capabilities) ? row.capabilities : normalizeCapabilities(row.capabilities);
    if (!caps.includes(cap)) continue;
    counts.match_capability += 1;
    if (row.enabled !== true) continue;
    counts.enabled += 1;
    // Sama seperti pickOpenAiAccount: hanya kredensial yang bisa dipanggil.
    if (!['api_key', 'oauth'].includes(credentialKindOf(row))) { counts.unsupported_kind += 1; continue; }
    // Kredit habis / kunci ditolak disebut sebagai dirinya sendiri, bukan
    // "cooldown": menunggu tidak akan memulihkannya.
    const stale = stalePoolBlock(row, now);
    if (stale?.kind === 'billing') { counts.billing += 1; registerStale(counts, row, 'billing'); continue; }
    if (stale?.kind === 'auth') { counts.unauthorized += 1; registerStale(counts, row, 'auth'); continue; }
    if (stale?.kind === 'plan_not_eligible') { counts.plan_not_eligible += 1; registerStale(counts, row, 'plan_not_eligible'); continue; }
    if (isCoolingDown(row, now)) { counts.cooling += 1; continue; }
    if (quotaExhausted(row, today)) { counts.quota_exhausted += 1; continue; }
    if (!row.sealed_token) { counts.sealed_missing += 1; continue; }
    // Uji apakah segel bisa dibuka dengan secret sekarang.
    const token = await unsealOpenAiToken(env, row.sealed_token);
    if (!token) { counts.sealed_missing += 1; continue; }
    // Akun OAuth: access token berumur 1 jam, jadi yang menentukan bisa
    // dipakai adalah refresh token-nya. Kalau itu pun tak terbuka, akun akan
    // dilewati `pickOpenAiAccount` dan pesan error harus menyebutkannya.
    if (credentialKindOf(row) === 'oauth' && isOAuthAccessExpired(row, now)) {
      const refresh = await unsealOpenAiToken(env, row.oauth_refresh_sealed);
      if (!refresh) { counts.sealed_missing += 1; continue; }
    }
    counts.usable += 1;
  }
  // Kalau satu-satunya penghalang adalah cooldown, sebutkan berapa lama lagi —
  // "tunggu sebentar" tanpa angka membuat admin menebak.
  if (!counts.billing && !counts.unauthorized && !counts.plan_not_eligible && counts.cooling) {
    const waits = rows
      .filter((row) => isCoolingDown(row, now))
      .map((row) => (Date.parse(row.cooldown_until || '') - now) / 1000)
      .filter((sec) => Number.isFinite(sec) && sec > 0);
    counts.retry_after_sec = waits.length ? Math.ceil(Math.min(...waits)) : 0;
  }
  return counts;
}

/**
 * Pesan penolakan untuk pool yang tidak bisa melayani `capability`.
 * Dipakai `/api/agent` dan `/api/chat` supaya keduanya tidak lagi menjawab
 * "API key belum dikonfigurasi" ketika akunnya sebenarnya ada tetapi terhalang
 * (nonaktif, cooldown, kuota habis, atau segel tak terbuka).
 * Mengembalikan null bila pool benar-benar kosong — pemanggil memakai pesan
 * "belum ada akun" yang lebih tepat.
 */
export async function openAiPoolBlockedMessage(env, capability = 'chat') {
  const cap = String(capability || 'chat').toLowerCase();
  const pool = await openAiPoolDiagnostic(env, cap).catch(() => null);
  if (!pool || !pool.total) return null;
  const label = cap === 'agent' ? 'Agen' : cap.charAt(0).toUpperCase() + cap.slice(1);
  const blockers = [];
  if (pool.match_capability === 0) blockers.push(`tidak ada akun dengan kapabilitas "${label}" dicentang`);
  if (pool.match_capability > 0 && pool.enabled === 0) blockers.push('semua akun yang cocok sedang nonaktif');
  if (pool.unsupported_kind) blockers.push(`${pool.unsupported_kind} akun memakai jenis kredensial yang tidak bisa dipanggil`);
  // Sebab permanen disebut lebih dulu dan dengan tindakannya: inilah yang
  // membuat pesan "sedang cooldown" terus muncul padahal yang habis kredit.
  if (pool.billing) {
    blockers.push(`${pool.billing} akun kehabisan kredit OpenAI — isi saldo di platform.openai.com → Billing, lalu tekan Uji`);
  }
  if (pool.unauthorized) {
    blockers.push(`${pool.unauthorized} akun ditolak OpenAI (kunci tidak valid) — ganti API key-nya, lalu tekan Uji`);
  }
  if (pool.plan_not_eligible) {
    // Permanen untuk akun ini: mengulang login OAuth tidak menolong.
    blockers.push(
      `${pool.plan_not_eligible} akun OAuth memakai paket yang tidak bisa dibagikan ke aplikasi lain `
      + '(paket Plus/Pro pada akun pribadi saja; akun Free/Go tidak bisa, workspace Business/Enterprise perlu izin admin) '
      + '— tambahkan API key dengan saldo atau login dengan akun Plus/Pro, bukan mengulangi tombol Connect',
    );
  }
  if (pool.cooling) {
    const wait = Number(pool.retry_after_sec) || 0;
    blockers.push(wait > 0
      ? `${pool.cooling} akun sedang cooldown sementara (±${wait} detik lagi)`
      : `${pool.cooling} akun sedang cooldown sementara`);
  }
  if (pool.quota_exhausted) blockers.push(`${pool.quota_exhausted} akun sudah habis kuota harian BLEA — reset kuota atau tunggu tanggal WIB berikutnya`);
  if (pool.sealed_missing) blockers.push(`${pool.sealed_missing} akun tersegel dengan secret lain — simpan ulang API key-nya`);
  const permanent = pool.billing || pool.unauthorized || pool.plan_not_eligible;
  return {
    // Kredit habis / kunci mati tidak akan membaik dengan menunggu; kode
    // berbeda supaya klien bisa membedakan tindakannya (bukan "coba lagi").
    status: 503,
    code: permanent ? 'openai_pool_needs_attention' : 'openai_pool_not_usable',
    error: `Akun OpenAI ada ${pool.total} di pool, ${pool.usable} siap dipakai: ${blockers.join('; ') || 'tidak ada yang lolos penyaringan pool'}.`,
    hint: pool.plan_not_eligible
      ? 'Jalur OAuth hanya memakai paket Plus/Pro pada akun pribadi. Untuk akun Free, satu-satunya jalan adalah API key dengan saldo prabayar.'
      : undefined,
    pool,
  };
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
    // Metadata OAuth (hanya bila akun ini hasil login OAuth OpenAI). Refresh
    // token disegel disimpan di sini; kolomnya harus ada di tabel yang
    // di-migrasikan, kalau tidak seluruh penyimpanan akun ditolak PostgREST.
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
  const refreshToken = await readOpenAiSealedField(env, row.oauth_refresh_sealed, { table: TABLE, id: row.id, column: 'oauth_refresh_sealed' });
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
export async function sendOAuthResponses({ accessToken, model, payload, timeoutMs = 180_000, catalogFallback = true }) {
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
    // Model yang tidak ada di akun ini bukan "akun rusak": jalur paket memakai
    // katalog per-akun, sedangkan `model_default` bisa saja tebakan. Baca
    // katalog akun lalu ulangi SEKALI dengan model yang benar-benar dimiliki.
    const modelMissing = /model_not_found|does not exist|unsupported_model|unknown model|invalid model/i.test(String(text || ''));
    if (modelMissing && catalogFallback) {
      const catalog = await openAiResponsesModelCatalog(accessToken);
      const better = planModelFromCatalog({ models: catalog }, body.model);
      if (better && better !== body.model) {
        const retry = await sendOAuthResponses({
          accessToken,
          model: better,
          payload,
          timeoutMs,
          catalogFallback: false,
        });
        // Sebut model yang dipakai supaya pesan berikutnya tidak membingungkan.
        if (retry?.data && typeof retry.data === 'object') retry.data.model_used = better;
        return retry;
      }
    }
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
    // `readOpenAiSealedField` membaca format lama maupun baru, lalu menulis
    // ulang ke format sekarang (lihat unsealOpenAiToken).
    let token = await readOpenAiSealedField(env, row.sealed_token, { table: TABLE, id: row.id, column: 'sealed_token' });
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
  if (!accounts.length) return { attempted: false, accounts: 0, attempt: null, account: null, failures: [] };
  let lastAttempt = null;
  let lastAccount = null;
  // Kegagalan per akun, supaya pemanggil bisa menyebut SEBAB yang benar
  // (batas laju vs billing vs kunci ditolak) alih-alih satu kalimat generik.
  const failures = [];
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
      return { attempted: true, accounts: accounts.length, attempt, account, failures };
    }
    lastAttempt = attempt;
    lastAccount = account;
    failures.push({
      id: account.id,
      label: account.accountLabel || account.accountEmail || account.id.slice(0, 8),
      status: Number(attempt?.status) || 0,
      detail: detail || `HTTP ${attempt?.status || 0}`,
      kind: classifyOpenAiFailure(attempt?.status, detail),
    });
    await recordOpenAiUsage(env, account.id, {
      ok: false,
      status: attempt?.status || 0,
      error: detail || `HTTP ${attempt?.status || 0}`,
      counted: true,
    });
    if (!isOpenAiPoolFailure(attempt?.status, detail)) break;
  }
  return { attempted: true, accounts: accounts.length, attempt: lastAttempt, account: lastAccount, failures };
}

// Kode yang berarti "akun ini tidak bisa dipakai sekarang" → cooldown + akun
// berikutnya. Kode lain (400 format, 404 model) bukan salah akun.
export function isOpenAiPoolFailure(status, detail = '') {
  // Paket akun OAuth: `not_eligible` (403) dan batas paket (429) berarti akun
  // INI tidak bisa dipakai, jadi pool harus lanjut ke akun berikutnya.
  if (classifyOpenAiFailure(status, detail) === 'plan_not_eligible') return true;
  if ([401, 402, 403, 429, 503].includes(Number(status))) return true;
  return /insufficient_quota|quota|rate.?limit|billing|exceeded|deactivated|invalid_api_key/i.test(String(detail || ''));
}

/**
 * Kenapa satu akun gagal dipanggil. Ini yang membedakan pesan yang benar:
 *   • 'auth'      → kunci ditolak (401/403): akun memang tidak bisa dipakai.
 *   • 'billing'   → kredit/billing habis (402 ataupun 429 berisi
 *                   `insufficient_quota`/`billing`): pengisian ulang di
 *                   platform OpenAI yang dibutuhkan, bukan menunggu.
 *   • 'rate_limit'→ kena batas LAJU (429 murni, mis.
 *                   `rate_limit_exceeded`/`too many requests`): sebentar lagi
 *                   pulih sendiri, jadi menyuruh "tambah saldo" menyesatkan.
 *   • 'other'     → sisanya (5xx, gangguan).
 *
 * Kenapa perlu dipisah: dulu semua 429 diperlakukan sama, sehingga akun yang
 * hanya kena rate limit singkat dilaporkan sebagai "kuota habis / tambah
 * saldo". Pengguna lalu mencari masalah billing yang tidak ada.
 */
export function classifyOpenAiFailure(status, detail = '') {
  const http = Number(status) || 0;
  const text = String(detail || '');
  // Jalur paket akun (OAuth) DIPERIKSA PALING AWAL. Kode `subscription_sharing_*`
  // mengandung kata "usage_limit", sehingga kalau urutannya di bawah, ia
  // tertangkap pola billing → pesannya jadi "isi saldo", padahal akun OAuth
  // tidak punya saldo sama sekali. Dulu juga jatuh ke 403 → "kunci ditolak",
  // padahal kuncinya sehat; yang menolak adalah keputusan paket.
  const planFailure = planUsageFailure(http, text);
  if (planFailure) {
    if (planFailure.reason === 'not_eligible') return 'plan_not_eligible';
    if (planFailure.reason === 'usage_limit') return 'plan_usage_limit';
    if (planFailure.reason === 'signin_required') return 'auth';
    if (planFailure.reason === 'unsupported') return 'other';
    return 'other';
  }
  // Kode resmi OpenAI menang atas tebakan dari teks. Daftar ini dari
  // developers.openai.com/api/docs/guides/error-codes:
  //   credit_balance_exhausted   → saldo prabayar organisasi nol
  //   organization_spend_limit_exceeded / project_spend_limit_exceeded
  //                              → batas belanja yang disetel sendiri
  //   organization_usage_limit_exceeded → batas pemakaian dari OpenAI
  // Semuanya HTTP 429 dengan type `insufficient_quota`, jadi `type` saja tidak
  // cukup untuk membedakannya dari rate limit.
  if (/credit_balance_exhausted|insufficient_quota|spend_limit_exceeded|usage_limit_exceeded/i.test(text)) return 'billing';
  if (http === 402) return 'billing';
  // Pesan asli untuk saldo kosong (HTTP 429, bukan 402):
  //   "You have no credits remaining. Add credits to continue using the API at
  //    https://platform.openai.com/settings/organization/billing/"
  // Dulu teks ini tidak cocok dengan pola mana pun, jatuh ke cabang 429, lalu
  // dilaporkan sebagai "batas laju" — persis gejala yang membingungkan.
  if (/\bno credits?\b|credits? remaining|add credits|credit balance|out of credits|billing/i.test(text)) return 'billing';
  if (/invalid_api_key|incorrect api key|unauthorized|deactivated/i.test(text)) return 'auth';
  if (http === 401 || http === 403) return 'auth';
  // 429 tersisa = batas laju sungguhan (`rate_limit_exceeded`, `slow_down`).
  if (http === 429) return 'rate_limit';
  return 'other';
}

/**
 * Terjemahan kode galat OpenAI yang perlu tindakan BERBEDA. Dipakai untuk
 * memberi kalimat yang menyebut tombol/halaman yang benar, bukan "isi saldo"
 * untuk semua hal.
 */
export function openAiErrorCodeHint(detail = '') {
  const text = String(detail || '');
  if (/credit_balance_exhausted/i.test(text)) {
    return {
      reason: 'credit_balance',
      title: 'Saldo API OpenAI nol',
      action: 'Isi kredit API di platform.openai.com → Billing → Add credits.',
    };
  }
  if (/organization_spend_limit_exceeded|project_spend_limit_exceeded/i.test(text)) {
    return {
      reason: 'spend_limit',
      title: 'Batas belanja OpenAI tercapai',
      action: 'Naikkan/hapus batas belanja di platform.openai.com → Settings → Limits.',
    };
  }
  if (/organization_usage_limit_exceeded/i.test(text)) {
    return {
      reason: 'usage_limit',
      title: 'Batas pemakaian dari OpenAI tercapai',
      action: 'Minta batas lebih tinggi lewat platform.openai.com → Settings → Limits (Usage tiers).',
    };
  }
  return null;
}

/**
 * Pesan untuk pengguna saat SELURUH akun pool menolak satu permintaan.
 * `details` = daftar `{ status, detail }` dari akun yang dicoba (boleh kosong).
 * Mengembalikan `{ code, status, error }` supaya `/api/chat`, `/api/agent`, dan
 * UI memakai kalimat yang sama.
 */
export function openAiFailureMessage(details = [], { model = '' } = {}) {
  const list = Array.isArray(details) ? details.filter(Boolean) : [];
  const kinds = list.map((item) => classifyOpenAiFailure(item.status, item.detail));
  const label = model ? ` untuk model "${model}"` : '';
  const rateLimited = kinds.filter((kind) => kind === 'rate_limit').length;
  const billing = kinds.filter((kind) => kind === 'billing').length;
  const auth = kinds.filter((kind) => kind === 'auth').length;
  const accounts = list.length;

  if (rateLimited && !billing && !auth) {
    return {
      code: 'openai_rate_limited',
      status: 429,
      kind: 'rate_limit',
      error: `Akun OpenAI${label} kena batas laju permintaan (429) sementara, bukan kuota habis. `
        + 'Tunggu sekitar satu menit lalu coba lagi; akun di pool otomatis dicoba bergiliran.',
    };
  }
  if (billing) {
    // Sebut kode galatnya: itu yang membedakan "isi saldo" dari "naikkan batas".
    const hint = list.map((item) => openAiErrorCodeHint(item.detail)).find(Boolean);
    const specific = hint
      ? `${hint.title}. ${hint.action}`
      : 'Isi kredit API di platform.openai.com → Billing → Add credits.';
    return {
      code: 'openai_pool_billing',
      status: 402,
      kind: 'billing',
      // "Free tier" di halaman Limits OpenAI adalah TINGKAT BATAS LAJU, bukan
      // kredit gratis. Kalimat ini mencegah admin mencari kredit yang tidak ada.
      error: `Kredit API akun OpenAI${label} habis (${billing} dari ${accounts || 1} akun). ${specific} `
        + 'Catatan: “Free tier” di platform.openai.com → Limits adalah tingkat batas laju, bukan kredit gratis — '
        + 'API hanya jalan setelah ada saldo prabayar. Studio → Akun OpenAI juga menerima akun OAuth bila tidak ingin memakai saldo API.',
    };
  }
  if (auth) {
    return {
      code: 'openai_pool_unauthorized',
      status: 401,
      kind: 'auth',
      error: `API key akun OpenAI ditolak (401/403) untuk ${auth} dari ${accounts || 1} akun. `
        + 'Ganti kuncinya di Studio → Akun OpenAI, lalu tekan Uji.',
    };
  }
  return {
    code: 'openai_pool_failed',
    status: 502,
    kind: 'other',
    error: `Semua akun OpenAI di pool gagal dipanggil${label}. Cek status akun di Studio → Akun OpenAI (Uji) atau coba lagi sebentar.`,
  };
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
      const kind = classifyOpenAiFailure(status, error);
      // Batas LAJU (429 murni) pulih dalam hitungan detik/menit. Menghukum
      // akun dengan cooldown 10–60 menit seperti kegagalan auth membuat satu
      // permintaan cepat mematikan pool selama satu jam.
      const minutes = kind === 'rate_limit'
        ? RATE_LIMIT_COOLDOWN_MINUTES
        : Math.min(COOLDOWN_MAX_MINUTES, COOLDOWN_BASE_MINUTES * (2 ** Math.min(failures - 1, 3)));
      // Keadaan yang TIDAK pulih dengan menunggu (kredit habis, kunci ditolak,
      // paket tidak boleh dipakai) langsung dianggap permanen. Dulu semuanya
      // diberi `cooldown_until`, dan selama jendela itu `stalePoolBlock` sengaja
      // mengembalikan null → akun tampil "cooldown" 10 menit sebelum sebab
      // sebenarnya muncul. Itu persis keluhan yang membuat sesi ini dimulai.
      const permanent = kind === 'billing' || kind === 'plan_not_eligible';
      const authPermanent = kind === 'auth' && failures >= AUTH_STALE_FAILURES;
      Object.assign(patch, {
        consecutive_failures: failures,
        cooldown_until: permanent || authPermanent ? null : new Date(now.getTime() + minutes * 60_000).toISOString(),
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
  const finish = async (ok, message, status = null, rawCode = '') => {
    await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        last_test_at: nowIso,
        last_test_ok: ok,
        ...(ok ? { last_ok_at: nowIso, consecutive_failures: 0, cooldown_until: null, last_error: null } : {}),
        // Kegagalan yang TIDAK akan pulih dengan menunggu disimpan apa adanya,
        // supaya pool berhenti mencobanya dan UI menyebut sebabnya. Tanpa ini,
        // Uji hanya melaporkan merah satu kali lalu akun dicoba lagi tiap
        // cooldown habis.
        // Catat juga sebagai kegagalan: `stalePoolBlock` membaca
        // `consecutive_failures` untuk memutuskan akun berhenti dicoba.
        ...(ok ? {} : {
          // Kode galat OpenAI ditulis DI DEPAN pesan manusia: itu yang dibaca
          // `stalePoolBlock` untuk memutuskan akun berhenti dicoba.
          ...(message ? { last_error: `${rawCode ? `${rawCode}: ` : ''}${String(message)}`.slice(0, 300) } : {}),
          consecutive_failures: (Number(row.consecutive_failures) || 0) + 1,
        }),
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
    let token = await readOpenAiSealedField(env, row.sealed_token, { table: TABLE, id: row.id, column: 'sealed_token' });
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
      // 200 di sini hanya membuktikan "token sah". Izin pemakaian paket harus
      // dibuktikan lewat satu panggilan Responses API — persis seperti Uji akun
      // API key yang tidak berhenti di /v1/models.
      const plan = await probeOAuthPlanUsage({ token, model: String(row.model_default || '') });
      if (plan.ok) {
        return await finish(true, 'Token OAuth diterima dan paket akun boleh dipakai (Responses API teks).', res.status);
      }
      if (plan.kind === 'plan_usage_limit' || plan.kind === 'rate_limit') {
        // Batas pemakaian/laju bukan tanda akun rusak; jangan dilaporkan gagal.
        return await finish(true, `Token OAuth diterima, tetapi paketnya sedang kena batas pemakaian: ${String(plan.detail || '').slice(0, 160)}`, plan.status);
      }
      return await finish(
        false,
        `Token OAuth diterima, tetapi pemakaian paket ditolak: ${String(plan.detail || '').slice(0, 220)}`,
        plan.status,
        plan.code,
      );
    }
    const text = await res.text().catch(() => '');
    return await finish(false, `OpenAI menolak token OAuth (HTTP ${res.status}). ${text.slice(0, 200)}`.trim(), res.status);
  }
  const token = await readOpenAiSealedField(env, row.sealed_token, { table: TABLE, id: row.id, column: 'sealed_token' });
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
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const kind = classifyOpenAiFailure(res.status, text);
    if (kind === 'billing') {
      return await finish(
        false,
        // Jangan pernah bilang "berhasil" untuk akun tanpa kredit: /v1/models
        // memang tetap 200, jadi pemeriksaan kunci saja menyesatkan.
        `Kunci diterima, tetapi kredit OpenAI habis: ${text.slice(0, 160) || 'no credits remaining'}. Isi saldo di platform.openai.com → Billing.`,
        res.status,
      );
    }
    return await finish(false, `API menolak kunci (HTTP ${res.status}). ${text.slice(0, 200)}`.trim(), res.status);
  }
  await res.body?.cancel().catch?.(() => {});
  // /v1/models tidak memotong kredit, jadi ia membuktikan KUNCI saja. Untuk
  // menjawab "bisa dipakai atau tidak", satu panggilan termurah ke
  // /v1/chat/completions adalah bukti billing yang sebenarnya.
  // Urutan model: model_default akun lebih dulu (itu yang benar-benar dipakai
  // chat BLEA), lalu PROBE_MODEL sebagai cadangan termurah.
  const completion = await probeOpenAiCredit({ base, token, model: String(row.model_default || '') });
  if (completion && !completion.ok) {
    if (completion.kind === 'billing') {
      return await finish(
        false,
        `Kunci diterima, tetapi kredit OpenAI habis: ${String(completion.detail || '').slice(0, 160)}. Isi saldo di platform.openai.com → Billing.`,
        completion.status,
      );
    }
    if (completion.kind === 'rate_limit') {
      // Batas laju bukan tanda akun rusak, jadi jangan dilaporkan sebagai gagal.
      return await finish(true, 'Kunci diterima dan saldo tersedia (sedang kena batas laju sesaat).', completion.status);
    }
    // Bukan soal kredit: model yang diminta tidak ada di akun ini. Menyebut
    // "berhasil" di sini membuat Uji hijau padahal chat-nya akan gagal, jadi
    // yang dilaporkan adalah apa yang harus diganti.
    if (completion.kind === 'model_missing') {
      return await finish(
        false,
        `Kunci diterima, tetapi model \"${completion.model}\" tidak tersedia di akun ini. `
        + 'Ganti model akun (Ubah → model) ke model yang ada di akun itu; '
        + 'daftar model resmi: platform.openai.com → Settings → Project → Limits, atau GET /v1/models dengan kunci ini.',
        404,
      );
    }
  }
  return await finish(true, completion?.ok ? 'Kunci diterima dan kredit OpenAI tersedia.' : 'Kunci diterima API OpenAI.', res.status);
}

/**
 * Satu panggilan chat termurah untuk membuktikan saldo. Best-effort: kalau
 * endpoint chat tidak bisa dihubungi, hasil `null` dan akun tidak dihukum.
 */
async function probeOpenAiCredit({ base, token, model = '' }) {
  const preferred = String(model || '').trim();
  const probe = (chosen) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: chosen,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const readFailure = async (res) => {
    const text = await res.text().catch(() => '');
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message || parsed?.message || text;
    } catch { /* teks mentah sudah cukup */ }
    return { status: res.status, detail };
  };
  try {
    let chosen = preferred || PROBE_MODEL;
    let res = await probe(chosen);
    if (!res.ok) {
      const failure = await readFailure(res);
      if (MODEL_MISSING_RE.test(failure.detail) && chosen !== PROBE_MODEL) {
        // Model akun tidak ada di kunci ini; jangan simpulkan "kredit".
        chosen = PROBE_MODEL;
        res = await probe(chosen);
        if (!res.ok) {
          const retry = await readFailure(res);
          const kind = MODEL_MISSING_RE.test(retry.detail) ? 'model_missing' : classifyOpenAiFailure(retry.status, retry.detail);
          return { ok: false, status: retry.status, kind, detail: retry.detail, model: chosen };
        }
      } else if (MODEL_MISSING_RE.test(failure.detail)) {
        return { ok: false, status: failure.status, kind: 'model_missing', detail: failure.detail, model: chosen };
      } else {
        return { ok: false, status: failure.status, kind: classifyOpenAiFailure(failure.status, failure.detail), detail: failure.detail, model: chosen };
      }
    }
    await res.body?.cancel?.().catch?.(() => {});
    return { ok: true, status: res.status, model: chosen };
  } catch (error) {
    return { ok: false, status: 0, kind: 'other', detail: String(error?.message || error).slice(0, 160) };
  }
}

/**
 * Bukti bahwa akun OAuth benar-benar boleh memakai paketnya.
 *
 * `GET /v1/models` di jalur paket tetap 200 walau izin pemakaian paket TIDAK
 * diberikan, jadi status 200 di situ hanya membuktikan "token sah", bukan
 * "bisa dipakai chat". Satu permintaan teks sekecil mungkin ke
 * `/v1/responses` (wajib `store:false` + `stream:true`) adalah buktinya.
 * Batas laju/pemakaian dianggap bukan kegagalan kredensial.
 */
export async function probeOAuthPlanUsage({ token, model = '', timeoutMs = 30_000 }) {
  // `model_default` bisa saja tidak ada di akun ini (katalog jalur paket
  // bersifat per-akun), jadi pilihan itu tetap divalidasi ke katalog. Kalau
  // katalognya tidak terbaca, pilihan pengguna dipakai apa adanya.
  const catalog = await openAiResponsesModelCatalog(token);
  const chosen = planModelFromCatalog({ models: catalog }, model) || model || 'gpt-5.1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      // Body seminimal mungkin: jalur paket menolak banyak field Chat
      // Completions (`max_output_tokens`, `temperature`, …), jadi hanya field
      // wajib yang dikirim.
      body: JSON.stringify({
        model: chosen,
        input: [{ role: 'user', content: 'ping' }],
        store: false,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    return { ok: false, status: 0, kind: 'other', detail: String(error?.message || error).slice(0, 160), model: chosen };
  }
  clearTimeout(timer);
  if (res.ok) {
    // Body tidak perlu dihabiskan: yang dibuktikan adalah izinnya, bukan teksnya.
    await res.body?.cancel?.().catch?.(() => {});
    return { ok: true, status: res.status, model: chosen };
  }
  const text = await res.text().catch(() => '');
  let detail = text;
  let rawCode = '';
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.error?.message || parsed?.message || text;
    rawCode = String(parsed?.error?.code || parsed?.code || '');
  } catch { /* teks mentah sudah cukup */ }
  const planFailure = planUsageFailure(res.status, text);
  return {
    ok: false,
    status: res.status,
    kind: planFailure?.reason === 'not_eligible' ? 'plan_not_eligible'
      : (planFailure?.reason === 'usage_limit' ? 'plan_usage_limit' : classifyOpenAiFailure(res.status, detail)),
    detail: planFailure ? `${planFailure.title}. ${planFailure.action}` : detail,
    // Kode mentah ikut dikembalikan: `last_error` di DB disusun dari sini, dan
    // `stalePoolBlock` mengklasifikasi dari kode itu — kalau hilang, akun yang
    // sudah pasti tidak bisa dipakai akan tetap dicoba lagi.
    code: rawCode,
    model: chosen,
  };
}

