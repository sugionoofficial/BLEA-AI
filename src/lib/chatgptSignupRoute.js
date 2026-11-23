// Rute /api/chatgpt-signup — "Daftar ChatGPT pakai email TempMail" untuk admin.
//
// Lihat src/lib/chatgptSignup.js untuk alasan mengapa server TIDAK mem-POST ke
// chatgpt.com. Modul ini hanya:
//   1. menyiapkan URL HALAMAN formulir resmi OpenAI (auth.openai.com/log-in);
//   2. mencatat langkah manual admin (dibuka → email dikirim → menunggu → terverifikasi);
//   3. mencocokkan pesan verifikasi di inbox TempMail.
//
// Inbox dibaca lewat `listInbox` yang disuntikkan Worker (jalur TempMail yang
// sudah ada: mail.tm atau Gmail alias + pemeriksaan pemilik alias). Kode
// verifikasi disimpan (kolom `verification_code`, sekali pakai, bukan
// kredensial login); isi email dan cookie sesi tidak pernah disimpan.

import {
  analyzeReturnUrl,
  describeStoredCode,
  extractVerificationCode,
  buildSigninBootstrap,
  buildSignupUrl,
  normalizeSignupRequest,
  scoreVerificationMessage,
  signupConfig,
  validateSignupInput,
  SIGNUP_STEPS,
} from './chatgptSignup.js';

const TABLE = '/chatgpt_signup_attempts';

function supabaseBase(env) {
  return (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');
}

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

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

async function listAttempts(env, userId) {
  const rows = await dbJson(env, `${TABLE}?select=*&user_id=eq.${encodeURIComponent(userId)}&order=updated_at.desc&limit=20`);
  return (Array.isArray(rows) ? rows : []).map(normalizeSignupRequest).filter(Boolean);
}

async function readAttempt(env, userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw fail('ID permintaan pendaftaran tidak valid.', 400);
  const rows = await dbJson(env, `${TABLE}?select=*&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Permintaan pendaftaran tidak ditemukan.', 404);
  return row;
}

/** Email TempMail aktif milik admin (dipakai sebagai isi awal kolom email). */
async function activeTempEmail(env, userId) {
  const rows = await dbJson(env, `/tempmail_user_aliases?select=email,provider&user_id=eq.${encodeURIComponent(userId)}&limit=1`).catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  return row ? { email: String(row.email || ''), provider: String(row.provider || '') } : null;
}

async function saveAttempt(env, userId, input) {
  const { email, auth_session_logging_id, plus_address } = validateSignupInput(input);
  const signupUrl = buildSignupUrl(email, { authSessionLoggingId: auth_session_logging_id });
  const now = new Date().toISOString();
  // Upsert per (user_id, lower(email)): mengulang alamat yang sama memperbarui
  // satu baris, bukan membuat riwayat pendaftaran ganda.
  const rows = await dbJson(env, `${TABLE}?on_conflict=user_id,email`, {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: [{
      user_id: userId,
      email,
      signup_url: signupUrl,
      step: 'dibuka',
      note: plus_address ? 'Alamat +tag Gmail: sebagian formulir OpenAI menolak tanda +.' : '',
      // Upsert per (user_id, email): tanpa pengosongan eksplisit, kode dan id
      // pesan dari ronde sebelumnya tetap menempel dan tampil seolah milik
      // permintaan yang baru — lalu ditempel ke ChatGPT dan gagal.
      verification_message_id: '',
      verification_code: '',
      verification_code_at: null,
      verified_at: null,
      created_at: now,
      updated_at: now,
    }],
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Permintaan pendaftaran gagal disimpan.', 500);
  // `url` adalah HALAMAN formulir OpenAI (GET), bukan endpoint POST NextAuth —
  // lihat catatan di chatgptSignup.js. `signin` berisi langkah manual yang sama
  // (nama field `login_hint` di sana hanya mengikuti formulir NextAuth, bukan
  // janji bahwa email akan terisi).
  return {
    attempt: normalizeSignupRequest(row),
    url: signupUrl,
    plus_address,
    signin: buildSigninBootstrap(email),
  };
}

async function markAttempt(env, userId, input) {
  const row = await readAttempt(env, userId, input.id);
  const step = String(input.step || '').trim();
  if (!SIGNUP_STEPS.includes(step)) throw fail('Langkah pendaftaran tidak dikenal.', 400);
  const patch = {
    step,
    note: String(input.note || '').slice(0, 500),
    updated_at: new Date().toISOString(),
    ...(step === 'terverifikasi' ? { verified_at: new Date().toISOString() } : {}),
  };
  const rows = await dbJson(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: patch,
  });
  const updated = Array.isArray(rows) ? rows[0] : null;
  if (!updated) throw fail('Langkah pendaftaran gagal disimpan.', 500);
  return { attempt: normalizeSignupRequest(updated) };
}

/**
 * Cocokkan inbox TempMail dengan permintaan pendaftaran.
 * `listInbox(email)` disediakan Worker dan sudah memeriksa bahwa email itu
 * memang alias milik admin ini.
 */
async function verifyAttempt(env, userId, input, listInbox, readMessage) {
  const row = await readAttempt(env, userId, input.id);
  if (typeof listInbox !== 'function') throw fail('Inbox TempMail tidak tersedia di server ini.', 503);
  let messages;
  try {
    messages = await listInbox(row.email);
  } catch (error) {
    throw fail(`Inbox TempMail tidak bisa dibaca: ${error?.message || 'gagal'}`, error?.status || 502);
  }
  const scored = (Array.isArray(messages) ? messages : [])
    .map((message) => ({ ...message, match: scoreVerificationMessage(message, row) }))
    .sort((a, b) => b.match.score - a.match.score);
  let best = scored.find((message) => message.match.matched) || null;

  // Email verifikasi OpenAI berisi KODE, bukan tautan yang cukup diklik.
  // Snippet inbox sering tidak memuat kodenya, jadi pesan teratas dibaca
  // lengkap (dengan pemeriksaan pemilik alias yang sama) sebelum menyimpulkan.
  let verificationCode = '';
  let codeSource = '';
  // Hanya pesan yang masuk SETELAH permintaan ini dibuat yang isinya dibaca
  // penuh. Tanpanya, email lama (termasuk surat pribadi di inbox admin) ikut
  // dipindai dan kode acak di dalamnya bisa tersaji seolah kode verifikasi.
  // Patokan = awal ronde (created_at), BUKAN updated_at. `prepare` selalu
  // menulis ulang created_at saat ronde baru dimulai, jadi ini memang awal
  // ronde. Memakai updated_at salah: setiap verify memperbarui updated_at,
  // sehingga percobaan ulang justru mengecualikan email yang sedang dicari.
  const startedAt = Date.parse(row.created_at || '') || Number.NaN;
  const candidatesToRead = scored.filter((message) => {
    if (!message?.id) return false;
    const receivedAt = Date.parse(message.createdAt || '');
    if (!Number.isFinite(receivedAt) || !Number.isFinite(startedAt)) return true;
    // Toleransi 5 menit: jam server pengirim bisa sedikit berbeda.
    return receivedAt >= startedAt - 5 * 60 * 1000;
  });
  const depth = typeof readMessage === 'function' ? Math.min(candidatesToRead.length, 3) : 0;
  for (let index = 0; index < depth; index += 1) {
    const candidate = candidatesToRead[index];
    if (!candidate?.id) continue;
    // `scored` tetap dipakai untuk daftar kandidat; tulis balik hasil perkayaan
    // ke posisi aslinya supaya urutan skor tidak berubah.
    const position = scored.indexOf(candidate);
    let full = null;
    try {
      full = await readMessage(row.email, candidate.id);
    } catch { continue; }
    const extracted = extractVerificationCode({
      subject: full?.subject || candidate.subject || '',
      bodyText: full?.bodyText || '',
      bodyHtml: full?.bodyHtml || '',
    });
    // Kalau kode hanya ada di isi pesan, pesan itu yang dijadikan bukti.
    if (extracted.code) {
      verificationCode = extracted.code;
      codeSource = candidate.id;
    }
    const enriched = {
      ...candidate,
      subject: full?.subject || candidate.subject,
      from: full?.from || candidate.from,
      preview: String(full?.bodyText || candidate.preview || '').replace(/\s+/g, ' ').trim().slice(0, 180),
      match: scoreVerificationMessage({ ...candidate, subject: full?.subject || candidate.subject, from: full?.from || candidate.from }, row),
    };
    if (position >= 0) scored[position] = enriched;
    if (!best || enriched.match.matched) best = enriched.match.matched ? enriched : best;
    if (verificationCode) break;
  }

  if (!best) {
    // Kode bisa ditemukan walau pengirimnya tidak dikenali (mis. domain
    // pengirim berubah). Langkah TIDAK dinaikkan ke "terverifikasi" karena itu
    // belum bukti email OpenAI, tetapi kodenya tetap disimpan — kalau tidak,
    // kode itu hilang begitu halaman dimuat ulang dan pengguna harus memindai
    // inbox lagi padahal kodenya sudah ada.
    let attemptRow = row;
    if (verificationCode) {
      try {
        const saved = await dbJson(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: {
            verification_code: verificationCode,
            verification_message_id: codeSource,
            verification_code_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        });
        attemptRow = (Array.isArray(saved) ? saved[0] : null) || row;
      } catch {
        // Gagal menyimpan bukan alasan menggagalkan pencarian: kodenya tetap
        // dikembalikan pada respons ini.
      }
    }
    return {
      ok: true,
      matched: false,
      code: verificationCode,
      code_expired: false,
      // Pengirim tidak dikenali: kode disimpan & ditampilkan, tetapi UI wajib
      // memberi tanda supaya tidak ditempel sebagai kode OpenAI tanpa dicek.
      code_unverified: Boolean(verificationCode),
      code_from_message_id: codeSource,
      candidates: scored.slice(0, 5),
      attempt: normalizeSignupRequest(attemptRow),
      hint: verificationCode
        ? `Kode ditemukan di inbox walau pengirim tidak dikenali: ${verificationCode}. Cocokkan sendiri dengan email OpenAI, lalu tempel di tab ChatGPT.`
        : 'Belum ada pesan verifikasi yang cocok. Tunggu email dari OpenAI, klik "Refresh inbox" di TempMail, lalu coba lagi.',
    };
  }
  const rows = await dbJson(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      step: 'terverifikasi',
      verification_message_id: String(best.id || ''),
      // Kode disimpan HANYA untuk ditempel ke tab ChatGPT oleh admin; bukan
      // kredensial dan tidak dipakai untuk autentikasi otomatis.
      verification_code: verificationCode || '',
      // Waktu kode diambil, terpisah dari verified_at: kode bisa ada tanpa
      // pesan yang dikenali sebagai verifikasi.
      verification_code_at: verificationCode ? new Date().toISOString() : null,
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    matched: true,
    best,
    code: verificationCode,
    // Kode baru diekstrak, jadi belum kedaluwarsa saat ini.
    code_expired: false,
    code_from_message_id: codeSource,
    candidates: scored.slice(0, 5),
    attempt: normalizeSignupRequest((Array.isArray(rows) ? rows[0] : null) || row),
  };
}

/**
 * Cocokkan URL setelah pengguna menekan "Lanjutkan" di halaman ChatGPT dengan
 * permintaan pendaftaran. Dipakai untuk membuktikan langkah benar-benar
 * berjalan, bukan berhenti di halaman error.
 *
 * Tidak ada kredensial yang diambil: URL hanya dibaca (domain + jejak email),
 * bukan disimpan mentah.
 */
async function confirmAttempt(env, userId, input) {
  const row = await readAttempt(env, userId, input.id);
  const analysis = analyzeReturnUrl(input.url, row.email);
  if (!analysis.ok) {
    return {
      ok: false,
      analysis,
      attempt: normalizeSignupRequest(row),
      hint: analysis.detail,
    };
  }
  const rows = await dbJson(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      step: 'email_dikirim',
      note: `Terkonfirmasi di halaman ChatGPT (${analysis.status}).`,
      updated_at: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    analysis,
    attempt: normalizeSignupRequest((Array.isArray(rows) ? rows[0] : null) || row),
    hint: analysis.detail,
  };
}

/**
 * Ambil kode verifikasi yang SUDAH tersimpan tanpa memanggil inbox lagi.
 *
 * Kenapa perlu: kode hanya sampai ke browser saat tombol verify ditekan.
 * Setelah halaman dimuat ulang, DB menyimpan kodenya tetapi UI buta, sehingga
 * satu-satunya jalan adalah menekan "Cari email verifikasi" lagi — dan itu
 * memanggil Gmail ulang serta me-reset `verified_at` demi data yang sudah ada.
 */
async function readStoredCode(env, userId, input) {
  const row = await readAttempt(env, userId, input.id);
  const stored = describeStoredCode({
    code: row.verification_code,
    verified_at: row.verification_code_at || row.verified_at,
  });
  return {
    ok: true,
    code: stored.code,
    code_expired: stored.expired,
    // Kode bisa tersimpan walau langkah belum "terverifikasi" (pengirim tidak
    // dikenali). Statusnya tidak boleh tampil seolah kode OpenAI yang sah.
    code_unverified: Boolean(stored.code) && row.step !== 'terverifikasi',
    verification_message_id: row.verification_message_id || '',
    verified_at: row.verified_at || null,
    attempt: normalizeSignupRequest(row),
    hint: stored.code
      ? (stored.note || 'Kode tersimpan ini sekali pakai. Kalau sudah dipakai atau kedaluwarsa, minta kode baru di ChatGPT.')
      : 'Belum ada kode tersimpan untuk permintaan ini.',
  };
}

export async function handleChatgptSignup(request, env, user, { listInbox, readMessage } = {}) {
  if (!user) return { status: 401, body: { error: 'Login diperlukan.' } };
  if (user.app_metadata?.role !== 'admin') {
    return { status: 403, body: { error: 'Pendaftaran ChatGPT hanya tersedia untuk admin.' } };
  }
  const method = request.method;
  try {
    if (method === 'GET') {
      return {
        status: 200,
        body: {
          ok: true,
          config: signupConfig(env),
          temp_email: await activeTempEmail(env, user.id),
          attempts: await listAttempts(env, user.id),
        },
      };
    }
    if (method !== 'POST') return { status: 405, body: { error: 'Method tidak diizinkan.' } };
    const body = await request.json().catch(() => ({}));
    const action = String(body.action || 'prepare').toLowerCase();
    if (action === 'prepare') return { status: 201, body: { ok: true, ...(await saveAttempt(env, user.id, body)) } };
    if (action === 'mark') return { status: 200, body: { ok: true, ...(await markAttempt(env, user.id, body)) } };
    if (action === 'confirm') {
      const result = await confirmAttempt(env, user.id, body);
      // 200 juga untuk URL yang belum cocok: itu jawaban sah, bukan kegagalan
      // server, dan UI perlu menampilkan alasannya.
      return { status: 200, body: result };
    }
    if (action === 'verify') return { status: 200, body: await verifyAttempt(env, user.id, body, listInbox, readMessage) };
    if (action === 'code') return { status: 200, body: await readStoredCode(env, user.id, body) };
    return { status: 400, body: { error: 'Aksi pendaftaran tidak dikenal.' } };
  } catch (error) {
    return { status: Number(error?.status) || 500, body: { error: String(error?.message || 'Pendaftaran ChatGPT gagal diproses.') } };
  }
}

export default handleChatgptSignup;
export { listAttempts, saveAttempt, markAttempt, verifyAttempt, confirmAttempt };
