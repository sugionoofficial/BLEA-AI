// Klien "Daftar ChatGPT pakai email TempMail" (halaman Akun ChatGPT).
//
// yang dilakukan: minta URL daftar resmi berisi login_hint = email TempMail,
// mencatat langkah manual, dan meminta pencocokan email verifikasi di inbox.
// Yang TIDAK dilakukan: mengirim kata sandi, mem-POST chatgpt.com dari server,
// atau menyimpan cookie sesi chatgpt.com.

import { getAccessToken } from '../api/client';

async function request(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken();
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return { ok: false, status: 0, data: { error: String(error?.message || error) } };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/**
 * Unduh userscript sebagai teks. Tidak bisa lewat <a href> karena rute itu
 * memerlukan header Authorization, jadi diambil dengan fetch lalu disajikan
 * sebagai Blob ke pengguna.
 */
export async function fetchAutofillUserscript(email = '') {
  const token = await getAccessToken();
  const query = email ? `?email=${encodeURIComponent(email)}` : '';
  const res = await fetch(`/api/chatgpt-signup/userscript${query}`, {
    method: 'GET',
    cache: 'no-store',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, error: data?.error || `Userscript tidak bisa diunduh (HTTP ${res.status}).` };
  }
  return { ok: true, text: await res.text() };
}

export const chatGptSignupApi = {
  status: () => request('/chatgpt-signup'),
  // `route`: 'platform' (default) membuka platform.openai.com; 'chatgpt'
  // membuka chatgpt.com untuk alur OAuth. `next` hanya dipakai jalur platform
  // dan divalidasi server (daftar path tetap).
  prepare: (email, authSessionLoggingId = '', { route = 'platform', next = '' } = {}) => request('/chatgpt-signup', {
    method: 'POST',
    body: {
      action: 'prepare',
      email,
      route,
      ...(next ? { next } : {}),
      ...(authSessionLoggingId ? { auth_session_logging_id: authSessionLoggingId } : {}),
    },
  }),
  mark: (id, step, note = '') => request('/chatgpt-signup', { method: 'POST', body: { action: 'mark', id, step, note } }),
  verify: (id) => request('/chatgpt-signup', { method: 'POST', body: { action: 'verify', id } }),
  // Baca ulang kode yang sudah tersimpan (tanpa panggilan Gmail baru).
  code: (id) => request('/chatgpt-signup', { method: 'POST', body: { action: 'code', id } }),
  // Bukti langkah: URL setelah pengguna menekan "Lanjutkan" di halaman ChatGPT.
  confirm: (id, url) => request('/chatgpt-signup', { method: 'POST', body: { action: 'confirm', id, url } }),
};

/** UUID acak untuk `auth_session_logging_id` (parameter yang sama seperti di browser ChatGPT). */
export function newLoggingId() {
  try {
    return crypto.randomUUID();
  } catch {
    return '';
  }
}

export const SIGNUP_STEP_META = {
  dibuka: { label: 'URL daftar disiapkan', tone: 'muted' },
  email_dikirim: { label: 'Formulir dikirim manual', tone: 'warn' },
  menunggu_verifikasi: { label: 'Menunggu email verifikasi', tone: 'warn' },
  terverifikasi: { label: 'Email verifikasi ditemukan', tone: 'ok' },
  dilewati: { label: 'Dilewati', tone: 'muted' },
};
