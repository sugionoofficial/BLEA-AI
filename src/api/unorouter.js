import { supabase } from '../lib/supabase';

// API routes served by the Cloudflare Worker (same origin — no CORS).
// These replace the Supabase edge function "ai-chat" (edge runtime on this
// project returns BOOT_ERROR for all functions — see dashboard logs).
// Env vars for the Worker: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
const EDGE_BASE = '/api';
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz';

async function edgeRequest(path, body) {
  // getSession() mengembalikan cache — bisa sudah expired (JWT 1 jam).
  // Refresh dulu agar edge function menerima token valid.
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  let token = session?.access_token;
  if (!token || (session?.expires_at && session.expires_at * 1000 < Date.now() + 60_000)) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed?.data?.session?.access_token;
  }
  if (!token) {
    return { ok: false, status: 401, data: { error: 'authentication required' } };
  }
  const res = await fetch(`${EDGE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function fetchProviderStatus() {
  const { data } = await edgeRequest('/status', {});
  return data;
}

export async function fetchFreeModels() {
  const { data } = await edgeRequest('/models', {});
  return data.models || [];
}

// Admin panel — daftar model UnoRouter (model gratis) dengan status aktif.
export async function fetchAdminModels({ apiKey } = {}) {
  const { data, status } = await edgeRequest('/admin-models', { apiKey });
  return { models: Array.isArray(data?.models) ? data.models : [], error: data?.error || '', status };
}

// Admin panel — simpan pilihan model aktif untuk provider.
export async function saveProviderModels({ provider, models }) {
  return edgeRequest('/save-models', { provider, models });
}

// AI Studio — model aktif yang dipilih admin (berjalan ke UnoRouter).
export async function fetchEnabledModels() {
  const { data } = await edgeRequest('/enabled-models', {});
  return Array.isArray(data?.models) ? data.models : [];
}

export async function chatCompletion({ conversationId, model, messages }) {
  return edgeRequest('/chat', { conversationId, model, messages });
}

export async function verifyKey({ apiKey, baseUrl }) {
  return edgeRequest('/verify', { apiKey, baseUrl });
}
