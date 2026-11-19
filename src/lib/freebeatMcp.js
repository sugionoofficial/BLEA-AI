// Admin-only Freebeat MCP diagnostics and explicitly approved generation tests.
import { boundedJson } from './boundedJson.js';
import { FREEBEAT_VIDEO_TEST, FREEBEAT_GEMINI_DIAGNOSTIC, videoHeadroom } from './freebeatVideoTestSettings.js';
const ENDPOINT = 'https://freebeat.ai/api/mcp';
const READ_SCOPE = 'freebeat:read';
const IMAGE_SCOPE = 'freebeat:generate';
const REGISTER = 'https://freebeat.ai/oauth/register';
const AUTH = 'https://freebeat.ai/oauth/authorize';
const TOKEN = 'https://freebeat.ai/oauth/token';
const REVOKE = 'https://freebeat.ai/oauth/revoke';
// Undocumented web-app gateway. Used only by the operator's explicit
// gateway probe: a free GET first, then a paid create call that stays disabled
// unless FREEBEAT_ALLOW_PROXY_CREATE=1 is set. The MCP path remains the only
// sanctioned generation route.
const PROXY_BASE = 'https://freebeat.ai/api/proxy/v1';
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
async function unseal(value, env, purpose, maxLength = 3800) {
  try {
    const parts = String(value || '').split('.');
    if (parts.length !== 2 || value.length > maxLength) return null;
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
  const requestedScope = `${READ_SCOPE} ${IMAGE_SCOPE}`;
  // Freebeat accepted this combination in a live registration test. Requesting
  // the refresh grant does not mean we retain or use any returned refresh token.
  const registration = await jsonFetch(REGISTER, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: 'BLEA AI (uji MCP)', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: requestedScope }) }, 'register');
  if (typeof registration.client_id !== 'string' || !registration.client_id || registration.client_id.length > 500) throw fail('Registrasi klien Freebeat tidak mengembalikan client ID yang valid.');
  const state = random(), verifier = random();
  const challenge = b64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const sealed = await seal({ uid: userId, clientId: registration.client_id, state, verifier, redirect, requestedScope, created: Date.now() }, env, 'pending');
  if (sealed.length > 3800) throw fail('Data sesi Freebeat terlalu besar.', 503);
  const auth = new URL(AUTH);
  for (const [name, value] of Object.entries({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', scope: requestedScope, resource: ENDPOINT })) auth.searchParams.set(name, value);
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
    const requestedScope = pending.requestedScope || READ_SCOPE; // Pending sessions created before this change were read-only.
    if (![READ_SCOPE, `${READ_SCOPE} ${IMAGE_SCOPE}`].includes(requestedScope)) return finish('invalid');
    if (url.searchParams.get('error')) return finish('denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4000) return finish('invalid');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.clientId, code, redirect_uri: pending.redirect, code_verifier: pending.verifier, resource: ENDPOINT });
    const tokens = await jsonFetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }, 'token');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 2000 || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) return finish('failed');
    // RFC 6749: omitted scope means the granted scope matches what was requested.
    const grantedScope = tokens.scope === undefined ? requestedScope : tokens.scope;
    if (typeof grantedScope !== 'string' || grantedScope.length > 1000) return finish('failed');
    const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
    if (!granted.has(READ_SCOPE)) return finish('failed');
    const imageAccess = requestedScope.includes(IMAGE_SCOPE) && granted.has(IMAGE_SCOPE);
    const lifetime = Math.min(3600, Number(tokens.expires_in) || 300);
    if (lifetime < 1) return finish('failed');
    const encrypted = await seal({ uid: pending.uid, sid: crypto.randomUUID(), accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null, clientId: pending.clientId, imageAccess, expiresAt: Date.now() + lifetime * 1000 }, env, 'session');
    if (encrypted.length > 3800) return finish('failed');
    headers.append('set-cookie', cookie(SESSION, encrypted, Math.floor(lifetime)));
    return finish(requestedScope.includes(IMAGE_SCOPE) && !imageAccess ? 'connected-limited' : 'connected');
  } catch (error) {
    const kind = error?.freebeatKind;
    return finish(['network', 'timeout', 'redirect', 'http', 'response'].includes(kind) ? `failed-${kind}` : 'failed');
  }
}

const REFRESH_WINDOW = 10 * 60 * 1000;
const sessionCookies = new WeakMap();
async function renewSession(session, env) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource: ENDPOINT });
  const tokens = await jsonFetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }, 'token');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 2000 || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) return null;
  const lifetime = Math.min(3600, Number(tokens.expires_in) || 300);
  if (lifetime < 1) return null;
  return { ...session, accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : session.refreshToken, expiresAt: Date.now() + lifetime * 1000 };
}
async function readSession(request, env, userId) {
  const session = await unseal(cookieValue(request, SESSION), env, 'session');
  if (!session || session.uid !== userId || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now() || typeof session.accessToken !== 'string') return null;
  if (session.expiresAt - Date.now() > REFRESH_WINDOW || !session.refreshToken) return session;
  // Silent renewal keeps ONE Freebeat connection (and therefore one provider
  // API key) alive instead of pushing admins through consent again every hour.
  // A failed renewal must NEVER drop a still-valid session: Freebeat's token
  // endpoint can refuse or time out while the current access token keeps
  // working until its own expiry. Worst case we retry on the next request.
  try {
    const renewed = await renewSession(session, env);
    if (!renewed) return session;
    const encrypted = await seal({ uid: renewed.uid, sid: renewed.sid || crypto.randomUUID(), accessToken: renewed.accessToken, refreshToken: renewed.refreshToken, clientId: renewed.clientId, imageAccess: renewed.imageAccess, expiresAt: renewed.expiresAt }, env, 'session');
    if (encrypted.length > 3800) return session;
    sessionCookies.set(request, cookie(SESSION, encrypted, Math.max(60, Math.floor((renewed.expiresAt - Date.now()) / 1000))));
    return renewed;
  } catch {
    return session;
  }
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

function rpcObject(text, expectedId, stage, captureToolError = false) {
  let object;
  try { object = JSON.parse(text); } catch { return null; }
  if (!object || typeof object !== 'object' || Array.isArray(object) || object.id !== expectedId) return null;
  if (object.error) {
    if (captureToolError) return { isError: true, error: object.error };
    throw mcpFailure(stage, 'rpc');
  }
  if (!object.result || typeof object.result !== 'object' || (object.result.isError && !captureToolError)) throw mcpFailure(stage, 'rpc');
  return object.result;
}

// Bound memory while reading, and stop at the expected SSE response even if the stream stays open.
async function readRpc(res, expectedId, stage, signal, maxBytes = 65536, captureToolError = false) {
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
    return data ? rpcObject(data, expectedId, stage, captureToolError) : null;
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        const result = isSse ? parseEvent(text) : rpcObject(text, expectedId, stage, captureToolError);
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

async function rpc(accessToken, body, stage, extraHeaders = {}, maxBytes = 65536, captureToolError = false) {
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
  return { result: await readRpc(res, body.id, stage, signal, maxBytes, captureToolError), sessionId: res.headers.get('mcp-session-id') };
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
const VIDEO_TOOLS = new Set(['list_models', 'get_model_help', 'quote_generation', 'generate_video', 'get_task_status']);
const SAFE_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const SAFE_SCHEMA_ENUMS = new Set(['image', 'image_edit', 'generate_image', 'generate_video', 'text', 'video', 'transition', 'reference']);
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
    out.known_enum_values = schema.enum.filter((item) => SAFE_SCHEMA_ENUMS.has(item)).slice(0, 20);
    out.enum_incomplete = out.known_enum_values.length !== schema.enum.length;
  }
  return out;
}

async function getToolSchemas(accessToken, allowedTools) {
  const headers = await openMcp(accessToken);
  const tools = new Map();
  const cursors = new Set();
  let cursor;
  let truncated = false;
  for (let page = 0; page < 5; page += 1) {
    const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params: cursor ? { cursor } : {} }, 'inspect', headers, 262144);
    if (!Array.isArray(result.tools)) throw mcpFailure('inspect', 'response');
    for (const tool of result.tools) if (tool && allowedTools.has(tool.name) && !tools.has(tool.name)) tools.set(tool.name, imageSchema(tool.inputSchema));
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
async function getModels(accessToken, type) {
  if (!['image', 'video'].includes(type)) throw mcpFailure('models', 'response');
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_models', arguments: { type } } }, 'models', headers, 262144);
  const content = modelContent(result);
  const list = Array.isArray(content) ? content : content?.models ?? content?.items ?? content?.data?.models ?? content?.data?.items ?? (Array.isArray(content?.data) ? content.data : null);
  if (!Array.isArray(list)) throw mcpFailure('models', 'response');
  const models = list.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = item.model_id ?? item.modelId ?? item.id;
    const name = item.display_name ?? item.displayName ?? item.name;
    if (!safeModelId(id) || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) return [];
    // The web client dispatches with the model slug as well as the numeric id.
    const slug = [item.model, item.model_slug, item.slug].find((v) => typeof v === 'string' && /^[a-z0-9._-]{1,60}$/i.test(v));
    return [{ model_id: id, name, model_slug: slug || '', member_only: item.member_only === true, available: item.available !== false }];
  });
  if (list.length && !models.length) throw mcpFailure('models', 'response');
  return { models, truncated: list.length > 100 };
}

const QUOTE_SAFE_TEXT = new Set(['generate_image', 'image', 'available', 'unavailable', 'unknown', 'known', 'exact', 'estimated', 'credits', 'credit', 'success', 'error']);
// Fixed vocabulary only, and only in a status field. These are diagnostic
// values, not a provider contract or a classification that authorizes spending.
const QUOTE_SAFE_STATUS = new Set(['ok', 'ready', 'quoted', 'priced', 'price_available', 'quote_available', 'success', 'successful', 'succeeded', 'available', 'unavailable', 'unknown', 'error', 'failed', 'failure', 'pending', 'estimated', 'exact', 'not_available', 'not_supported', 'unsupported', 'not_found', 'no_quote', 'unquotable', 'insufficient_credits']);
const QUOTE_PRIVATE_KEY = /(^id$|user|account|session|secret|token|credential|authorization|cookie|prompt|client|email|url|uri|task|batch)/i;
function safeQuote(value, depth = 0, field = '') {
  if (depth > 5) return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (field === 'status' && QUOTE_SAFE_STATUS.has(value.toLowerCase())) return value.toLowerCase();
    if (QUOTE_SAFE_TEXT.has(value) || (/^-?\d{1,12}(\.\d{1,6})?$/.test(value))) return value;
    return '[teks disembunyikan]';
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeQuote(item, depth + 1));
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).filter(([name]) => schemaName(name) && !QUOTE_PRIVATE_KEY.test(name)).slice(0, 50).map(([name, child]) => [name, safeQuote(child, depth + 1, name)]));
}
async function rawImageQuote(accessToken, input) {
  const headers = await openMcp(accessToken);
  const parameters = { model_id: input.model_id, prompt: input.prompt };
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote_generation', arguments: { tool: 'generate_image', parameters } } }, 'quote', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('quote', 'response');
  return content;
}
async function quoteImage(accessToken, input) {
  return safeQuote(await rawImageQuote(accessToken, input));
}

// Diagnostics only: reveal a small vocabulary of model options, never raw
// provider messages, prompts, URLs or credentials. Unknown values stay hidden.
const VIDEO_HELP_WORDS = new Set(['video', 'image', 'text', 'transition', 'reference', '720p', '1080p', '480p', '360p', '4k', '2k', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'standard', 'pro', 'fast', 'default', 'auto']);
function safeVideoHelp(value, depth = 0, field = '') {
  if (depth > 5) return null;
  if (typeof value === 'string' && VIDEO_HELP_WORDS.has(value.toLowerCase())) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeVideoHelp(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => schemaName(name) && !QUOTE_PRIVATE_KEY.test(name)).slice(0, 50).map(([name, child]) => [name, safeVideoHelp(child, depth + 1, name)]));
  return safeQuote(value, depth, field);
}
async function videoDiagnostic(accessToken, action, input, raw = false, settings = FREEBEAT_VIDEO_TEST) {
  const headers = await openMcp(accessToken);
  const params = action === 'video-help'
    ? { name: 'get_model_help', arguments: { type: 'video', model_id: settings.model_id } }
    : { name: 'quote_generation', arguments: { tool: 'generate_video', parameters: { ...settings, prompt: input.prompt, images: [input.image_url] } } };
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params }, action === 'video-help' ? 'help' : 'quote', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure(action === 'video-help' ? 'help' : 'quote', 'response');
  return raw ? content : action === 'video-help' ? safeVideoHelp(content) : safeQuote(content);
}
async function parseVideoQuote(request) {
  return validateVideoInput(await imageJson(request));
}
function optionalDuration(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 600) throw fail('Durasi harus berupa angka detik antara 1 dan 600.', 400);
  return value;
}
function optionalResolution(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !HELP_RESOLUTION.test(value.trim())) throw fail('Resolusi tidak valid (contoh: 480p, 768p, 1080p).', 400);
  return value.trim().toLowerCase();
}
async function parseVideoPrepare(request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['model_id', 'prompt', 'image_url', 'duration', 'resolution'].includes(key)) || !Number.isSafeInteger(input.model_id) || input.model_id < 0) throw fail('Pilih ID model video yang valid.', 400);
  return { model_id: input.model_id, duration: optionalDuration(input.duration), resolution: optionalResolution(input.resolution), ...validateVideoInput({ prompt: input.prompt, image_url: input.image_url }) };
}
function videoSettings(modelId) { return { ...FREEBEAT_VIDEO_TEST, model_id: modelId }; }

// --- Capability normalization -------------------------------------------------
// Freebeat rejects generate_video items whose settings the model does not
// support, without a usable reason (0 accepted credits). get_model_help exposes
// the supported durations/resolutions/generation types; align the fixed test
// settings to them BEFORE quoting so the quote, the approval and the dispatch
// all carry values the model accepts. Unknown help => keep current settings.
const HELP_RESOLUTION = /^(360p|480p|720p|768p|1080p|2k|4k)$/i;
const HELP_PAIR = /^(\d{3,4}p|2k|4k)\|(\d{1,3})$/i; // price-map keys like "480p|5"
function collectHelpOptions(help) {
  const durations = new Set();
  const resolutions = new Set();
  const generations = new Set();
  function notePair(name) {
    const pair = HELP_PAIR.exec(name);
    if (pair) { resolutions.add(pair[1].toLowerCase()); durations.add(Number(pair[2])); }
  }
  function walk(value, key = '', depth = 0) {
    if (depth > 8 || value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value > 0 && value <= 600 && /duration|second|secs|length/i.test(key)) durations.add(value);
      return;
    }
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (HELP_RESOLUTION.test(v)) resolutions.add(v);
      notePair(v);
      return;
    }
    if (Array.isArray(value)) { value.slice(0, 200).forEach((item) => walk(item, key, depth + 1)); return; }
    if (typeof value === 'object') {
      // Help entries name their modes like "image-to-video"; map them to the
      // generate_video generation_type enum (text|image|transition|reference).
      if (typeof value.generation_type === 'number' && typeof value.generation_name === 'string') {
        const mapped = { 'image-to-video': 'image', 'text-to-video': 'text', 'first/last-frame transition': 'transition', 'reference-to-video': 'reference' }[value.generation_name.toLowerCase()];
        if (mapped) generations.add(mapped);
      }
      for (const [name, child] of Object.entries(value).slice(0, 200)) {
        notePair(name);
        const low = name.toLowerCase();
        // Price maps key their entries by resolution ("768p": 13) or by
        // resolution|duration pairs ("480p|5": 27); capture both shapes.
        if (HELP_RESOLUTION.test(low)) resolutions.add(low);
        walk(child, `${key}${key ? '.' : ''}${low}`, depth + 1);
      }
    }
  }
  walk(help);
  return {
    durations: [...durations].sort((a, b) => a - b),
    resolutions: [...resolutions],
    generations: [...generations],
  };
}
function normalizeVideoSettings(help, settings, hasImage) {
  const options = collectHelpOptions(help);
  const adjusted = [];
  const next = { ...settings };
  if (options.generations.length) {
    const wanted = hasImage ? 'image' : 'text';
    if (!options.generations.includes(wanted)) {
      throw fail(`Model ${settings.model_id} tidak mendukung generasi dari ${wanted === 'image' ? 'gambar' : 'teks'} (mendukung: ${options.generations.join(', ')}). Pilih model lain.`, 409);
    }
    if (next.generation_type !== wanted) { next.generation_type = wanted; adjusted.push('generation_type'); }
  }
  if (options.durations.length && !options.durations.includes(next.duration)) {
    next.duration = options.durations.reduce((best, d) => (Math.abs(d - settings.duration) < Math.abs(best - settings.duration) ? d : best), options.durations[0]);
    adjusted.push('duration');
  }
  if (options.resolutions.length && !options.resolutions.includes(String(next.resolution).toLowerCase())) {
    const preference = ['480p', '768p', '720p', '1080p', '2k', '4k'];
    next.resolution = preference.find((item) => options.resolutions.includes(item)) ?? options.resolutions[0];
    adjusted.push('resolution');
  }
  return { settings: next, adjusted, options };
}
// Member-only models reject non-member accounts at dispatch time with no
// usable reason (0 accepted credits). Fail early with an actionable message.
// Set FREEBEAT_ALLOW_MEMBER_ONLY=1 on the Worker once the account has membership.
function assertModelUsable(help, modelId, env) {
  if (env && String(env.FREEBEAT_ALLOW_MEMBER_ONLY) === '1') return;
  const model = help && typeof help === 'object' && help.model && typeof help.model === 'object' ? help.model : null;
  if (!model) return;
  if (model.available === false) throw fail(`Model ${modelId} sedang tidak tersedia di Freebeat. Pilih model lain.`, 409);
  if (model.member_only === true) throw fail(`Model ${modelId} khusus member Freebeat; akun tanpa membership ditolak penyedia saat pengiriman (0 accepted credits). Pilih model non-member atau aktifkan membership, lalu set FREEBEAT_ALLOW_MEMBER_ONLY=1 bila sudah member.`, 409);
}

// Do not dispatch an upload unless the live tool exposes a zero-credit ceiling
// and Freebeat quotes the exact URL at zero. Unknown is not free.
async function freebeatUploadPreflight(session, imageUrl) {
  const { tools } = await getToolSchemas(session.accessToken, new Set(['upload_image']));
  const schema = tools.upload_image;
  const cap = schema?.properties?.max_credits?.type;
  if (schema?.type !== 'object' || schema?.properties?.urls?.type !== 'array' || !['integer', 'number'].includes(cap) || (schema.required || []).some((key) => !['urls', 'max_credits'].includes(key))) return { eligible: false, reason: 'cap_unavailable' };
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote_generation', arguments: { tool: 'upload_image', parameters: { urls: [imageUrl] } } } }, 'quote', headers, 262144);
  const quote = modelContent(result);
  if (quotedCredits(quote) !== 0) return { eligible: false, reason: 'zero_quote_unavailable' };
  return { eligible: true };
}
async function freebeatUploadDiagnostic(session, request, submit) {
  await requireImageSession(session);
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['image_url', 'acknowledge'].includes(key)) || input.acknowledge !== true) throw fail('Konfirmasi privasi diperlukan.', 400);
  const imageUrl = validateVideoInput({ prompt: 'diagnostic', image_url: input.image_url }).image_url;
  const preflight = await freebeatUploadPreflight(session, imageUrl);
  if (!submit || !preflight.eligible) return preflight;
  // No retries: a lost response may still mean a copy was stored remotely.
  const headers = await openMcp(session.accessToken);
  let result;
  try {
    ({ result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'upload_image', arguments: { urls: [imageUrl], max_credits: 0 } } }, 'upload', headers, 262144));
    const content = modelContent(result);
    if (content?.success !== true || !Array.isArray(content.image_urls) || content.image_urls.length !== 1 || !safeImageUrl(content.image_urls[0])) throw new Error('unrecognized');
  } catch {
    return { eligible: true, outcome: 'unknown' };
  }
  return { eligible: true, outcome: 'uploaded' };
}
// Settings are normalized per model (resolution/duration/generation type follow
// get_model_help), so validate the shape and ranges instead of equality with the
// fixed defaults. The quote re-check at dispatch remains the real price guard.
function validVideoSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  if (Object.keys(settings).sort().join(',') !== 'aspect_ratio,duration,generation_type,model_id,resolution') return false;
  return Number.isSafeInteger(settings.model_id) && settings.model_id >= 0
    && ['image', 'text', 'transition', 'reference'].includes(settings.generation_type)
    && Number.isSafeInteger(settings.duration) && settings.duration > 0 && settings.duration <= 600
    && typeof settings.resolution === 'string' && HELP_RESOLUTION.test(settings.resolution)
    && typeof settings.aspect_ratio === 'string' && /^\d{1,2}:\d{1,2}$/.test(settings.aspect_ratio);
}
function validateVideoInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['prompt', 'image_url'].includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 2000 || typeof input.image_url !== 'string' || input.image_url.trim().length > 2048) throw fail('Masukkan prompt 1–2000 karakter dan satu URL gambar HTTPS.', 400);
  const imageUrl = input.image_url.trim();
  let url;
  try { url = new URL(imageUrl); } catch { throw fail('URL gambar HTTPS tidak valid.', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) throw fail('Gunakan URL gambar HTTPS dengan nama domain publik tanpa kredensial atau fragment.', 400);
  return { prompt: input.prompt.trim(), image_url: imageUrl };
}
async function parseImageQuote(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw fail('Format permintaan tidak valid.', 400);
  let input;
  try { input = await boundedJson(request); } catch { throw fail('Permintaan tidak valid atau terlalu besar.', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['model_id', 'prompt'].includes(key)) || !Number.isSafeInteger(input.model_id) || input.model_id < 0 || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 2000) throw fail('Masukkan ID model angka dan prompt sepanjang 1–2000 karakter.', 400);
  return { model_id: input.model_id, prompt: input.prompt.trim() };
}


// A quote receipt is encrypted and bound to the admin, Freebeat token and exact
// inputs. The durable insert below is the point of no return: after it, every
// error is treated as possibly charged and no automatic retry is attempted.
const APPROVAL_LIFETIME = 5 * 60 * 1000;
const TEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
async function sessionHash(session) {
  // Stable across silent token renewals: polling rights survive refreshes.
  return b64(await crypto.subtle.digest('SHA-256', encoder.encode(`blea-freebeat-image-session-v1:${session.sid || session.accessToken}`)));
}
function quotedCredits(content) {
  return content?.status === 'quoted' && typeof content.credits === 'number' && Number.isFinite(content.credits) && content.credits >= 0 && content.credits <= 1000000 ? content.credits : null;
}
async function requireImageSession(session) {
  if (!session?.imageAccess) throw fail('Hubungkan ulang Freebeat dan setujui izin generasi terlebih dahulu.', 403);
}
async function modelHelp(accessToken, modelId) {
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_model_help', arguments: { type: 'image', model_id: modelId } } }, 'help', headers, 262144);
  const data = modelContent(result);
  if (!data || typeof data !== 'object') throw mcpFailure('help', 'response');
}
async function prepareImage(env, user, session, input) {
  await requireImageSession(session);
  const catalog = await getModels(session.accessToken, 'image');
  if (!catalog.models.some((m) => m.model_id === input.model_id)) throw fail('ID model tidak ditemukan dalam daftar gambar saat ini.', 400);
  await modelHelp(session.accessToken, input.model_id);
  const credits = quotedCredits(await rawImageQuote(session.accessToken, input));
  if (credits === null) throw fail('Freebeat tidak memberikan quote numerik yang dapat digunakan. Generasi tidak diaktifkan.', 409);
  const expires = Date.now() + APPROVAL_LIFETIME;
  const approval = await seal({ id: crypto.randomUUID(), uid: user.id, sessionHash: await sessionHash(session), model_id: input.model_id, prompt: input.prompt, credits, expires }, env, 'image-approval');
  if (approval.length > 12000) throw fail('Prompt terlalu besar untuk persetujuan uji ini.', 400);
  return { approval, model_id: input.model_id, prompt: input.prompt, credits, expiresAt: expires };
}
async function imageJson(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw fail('Format permintaan tidak valid.', 400);
  try { return await boundedJson(request); } catch { throw fail('Permintaan tidak valid atau terlalu besar.', 400); }
}
async function imageDb(env, path, options = {}, kind = 'image') {
  const label = kind === 'video' ? 'video' : 'gambar';
  const table = kind === 'video' ? 'freebeat_admin_video_tests' : 'freebeat_admin_image_tests';
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_URL) throw fail(`Penyimpanan uji ${label} belum dikonfigurasi; tidak ada generasi yang dikirim.`, 503);
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw fail(`Konfigurasi penyimpanan uji ${label} tidak valid.`, 503);
  let res;
  try {
    res = await fetch(`${base.toString().replace(/\/$/, '')}/rest/v1/${table}${path}`, {
      method: options.method || 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', prefer: 'return=representation' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch { throw fail(`Penyimpanan uji ${label} tidak dapat dihubungi. Periksa catatan sebelum mencoba lagi.`, 503); }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    if (res.status === 409) throw fail('Persetujuan sudah digunakan atau ada uji dengan hasil belum pasti. Jangan ulangi; periksa catatan uji.', 409);
    throw fail(`Penyimpanan uji ${label} menolak permintaan. Periksa catatan sebelum mencoba lagi.`, 503);
  }
  try {
    const data = await boundedJson(res);
    if (!Array.isArray(data)) throw new Error('invalid');
    return data;
  } catch { throw fail(`Respons penyimpanan uji ${label} tidak dapat dipastikan. Periksa catatan sebelum mencoba lagi.`, 503); }
}
async function markTest(env, userId, id, status, taskId = null) {
  const rows = await imageDb(env, `?id=eq.${encodeURIComponent(id)}&admin_id=eq.${encodeURIComponent(userId)}&status=eq.dispatching`, { method: 'PATCH', body: { status, task_id: taskId, updated_at: new Date().toISOString() } });
  if (rows.length !== 1) throw fail('Status penyimpanan uji gambar tidak dapat dipastikan.', 503);
}
async function submitImage(env, user, session, request) {
  await requireImageSession(session);
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['approval', 'confirm'].includes(k)) || input.confirm !== true || typeof input.approval !== 'string' || input.approval.length > 12000) throw fail('Persetujuan uji tidak valid.', 400);
  const ticket = await unseal(input.approval, env, 'image-approval', 12000);
  if (!ticket || ticket.uid !== user.id || ticket.sessionHash !== await sessionHash(session) || !TEST_ID.test(ticket.id || '') || !Number.isSafeInteger(ticket.model_id) || ticket.model_id < 0 || typeof ticket.prompt !== 'string' || !ticket.prompt.trim() || ticket.prompt.length > 2000 || !Number.isFinite(ticket.expires) || ticket.expires <= Date.now() || ticket.expires > Date.now() + APPROVAL_LIFETIME || typeof ticket.credits !== 'number' || !Number.isFinite(ticket.credits) || ticket.credits < 0 || ticket.credits > 1000000) throw fail('Persetujuan kedaluwarsa atau tidak cocok. Buat quote baru.', 400);
  // Quote again for the exact original inputs; no input or cap may be changed.
  const current = quotedCredits(await rawImageQuote(session.accessToken, ticket));
  if (current === null || current !== ticket.credits) throw fail('Quote berubah atau tidak tersedia. Tidak ada generasi dikirim; buat quote baru.', 409);
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa. Tidak ada generasi dikirim; buat quote baru.', 400);
  const headers = await openMcp(session.accessToken);
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa. Tidak ada generasi dikirim; buat quote baru.', 400);
  const inserted = await imageDb(env, '', { method: 'POST', body: { id: ticket.id, admin_id: user.id, session_hash: ticket.sessionHash, model_id: ticket.model_id, quote_credits: ticket.credits, max_credits: ticket.credits, status: 'dispatching' } });
  if (inserted.length !== 1 || inserted[0]?.id !== ticket.id) throw fail('Penyimpanan belum dapat memastikan pencatatan. Jangan ulangi sebelum memeriksa catatan.', 503);
  if (ticket.expires <= Date.now()) {
    try { await markTest(env, user.id, ticket.id, 'reviewed'); } catch { /* leave the conservative lock in place */ }
    throw fail('Persetujuan kedaluwarsa sebelum pengiriman; tidak ada generasi dikirim. Periksa catatan sebelum mencoba lagi.', 409);
  }
  let taskId;
  try {
    const { result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { model_id: ticket.model_id, prompt: ticket.prompt, max_credits: ticket.credits } } }, 'generate', headers, 262144);
    const content = modelContent(result);
    if (!content || typeof content !== 'object' || typeof content.batch_id !== 'string' || !TASK_ID.test(content.batch_id)) throw new Error('unrecognized');
    taskId = content.batch_id;
  } catch {
    try { await markTest(env, user.id, ticket.id, 'unknown'); } catch { /* dispatching stays locked */ }
    return { id: ticket.id, status: 'unknown' };
  }
  try { await markTest(env, user.id, ticket.id, 'submitted', taskId); }
  catch { return { id: ticket.id, status: 'unknown', recoveryTaskId: taskId }; }
  return { id: ticket.id, status: 'submitted' };
}
function safeImageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}
function safeTask(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('task', 'response');
  const statuses = new Set(['pending', 'queued', 'processing', 'running', 'completed', 'failed', 'partial_failed', 'action_required']);
  const status = statuses.has(content.status) ? content.status : 'unknown';
  const images = Array.isArray(content.items) ? content.items.slice(0, 10).map((item) => safeImageUrl(item?.image_url)).filter(Boolean) : [];
  const billing = {};
  for (const field of ['charged', 'refunded', 'net']) billing[field] = typeof content.billing?.[field] === 'number' && Number.isFinite(content.billing[field]) ? content.billing[field] : null;
  const refunds = new Set(['none', 'pending', 'completed', 'failed', 'not_applicable']);
  billing.refund_state = refunds.has(content.billing?.refund_state) ? content.billing.refund_state : null;
  return { status, images, billing };
}
async function imageTests(env, user, session) {
  const rows = await imageDb(env, `?admin_id=eq.${encodeURIComponent(user.id)}&select=id,model_id,quote_credits,max_credits,status,created_at,session_hash&order=created_at.desc&limit=20`);
  const hash = await sessionHash(session);
  return rows.map((row) => ({ id: row.id, model_id: row.model_id, quote_credits: row.quote_credits, max_credits: row.max_credits, status: row.status, created_at: row.created_at, canPoll: row.status === 'submitted' && row.session_hash === hash }));
}
async function pollImage(env, user, session, request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'id') || typeof input.id !== 'string' || !TEST_ID.test(input.id)) throw fail('ID uji tidak valid.', 400);
  const rows = await imageDb(env, `?id=eq.${encodeURIComponent(input.id)}&admin_id=eq.${encodeURIComponent(user.id)}&select=status,task_id,session_hash&limit=1`);
  const row = rows[0];
  if (!row || row.status !== 'submitted' || typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id) || row.session_hash !== await sessionHash(session)) throw fail('Uji tidak tersedia pada sesi Freebeat ini.', 404);
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task_status', arguments: { task_id: row.task_id } } }, 'task', headers, 262144);
  return safeTask(modelContent(result));
}

// Video testing is separate from image tests and never touches the BLEA wallet.
// The encrypted ticket binds the exact URL, prompt, settings, user, session and cap.
const videoDb = (env, path, options = {}) => imageDb(env, path, options, 'video');
async function videoMark(env, uid, id, status, taskId = null) {
  const rows = await videoDb(env, `?id=eq.${encodeURIComponent(id)}&admin_id=eq.${encodeURIComponent(uid)}&status=eq.dispatching`, { method: 'PATCH', body: { status, task_id: taskId, updated_at: new Date().toISOString() } });
  if (rows.length !== 1) throw fail('Status penyimpanan uji video tidak dapat dipastikan.', 503);
}
async function prepareVideo(env, user, session, input) {
  await requireImageSession(session);
  const models = await getModels(session.accessToken, 'video');
  const found = models.models.some((model) => {
    const id = model.model_id;
    return (typeof id === 'number' && id === input.model_id) || (typeof id === 'string' && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) === input.model_id);
  });
  if (!found) throw fail('Model tidak ditemukan dalam daftar video Freebeat saat ini. Muat ulang daftar model.', 400);
  const exact = { prompt: input.prompt, image_url: input.image_url };
  const base = { ...videoSettings(input.model_id), ...(Number.isSafeInteger(input.duration) ? { duration: input.duration } : {}), ...(input.resolution ? { resolution: input.resolution } : {}) };
  const help = await videoDiagnostic(session.accessToken, 'video-help', null, true, base);
  assertModelUsable(help, input.model_id, env);
  const normalized = normalizeVideoSettings(help, base, Boolean(exact.image_url));
  const settings = normalized.settings;
  const credits = quotedCredits(await videoDiagnostic(session.accessToken, 'video-quote', exact, true, settings));
  if (credits === null) throw fail('Freebeat tidak memberikan quote numerik yang dapat digunakan. Generasi tidak diaktifkan.', 409);
  const expires = Date.now() + APPROVAL_LIFETIME;
  const approval = await seal({ id: crypto.randomUUID(), uid: user.id, sessionHash: await sessionHash(session), settings, ...exact, credits, expires }, env, 'video-approval');
  if (approval.length > 12000) throw fail('Input terlalu besar untuk persetujuan uji.', 400);
  return { approval, settings, ...exact, credits, max_credits: credits + videoHeadroom(credits), adjusted: normalized.adjusted, supported: normalized.options, expiresAt: expires };
}
async function submitVideo(env, user, session, request) {
  await requireImageSession(session);
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['approval', 'confirm', 'private_diagnostics'].includes(key)) || input.confirm !== true || (input.private_diagnostics !== undefined && typeof input.private_diagnostics !== 'boolean') || typeof input.approval !== 'string' || input.approval.length > 12000) throw fail('Persetujuan uji tidak valid.', 400);
  const ticket = await unseal(input.approval, env, 'video-approval', 12000);
  if (!ticket || ticket.uid !== user.id || ticket.sessionHash !== await sessionHash(session) || !TEST_ID.test(ticket.id || '') || !validVideoSettings(ticket.settings) || !Number.isFinite(ticket.expires) || ticket.expires <= Date.now() || ticket.expires > Date.now() + APPROVAL_LIFETIME || typeof ticket.credits !== 'number' || !Number.isFinite(ticket.credits) || ticket.credits < 0 || ticket.credits > 1000000) throw fail('Persetujuan kedaluwarsa atau tidak cocok. Buat quote baru.', 400);
  const exact = validateVideoInput({ prompt: ticket.prompt, image_url: ticket.image_url });
  if (exact.prompt !== ticket.prompt || exact.image_url !== ticket.image_url) throw fail('Persetujuan tidak valid.', 400);
  const current = quotedCredits(await videoDiagnostic(session.accessToken, 'video-quote', exact, true, ticket.settings));
  if (current === null || current !== ticket.credits) throw fail('Quote berubah atau tidak tersedia. Tidak ada video dikirim; buat quote baru.', 409);
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa; tidak ada video dikirim.', 400);
  const headers = await openMcp(session.accessToken);
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa; tidak ada video dikirim.', 400);
  const cap = ticket.credits + videoHeadroom(ticket.credits);
  const rows = await videoDb(env, '', { method: 'POST', body: { id: ticket.id, admin_id: user.id, session_hash: ticket.sessionHash, model_id: ticket.settings.model_id, quote_credits: ticket.credits, max_credits: cap, status: 'dispatching' } });
  if (rows.length !== 1 || rows[0]?.id !== ticket.id) throw fail('Pencatatan belum dapat dipastikan. Jangan ulangi sebelum memeriksa catatan.', 503);
  if (ticket.expires <= Date.now()) {
    try { await videoMark(env, user.id, ticket.id, 'reviewed'); } catch { /* preserve lock */ }
    throw fail('Persetujuan kedaluwarsa sebelum pengiriman; tidak ada video dikirim. Periksa catatan.', 409);
  }
  let taskId;
  let initialDiagnostics = null;
  try {
    // Dispatch mirrors the official generate_video schema (model_id, prompt,
    // generation_type enum string, images, duration, resolution, aspect_ratio,
    // max_credits) AND the proven web client shape (aspect ratio always sent).
    const { result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_video', arguments: { model_id: ticket.settings.model_id, generation_type: ticket.settings.generation_type, prompt: exact.prompt, images: [exact.image_url], duration: ticket.settings.duration, resolution: ticket.settings.resolution, aspect_ratio: ticket.settings.aspect_ratio, max_credits: cap } } }, 'generate', headers, 262144, input.private_diagnostics === true);
    if (input.private_diagnostics === true) initialDiagnostics = { received: true, messages: initialVideoMessages(result) };
    if (result.isError) throw new Error('unrecognized');
    const content = modelContent(result);
    if (!content || typeof content.batch_id !== 'string' || !TASK_ID.test(content.batch_id)) throw new Error('unrecognized');
    taskId = content.batch_id;
  } catch {
    try { await videoMark(env, user.id, ticket.id, 'unknown'); } catch { /* retain lock */ }
    return { id: ticket.id, status: 'unknown', ...(input.private_diagnostics === true ? { initial_diagnostics: initialDiagnostics || { received: false, messages: [] } } : {}) };
  }
  try { await videoMark(env, user.id, ticket.id, 'submitted', taskId); }
  catch { return { id: ticket.id, status: 'unknown', recoveryTaskId: taskId, ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}) }; }
  return { id: ticket.id, status: 'submitted', ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}) };
}
async function videoTests(env, user, session) {
  const rows = await videoDb(env, `?admin_id=eq.${encodeURIComponent(user.id)}&select=id,model_id,quote_credits,max_credits,status,created_at,session_hash&order=created_at.desc&limit=20`);
  const hash = await sessionHash(session);
  return rows.map((row) => ({ id: row.id, model_id: row.model_id, quote_credits: row.quote_credits, max_credits: row.max_credits, status: row.status, created_at: row.created_at, canPoll: row.status === 'submitted' && row.session_hash === hash }));
}
// Provider failure details can contain private URLs, prompts and credentials.
// Return only exact fixed codes and booleans; unknown prose is never exposed.
const VIDEO_FAILURE_STAGES = new Set(['validation', 'input', 'preflight', 'planning', 'generation', 'processing', 'render', 'rendering', 'upload', 'download', 'provider', 'billing', 'moderation', 'output', 'unknown']);
const VIDEO_FAILURE_REASONS = new Set(['invalid_input', 'invalid_parameter', 'unsupported_model', 'unsupported_resolution', 'unsupported_duration', 'invalid_image', 'image_download_failed', 'insufficient_credits', 'membership_required', 'permission_denied', 'content_policy', 'moderation_failed', 'provider_error', 'generation_failed', 'timeout', 'unknown']);
function safeVideoFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safeCode = (v, allowed) => typeof v === 'string' && allowed.has(v.toLowerCase()) ? v.toLowerCase() : null;
  return {
    stage: safeCode(value.stage, VIDEO_FAILURE_STAGES),
    stage_hidden: typeof value.stage === 'string' && !safeCode(value.stage, VIDEO_FAILURE_STAGES),
    reason: safeCode(value.reason, VIDEO_FAILURE_REASONS),
    reason_hidden: typeof value.reason === 'string' && !safeCode(value.reason, VIDEO_FAILURE_REASONS),
    retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
  };
}
async function videoTaskContent(env, user, session, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['id', 'acknowledge'].includes(key)) || typeof input.id !== 'string' || !TEST_ID.test(input.id)) throw fail('ID uji tidak valid.', 400);
  const rows = await videoDb(env, `?id=eq.${encodeURIComponent(input.id)}&admin_id=eq.${encodeURIComponent(user.id)}&select=status,task_id,session_hash&limit=1`);
  const row = rows[0];
  const sameSession = Boolean(row) && row.session_hash === await sessionHash(session);
  // Legacy rows (submitted from an earlier Freebeat session) stay pollable for
  // the owning admin with explicit acknowledgement, so rejected dispatches can
  // finally reveal their provider failure reason instead of hanging forever.
  if (!row || row.status !== 'submitted' || typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id) || (!sameSession && input.acknowledge !== true)) throw fail('Uji tidak tersedia pada sesi Freebeat ini.', 404);
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task_status', arguments: { task_id: row.task_id } } }, 'task', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('task', 'response');
  return content;
}
async function pollVideo(env, user, session, request) {
  const content = await videoTaskContent(env, user, session, await imageJson(request));
  const summary = safeTask(content);
  return { status: summary.status, billing: summary.billing, videos: Array.isArray(content.items) ? content.items.slice(0, 10).map((item) => safeImageUrl(item?.video_url)).filter(Boolean) : [], failure: safeVideoFailure(content.failure), item_failures: Array.isArray(content.items) ? content.items.slice(0, 10).map((item) => safeVideoFailure(item?.failure)).filter(Boolean) : [] };
}
// Best-effort redaction only. Free-form provider text may still include sensitive
// data; reveal to the submitting admin only, on explicit request, never log it.
function privateFailureReason(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.slice(0, 2000)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL disembunyikan]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email disembunyikan]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [disembunyikan]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token disembunyikan]')
    .replace(/\b(?:fbk_|sk_|sb_secret_)[A-Za-z0-9_-]+\b/gi, '[kunci disembunyikan]')
    .replace(/\b(token|api[_-]?key|authorization|cookie|secret|password)(["'\s]*[:=]["'\s]*)[^\s,;"']+/gi, '$1$2[disembunyikan]');
}
// More complete model help for an explicitly consenting admin. This is not a
// guarantee of redaction: provider prose may contain unrecognized secrets.
function privateModelHelp(value) {
  let remaining = 3000;
  let truncated = false;
  function visit(item, depth) {
    if (remaining-- <= 0 || depth > 9) { truncated = true; return '[terpotong]'; }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item === 'string') {
      if (item.length > 2000) truncated = true;
      return privateFailureReason(item) ?? '';
    }
    if (Array.isArray(item)) {
      if (item.length > 100) truncated = true;
      return item.slice(0, 100).map((child) => visit(child, depth + 1));
    }
    if (typeof item !== 'object') return null;
    const entries = Object.entries(item);
    if (entries.length > 100) truncated = true;
    const result = [];
    for (const [name, child] of entries.slice(0, 100)) {
      // Preserve common price-map combination keys such as 480p|5, but never
      // reflect arbitrary URL-like or credential-bearing property names.
      if (!/^[A-Za-z0-9_.,:|/ +\-]{1,100}$/.test(name) || name.includes('://') || ['__proto__', 'constructor', 'prototype'].includes(name) || QUOTE_PRIVATE_KEY.test(name) || /password|passwd|api[_-]?key|private[_-]?key|access[_-]?key/i.test(name) || privateFailureReason(name) !== name) { truncated = true; continue; }
      result.push([name, visit(child, depth + 1)]);
    }
    return Object.fromEntries(result);
  }
  return { help: visit(value, 0), truncated };
}

// Extract only selected batch/item message fields from the original create
// response. The provider body is not stored or logged; redaction is best effort.
function initialVideoMessages(result) {
  const candidates = [];
  const fields = (value) => [value?.failure?.reason, value?.error_code, value?.error_message, value?.message, value?.error?.message];
  function collect(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    candidates.push(...fields(value));
    if (Array.isArray(value.items)) for (const item of value.items.slice(0, 10)) candidates.push(...fields(item));
  }
  collect(result);
  const structured = modelContent(result);
  collect(structured);
  if (!result.structuredContent && Array.isArray(result.content)) {
    for (const entry of result.content.slice(0, 10)) {
      if (entry?.type !== 'text' || typeof entry.text !== 'string') continue;
      try { const parsed = JSON.parse(entry.text); if (parsed && typeof parsed === 'object') collect(parsed); else if (typeof parsed === 'string') candidates.push(parsed); }
      catch { candidates.push(entry.text); }
    }
  }
  return [...new Set(candidates.map(privateFailureReason).filter(Boolean))].slice(0, 50);
}

async function privateVideoFailure(env, user, session, request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['id', 'acknowledge'].includes(key)) || input.acknowledge !== true) throw fail('Konfirmasi privasi diperlukan.', 400);
  const content = await videoTaskContent(env, user, session, { id: input.id, acknowledge: true });
  if (!['failed', 'partial_failed', 'action_required'].includes(content.status)) throw fail('Pesan kegagalan tidak tersedia untuk status ini.', 409);
  // Status responses can carry useful details in failure.reason, error_message
  // or message at batch/item level. The original create response is not stored,
  // so this can only reveal fields that get_task_status still returns.
  const fields = (value) => [value?.failure?.reason, value?.error_code, value?.error_message, value?.message];
  const candidates = [...fields(content), ...(Array.isArray(content.items) ? content.items.slice(0, 10).flatMap(fields) : [])];
  const reasons = [...new Set(candidates.map(privateFailureReason).filter(Boolean))];
  return { reasons };
}

function proxyVerdict(status) {
  if (status === 401 || status === 403) return 'token_oauth_ditolak_gerbang_web';
  if (status === 404 || status === 405) return 'jalur_proxy_tidak_dikenal';
  if (status === 429) return 'rate_limited';
  if (status >= 200 && status < 300) return 'diterima_gerbang_web';
  if (status >= 500) return 'galat_server_freebeat';
  return 'ditolak_lainnya';
}
// Read-only shapes for the web gateway's video list. The plain GET returned
// HTTP 200 with an empty body, so the real contract is probably a POST; these
// candidates cost nothing and reveal which one the gateway answers.
const PROXY_LIST_CANDIDATES = Object.freeze([
  { method: 'POST', path: '/aiVideo/list', body: { page: 1, pageSize: 5 } },
  { method: 'POST', path: '/aiVideo/list', body: { pageNum: 1, pageSize: 5 } },
  { method: 'POST', path: '/aiVideo/list', body: {} },
  { method: 'GET', path: '/aiVideo/list?pageNum=1&pageSize=5', body: null },
]);
async function proxyRequest(session, accessToken, method, url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, { method, redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text().catch(() => '');
    const masked = text.replaceAll(accessToken || '\u0000', '[token dihapus]').slice(0, 1200);
    return { method, url, status: res.status, accepted: res.ok, verdict: proxyVerdict(res.status), length: text.length, body: masked };
  } catch (err) {
    return { method, url, status: 0, accepted: false, verdict: err?.name === 'AbortError' ? 'timeout' : 'jaringan_gagal', length: 0, body: '' };
  } finally { clearTimeout(timer); }
}
async function proxyListSweep(session) {
  const attempts = [];
  for (const candidate of PROXY_LIST_CANDIDATES) {
    attempts.push(await proxyRequest(session, session.accessToken, candidate.method, `${PROXY_BASE}${candidate.path}`, candidate.body));
    if (attempts[attempts.length - 1].length > 2) break; // first shape that answers wins
  }
  // Only a 2xx with a body counts as an answer; an error body (401 device
  // conflict, 404) is a rejection, not proof the token works on this gateway.
  const last = attempts[attempts.length - 1];
  const answered = attempts.find((item) => item.accepted && item.length > 2) || null;
  return { stage: 'list', attempts, answered: Boolean(answered), status: answered?.status ?? last.status, accepted: answered?.accepted === true, verdict: answered ? answered.verdict : (last.status ? last.verdict : 'tidak_ada_bentuk_yang_menjawab'), body: answered?.body ?? last.body ?? '' };
}
async function proxyProbe(session, env, input) {
  if (input.stage === 'list') return await proxyListSweep(session);
  const create = input.stage === 'create';
  if (create && env.FREEBEAT_ALLOW_PROXY_CREATE !== '1') throw fail('Langkah kirim video melalui gerbang web dinonaktifkan. Setel FREEBEAT_ALLOW_PROXY_CREATE=1 di Worker hanya setelah uji probe gratis diterima dan pengeluaran disetujui.', 409);
  const exact = create ? validateVideoInput({ prompt: input.prompt, image_url: input.image_url }) : null;
  const url = create ? `${PROXY_BASE}/aiVideo/createAiVideo` : `${PROXY_BASE}/aiVideo/list?page=1&pageSize=1`;
  const payload = create ? {
    generationType: input.generation_type === 'text' ? 1 : 0,
    model: typeof input.model_slug === 'string' && input.model_slug ? input.model_slug : undefined,
    modelId: input.model_id,
    duration: input.duration,
    resolution: input.resolution,
    style: '',
    images: [exact.image_url],
    prompt: exact.prompt,
    watermark: 1,
    name: 'BLEA AI gateway probe',
    aspectRatio: input.aspect_ratio,
    extraParams: {},
  } : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let res;
  try {
    res = await fetch(url, { method: create ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal, headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json', accept: 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  } catch (err) {
    return { stage: input.stage, url, status: 0, accepted: false, verdict: err?.name === 'AbortError' ? 'timeout' : 'jaringan_gagal', location: null, body: '' };
  } finally { clearTimeout(timer); }
  const text = await res.text().catch(() => '');
  const masked = text.replaceAll(session.accessToken || '\u0000', '[token dihapus]').slice(0, 1500);
  return { stage: input.stage, url, status: res.status, accepted: res.ok, verdict: proxyVerdict(res.status), location: res.headers.get('location'), body: masked };
}

async function dispatchFreebeat(request, url, env, user) {
  try {
    if (!user) return response({ error: 'Login diperlukan.' }, 401);
    if (user.app_metadata?.role !== 'admin') return response({ error: 'Koneksi Freebeat hanya untuk admin.' }, 403);
    const action = url.pathname.split('/').pop();
    if (['start', 'start-image'].includes(action) && request.method === 'POST') {
      if (url.origin !== new URL(redirectUri(env)).origin) return response({ error: 'Buka BLEA melalui domain callback Freebeat yang dikonfigurasi sebelum menghubungkan akun.' }, 400);
      return await startFreebeat(env, user.id);
    }
    if (action === 'status' && request.method === 'GET') {
      const session = await readSession(request, env, user.id);
      return response({ connected: Boolean(session), imageAccess: session?.imageAccess === true, expiresAt: session?.expiresAt || null });
    }
    if (['balance', 'image-schemas', 'image-models', 'image-quote', 'video-schemas', 'video-models'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'balance') return response({ ok: true, balance: await getBalance(session.accessToken) });
      if (action === 'image-schemas') return response({ ok: true, ...(await getToolSchemas(session.accessToken, IMAGE_TOOLS)) });
      if (action === 'video-schemas') return response({ ok: true, ...(await getToolSchemas(session.accessToken, VIDEO_TOOLS)) });
      if (action === 'image-models') return response({ ok: true, ...(await getModels(session.accessToken, 'image')) });
      if (action === 'video-models') return response({ ok: true, ...(await getModels(session.accessToken, 'video')) });
      return response({ ok: true, quote: await quoteImage(session.accessToken, await parseImageQuote(request)) });
    }
    if (['video-upload-check', 'video-upload-image'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      return response({ ok: true, ...(await freebeatUploadDiagnostic(session, request, action === 'video-upload-image')) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (action === 'video-model-private-help' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const input = await imageJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['model_id', 'acknowledge'].includes(key)) || input.acknowledge !== true || !Number.isSafeInteger(input.model_id) || input.model_id < 0) throw fail('Pilih model dan konfirmasi privasi terlebih dahulu.', 400);
      const content = await videoDiagnostic(session.accessToken, 'video-help', null, true, videoSettings(input.model_id));
      return response({ ok: true, model_id: input.model_id, ...privateModelHelp(content) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (['video-model-help', 'video-model-quote'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const input = await imageJson(request);
      const allowed = action === 'video-model-help' ? ['model_id'] : ['model_id', 'prompt', 'image_url', 'duration', 'resolution'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) || !Number.isSafeInteger(input.model_id) || input.model_id < 0) throw fail('Masukkan ID model video yang valid.', 400);
      const settings = { ...FREEBEAT_VIDEO_TEST, model_id: input.model_id, ...(input.duration !== undefined ? { duration: optionalDuration(input.duration) } : {}), ...(input.resolution !== undefined ? { resolution: optionalResolution(input.resolution) } : {}) };
      if (action === 'video-model-help') return response({ ok: true, model_id: settings.model_id, help: await videoDiagnostic(session.accessToken, 'video-help', null, false, settings) });
      const videoInput = validateVideoInput({ prompt: input.prompt, image_url: input.image_url });
      const help = await videoDiagnostic(session.accessToken, 'video-help', null, true, settings);
      assertModelUsable(help, input.model_id, env);
      const normalized = normalizeVideoSettings(help, settings, Boolean(videoInput.image_url));
      return response({ ok: true, settings: normalized.settings, adjusted: normalized.adjusted, member_only: help?.model?.member_only === true, quote: await videoDiagnostic(session.accessToken, 'video-quote', videoInput, false, normalized.settings) });
    }
    if (['video-help', 'video-quote', 'video-gemini-help', 'video-gemini-quote'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const gemini = action.startsWith('video-gemini-');
      const settings = gemini ? FREEBEAT_GEMINI_DIAGNOSTIC : FREEBEAT_VIDEO_TEST;
      if (action.endsWith('-help')) {
        const input = await imageJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw fail('Permintaan tidak valid.', 400);
        return response({ ok: true, model_id: settings.model_id, help: await videoDiagnostic(session.accessToken, 'video-help', null, false, settings) });
      }
      return response({ ok: true, quote: await videoDiagnostic(session.accessToken, 'video-quote', await parseVideoQuote(request), false, settings) });
    }
    if (['video-prepare', 'video-submit', 'video-tests', 'video-task', 'video-private-failure'].includes(action)) {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'video-tests' && request.method === 'GET') return response({ ok: true, tests: await videoTests(env, user, session) });
      if (action === 'video-prepare' && request.method === 'POST') return response({ ok: true, ...(await prepareVideo(env, user, session, await parseVideoPrepare(request))) });
      if (action === 'video-submit' && request.method === 'POST') return response({ ok: true, ...(await submitVideo(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'video-task' && request.method === 'POST') return response({ ok: true, task: await pollVideo(env, user, session, request) });
      if (action === 'video-private-failure' && request.method === 'POST') return response({ ok: true, ...(await privateVideoFailure(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (action === 'proxy-probe' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const input = await imageJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.acknowledge !== true || !['probe', 'list', 'create'].includes(input.stage) || Object.keys(input).some((key) => !['stage', 'acknowledge', 'model_id', 'model_slug', 'prompt', 'image_url', 'duration', 'resolution', 'aspect_ratio', 'generation_type'].includes(key))) throw fail('Permintaan probe gerbang web tidak valid.', 400);
      const settings = { ...FREEBEAT_VIDEO_TEST, ...(Number.isSafeInteger(input.model_id) && input.model_id >= 0 ? { model_id: input.model_id } : {}), ...(input.duration !== undefined ? { duration: optionalDuration(input.duration) } : {}), ...(input.resolution !== undefined ? { resolution: optionalResolution(input.resolution) } : {}), model_slug: typeof input.model_slug === 'string' && /^[a-z0-9._-]{1,60}$/i.test(input.model_slug) ? input.model_slug.toLowerCase() : '' };
      const probe = await proxyProbe(session, env, { stage: input.stage, model_id: settings.model_id, model_slug: settings.model_slug, generation_type: settings.generation_type, duration: settings.duration, resolution: settings.resolution, aspect_ratio: settings.aspect_ratio, prompt: input.prompt, image_url: input.image_url });
      return response({ ok: true, probe }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (['image-prepare', 'image-submit', 'image-tests', 'image-task'].includes(action)) {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'image-tests' && request.method === 'GET') return response({ ok: true, tests: await imageTests(env, user, session) });
      if (action === 'image-prepare' && request.method === 'POST') return response({ ok: true, ...(await prepareImage(env, user, session, await parseImageQuote(request))) });
      if (action === 'image-submit' && request.method === 'POST') return response({ ok: true, ...(await submitImage(env, user, session, request)) });
      if (action === 'image-task' && request.method === 'POST') return response({ ok: true, task: await pollImage(env, user, session, request) });
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

export async function handleFreebeat(request, url, env, user) {
  const res = await dispatchFreebeat(request, url, env, user);
  // Persist silently renewed sessions so one connection keeps working.
  const setCookie = sessionCookies.get(request);
  if (setCookie) res.headers.append('Set-Cookie', setCookie);
  return res;
}
