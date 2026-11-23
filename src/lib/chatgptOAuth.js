// "Continue with ChatGPT" — alur OAuth resmi OpenAI, TANPA API key.
//
// Kenapa modul ini ada: permintaan pengguna "koneksikan seperti freebeat tanpa
// apikey". Sejak DevDay 29 Sep 2026 OpenAI membuka **Sign in with ChatGPT**
// untuk proyek open-source / self-hosted: pengguna menekan satu tombol,
// menyetujui di browser ChatGPT, lalu aplikasi memakai kuota paket ChatGPT
// pengguna itu. Tidak ada API key, tidak ada client secret, tidak ada API
// berbayar per token. Rujukan: https://developers.openai.com/siwc/token-sharing-open-source
//
// Yang SENGAJA tidak dilakukan (dan tidak akan):
//   • menyalin token sesi chatgpt.com dan memanggil `backend-api` privat
//     (jalur abu-abu yang dilarang eksplisit di dokumentasi);
//   • login dengan email + kata sandi user; password tidak pernah menyentuh BLEA.
//
// Batasan arsitektur yang harus dipahami:
//   Redirect URI flow OSS WAJIB http://127.0.0.1:<port>/auth/callback — browser
//   pengguna, bukan browser server. Karena itu OAuth diselesaikan di browser
//   (PKCE, tanpa client secret), dan hasil tokennya dikirim SEKALI ke Worker
//   untuk disegel AES-GCM lalu dipakai sebagai kredensial pool. Tidak ada token
//   di localStorage; satu-satunya tempat token hidup adalah tabel
//   `chatgpt_oauth_links` (service_role) dan pool `chatgpt_accounts`.
//
// Preview limitation yang relevan (lihat preview-limitations): jalur ini hanya
// untuk teks/agen. Gambar, video, audio, dan file tool tidak tersedia, jadi
// tool media tetap memakai API key di pool yang sama.

import {
  createChatGptAccount,
  sealChatGptToken,
  unsealChatGptToken,
} from './chatgptPool.js';

export const OPENAI_AUTH_BASE = 'https://auth.openai.com';
export const OPENAI_RESOURCE = 'https://api.openai.com/v1';
export const OPENAI_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const OPENAI_LOOPBACK_PATH = '/auth/callback';
export const OPENAI_AGENT_NAME_HINT = 'BLEA AI';
// Client publik untuk registrasi pertama. Untuk sign-in ulang, `client_id` yang
// diterbitkan (oaiapp_…) per akun yang dipakai.
export const OPENAI_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TABLE = '/chatgpt_oauth_links';

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

/**
 * Sidik jari kode otorisasi (SHA-256, 12 heksadesimal pertama).
 * Dipakai untuk mencegah penukaran ganda dan untuk jejak debug tanpa
 * menyimpan kode aslinya.
 */
async function fingerprintCode(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(code || '')));
  return [...new Uint8Array(digest)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isOAuthLinkId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function cleanText(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/**
 * `state` + `nonce` disimpan di server SEBELUM browser membuka halaman OpenAI,
 * supaya callback tidak bisa dipalsukan (state tidak dikenal → ditolak).
 */
export async function createOAuthAttempt(env, user, input = {}) {
  const redirectUri = cleanText(input.redirect_uri, 200);
  let parsed;
  try { parsed = new URL(redirectUri); } catch { throw fail('redirect_uri tidak valid.', 400); }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== OPENAI_LOOPBACK_PATH) {
    throw fail(`redirect_uri harus http://127.0.0.1:<port>${OPENAI_LOOPBACK_PATH} sesuai ketentuan OpenAI.`, 400);
  }
  const codeVerifier = cleanText(input.code_verifier, 200);
  if (codeVerifier.length < 43 || codeVerifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
    throw fail('code_verifier PKCE tidak valid.', 400);
  }
  const state = cleanText(input.state, 128);
  const nonce = cleanText(input.nonce, 128);
  if (state.length < 16 || nonce.length < 16) throw fail('state/nonce tidak valid.', 400);

  const rows = await dbJson(env, TABLE, {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      user_id: user.id,
      state,
      nonce,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      // `client_id` hasil registrasi sebelumnya dipakai untuk sign-in ulang,
      // supaya akun yang sama tidak mendaftar client baru setiap kali login.
      requested_client_id: cleanText(input.client_id, 120) || null,
      status: 'pending',
    },
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row?.id) throw fail('Percobaan login gagal disimpan.', 500);
  return { id: row.id, state };
}

/**
 * Menukar authorization code menjadi token, lalu menyimpannya ke pool
 * `chatgpt_accounts` sebagai akun berkapabilitas chat/agent.
 *
 * Catatan jujur: token OpenAI ini HANYA berlaku untuk Responses API teks
 * (bukan /v1/images atau /v1/videos). Akun seperti ini karena itu tidak boleh
 * dipakai tool gambar/video — pemilihan akun di pool sudah memfilter lewat
 * `capabilities`, dan akun OAuth selalu {'chat','agent'}.
 */
export async function completeOAuthAttempt(env, user, input = {}) {
  let attemptId = cleanText(input.attempt_id, 60);
  const returnedState = cleanText(input.state, 200);

  // Callback bisa tiba tanpa `attempt_id` (mis. pengguna menempel URL callback
  // dari domain/tab lain yang localStorage-nya berbeda). Dalam hal itu baris
  // percobaan dicari lewat `state`, yang hanya berlaku 30 menit. `attempt_id`
  // dari klien tetap divalidasi milik pengguna yang login.
  if (!attemptId) {
    if (!returnedState) throw fail('Sesi login tidak ditemukan. Mulai lagi dari tombol Continue with ChatGPT.', 400);
    const found = await dbJson(env, `${TABLE}?select=id,status,created_at&user_id=eq.${encodeURIComponent(user.id)}&state=eq.${encodeURIComponent(returnedState)}&status=eq.pending&order=created_at.desc&limit=1`);
    const row = Array.isArray(found) ? found[0] : null;
    if (!row) {
      throw fail('Sesi login tidak ditemukan atau sudah dipakai (berlaku 30 menit). Mulai lagi dari tombol Continue with ChatGPT.', 404);
    }
    if (Date.now() - Date.parse(row.created_at || 0) > 30 * 60 * 1000) {
      throw fail('Sesi login sudah kedaluwarsa (30 menit). Mulai lagi dari tombol Continue with ChatGPT.', 400);
    }
    attemptId = row.id;
  }
  if (!isOAuthLinkId(attemptId)) throw fail('attempt_id tidak valid.', 400);
  if (cleanText(input.error, 200)) {
    await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(attemptId)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { status: 'denied', error_message: cleanText(input.error_description || input.error, 240), updated_at: new Date().toISOString() },
    }).catch(() => {});
    throw fail('Login dibatalkan atau ditolak di halaman ChatGPT.', 400);
  }

  const rows = await dbJson(env, `${TABLE}?select=*&id=eq.${encodeURIComponent(attemptId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const attempt = Array.isArray(rows) ? rows[0] : null;
  if (!attempt) throw fail('Percobaan login tidak ditemukan.', 404);
  if (attempt.status !== 'pending') throw fail('Percobaan login ini sudah dipakai. Mulai lagi dari tombol Continue with ChatGPT.', 409);
  const code = cleanText(input.code, 4000);
  const clientId = cleanText(input.client_id, 120) || attempt.requested_client_id || '';
  if (!code) throw fail('Kode otorisasi tidak ada di callback.', 400);
  // Client baru: callback WAJIB memberi client_id terbitan (oaiapp_…).
  if (!clientId || clientId === OPENAI_DYNAMIC_CLIENT_ID) {
    throw fail('Callback tidak memuat client_id terbitan OpenAI. Registrasi belum selesai; ulangi login.', 400);
  }

  // `state` WAJIB cocok dengan baris percobaan. Tanpa ini, callback dari
  // percobaan lama bisa dipasangkan dengan code_verifier percobaan baru —
  // PKCE tidak cocok, dan OpenAI menjawab `invalid_grant` tanpa penjelasan.
  if (returnedState && attempt.state && returnedState !== attempt.state) {
    throw fail('state callback tidak cocok dengan sesi login yang tersimpan. Mulai lagi dari tombol Continue with ChatGPT.', 409);
  }

  // Satu kode hanya boleh ditukar sekali. Kalau tidak, penukaran kedua
  // menghasilkan `invalid_grant` yang menyesatkan (kode sebenarnya sudah sah
  // ditukar sebelumnya).
  const codeFingerprint = await fingerprintCode(code);
  if (attempt.exchanged_code_fingerprint) {
    throw fail(attempt.exchanged_code_fingerprint === codeFingerprint
      ? 'Kode ini sudah pernah ditukar. Kalau akun belum muncul, muat ulang halaman; kalau tidak, ulangi login.'
      : 'Percobaan login ini sudah dipakai untuk kode lain. Ulangi dari tombol Continue with ChatGPT.', 409);
  }
  // Tandai SEBELUM memanggil OpenAI, supaya dua permintaan bersamaan (klik
  // ganda / dua tab) tidak sama-sama menukar kode yang sama.
  const claimed = await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(attemptId)}&exchanged_code_fingerprint=is.null`, {
    method: 'PATCH',
    prefer: 'return=representation',
    body: { exchanged_code_fingerprint: codeFingerprint, updated_at: new Date().toISOString() },
  }).then((r) => r.json()).catch(() => null);
  if (Array.isArray(claimed) && claimed.length === 0) {
    throw fail('Kode ini sedang/ sudah dipakai untuk login. Muat ulang halaman; bila akun belum muncul, ulangi login.', 409);
  }

  // Pertukaran kode. `resource` dikirim sesuai dokumentasi; bila OpenAI
  // menolak dengan `invalid_grant` (sesuai catatan mereka: "discard that code
  // and start a fresh authorization"), percobaan kedua tanpa `resource`
  // dicoba sekali — perbedaan ini dulu tidak terlihat karena errornya sama.
  const exchange = async (withResource) => {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: attempt.code_verifier,
      redirect_uri: attempt.redirect_uri,
      ...(withResource ? { resource: OPENAI_RESOURCE } : {}),
    });
    let res;
    try {
      res = await fetch(`${OPENAI_AUTH_BASE}/api/accounts/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw fail(`Tidak bisa menghubungi OpenAI: ${String(error?.message || error).slice(0, 160)}`, 502);
    }
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { ok: res.ok && Boolean(data?.access_token), status: res.status, data, text, withResource };
  };

  let result = await exchange(true);
  if (!result.ok && result.data?.error === 'invalid_grant') {
    const retry = await exchange(false);
    if (retry.ok) result = retry;
    else {
      // Simpan kedua jawaban: tanpa ini, "invalid_grant" tidak bisa dilacak
      // (OpenAI tidak mengirim error_description pada kasus ini).
      result = { ...retry, attempts: [result, retry] };
    }
  }
  const text = result.text;
  const token = result.data;
  if (!result.ok) {
    await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(attemptId)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: {
        status: 'failed',
        // OpenAI: "If code exchange returns invalid_grant, discard that code and
        // start a fresh authorization WITH the issued client ID retained."
        // Dulu id terbitan ini dibuang saat gagal, sehingga setiap percobaan
        // berikutnya mendaftar ulang sebagai `dynamic_agent_client` dan
        // berakhir dengan invalid_grant yang sama, berulang tanpa akhir.
        issued_client_id: clientId,
        // Jejak teknis (tanpa token/kode) supaya penyebab bisa dibaca nanti.
        error_message: cleanText(`client=${clientId} verify=${codeFingerprint} status=${result.status} body=${text.slice(0, 160)}${result.attempts ? ` | retry(${result.attempts[1].status})=${result.attempts[1].text.slice(0, 80)}` : ''}`, 900),
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
    const detail = token?.error_description || token?.error || text.slice(0, 200) || `HTTP ${result.status}`;
    if (token?.error === 'invalid_grant') {
      throw fail(
        'OpenAI menolak pertukaran kode (invalid_grant) dan tidak menjelaskan sebabnya. Tiga penyebab yang paling sering: '
        + '(1) paket ChatGPT akun itu tidak bisa dipakai aplikasi lain — perlu Plus/Pro pada akun pribadi, bukan Free/Go atau workspace kerja; '
        + '(2) kode sudah terpakai karena halaman 127.0.0.1 dimuat dua kali; '
        + '(3) izin pemakaian paket tidak dicentang saat menyetujui. '
        + 'Client yang sudah terbit disimpan, jadi menekan Continue with ChatGPT lagi tidak mendaftar ulang.',
        400,
      );
    }
    throw fail(`OpenAI menolak pertukaran kode: ${detail}`, 400);
  }

  const scopes = String(token.scope || '').split(/\s+/).filter(Boolean);
  const planUsage = scopes.includes('chatgpt.tokens.use.direct');
  const claims = decodeJwtPayload(token.id_token || token.access_token || '');
  const email = cleanText(claims?.email || '', 320);
  const label = cleanText(input.label, 100) || email || 'ChatGPT (OAuth)';

  // Simpan kredensial di tabel tautan (audit + refresh), lalu daftarkan ke pool.
  // Impor statis (bukan dinamis) supaya bundel Worker tidak bergantung pada
  // resolusi modul saat runtime, dan supaya tidak ada siklus impor.
  const sealedAccess = await sealChatGptToken(env, token.access_token);
  const sealedRefresh = token.refresh_token ? await sealChatGptToken(env, token.refresh_token) : '';
  const sealedIdToken = token.id_token ? await sealChatGptToken(env, token.id_token) : '';
  await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(attemptId)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      status: planUsage ? 'linked' : 'linked_identity_only',
      issued_client_id: clientId,
      account_email: email,
      subject: cleanText(claims?.sub || '', 200),
      scopes,
      plan_usage: planUsage,
      sealed_access_token: sealedAccess,
      sealed_refresh_token: sealedRefresh || null,
      sealed_id_token: sealedIdToken || null,
      access_expires_at: new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    },
  });

  let account = null;
  if (planUsage) {
    account = await createChatGptAccount(env, {
      account_email: email,
      account_label: label,
      credential_kind: 'oauth',
      api_base: 'https://api.openai.com',
      model_default: cleanText(input.model_default, 120) || 'gpt-5.1',
      // Hanya chat & agen: token OAuth tidak membuka gambar/video/audio.
      capabilities: ['chat', 'agent'],
      daily_limit: 0,
      token: token.access_token,
      oauth_client_id: clientId,
      oauth_expires_at: new Date(Date.now() + (Number(token.expires_in) || 3600) * 1000).toISOString(),
      oauth_refresh_sealed: sealedRefresh || null,
    }, user.id).catch(() => null);
  }

  return {
    link: {
      email,
      scopes,
      plan_usage: planUsage,
      client_id: clientId,
    },
    account,
    hint: planUsage
      ? 'Akun ChatGPT tersambung tanpa API key. Kuota mengikuti paket ChatGPT pemilik akun.'
      : 'Identitas ChatGPT tersambung, tetapi izin pemakaian paket (chatgpt.tokens.use.direct) belum dicentang saat persetujuan. Ulangi login lalu centang "gunakan paket ChatGPT saya".',
  };
}

/** Refresh token OAuth (akses 1 jam, refresh 30 hari bergulir). */
export async function refreshOAuthLink(env, id) {
  if (!isOAuthLinkId(id)) throw fail('ID tautan tidak valid.', 400);
  const rows = await dbJson(env, `${TABLE}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Tautan ChatGPT tidak ditemukan.', 404);
  const refreshToken = await unsealChatGptToken(env, row.sealed_refresh_token || '');
  if (!refreshToken) throw fail('Tautan ini tidak punya refresh token. Sambungkan ulang akun ChatGPT.', 400);
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: row.issued_client_id,
    refresh_token: refreshToken,
    resource: OPENAI_RESOURCE,
  });
  const res = await fetch(`${OPENAI_AUTH_BASE}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(30_000),
  }).catch((error) => { throw fail(`Tidak bisa menghubungi OpenAI: ${String(error?.message || error).slice(0, 160)}`, 502); });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    throw fail(`Refresh ditolak OpenAI (HTTP ${res.status}). ${data?.error_description || data?.error || ''}`.trim(), 400);
  }
  const patch = {
    sealed_access_token: await sealChatGptToken(env, data.access_token),
    access_expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (data.refresh_token) patch.sealed_refresh_token = await sealChatGptToken(env, data.refresh_token);
  await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', prefer: 'return=minimal', body: patch });
  return { ok: true, expires_at: patch.access_expires_at };
}

/**
 * `client_id` terbitan OpenAI terakhir untuk pengguna ini.
 *
 * Dipakai saat memulai login lagi: kalau sudah pernah terbit, percobaan baru
 * memakai id itu (tanpa `agent_name_hint`) sesuai panduan OpenAI, bukan
 * mendaftar ulang sebagai `dynamic_agent_client`. Baris `failed` ikut dibaca
 * karena exactly kasus itu (gagal tukar kode) yang paling butuh diulang dengan
 * id yang dipertahankan.
 */
export async function retainedClientId(env, user) {
  const rows = await dbJson(
    env,
    `${TABLE}?select=issued_client_id,account_email&user_id=eq.${encodeURIComponent(user.id)}&issued_client_id=not.is.null&order=created_at.desc&limit=1`,
  ).catch(() => null);
  const row = Array.isArray(rows) ? rows[0] : null;
  const clientId = cleanText(row?.issued_client_id, 120);
  if (!clientId || clientId === OPENAI_DYNAMIC_CLIENT_ID) return null;
  return { client_id: clientId, email: cleanText(row?.account_email, 320) || '' };
}

/** Daftar tautan ChatGPT milik satu pengguna (tanpa token). */
export async function listOAuthLinks(env, user) {
  const rows = await dbJson(env, `${TABLE}?select=id,status,account_email,subject,scopes,plan_usage,issued_client_id,access_expires_at,error_message,created_at,updated_at&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=50`).catch(() => []);
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).map((row) => {
    // Percobaan `pending` yang lewat 30 menit tidak bisa diselesaikan lagi
    // (kode otorisasi maupun server menyimpannya sementara). Ditampilkan apa
    // adanya sebagai `expired`, supaya UI tidak terus bilang "menunggu
    // persetujuan" padahal tidak ada yang menunggu.
    const createdAt = Date.parse(row.created_at || 0);
    const stale = row.status === 'pending' && Number.isFinite(createdAt) && now - createdAt > 30 * 60 * 1000;
    return {
    id: row.id,
    status: stale ? 'expired' : row.status,
    stale,
    email: row.account_email || '',
    plan_usage: row.plan_usage === true,
    scopes: Array.isArray(row.scopes) ? row.scopes : [],
    client_id: row.issued_client_id || '',
    access_expires_at: row.access_expires_at || null,
    error: row.error_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  });
}

/** Putuskan tautan: revoke refresh token di OpenAI, lalu hapus baris. */
export async function disconnectOAuthLink(env, user, id) {
  if (!isOAuthLinkId(id)) throw fail('ID tautan tidak valid.', 400);
  const rows = await dbJson(env, `${TABLE}?select=*&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Tautan ChatGPT tidak ditemukan.', 404);
  const refreshToken = await unsealChatGptToken(env, row.sealed_refresh_token || '');
  let revoked = false;
  if (refreshToken && row.issued_client_id) {
    try {
      const res = await fetch(`${OPENAI_AUTH_BASE}/api/accounts/oauth/revoke`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: 'refresh_token',
          client_id: row.issued_client_id,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      revoked = res.ok;
      await res.body?.cancel?.().catch?.(() => {});
    } catch { revoked = false; }
  }
  await dbRequest(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  return { ok: true, revoked, note: revoked ? 'Sesi ChatGPT dicabut di sisi OpenAI.' : 'Tautan dihapus di BLEA; pencabutan di OpenAI tidak terkonfirmasi. Cabut manual di ChatGPT → Settings → Apps.' };
}

/** Model yang tersedia untuk akun ChatGPT hasil login (dipakai model picker). */
export async function listOAuthAccountModels(env, accessToken) {
  const res = await fetch(`${OPENAI_RESOURCE}/models`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const models = Array.isArray(data?.models) ? data.models : [];
  return models
    .filter((model) => !model?.visibility || model.visibility === 'list')
    .map((model) => ({ id: String(model?.slug || model?.id || ''), label: String(model?.display_name || model?.slug || '') }))
    .filter((model) => model.id);
}

/** Payload JWT tanpa verifikasi tanda tangan (hanya untuk email/sub tampilan). */
export function decodeJwtPayload(jwt) {
  const parts = String(jwt || '').split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[1].length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
