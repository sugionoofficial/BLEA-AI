import { supabase } from '../lib/supabase';

// Edge function "ai-chat" di Supabase — key API tetap di server.
const EDGE_BASE = `${(import.meta.env.VITE_SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '')}/functions/ai-chat`;

async function edgeRequest(path, body) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  const res = await fetch(`${EDGE_BASE}?path=${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token || ''}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function fetchProviderStatus() {
  const { data } = await edgeRequest('status', {});
  return data;
}

export async function fetchFreeModels() {
  const { data } = await edgeRequest('models', {});
  return data.models || [];
}

// Admin panel — daftar model UnoRouter (model gratis) dengan status aktif.
export async function fetchAdminModels({ apiKey } = {}) {
  const { data, status } = await edgeRequest('admin-models', { apiKey });
  return { models: Array.isArray(data?.models) ? data.models : [], error: data?.error || '', status };
}

// Admin panel — simpan pilihan model aktif untuk provider.
export async function saveProviderModels({ provider, models }) {
  return edgeRequest('save-models', { provider, models });
}

// AI Studio — model aktif yang dipilih admin (berjalan ke UnoRouter).
export async function fetchEnabledModels() {
  const { data } = await edgeRequest('enabled-models', {});
  return Array.isArray(data?.models) ? data.models : [];
}

export async function chatCompletion({ conversationId, model, messages }) {
  return edgeRequest('chat', { conversationId, model, messages });
}

export async function verifyKey({ apiKey, baseUrl }) {
  return edgeRequest('verify', { apiKey, baseUrl });
}
