import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  PLATFORM_API_KEYS_URL,
  PLATFORM_HOME_URL,
  PLATFORM_LOGIN_URL,
  PLATFORM_NEXT_PATHS,
  PLATFORM_STEPS,
  analyzeReturnUrl,
  buildPlatformSignupUrl,
  buildSigninBootstrap,
  isPlusAddress,
  scoreVerificationMessage,
  signupConfig,
  validateSignupInput,
} from '../src/lib/openaiSignup.js';

const signupModule = await import('../src/lib/openaiSignup.js');
globalThis.__signup = signupModule;

const BASE = 'https://app.example';
const ENV = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
};

function request(path, { method = 'GET', body, token = 'admin-jwt' } = {}) {
  return new Request(`${BASE}/api${path}`, {
    method,
    headers: {
      origin: BASE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('URL pendaftaran memakai platform.openai.com dengan next yang dibatasi', () => {
  const url = new URL(buildPlatformSignupUrl('sugionoofficial88+1@gmail.com', { next: '/api-keys' }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://platform.openai.com/login');
  assert.equal(url.searchParams.get('next'), '/api-keys');

  // Tanpa `next`, URL-nya persis halaman login.
  assert.equal(buildPlatformSignupUrl('a@b.co'), PLATFORM_LOGIN_URL);
  // `next` di luar daftar tetap dibuang: parameter ini tidak boleh dipakai
  // mengarahkan pengguna ke domain lain.
  assert.equal(buildPlatformSignupUrl('a@b.co', { next: 'https://evil.example' }), PLATFORM_LOGIN_URL);
  assert.equal(buildPlatformSignupUrl('a@b.co', { next: '//evil.example' }), PLATFORM_LOGIN_URL);
  for (const path of PLATFORM_NEXT_PATHS) {
    assert.ok(buildPlatformSignupUrl('a@b.co', { next: path }).endsWith(`next=${encodeURIComponent(path)}`));
  }
  // Email tidak pernah dikirim sebagai parameter: halaman login platform tidak
  // memakai login_hint, dan parameter karangan bisa memicu error.
  assert.ok(!url.href.includes('sugionoofficial'));
  assert.equal(url.searchParams.get('login_hint'), null);

  const config = signupConfig({});
  assert.equal(config.route, 'platform');
  assert.equal(config.signup_url, PLATFORM_LOGIN_URL);
  assert.equal(config.api_keys_url, PLATFORM_API_KEYS_URL);
  assert.equal(config.supported.login_hint, false);
  assert.equal(config.supported.server_side_post, false);
  assert.equal(config.supported.headless_signup, false);
  assert.equal(config.supported.captcha_bypass, false);
  assert.equal(config.supported.capture_session_cookie, false);
  assert.deepEqual(config.platform_steps, PLATFORM_STEPS);
  // Langkahnya harus benar-benar berakhir di platform, bukan di aplikasi.
  assert.match(PLATFORM_STEPS.join(' '), /platform\.openai\.com\/home/);
  assert.match(PLATFORM_STEPS.join(' '), /API key/);
});

test('bootstrap sign-in hanya berisi langkah manual, tanpa CSRF dan tanpa POST', () => {
  const bootstrap = buildSigninBootstrap('a+1@b.co');
  assert.equal(bootstrap.form.url, PLATFORM_LOGIN_URL);
  assert.equal(bootstrap.form.method, 'GET');
  assert.equal(bootstrap.fields_to_fill['Alamat email'], 'a+1@b.co');
  // Tidak ada token CSRF: halaman login platform bukan endpoint NextAuth.
  assert.equal(bootstrap.csrf, undefined);
  assert.ok(!JSON.stringify(bootstrap).includes('csrfToken'));
  assert.ok(bootstrap.steps.some((line) => /Continue/.test(line)));
  assert.ok(!JSON.stringify(bootstrap).includes('/api/auth/signin'));
  assert.ok(!JSON.stringify(bootstrap).includes('login_with'));
});

test('analyzeReturnUrl membedakan halaman error, host asing, dan email yang benar-benar terkirim', () => {
  const email = 'kotak+1@mail.tm';

  const error = analyzeReturnUrl('https://platform.openai.com/error?error=OAuthSignin', email);
  assert.equal(error.ok, false);
  assert.equal(error.status, 'masih_error');

  const foreign = analyzeReturnUrl('https://evil.example/login?email=kotak%2B1%40mail.tm', email);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.status, 'host_asing');

  const notUrl = analyzeReturnUrl('bukan url', email);
  assert.equal(notUrl.ok, false);
  assert.equal(notUrl.status, 'tidak_valid');

  const accepted = analyzeReturnUrl('https://auth.openai.com/u/signup/identifier?state=abc&login_hint=kotak%2B1%40mail.tm', email);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.email_matches, true);

  const verification = analyzeReturnUrl('https://auth.openai.com/u/email-verification?email=kotak%2B1%40mail.tm', email);
  assert.equal(verification.ok, true);
  assert.equal(verification.status, 'verifikasi');

  // Regresi dari laporan nyata: URL ini tampil di browser dengan judul
  // "Session ended" + error_code: invalid_state, tetapi analyzer lama
  // menganggapnya "verifikasi" karena tidak ada kata "error" di URL.
  // `auth_page=…` menandai halaman milik sesi tab yang sudah mati dan tidak
  // membawa `state`, jadi tidak bisa dipakai melanjutkan daftar.
  const ended = analyzeReturnUrl('https://auth.openai.com/email-verification?auth_page=YVXP3qYcCk42c3H0mcISDEgR3G4UGicJ', email);
  assert.equal(ended.ok, false);
  assert.equal(ended.status, 'sesi_berakhir');
  assert.match(ended.detail, /Session ended|sesi login/i);

  // Halaman awal (belum menekan Continue) tetap ditolak — baik halaman baru
  // (formulir Auth0) maupun halaman lama.
  for (const startUrl of [
    'https://platform.openai.com/login',
    'https://auth.openai.com/log-in',
    'https://auth.openai.com/log-in?auth_page=abc',
    'https://auth.openai.com/create-account?auth_page=abc',
  ]) {
    const landing = analyzeReturnUrl(startUrl, email);
    assert.equal(landing.ok, false, startUrl);
    assert.equal(landing.status, 'halaman_awal', startUrl);
  }

  // Auth0 TIDAK membawa email di URL lanjutan (hanya state=). URL seperti itu
  // harus DITERIMA — bukan ditolak karena email tidak terlihat.
  const advanced = analyzeReturnUrl('https://auth.openai.com/u/login/identifier?state=hKFo2SAbcdef', email);
  assert.equal(advanced.ok, true);
  assert.equal(advanced.status, 'lanjutan');
  assert.equal(advanced.email_matches, false);
  assert.match(advanced.detail, /normal, bukan kegagalan/i);

  // Status lama yang mustahil dipenuhi tidak boleh kembali.
  assert.ok(!JSON.stringify(analyzeReturnUrl('https://auth.openai.com/u/signup/password?state=x', email)).includes('email_tidak_terlihat'));
});

test('validasi email pendaftaran menolak alamat rusak dan menandai +tag', () => {
  assert.deepEqual(validateSignupInput({ email: 'A@B.co' }), { email: 'a@b.co', auth_session_logging_id: '', plus_address: false });
  assert.equal(validateSignupInput({ email: 'a+tag@b.co' }).plus_address, true);
  assert.equal(isPlusAddress('a+tag@b.co'), true);
  assert.equal(isPlusAddress('a@b.co'), false);
  assert.throws(() => validateSignupInput({ email: 'bukan-email' }), /tidak valid/i);
  assert.throws(() => validateSignupInput({ email: 'a@b.co', auth_session_logging_id: 'x' }), /UUID/i);
});

test('pencocokan email verifikasi memakai pengirim, kata kunci, penerima, dan waktu', () => {
  const row = { email: 'kotak+1@mail.tm', created_at: '2026-11-23T10:00:00Z' };
  const good = scoreVerificationMessage({
    subject: 'Verify your email for OpenAI',
    from: 'noreply@tm.openai.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-23T10:00:40Z',
  }, row);
  assert.equal(good.matched, true);
  assert.ok(good.score >= 50);
  assert.ok(good.reasons.length >= 2);

  const unrelated = scoreVerificationMessage({
    subject: 'Promo akhir tahun',
    from: 'toko@example.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-23T10:00:40Z',
  }, row);
  assert.equal(unrelated.matched, false);

  // Email lama (sebelum pendaftaran dimulai) tidak boleh dianggap verifikasi.
  const old = scoreVerificationMessage({
    subject: 'OpenAI verification code',
    from: 'noreply@openai.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-20T10:00:00Z',
  }, row);
  assert.ok(old.reasons.includes('diterima sebelum pendaftaran dimulai'));
});

test('/api/openai-signup hanya untuk admin dan melaporkan bahwa POST server tidak didukung', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    }
    if (target.includes('/rest/v1/openai_signup_attempts')) return Response.json([]);
    if (target.includes('/rest/v1/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm' }]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup'), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.supported.server_side_post, false);
    assert.equal(body.temp_email.email, 'kotak@mail.tm');
    assert.deepEqual(body.attempts, []);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('/api/openai-signup menolak non-admin dan aksi asing', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: 'user-1', app_metadata: { role: 'user' } });
    }
    if (target.includes('/rest/v1/openai_signup_attempts')) return Response.json([]);
    if (target.includes('/rest/v1/tempmail_user_aliases')) return Response.json([]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup'), ENV);
    assert.equal(res.status, 403);

    const bad = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'hack' } }), ENV);
    assert.equal(bad.status, 403);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Regresi: `window.open` setelah `await` dianggap bukan bagian dari klik
// pengguna sehingga diblokir popup blocker — tombol utama jadi tidak melakukan
// apa pun. Panel harus membuka tab kosong SEBELUM menunggu server.
test('panel pendaftaran membuka tab sebelum await dan menyediakan tautan manual', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  const prepareBody = source.slice(source.indexOf('async function prepare()'), source.indexOf('async function mark('));
  const openIndex = prepareBody.indexOf("window.open('', '_blank')");
  const awaitIndex = prepareBody.indexOf('openAiSignupApi.prepare(');
  assert.ok(openIndex > -1, 'tab kosong harus dibuka lewat window.open');
  assert.ok(awaitIndex > -1, 'prepare harus memanggil API');
  assert.ok(openIndex < awaitIndex, 'window.open harus dipanggil sebelum await, bukan sesudahnya');
  assert.ok(!/await load\(\);\s*if \(url\) window\.open/.test(prepareBody), 'pola lama (open setelah await) tidak boleh kembali');
  // Jalan keluar bila popup diblokir keras.
  assert.ok(source.includes('Buka di tab baru'), 'harus ada tautan manual bila tab baru diblokir');
});

// Regresi 42P10: upsert memakai PostgREST `on_conflict=user_id,email`, jadi
// migrasi WAJIB punya unique constraint pada kolom apa adanya. Unique index
// ekspresi (user_id, lower(email)) saja tidak bisa diinferensi ON CONFLICT.
test('migrasi pendaftaran menyediakan unique constraint (user_id, email) untuk upsert', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.includes('openai_signup_attempts') || name.includes('openai_signup_on_conflict'));
  assert.ok(files.length >= 2, 'migrasi awal + migrasi perbaikan harus ada');
  const sql = files.map((name) => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  assert.ok(
    /unique\s*\(\s*user_id\s*,\s*email\s*\)/i.test(sql),
    'harus ada unique (user_id, email) agar ON CONFLICT (user_id, email) sah',
  );
  assert.ok(/on_conflict=user_id,email/.test(readFileSync(new URL('../src/lib/openaiSignupRoute.js', import.meta.url), 'utf8')));
});

// Aksi `confirm` harus menolak URL yang tidak membuktikan apa pun, dan hanya
// menandai `email_dikirim` bila URL memang memuat email TempMail.
test('/api/openai-signup confirm menolak halaman error dan menerima URL ber-email', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: 'admin-1',
    email: 'kotak+1@mail.tm',
    signup_url: 'https://platform.openai.com/login',
    step: 'dibuka',
    note: '',
    verification_message_id: '',
    verified_at: null,
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:00Z',
  };
  let patched = null;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/openai_signup_attempts')) {
      if ((init.method || 'GET') === 'PATCH') {
        patched = JSON.parse(String(init.body));
        return Response.json([{ ...attempt, ...patched }]);
      }
      if (target.includes('id=eq.')) return Response.json([attempt]);
      return Response.json([attempt]);
    }
    if (target.includes('/tempmail_user_aliases')) return Response.json([]);
    return new Response('not found', { status: 404 });
  };
  try {
    const bad = await worker.fetch(request('/openai-signup', {
      method: 'POST',
      body: { action: 'confirm', id: attempt.id, url: 'https://platform.openai.com/error?error=OAuthSignin' },
    }), ENV);
    const badBody = await bad.json();
    assert.equal(bad.status, 200);
    assert.equal(badBody.ok, false);
    assert.equal(badBody.analysis.status, 'masih_error');
    assert.equal(patched, null, 'URL error tidak boleh mengubah langkah');

    const good = await worker.fetch(request('/openai-signup', {
      method: 'POST',
      body: { action: 'confirm', id: attempt.id, url: 'https://auth.openai.com/u/signup/identifier?login_hint=kotak%2B1%40mail.tm' },
    }), ENV);
    const goodBody = await good.json();
    assert.equal(good.status, 200);
    assert.equal(goodBody.ok, true);
    assert.equal(goodBody.attempt.step, 'email_dikirim');
    assert.equal(patched.step, 'email_dikirim');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Fakta terverifikasi dari percobaan nyata: /auth/login membuka halaman dengan
// kolom "Alamat email" KOSONG — OpenAI mengabaikan login_hint di sana. UI tidak
// boleh lagi menjanjikan isian otomatis, dan harus menyediakan penyalinan email
// satu klik (dengan fallback bila Clipboard API ditolak).
test('panel jujur soal isi email manual dan menyediakan salin email dengan fallback', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('tidak terisi otomatis'), 'harus menyatakan kolom email tidak terisi otomatis');
  assert.ok(source.includes('same-origin'));
  assert.ok(source.includes('login_hint'), 'alasan teknisnya harus tetap disebut');
  assert.ok(source.includes('Salin email'), 'harus ada tombol salin email');
  // Fallback wajib: navigator.clipboard sering ditolak di iframe/preview.
  assert.ok(source.includes('execCommand'), 'harus ada fallback execCommand');
  assert.ok(source.includes('Clipboard tidak tersedia di browser ini'));
  // Panel hanya satu jalur: pemilih route/openai tidak boleh kembali.
  assert.ok(!/name="cga-route"/.test(source), 'pemilih jalur sudah dihapus');
});

// Autofill lintas-origin tidak mungkin dari halaman BLEA (same-origin policy).
// Satu-satunya jalan sah: bookmarklet yang dijalankan DI halaman platform atas
// klik pengguna.
test('bookmarklet pengisi email: aman, tidak mengirim, dan menargetkan kolom email', () => {
  const { buildAutofillBookmarklet } = globalThis.__signup;
  const email = 'sugionoofficial88+1@gmail.com';
  const bookmarklet = buildAutofillBookmarklet(email);
  assert.ok(bookmarklet.startsWith('javascript:'), 'harus berupa bookmarklet javascript:');
  const decoded = decodeURIComponent(bookmarklet.slice('javascript:'.length));
  assert.ok(decoded.includes(JSON.stringify(email)), 'email harus ikut tertanam');
  // Hanya mengisi kolom: tidak menekan tombol, tidak submit, tidak baca cookie.
  assert.ok(!/\.submit\(|\.click\(|requestSubmit|cookie|localStorage|fetch\(/i.test(decoded));
  assert.ok(decoded.includes("dispatchEvent(new Event('input'"));
  // Kolom telepon tidak boleh dipilih lebih dulu (Lanjutkan dengan nomor
  // telepon ada di halaman yang sama).
  assert.ok(decoded.includes("el.type==='tel'"));
  // Injektif aman: email berkutip ditolak, bukan disisipkan mentah.
  assert.throws(() => buildAutofillBookmarklet('a"@b.co'), /tidak aman/i);
  assert.throws(() => buildAutofillBookmarklet('a b@c.co'), /tidak valid|tidak aman/i);
});

test('bootstrap menyertakan bookmarklet dan langkah yang tidak mengklaim otomatis', () => {
  const { buildSigninBootstrap } = globalThis.__signup;
  const bootstrap = buildSigninBootstrap('kotak+1@mail.tm');
  assert.ok(bootstrap.autofill_bookmarklet.startsWith('javascript:'));
  assert.ok(bootstrap.autofill_userscript.startsWith('// ==UserScript=='));
  assert.ok(bootstrap.steps.some((line) => /bookmarklet|tempel/i.test(line)));
  // Langkah menyebut tombol yang benar-benar ada di halaman login platform.
  assert.ok(bootstrap.steps.some((line) => /Continue/.test(line)));
  assert.ok(bootstrap.steps.some((line) => /BLEA tidak pernah menekan/i.test(line)));
});

// Userscript harus benar-benar mengisi kolom di DOM halaman OpenAI palsu —
// bukan cuma lolos pemeriksaan string. Kolom telepon (type=tel) tidak boleh
// dipilih, dan skrip tidak boleh menekan tombol apa pun.
test('userscript mengisi kolom email di DOM tiruan platform tanpa menekan tombol', async () => {
  const { JSDOM } = await import('jsdom');
  const { buildAutofillUserscript } = globalThis.__signup;
  const email = 'sugionoofficial88+1@gmail.com';
  const source = buildAutofillUserscript(email, { origin: BASE });

  const html = `<!doctype html><html><body>
    <div><button type="button">Lanjutkan dengan Google</button></div>
    <form>
      <div><input type="tel" name="phone" placeholder="Nomor telepon"></div>
      <div><input type="email" name="email" placeholder="Alamat email" autocomplete="username"></div>
      <button type="submit" id="submit-btn">Lanjutkan</button>
    </form></body></html>`;
  const dom = new JSDOM(html, { url: 'https://platform.openai.com/login', runScripts: 'outside-only' });
  const { window } = dom;
  let clicks = 0;
  let submits = 0;
  window.document.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => { clicks += 1; }));
  window.document.querySelector('form').addEventListener('submit', (event) => { submits += 1; event.preventDefault(); });

  window.eval(source.trim());

  const emailInput = window.document.querySelector('input[type=email]');
  const telInput = window.document.querySelector('input[type=tel]');
  assert.equal(emailInput.value, email, 'kolom email harus terisi');
  assert.equal(telInput.value, '', 'kolom telepon tidak boleh disentuh');
  assert.equal(window.document.activeElement, emailInput, 'fokus harus pindah ke kolom email');
  assert.equal(clicks, 0, 'userscript tidak boleh menekan tombol');
  assert.equal(submits, 0, 'userscript tidak boleh mengirim formulir');
  assert.ok(window.document.getElementById('blea-autofill-mark'), 'harus ada penanda kecil bahwa skrip berjalan');

  // Tidak ada akses kredensial atau jaringan dari userscript.
  const body = source.slice(source.indexOf('==/UserScript=='));
  assert.ok(!/cookie|localStorage|sessionStorage|fetch\(|XMLHttpRequest|\.submit\(/.test(body));
  assert.ok(!/document\.cookie/.test(body));
});

test('/api/openai-signup/userscript hanya untuk admin dan menyajikan berkas .user.js', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm' }]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup/userscript'), ENV);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/javascript/);
    assert.match(res.headers.get('content-disposition') || '', /\.user\.js/);
    const text = await res.text();
    assert.ok(text.startsWith('// ==UserScript=='));
    assert.ok(text.includes('"kotak@mail.tm"'), 'email alias aktif harus dipakai');
    assert.ok(text.includes('@match        https://platform.openai.com/*'));

    const bad = await worker.fetch(request('/openai-signup/userscript?email=bukan-email'), ENV);
    assert.equal(bad.status, 400);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Panel tidak boleh terasa "wajib pasang sesuatu": tidak ada langkah opsional
// yang menonjol, dan salin email tetap jalur utama.
test('alur manual tetap utama tanpa langkah opsional yang menonjol', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('Salin email'));
  assert.ok(!/Unduh userscript/.test(source), 'unduhan userscript tidak lagi ditampilkan di panel');
  assert.ok(!/cga-signup-optional/.test(source));
});

// Email OpenAI berisi KODE (bukan tautan yang cukup diklik). Ekstraksi harus
// konservatif: jangan sampai salah ambil tahun/nominal/ID.
test('extractVerificationCode mengambil kode 6 digit dan menolak angka lain', () => {
  const { extractVerificationCode } = globalThis.__signup;
  assert.equal(extractVerificationCode({ bodyText: 'Kode verifikasi Anda adalah 483920. Kode berlaku 10 menit.' }).code, '483920');
  assert.equal(extractVerificationCode({ bodyText: 'Kode: 483-920' }).code, '483920');
  assert.equal(extractVerificationCode({ bodyHtml: '<p>Kode: <b>774411</b></p>' }).code, '774411');
  assert.equal(extractVerificationCode({ bodyText: 'Your verification code is 918273. Dikirim 2026' }).code, '918273');
  // Negatif: tahun saja, dua kandidat tanpa kata kunci, dan tanpa kode.
  assert.equal(extractVerificationCode({ bodyText: 'Selamat tahun 2026 dari OpenAI' }).code, '');
  assert.equal(extractVerificationCode({ bodyText: 'Pesanan 123456 dikirim, resi 998877' }).code, '');
  assert.equal(extractVerificationCode({ bodyText: 'Terima kasih sudah mendaftar.' }).code, '');
  // Nominal/harga tidak boleh dianggap kode.
  assert.equal(extractVerificationCode({ bodyText: 'Total Rp 1250000 dibayar' }).code, '');
});

test('/api/openai-signup verify membaca isi email dan mengembalikan kode', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '33333333-3333-4333-8333-333333333333',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'email_dikirim',
    signup_url: '',
    note: '',
    verification_message_id: '',
    verification_code: '',
    verified_at: null,
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:00Z',
  };
  let patched = null;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      if ((init.method || 'GET') === 'PATCH') {
        patched = JSON.parse(String(init.body));
        return Response.json([{ ...attempt, ...patched }]);
      }
      return Response.json([attempt]);
    }
    if (target.includes('api.mail.tm/messages/msg-9')) {
      return Response.json({
        id: 'msg-9',
        subject: 'Verifikasi email Anda',
        from: { address: 'noreply@tm.openai.com' },
        text: 'Masukkan kode berikut untuk melanjutkan: 483920',
        html: ['<p>Kode: <b>483920</b></p>'],
        createdAt: '2026-11-23T10:00:30Z',
      });
    }
    if (target.includes('api.mail.tm/messages')) {
      // Inbox: snippet tidak memuat kode.
      return Response.json({ 'hydra:member': [{
        id: 'msg-9',
        subject: 'Verifikasi email Anda',
        from: { address: 'noreply@tm.openai.com' },
        to: [{ address: 'kotak@mail.tm' }],
        intro: 'Silakan verifikasi email Anda',
        createdAt: '2026-11-23T10:00:30Z',
      }] });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'verify', id: attempt.id } }), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.matched, true);
    assert.equal(body.code, '483920', 'kode harus diambil dari isi email, bukan snippet');
    assert.equal(patched.verification_code, '483920');
    assert.equal(patched.step, 'terverifikasi');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Regresi: setelah alur kode masuk, tidak boleh ada lagi teks yang mengirim
// pengguna mencari tautan verifikasi. OpenAI mengirim KODE.
test('tidak ada lagi instruksi "klik tautan" verifikasi di panel/konfigurasi', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/openaiSignup.js', import.meta.url), 'utf8');
  // Komentar boleh menyebut istilah lama untuk menjelaskan sejarah; yang
  // dilarang adalah teks yang dilihat pengguna.
  const visible = (source) => source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n');
  for (const [name, source] of [['panel', panel], ['lib', lib]]) {
    const text = visible(source);
    assert.ok(!/klik tautan/iu.test(text), `${name}: instruksi "klik tautan" verifikasi tidak boleh kembali`);
    assert.ok(!/verifikasi (email )?tetap diklik/iu.test(text), `${name}: klaim "verifikasi diklik" sudah tidak benar`);
  }
  // Panel wajib menyediakan kode + aksi salin.
  assert.match(panel, /cga-signup-code-value/);
  assert.ok(/Salin kode/.test(panel));
});

// Kasus Gmail: pesan verifikasi OpenAI nyata yang memuat kode di tengah HTML.
test('kode tetap terbaca dari HTML email yang berantakan', () => {
  const { extractVerificationCode } = globalThis.__signup;
  const html = '<div style="font-family:Arial"><p>Halo,</p><p>Masukkan kode ini untuk memverifikasi email Anda:</p>'
    + '<h1>604 217</h1><p>Kode ini berlaku 10 menit.</p><p>&copy; 2026 OpenAI</p></div>';
  // Kode ditulis berkelompok dengan spasi; kata "kode" di dekatnya membuatnya sah.
  assert.equal(extractVerificationCode({ subject: 'Verifikasi email Anda', bodyHtml: html }).code, '604217');
  // Tanpa kata kunci, bentuk berspasi tidak ditebak.
  assert.equal(extractVerificationCode({ bodyHtml: '<p>604 217</p>' }).code, '');
});

test('kode di subjek email tetap ditemukan', () => {
  const { extractVerificationCode } = globalThis.__signup;
  assert.equal(extractVerificationCode({ subject: 'Your OpenAI verification code: 552310', bodyText: '' }).code, '552310');
});

// Kode harus tetap bisa dilihat setelah panel dimuat ulang, tanpa memanggil
// Gmail lagi dan tanpa me-reset verified_at.
test('/api/openai-signup action=code membaca kode tersimpan tanpa menyentuh inbox', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '44444444-4444-4444-8444-444444444444',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'terverifikasi',
    signup_url: '',
    note: '',
    verification_message_id: 'msg-9',
    verification_code: '483920',
    verified_at: '2026-11-23T10:00:30Z',
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:30Z',
  };
  const visited = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    visited.push(`${init.method || 'GET'} ${target}`);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      if (target.includes('id=eq.55555555-5555-4555-8555-555555555555')) return Response.json([]);
      return Response.json([attempt]);
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'code', id: attempt.id } }), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, '483920');
    assert.equal(body.verification_message_id, 'msg-9');
    // Tidak boleh ada panggilan ke provider email maupun PATCH.
    assert.ok(!visited.some((line) => line.includes('mail.tm') || line.includes('gmail') || line.startsWith('PATCH')), visited.join('\n'));

    // Permintaan milik user lain tidak boleh membocorkan kode.
    const other = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'code', id: '55555555-5555-4555-8555-555555555555' } }), ENV);
    assert.equal(other.status, 404);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Kode OpenAI berumur pendek. Panel harus menandai kode basi, bukan diam saja.
test('describeStoredCode menandai kode lewat 10 menit sebagai kedaluwarsa', () => {
  const { describeStoredCode, VERIFICATION_CODE_TTL_MS } = globalThis.__signup;
  const now = Date.parse('2026-11-23T14:00:00Z');
  assert.equal(VERIFICATION_CODE_TTL_MS, 600000);

  const fresh = describeStoredCode({ code: '483920', verified_at: '2026-11-23T13:55:00Z', now });
  assert.equal(fresh.code, '483920');
  assert.equal(fresh.expired, false);
  assert.equal(fresh.note, '');

  const stale = describeStoredCode({ code: '483920', verified_at: '2026-11-23T13:40:00Z', now });
  assert.equal(stale.code, '483920', 'kode basi tetap ditampilkan, hanya ditandai');
  assert.equal(stale.expired, true);
  assert.match(stale.note, /kedaluwarsa/i);

  // Tanpa kode: tidak ada apa pun untuk ditampilkan.
  assert.deepEqual(describeStoredCode({ code: '', verified_at: '2026-11-23T13:55:00Z', now }).code, '');
  // Tanpa waktu: jangan mengklaim masih berlaku.
  const unknown = describeStoredCode({ code: '111222', verified_at: null, now });
  assert.equal(unknown.expired, false);
  assert.match(unknown.note, /tidak tercatat/i);
});

test('action=code menandai kode tersimpan yang sudah basi', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '66666666-6666-4666-8666-666666666666',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'terverifikasi',
    signup_url: '',
    note: '',
    verification_message_id: 'msg-9',
    verification_code: '483920',
    // 40 menit lalu: sudah lewat TTL 10 menit.
    verified_at: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:00Z',
  };
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/openai_signup_attempts')) return Response.json([attempt]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'code', id: attempt.id } }), ENV);
    const body = await res.json();
    assert.equal(body.code, '483920');
    assert.equal(body.code_expired, true);
    assert.match(body.hint, /kedaluwarsa/i);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Regresi penting: kode yang ditemukan pada pesan TIDAK dikenali tetap harus
// tersimpan, supaya tidak hilang saat panel dimuat ulang. Langkahnya pun tidak
// boleh naik ke "terverifikasi" karena belum terbukti email OpenAI.
test('kode dari pengirim tak dikenal disimpan tanpa menaikkan langkah', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '77777777-7777-4777-8777-777777777777',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'menunggu_verifikasi',
    signup_url: '',
    note: '',
    verification_message_id: '',
    verification_code: '',
    verification_code_at: null,
    verified_at: null,
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:00Z',
  };
  let patched = null;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      if ((init.method || 'GET') === 'PATCH') {
        patched = JSON.parse(String(init.body));
        return Response.json([{ ...attempt, ...patched }]);
      }
      return Response.json([attempt]);
    }
    if (target.includes('api.mail.tm/messages/msg-77')) {
      // Pengirim dikenal, tetapi isi pesannya tidak menyebut verifikasi/kode
      // di snippet; skornya di bawah ambang walau kode ada di isi.
      return Response.json({
        id: 'msg-77',
        subject: 'Pemberitahuan',
        from: { address: 'info@contoh.invalid' },
        text: 'Kode akses sementara: 730145',
        createdAt: '2026-11-23T10:00:30Z',
      });
    }
    if (target.includes('api.mail.tm/messages')) {
      return Response.json({ 'hydra:member': [{
        id: 'msg-77',
        subject: 'Pemberitahuan',
        from: { address: 'info@contoh.invalid' },
        to: [{ address: 'kotak@mail.tm' }],
        intro: 'Pemberitahuan',
        createdAt: '2026-11-23T10:00:30Z',
      }] });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'verify', id: attempt.id } }), ENV);
    const body = await res.json();
    assert.equal(body.matched, false, 'pengirim tak dikenal tidak boleh dianggap verifikasi');
    assert.equal(body.code, '730145');
    // Yang disimpan hanya kode + waktunya; langkah tidak dinaikkan.
    assert.equal(patched.verification_code, '730145');
    assert.equal(patched.verification_message_id, 'msg-77');
    assert.ok(patched.verification_code_at, 'waktu kode harus disimpan agar TTL bisa dihitung');
    assert.equal(patched.step, undefined);
    assert.equal(patched.verified_at, undefined);
    assert.equal(body.code_unverified, true, 'kode dari pengirim tak dikenal harus ditandai');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Halaman TempMail juga harus bisa menyalin kode: menyalin angka dari iframe
// email (sandbox) sering terpotong, dan pengguna tidak selalu membuka panel
// pendaftaran saat membaca email.
test('halaman TempMail menampilkan kode + Salin kode dari isi pesan', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../src/auth/TempMailPage.jsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/auth/tempmail.css', import.meta.url), 'utf8');
  assert.ok(page.includes("from '../lib/openaiSignup'"), 'harus memakai extractVerificationCode yang sama');
  assert.match(page, /extractVerificationCode\(/);
  assert.ok(/Salin kode/.test(page));
  assert.match(page, /className="tempmail-code"/);
  assert.match(css, /\.tempmail-code-value/);
  // Kode harus dari isi pesan yang dibuka, bukan ditebak di klien lain.
  assert.match(page, /selectedMessage\.bodyText/);
});

// Privasi: email lama di inbox admin tidak boleh dipindai isinya hanya karena
// kebetulan memuat angka 6 digit.
test('verify tidak membaca isi email lama sebelum pendaftaran dimulai', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '88888888-8888-4888-8888-888888888888',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'menunggu_verifikasi',
    signup_url: '',
    note: '',
    verification_message_id: '',
    verification_code: '',
    verification_code_at: null,
    verified_at: null,
    // Pendaftaran dimulai jam 10:00; pesan lama jam 08:00.
    created_at: '2026-11-23T10:00:00Z',
    updated_at: '2026-11-23T10:00:00Z',
  };
  const detailFetches = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      if ((init.method || 'GET') === 'PATCH') return Response.json([attempt]);
      return Response.json([attempt]);
    }
    if (target.includes('api.mail.tm/messages/')) {
      detailFetches.push(target);
      return Response.json({ id: 'msg-lama', subject: 'Kode gudang', text: 'Kode: 112233', createdAt: '2026-11-23T08:00:00Z' });
    }
    if (target.includes('api.mail.tm/messages')) {
      return Response.json({ 'hydra:member': [{
        id: 'msg-lama',
        subject: 'Kode gudang',
        from: { address: 'gudang@contoh.invalid' },
        to: [{ address: 'kotak@mail.tm' }],
        intro: 'Kode: 112233',
        createdAt: '2026-11-23T08:00:00Z',
      }] });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'verify', id: attempt.id } }), ENV);
    const body = await res.json();
    assert.equal(body.code, '', 'kode dari email lama tidak boleh diambil');
    assert.equal(detailFetches.length, 0, 'isi email lama tidak boleh dibaca sama sekali');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Baris dipakai ulang per alamat (upsert), jadi created_at bisa berhari-hari
// lalu. Patokan jendela harus ikut langkah terakhir, bukan hanya created_at.
test('verify tetap membaca email baru pada baris yang dibuat beberapa hari lalu', async () => {
  const oldFetch = globalThis.fetch;
  const now = Date.now();
  const attempt = {
    id: '99999999-9999-4999-8999-999999999999',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'menunggu_verifikasi',
    signup_url: '',
    note: '',
    verification_message_id: '',
    verification_code: '',
    verification_code_at: null,
    verified_at: null,
    created_at: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date(now - 2 * 60 * 1000).toISOString(),
  };
  const receivedAt = new Date(now - 60 * 1000).toISOString();
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      if ((init.method || 'GET') === 'PATCH') return Response.json([attempt]);
      return Response.json([attempt]);
    }
    if (target.includes('api.mail.tm/messages/msg-baru')) {
      return Response.json({ id: 'msg-baru', subject: 'Verifikasi email Anda', from: { address: 'noreply@tm.openai.com' }, text: 'Kode verifikasi: 908172', createdAt: receivedAt });
    }
    if (target.includes('api.mail.tm/messages')) {
      return Response.json({ 'hydra:member': [{
        id: 'msg-baru',
        subject: 'Verifikasi email Anda',
        from: { address: 'noreply@tm.openai.com' },
        to: [{ address: 'kotak@mail.tm' }],
        intro: 'Kode verifikasi dikirim',
        createdAt: receivedAt,
      }] });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'verify', id: attempt.id } }), ENV);
    const body = await res.json();
    assert.equal(body.code, '908172');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Upsert per (user_id, email): memulai ronde baru harus mengosongkan kode lama,
// kalau tidak kode ronde sebelumnya tetap tampil dan ditempel sia-sia.
test('prepare mengosongkan kode verifikasi dari ronde sebelumnya', async () => {
  const oldFetch = globalThis.fetch;
  let sent = null;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      sent = JSON.parse(String(init.body))[0];
      return Response.json([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...sent }]);
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'prepare', email: 'kotak@mail.tm' } }), ENV);
    assert.equal(res.status, 201);
    assert.equal(sent.verification_code, '');
    assert.equal(sent.verification_message_id, '');
    assert.equal(sent.verification_code_at, null);
    assert.equal(sent.verified_at, null);
    assert.equal(sent.step, 'dibuka');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Regresi dari kesalahan saya sendiri: anchor updated_at membuat percobaan
// ulang gagal, karena verify sendiri memperbarui updated_at.
test('verify ulang tetap menemukan email yang sama setelah percobaan pertama', async () => {
  const oldFetch = globalThis.fetch;
  const now = Date.now();
  const base = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    user_id: 'admin-1',
    email: 'kotak@mail.tm',
    step: 'menunggu_verifikasi',
    signup_url: '',
    note: '',
    verification_message_id: '',
    verification_code: '',
    verification_code_at: null,
    verified_at: null,
    // Ronde dimulai 60 menit lalu.
    created_at: new Date(now - 60 * 60 * 1000).toISOString(),
    // Sebuah langkah (verify pertama yang gagal / tombol "Tunggu verifikasi")
    // memperbarui updated_at 20 menit lalu.
    updated_at: new Date(now - 20 * 60 * 1000).toISOString(),
  };
  // Email verifikasi datang 40 menit lalu: masih di dalam ronde, tetapi jauh
  // sebelum updated_at. Dengan anchor updated_at, email ini terbuang.
  const receivedAt = new Date(now - 40 * 60 * 1000).toISOString();
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm', token: '{"token":"t","password":"p"}' }]);
    if (target.includes('/openai_signup_attempts')) {
      if ((init.method || 'GET') === 'PATCH') return Response.json([base]);
      return Response.json([base]);
    }
    if (target.includes('api.mail.tm/messages/msg-1')) {
      return Response.json({ id: 'msg-1', subject: 'Verifikasi email Anda', from: { address: 'noreply@tm.openai.com' }, text: 'Kode verifikasi: 121314', createdAt: receivedAt });
    }
    if (target.includes('api.mail.tm/messages')) {
      return Response.json({ 'hydra:member': [{
        id: 'msg-1',
        subject: 'Verifikasi email Anda',
        from: { address: 'noreply@tm.openai.com' },
        to: [{ address: 'kotak@mail.tm' }],
        intro: 'Verifikasi',
        createdAt: receivedAt,
      }] });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/openai-signup', { method: 'POST', body: { action: 'verify', id: base.id } }), ENV);
    const body = await res.json();
    assert.equal(body.code, '121314');
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Satu jalur saja: panel tidak boleh lagi menyusun URL daftar sendiri-sendiri,
// dan tidak boleh ada sisa jalur konsumen (auth.login_with) di kode.
test('panel dan rute hanya memakai jalur platform', async () => {
  const { readFileSync } = await import('node:fs');
  const lib = readFileSync(new URL('../src/lib/openaiSignup.js', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../src/lib/openaiSignupRoute.js', import.meta.url), 'utf8');
  assert.match(route, /buildPlatformSignupUrl\(/);
  assert.ok(!/buildSignupUrl|SIGNUP_FORM_URL|login_with/.test(route));
  assert.ok(!/SIGNUP_FORM_URL|login_with|auth\.openai\.com\/log-in/.test(lib));
  // UI memakai nama tombol yang benar-benar ada di halaman login platform.
  assert.ok(panel.includes('Continue'));
  assert.ok(!/tekan <b>Lanjutkan<\/b>/.test(panel));
  assert.ok(panel.includes('Buka login platform'));
});

// Regresi: pemeriksaan sesi otomatis TIDAK BOLEH kembali. Endpoint itu tanpa
// header CORS, jadi hasilnya selalu "Failed to fetch" di browser pengguna.
test('panel memakai panduan sesi manual, bukan fetch lintas-origin', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/openaiSignup.js', import.meta.url), 'utf8');
  assert.match(panel, /sessionCheckGuide/);
  assert.match(panel, /Failed to fetch/);
  // Komentar boleh menyebut nama endpoint (untuk menjelaskan sejarah); yang
  // dilarang adalah pemanggilan sungguhan.
  const code = panel.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
  assert.ok(!/backend-api\/me/.test(code), 'panel tidak boleh memanggil backend-api/me');
  assert.ok(!/checkSessionState/.test(lib), 'pemeriksa sesi otomatis sudah dihapus');
  const libCode = lib.split('\n').filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//')).join('\n');
  assert.ok(!/backend-api\/me/.test(libCode), 'jangan menyimpan pemanggilan yang tidak mungkin berhasil');
  const guide = globalThis.__signup.sessionCheckGuide();
  assert.equal(guide.automatic, false);
  assert.ok(guide.steps.length >= 2);
  assert.match(guide.why, /CORS|Failed to fetch/i);
  assert.match(guide.note, /Akun OpenAI/);
});

// Setelah kode berhasil, akses disimpan lewat OAuth resmi — BUKAN dengan
// menyalin cookie sesi browser (yang tidak bisa dibaca server dan bukan
// kredensial yang layak disimpan).
test('panel menyimpan akses lewat OAuth resmi, bukan cookie sesi', async () => {
  const { readFileSync } = await import('node:fs');
  const panel = readFileSync(new URL('../src/studio/OpenAiSignupPanel.jsx', import.meta.url), 'utf8');
  const oauth = readFileSync(new URL('../src/studio/OpenAiOAuthPanel.jsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/openaiSignup.js', import.meta.url), 'utf8');
  // Satu tombol penyimpan akses saja, di panel OAuth. Dulu tombol ini hanya
  // muncul saat `step === 'terverifikasi'` (buntu tanpa penjelasan), lalu
  // sempat terduplikasi di dua panel. Panel pendaftaran hanya menunjuk ke sana.
  assert.ok(!/active\.step === 'terverifikasi'/.test(panel), 'tombol simpan tidak boleh disembunyikan oleh status langkah');
  assert.ok(!/beginOpenAiSignIn/.test(panel), 'panel pendaftaran tidak boleh punya tombol simpan sendiri');
  assert.match(oauth, /Simpan aksesnya ke pool/);
  assert.match(panel, /Connect OpenAI/);
  // Tidak boleh ada pembacaan cookie sesi openai.com dari mana pun.
  for (const [name, source] of [['panel', panel], ['lib', lib]]) {
    assert.ok(!/document\.cookie/.test(source), `${name}: jangan baca document.cookie`);
    assert.ok(!/__Secure-next-auth|next-auth\.session-token/.test(source), `${name}: jangan menyentuh cookie sesi`);
  }
  // Penjelasan yang diberikan ke pengguna harus jujur soal masa berlaku.
  assert.match(oauth, /1 jam|refresh/);
});

// Diagnosa kegagalan OAuth: halaman error `invalid_state` dari auth.openai.com
// terjadi SEBELUM callback kita, jadi tidak ada baris DB yang bisa diperiksa.
// Panel harus menjelaskan sebab yang paling mungkin, bukan menampilkan kode
// mentah tanpa arti.
test('pesan invalid_state menjelaskan sebab dan langkah konkret', () => {
  const { explainOAuthError } = globalThis.__signup;
  const notFound = explainOAuthError({ error: 'invalid_state', detail: '', hasPendingAttempt: false });
  assert.equal(notFound.code, 'invalid_state');
  assert.match(notFound.cause, /percobaan OAuth yang sah/i);
  assert.match(notFound.fix, /Connect/i);

  const mismatch = explainOAuthError({ error: 'invalid_state', detail: '', hasPendingAttempt: true });
  assert.match(mismatch.cause, /tidak cocok|beda/i);

  // Error lain tidak boleh "dipaksa" jadi invalid_state.
  const other = explainOAuthError({ error: 'invalid_grant', detail: 'refresh ditolak' });
  assert.equal(other.code, 'invalid_grant');
  assert.match(other.fix, /ulangi|ulang/i);
  assert.equal(explainOAuthError({}).code, 'unknown');
});

// redirect_uri: port hanya boleh berubah; skema/host/path tetap. Di domain
// publik tidak ada yang mendengarkan, jadi callback diselesaikan tempel-URL.
test('resolveOAuthRedirectUri mengikuti aturan loopback OpenAI', () => {
  const { resolveOAuthRedirectUri } = globalThis.__signup;
  const local = resolveOAuthRedirectUri({ hostname: '127.0.0.1', port: '5173' });
  assert.equal(local.redirect_uri, 'http://127.0.0.1:5173/auth/callback');
  assert.equal(local.auto_callback, true);

  const noPort = resolveOAuthRedirectUri({ hostname: '127.0.0.1', port: '' });
  assert.equal(noPort.redirect_uri, 'http://127.0.0.1:80/auth/callback');

  const remote = resolveOAuthRedirectUri({ hostname: 'blea.ai', port: '443' });
  assert.equal(remote.auto_callback, false);
  assert.match(remote.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
  const port = Number(remote.redirect_uri.split(':')[2].split('/')[0]);
  assert.ok(port >= 1024 && port <= 65535, `port di luar rentang: ${port}`);
  // `localhost` tidak boleh dipakai: OpenAI menolaknya.
  assert.ok(!/localhost/.test(remote.redirect_uri));
  assert.ok(!/\/callback\?/.test(remote.redirect_uri));
});

// Deep link aplikasi: setelah kode verifikasi, OpenAI menawarkan "buka
// aplikasi" dan halaman verifikasi berputar terus. Panduannya harus ada dan
// harus jujur bahwa callback aplikasi tidak bisa diselesaikan
// browser — bukan disuruh mencoba lagi.
test('panduan handoff aplikasi menjelaskan halaman yang berputar', () => {
  const { APP_HANDOFF_GUIDE, describeOAuthCallbackPath, summarizeAccessStorage } = globalThis.__signup;
  assert.match(APP_HANDOFF_GUIDE.summary, /buka aplikasi/i);
  assert.match(APP_HANDOFF_GUIDE.why, /aplikasi/);
  assert.ok(APP_HANDOFF_GUIDE.steps.length >= 3);
  assert.match(APP_HANDOFF_GUIDE.steps.join(' '), /API key/i);

  // Callback otomatis hanya mungkin di 127.0.0.1; di domain publik langkahnya
  // harus menyebut tempel URL, bukan "tunggu kembali sendiri".
  const local = describeOAuthCallbackPath({ hostname: '127.0.0.1', port: '3000' });
  assert.equal(local.automatic, true);
  assert.match(local.steps.join(' '), /kembali sendiri/);

  const remote = describeOAuthCallbackPath({ hostname: 'blea.ai', port: '' });
  assert.equal(remote.automatic, false);
  assert.match(remote.steps.join(' '), /tempel|Salin SELURUH/i);
  assert.match(remote.redirect_uri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

  // Status penyimpanan tidak boleh mengklaim tersimpan tanpa akun tertaut.
  assert.equal(summarizeAccessStorage({}).stored, false);
  assert.equal(summarizeAccessStorage({ linkedCount: 2 }).stored, true);
  assert.match(summarizeAccessStorage({ pendingCount: 1 }).text, /menunggu izin/i);
});

// OAuth harus dibuka di TAB BARU: kalau halaman BLEA digantikan, panel hilang
// dan callback mendarat di 127.0.0.1 tanpa sesi login BLEA.
test('beginOpenAiSignIn membuka tab baru, bukan menggantikan halaman panel', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../src/studio/openaiOAuthClient.js', import.meta.url), 'utf8');
  assert.ok(!/window\.location\.assign/.test(client), 'jangan menavigasi halaman panel ke OpenAI');
  assert.match(client, /window\.open\(authorizeUrl, '_blank'\)/);
  assert.match(client, /tab = null/);
});

// Pengguna berpindah perangkat (HP → PC) di tengah alur: URL callback boleh
// diselesaikan dari perangkat yang localStorage-nya TIDAK memuat percobaan itu.
// Dulu klien menolak di depan ("state tidak cocok") sebelum server sempat
// memeriksa `state` yang tersimpan — tempelan URL yang sah jadi gagal.
test('URL callback bisa diselesaikan dari perangkat lain (state dicari di server)', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../src/studio/openaiOAuthClient.js', import.meta.url), 'utf8');
  assert.ok(!/pending\.state !== returnedState/.test(client), 'jangan menolak state sebelum server memeriksanya');
  assert.match(client, /pendingAttemptId/);
  assert.match(client, /server mencari barisnya lewat `state`/);
});

// `invalid_state` punya dua sumber; saran perbaikannya tidak boleh tertukar.
test('explainOAuthError membedakan invalid_state alur daftar dan OAuth BLEA', () => {
  const { explainOAuthError } = globalThis.__signup;
  const signupPage = explainOAuthError({ error: 'invalid_state' });
  assert.match(signupPage.stage, /daftar|verifikasi/i);
  const oauthPage = explainOAuthError({ error: 'invalid_state', detail: 'https://auth.openai.com/api/accounts/authorize?client_id=x' });
  assert.match(oauthPage.stage, /authorize|OAuth BLEA/i);
});

// Jalur platform.openai.com: titik masuk yang sah (semua halaman platform 302
// ke /login saat belum masuk), `next` dibatasi daftar path tetap, dan email
// tidak dikirim sebagai parameter karena formulirnya tidak memakainya.
test('langkah platform menunjuk API keys dan billing, bukan OAuth', () => {
  assert.equal(PLATFORM_LOGIN_URL, 'https://platform.openai.com/login');
  assert.equal(PLATFORM_HOME_URL, 'https://platform.openai.com/home');
  assert.equal(PLATFORM_API_KEYS_URL, 'https://platform.openai.com/api-keys');
  assert.ok(PLATFORM_NEXT_PATHS.includes('/api-keys'));
  assert.ok(!PLATFORM_NEXT_PATHS.includes('/settings/organization/usage'));
  // Langkahnya harus menyebut API key, bukan alur OAuth.
  assert.match(PLATFORM_STEPS.join(' '), /API key/i);
  assert.ok(!/Connect OpenAI|OAuth/.test(PLATFORM_STEPS.join(' ')));
});

test('prepare hanya menyimpan jalur platform (tanpa cabang route)', async () => {
  const { readFileSync } = await import('node:fs');
  const route = readFileSync(new URL('../src/lib/openaiSignupRoute.js', import.meta.url), 'utf8');
  assert.ok(!/normalizeRoute/.test(route), 'pemilih route sudah dihapus');
  assert.match(route, /buildPlatformSignupUrl/);
  assert.match(route, /route: 'platform'/);
  const client = readFileSync(new URL('../src/studio/OpenAiSignupClient.js', import.meta.url).pathname.replace('/OpenAiSignupClient.js','/openaiSignupClient.js'), 'utf8');
  assert.match(client, /openAiSignupApi/);
  assert.ok(!/chatGptSignupApi/.test(client));
});
