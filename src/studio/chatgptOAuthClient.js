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
export async function beginChatGptSignIn() {
  const port = window.location.port || '1455';
  const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const state = randomString(32);
  const nonce = randomString(24);
  const codeVerifier = randomString(64);
  const codeChallenge = await challengeFor(codeVerifier);

  const res = await chatGptOAuthApi.start({ state, nonce, code_verifier: codeVerifier, redirect_uri: redirectUri });
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

  const params = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: AGENT_NAME_HINT,
    ext_agent_host_id: `urn:uuid:${hostId()}`,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });
  window.location.assign(`${AUTHORIZE_ENDPOINT}?${params.toString()}`);
  return { ok: true };
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
export async function finishChatGptSignIn(search = '') {
  const params = new URLSearchParams(search || (typeof window !== 'undefined' ? window.location.search : ''));
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
  if (pending && pending.state !== returnedState) {
    return { ok: false, error: 'state OAuth tidak cocok dengan sesi di browser ini. Mulai lagi dari tombol Continue with ChatGPT.' };
  }
  if (params.get('error')) {
    const res = await chatGptOAuthApi.complete({
      ...(pending ? { attempt_id: pending.attemptId } : {}),
      state: returnedState,
      error: params.get('error'),
      error_description: params.get('error_description') || '',
    });
    return { ok: false, error: res.data?.error || 'Izin ChatGPT ditolak.' };
  }
  const code = params.get('code') || '';
  if (!code) return { ok: false, error: 'Kode otorisasi tidak ada di URL callback.' };

  const res = await chatGptOAuthApi.complete({
    ...(pending ? { attempt_id: pending.attemptId } : {}),
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
