import { supabase } from '../lib/supabase';

// API routes served by the Cloudflare Worker (same origin — no CORS).
// Env vars for the Worker: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
export const EDGE_BASE = '/api';
export const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz';

export async function getAccessToken() {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  let token = session?.access_token;
  if (!token || (session?.expires_at && session.expires_at * 1000 < Date.now() + 60_000)) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed?.data?.session?.access_token;
  }
  return token || '';
}

export async function edgeRequest(path, body) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, status: 401, data: { error: 'authentication required' } };
  }
  try {
    const res = await fetch(`${EDGE_BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body ?? {}),
    });
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        ok: false,
        status: res.status,
        workerUnavailable: true,
        data: { error: 'API worker belum aktif pada pratinjau lokal ini.' },
      };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      workerUnavailable: true,
      data: { error: String(error?.message || error) },
    };
  }
}
