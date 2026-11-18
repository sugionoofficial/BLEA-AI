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
  if (!res.ok) throw new Error(payload.error || 'Freebeat tidak dapat dihubungi.');
  return payload;
}
