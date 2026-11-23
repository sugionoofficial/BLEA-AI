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
/**
 * Prioritas kolom isian di halaman login ChatGPT. `type=email` diutamakan,
 * karena kolom itu yang benar-benar mengirim email; kolom telepon juga
 * `type=tel`/text sehingga tidak boleh dipilih lebih dulu.
 */
export const EMAIL_INPUT_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[id*="email" i]',
  'input[placeholder*="email" i]',
];

/**
 * Bookmarklet: skrip yang dijalankan DI HALAMAN chatgpt.com, dipicu klik
 * pengguna sendiri.
 *
 * Kenapa ini satu-satunya jalan: same-origin policy melarang halaman BLEA
 * menyentuh DOM `chatgpt.com` (tidak bisa mengisi kolom dari jauh), dan OpenAI
 * mengabaikan `login_hint`. Bookmarklet dieksekusi oleh dokumen chatgpt.com
 * setelah pengguna mengkliknya, jadi ia boleh mengisi kolom — persis seperti
 * pengguna mengetik sendiri.
 *
 * Batasannya disengaja: hanya mengisi kolom dan memfokuskan; TIDAK menekan
 * "Lanjutkan", TIDAK mengirim formulir, TIDAK membaca cookie/token, dan TIDAK
 * menyimpan apa pun. Pengguna tetap menekan tombolnya sendiri.
 *
 * Keamanan: email sudah lolos validasi (tanpa kutip, backslash, kurung kurawal,
 * `@` tunggal, tanpa spasi), jadi aman disisipkan ke string literal JS.
 */
export function buildAutofillBookmarklet(email) {
  const address = cleanText(email, 320).toLowerCase();
  if (!isSignupEmail(address) || /["'\\`<>]/.test(address)) {
    throw fail('Email tidak aman untuk dijadikan bookmarklet.', 400);
  }
  const script = `(function(){try{var v=${JSON.stringify(address)};`
    + `var els=document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=checkbox]):not([type=radio])');`
    + `var t=null;`
    + `for(var i=0;i<els.length&&!t;i++){var el=els[i];if(el.type==='tel')continue;`
    + `var hay=((el.getAttribute('name')||'')+' '+(el.id||'')+' '+(el.getAttribute('autocomplete')||'')+' '+(el.getAttribute('placeholder')||'')).toLowerCase();`
    + `if(el.type==='email'||hay.indexOf('email')>-1||hay.indexOf('username')>-1){t=el;}}`
    + `if(!t){alert('Kolom email tidak ditemukan di halaman ini. Buka https://chatgpt.com/auth/login dulu.');return;}`
    + `var set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;`
    + `set.call(t,v);t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));t.focus();`
    + `if(t.value!==v){t.value=v;}`
    + `}catch(e){alert('Gagal mengisi email: '+e.message);}})();`;
  return `javascript:${encodeURIComponent(script)}`;
}

/**
 * Userscript (Tampermonkey/Violentmonkey) untuk pengisian OTOMATIS.
 *
 * Kenapa jalur ini ada: bookmarklet hanya jalan bila pengguna berhasil menyeret
 * tautannya ke bilah bookmark, dan Chrome membuang awalan `javascript:` saat
 * ditempel — dua titik gagal yang tidak bisa dikendalikan dari halaman BLEA.
 * Userscript dipasang sekali, lalu berjalan sendiri setiap halaman login
 * ChatGPT dibuka: tidak ada seret, tidak ada tempel.
 *
 * Batasannya tetap sama: hanya mengisi kolom email, tidak menekan "Lanjutkan",
 * tidak mengirim formulir, tidak membaca cookie/token, tidak mengirim data ke
 * mana pun. Pengguna tetap menekan tombolnya sendiri.
 */
export function buildAutofillUserscript(email, { origin = '' } = {}) {
  const address = cleanText(email, 320).toLowerCase();
  if (!isSignupEmail(address) || /["'\\`<>]/.test(address)) {
    throw fail('Email tidak aman untuk dijadikan userscript.', 400);
  }
  const from = cleanText(origin, 200);
  return `// ==UserScript==
// @name         BLEA — isi email ChatGPT
// @namespace    blea-ai
// @version      1.0
// @description  Mengisi kolom email di halaman login/daftar ChatGPT dengan email TempMail. Tidak menekan Lanjutkan.
// @match        https://chatgpt.com/*
// @match        https://auth.openai.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
(function () {
  'use strict';
  var EMAIL = ${JSON.stringify(address)};
  var SRC = ${JSON.stringify(from || 'BLEA AI')};
  var SELECTORS = ${JSON.stringify(EMAIL_INPUT_SELECTORS)};

  function pickInput() {
    for (var i = 0; i < SELECTORS.length; i += 1) {
      var el = document.querySelector(SELECTORS[i]);
      if (el && !el.disabled && el.type !== 'tel' && !el.readOnly) return el;
    }
    return null;
  }

  function fill(el) {
    if (!el || el.value === EMAIL) return el && el.value === EMAIL;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, EMAIL);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.focus();
    if (el.value !== EMAIL) el.value = EMAIL;
    return el.value === EMAIL;
  }

  function attempt() {
    var el = pickInput();
    if (!el) return false;
    if (!fill(el)) return false;
    // Penanda kecil supaya terlihat skrip ini benar-benar berjalan.
    if (!document.getElementById('blea-autofill-mark')) {
      var mark = document.createElement('div');
      mark.id = 'blea-autofill-mark';
      mark.textContent = 'Email diisi oleh ' + SRC;
      mark.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:6px 10px;border-radius:8px;background:#111;color:#d7d7ff;font:12px system-ui;opacity:.85;pointer-events:none';
      document.body.appendChild(mark);
      setTimeout(function () { mark.remove(); }, 4000);
    }
    return true;
  }

  if (attempt()) return;
  // Halaman ini merender formulir belakangan (React hydrate): coba beberapa kali.
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (attempt() || tries > 40) clearInterval(timer);
  }, 250);
  // Kalau kolom muncul lagi setelah navigasi internal, isi ulang.
  var observer = new MutationObserver(function () {
    var el = pickInput();
    if (el && el.value !== EMAIL) fill(el);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
`;
}

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
    // Bookmarklet = satu-satunya cara sah mengisi kolom lintas-origin:
    // dijalankan di halaman chatgpt.com atas klik pengguna.
    autofill_bookmarklet: buildAutofillBookmarklet(address),
    // Jalur otomatis tanpa seret/tempel: dipasang sekali di Tampermonkey.
    autofill_userscript: buildAutofillUserscript(address),
    steps: [
      'Isi kolom "Alamat email" di ChatGPT: tempel manual, atau seret tombol "Isi email otomatis" di panel ke bilah bookmark lalu klik di tab ChatGPT.',
      'Tekan "Lanjutkan" di tab ChatGPT (BLEA tidak pernah menekan tombol itu untuk Anda).',
      'Salin URL halaman hasil lalu tempel di kolom "URL setelah menekan Lanjutkan" di panel ini.',
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

/**
 * Ambil kode verifikasi dari isi email.
 *
 * Kenapa ini perlu: email verifikasi OpenAI berisi KODE (bukan tautan yang
 * cukup diklik), dan kode itu harus ditempel kembali di tab ChatGPT. Snippet
 * inbox tidak selalu memuat kodenya, jadi isi lengkap perlu dibaca.
 *
 * Aturan pemilihan sengaja konservatif supaya tidak salah ambil angka:
 *   • utamakan deret 6–8 digit (bentuk kode OpenAI);
 *   • abaikan angka yang menempel pada tahun (`2026`), harga/kuota, atau
 *     bagian dari kata/angka lebih panjang;
 *   • kalau ada beberapa kandidat, ambil yang berada dekat kata kunci
 *     (`kode`, `code`, `verifikasi`, `verification`);
 *   • ragu → kembalikan kosong, jangan menebak.
 */
export function extractVerificationCode({ subject = '', bodyText = '', bodyHtml = '' } = {}) {
  const plain = String(bodyText || '')
    .concat(' ', String(bodyHtml || '').replace(/<[^>]+>/g, ' '))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ');
  if (!plain.trim()) return { code: '', candidates: [] };

  const KEYWORD_RE = /(kode|code|verifikasi|verification|verifikasi|one[- ]?time|otp|masuk|sign[- ]?in)/i;
  const found = new Map();
  // Kode OpenAI 6 digit, kadang ditulis berkelompok ("483-920"). Kelompok
  // bertanda hubung digabung lebih dulu, lalu deret 6–8 digit yang tidak
  // menempel pada huruf/angka lain.
  const pattern = /(?<![A-Za-z0-9])(\d{3}-\d{3}|\d{6,8})(?![A-Za-z0-9])/g;
  let match;
  while ((match = pattern.exec(plain)) !== null) {
    const code = match[1].replace(/-/g, '');
    const start = Math.max(0, match.index - 60);
    const context = plain.slice(start, match.index + match[1].length + 60);
    // Buang angka yang jelas bukan kode: tahun, nominal, kuota, ukuran.
    if (/^(19|20)\d{2}$/.test(code) && !/kode|code|otp|verifikasi|verification/i.test(context)) continue;
    if (/(rp|idr|usd|\$|kuota|quota|harga|price|jumlah|total)\s*[:.]?\s*$/i.test(plain.slice(start, match.index))) continue;
    const score = (KEYWORD_RE.test(context) ? 2 : 0) + (code.length === 6 ? 1 : 0);
    const existing = found.get(code);
    if (!existing || score > existing.score) {
      found.set(code, { code, score, context: context.trim().slice(0, 160) });
    }
  }
  const candidates = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  // Tanpa kata kunci di sekitar, hanya terima bila kandidatnya tunggal.
  const best = candidates[0];
  if (!best) return { code: '', candidates: [] };
  const hasKeyword = candidates.filter((item) => item.score >= 2).length === 1;
  if (!hasKeyword && candidates.length > 1) return { code: '', candidates };
  return { code: best.code, candidates };
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
    verification_code: row.verification_code || '',
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
  // Halaman awal: pengguna baru membuka formulir dan belum menekan Lanjutkan.
  const landing = /^\/auth\/(login|signup|log-in)?\/?$/.test(path) || path === '/';

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
  if (landing) {
    return {
      ok: false,
      status: 'halaman_awal',
      detail: 'Itu masih halaman awal. Isi email, tekan Lanjutkan, lalu salin URL halaman berikutnya.',
      email_matches: emailMatches,
    };
  }
  // PENTING: OpenAI/Auth0 TIDAK membawa email di URL lanjutan — yang tersisa
  // hanya `state=`, dan itu memang normal. Jadi URL lanjutan yang bukan error
  // dianggap bukti sah bahwa formulir menerima email. Email hanya bisa
  // "terlihat" pada URL perantara tertentu; itu bonus, bukan syarat.
  if (verification || password || emailMatches) {
    return {
      ok: true,
      status: verification ? 'verifikasi' : password ? 'kata_sandi' : 'email_diterima',
      detail: emailMatches
        ? 'Email TempMail terbaca di URL — formulir sudah menerimanya.'
        : 'Halaman lanjutan diterima (email memang tidak ditampilkan OpenAI di URL). Lanjutkan ke verifikasi email.',
      email_matches: emailMatches,
    };
  }
  return {
    ok: true,
    status: 'lanjutan',
    detail: 'Halaman lanjutan OpenAI diterima. Email tidak ditampilkan di URL oleh OpenAI — itu normal, bukan kegagalan.',
    email_matches: false,
  };
}
