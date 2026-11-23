// Daftar akun ChatGPT dari halaman admin, memakai email yang sedang aktif di
// halaman TempMail.
//
// PENTING — baca dulu sebelum memakai:
//
// Yang diminta adalah meniru request `POST https://chatgpt.com/api/auth/signin/openai`
// langsung dari server. Itu TIDAK mungkin dan tidak akan dikerjakan di sini:
//   1. Cloudflare Workerd memblokir request ke `chatgpt.com` (IP/ASN Worker
//      ditolak, sama seperti api.openai.com), jadi hasilnya pasti gagal.
//   2. Endpoint itu butuh cookie sesi + token CSRF milik browser, Cloudflare
//      Turnstile, lalu verifikasi email lewat tautan di inbox. Tanpa langkah
//      itu, respons 200 hanya berarti "halaman login terbuka", bukan akun jadi.
//   3. Membuat akun OpenAI secara otomatis melanggar Terms of Use mereka.
//
// Jadi modul ini TIDAK melakukan POST ke chatgpt.com. Ia menyiapkan bahan yang
// memang bisa disiapkan server dengan benar, lalu membuka alur pendaftaran
// resmi di browser (dengan `login_hint` = email TempMail aktif):
//   • ringkasan konfigurasi (login_hint dipakai atau tidak, alasan bila tidak);
//   • permintaan verifikasi tertunda + pencocokan email verifikasi di inbox
//     TempMail (mail.tm atau Gmail alias) dengan skor kecocokan;
//   • satu percobaan pendaftaran per alamat email, supaya tidak mengulang
//     alamat yang sama dan mengotori inbox.
//
// Yang disimpan HANYA: email, URL permintaan, dan langkah terakhir. Tidak ada
// kata sandi, kode verifikasi, atau token sesi chatgpt.com.

export const SIGNUP_REQUEST_URL = 'https://chatgpt.com/api/auth/signin/openai';
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
 * Query string yang dipakai UI untuk membuka halaman daftar ChatGPT.
 * `login_hint` hanya berisi email — tidak ada password, tidak ada token.
 */
export function buildSignupUrl(email, { authSessionLoggingId = '' } = {}) {
  const address = cleanText(email, 320).toLowerCase();
  const params = new URLSearchParams({ prompt: 'login', screen_hint: 'signup' });
  const loggingId = cleanText(authSessionLoggingId, 64);
  if (loggingId) params.set('auth_session_logging_id', loggingId);
  if (address) params.set('login_hint', address);
  return `${SIGNUP_REQUEST_URL}?${params.toString()}`;
}

/**
 * Konfigurasi yang dikirim ke UI. `POST` selalu dilaporkan tidak tersedia,
 * dengan alasan tertulis — bukan tombol yang diam-diam gagal.
 */
export function signupConfig(env = {}) {
  const autoOpen = String(env.CHATGPT_SIGNUP_AUTO_OPEN || '').toLowerCase() === '1'
    || String(env.CHATGPT_SIGNUP_AUTO_OPEN || '').toLowerCase() === 'true';
  return {
    // Formulir daftar dibuka di tab browser pengguna. Server tidak mem-POST ke
    // chatgpt.com; lihat catatan di kepala berkas ini.
    signup_url: SIGNUP_REQUEST_URL,
    method_used_by_browser: 'GET',
    supported: {
      build_signup_link: true,
      login_hint: true,
      auto_open_from_server: autoOpen,
      server_side_post: false,
      headless_signup: false,
      captcha_bypass: false,
      capture_session_cookie: false,
    },
    why_not_post: [
      'Cloudflare Worker diblokir saat menghubungi chatgpt.com, jadi POST dari server tidak akan pernah berhasil.',
      'Endpoint itu butuh cookie sesi + token CSRF browser dan Cloudflare Turnstile; POST tanpa keduanya hanya membuka halaman login.',
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
