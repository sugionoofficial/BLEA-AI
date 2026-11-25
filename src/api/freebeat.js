import { supabase } from '../lib/supabase';

// Admin-scoped endpoints; the backend verifies the BLEA role and OAuth session.
// Tokens and quote approvals never leave the same-origin request or enter storage.
export async function freebeatRequest(action, method = 'GET', body) {
  const { data } = await supabase.auth.getSession();
  let session = data?.session;
  if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) session = (await supabase.auth.refreshSession()).data?.session;
  if (!session?.access_token) throw new Error('Sesi login berakhir. Silakan login kembali.');
  const res = await fetch(`/api/freebeat/${action}`, { method, headers: { authorization: `Bearer ${session.access_token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin', cache: 'no-store' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = Object.assign(new Error(payload.error || 'Freebeat tidak dapat dihubungi.'), { status: res.status });
    // Never infer non-dispatch from an HTTP status or provider error prose.
    if (action === 'video-submit' && [400, 409].includes(res.status) && payload.video_dispatch === 'not_sent') error.videoDispatch = 'not_sent';
    throw error;
  }
  return payload;
}

export function startFreebeatOAuth({ email = '', label = '', accountId = '', returnTo = '' } = {}) {
  const payload = {};
  if (email && String(email).trim()) payload.email = String(email).trim();
  if (label && String(label).trim()) payload.label = String(label).trim();
  if (accountId && String(accountId).trim()) payload.accountId = String(accountId).trim();
  if (returnTo && String(returnTo).trim()) payload.returnTo = String(returnTo).trim();
  return freebeatRequest('start', 'POST', payload);
}

export function fetchFreebeatAccounts() {
  return freebeatRequest('accounts', 'GET');
}

export function updateFreebeatAccount(payload) {
  return freebeatRequest('accounts', 'PATCH', payload);
}

export function deleteFreebeatAccount(id) {
  return freebeatRequest('accounts', 'DELETE', { id });
}

export function reorderFreebeatAccounts(orderedIds) {
  return freebeatRequest('accounts/reorder', 'POST', { orderedIds });
}

export function checkFreebeatAccountsBalance(id = null) {
  return freebeatRequest('accounts/balance', 'POST', id ? { id } : {});
}
