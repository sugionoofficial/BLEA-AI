import { supabase } from '../lib/supabase';

// API routes served by the Cloudflare Worker (same origin — no CORS).
// Env vars for the Worker: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
const EDGE_BASE = '/api';
const PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz';

async function getAccessToken() {
  const { data: sessionData } = await supabase.auth.getSession();
  const session = sessionData?.session;
  let token = session?.access_token;
  if (!token || (session?.expires_at && session.expires_at * 1000 < Date.now() + 60_000)) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed?.data?.session?.access_token;
  }
  return token || '';
}

async function edgeRequest(path, body) {
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

export async function fetchProviderStatus() {
  const { data } = await edgeRequest('/status', {});
  return data;
}

export async function fetchFreeModels() {
  const { data } = await edgeRequest('/models', {});
  return data.models || [];
}

// Admin panel — daftar model per provider dengan status aktif.
export async function fetchAdminModels({ apiKey } = {}) {
  const { data, status } = await edgeRequest('/admin-models', { apiKey });
  return { models: Array.isArray(data?.models) ? data.models : [], error: data?.error || '', status };
}

// Admin panel — catalog model dari UnoRouter / OpenRouter (di-fetch server-side via worker).
export async function fetchCatalog({ provider = 'unorouter' } = {}) {
  const { data, status } = await edgeRequest('/catalog', { provider });
  return { models: Array.isArray(data?.models) ? data.models : null, error: data?.error || '', status };
}

// Admin panel — simpan pilihan model aktif untuk provider.
export async function saveProviderModels({ provider, models }) {
  return edgeRequest('/save-models', { provider, models });
}

// Admin panel — tambah / ubah satu model untuk provider mana pun.
export async function saveSingleProviderModel({ provider, model, active = true }) {
  return edgeRequest('/save-models', { mode: 'upsert_one', provider, model, active });
}

// AI Studio — model aktif yang dipilih admin.
export async function fetchEnabledModels() {
  const { data } = await edgeRequest('/enabled-models', {});
  return Array.isArray(data?.models) ? data.models : [];
}

export async function fetchEnabledModelItems() {
  const { data } = await edgeRequest('/enabled-models', {});
  if (Array.isArray(data?.modelItems) && data.modelItems.length) return data.modelItems;
  return Array.isArray(data?.models) ? data.models.map((id) => ({ id, provider: 'unorouter' })) : [];
}

// Generate Video — daftar model video & status provider.
export async function fetchVideoModels() {
  return edgeRequest('/video/models', {});
}

// Generate Video — kirim tugas generasi video asinkron.
export async function generateVideo(payload) {
  return edgeRequest('/video/generate', payload);
}

// Generate Video — periksa status job video.
export async function fetchVideoStatus(id) {
  return edgeRequest('/video/status', { id });
}

// Generate Video — ambil riwayat generasi milik pengguna dengan URL putar bertanda tangan.
export async function fetchVideoHistory() {
  return edgeRequest('/video/history', {});
}

export async function chatCompletion({ conversationId, model, provider, messages, github, repository, autoFallback = true }) {
  return edgeRequest('/chat', { conversationId, model, provider, messages, github, repository, autoFallback });
}

// AI Studio — repo terhubung (GitHub) untuk panel koneksi di bawah input.
export async function fetchConnectedRepos() {
  const { data } = await edgeRequest('/repos', {});
  return Array.isArray(data?.repos) ? data.repos : [];
}

// AI Studio agen mode — akses internet: pencarian web melalui worker (server-side).
export async function webSearch(query) {
  const { data } = await edgeRequest('/search', { query });
  return Array.isArray(data?.results) ? data.results : [];
}

// GitHub OAuth — mulai alur otorisasi (real).
export async function githubStart() {
  return edgeRequest('/auth/github/start', {});
}

// GitHub OAuth — status koneksi + identitas akun.
export async function githubStatus() {
  const { data } = await edgeRequest('/github/status', {});
  return data;
}

// GitHub OAuth — putus koneksi.
export async function githubLogout() {
  return edgeRequest('/auth/github/logout', {});
}

// Alat agen GitHub (real): read/write/delete/commit/push/pr/pr_merge/deploy.
export async function githubTool(name, args = {}) {
  const { data } = await edgeRequest(`/github/tools/${name}`, {
    ...args,
  });
  return data;
}

export async function verifyKey({ provider = 'unorouter', apiKey, baseUrl }) {
  return edgeRequest('/verify', { provider, apiKey, baseUrl });
}
