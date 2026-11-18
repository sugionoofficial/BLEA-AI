// Read-only Freebeat MCP connection test. No generation tools are exposed here.
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

// MCP may return JSON or a finite Server-Sent Events response. Only the expected request ID is accepted.
function parseRpc(text, type, expectedId) {
  let objects = [];
  if (type.includes('application/json')) { try { objects = [JSON.parse(text)]; } catch { /* invalid response */ } }
  else if (type.includes('text/event-stream')) {
    objects = text.split(/\r?\n\r?\n/).flatMap((event) => {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      try { return data ? [JSON.parse(data)] : []; } catch { return []; }
    });
  }
  const object = objects.find((entry) => entry?.id === expectedId);
  if (!object || object.error || !object.result || object.result.isError) throw fail('Freebeat menolak atau tidak mendukung permintaan baca saldo.');
  return object.result;
}
async function rpc(accessToken, body, extraHeaders = {}) {
  let res;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders }, body: JSON.stringify(body) });
  } catch { throw fail('MCP Freebeat tidak dapat dihubungi.'); }
  if (!res.ok) throw fail(res.status === 401 || res.status === 403 ? 'Freebeat menolak akses. Hubungkan ulang atau periksa akses akun/plan.' : `MCP Freebeat menolak permintaan (HTTP ${res.status}).`, res.status === 401 ? 401 : 502);
  if (body.id === undefined) { await res.body?.cancel(); return {}; }
  const text = await res.text();
  if (text.length > 65536) throw fail('Respons MCP Freebeat terlalu besar.');
  return { result: parseRpc(text, res.headers.get('content-type') || '', body.id), sessionId: res.headers.get('mcp-session-id') };
}
async function getBalance(accessToken) {
  const init = await rpc(accessToken, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'blea-ai-readonly-test', version: '1.0.0' } } });
  const version = init.result.protocolVersion;
  if (!['2024-11-05', '2025-03-26', '2025-06-18'].includes(version)) throw fail('Versi protokol MCP Freebeat tidak didukung.');
  const headers = { 'MCP-Protocol-Version': version, ...(init.sessionId ? { 'Mcp-Session-Id': init.sessionId } : {}) };
  await rpc(accessToken, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  const call = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_credit_balance', arguments: {} } }, headers);
  const data = call.result.structuredContent ?? call.result.content;
  if (!data) throw fail('Freebeat tidak mengembalikan data saldo.');
  return data;
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
    if (action === 'balance' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      return response({ ok: true, balance: await getBalance(session.accessToken) });
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
