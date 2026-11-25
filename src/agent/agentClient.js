import { getAccessToken } from '../api/client';

// Reads the /api/agent SSE stream. Kept separate from api/unorouter.js because
// the event vocabulary differs (steps + skill activations) and mixing the two
// would make chatStream.js depend on agent-only concepts.
export const AGENT_ENDPOINT = '/api/agent';

// Ruang Studio yang membuka giliran agen. Worker memakainya untuk membatasi
// alat agen (ruang riset ≠ ruang klip) dan menolak kapabilitas di luar tool.
function studioToolHeader() {
  if (typeof window === 'undefined') return {};
  const match = /^\/studio\/([a-z0-9-]+)/i.exec(window.location.pathname || '');
  if (!match) return {};
  return { 'x-blea-studio-tool': match[1].toLowerCase() };
}

/**
 * @returns {Promise<{ok:boolean, status:number, data:object}>} resolves when the
 *   stream closes. Errors are returned, never thrown, so the page can render
 *   them inline.
 */
export async function runAgentTurn({
  messages,
  model,
  provider,
  skill = '',
  resource = '',
  blueprint = '',
  attachments = [],
  videoAnalysis = null,
  videoTranscript = null,
  browserMode = false,
  signal,
  onMeta,
  onStep,
  onSkill,
  onClips,
  onDelta,
  onDone,
}) {
  const token = await getAccessToken();
  if (!token) return { ok: false, status: 401, data: { error: 'Sesi berakhir. Masuk ulang untuk melanjutkan.' } };

  let response;
  try {
    response = await fetch(AGENT_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...studioToolHeader() },
      body: JSON.stringify({ messages, model, provider, skill, resource, blueprint, attachments, videoAnalysis, videoTranscript, browserMode }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, status: 0, aborted: true, data: {} };
    return { ok: false, status: 0, data: { error: 'Tidak bisa menghubungi server agen. Periksa koneksi lalu coba lagi.' } };
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
    const data = await response.json().catch(() => ({}));
    return {
      ok: false,
      status: response.status,
      data: { error: data?.error || `Server membalas HTTP ${response.status}.` },
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  let streamError = '';

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (event.type === 'meta') onMeta?.(event);
    else if (event.type === 'step') onStep?.(event);
    else if (event.type === 'skill') onSkill?.(event);
    else if (event.type === 'clips') onClips?.(event);
    else if (event.type === 'delta' && event.text) onDelta?.(event.text);
    else if (event.type === 'done') done = event;
    else if (event.type === 'error') streamError = event.error || 'Agen gagal menyelesaikan giliran ini.';
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer.trim()) buffer.split(/\r?\n/).forEach(handleLine);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      parts.forEach(handleLine);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      return { ok: false, status: 0, aborted: true, data: { error: 'Dihentikan.' } };
    }
    return { ok: false, status: 0, data: { error: String(error?.message || error) } };
  }

  if (streamError) return { ok: false, status: 200, data: { error: streamError } };
  if (done) {
    onDone?.(done);
    return { ok: true, status: 200, data: done };
  }
  return { ok: false, status: 200, data: { error: 'Stream berakhir tanpa jawaban final.' } };
}

export async function fetchAgentSkills() {
  const token = await getAccessToken();
  try {
    const response = await fetch('/api/agent/skills', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data };
  } catch (error) {
    return { ok: false, data: { error: String(error?.message || error) } };
  }
}
