import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  SIGNUP_CSRF_URL,
  SIGNUP_PAGE_URL,
  SIGNUP_REQUEST_URL,
  analyzeReturnUrl,
  buildSigninBootstrap,
  buildSignupUrl,
  isPlusAddress,
  scoreVerificationMessage,
  signupConfig,
  validateSignupInput,
} from '../src/lib/chatgptSignup.js';

const signupModule = await import('../src/lib/chatgptSignup.js');
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

test('URL yang dibuka adalah halaman /auth/login, bukan endpoint POST NextAuth', () => {
  const url = new URL(buildSignupUrl('sugionoofficial88+1@gmail.com', { authSessionLoggingId: '3aa1b9d5-3741-4c50-abb1-498284787a85' }));
  // Regresi bug nyata: buildSignupUrl pernah menghasilkan
  // https://chatgpt.com/api/auth/signin/openai?... Endpoint itu POST NextAuth
  // sehingga GET dari browser selalu berakhir di
  // "Kami tidak dapat memproses upaya masuk Anda. Coba lagi".
  assert.equal(`${url.origin}${url.pathname}`, SIGNUP_PAGE_URL);
  assert.notEqual(`${url.origin}${url.pathname}`, SIGNUP_REQUEST_URL);
  assert.ok(!url.pathname.includes('/api/auth/signin'), 'endpoint POST tidak boleh dibuka dengan GET');
  assert.equal(url.searchParams.get('screen_hint'), 'signup');
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('login_hint'), 'sugionoofficial88+1@gmail.com');
  assert.equal(url.searchParams.get('auth_session_logging_id'), '3aa1b9d5-3741-4c50-abb1-498284787a85');
  assert.ok(!/password|csrfToken|cookie/i.test(url.toString()), 'URL tidak boleh membawa kredensial');

  const config = signupConfig({});
  assert.equal(config.signup_url, SIGNUP_PAGE_URL);
  assert.equal(config.csrf_url, SIGNUP_CSRF_URL);
  assert.equal(config.supported.server_side_post, false);
  assert.equal(config.supported.headless_signup, false);
  assert.equal(config.supported.captcha_bypass, false);
  assert.equal(config.supported.capture_session_cookie, false);
  assert.ok(config.why_not_post.some((line) => line.includes('csrfToken')));
});

test('bootstrap sign-in menyebut langkah sah dan tidak pernah membawa csrfToken', () => {
  const bootstrap = buildSigninBootstrap('a+1@b.co');
  assert.equal(bootstrap.csrf_url, SIGNUP_CSRF_URL);
  assert.equal(bootstrap.form.url, SIGNUP_REQUEST_URL);
  assert.equal(bootstrap.form.method, 'POST');
  assert.ok(bootstrap.form.fields.includes('csrfToken'));
  assert.equal(bootstrap.fields_to_fill['Alamat email'], 'a+1@b.co');
  // Token CSRF wajib diambil browser saat itu juga; tidak boleh ada di payload.
  assert.equal(bootstrap.csrf, '');
});

test('analyzeReturnUrl membedakan halaman error, host asing, dan email yang benar-benar terkirim', () => {
  const email = 'kotak+1@mail.tm';

  const error = analyzeReturnUrl('https://chatgpt.com/auth/error?error=OAuthSignin', email);
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

  // Halaman awal (belum menekan Lanjutkan) tetap ditolak.
  const landing = analyzeReturnUrl('https://chatgpt.com/auth/login', email);
  assert.equal(landing.ok, false);
  assert.equal(landing.status, 'halaman_awal');

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
    subject: 'ChatGPT verification code',
    from: 'noreply@openai.com',
    to: 'kotak+1@mail.tm',
    createdAt: '2026-11-20T10:00:00Z',
  }, row);
  assert.ok(old.reasons.includes('diterima sebelum pendaftaran dimulai'));
});

test('/api/chatgpt-signup hanya untuk admin dan melaporkan bahwa POST server tidak didukung', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    }
    if (target.includes('/rest/v1/chatgpt_signup_attempts')) return Response.json([]);
    if (target.includes('/rest/v1/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm', provider: 'mailtm' }]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup'), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.config.supported.server_side_post, false);
    assert.equal(body.temp_email.email, 'kotak@mail.tm');
    assert.deepEqual(body.attempts, []);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('/api/chatgpt-signup menolak non-admin dan aksi asing', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) {
      return Response.json({ id: 'user-1', app_metadata: { role: 'user' } });
    }
    if (target.includes('/rest/v1/chatgpt_signup_attempts')) return Response.json([]);
    if (target.includes('/rest/v1/tempmail_user_aliases')) return Response.json([]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup'), ENV);
    assert.equal(res.status, 403);

    const bad = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'hack' } }), ENV);
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
  const source = readFileSync(new URL('../src/studio/ChatGptSignupPanel.jsx', import.meta.url), 'utf8');
  const prepareBody = source.slice(source.indexOf('async function prepare()'), source.indexOf('async function mark('));
  const openIndex = prepareBody.indexOf("window.open('', '_blank')");
  const awaitIndex = prepareBody.indexOf('chatGptSignupApi.prepare(');
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
  const files = readdirSync(dir).filter((name) => name.includes('chatgpt_signup_attempts') || name.includes('chatgpt_signup_on_conflict'));
  assert.ok(files.length >= 2, 'migrasi awal + migrasi perbaikan harus ada');
  const sql = files.map((name) => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  assert.ok(
    /unique\s*\(\s*user_id\s*,\s*email\s*\)/i.test(sql),
    'harus ada unique (user_id, email) agar ON CONFLICT (user_id, email) sah',
  );
  assert.ok(/on_conflict=user_id,email/.test(readFileSync(new URL('../src/lib/chatgptSignupRoute.js', import.meta.url), 'utf8')));
});

// Aksi `confirm` harus menolak URL yang tidak membuktikan apa pun, dan hanya
// menandai `email_dikirim` bila URL memang memuat email TempMail.
test('/api/chatgpt-signup confirm menolak halaman error dan menerima URL ber-email', async () => {
  const oldFetch = globalThis.fetch;
  const attempt = {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: 'admin-1',
    email: 'kotak+1@mail.tm',
    signup_url: 'https://chatgpt.com/auth/login?login_hint=kotak%2B1%40mail.tm',
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
    if (target.includes('/chatgpt_signup_attempts')) {
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
    const bad = await worker.fetch(request('/chatgpt-signup', {
      method: 'POST',
      body: { action: 'confirm', id: attempt.id, url: 'https://chatgpt.com/auth/error?error=OAuthSignin' },
    }), ENV);
    const badBody = await bad.json();
    assert.equal(bad.status, 200);
    assert.equal(badBody.ok, false);
    assert.equal(badBody.analysis.status, 'masih_error');
    assert.equal(patched, null, 'URL error tidak boleh mengubah langkah');

    const good = await worker.fetch(request('/chatgpt-signup', {
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
test('panel tidak menjanjikan autofill email dan menyediakan salin email dengan fallback', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/studio/ChatGptSignupPanel.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('tidak terisi otomatis'), 'harus menyatakan kolom email tidak terisi otomatis');
  assert.ok(source.includes('mengabaikan') && source.includes('login_hint'));
  assert.ok(source.includes('Salin email'), 'harus ada tombol salin email');
  assert.ok(!/login_hint\. Ketik email itu/.test(source), 'janji autofill lama tidak boleh kembali');
  // Klaim baru: autofill hanya lewat bookmarklet yang diklik pengguna.
  assert.ok(source.includes('Opsional: isi otomatis'));
  assert.ok(source.includes('same-origin'));
  assert.ok(source.includes('bookmarklet'));
  // Fallback wajib: navigator.clipboard sering ditolak di iframe/preview.
  assert.ok(source.includes('execCommand'), 'harus ada fallback execCommand');
  assert.ok(source.includes('Clipboard tidak tersedia di browser ini'));
});

// Autofill lintas-origin tidak mungkin dari halaman BLEA (same-origin policy)
// dan OpenAI mengabaikan login_hint. Satu-satunya jalan sah: bookmarklet yang
// dijalankan DI halaman chatgpt.com atas klik pengguna.
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
  assert.ok(bootstrap.steps.some((line) => /bookmarklet|tempel/i.test(line)));
  assert.ok(bootstrap.steps.some((line) => /BLEA tidak pernah menekan/i.test(line)));
});

// Userscript harus benar-benar mengisi kolom di DOM halaman ChatGPT palsu —
// bukan cuma lolos pemeriksaan string. Kolom telepon (type=tel) tidak boleh
// dipilih, dan skrip tidak boleh menekan tombol apa pun.
test('userscript mengisi kolom email di DOM tiruan chatgpt.com tanpa menekan tombol', async () => {
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
  const dom = new JSDOM(html, { url: 'https://chatgpt.com/auth/login', runScripts: 'outside-only' });
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

test('/api/chatgpt-signup/userscript hanya untuk admin dan menyajikan berkas .user.js', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('/auth/v1/user')) return Response.json({ id: 'admin-1', app_metadata: { role: 'admin' } });
    if (target.includes('/profiles')) return Response.json([]);
    if (target.includes('/tempmail_user_aliases')) return Response.json([{ email: 'kotak@mail.tm' }]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup/userscript'), ENV);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/javascript/);
    assert.match(res.headers.get('content-disposition') || '', /\.user\.js/);
    const text = await res.text();
    assert.ok(text.startsWith('// ==UserScript=='));
    assert.ok(text.includes('"kotak@mail.tm"'), 'email alias aktif harus dipakai');
    assert.ok(text.includes('@match        https://chatgpt.com/*'));

    const bad = await worker.fetch(request('/chatgpt-signup/userscript?email=bukan-email'), ENV);
    assert.equal(bad.status, 400);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

// Panel tidak boleh terasa "wajib pasang sesuatu". Alur manual adalah jalur
// utama; bingkai otomatis hanya opsi di dalam <details> yang tertutup.
test('alur manual tetap utama dan bingkai otomatis dilipat sebagai opsional', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/studio/ChatGptSignupPanel.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('isi email manual'));
  assert.ok(source.includes('Cukup tempel manual'));
  assert.ok(/<details className="cga-signup-optional">/.test(source), 'bingkai otomatis harus di dalam <details>');
  assert.ok(source.includes('Opsional: isi otomatis (tidak wajib)'));
  // Label lama yang menonjolkan unduhan sebagai "disarankan" tidak boleh kembali.
  assert.ok(!/Unduh userscript \(disarankan\)/.test(source));
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

test('/api/chatgpt-signup verify membaca isi email dan mengembalikan kode', async () => {
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
    if (target.includes('/chatgpt_signup_attempts')) {
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
    const res = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'verify', id: attempt.id } }), ENV);
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
  const panel = readFileSync(new URL('../src/studio/ChatGptSignupPanel.jsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/chatgptSignup.js', import.meta.url), 'utf8');
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
test('/api/chatgpt-signup action=code membaca kode tersimpan tanpa menyentuh inbox', async () => {
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
    if (target.includes('/chatgpt_signup_attempts')) {
      if (target.includes('id=eq.55555555-5555-4555-8555-555555555555')) return Response.json([]);
      return Response.json([attempt]);
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'code', id: attempt.id } }), ENV);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.code, '483920');
    assert.equal(body.verification_message_id, 'msg-9');
    // Tidak boleh ada panggilan ke provider email maupun PATCH.
    assert.ok(!visited.some((line) => line.includes('mail.tm') || line.includes('gmail') || line.startsWith('PATCH')), visited.join('\n'));

    // Permintaan milik user lain tidak boleh membocorkan kode.
    const other = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'code', id: '55555555-5555-4555-8555-555555555555' } }), ENV);
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
    if (target.includes('/chatgpt_signup_attempts')) return Response.json([attempt]);
    return new Response('not found', { status: 404 });
  };
  try {
    const res = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'code', id: attempt.id } }), ENV);
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
    if (target.includes('/chatgpt_signup_attempts')) {
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
    const res = await worker.fetch(request('/chatgpt-signup', { method: 'POST', body: { action: 'verify', id: attempt.id } }), ENV);
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
