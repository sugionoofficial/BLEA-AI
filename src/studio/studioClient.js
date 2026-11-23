import { getAccessToken } from '../api/client';

// Header ini dipakai Worker untuk menegakkan isolasi tool: ruang /studio/image
// tidak boleh memanggil API video, dan sebaliknya. Bila tool tidak diketahui,
// header tidak dikirim (perilaku lama tetap jalan) — lebih baik daripada
// memalsukan ruang yang tidak ada.
export const STUDIO_TOOL_HEADER = 'x-blea-studio-tool';

export function currentStudioTool() {
  if (typeof window === 'undefined') return '';
  const match = /^\/studio\/([a-z0-9-]+)/i.exec(window.location.pathname || '');
  if (!match) return '';
  const id = match[1].toLowerCase();
  // /studio/connection, /studio/library bukan tool, tapi keduanya tetap
  // punya kapabilitas sendiri di peta tool.
  return id === 'connection' ? 'connect-ai' : id;
}

async function request(path, { method = 'GET', body, tool } = {}) {
  const token = await getAccessToken();
  const toolId = tool === undefined ? currentStudioTool() : tool;
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (toolId) headers[STUDIO_TOOL_HEADER] = toolId;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
    });
  } catch (error) {
    return { ok: false, status: 0, data: { error: String(error?.message || error) } };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- Hasil & unduhan (halaman /studio/library) ----
export async function fetchLibrary({ tool = 'all', limit = 40 } = {}) {
  return request('/library', { method: 'POST', body: { tool, limit } });
}

// ---- Pool akun ChatGPT/OpenAI (admin) ----
export async function fetchChatGptAccounts() {
  return request('/chatgpt-accounts', { tool: '' });
}
export async function createChatGptAccount(payload) {
  return request('/chatgpt-accounts', { method: 'POST', body: payload, tool: '' });
}
export async function updateChatGptAccount(payload) {
  return request('/chatgpt-accounts', { method: 'PATCH', body: payload, tool: '' });
}
export async function deleteChatGptAccount(id) {
  return request('/chatgpt-accounts', { method: 'DELETE', body: { id }, tool: '' });
}
export async function testChatGptAccount(id) {
  return request('/chatgpt-accounts/test', { method: 'POST', body: { id }, tool: '' });
}
