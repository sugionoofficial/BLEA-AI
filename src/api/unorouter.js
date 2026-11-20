import { EDGE_BASE, PUBLISHABLE_KEY, edgeRequest, getAccessToken } from './client';

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

export async function chatCompletion({ conversationId, model, provider, messages, github, repository, autoFallback = true }) {
  return edgeRequest('/chat', { conversationId, model, provider, messages, github, repository, autoFallback });
}

export async function chatCompletionStream({
  conversationId,
  model,
  provider,
  messages,
  github,
  repository,
  autoFallback = true,
  research = true,
  signal,
  onMeta,
  onThinking,
  onDelta,
}) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, status: 401, data: { error: 'authentication required' } };
  }
  try {
    const res = await fetch(`${EDGE_BASE}/chat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: PUBLISHABLE_KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        conversationId,
        model,
        provider,
        messages,
        github,
        repository,
        autoFallback,
        research,
        stream: true,
      }),
      signal,
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
      if (!contentType.includes('application/json') && !contentType.includes('text/event-stream')) {
        return {
          ok: false,
          status: res.status,
          workerUnavailable: true,
          data: { error: 'API worker belum aktif pada pratinjau lokal ini.' },
        };
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.reply) {
        onMeta?.({ model: data.model || model, provider: data.provider || provider, fallbackFrom: data.fallbackFrom, fallbackReason: data.fallbackReason });
        onDelta?.(data.reply);
      }
      return { ok: res.ok, status: res.status, data };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalDone = null;
    let assembledReply = '';
    let assembledReasoning = '';
    let meta = { model, provider };
    let streamError = '';

    const handleLines = (lines) => {
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        let ev = null;
        try { ev = JSON.parse(jsonStr); } catch {}
        if (!ev) continue;
        if (ev.type === 'meta') {
          meta = { ...meta, ...ev };
          onMeta?.(ev);
        } else if (ev.type === 'thinking' && ev.text) {
          assembledReasoning += ev.text;
          onThinking?.(ev.text);
        } else if (ev.type === 'delta' && ev.text) {
          assembledReply += ev.text;
          onDelta?.(ev.text);
        } else if (ev.type === 'done') {
          finalDone = ev;
        } else if (ev.type === 'error') {
          streamError = ev.error || 'Streaming gagal.';
        }
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          if (buffer.trim()) handleLines(buffer.split(/\r?\n/));
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() || '';
        handleLines(parts);
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (streamError && !assembledReply && !finalDone?.reply) {
      return { ok: false, status: 502, data: { error: streamError } };
    }

    return {
      ok: true,
      status: 200,
      data: finalDone || {
        ok: true,
        reply: assembledReply || assembledReasoning,
        reasoning: assembledReasoning,
        model: meta.model,
        provider: meta.provider,
        fallbackFrom: meta.fallbackFrom,
        fallbackReason: meta.fallbackReason,
      },
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, status: 0, aborted: true, data: { error: 'Dihentikan oleh pengguna.' } };
    }
    return {
      ok: false,
      status: 0,
      workerUnavailable: true,
      data: { error: String(error?.message || error) },
    };
  }
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

// Admin panel — sisa kuota/saldo API key provider (server-side; admin only).
export async function fetchProviderQuota(provider) {
  return edgeRequest('/provider-quota', { provider });
}

export async function verifyKey({ provider = 'unorouter', apiKey, baseUrl }) {
  return edgeRequest('/verify', { provider, apiKey, baseUrl });
}
