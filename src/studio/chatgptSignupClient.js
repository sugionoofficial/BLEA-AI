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

export const chatGptSignupApi = {
  status: () => request('/chatgpt-signup'),
  prepare: (email, authSessionLoggingId = '') => request('/chatgpt-signup', {
    method: 'POST',
    body: { action: 'prepare', email, ...(authSessionLoggingId ? { auth_session_logging_id: authSessionLoggingId } : {}) },
  }),
  mark: (id, step, note = '') => request('/chatgpt-signup', { method: 'POST', body: { action: 'mark', id, step, note } }),
  verify: (id) => request('/chatgpt-signup', { method: 'POST', body: { action: 'verify', id } }),
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
