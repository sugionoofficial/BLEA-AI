// Klien "Daftar akun OpenAI pakai email TempMail" (halaman Akun OpenAI).
//
// Yang dilakukan: minta URL login resmi platform, mencatat langkah manual, dan
// meminta pencocokan email verifikasi di inbox. Yang TIDAK dilakukan: mengirim
// kata sandi, mem-POST formulir dari server, atau menyimpan cookie sesi.

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
  const res = await fetch(`/api/openai-signup/userscript${query}`, {
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

export const openAiSignupApi = {
  status: () => request('/openai-signup'),
  // `next` dibatasi daftar path tetap di server, jadi tidak bisa dipakai
  // mengarahkan ke domain lain.
  prepare: (email, { next = '' } = {}) => request('/openai-signup', {
    method: 'POST',
    body: { action: 'prepare', email, ...(next ? { next } : {}) },
  }),
  mark: (id, step, note = '') => request('/openai-signup', { method: 'POST', body: { action: 'mark', id, step, note } }),
  verify: (id) => request('/openai-signup', { method: 'POST', body: { action: 'verify', id } }),
  // Baca ulang kode yang sudah tersimpan (tanpa panggilan Gmail baru).
  code: (id) => request('/openai-signup', { method: 'POST', body: { action: 'code', id } }),
  // Bukti langkah: URL setelah pengguna menekan "Continue" di halaman platform.
  confirm: (id, url) => request('/openai-signup', { method: 'POST', body: { action: 'confirm', id, url } }),
};

export const SIGNUP_STEP_META = {
  dibuka: { label: 'URL daftar disiapkan', tone: 'muted' },
  email_dikirim: { label: 'Formulir dikirim manual', tone: 'warn' },
  menunggu_verifikasi: { label: 'Menunggu email verifikasi', tone: 'warn' },
  terverifikasi: { label: 'Email verifikasi ditemukan', tone: 'ok' },
  dilewati: { label: 'Dilewati', tone: 'muted' },
};
