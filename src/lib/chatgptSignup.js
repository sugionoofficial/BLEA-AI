// Daftar akun ChatGPT dari halaman admin, memakai email yang sedang aktif di
// halaman TempMail.
//
// BACA INI — inti persoalannya:
//
// `POST https://chatgpt.com/api/auth/signin/openai` adalah endpoint NextAuth,
// bukan halaman. Kontraknya (lihat SDK ChatGPT: GET /api/auth/csrf → POST
// {provider}?prompt=login dengan body callbackUrl + csrfToken) adalah:
//
//   GET  /api/auth/csrf            → { csrfToken: "…" }  + cookie __Host-next-auth.csrf-token
//   POST /api/auth/signin/openai   → 302 ke auth.openai.com/… (atau JSON { url }) 
//
// Konsekuensinya:
//   1. Menavigasi browser ke URL POST itu (GET tanpa csrfToken) SELALU gagal
//      dengan "Kami tidak dapat memproses upaya masuk Anda. Coba lagi" —
//      persis halaman error yang dilaporkan. Tab tidak pernah sampai ke
//      formulir daftar, jadi email TempMail tidak pernah terkirim.
//   2. Server BLEA juga tidak boleh mem-POST-nya: Cloudflare Worker diblokir
//      ke domain OpenAI, dan hasil POST tanpa cookie/Turnstile browser tetap
//      tidak menghasilkan akun.
//   3. Pendaftaran akun otomatis ke OpenAI melanggar Terms of Use dan hasilnya
//      langsung ditahan captcha.
//
// Jadi:
//   • `buildSignupUrl` menghasilkan URL HALAMAN (/auth/login) yang memang bisa
//     dibuka dengan GET oleh siapa pun, membawa email TempMail sebagai
//     `login_hint`.
//   • Di halaman itu, browser sendirilah yang mengambil csrfToken dan mem-POST
//     formulir — jalur yang sah, dengan cookie & Turnstile milik pengguna.
//   • `buildSigninBootstrap` menyediakan langkah yang sama untuk kasus halaman
//     login sudah terbuka: kirim email (POST identitas) lalu lanjut ke
//     verifikasi. Ini panduan, bukan eksekusi otomatis.
//
// Yang disimpan HANYA: email, URL yang dibuka, dan langkah terakhir. Tidak ada
// kata sandi, kode verifikasi, csrfToken, atau token sesi chatgpt.com.

// Endpoint NextAuth untuk memulai OAuth (HANYA sah lewat POST + csrfToken).
export const SIGNUP_REQUEST_URL = 'https://chatgpt.com/api/auth/signin/openai';
// Halaman yang memang bisa dibuka dengan GET. Ini yang dipakai tombol utama.
export const SIGNUP_PAGE_URL = 'https://chatgpt.com/auth/login';
export const SIGNUP_CSRF_URL = 'https://chatgpt.com/api/auth/csrf';
export const SIGNUP_STEPS = [
  'dibuka', 'email_dikirim', 'menunggu_verifikasi', 'terverifikasi', 'dilewati',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Domain +tag Gmail: OpenAI menolak alamat yang mengandung tanda `+` pada
// sebagian formulir, jadi kemampuan ini dilaporkan apa adanya, bukan disembunyikan.
const PLUS_ADDRESS_RE = /\+[^@]*@/;

function fail(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, ...extra });
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * URL yang benar untuk dibuka browser: halaman login/daftar, bukan endpoint
 * POST NextAuth. `login_hint` berisi email TempMail; tidak ada password dan
 * tidak ada token di URL.
 */
export function buildSignupUrl(email, { authSessionLoggingId = '' } = {}) {
  const address = cleanText(email, 320).toLowerCase();
  const params = new URLSearchParams({ prompt: 'login', screen_hint: 'signup' });
  const loggingId = cleanText(authSessionLoggingId, 64);
  if (loggingId) params.set('auth_session_logging_id', loggingId);
  if (address) params.set('login_hint', address);
  return `${SIGNUP_PAGE_URL}?${params.toString()}`;
}

/**
 * Langkah manual di halaman login yang sudah terbuka, untuk kasus tombol
 * utama tidak membawa `login_hint` (mis. OpenAI mengabaikan parameter itu).
 *
 * `csrf` disertakan sebagai dokumentasi: nilainya harus diambil browser dari
 * GET /api/auth/csrf pada saat itu juga, tidak boleh disimpan atau dikirim ke
 * server BLEA. Karena itu field ini selalu kosong di keluaran.
 */
export function buildSigninBootstrap(email) {
  const address = cleanText(email, 320).toLowerCase();
  return {
    csrf_url: SIGNUP_CSRF_URL,
    form: {
      method: 'POST',
      url: SIGNUP_REQUEST_URL,
      content_type: 'application/x-www-form-urlencoded',
      fields: ['callbackUrl', 'csrfToken', 'login_hint'],
      callback_url: 'https://chatgpt.com/',
    },
    fields_to_fill: { 'Alamat email': address },
    steps: [
      'Di tab ChatGPT yang sudah terbuka, salin semua yang ada di URL (bila sudah diarahkan ke halaman error, buka https://chatgpt.com/auth/login dulu).',
      'Tempel URL itu di kolom "URL setelah klik Lanjutkan" di panel ini.',
      'Panel cocokkan email dan domain, lalu menandai permintaan sebagai "email dikirim".',
    ],
    csrf: '',
  };
}

/**
 * Konfigurasi yang dikirim ke UI. `server_side_post` selalu false, dengan
 * alasan tertulis — bukan tombol yang diam-diam gagal.
 */
export function signupConfig() {
  return {
    signup_url: SIGNUP_PAGE_URL,
    signin_endpoint: SIGNUP_REQUEST_URL,
    csrf_url: SIGNUP_CSRF_URL,
    method_used_by_browser: 'GET',
    supported: {
      build_signup_link: true,
      login_hint: true,
      server_side_post: false,
      headless_signup: false,
      captcha_bypass: false,
      capture_session_cookie: false,
    },
    why_not_post: [
      `${SIGNUP_REQUEST_URL} adalah endpoint POST NextAuth: tanpa csrfToken dari ${SIGNUP_CSRF_URL} hasilnya halaman "Kami tidak dapat memproses upaya masuk Anda".`,
      'Cloudflare Worker juga diblokir ke domain OpenAI, jadi POST dari server tidak akan pernah berhasil.',
      'Pendaftaran akun otomatis melanggar Terms of Use OpenAI dan akunnya biasanya dinonaktifkan.',
    ],
    verification_note: 'Verifikasi email tetap diklik manusia. BLEA hanya membaca inbox TempMail dan menandai pesan verifikasi yang cocok.',
  };
}

export function isSignupEmail(value) {
  const address = cleanText(value, 320);
  return EMAIL_RE.test(address);
}

export function isPlusAddress(value) {
  return PLUS_ADDRESS_RE.test(cleanText(value, 320));
}

/** Skor kecocokan pesan inbox terhadap permintaan verifikasi (0–100). */
export function scoreVerificationMessage(message, request = {}) {
  const haystack = `${message?.subject || ''} ${message?.from || ''} ${message?.preview || ''}`.toLowerCase();
  let score = 0;
  const reasons = [];
  if (/openai|chatgpt/.test(haystack)) { score += 45; reasons.push('pengirim menyebut OpenAI/ChatGPT'); }
  if (/verif|verifikasi|confirm|konfirmasi|activate|aktifkan|kode|code|log ?in|masuk/.test(haystack)) {
    score += 35;
    reasons.push('isi menyebut verifikasi/kode');
  }
  const expected = cleanText(request.email, 320).toLowerCase();
  const to = cleanText(message?.to, 320).toLowerCase();
  if (expected && to && to.includes(expected)) { score += 20; reasons.push(`ditujukan ke ${expected}`); }
  const createdAt = Date.parse(message?.createdAt || '');
  const requestedAt = Date.parse(request.created_at || '');
  if (Number.isFinite(createdAt) && Number.isFinite(requestedAt) && createdAt >= requestedAt - 120_000) {
    reasons.push('diterima setelah pendaftaran dimulai');
  } else if (Number.isFinite(createdAt) && Number.isFinite(requestedAt)) {
    score -= 25;
    reasons.push('diterima sebelum pendaftaran dimulai');
  }
  return { score: Math.max(0, Math.min(100, score)), matched: score >= 50, reasons };
}

export function normalizeSignupRequest(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id,
    email: row.email || '',
    signup_url: row.signup_url || '',
    step: row.step || 'dibuka',
    note: row.note || '',
    verification_message_id: row.verification_message_id || '',
    verified_at: row.verified_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function validateSignupInput(input = {}) {
  const email = cleanText(input.email, 320).toLowerCase();
  if (!isSignupEmail(email)) throw fail('Email TempMail tidak valid. Buat atau muat ulang alamat TempMail lebih dulu.', 400);
  const authSessionLoggingId = cleanText(input.auth_session_logging_id, 64);
  if (authSessionLoggingId && !/^[0-9a-f-]{20,64}$/i.test(authSessionLoggingId)) {
    throw fail('auth_session_logging_id harus berupa UUID.', 400);
  }
  return { email, auth_session_logging_id: authSessionLoggingId, plus_address: isPlusAddress(email) };
}

/**
 * Baca URL hasil klik "Lanjutkan" di halaman ChatGPT, untuk memastikan langkah
 * benar-benar sampai ke tahap berikutnya (bukan tetap di halaman error).
 *
 * Yang diperiksa hanya hal yang bisa dibuktikan dari URL: domain OpenAI dan
 * apakah email yang diminta muncul di sana. Tidak ada yang diambil dari sini
 * untuk autentikasi — BLEA tidak pernah memakai cookie atau kode dari langkah
 * ini.
 */
export function analyzeReturnUrl(rawUrl, expectedEmail = '') {
  const raw = cleanText(rawUrl, 2000);
  if (!raw) return { ok: false, status: 'kosong', detail: 'URL masih kosong.', email_matches: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, status: 'tidak_valid', detail: 'Itu bukan URL yang bisa dibaca. Salin ulang dari bilah alamat browser.', email_matches: false };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, status: 'tidak_valid', detail: 'URL harus https.', email_matches: false };
  }
  const host = parsed.hostname.toLowerCase();
  const openAiHost = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'openai.com' || host.endsWith('.openai.com');
  const path = parsed.pathname || '';
  const whole = `${parsed.search} ${decodeURIComponent(parsed.search)}`.toLowerCase();
  const expected = cleanText(expectedEmail, 320).toLowerCase();
  const emailMatches = Boolean(expected) && whole.includes(expected);
  const stillError = /\/auth\/error/.test(path) || /error=/.test(parsed.search);
  const verification = /verify|verification|confirm|check.?email|email-verification/.test(`${path} ${whole}`);
  const password = /password|create-account|signup\/password/.test(`${path} ${whole}`);

  if (!openAiHost) {
    return { ok: false, status: 'host_asing', detail: `Host ${host} bukan domain OpenAI/ChatGPT.`, email_matches: false };
  }
  if (stillError) {
    return {
      ok: false,
      status: 'masih_error',
      detail: 'URL itu halaman error. Ulangi dari halaman daftar di panel; kalau tetap error, coba jendela privat atau jaringan lain.',
      email_matches: emailMatches,
    };
  }
  if (emailMatches) {
    return {
      ok: true,
      status: verification ? 'verifikasi' : password ? 'kata_sandi' : 'email_diterima',
      detail: verification
        ? 'Email sudah diterima OpenAI — langkah berikutnya memeriksa inbox TempMail.'
        : 'Email TempMail terbaca di URL, jadi formulir sudah menerimanya.',
      email_matches: true,
    };
  }
  return {
    ok: false,
    status: 'email_tidak_terlihat',
    detail: `URL ini diterima, tetapi email ${expected || '(kosong)'} tidak terlihat di dalamnya. Pastikan Anda menyalin URL setelah menekan Lanjutkan, bukan alamat halaman awal.`,
    email_matches: false,
  };
}
