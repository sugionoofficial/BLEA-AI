// Rute /api/chatgpt-signup — "Daftar ChatGPT pakai email TempMail" untuk admin.
//
// Lihat src/lib/chatgptSignup.js untuk alasan mengapa server TIDAK mem-POST ke
// chatgpt.com. Modul ini hanya:
//   1. menyiapkan URL halaman daftar resmi dengan `login_hint` = email TempMail;
//   2. mencatat langkah manual admin (dibuka → email dikirim → menunggu → terverifikasi);
//   3. mencocokkan pesan verifikasi di inbox TempMail.
//
// Inbox dibaca lewat `listInbox` yang disuntikkan Worker (jalur TempMail yang
// sudah ada: mail.tm atau Gmail alias + pemeriksaan pemilik alias). Modul ini
// tidak menyimpan isi email, kode verifikasi, atau cookie sesi apa pun.

import { signupConfig, buildSignupUrl, normalizeSignupRequest, scoreVerificationMessage, validateSignupInput, SIGNUP_STEPS } from './chatgptSignup.js';

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
      verification_message_id: '',
      verified_at: null,
      created_at: now,
      updated_at: now,
    }],
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Permintaan pendaftaran gagal disimpan.', 500);
  return { attempt: normalizeSignupRequest(row), url: signupUrl, plus_address };
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
async function verifyAttempt(env, userId, input, listInbox) {
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
  const best = scored.find((message) => message.match.matched) || null;
  if (!best) {
    return {
      ok: true,
      matched: false,
      candidates: scored.slice(0, 5),
      attempt: normalizeSignupRequest(row),
      hint: 'Belum ada pesan verifikasi yang cocok. Tunggu email dari OpenAI, klik "Refresh inbox" di TempMail, lalu coba lagi.',
    };
  }
  const rows = await dbJson(env, `${TABLE}?id=eq.${encodeURIComponent(row.id)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: {
      step: 'terverifikasi',
      verification_message_id: String(best.id || ''),
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  return {
    ok: true,
    matched: true,
    best,
    candidates: scored.slice(0, 5),
    attempt: normalizeSignupRequest((Array.isArray(rows) ? rows[0] : null) || row),
  };
}

export async function handleChatgptSignup(request, env, user, { listInbox } = {}) {
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
    if (action === 'verify') return { status: 200, body: await verifyAttempt(env, user.id, body, listInbox) };
    return { status: 400, body: { error: 'Aksi pendaftaran tidak dikenal.' } };
  } catch (error) {
    return { status: Number(error?.status) || 500, body: { error: String(error?.message || 'Pendaftaran ChatGPT gagal diproses.') } };
  }
}

export default handleChatgptSignup;
export { listAttempts, saveAttempt, markAttempt, verifyAttempt };
