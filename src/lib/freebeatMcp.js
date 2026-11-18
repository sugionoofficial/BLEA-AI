// Admin-only Freebeat MCP diagnostics. Only balance and image catalog discovery are exposed.
import { siteBalance } from './freebeatSiteBalance.js';
const ENDPOINT = 'https://freebeat.ai/api/mcp';
const READ_SCOPE = 'freebeat:read';
const REGISTER = 'https://freebeat.ai/oauth/register';
const AUTH = 'https://freebeat.ai/oauth/authorize';
const TOKEN = 'https://freebeat.ai/oauth/token';
const REVOKE = 'https://freebeat.ai/oauth/revoke';
const PENDING = '__Host-blea_freebeat_pending';
const SESSION = '__Host-blea_freebeat_session';
const encoder = new TextEncoder();

function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(value) { const s = value.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(s + '='.repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0)); }
function random() { return b64(crypto.getRandomValues(new Uint8Array(32))); }
function fail(message, status = 502) { return Object.assign(new Error(message), { status }); }
function redirectUri(env) {
  const uri = env.FREEBEAT_OAUTH_REDIRECT_URI || 'https://blea-ai.blea-ai.workers.dev/api/freebeat/callback';
  let url; try { url = new URL(uri); } catch { throw fail('FREEBEAT_OAUTH_REDIRECT_URI tidak valid.', 503); }
  if (url.protocol !== 'https:' || url.pathname !== '/api/freebeat/callback' || url.search || url.hash || url.username || url.password) throw fail('Callback Freebeat harus HTTPS dan menggunakan path /api/freebeat/callback.', 503);
  return url.toString();
}
async function key(env) {
  const secret = String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!secret) throw fail('Secret PROVIDER_CREDENTIAL_ENCRYPTION_KEY belum tersedia pada Worker.', 503);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`blea-freebeat-mcp-v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(value, env, purpose) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, await key(env), encoder.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(ciphertext)}`;
}
async function unseal(value, env, purpose) {
  try {
    const parts = String(value || '').split('.');
    if (parts.length !== 2 || value.length > 3800) return null;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(parts[0]), additionalData: encoder.encode(purpose) }, await key(env), unb64(parts[1]));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch { return null; }
}
function cookieValue(request, name) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
function cookie(name, value, age) { return `${name}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`; }
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
// Expose only fixed diagnostic codes; never expose provider bodies, OAuth codes or tokens.
function oauthFailure(stage, kind, status, registrationError = null) {
  const tag = `[FB-${stage.toUpperCase()}-${kind.toUpperCase()}]`;
  const message = kind === 'timeout' ? 'Freebeat tidak merespons dalam 15 detik.'
    : kind === 'network' ? 'Worker tidak dapat terhubung ke Freebeat.'
      : kind === 'redirect' ? 'Freebeat mengirim pengalihan yang tidak didukung atau tidak aman.'
        : kind === 'http' ? `Freebeat menolak permintaan (HTTP ${status}).`
          : 'Freebeat mengirim respons yang bukan JSON yang valid.';
  const details = registrationError ? ` Kode OAuth: ${registrationError.code}.${registrationError.loopback ? ' Freebeat menyebut callback localhost/loopback.' : ''}` : '';
  console.warn('Freebeat OAuth request failed', { stage, kind, ...(Number.isInteger(status) ? { status } : {}), ...(registrationError ? { oauthCode: registrationError.code, loopback: registrationError.loopback } : {}) });
  return Object.assign(fail(`${message} ${tag}${details}`), { freebeatKind: kind });
}

// Read a small registration error body only; never return or log its raw contents.
async function registrationErrorDetails(res) {
  if (!res.body || !(res.headers.get('content-type') || '').toLowerCase().includes('json')) return null;
  const maxBytes = 16384;
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) return null;
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const text = chunks.map((part) => new TextDecoder().decode(part)).join('');
    const data = JSON.parse(text);
    const allowed = ['invalid_redirect_uri', 'invalid_client_metadata', 'invalid_scope', 'invalid_request', 'unauthorized_client', 'access_denied', 'unsupported_grant_type', 'registration_not_supported'];
    if (!data || typeof data !== 'object' || !allowed.includes(data.error)) return null;
    const description = typeof data.error_description === 'string' ? data.error_description.slice(0, 1000) : '';
    return { code: data.error, loopback: data.error === 'invalid_redirect_uri' && /localhost|loopback|127\.0\.0\.1|\[::1\]/i.test(description) };
  } catch { return null; }
}

async function jsonFetch(url, options, stage) {
  let res;
  let target = url;
  for (let redirects = 0; redirects <= 1; redirects += 1) {
    try { res = await fetch(target, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
    catch (error) { throw oauthFailure(stage, ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network'); }
    if (![301, 302, 303, 307, 308].includes(res.status)) break;
    // Preserve POST and credentials only on 307/308 to the same endpoint with an optional trailing slash.
    // Never forward OAuth tokens or codes to another origin, a different path or query string.
    let next; try { next = new URL(res.headers.get('location'), target); } catch { throw oauthFailure(stage, 'redirect', res.status); }
    const original = new URL(url);
    if (redirects || ![307, 308].includes(res.status) || next.origin !== original.origin || next.pathname.replace(/\/$/, '') !== original.pathname.replace(/\/$/, '') || next.search || next.hash || next.username || next.password) throw oauthFailure(stage, 'redirect', res.status);
    target = next.toString();
  }
  if (!res.ok) {
    const details = stage === 'register' && res.status === 400 ? await registrationErrorDetails(res) : null;
    throw oauthFailure(stage, 'http', res.status, details);
  }
  let data;
  try { data = await res.json(); }
  catch (error) { throw oauthFailure(stage, ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'response', res.status); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw oauthFailure(stage, 'response', res.status);
  return data;
}

export async function startFreebeat(env, userId) {
  await key(env);
  const redirect = redirectUri(env);
  // Freebeat accepted this combination in a live registration test. Requesting
  // the refresh grant does not mean we retain or use any returned refresh token.
  const registration = await jsonFetch(REGISTER, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: 'BLEA AI (uji MCP)', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: READ_SCOPE }) }, 'register');
  if (typeof registration.client_id !== 'string' || !registration.client_id || registration.client_id.length > 500) throw fail('Registrasi klien Freebeat tidak mengembalikan client ID yang valid.');
  const state = random(), verifier = random();
  const challenge = b64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const sealed = await seal({ uid: userId, clientId: registration.client_id, state, verifier, redirect, created: Date.now() }, env, 'pending');
  if (sealed.length > 3800) throw fail('Data sesi Freebeat terlalu besar.', 503);
  const auth = new URL(AUTH);
  for (const [name, value] of Object.entries({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', scope: READ_SCOPE, resource: ENDPOINT })) auth.searchParams.set(name, value);
  return response({ url: auth.toString() }, 200, { 'set-cookie': cookie(PENDING, sealed, 600) });
}

export async function freebeatCallback(request, env) {
  const url = new URL(request.url);
  let destination;
  try { destination = new URL('/admin/freebeat', redirectUri(env)).toString(); }
  catch { return response({ error: 'Konfigurasi callback Freebeat tidak valid.' }, 503); }
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie(PENDING, '', 0) });
  const finish = (result) => { headers.set('location', `${destination}?freebeat=${result}`); return new Response(null, { status: 303, headers }); };
  try {
    const pending = await unseal(cookieValue(request, PENDING), env, 'pending');
    if (!pending || !pending.uid || !pending.verifier || !pending.clientId || pending.redirect !== redirectUri(env) || !Number.isFinite(pending.created) || Date.now() - pending.created > 600000 || pending.created > Date.now() + 30000 || !url.searchParams.get('state') || url.searchParams.get('state') !== pending.state) return finish('invalid');
    if (url.searchParams.get('error')) return finish('denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4000) return finish('invalid');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.clientId, code, redirect_uri: pending.redirect, code_verifier: pending.verifier, resource: ENDPOINT });
    const tokens = await jsonFetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }, 'token');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 2000 || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) return finish('failed');
    const lifetime = Math.min(3600, Number(tokens.expires_in) || 300);
    if (lifetime < 1) return finish('failed');
    const encrypted = await seal({ uid: pending.uid, accessToken: tokens.access_token, clientId: pending.clientId, expiresAt: Date.now() + lifetime * 1000 }, env, 'session');
    if (encrypted.length > 3800) return finish('failed');
    headers.append('set-cookie', cookie(SESSION, encrypted, Math.floor(lifetime)));
    return finish('connected');
  } catch (error) {
    const kind = error?.freebeatKind;
    return finish(['network', 'timeout', 'redirect', 'http', 'response'].includes(kind) ? `failed-${kind}` : 'failed');
  }
}

async function readSession(request, env, userId) {
  const session = await unseal(cookieValue(request, SESSION), env, 'session');
  return session && session.uid === userId && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now() && typeof session.accessToken === 'string' ? session : null;
}

// Codes and log fields are fixed; never expose errors, response bodies, headers, URLs or tokens from Freebeat.
function mcpFailure(stage, kind, status) {
  const tag = `[FB-MCP-${stage.toUpperCase()}-${kind.toUpperCase()}]`;
  const message = kind === 'timeout' ? 'MCP Freebeat tidak merespons dalam 15 detik.'
    : kind === 'network' ? 'Worker tidak dapat terhubung ke MCP Freebeat.'
      : kind === 'redirect' ? 'MCP Freebeat mengirim pengalihan yang ditolak demi keamanan.'
        : kind === 'http' && (status === 401 || status === 403) ? 'Freebeat menolak akses. Hubungkan ulang atau periksa akses akun/plan.'
          : kind === 'http' ? `MCP Freebeat menolak permintaan (HTTP ${status}).`
            : kind === 'size' ? 'Respons MCP Freebeat terlalu besar.'
              : kind === 'rpc' ? 'Freebeat menolak atau tidak mendukung permintaan MCP.'
                : 'Respons MCP Freebeat tidak valid atau tidak didukung.';
  console.warn('Freebeat MCP request failed', { stage, kind, ...(Number.isInteger(status) ? { status } : {}) });
  return Object.assign(fail(`${message} ${tag}`, kind === 'http' && status === 401 ? 401 : 502), { isMcpFailure: true });
}

function rpcObject(text, expectedId, stage) {
  let object;
  try { object = JSON.parse(text); } catch { return null; }
  if (!object || typeof object !== 'object' || Array.isArray(object) || object.id !== expectedId) return null;
  if (object.error || !object.result || typeof object.result !== 'object' || object.result.isError) throw mcpFailure(stage, 'rpc');
  return object.result;
}

// Bound memory while reading, and stop at the expected SSE response even if the stream stays open.
async function readRpc(res, expectedId, stage, signal, maxBytes = 65536) {
  const type = (res.headers.get('content-type') || '').toLowerCase();
  const isSse = type.includes('text/event-stream');
  if (!isSse && !type.includes('application/json')) throw mcpFailure(stage, 'response');
  const length = res.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) throw mcpFailure(stage, 'size');
  if (!res.body) throw mcpFailure(stage, 'response');
  let reader;
  try { reader = res.body.getReader(); } catch { throw mcpFailure(stage, 'response'); }
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  function parseEvent(event) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    return data ? rpcObject(data, expectedId, stage) : null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        const result = isSse ? parseEvent(text) : rpcObject(text, expectedId, stage);
        if (result) return result;
        throw mcpFailure(stage, 'response');
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw mcpFailure(stage, 'size');
      text += decoder.decode(value, { stream: true });
      if (isSse) {
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(text))) {
          const event = text.slice(0, boundary.index);
          text = text.slice(boundary.index + boundary[0].length);
          const result = parseEvent(event);
          if (result) return result;
        }
      }
    }
  } catch (error) {
    if (error?.isMcpFailure) throw error;
    throw mcpFailure(stage, signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network');
  } finally {
    try { reader.cancel().catch(() => {}); } catch { /* ignore cancellation errors */ }
    reader.releaseLock();
  }
}

async function rpc(accessToken, body, stage, extraHeaders = {}, maxBytes = 65536) {
  const signal = AbortSignal.timeout(15000);
  let res;
  try {
    // Manual mode permits diagnosing redirects without forwarding credentials to their destination.
    res = await fetch(ENDPOINT, { method: 'POST', redirect: 'manual', signal, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders }, body: JSON.stringify(body) });
  } catch (error) { throw mcpFailure(stage, signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network'); }
  if (res.status >= 300 && res.status < 400) {
    try { await res.body?.cancel(); } catch { /* no provider data is exposed */ }
    throw mcpFailure(stage, 'redirect', res.status);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* no provider data is exposed */ }
    throw mcpFailure(stage, 'http', res.status);
  }
  if (body.id === undefined) { try { await res.body?.cancel(); } catch { /* notification response ignored */ } return {}; }
  return { result: await readRpc(res, body.id, stage, signal, maxBytes), sessionId: res.headers.get('mcp-session-id') };
}
async function openMcp(accessToken) {
  const init = await rpc(accessToken, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'blea-ai-readonly-test', version: '1.0.0' } } }, 'init');
  const version = init.result.protocolVersion;
  if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(version)) throw mcpFailure('init', 'response');
  const headers = { 'MCP-Protocol-Version': version, ...(init.sessionId ? { 'Mcp-Session-Id': init.sessionId } : {}) };
  await rpc(accessToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, 'notify', headers);
  return headers;
}
async function getBalance(accessToken) {
  const headers = await openMcp(accessToken);
  const call = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_credit_balance', arguments: {} } }, 'balance', headers);
  const data = call.result.structuredContent ?? call.result.content;
  if (!data) throw mcpFailure('balance', 'response');
  return data;
}

// Only structural metadata for these image tools is returned; provider descriptions,
// examples, URLs, default values and unrelated tools are deliberately omitted.
const IMAGE_TOOLS = new Set(['list_models', 'get_model_help', 'quote_generation', 'generate_image', 'get_task_status']);
const SAFE_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const SAFE_SCHEMA_ENUMS = new Set(['image', 'image_edit', 'generate_image', 'text', 'video']);
function schemaName(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value); }
function imageSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 5) return {};
  const out = {};
  if (SAFE_SCHEMA_TYPES.has(schema.type)) out.type = schema.type;
  if (Array.isArray(schema.required)) out.required = schema.required.filter(schemaName).slice(0, 50);
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => schemaName(name)).slice(0, 50).map(([name, child]) => [name, imageSchema(child, depth + 1)]));
  }
  if (schema.items && typeof schema.items === 'object') out.items = imageSchema(schema.items, depth + 1);
  for (const name of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[name])) out[name] = schema[name].slice(0, 8).map((child) => imageSchema(child, depth + 1));
  if (Array.isArray(schema.enum)) {
    out.known_enum_values = schema.enum.filter((item) => SAFE_SCHEMA_ENUMS.has(item)).slice(0, 5);
    out.enum_incomplete = out.known_enum_values.length !== schema.enum.length;
  }
  return out;
}

async function getImageSchemas(accessToken) {
  const headers = await openMcp(accessToken);
  const tools = new Map();
  const cursors = new Set();
  let cursor;
  let truncated = false;
  for (let page = 0; page < 5; page += 1) {
    const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params: cursor ? { cursor } : {} }, 'inspect', headers, 262144);
    if (!Array.isArray(result.tools)) throw mcpFailure('inspect', 'response');
    for (const tool of result.tools) if (tool && IMAGE_TOOLS.has(tool.name) && !tools.has(tool.name)) tools.set(tool.name, imageSchema(tool.inputSchema));
    if (!result.nextCursor) break;
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw mcpFailure('inspect', 'response');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
    if (page === 4) truncated = true;
  }
  return { tools: Object.fromEntries(tools), truncated };
}

function modelContent(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = Array.isArray(result.content) ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text : null;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function safeModelId(id) {
  return (Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(id));
}
async function getImageModels(accessToken) {
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_models', arguments: { type: 'image' } } }, 'models', headers, 262144);
  const content = modelContent(result);
  const list = Array.isArray(content) ? content : content?.models ?? content?.items ?? content?.data?.models ?? content?.data?.items ?? (Array.isArray(content?.data) ? content.data : null);
  if (!Array.isArray(list)) throw mcpFailure('models', 'response');
  const models = list.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = item.model_id ?? item.modelId ?? item.id;
    const name = item.display_name ?? item.displayName ?? item.name;
    if (!safeModelId(id) || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) return [];
    return [{ model_id: id, name }];
  });
  if (list.length && !models.length) throw mcpFailure('models', 'response');
  return { models, truncated: list.length > 100 };
}

export async function handleFreebeat(request, url, env, user) {
  try {
    if (!user) return response({ error: 'Login diperlukan.' }, 401);
    if (user.app_metadata?.role !== 'admin') return response({ error: 'Koneksi Freebeat hanya untuk admin.' }, 403);
    const action = url.pathname.split('/').pop();
    if (action === 'site-balance' && request.method === 'POST') return await siteBalance(request);
    if (action === 'start' && request.method === 'POST') {
      if (url.origin !== new URL(redirectUri(env)).origin) return response({ error: 'Buka BLEA melalui domain callback Freebeat yang dikonfigurasi sebelum menghubungkan akun.' }, 400);
      return await startFreebeat(env, user.id);
    }
    if (action === 'status' && request.method === 'GET') {
      const session = await readSession(request, env, user.id);
      return response({ connected: Boolean(session), expiresAt: session?.expiresAt || null });
    }
    if (['balance', 'image-schemas', 'image-models'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'balance') return response({ ok: true, balance: await getBalance(session.accessToken) });
      if (action === 'image-schemas') return response({ ok: true, ...(await getImageSchemas(session.accessToken)) });
      return response({ ok: true, ...(await getImageModels(session.accessToken)) });
    }
    if (action === 'disconnect' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      let revoked = false;
      if (session) {
        try { const res = await fetch(REVOKE, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: session.accessToken, client_id: session.clientId }).toString() }); revoked = res.ok; } catch { /* local session is still removed */ }
      }
      return response({ ok: true, revoked }, 200, { 'set-cookie': cookie(SESSION, '', 0) });
    }
    return response({ error: 'Aksi Freebeat tidak dikenal.' }, 404);
  } catch (error) { return response({ error: error?.message || 'Koneksi Freebeat gagal.' }, error?.status || 502); }
}
