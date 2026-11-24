// Pendaftaran akun OpenAI dari halaman admin, memakai email yang sedang aktif
// di halaman TempMail.
//
// Alur yang dipakai adalah jalur platform, seluruhnya di browser pengguna:
//   platform.openai.com/login → email → Continue → kode 6 digit dari inbox
//   → platform.openai.com/home → API keys → Create new secret key → sk-…
//
// Yang TIDAK dilakukan BLEA, dan ini batas, bukan kekurangan:
//   • Tidak mem-POST formulir ke OpenAI dari server. Cloudflare Worker diblokir
//     ke domain OpenAI, dan pendaftaran otomatis melanggar Terms of Use.
//   • Tidak mengisi kolom email di domain lain. Same-origin policy melarangnya,
//     dan halaman login platform tidak memakai `login_hint`.
//   • Tidak membaca/menyimpan cookie atau token sesi platform. Yang disimpan
//     hanya email, URL yang dibuka, dan langkah terakhir.
//
// Semua halaman platform mengarah ke `/login` bila belum masuk (diuji langsung
// ke server OpenAI: /home, /api-keys, dan billing semuanya 302 → /login?next=…),
// jadi `/login` adalah titik masuk yang sah dan bisa dibuka dengan GET.
// Parameter `next` dibatasi daftar tetap supaya tidak bisa dipakai mengarahkan
// ke domain lain.

export const PLATFORM_BASE = 'https://platform.openai.com';
export const PLATFORM_LOGIN_URL = `${PLATFORM_BASE}/login`;
export const PLATFORM_HOME_URL = `${PLATFORM_BASE}/home`;
export const PLATFORM_API_KEYS_URL = `${PLATFORM_BASE}/api-keys`;
export const PLATFORM_BILLING_URL = `${PLATFORM_BASE}/settings/organization/billing/overview`;
// Daftar tujuan yang diizinkan untuk parameter `next`.
export const PLATFORM_NEXT_PATHS = ['/home', '/api-keys', '/settings/organization/billing/overview'];

/**
 * URL login/daftar platform untuk sebuah email.
 *
 * `email` sengaja tidak dikirim sebagai parameter: halaman login platform tidak
 * memakai `login_hint`, dan parameter karangan bisa memicu error. Kolom email
 * tetap diisi manual.
 */
export function buildPlatformSignupUrl(_email, { next = '' } = {}) {
  const target = PLATFORM_NEXT_PATHS.includes(next) ? next : '';
  return target ? `${PLATFORM_LOGIN_URL}?next=${encodeURIComponent(target)}` : PLATFORM_LOGIN_URL;
}

/** Langkah yang dilihat pengguna di panel. */
export const PLATFORM_STEPS = [
  'Klik "Buka login platform", lalu tempel email TempMail di kolom Email address dan tekan Continue.',
  'Buka halaman TempMail, salin kode 6 digit dari email OpenAI, tempel di halaman platform, lalu lanjutkan.',
  'Setelah masuk ke platform.openai.com/home, buka "API keys" → Create new secret key, lalu salin key-nya (diawali sk-).',
  'Kembali ke panel ini → "Tambah akun manual" → tempel key itu sebagai API key. Akun langsung bisa dipakai BLEA.',
];

/**
 * Prioritas kolom isian di halaman login platform. `type=email` diutamakan,
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
 * Bookmarklet: skrip yang dijalankan DI HALAMAN platform.openai.com, dipicu
 * klik pengguna sendiri.
 *
 * Kenapa ini satu-satunya jalan: same-origin policy melarang halaman BLEA
 * menyentuh DOM domain lain (tidak bisa mengisi kolom dari jauh), dan halaman
 * login platform memakai `login_hint` nol. Bookmarklet dieksekusi oleh dokumen
 * platform setelah pengguna mengkliknya, jadi ia boleh mengisi kolom — persis
 * seperti pengguna mengetik sendiri.
 *
 * Batasannya disengaja: hanya mengisi kolom dan memfokuskan; TIDAK menekan
 * "Continue", TIDAK mengirim formulir, TIDAK membaca cookie/token, dan TIDAK
 * menyimpan apa pun.
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
    + `if(!t){alert('Kolom email tidak ditemukan di halaman ini. Buka https://platform.openai.com/login dulu.');return;}`
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
 * platform dibuka: tidak ada seret, tidak ada tempel.
 *
 * Batasannya tetap sama: hanya mengisi kolom email, tidak menekan "Continue",
 * tidak mengirim formulir, tidak membaca cookie/token, tidak mengirim data ke
 * mana pun.
 */
export function buildAutofillUserscript(email, { origin = '' } = {}) {
  const address = cleanText(email, 320).toLowerCase();
  if (!isSignupEmail(address) || /["'\\`<>]/.test(address)) {
    throw fail('Email tidak aman untuk dijadikan userscript.', 400);
  }
  const from = cleanText(origin, 200);
  return `// ==UserScript==
// @name         BLEA — isi email OpenAI
// @namespace    blea-ai
// @version      1.0
// @description  Mengisi kolom email di halaman login platform OpenAI dengan email TempMail. Tidak menekan Continue.
// @match        https://platform.openai.com/*
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

/** Langkah manual yang dilihat pengguna (tanpa server, tanpa CSRF). */
export function buildSigninBootstrap(email) {
  const address = cleanText(email, 320).toLowerCase();
  return {
    form: { url: PLATFORM_LOGIN_URL, method: 'GET' },
    fields_to_fill: { 'Alamat email': address },
    autofill_bookmarklet: buildAutofillBookmarklet(address),
    autofill_userscript: buildAutofillUserscript(address),
    steps: [
      'Tempel email TempMail di kolom "Email address" pada tab platform.openai.com (tempel manual, atau pakai bookmarklet yang Anda klik sendiri).',
      'Tekan "Continue" di tab itu (BLEA tidak pernah menekan tombol itu untuk Anda).',
      'Salin URL halaman hasil lalu tempel di kolom "URL setelah menekan Continue" di panel ini.',
      'Panel mencocokkan domain, lalu menandai permintaan sebagai "email dikirim".',
    ],
  };
}

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
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Konfigurasi yang dikirim ke UI. `server_side_post` selalu false, dengan
 * alasan tertulis — bukan tombol yang diam-diam gagal.
 */
export function signupConfig() {
  return {
    route: 'platform',
    signup_url: PLATFORM_LOGIN_URL,
    api_keys_url: PLATFORM_API_KEYS_URL,
    billing_url: PLATFORM_BILLING_URL,
    method_used_by_browser: 'GET',
    supported: {
      build_signup_link: true,
      // login_hint TIDAK dijanjikan: halaman login platform tidak memakainya.
      login_hint: false,
      server_side_post: false,
      headless_signup: false,
      captcha_bypass: false,
      capture_session_cookie: false,
    },
    platform_steps: PLATFORM_STEPS,
    why_not_post: [
      'Cloudflare Worker BLEA diblokir ke domain OpenAI, jadi POST dari server tidak akan pernah berhasil.',
      'Pendaftaran akun otomatis melanggar Terms of Use OpenAI dan hasilnya langsung ditahan captcha.',
      'Karena itu formulir diisi di browser Anda; BLEA hanya menyiapkan tautan dan membaca inbox untuk kodenya.',
    ],
    verification_note: 'Verifikasi tetap dikerjakan manusia. BLEA membaca inbox TempMail, mengambil kode verifikasinya, lalu Anda menempelkan kode itu di tab platform.openai.com — tidak ada verifikasi otomatis.',
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
  if (/openai/.test(haystack)) { score += 45; reasons.push('pengirim menyebut OpenAI'); }
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
 * cukup diklik), dan kode itu harus ditempel kembali di tab platform. Snippet
 * inbox tidak selalu memuat kodenya, jadi isi lengkap perlu dibaca.
 *
 * Aturan pemilihan sengaja konservatif supaya tidak salah ambil angka:
 *   • utamakan deret 6–8 digit (bentuk kode OpenAI);
 *   • abaikan angka yang menempel pada tahun (`2026`), nominal, atau kuota;
 *   • kalau ada beberapa kandidat, menangkan yang dekat kata kunci;
 *   • ragu → kembalikan kosong, jangan menebak.
 */
export function extractVerificationCode({ subject = '', bodyText = '', bodyHtml = '' } = {}) {
  // Subjek ikut dibaca: sebagian email menaruh kodenya di subjek, dan subjek
  // juga memberi kata kunci ("verification code") untuk menilai kandidat.
  const plain = String(subject || '')
    .concat(' ', String(bodyText || ''))
    .concat(' ', String(bodyHtml || '').replace(/<[^>]+>/g, ' '))
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ');
  if (!plain.trim()) return { code: '', candidates: [] };

  const KEYWORD_RE = /(kode|code|verifikasi|verification|one[- ]?time|otp|masuk|sign[- ]?in)/i;
  const found = new Map();
  // Kode OpenAI 6 digit, kadang ditulis berkelompok ("483-920", "604 217").
  // Kelompok digabung lebih dulu, lalu deret 6–8 digit yang tidak menempel
  // pada huruf/angka lain. Bentuk berspasi hanya diterima bila ada kata kunci
  // di sekitarnya, supaya dua angka acak yang berdampingan tidak dianggap kode.
  const pattern = /(?<![A-Za-z0-9])(\d{3}-\d{3}|\d{3} \d{3}|\d{6,8})(?![A-Za-z0-9])/g;
  let match;
  while ((match = pattern.exec(plain)) !== null) {
    const code = match[1].replace(/[\s-]/g, '');
    const start = Math.max(0, match.index - 60);
    const context = plain.slice(start, match.index + match[1].length + 60);
    if (/\s/.test(match[1]) && !/kode|code|otp|verifikasi|verification/i.test(context)) continue;
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

/**
 * Kode verifikasi OpenAI berumur pendek (±10 menit). Panel harus tahu itu,
 * supaya tidak menyajikan kode basi seolah masih berlaku.
 *
 * Ambang 10 menit dipakai sebagai batas tampil; lewat dari itu kode tetap
 * ditunjukkan tetapi ditandai kedaluwarsa, bukan disembunyikan — menghapusnya
 * akan membuat pengguna mengira BLEA tidak pernah menemukan kode.
 */
export const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;

export function describeStoredCode({ code = '', verified_at: verifiedAt = null, now = Date.now() } = {}) {
  const value = String(code || '').trim();
  if (!value) return { code: '', expired: false, age_ms: null, note: '' };
  const takenAt = Date.parse(verifiedAt || '');
  if (!Number.isFinite(takenAt)) {
    // Tanpa waktu, jangan mengklaim masih berlaku.
    return { code: value, expired: false, age_ms: null, note: 'Waktu kode tidak tercatat — pastikan masih yang terbaru.' };
  }
  const age = Math.max(0, now - takenAt);
  const expired = age > VERIFICATION_CODE_TTL_MS;
  return {
    code: value,
    expired,
    age_ms: age,
    note: expired
      ? 'Kode ini sudah lewat 10 menit dan hampir pasti kedaluwarsa. Minta kode baru di halaman platform lalu tekan "Cari email verifikasi" lagi.'
      : '',
  };
}

/**
 * Kenapa TIDAK ada pemeriksaan sesi otomatis dari browser.
 *
 * Versi sebelumnya memanggil API privat milik halaman konsumen OpenAI dengan
 * `credentials: 'include'`. Hasil nyata di browser pengguna: **"Failed to
 * fetch"** — endpoint itu bukan API publik dan tidak mengirim header CORS,
 * jadi jawabannya tidak bisa dibaca dari origin lain (BLEA). Itu kesalahan
 * rancang, bukan gangguan jaringan pengguna.
 *
 * Jadi yang disediakan hanya langkah manual yang jujur: periksa sendiri di tab
 * platform, karena di sana sesi itu memang terlihat.
 */
export function sessionCheckGuide() {
  return {
    automatic: false,
    why: 'Halaman konsumen OpenAI tidak mengizinkan halaman lain membaca status sesinya (tanpa header CORS), jadi pemeriksaan otomatis dari BLEA selalu berakhir "Failed to fetch".',
    steps: [
      'Buka platform.openai.com di tab yang sama dengan tab login.',
      'Kalau yang muncul adalah menu akun (bukan formulir login), perangkat ini MASIH login sebagai akun lain — keluarkan dulu, atau pakai jendela Incognito yang benar-benar baru.',
      'Kalau yang muncul formulir "Email address" + Continue, sesi bersih dan alur daftar bisa mulai.',
    ],
    note: 'BLEA tidak membaca cookie platform.openai.com. Setelah akun masuk, buat API key di menu API keys lalu tempel di "Tambah akun manual" di panel Akun OpenAI.',
  };
}

/**
 * Terjemahkan error OAuth OpenAI menjadi sebab + langkah.
 *
 * Kenapa perlu: `invalid_state` bisa muncul SEBELUM callback kita, jadi BLEA
 * bahkan tidak menerima parameter apa pun (tidak ada baris DB yang bisa
 * diperiksa). Menampilkan kode mentah hanya membuat pengguna menebak.
 */
export function explainOAuthError({ error = '', detail = '', hasPendingAttempt = false } = {}) {
  const code = String(error || '').trim() || 'unknown';
  const extra = String(detail || '').trim();
  if (code === 'invalid_state') {
    // `invalid_state` muncul di DUA tempat berbeda dan obatnya berbeda. Pada
    // halaman daftar/verifikasi (auth_page=…) itu milik sesi tab OpenAI; pada
    // /api/accounts/authorize itu milik percobaan OAuth BLEA.
    const stage = /authorize/.test(String(detail || ''))
      ? 'OAuth BLEA (/api/accounts/authorize)'
      : 'halaman daftar/verifikasi OpenAI (auth_page)';
    return {
      code,
      stage,
      cause: hasPendingAttempt
        ? 'OpenAI mengembalikan state yang tidak cocok dengan percobaan login yang dikirim dari perangkat ini — biasanya karena halaman OAuth dibuka ulang/duplikat, atau callback diselesaikan di perangkat/tab lain.'
        : 'Tidak ada percobaan OAuth yang sah dari perangkat ini, jadi state ini bukan milik BLEA. Pada halaman daftar/verifikasi state itu milik sesi tab OpenAI sendiri: tab ditutup lalu dipulihkan dari riwayat, formulir dibuka dua kali, atau sesinya sudah kedaluwarsa. Pada halaman authorize, kemungkinan URL lama dibuka lagi atau percobaannya sudah lewat 30 menit.',
      fix: hasPendingAttempt
        ? 'Tutup tab OAuth yang lama, lalu tekan Connect SEKALI dan selesaikan di tab itu sampai kembali ke BLEA.'
        : 'Tekan Connect sampai halaman izin OpenAI terbuka, jangan menyimpan atau membuka ulang URL-nya, dan jangan menekan tombol itu dua kali (dua percobaan = dua state).',
      detail: extra,
    };
  }
  if (code === 'access_denied') {
    return { code, cause: 'Izin di halaman persetujuan OpenAI tidak diberikan (tombol batal/ditolak).', fix: 'Ulangi dan setujui izinnya.', detail: extra };
  }
  if (code === 'subscription_sharing_user_not_eligible') {
    return {
      code,
      stage: 'pemakaian paket (Responses API)',
      cause: 'Login berhasil, tetapi OpenAI menolak membagikan paket akun ini ke aplikasi lain. '
        + 'Ini keputusan di sisi OpenAI untuk akun/workspace tersebut, bukan kesalahan kode atau token.',
      fix: 'Pakai akun dengan paket Plus/Pro (akun pribadi, bukan workspace kerja), atau '
        + 'tambahkan API key dengan saldo prabayar di Studio → Akun OpenAI. '
        + 'Mengulangi tombol Connect tidak akan mengubahnya.',
      detail: extra,
    };
  }
  if (code === 'subscription_sharing_usage_limit_exceeded') {
    return {
      code,
      stage: 'pemakaian paket (Responses API)',
      cause: 'Batas pemakaian paket untuk aplikasi ini sudah tercapai. Ini batas sementara, bukan kredensial rusak.',
      fix: 'Tunggu sampai jendela pemakaian pulih, atau tambahkan akun lain ke pool. '
        + 'Sisa pemakaian bisa dilihat di pengaturan Usage akun OpenAI Anda.',
      detail: extra,
    };
  }
  if (code === 'invalid_grant') {
    return {
      code,
      stage: 'penukaran kode (token endpoint)',
      cause: 'Kode otorisasi ditolak, dan OpenAI tidak menyebut sebabnya. Kode itu hanya bisa ditukar SEKALI.',
      fix: 'Periksa berurutan: (1) apakah akun sudah muncul di daftar di bawah — kalau sudah, tidak ada yang perlu diulang; '
        + '(2) jangan membuka atau memuat ulang alamat 127.0.0.1:<port>/auth/callback dua kali; '
        + '(3) pastikan persetujuan diberikan untuk klien yang sama (client_id di URL authorize = client_id saat menukar kode); '
        + '(4) bila akun memakai paket langganan, harus paket yang mengizinkan API pada akun pribadi, bukan akun workspace kerja.',
      detail: extra,
    };
  }
  if (code === 'invalid_refresh_token' || code === 'refresh_token_expired'
    || code === 'refresh_token_invalidated' || code === 'refresh_token_reused') {
    return {
      code,
      stage: 'refresh token',
      cause: 'Refresh token sudah mati atau dicabut (bisa dicabut dari sisi OpenAI → Settings → Apps).',
      fix: 'Sambungkan ulang akun lewat "Connect". Client terbitan disimpan, jadi ini tidak mendaftar ulang.',
      detail: extra,
    };
  }
  return { code, cause: extra || 'OpenAI tidak memberi penjelasan tambahan.', fix: 'Ulangi OAuth dari tombol Connect.', detail: extra };
}

/**
 * Port & redirect_uri yang DIPAKAI untuk OAuth OpenAI.
 *
 * Dipakai UI untuk menampilkan nilai persis yang dikirim, supaya pengguna bisa
 * mencocokkannya dengan URL di bilah alamat saat `invalid_state` terjadi —
 * tanpa itu, pesan error hanya jadi tebakan.
 */
export const OAUTH_LOOPBACK_PATH = '/auth/callback';

export function resolveOAuthRedirectUri({ hostname = '', port = '' } = {}) {
  const isLoopbackHost = String(hostname || '') === '127.0.0.1';
  const digits = /^\d+$/.test(String(port || '')) ? String(port) : '';
  const chosen = isLoopbackHost ? (digits || '80') : String(randomLoopbackPort());
  return {
    hostname: '127.0.0.1',
    port: Number(chosen),
    redirect_uri: `http://127.0.0.1:${chosen}${OAUTH_LOOPBACK_PATH}`,
    // Di domain publik tidak ada yang mendengarkan di port itu, jadi callback
    // harus diselesaikan dengan menempel URL.
    auto_callback: isLoopbackHost,
  };
}

function randomLoopbackPort() {
  const buffer = new Uint16Array(1);
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    cryptoObj.getRandomValues(buffer);
    return 1024 + (buffer[0] % (65535 - 1024 + 1));
  }
  return 1024 + Math.floor(Math.random() * (65535 - 1024 + 1));
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
    verification_code_at: row.verification_code_at || null,
    verified_at: row.verified_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function validateSignupInput(input = {}) {
  const email = cleanText(input.email, 320).toLowerCase();
  if (!isSignupEmail(email)) throw fail('Email TempMail tidak valid. Buat atau muat ulang alamat TempMail lebih dulu.', 400);
  // Parameter ini tidak lagi memengaruhi URL (halaman login platform tidak
  // memakainya), tetapi tetap divalidasi agar tidak ada nilai sampah di DB.
  const authSessionLoggingId = cleanText(input.auth_session_logging_id, 64);
  if (authSessionLoggingId && !/^[0-9a-f-]{20,64}$/i.test(authSessionLoggingId)) {
    throw fail('auth_session_logging_id harus berupa UUID.', 400);
  }
  return { email, auth_session_logging_id: authSessionLoggingId, plus_address: isPlusAddress(email) };
}

/**
 * Baca URL hasil klik "Continue" di halaman login platform, untuk memastikan
 * langkah benar-benar sampai ke tahap berikutnya (bukan tetap di halaman
 * error).
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
  const openAiHost = host === 'openai.com' || host.endsWith('.openai.com');
  const path = parsed.pathname || '';
  const whole = `${parsed.search} ${decodeURIComponent(parsed.search)}`.toLowerCase();
  const expected = cleanText(expectedEmail, 320).toLowerCase();
  const emailMatches = Boolean(expected) && whole.includes(expected);
  const stillError = /\/error/.test(path) || /error=/.test(parsed.search);
  // Halaman "Session ended" milik OpenAI TIDAK memuat kata "error" di path
  // maupun query — hanya judulnya yang berkata begitu, dan `auth_page=…`
  // hanyalah penanda sesi tab yang sudah mati. URL semacam itu tidak membawa
  // `state` dan tidak menyebut email, jadi tidak bisa dipakai melanjutkan.
  const endsSession = /\/(email-verification|session-ended)(\/|$)/.test(path);
  const sessionEnded = endsSession && !/state=/.test(parsed.search) && !emailMatches;
  const verification = /verify|verification|confirm|check.?email|email-verification|code/.test(`${path} ${whole}`);
  // Halaman awal: pengguna baru membuka formulir dan belum menekan Continue.
  const landing = /^\/(login|log-in|auth\/login|create-account|signup)?\/?$/.test(path) || path === '/';

  if (!openAiHost) {
    return { ok: false, status: 'host_asing', detail: `Host ${host} bukan domain OpenAI. Salin URL dari tab platform.openai.com.`, email_matches: false };
  }
  if (sessionEnded) {
    return {
      ok: false,
      status: 'sesi_berakhir',
      detail: 'Itu halaman “Session ended” milik OpenAI: sesi login di tab itu sudah tidak berlaku. '
        + 'Tab lama tidak bisa dilanjutkan — buka lagi dari panel (tab BARU, bukan dari riwayat) dan '
        + 'jangan menutup tab TempMail.',
      email_matches: emailMatches,
    };
  }
  if (stillError) {
    return {
      ok: false,
      status: 'masih_error',
      detail: 'URL itu halaman error. Ulangi dari halaman login platform di panel; kalau tetap error, coba jendela privat atau jaringan lain.',
      email_matches: emailMatches,
    };
  }
  if (landing) {
    return {
      ok: false,
      status: 'halaman_awal',
      detail: 'Itu masih halaman awal (formulir email). Isi email, tekan Continue, lalu salin URL halaman berikutnya.',
      email_matches: emailMatches,
    };
  }
  // PENTING: OpenAI TIDAK membawa email di URL lanjutan — yang tersisa hanya
  // `state=`, dan itu memang normal. Jadi URL lanjutan yang bukan error
  // dianggap bukti sah bahwa formulir menerima email.
  return {
    ok: true,
    status: verification ? 'verifikasi' : emailMatches ? 'email_diterima' : 'lanjutan',
    detail: emailMatches
      ? 'Email TempMail terbaca di URL — formulir sudah menerimanya.'
      : 'Halaman lanjutan OpenAI diterima (email memang tidak ditampilkan di URL — itu normal, bukan kegagalan). Lanjutkan: tempel kode dari TempMail di tab itu.',
    email_matches: emailMatches,
  };
}

/**
 * Kenapa halaman login platform lebih aman daripada jalur aplikasi.
 *
 * Jalur daftar lama (halaman login konsumen dengan callback aplikasi)
 * ditujukan untuk aplikasi
 * konsumen: setelah verifikasi, OpenAI mengembalikan konteks ke callback
 * aplikasi (`openai://…`) yang tidak ada penanganannya di browser, sehingga
 * halaman berputar tanpa hasil. Jalur platform berakhir di
 * `platform.openai.com/home` — halaman web biasa yang bisa dilanjutkan.
 */
export const APP_HANDOFF_GUIDE = {
  summary: 'Kalau halaman berhenti di “buka aplikasi”, mulai lagi dari jalur platform',
  why: 'Jalur daftar lama ditujukan untuk aplikasi konsumen OpenAI. Setelah verifikasi, OpenAI '
    + 'mengembalikan konteks ke callback aplikasi (openai://…), dan browser tidak punya '
    + 'penangan untuk itu — karena itu halamannya berputar terus.',
  steps: [
    'Kode verifikasi Anda sudah diterima OpenAI; akunnya biasanya sudah jadi. Jangan ulangi pendaftaran dengan email yang sama.',
    'Tutup tab OpenAI yang macet (yang menampilkan tombol “buka aplikasi”).',
    'Di panel ini, buat permintaan baru lalu tekan “Siapkan & buka daftar” — jalur platform berakhir di platform.openai.com/home, bukan di aplikasi.',
    'Kalau akun sudah bisa masuk, buat API key di menu API keys lalu tempel di “Tambah akun manual”.',
  ],
  note: 'Akses yang disimpan BLEA adalah API key platform (sk-…), bukan cookie sesi dan bukan deep link aplikasi.',
};

/**
 * Bisakah callback OAuth diselesaikan dari halaman ini?
 *
 * Kalau BLEA dibuka dari domain publik, browser pengguna tidak punya apa pun di
 * `127.0.0.1:<port>`; URL callback harus ditempel. Panel memakai ini untuk
 * menjelaskan langkahnya SEBELUM pengguna terlanjur menekan tombol.
 */
export function describeOAuthCallbackPath({ hostname = '', port = '' } = {}) {
  const info = resolveOAuthRedirectUri({ hostname, port });
  return {
    redirect_uri: info.redirect_uri,
    automatic: info.auto_callback,
    steps: info.auto_callback
      ? ['Setelah menekan tombol, OpenAI membuka halaman izin. Setujui, lalu Anda kembali sendiri ke BLEA dan akunnya tersimpan.']
      : [
        'Setelah menekan tombol, OpenAI membuka halaman izin. Setujui di sana.',
        `Browser akan berhenti di ${info.redirect_uri}?code=…&state=… dan halaman itu biasanya “tidak bisa diakses” — itu normal.`,
        'Salin SELURUH alamat itu dari bilah alamat, kembali ke panel, tempel di kolom “Sudah menyetujui di OpenAI?”, lalu tekan Selesaikan.',
      ],
    note: 'Callback memakai 127.0.0.1 karena OpenAI mewajibkan itu untuk klien open-source; '
      + 'halaman BLEA tetap tidak pernah menyimpan cookie atau token sesi konsumen.',
  };
}

/** Ringkas status penyimpanan akses supaya tidak diklaim berhasil tanpa bukti. */
export function summarizeAccessStorage({ linkedCount = 0, pendingCount = 0 } = {}) {
  if (linkedCount > 0) {
    return {
      stored: true,
      text: `${linkedCount} akun sudah punya access token tersegel di server (refresh otomatis 60 detik sebelum kedaluwarsa).`,
    };
  }
  if (pendingCount > 0) {
    return {
      stored: false,
      text: 'Belum ada akses yang tersimpan: OAuth masih menunggu izin. Selesaikan di halaman persetujuan OpenAI, lalu tempel URL callback.',
    };
  }
  return {
    stored: false,
    text: 'Belum ada akses OAuth yang tersimpan. Akun API key tidak perlu OAuth — cukup tempel sk-… di "Tambah akun manual".',
  };
}
