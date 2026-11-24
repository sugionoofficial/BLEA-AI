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

// ---- Pool akun OpenAI (admin) ----
export async function fetchOpenAiAccounts() {
  return request('/openai-accounts', { tool: '' });
}
export async function createOpenAiAccount(payload) {
  return request('/openai-accounts', { method: 'POST', body: payload, tool: '' });
}
export async function updateOpenAiAccount(payload) {
  return request('/openai-accounts', { method: 'PATCH', body: payload, tool: '' });
}
export async function deleteOpenAiAccount(id) {
  return request('/openai-accounts', { method: 'DELETE', body: { id }, tool: '' });
}
export async function testOpenAiAccount(id) {
  return request('/openai-accounts/test', { method: 'POST', body: { id }, tool: '' });
}

// ---- Model OpenAI untuk Studio ----
// Studio memakai model OpenAI (pool akun manual), bukan katalog provider yang
// terdaftar di Admin Panel. Endpoint ini terpisah dari /api/enabled-models
// supaya keduanya tidak saling mengubah.
export async function fetchStudioModels({ capability = 'chat' } = {}) {
  return request('/studio/models', { method: 'POST', body: { capability }, tool: '' });
}

export async function pingStudioModels() {
  return request('/studio/ping', { method: 'POST', body: {}, tool: '' });
}

// ---- Generasi media lewat pool akun OpenAI ----
export async function fetchStudioImageConfig() {
  return request('/studio/image/config', { method: 'POST', body: {} });
}
export async function generateStudioImage(payload) {
  return request('/studio/image/generate', { method: 'POST', body: payload });
}
export async function fetchStudioVideoConfig() {
  return request('/studio/video/config', { method: 'POST', body: {} });
}
export async function generateStudioVideo(payload) {
  return request('/studio/video/generate', { method: 'POST', body: payload });
}
export async function fetchStudioVideoStatus(id) {
  return request('/studio/video/status', { method: 'POST', body: { id } });
}
