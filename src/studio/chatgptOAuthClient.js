// Klien "Continue with ChatGPT" di browser.
//
// Kenapa PKCE dikerjakan di browser: OpenAI mewajibkan redirect_uri berupa
// loopback `http://127.0.0.1:<port>/auth/callback`, artinya callback hanya bisa
// diterima oleh halaman di perangkat pengguna — bukan oleh Worker. Halaman ini
// karena itu membuka tab OAuth, menerima `code`, lalu mengirim kode tersebut
// SEKALI ke Worker untuk ditukar dan disegel. Access/refresh token tidak pernah
// masuk ke localStorage, cookie, atau state React.

import { getAccessToken } from '../api/client';
import { parseCallbackInput } from './oauthCallbackUrl';
import { resolveOAuthRedirectUri } from '../lib/chatgptSignup';

const AUTHORIZE_ENDPOINT = 'https://auth.openai.com/api/accounts/authorize';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const RESOURCE = 'https://api.openai.com/v1';
const CALLBACK_PATH = '/auth/callback';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const AGENT_NAME_HINT = 'BLEA AI';
const PENDING_KEY = 'blea.chatgpt.oauth.pending';

function randomString(bytes = 48) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return base64Url(array);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function api(path, options = {}) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: options.method || 'GET',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    return { ok: false, status: 0, data: { error: String(error?.message || error) } };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const chatGptOAuthApi = {
  status: () => api('/chatgpt-oauth'),
  start: (body) => api('/chatgpt-oauth/start', { method: 'POST', body }),
  complete: (body) => api('/chatgpt-oauth/complete', { method: 'POST', body }),
  refresh: (id) => api('/chatgpt-oauth/refresh', { method: 'POST', body: { id } }),
  disconnect: (id) => api('/chatgpt-oauth/disconnect', { method: 'POST', body: { id } }),
};

/**
 * Apakah origin ini bisa menerima callback OAuth secara otomatis.
 *
 * OpenAI mewajibkan redirect_uri loopback `http://127.0.0.1:<port>/auth/callback`
 * untuk klien open-source. Artinya: bila BLEA dibuka dari 127.0.0.1 (dev atau
 * self-host di mesin sendiri), callback mendarat langsung di halaman
 * /auth/callback dan alur selesai otomatis. Bila dibuka dari domain publik
 * (blea.ai), tidak ada yang mendengarkan di 127.0.0.1 — untuk itu UI
 * menyediakan jalur tempel-URL callback. Domain publik butuh client ID partner
 * dari OpenAI (formulir Sign in with ChatGPT) supaya bisa memakai redirect https.
 */
export function oauthAutoCallbackSupported() {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === '127.0.0.1';
}

/** Apakah halaman ini sedang menerima callback OAuth (127.0.0.1:port/auth/callback). */
export function isOAuthCallbackPage() {
  if (typeof window === 'undefined') return false;
  return window.location.pathname === CALLBACK_PATH && window.location.hostname === '127.0.0.1';
}

export function readPendingAttempt() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.attemptId || Date.now() - Number(parsed.startedAt || 0) > 15 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearPendingAttempt() {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(PENDING_KEY); } catch { /* mode privat */ }
}

/**
 * Mulai login: daftarkan attempt (state/nonce/PKCE disimpan server), lalu buka
 * halaman izin OpenAI di tab yang sama. Return value hanya untuk UI.
 */
export async function beginChatGptSignIn({ issuedClientId = '', loginHint = '', tab = null } = {}) {
  // Port callback: pakai port halaman HANYA bila BLEA memang dibuka dari
  // 127.0.0.1 (di situ ada server yang mendengarkan, jadi callback mendarat
  // otomatis). Di domain publik tidak ada yang mendengarkan di perangkat
  // pengguna, jadi dipilih port acak dan URL callback diselesaikan lewat
  // tempel-URL.
  //
  // Dokumen OpenAI hanya mengizinkan PORT berubah antar percobaan; skema,
  // host, dan path harus tetap (`localhost` tidak boleh menggantikan 127.0.0.1).
  //
  // CATATAN JUJUR: pemilihan port ini HIPOTESIS untuk `invalid_state`, belum
  // terbukti. `state` dikirim apa adanya; yang membuat OpenAI tidak
  // mengenalinya kemungkinan besar percobaan yang tidak ada/berbeda di server.
  const redirectInfo = resolveOAuthRedirectUri({
    hostname: typeof window === 'undefined' ? '' : window.location.hostname,
    port: typeof window === 'undefined' ? '' : window.location.port,
  });
  const redirectUri = redirectInfo.redirect_uri;
  const state = randomString(32);
  const nonce = randomString(24);
  const codeVerifier = randomString(64);
  const codeChallenge = await challengeFor(codeVerifier);

  // `client_id` IKUT dikirim ke /start. Sebelumnya tidak, sehingga baris
  // percobaan tidak bisa membuktikan client mana yang dipakai saat authorize —
  // dan itulah satu-satunya cara membedakan "pendaftaran pertama" dari
  // "mendaftar ulang padahal client sudah terbit".
  const authorizeClientId = issuedClientId && issuedClientId !== DYNAMIC_CLIENT_ID ? issuedClientId : '';
  const res = await chatGptOAuthApi.start({
    state,
    nonce,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    client_id: authorizeClientId,
  });
  if (!res.ok) return { ok: false, error: res.data?.error || 'Tidak bisa memulai sesi login ChatGPT.' };

  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({
      attemptId: res.data.id,
      state,
      nonce,
      redirectUri,
      startedAt: Date.now(),
    }));
  } catch { /* localStorage diblokir: state tetap divalidasi server */ }

  // Panduan OpenAI: registrasi pertama memakai `dynamic_agent_client` +
  // `agent_name_hint`; login BERIKUTNYA memakai `client_id` terbitan dan
  // TIDAK mengirim `agent_name_hint`. Ini juga yang membuat `invalid_grant`
  // tidak berulang: id terbitan dipertahankan, bukan didaftarkan ulang.
  const reauth = Boolean(issuedClientId && issuedClientId !== DYNAMIC_CLIENT_ID);
  const params = new URLSearchParams({
    client_id: reauth ? issuedClientId : DYNAMIC_CLIENT_ID,
    ext_agent_host_id: `urn:uuid:${hostId()}`,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    ...(reauth ? {} : { agent_name_hint: AGENT_NAME_HINT }),
    ...(reauth && loginHint ? { login_hint: loginHint } : {}),
  });
  const authorizeUrl = `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
  // Dibuka di TAB BARU, bukan menggantikan halaman BLEA.
  //
  // Kalau `location.assign` dipakai, halaman admin hilang; callback lalu
  // mendarat di 127.0.0.1:<port> yang tidak punya sesi login BLEA, dan
  // pengguna tidak lagi punya panel untuk menempel URL callback. Dengan tab
  // baru, halaman panel tetap hidup di belakang dan bisa dipakai menyelesaikan
  // alur (terutama di domain publik, tempat callback tidak bisa otomatis).
  // Tab yang sudah dibuka pemanggil (sebelum `await`) lebih dulu dipakai:
  // `window.open` setelah await dianggap bukan bagian dari klik pengguna dan
  // diblokir popup blocker.
  let opened = tab || null;
  if (!opened) {
    try { opened = window.open(authorizeUrl, '_blank'); } catch { opened = null; }
  } else {
    try { opened.location.replace(authorizeUrl); } catch { opened = null; }
  }
  if (!opened) {
    // Popup diblokir: beri URL-nya supaya bisa dibuka manual, jangan diam.
    return { ok: true, authorize_url: authorizeUrl, opened: false };
  }
  try { opened.opener = null; } catch { /* lintas-origin: tidak apa-apa */ }
  return { ok: true, authorize_url: authorizeUrl, opened: true };
}

// Host ID stabil per browser (bukan identitas pengguna): OpenAI memakainya untuk
// mengaitkan pemakaian paket dengan perangkat, bukan untuk autentikasi.
function hostId() {
  try {
    const existing = window.localStorage.getItem('blea.chatgpt.hostId');
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem('blea.chatgpt.hostId', fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/**
 * Selesaikan callback: kirim `code` + `state` + `client_id` terbitan ke Worker.
 * Worker yang memvalidasi state, menukar kode, menyegel token, dan mendaftarkan
 * akun ke pool.
 */
// Satu kode otorisasi hanya boleh ditukar SEKALI. Halaman /auth/callback bisa
// termuat lebih dari sekali (hard reload, tab dipulihkan, StrictMode di dev),
// dan dulu setiap pemuatan mengirim penukaran baru — kode pertama menang,
// sisanya mendapat `invalid_grant` yang menutupi keberhasilan sebenarnya.
// Promise modul ini memastikan penukaran hanya terjadi satu kali per kode.
let inFlightExchange = null;
let exchangedCode = '';

export async function finishChatGptSignIn(search = '') {
  const params = new URLSearchParams(search || (typeof window !== 'undefined' ? window.location.search : ''));
  const codeForExchange = params.get('code') || '';
  if (codeForExchange && exchangedCode === codeForExchange && inFlightExchange) {
    return inFlightExchange;
  }
  if (codeForExchange) exchangedCode = codeForExchange;
  inFlightExchange = runExchange(params);
  try {
    return await inFlightExchange;
  } finally {
    setTimeout(() => { inFlightExchange = null; }, 30_000);
  }
}

async function runExchange(params) {
  const pending = readPendingAttempt();
  const returnedState = params.get('state') || '';
  if (!returnedState) {
    return { ok: false, error: 'URL callback tidak memuat parameter state. Salin ulang URL selengkapnya dari bilah alamat browser.' };
  }
  // `state` dicocokkan ke baris percobaan yang tersimpan di SERVER, bukan hanya
  // ke localStorage. Alasannya: callback mendarat di 127.0.0.1 (port browser),
  // dan pengguna sering menyelesaikannya dari tab/domain lain (blea.ai) yang
  // localStorage-nya berbeda. Karena PKCE verifier juga disimpan server,
  // penukaran kode tetap sah dari perangkat mana pun milik pengguna yang sama.
  // Kalau localStorage memuat percobaan LAIN (mis. URL callback diselesaikan
  // di perangkat/tab lain dari tempat OAuth dimulai — persis yang terjadi saat
  // pengguna pindah dari HP ke PC), jangan langsung menolak. `attempt_id` tidak
  // dikirim, dan server mencari barisnya lewat `state` yang hanya berlaku
  // sekali. Menolak di sini dulu membuat tempelan URL yang benar-benar sah
  // gagal dengan pesan yang menyesatkan.
  const pendingMatches = Boolean(pending && pending.state === returnedState);
  const pendingAttemptId = pendingMatches ? pending.attemptId : '';
  if (params.get('error')) {
    const res = await chatGptOAuthApi.complete({
      ...(pendingAttemptId ? { attempt_id: pendingAttemptId } : {}),
      state: returnedState,
      error: params.get('error'),
      error_description: params.get('error_description') || '',
    });
    return { ok: false, error: res.data?.error || 'Izin ChatGPT ditolak.' };
  }
  const code = params.get('code') || '';
  if (!code) return { ok: false, error: 'Kode otorisasi tidak ada di URL callback.' };

  const res = await chatGptOAuthApi.complete({
    ...(pendingAttemptId ? { attempt_id: pendingAttemptId } : {}),
    state: returnedState,
    code,
    client_id: params.get('client_id') || '',
    scope: params.get('scope') || '',
  });
  if (!res.ok) return { ok: false, error: res.data?.error || 'Pertukaran kode OAuth gagal.' };
  clearPendingAttempt();
  return { ok: true, ...res.data };
}


/**
 * Selesaikan callback dari URL yang ditempel pengguna.
 *
 * Dipakai ketika halaman loopback 127.0.0.1:<port> tidak bisa dibuka (mis. BLEA
 * diakses dari domain publik): setelah menyetujui di ChatGPT, browser berhenti
 * di alamat yang memuat ?code=…&state=… — alamat itu ditempel di sini. state
 * tetap divalidasi terhadap attempt yang tersimpan, jadi tempelan URL sembarang
 * tidak bisa menyelesaikan login.
 */
export async function finishChatGptSignInFromUrl(rawUrl) {
  const params = parseCallbackInput(rawUrl);
  if (!params) return { ok: false, error: 'Tempel URL callback dari browser (alamat yang memuat ?code=…&state=…).' };
  return finishChatGptSignIn(params);
}
