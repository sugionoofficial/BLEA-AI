// Admin-only Freebeat MCP diagnostics and explicitly approved generation tests.
import { boundedJson } from './boundedJson.js';
import { FREEBEAT_VIDEO_TEST, FREEBEAT_GEMINI_DIAGNOSTIC, FREEBEAT_VIDEO_MAX_IMAGES, videoHeadroom } from './freebeatVideoTestSettings.js';
import { UPSTREAM_MEDIA_USER_AGENT } from './safeUrl.js';
const ENDPOINT = 'https://freebeat.ai/api/mcp';
const READ_SCOPE = 'freebeat:read';
const IMAGE_SCOPE = 'freebeat:generate';
const REGISTER = 'https://freebeat.ai/oauth/register';
const AUTH = 'https://freebeat.ai/oauth/authorize';
const TOKEN = 'https://freebeat.ai/oauth/token';
const REVOKE = 'https://freebeat.ai/oauth/revoke';
const PENDING = '__Host-blea_freebeat_pending';
const SESSION = '__Host-blea_freebeat_session';
export const FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE = 'SALDO GATEWAY HABIS, SILAHKAN HUBUNGI ADMIN.';
export const FREEBEAT_POOL_MAX_CYCLES = 3;
const FREEBEAT_ALLOWED_RETURNS = new Set(['/admin/freebeat', '/admin?tab=freebeat-oauth', '/admin/freebeat-oauth']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encoder = new TextEncoder();

function decodeJwtClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const json = new TextDecoder().decode(unb64(parts[1]));
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : null;
  } catch { return null; }
}
function extractEmailFromJwt(token) {
  return extractEmailFromObject(decodeJwtClaims(token));
}
function extractEmailFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const cand of [
    obj.email,
    obj.user_email,
    obj.account_email,
    obj.primary_email,
    obj.mail,
    obj.preferred_username,
    obj.upn,
    obj.username,
    obj.user?.email,
    obj.user?.user_email,
    obj.account?.email,
    obj.profile?.email,
    obj.data?.email,
    obj.data?.user?.email,
  ]) {
    if (typeof cand === 'string') {
      const clean = cand.trim().slice(0, 320);
      if (EMAIL_PATTERN.test(clean)) return clean;
    }
  }
  return '';
}
function extractSubjectFromObject(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const cand of [obj.sub, obj.user_id, obj.account_id, obj.uid, obj.id, obj.user?.sub, obj.user?.id, obj.data?.id]) {
    if ((typeof cand === 'string' && cand.trim()) || (typeof cand === 'number' && Number.isFinite(cand))) {
      return String(cand).trim().slice(0, 128);
    }
  }
  return '';
}
async function resolveFreebeatOAuthIdentity(tokens) {
  const tokenEmail = extractEmailFromObject(tokens);
  const idClaims = decodeJwtClaims(tokens?.id_token);
  const accessClaims = decodeJwtClaims(tokens?.access_token);
  let email = tokenEmail || extractEmailFromObject(idClaims) || extractEmailFromObject(accessClaims) || '';
  let subject = extractSubjectFromObject(idClaims) || extractSubjectFromObject(accessClaims) || extractSubjectFromObject(tokens) || '';
  if (email) return { email, subject };

  const userinfoCandidates = new Set();
  for (const metaUrl of ['https://freebeat.ai/.well-known/oauth-authorization-server', 'https://freebeat.ai/.well-known/openid-configuration']) {
    try {
      const res = await fetch(metaUrl, { headers: { accept: 'application/json', 'user-agent': UPSTREAM_MEDIA_USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const meta = await res.json().catch(() => null);
        if (typeof meta?.userinfo_endpoint === 'string') {
          const parsed = new URL(meta.userinfo_endpoint);
          if (parsed.protocol === 'https:' && parsed.origin === 'https://freebeat.ai') {
            userinfoCandidates.add(parsed.toString());
          }
        }
        break;
      }
    } catch { /* metadata discovery is optional */ }
  }
  userinfoCandidates.add('https://freebeat.ai/oauth/userinfo');

  for (const endpoint of userinfoCandidates) {
    try {
      const res = await fetch(endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json', 'user-agent': UPSTREAM_MEDIA_USER_AGENT },
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const profile = await res.json().catch(() => null);
      const foundEmail = extractEmailFromObject(profile);
      const foundSub = extractSubjectFromObject(profile);
      if (foundEmail) email = foundEmail;
      if (!subject && foundSub) subject = foundSub;
      if (email) break;
    } catch { /* userinfo is optional */ }
  }
  return { email, subject };
}
function extractNumericBalance(payload, depth = 0) {
  if (depth > 3 || payload === null || payload === undefined) return null;
  if (typeof payload === 'number' && Number.isFinite(payload)) return payload;
  if (Array.isArray(payload)) {
    for (const item of payload.slice(0, 10)) {
      if (item?.type === 'text' && typeof item.text === 'string') {
        try {
          const parsed = JSON.parse(item.text);
          const n = extractNumericBalance(parsed, depth + 1);
          if (n !== null) return n;
        } catch { /* ignore */ }
      }
      const n = extractNumericBalance(item, depth + 1);
      if (n !== null) return n;
    }
    return null;
  }
  if (typeof payload !== 'object') return null;
  for (const key of ['available_credits', 'remaining_credits', 'credits', 'credit_balance', 'balance', 'total_credits']) {
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
    if (typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
  }
  for (const nestedKey of ['structuredContent', 'content', 'data', 'account', 'balance']) {
    if (payload[nestedKey] && typeof payload[nestedKey] === 'object') {
      const n = extractNumericBalance(payload[nestedKey], depth + 1);
      if (n !== null) return n;
    }
  }
  return null;
}
const BALANCE_EXHAUSTED_REGEX = /insufficient[_\s-]?credit|not[\s_-]?enough[\s_-]?credit|(?:don't|do\s+not|doesn't|does\s+not)\s+have\s+enough\s+credit|(?:lack|short)\s+(?:of\s+)?credit|no[\s_-]?credits?(?:[\s_-]+(?:left|remaining|available))?(?![\s_-]+(?:required|needed|card))|(?:out|ran\s+out)[\s_-]?of[\s_-]?credits?|credit[s]?[\s_-]*(?:balance[\s_-]*(?:is[\s_-]*)?(?:too[\s_-]*low|insufficient|empty|0)|exhausted|depleted|empty|insufficient|not[\s_-]+enough|too[\s_-]+low|habis|kurang|tidak[\s_-]+cukup)|(?:need|require|requires)s?\s+(?:more|additional)\s+credit|balance[\s_-]*(?:is\s*)?(?:0|zero|empty|insufficient|too\s*low)|quota[\s_-]*(?:exceeded|exhausted)|(?:saldo|kredit)[\s_-]*(?:habis|kosong|kurang|tidak\s*cukup)|(?:please|kindly)\s*(?:top\s*up|recharge|purchase\s*credits?|buy\s*credits?|add\s*credits?)|(?:top[\s_-]*up|recharge|upgrade\s*(?:your\s*)?plan)[\s_-]+(?:to\s+(?:continue|proceed|resume)|required|credits?)/i;
export function isFreebeatBalanceExhausted(payload) {
  if (!payload) return false;
  if (typeof payload === 'string') return BALANCE_EXHAUSTED_REGEX.test(payload);
  if (typeof payload !== 'object') return false;
  if (payload.balanceExhausted === true || payload.httpStatus === 402) return true;
  if (String(payload.status || '').trim().toLowerCase() === 'insufficient_credits') return true;
  const check = (value, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return false;
    if (typeof value === 'string') return BALANCE_EXHAUSTED_REGEX.test(value);
    if (Array.isArray(value)) return value.slice(0, 20).some((item) => check(item, depth + 1));
    if (typeof value === 'object') {
      for (const k of ['reason', 'error_code', 'code', 'error_message', 'message', 'status_message', 'status', 'text', 'error', 'failure', 'content', 'structuredContent', 'details', 'messages', 'events', 'items', 'pending_action', 'action_reason', 'prompt', 'question', 'reply', 'description', 'title']) {
        if (k in value && check(value[k], depth + 1)) return true;
      }
    }
    return false;
  };
  return check(payload);
}
function isAccountFailoverError(err) {
  if (!err) return false;
  if (err.balanceExhausted === true || err.httpStatus === 402) return true;
  if (err.httpStatus === 401 || err.httpStatus === 403 || err.status === 401) return true;
  if (err.freebeatKind === 'http' && err.status === 401) return true;
  return isFreebeatBalanceExhausted(err);
}
function normalizeStartOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const email = typeof raw.email === 'string' ? raw.email.trim().slice(0, 320) : '';
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 100) : '';
  const accountId = typeof raw.accountId === 'string' && TEST_ID.test(raw.accountId.trim()) ? raw.accountId.trim() : null;
  const rawReturn = typeof raw.returnTo === 'string' ? raw.returnTo.trim() : '';
  const returnTo = FREEBEAT_ALLOWED_RETURNS.has(rawReturn) ? rawReturn : '/admin/freebeat';
  return { email, label, accountId, returnTo };
}

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
// Expose only fixed diagnostic codes and, when present, a short safe-shaped
// OAuth error code (see registrationErrorDetails); never expose raw provider
// bodies, free-text descriptions or tokens.
// A request-tracing identifier (e.g. Cloudflare's `cf-ray`, or a generic
// `x-request-id`/`request-id`) is not sensitive -- it is a short opaque
// token meant specifically to be handed to the origin's own support team to
// look up what happened to one exact request. Surfacing it lets a user
// escalate a persistent provider-side failure (like `server_error`) to
// Freebeat support with something concrete to search their logs by,
// instead of only a timestamp and a guess.
const TRACE_HEADER_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
function safeTraceId(res) {
  if (!res || typeof res.headers?.get !== 'function') return null;
  for (const name of ['cf-ray', 'x-request-id', 'request-id', 'x-amzn-requestid']) {
    const value = res.headers.get(name);
    if (typeof value === 'string' && TRACE_HEADER_RE.test(value.trim())) return value.trim();
  }
  return null;
}
function oauthFailure(stage, kind, status, registrationError = null, traceId = null) {
  const tag = `[FB-${stage.toUpperCase()}-${kind.toUpperCase()}]`;
  const message = kind === 'timeout' ? 'Freebeat tidak merespons dalam 15 detik.'
    : kind === 'network' ? 'Worker tidak dapat terhubung ke Freebeat.'
      : kind === 'redirect' ? 'Freebeat mengirim pengalihan yang tidak didukung atau tidak aman.'
        : kind === 'http' ? `Freebeat menolak permintaan (HTTP ${status}).`
          : 'Freebeat mengirim respons yang bukan JSON yang valid.';
  const details = (registrationError ? ` Kode OAuth: ${registrationError.code}.${registrationError.loopback ? ' Freebeat menyebut callback localhost/loopback.' : ''}` : '')
    + (traceId ? ` Ref: ${traceId}.` : '');
  console.warn('Freebeat OAuth request failed', { stage, kind, ...(Number.isInteger(status) ? { status } : {}), ...(registrationError ? { oauthCode: registrationError.code, loopback: registrationError.loopback } : {}), ...(traceId ? { traceId } : {}) });
  return Object.assign(fail(`${message} ${tag}${details}`), { freebeatKind: kind, freebeatOauthCode: registrationError?.code || null });
}

// Read a small registration error body only; never return or log its raw
// contents (error_description free text is used only to detect a loopback
// hint, never surfaced itself). Previously this required the `error` field
// to match a fixed allow-list of RFC 7591 codes we had already seen in a
// live test; that silently hid the real code (and even the server-side log)
// whenever Freebeat used a code outside that list, making "Freebeat menolak
// permintaan (HTTP 400)" the only thing anyone ever saw. The code itself is
// a short lowercase enum-like identifier per RFC 7591/6749, not sensitive,
// so any value matching that shape is now shown/logged, not just a
// pre-approved subset. Also stop requiring `content-type: ...json...`:
// some error responses are served as text/plain or application/problem+json
// with a perfectly valid JSON body.
const SAFE_OAUTH_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
async function registrationErrorDetails(res) {
  if (!res.body) return null;
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
    if (!data || typeof data !== 'object' || typeof data.error !== 'string' || !SAFE_OAUTH_CODE_RE.test(data.error)) return null;
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
    let next; try { next = new URL(res.headers.get('location'), target); } catch { throw oauthFailure(stage, 'redirect', res.status, null, safeTraceId(res)); }
    const original = new URL(url);
    if (redirects || ![307, 308].includes(res.status) || next.origin !== original.origin || next.pathname.replace(/\/$/, '') !== original.pathname.replace(/\/$/, '') || next.search || next.hash || next.username || next.password) throw oauthFailure(stage, 'redirect', res.status, null, safeTraceId(res));
    target = next.toString();
  }
  if (!res.ok) {
    // RFC 7591 (register) and RFC 6749 §5.2 (token) both define a small JSON
    // {error, error_description} body on failure; try to read it on either
    // stage so a token-refresh rejection (e.g. invalid_grant on an existing
    // connected account) is just as diagnosable as a registration rejection.
    const details = (stage === 'register' || stage === 'token') && [400, 401].includes(res.status) ? await registrationErrorDetails(res) : null;
    throw oauthFailure(stage, 'http', res.status, details, safeTraceId(res));
  }
  let data;
  try { data = await res.json(); }
  catch (error) { throw oauthFailure(stage, ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'response', res.status, null, safeTraceId(res)); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw oauthFailure(stage, 'response', res.status, null, safeTraceId(res));
  return data;
}

// Register a new dynamic OAuth client with Freebeat. This has been observed
// live to fail with the generic OAuth error code `server_error` ("the
// authorization server encountered an unexpected condition", RFC 6749
// Sec 4.1.2.1) -- a problem on Freebeat's own backend, not a declared
// rejection of our client metadata. Registration has no single-use side
// effect (each call simply mints a new client), so it is safe to retry.
//
// Escalation, in order, stopping at the first success:
//   1. The full, intended combination (both grants, both scopes).
//   2. The identical payload again after a short delay, in case attempt 1
//      hit a transient backend hiccup that clears on an immediate retry.
//   3. The same scope but WITHOUT the `refresh_token` grant. This has been
//      observed live to keep failing with `server_error` on attempts 1-2
//      even after Freebeat was given time to recover, which points at the
//      specific grant combination rather than a one-off blip. Dropping
//      `refresh_token` only shortens how long a connected session lasts
//      before it needs a fresh reconnect (renewSession's later
//      grant_type=refresh_token call would then be rejected instead of
//      renewing) -- a real but bounded regression, and strictly better than
//      not being able to connect at all.
// If every attempt still fails, the error from the LAST attempt is thrown
// (it reflects the most current state) so the real OAuth code is still
// visible to the user and in the logs either way.
async function registerFreebeatClient(redirect, requestedScope) {
  // Cloudflare Workers' fetch() sends NO User-Agent by default (unlike
  // Node/browser fetch or curl). This was already found to matter for
  // Freebeat's media CDN, which rejects empty-UA requests with a 403 (see
  // UPSTREAM_MEDIA_USER_AGENT in safeUrl.js). All 3 registration attempts
  // below previously failed identically with OAuth code `server_error`
  // regardless of grant_types -- a result fully consistent with something
  // constant across every attempt (like a missing User-Agent, possibly
  // blocked/mishandled by a WAF or bot-protection layer in front of
  // Freebeat's OAuth endpoint) being the actual blocker, not the payload
  // shape. Identify every Freebeat OAuth request the same way the media
  // proxy already does.
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': UPSTREAM_MEDIA_USER_AGENT };
  const base = { client_name: 'BLEA AI (uji MCP)', redirect_uris: [redirect], token_endpoint_auth_method: 'none', response_types: ['code'], scope: requestedScope };
  const fullGrants = ['authorization_code', 'refresh_token'];
  const noRefreshGrants = ['authorization_code'];
  const attempts = [
    { grant_types: fullGrants, delayMs: 0, note: null },
    { grant_types: fullGrants, delayMs: 400, note: null },
    { grant_types: noRefreshGrants, delayMs: 0, note: 'falling back to a client without the refresh_token grant (sessions will need to reconnect more often)' },
  ];
  let lastError = null;
  for (const attempt of attempts) {
    if (attempt.delayMs) await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
    try {
      return await jsonFetch(REGISTER, { method: 'POST', headers, body: JSON.stringify({ ...base, grant_types: attempt.grant_types }) }, 'register');
    } catch (err) {
      lastError = err;
      if (err?.freebeatKind !== 'http' || err?.freebeatOauthCode !== 'server_error') throw err;
      console.warn(`Freebeat OAuth registration returned server_error${attempt.note ? `, ${attempt.note}` : ', retrying'}`);
    }
  }
  throw lastError;
}

export async function startFreebeat(env, userId, options = {}) {
  await key(env);
  const redirect = redirectUri(env);
  const opts = normalizeStartOptions(options);
  const requestedScope = `${READ_SCOPE} ${IMAGE_SCOPE}`;
  const registration = await registerFreebeatClient(redirect, requestedScope);
  if (typeof registration.client_id !== 'string' || !registration.client_id || registration.client_id.length > 500) throw fail('Registrasi klien Freebeat tidak mengembalikan client ID yang valid.');
  const state = random(), verifier = random();
  const challenge = b64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)));
  const sealed = await seal({
    uid: userId,
    clientId: registration.client_id,
    state,
    verifier,
    redirect,
    requestedScope,
    ...(opts.email ? { accountEmail: opts.email } : {}),
    ...(opts.label ? { accountLabel: opts.label } : {}),
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
    ...(opts.returnTo ? { returnTo: opts.returnTo } : {}),
    created: Date.now(),
  }, env, 'pending');
  if (sealed.length > 3800) throw fail('Data sesi Freebeat terlalu besar.', 503);
  const auth = new URL(AUTH);
  for (const [name, value] of Object.entries({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirect, state, code_challenge: challenge, code_challenge_method: 'S256', scope: requestedScope, resource: ENDPOINT })) auth.searchParams.set(name, value);
  return response({ url: auth.toString() }, 200, { 'set-cookie': cookie(PENDING, sealed, 600) });
}

export async function freebeatCallback(request, env) {
  const url = new URL(request.url);
  let baseRedirect;
  try { baseRedirect = redirectUri(env); }
  catch { return response({ error: 'Konfigurasi callback Freebeat tidak valid.' }, 503); }
  const headers = new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'set-cookie': cookie(PENDING, '', 0) });
  const buildDest = (result, returnPath = '/admin/freebeat') => {
    const safePath = FREEBEAT_ALLOWED_RETURNS.has(returnPath) ? returnPath : '/admin/freebeat';
    const dest = new URL(safePath, baseRedirect);
    dest.searchParams.set('freebeat', result);
    return dest.toString();
  };
  let callbackReturnTo = '/admin/freebeat';
  const finish = (result) => { headers.set('location', buildDest(result, callbackReturnTo)); return new Response(null, { status: 303, headers }); };
  try {
    const pending = await unseal(cookieValue(request, PENDING), env, 'pending');
    if (pending?.returnTo && FREEBEAT_ALLOWED_RETURNS.has(pending.returnTo)) callbackReturnTo = pending.returnTo;
    if (!pending || !pending.uid || !pending.verifier || !pending.clientId || pending.redirect !== baseRedirect || !Number.isFinite(pending.created) || Date.now() - pending.created > 600000 || pending.created > Date.now() + 30000 || !url.searchParams.get('state') || url.searchParams.get('state') !== pending.state) return finish('invalid');
    const requestedScope = pending.requestedScope || READ_SCOPE; // Pending sessions created before this change were read-only.
    if (![READ_SCOPE, `${READ_SCOPE} ${IMAGE_SCOPE}`].includes(requestedScope)) return finish('invalid');
    if (url.searchParams.get('error')) return finish('denied');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4000) return finish('invalid');
    const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.clientId, code, redirect_uri: pending.redirect, code_verifier: pending.verifier, resource: ENDPOINT });
    const tokens = await jsonFetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': UPSTREAM_MEDIA_USER_AGENT }, body: body.toString() }, 'token');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 2000 || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) return finish('failed');
    // RFC 6749: omitted scope means the granted scope matches what was requested.
    const grantedScope = tokens.scope === undefined ? requestedScope : tokens.scope;
    if (typeof grantedScope !== 'string' || grantedScope.length > 1000) return finish('failed');
    const granted = new Set(grantedScope.split(/\s+/).filter(Boolean));
    if (!granted.has(READ_SCOPE)) return finish('failed');
    const imageAccess = requestedScope.includes(IMAGE_SCOPE) && granted.has(IMAGE_SCOPE);
    const lifetime = Math.min(86400, Number(tokens.expires_in) || 300);
    if (lifetime < 1) return finish('failed');
    const now = Date.now();
    const oauthIdentity = await resolveFreebeatOAuthIdentity(tokens);
    const manualEmail = typeof pending.accountEmail === 'string' ? pending.accountEmail.trim().slice(0, 320) : '';
    const resolvedEmail = String(oauthIdentity.email || manualEmail || '').trim().slice(0, 320);
    const emailSource = oauthIdentity.email ? 'oauth' : (manualEmail ? 'manual' : 'unverified');
    const targetAccountId = typeof pending.accountId === 'string' && TEST_ID.test(pending.accountId) ? pending.accountId : null;
    const encrypted = await seal({
      ...(targetAccountId ? { accountId: targetAccountId } : {}),
      ...(resolvedEmail ? { accountEmail: resolvedEmail } : {}),
      ...(oauthIdentity.subject ? { oauthSubject: oauthIdentity.subject } : {}),
      ...(resolvedEmail || manualEmail || targetAccountId ? { emailSource } : {}),
      uid: pending.uid,
      sid: crypto.randomUUID(),
      accessToken: tokens.access_token,
      refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : null,
      clientId: pending.clientId,
      imageAccess,
      issuedAt: now,
      expiresAt: now + lifetime * 1000,
    }, env, 'session');
    if (encrypted.length > 3800) return finish('failed');
    headers.append('set-cookie', cookie(SESSION, encrypted, SESSION_COOKIE_AGE));
    // Salinan sisi server agar generate gambar konsumen dapat memakai provider
    // ini tanpa bergantung pada cookie browser admin.
    await persistProviderSession(env, pending.uid, encrypted, imageAccess);
    await upsertPoolOAuthAccount(env, {
      id: targetAccountId,
      accountEmail: resolvedEmail,
      accountLabel: pending.accountLabel || '',
      oauthSubject: oauthIdentity.subject,
      emailSource,
      connectedBy: pending.uid,
      sealedSession: encrypted,
      imageAccess,
      issuedAt: new Date(now).toISOString(),
    });
    return finish(requestedScope.includes(IMAGE_SCOPE) && !imageAccess ? 'connected-limited' : 'connected');
  } catch (error) {
    const kind = error?.freebeatKind;
    return finish(['network', 'timeout', 'redirect', 'http', 'response'].includes(kind) ? `failed-${kind}` : 'failed');
  }
}

// Sesi BLEA harus bertahan jauh melampaui umur access token Freebeat: cookie
// ini memuat refresh token tersegel, jadi umurnya mengikuti refresh token,
// bukan access token. Sebelumnya Max-Age disetel = umur access token (<=1 jam),
// sehingga browser menghapus cookie dan koneksi "terputus" tiap jam.
const SESSION_COOKIE_AGE = 30 * 24 * 60 * 60;
const REFRESH_WINDOW = 15 * 60 * 1000;
function sessionMaxAgeMs(env) {
  const days = Number(env?.FREEBEAT_SESSION_MAX_DAYS);
  const bounded = Number.isFinite(days) && days >= 1 && days <= 365 ? days : 30;
  return bounded * 24 * 60 * 60 * 1000;
}
const sessionCookies = new WeakMap();
async function renewSession(session, env) {
  const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource: ENDPOINT });
  const tokens = await jsonFetch(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': UPSTREAM_MEDIA_USER_AGENT }, body: body.toString() }, 'token');
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 2000 || (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer')) return null;
  const lifetime = Math.min(86400, Number(tokens.expires_in) || 300);
  if (lifetime < 1) return null;
  return { ...session, accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' && tokens.refresh_token ? tokens.refresh_token : session.refreshToken, expiresAt: Date.now() + lifetime * 1000 };
}
const refreshFlights = new Map();
// Freebeat merotasi refresh token. Bila dua request me-refresh dengan refresh
// token yang sama (cookie admin dan jalur konsumen, atau dua poll paralel),
// provider mencabut seluruh grant dan SEMUA panggilan berikutnya ditolak
// [FB-MCP-INIT-HTTP]. Karena itu refresh dikunci per akun pool (atau per user),
// selalu memeriksa salinan database lebih dulu, dan hanya menulis bila lebih baru.
async function renewAndPersist(session, env, source) {
  const key = session.accountId
    ? `acct:${session.accountId}`
    : (typeof session.uid === 'string' && session.uid ? `uid:${session.uid}` : 'anon');
  const inflight = refreshFlights.get(key);
  if (inflight) return inflight;
  const flight = (async () => {
    const startedAt = Date.now();
    const adoptStored = async (stored) => {
      const sealedStored = await seal({ ...stored }, env, 'session');
      return { session: stored, sealed: sealedStored.length <= 3800 ? sealedStored : null };
    };
    const storedBefore = await readDbSession(env, session.uid, session.accountId || null);
    if (storedBefore && Number.isFinite(storedBefore.expiresAt) && storedBefore.expiresAt > (session.expiresAt || 0) && storedBefore.expiresAt - Date.now() > REFRESH_WINDOW) {
      console.info('Freebeat refresh dilewati: salinan lain lebih baru', { source });
      return adoptStored(storedBefore);
    }
    const renewed = await renewSession(session, env);
    if (!renewed) { console.warn('Freebeat refresh ditolak provider', { source }); return null; }
    const issuedAt = Number.isFinite(session.issuedAt) ? session.issuedAt : startedAt;
    const storedAfter = await readDbSession(env, renewed.uid, renewed.accountId || null);
    if (storedAfter && Number.isFinite(storedAfter.expiresAt) && storedAfter.expiresAt >= renewed.expiresAt) {
      console.info('Freebeat refresh tidak disimpan: salinan lain lebih baru', { source });
      return adoptStored(storedAfter);
    }
    const encrypted = await seal({
      ...(renewed.accountId ? { accountId: renewed.accountId } : {}),
      ...(renewed.accountEmail ? { accountEmail: renewed.accountEmail } : {}),
      uid: renewed.uid,
      sid: renewed.sid || crypto.randomUUID(),
      accessToken: renewed.accessToken,
      refreshToken: renewed.refreshToken,
      clientId: renewed.clientId,
      imageAccess: renewed.imageAccess,
      issuedAt,
      expiresAt: renewed.expiresAt,
    }, env, 'session');
    if (encrypted.length > 3800) return null;
    if (renewed.accountId) {
      await updatePoolAccountSession(env, renewed.accountId, encrypted, renewed.imageAccess === true);
    }
    if (renewed.uid) {
      await persistProviderSession(env, renewed.uid, encrypted, renewed.imageAccess === true);
    }
    console.info('Freebeat token di-refresh', { source, umur_grant_detik: Math.round((startedAt - issuedAt) / 1000), berlaku_detik: Math.round((renewed.expiresAt - startedAt) / 1000) });
    return { session: renewed, sealed: encrypted };
  })();
  refreshFlights.set(key, flight);
  try { return await flight; } finally { refreshFlights.delete(key); }
}
// Handshake MCP sekali, dengan satu percobaan ulang memakai salinan sesi
// terbaru: request lain mungkin baru saja me-rotasi token yang kita pegang.
async function openMcpSession(env, session) {
  try {
    return { headers: await openMcp(session.accessToken), session };
  } catch (error) {
    // Retry only a rejected handshake, never a paid tools/call, timeout, or
    // arbitrary account from the provider pool. Do not force OAuth rotation.
    if (!error?.isMcpFailure || ![401, 403].includes(error.httpStatus)) throw error;
    const fresh = await readDbSession(env, session.uid, session.accountId || null);
    if (!fresh?.accessToken || fresh.accessToken === session.accessToken
      || fresh.uid !== session.uid || (session.accountId && fresh.accountId !== session.accountId)
      || fresh.expiresAt <= Date.now()
      || Date.now() - (fresh.issuedAt ?? fresh.expiresAt) > sessionMaxAgeMs(env)) throw error;
    console.warn('Freebeat MCP init ditolak; memakai salinan sesi terbaru');
    return { headers: await openMcp(fresh.accessToken), session: fresh };
  }
}
// Salinan sesi di database dapat lebih baru daripada cookie: jalur generate
// konsumen me-refresh token lewat salinan itu, dan Freebeat merotasi refresh
// token. Tanpa adopsi salinan terbaru, cookie admin memakai token yang sudah
// dicabut dan seluruh panggilan MCP ditolak [FB-MCP-INIT-HTTP].
async function readDbSession(env, userId, accountId = null) {
  try {
    if (accountId) {
      const poolRows = await dbJson(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(accountId)}&select=id,account_email,sealed_session&limit=1`);
      const poolRow = Array.isArray(poolRows) ? poolRows[0] : null;
      if (poolRow?.sealed_session) {
        const s = await unseal(poolRow.sealed_session, env, 'session', 3800);
        if (s && s.uid === userId && (!s.accountId || s.accountId === poolRow.id) && typeof s.accessToken === 'string' && Number.isFinite(s.expiresAt)) {
          return { ...s, accountId: poolRow.id, accountEmail: poolRow.account_email || s.accountEmail || '' };
        }
      }
      // A cookie bound to one pool account must not adopt another account's
      // legacy session when that account is missing or no longer usable.
      return null;
    }
    const rows = await dbJson(env, `/freebeat_provider_sessions?user_id=eq.${encodeURIComponent(userId)}&select=sealed_session&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.sealed_session) return null;
    const session = await unseal(row.sealed_session, env, 'session', 3800);
    if (!session || session.uid !== userId || typeof session.accessToken !== 'string' || !Number.isFinite(session.expiresAt)) return null;
    return session;
  } catch { return null; }
}
async function readSession(request, env, userId) {
  const usable = (value) => value && value.uid === userId && typeof value.accessToken === 'string' && Number.isFinite(value.expiresAt);
  const cookieSession = await unseal(cookieValue(request, SESSION), env, 'session');
  let session = usable(cookieSession) ? cookieSession : null;
  const dbSession = await readDbSession(env, userId, session?.accountId || null);
  if (usable(dbSession) && (!session || dbSession.expiresAt > session.expiresAt
    || (dbSession.expiresAt === session.expiresAt && dbSession.accessToken !== session.accessToken))) {
    session = dbSession;
    try {
      const sealed = await seal({
        ...(dbSession.accountId ? { accountId: dbSession.accountId } : {}),
        ...(dbSession.accountEmail ? { accountEmail: dbSession.accountEmail } : {}),
        uid: dbSession.uid,
        sid: dbSession.sid || crypto.randomUUID(),
        accessToken: dbSession.accessToken,
        refreshToken: dbSession.refreshToken,
        clientId: dbSession.clientId,
        imageAccess: dbSession.imageAccess === true,
        issuedAt: Number.isFinite(dbSession.issuedAt) ? dbSession.issuedAt : Date.now(),
        expiresAt: dbSession.expiresAt,
      }, env, 'session');
      if (sealed.length <= 3800) sessionCookies.set(request, cookie(SESSION, sealed, SESSION_COOKIE_AGE));
    } catch { /* cookie lama tetap dipakai; DB sudah menjadi sumber kebenaran */ }
  }
  if (!session) return null;
  // Umur maksimum sejak consent, agar refresh token tidak hidup selamanya.
  const issuedAt = Number.isFinite(session.issuedAt) ? session.issuedAt : session.expiresAt;
  if (Date.now() - issuedAt > sessionMaxAgeMs(env)) return null;
  const expired = session.expiresAt <= Date.now();
  // Access token yang sudah kedaluwarsa BUKAN sesi mati: refresh token masih
  // berlaku dan harus dipakai. Sebelumnya kondisi ini langsung return null,
  // sehingga admin dipaksa consent ulang setiap kali sempat idle.
  if ((!expired && session.expiresAt - Date.now() > REFRESH_WINDOW) || !session.refreshToken) return expired ? null : session;
  // Silent renewal keeps ONE Freebeat connection (and therefore one provider
  // API key) alive instead of pushing admins through consent again every hour.
  // A failed renewal must NEVER drop a still-valid session: Freebeat's token
  // endpoint can refuse or time out while the current access token keeps
  // working until its own expiry. Worst case we retry on the next request.
  try {
    const outcome = await renewAndPersist(session, env, 'cookie');
    if (!outcome?.session) return expired ? null : session;
    if (outcome.sealed) sessionCookies.set(request, cookie(SESSION, outcome.sealed, SESSION_COOKIE_AGE));
    return outcome.session;
  } catch {
    return expired ? null : session;
  }
}

// Codes and log fields are fixed; never expose errors, response bodies, headers, URLs or tokens from Freebeat.
function mcpFailure(stage, kind, status) {
  const tag = `[FB-MCP-${stage.toUpperCase()}-${kind.toUpperCase()}]`;
  const message = kind === 'timeout' ? 'MCP Freebeat tidak merespons dalam 15 detik.'
    : kind === 'network' ? 'Worker tidak dapat terhubung ke MCP Freebeat.'
      : kind === 'redirect' ? 'MCP Freebeat mengirim pengalihan yang ditolak demi keamanan.'
        : kind === 'http' && (status === 401 || status === 403) ? 'Freebeat menolak akses. Hubungkan ulang atau periksa akses akun/plan.'
          : kind === 'http' && status === 402 ? 'Saldo akun Freebeat habis. [FB-MCP-HTTP-402]'
            : kind === 'http' ? `MCP Freebeat menolak permintaan (HTTP ${status}).`
              : kind === 'size' ? 'Respons MCP Freebeat terlalu besar.'
                : kind === 'rpc' ? 'Freebeat menolak atau tidak mendukung permintaan MCP.'
                  : 'Respons MCP Freebeat tidak valid atau tidak didukung.';
  console.warn('Freebeat MCP request failed', { stage, kind, ...(Number.isInteger(status) ? { status } : {}) });
  return Object.assign(fail(status === 402 ? message : `${message} ${tag}`, kind === 'http' && status === 401 ? 401 : 502), {
    isMcpFailure: true,
    freebeatKind: kind,
    ...(Number.isInteger(status) ? { httpStatus: status } : {}),
    ...(status === 402 ? { balanceExhausted: true } : {}),
  });
}

function rpcObject(text, expectedId, stage, captureToolError = false) {
  let object;
  try { object = JSON.parse(text); } catch { return null; }
  if (!object || typeof object !== 'object' || Array.isArray(object) || object.id !== expectedId) return null;
  if (object.error) {
    if (captureToolError) return { isError: true, error: object.error };
    const err = mcpFailure(stage, 'rpc');
    if (isFreebeatBalanceExhausted(object.error)) err.balanceExhausted = true;
    throw err;
  }
  if (!object.result || typeof object.result !== 'object' || (object.result.isError && !captureToolError)) {
    const err = mcpFailure(stage, 'rpc');
    if (object.result && isFreebeatBalanceExhausted(object.result)) err.balanceExhausted = true;
    throw err;
  }
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
    res = await fetch(ENDPOINT, { method: 'POST', redirect: 'manual', signal, headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': UPSTREAM_MEDIA_USER_AGENT, ...extraHeaders }, body: JSON.stringify(body) });
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
async function getBalance(accessToken, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const call = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_credit_balance', arguments: {} } }, 'balance', headers);
  const data = call.result.structuredContent ?? call.result.content;
  if (!data) throw mcpFailure('balance', 'response');
  return data;
}
async function readMcpAccountBalance(accessToken, headers) {
  try {
    const call = await rpc(
      accessToken,
      { jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'get_credit_balance', arguments: {} } },
      'balance',
      headers,
      65536,
    );
    const data = call?.result?.structuredContent ?? call?.result?.content ?? null;
    return { credits: extractNumericBalance(data), payload: data };
  } catch {
    return { credits: null, payload: null };
  }
}
const CONFIRMATION_HINT_REGEX = /confirm|continue|proceed|credit|balance|cost|charge|top[\s_-]?up|recharge|upgrade|plan|konfirmasi|lanjut|saldo|kredit|biaya/i;
function sessionHasConfirmationPrompt(payload, depth = 0) {
  if (!payload || depth > 5) return false;
  if (typeof payload === 'string') return CONFIRMATION_HINT_REGEX.test(payload);
  if (Array.isArray(payload)) return payload.slice(0, 20).some((item) => sessionHasConfirmationPrompt(item, depth + 1));
  if (typeof payload !== 'object') return false;
  for (const k of ['messages', 'events', 'items', 'message', 'status_message', 'pending_action', 'action_reason', 'prompt', 'question', 'reply', 'description', 'text', 'content', 'structuredContent']) {
    if (k in payload && sessionHasConfirmationPrompt(payload[k], depth + 1)) return true;
  }
  return false;
}

// Only structural metadata for these image tools is returned; provider descriptions,
// examples, URLs, default values and unrelated tools are deliberately omitted.
const IMAGE_TOOLS = new Set(['list_models', 'get_model_help', 'quote_generation', 'generate_image', 'edit_image', 'upload_image', 'get_task_status']);
const VIDEO_TOOLS = new Set(['list_models', 'get_model_help', 'quote_generation', 'generate_video', 'get_task_status']);
const DANCE_TOOLS = new Set(['upload_audio', 'upload_image', 'quote_generation', 'generate_dance_video', 'get_task_status', 'get_task_result', 'get_video_session', 'send_video_agent_message']);
const VOCAL_VIDEO_TOOLS = new Set([
  'generate_singing_video',
  'generate_lip_sync_video',
  'upload_video',
  'upload_audio',
  'upload_image',
  'quote_generation',
  'get_task_status',
  'get_task_result',
  'get_video_session',
  'send_video_agent_message',
]);
const VOCAL_VIDEO_PRIMARY_TOOLS = ['generate_singing_video', 'generate_lip_sync_video', 'upload_video', 'upload_audio', 'upload_image'];
const REMAINING_PRIMARY_TOOLS = [
  'list_music_models',
  'generate_music',
  'generate_music_video',
  'generate_lyric_video',
  'list_effects',
  'generate_effect',
  'generate_text',
];
const REMAINING_TOOLS = new Set([
  ...REMAINING_PRIMARY_TOOLS,
  'quote_generation',
]);
const SAFE_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null']);
const SAFE_SCHEMA_ENUMS = new Set(['image', 'image_edit', 'generate_image', 'generate_video', 'text', 'video', 'transition', 'reference']);
const SAFE_DANCE_SCHEMA_ENUMS = new Set([...SAFE_SCHEMA_ENUMS, 'generate_dance_video', 'upload_audio', '16:9', '9:16', '1:1', '4:3', '3:4', '720p']);
const SAFE_VOCAL_VIDEO_SCHEMA_ENUMS = new Set([
  ...SAFE_DANCE_SCHEMA_ENUMS,
  'generate_singing_video',
  'generate_lip_sync_video',
  'upload_video',
  'upload_image',
  '480p',
  '1080p',
  '2k',
  '4k',
  'auto',
  'standard',
  'pro',
  'fast',
  'normal',
  'high',
  'low',
  'portrait',
  'landscape',
  'square',
  'male',
  'female',
  'solo',
  'duet',
  'singing',
  'lip_sync',
  'lipsync',
  '21:9',
]);
const SAFE_REMAINING_SCHEMA_ENUMS = new Set([
  ...SAFE_VOCAL_VIDEO_SCHEMA_ENUMS,
  ...REMAINING_PRIMARY_TOOLS,
  'custom',
  'instrumental',
  'vocal',
  'lyrics',
  'lyric',
  'manual',
  'quality',
  'balanced',
  'effect',
  'music',
  'music_video',
  'lyric_video',
  'json',
  'markdown',
]);
function schemaName(value) { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value); }
function imageSchema(schema, depth = 0, allowedEnums = SAFE_SCHEMA_ENUMS) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 5) return {};
  const out = {};
  if (SAFE_SCHEMA_TYPES.has(schema.type)) out.type = schema.type;
  if (Array.isArray(schema.required)) out.required = schema.required.filter(schemaName).slice(0, 50);
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => schemaName(name)).slice(0, 50).map(([name, child]) => [name, imageSchema(child, depth + 1, allowedEnums)]));
  }
  if (schema.items && typeof schema.items === 'object') out.items = imageSchema(schema.items, depth + 1, allowedEnums);
  for (const name of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(schema[name])) out[name] = schema[name].slice(0, 8).map((child) => imageSchema(child, depth + 1, allowedEnums));
  if (Array.isArray(schema.enum)) {
    out.known_enum_values = schema.enum.filter((item) => allowedEnums.has(item)).slice(0, 20);
    out.enum_incomplete = out.known_enum_values.length !== schema.enum.length;
  }
  return out;
}

function sanitizeDetailedSchemaValue(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return privateFailureReason(value)?.slice(0, 200) ?? '';
  if (Array.isArray(value)) {
    if (depth >= 3) return [];
    return value.slice(0, 20).map((item) => sanitizeDetailedSchemaValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth >= 3) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => schemaName(name) && !/secret|token|password|credential|key|auth|cookie/i.test(name))
        .slice(0, 20)
        .map(([name, child]) => [name, sanitizeDetailedSchemaValue(child, depth + 1)]),
    );
  }
  return null;
}

function detailedToolSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 6) return {};
  const out = {};
  if (SAFE_SCHEMA_TYPES.has(schema.type)) out.type = schema.type;
  if (typeof schema.description === 'string') {
    const clean = privateFailureReason(schema.description);
    if (clean) out.description = clean.slice(0, 500);
  }
  if (Array.isArray(schema.required)) out.required = schema.required.filter(schemaName).slice(0, 50);
  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .filter(([name]) => schemaName(name))
        .slice(0, 50)
        .map(([name, child]) => [name, detailedToolSchema(child, depth + 1)]),
    );
  }
  if (schema.items && typeof schema.items === 'object') out.items = detailedToolSchema(schema.items, depth + 1);
  for (const name of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[name])) out[name] = schema[name].slice(0, 8).map((child) => detailedToolSchema(child, depth + 1));
  }
  if (typeof schema.additionalProperties === 'boolean') out.additionalProperties = schema.additionalProperties;
  for (const bound of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (typeof schema[bound] === 'number' && Number.isFinite(schema[bound])) out[bound] = schema[bound];
  }
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum.slice(0, 50).map((item) => sanitizeDetailedSchemaValue(item, 1));
  }
  if (schema.default !== undefined) out.default = sanitizeDetailedSchemaValue(schema.default, 0);
  return out;
}

async function getToolSchemas(accessToken, allowedTools, allowedEnums = SAFE_SCHEMA_ENUMS) {
  const headers = await openMcp(accessToken);
  const tools = new Map();
  const cursors = new Set();
  let cursor;
  let truncated = false;
  for (let page = 0; page < 5; page += 1) {
    const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params: cursor ? { cursor } : {} }, 'inspect', headers, 262144);
    if (!Array.isArray(result.tools)) throw mcpFailure('inspect', 'response');
    for (const tool of result.tools) if (tool && allowedTools.has(tool.name) && !tools.has(tool.name)) tools.set(tool.name, imageSchema(tool.inputSchema, 0, allowedEnums));
    if (!result.nextCursor) break;
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw mcpFailure('inspect', 'response');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
    if (page === 4) truncated = true;
  }
  return { tools: Object.fromEntries(tools), truncated };
}

async function inspectMcpToolSchemas(accessToken, { allowedTools, primaryTools, safeEnums, acknowledge = false }) {
  const headers = await openMcp(accessToken);
  const tools = new Map();
  const availableTools = [];
  const seenNames = new Set();
  const cursors = new Set();
  let cursor;
  let truncated = false;
  for (let page = 0; page < 5; page += 1) {
    const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: page + 2, method: 'tools/list', params: cursor ? { cursor } : {} }, 'inspect', headers, 262144);
    if (!Array.isArray(result.tools)) throw mcpFailure('inspect', 'response');
    for (const tool of result.tools) {
      if (!tool || typeof tool.name !== 'string') continue;
      if (schemaName(tool.name) && !/secret|token|password|credential/i.test(tool.name) && !seenNames.has(tool.name) && availableTools.length < 100) {
        seenNames.add(tool.name);
        availableTools.push(tool.name);
      }
      if (allowedTools.has(tool.name) && !tools.has(tool.name)) {
        if (acknowledge) {
          const schemaObj = detailedToolSchema(tool.inputSchema, 0);
          const desc = typeof tool.description === 'string' ? privateFailureReason(tool.description) : null;
          if (desc) schemaObj.tool_description = desc.slice(0, 1000);
          tools.set(tool.name, schemaObj);
        } else {
          tools.set(tool.name, imageSchema(tool.inputSchema, 0, safeEnums));
        }
      }
    }
    if (!result.nextCursor) break;
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) throw mcpFailure('inspect', 'response');
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
    if (page === 4) truncated = true;
  }
  return {
    mode: acknowledge ? 'detailed' : 'safe',
    tools: Object.fromEntries(tools),
    available_tools: availableTools,
    missing_tools: primaryTools.filter((name) => !tools.has(name)),
    truncated,
  };
}

function getVocalVideoSchemas(accessToken, { acknowledge = false } = {}) {
  return inspectMcpToolSchemas(accessToken, {
    allowedTools: VOCAL_VIDEO_TOOLS,
    primaryTools: VOCAL_VIDEO_PRIMARY_TOOLS,
    safeEnums: SAFE_VOCAL_VIDEO_SCHEMA_ENUMS,
    acknowledge,
  });
}

function getRemainingToolSchemas(accessToken, { acknowledge = false } = {}) {
  return inspectMcpToolSchemas(accessToken, {
    allowedTools: REMAINING_TOOLS,
    primaryTools: REMAINING_PRIMARY_TOOLS,
    safeEnums: SAFE_REMAINING_SCHEMA_ENUMS,
    acknowledge,
  });
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
async function getModels(accessToken, type, existingHeaders = null) {
  if (!['image', 'image_edit', 'video', 'text'].includes(type)) throw mcpFailure('models', 'response');
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_models', arguments: { type } } }, 'models', headers, 262144);
  const content = modelContent(result);
  const list = Array.isArray(content) ? content : content?.models ?? content?.items ?? content?.data?.models ?? content?.data?.items ?? (Array.isArray(content?.data) ? content.data : null);
  if (!Array.isArray(list)) throw mcpFailure('models', 'response');
  const models = list.slice(0, 100).flatMap((item) => {
    if (type === 'text' && typeof item === 'string' && safeModelId(item.trim()) && !/[\x00-\x1f\x7f]/.test(item)) {
      const clean = item.trim();
      return [{ model_id: clean, name: clean, member_only: false, available: true }];
    }
    if (!item || typeof item !== 'object') return [];
    const id = item.model_id ?? item.modelId ?? item.id ?? (type === 'text' ? item.name : undefined);
    const name = item.display_name ?? item.displayName ?? item.name ?? (type === 'text' && typeof id === 'string' ? id : undefined);
    if (!safeModelId(id) || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) return [];
    return [{ model_id: id, name, member_only: item.member_only === true, available: item.available !== false }];
  });
  if (list.length && !models.length) throw mcpFailure('models', 'response');
  return { models, truncated: list.length > 100 };
}

const CATALOG_MEDIA_URL_KEYS = new Set(['image_url', 'cover_url', 'thumbnail_url', 'preview_url', 'preview_video_url', 'video_url', 'audio_url', 'url']);
const CATALOG_MEDIA_LIST_KEYS = new Set(['reference_image_urls', 'image_urls', 'images']);
function sanitizeCatalogPayload(value, depth = 0, parentKey = '') {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (CATALOG_MEDIA_URL_KEYS.has(parentKey) || CATALOG_MEDIA_LIST_KEYS.has(parentKey)) {
      return safeImageUrl(value);
    }
    return privateFailureReason(value)?.slice(0, 500) ?? '';
  }
  if (Array.isArray(value)) {
    if (depth >= 5) return [];
    return value.slice(0, 100).map((item) => sanitizeCatalogPayload(item, depth + 1, parentKey));
  }
  if (typeof value === 'object') {
    if (depth >= 5) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => (
          typeof name === 'string'
          && /^[A-Za-z0-9_.:-]{1,80}$/.test(name)
          && !['__proto__', 'constructor', 'prototype'].includes(name)
          && !/secret|token|password|credential|auth|cookie|api[_-]?key|private[_-]?key/i.test(name)
        ))
        .slice(0, 50)
        .map(([name, child]) => [name, sanitizeCatalogPayload(child, depth + 1, name)]),
    );
  }
  return null;
}
function extractCatalogList(content, preferredKey = null) {
  if (Array.isArray(content)) return content;
  if (!content || typeof content !== 'object') return null;
  if (preferredKey && Array.isArray(content[preferredKey])) return content[preferredKey];
  for (const key of ['models', 'effects', 'items', 'results', 'list', 'data']) {
    if (Array.isArray(content[key])) return content[key];
  }
  if (preferredKey && Array.isArray(content.data?.[preferredKey])) return content.data[preferredKey];
  for (const key of ['models', 'effects', 'items', 'results', 'list']) {
    if (Array.isArray(content.data?.[key])) return content.data[key];
  }
  return null;
}
function safeTextModelId(id) {
  return (Number.isSafeInteger(id) && id >= 0) || (typeof id === 'string' && /^[A-Za-z0-9_.:\/-]{1,120}$/.test(id));
}
async function getTextModels(accessToken, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_models', arguments: { type: 'text' } },
  }, 'models', headers, 262144);
  if (result?.isError || result?.error) throw mcpFailure('models', 'rpc');
  const content = modelContent(result);
  if (content !== null) {
    const safeData = sanitizeCatalogPayload(content);
    const list = extractCatalogList(content, 'text_models');
    const models = Array.isArray(list) ? list.slice(0, 100).flatMap((item) => {
      if (typeof item === 'string' && safeTextModelId(item.trim()) && !/[\x00-\x1f\x7f]/.test(item)) {
        const clean = item.trim();
        return [{ model_id: clean, name: clean, member_only: false, available: true }];
      }
      if (!item || typeof item !== 'object') return [];
      const id = item.model ?? item.model_id ?? item.modelId ?? item.id ?? item.name;
      const name = item.display_name ?? item.displayName ?? item.name ?? item.model ?? (typeof id === 'string' ? id : undefined);
      if (!safeTextModelId(id) || typeof name !== 'string' || !name.trim() || name.length > 200 || /[\x00-\x1f\x7f]/.test(name)) return [];
      return [{ model_id: id, name: name.trim(), member_only: item.member_only === true, available: item.available !== false }];
    }) : [];
    let schema;
    if (!models.length) {
      try {
        schema = (await getToolSchemas(accessToken, new Set(['list_models']), new Set(['image', 'image_edit', 'video', 'text', 'audio', 'music', 'effects', 'effect']))).tools?.list_models ?? null;
      } catch { schema = null; }
    }
    return {
      catalog: 'text',
      models,
      truncated: Array.isArray(list) && list.length > 100,
      ...(models.length === 0 ? { data: safeData, ...(schema !== undefined ? { schema } : {}) } : {}),
    };
  }
  const rawText = Array.isArray(result.content) ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text : null;
  if (!rawText) throw mcpFailure('models', 'response');
  let schema;
  try {
    schema = (await getToolSchemas(accessToken, new Set(['list_models']), new Set(['image', 'image_edit', 'video', 'text', 'audio', 'music', 'effects', 'effect']))).tools?.list_models ?? null;
  } catch { schema = null; }
  return {
    catalog: 'text',
    models: [],
    truncated: false,
    data: { text: privateFailureReason(rawText)?.slice(0, 2000) ?? '' },
    ...(schema !== undefined ? { schema } : {}),
  };
}
async function getMusicModels(accessToken, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_music_models', arguments: {} },
  }, 'models', headers, 262144);
  if (result?.isError || result?.error) throw mcpFailure('models', 'rpc');
  const content = modelContent(result);
  if (content !== null) {
    const safeData = sanitizeCatalogPayload(content);
    const list = extractCatalogList(safeData, 'models');
    return {
      catalog: 'music',
      count: Array.isArray(list) ? list.length : null,
      truncated: Array.isArray(extractCatalogList(content, 'models')) && extractCatalogList(content, 'models').length > 100,
      data: safeData,
    };
  }
  const rawText = Array.isArray(result.content) ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text : null;
  if (!rawText) throw mcpFailure('models', 'response');
  return { catalog: 'music', count: null, truncated: false, data: { text: privateFailureReason(rawText)?.slice(0, 2000) ?? '' } };
}
function parseEffectsListInput(input) {
  if (input === undefined || input === null) return { page: 1, page_size: 20 };
  if (typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['page', 'page_size'].includes(k))) {
    throw fail('Parameter list_effects tidak valid.', 400);
  }
  let page = 1;
  if (input.page !== undefined) {
    if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 50) {
      throw fail('page harus berupa bilangan bulat antara 1 dan 50.', 400);
    }
    page = input.page;
  }
  let page_size = 20;
  if (input.page_size !== undefined) {
    if (!Number.isSafeInteger(input.page_size) || input.page_size < 1 || input.page_size > 100) {
      throw fail('page_size harus berupa bilangan bulat antara 1 dan 100.', 400);
    }
    page_size = input.page_size;
  }
  return { page, page_size };
}
async function getEffectsCatalog(accessToken, input = {}, existingHeaders = null) {
  const { page, page_size } = parseEffectsListInput(input);
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_effects', arguments: { page, page_size } },
  }, 'models', headers, 262144);
  if (result?.isError || result?.error) throw mcpFailure('models', 'rpc');
  const content = modelContent(result);
  if (content !== null) {
    const safeData = sanitizeCatalogPayload(content);
    const list = extractCatalogList(safeData, 'effects');
    return {
      catalog: 'effects',
      page,
      page_size,
      count: Array.isArray(list) ? list.length : null,
      truncated: Array.isArray(extractCatalogList(content, 'effects')) && extractCatalogList(content, 'effects').length > 100,
      data: safeData,
    };
  }
  const rawText = Array.isArray(result.content) ? result.content.find((item) => item?.type === 'text' && typeof item.text === 'string')?.text : null;
  if (!rawText) throw mcpFailure('models', 'response');
  return { catalog: 'effects', page, page_size, count: null, truncated: false, data: { text: privateFailureReason(rawText)?.slice(0, 2000) ?? '' } };
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
const VIDEO_HELP_WORDS = new Set([
  'video', 'image', 'text', 'transition', 'reference',
  'keyframe', 'omni_reference', 'omni-reference',
  'image-to-video', 'text-to-video', 'first/last-frame transition', 'reference-to-video',
  '720p', '1080p', '480p', '360p', '540p', '768p', '1440p', '2160p', '4k', '2k',
  '16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3',
  'standard', 'pro', 'fast', 'default', 'auto',
]);
function safeVideoHelp(value, depth = 0, field = '') {
  if (depth > 5) return null;
  if (typeof value === 'string' && VIDEO_HELP_WORDS.has(value.toLowerCase())) return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeVideoHelp(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([name]) => schemaName(name) && !QUOTE_PRIVATE_KEY.test(name)).slice(0, 50).map(([name, child]) => [name, safeVideoHelp(child, depth + 1, name)]));
  return safeQuote(value, depth, field);
}
async function videoDiagnostic(accessToken, action, input, raw = false, settings = FREEBEAT_VIDEO_TEST, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const images = Array.isArray(input?.images) ? input.images : (input?.image_url ? [input.image_url] : []);
  const params = action === 'video-help'
    ? { name: 'get_model_help', arguments: { type: 'video', model_id: settings.model_id } }
    : { name: 'quote_generation', arguments: { tool: 'generate_video', parameters: { ...settings, prompt: input.prompt, ...(images.length ? { images } : {}) } } };
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
  if (typeof value !== 'string') throw fail('Resolusi tidak valid (contoh: 480p, 720p, 1080p).', 400);
  const clean = value.trim().toLowerCase();
  if (/^(480|720|1080)$/.test(clean)) return `${clean}p`;
  if (!HELP_RESOLUTION.test(clean)) throw fail('Resolusi tidak valid (contoh: 480p, 720p, 1080p).', 400);
  return clean;
}
const HELP_ASPECT_RATIO = /^(auto|16:9|9:16|1:1|4:3|3:4|21:9|3:2|2:3)$/i;
function optionalAspectRatio(value) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw fail('Rasio aspek tidak valid (contoh: 16:9, 9:16, 1:1).', 400);
  const clean = value.trim().toLowerCase();
  if (!HELP_ASPECT_RATIO.test(clean)) throw fail('Rasio aspek tidak valid (contoh: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, auto).', 400);
  return clean;
}
const VIDEO_MODEL_REQUEST_KEYS = new Set(['model_id', 'prompt', 'image_url', 'images', 'input_mode', 'generation_type', 'duration', 'resolution', 'aspect_ratio']);
function parseVideoModelRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !VIDEO_MODEL_REQUEST_KEYS.has(key)) || !Number.isSafeInteger(input.model_id) || input.model_id < 0) {
    throw fail('Pilih ID model video yang valid.', 400);
  }
  const duration = optionalDuration(input.duration);
  const resolution = optionalResolution(input.resolution);
  const aspect_ratio = optionalAspectRatio(input.aspect_ratio);
  const videoInput = validateMultiVideoInput({
    prompt: input.prompt,
    ...(input.image_url !== undefined ? { image_url: input.image_url } : {}),
    ...(input.images !== undefined ? { images: input.images } : {}),
    ...(input.input_mode !== undefined ? { input_mode: input.input_mode } : {}),
    ...(input.generation_type !== undefined ? { generation_type: input.generation_type } : {}),
  });
  return { model_id: input.model_id, duration, resolution, aspect_ratio, ...videoInput };
}
async function parseVideoPrepare(request) {
  return parseVideoModelRequest(await imageJson(request));
}
function videoSettings(modelId) { return { ...FREEBEAT_VIDEO_TEST, model_id: modelId }; }

// --- Capability normalization -------------------------------------------------
// Freebeat rejects generate_video items whose settings the model does not
// support, without a usable reason (0 accepted credits). get_model_help exposes
// the supported durations/resolutions/generation types; align the test settings
// to them BEFORE quoting so the quote, the approval and the dispatch all carry
// values the model accepts. Unknown help => keep current settings.
const HELP_RESOLUTION = /^(360p|480p|540p|720p|768p|1080p|1440p|2160p|2k|4k)$/i;
const HELP_PAIR = /^(\d{3,4}p|2k|4k)\|(\d{1,3})$/i; // price-map keys like "480p|5"
const GEN_NAME_MAP = {
  'image-to-video': 'image',
  image2video: 'image',
  img2video: 'image',
  image: 'image',
  'text-to-video': 'text',
  text2video: 'text',
  text: 'text',
  'first/last-frame transition': 'transition',
  'first/last frame transition': 'transition',
  'first-last-frame': 'transition',
  'first_last_frame': 'transition',
  'first_last_frame_transition': 'transition',
  transition: 'transition',
  'reference-to-video': 'reference',
  'reference_to_video': 'reference',
  'omni-reference': 'reference',
  'omni_reference': 'reference',
  'omni reference': 'reference',
  reference: 'reference',
};
const GEN_CODE_MAP = { 0: 'image', 1: 'text', 2: 'transition', 3: 'reference' };
function mapHelpGenerationMode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.generation_name === 'string') {
    const byName = GEN_NAME_MAP[value.generation_name.trim().toLowerCase()];
    if (byName) return byName;
  }
  if (typeof value.generation_type === 'string') {
    const byStr = GEN_NAME_MAP[value.generation_type.trim().toLowerCase()];
    if (byStr) return byStr;
  }
  if (typeof value.type === 'string') {
    const byType = GEN_NAME_MAP[value.type.trim().toLowerCase()];
    if (byType) return byType;
  }
  if (typeof value.generation_type === 'number' && Object.hasOwn(GEN_CODE_MAP, value.generation_type)) {
    return GEN_CODE_MAP[value.generation_type];
  }
  return null;
}
function collectHelpOptions(help, wantedGenerationType = null) {
  const durations = new Set();
  const resolutions = new Set();
  const generations = new Set();
  const aspectRatios = new Set();
  const modeDurations = new Set();
  const modeResolutions = new Set();
  const modeAspectRatios = new Set();
  let minDuration = null;
  let maxDuration = null;
  let modeMinDuration = null;
  let modeMaxDuration = null;

  function notePair(name, inTargetMode) {
    const pair = HELP_PAIR.exec(name);
    if (pair) {
      const res = pair[1].toLowerCase();
      const dur = Number(pair[2]);
      resolutions.add(res);
      durations.add(dur);
      if (inTargetMode) { modeResolutions.add(res); modeDurations.add(dur); }
    }
  }
  function walk(value, key = '', depth = 0, inTargetMode = false) {
    if (depth > 8 || value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (Number.isInteger(value) && value > 0 && value <= 600) {
        if (/min_?duration/i.test(key)) {
          minDuration = minDuration === null ? value : Math.min(minDuration, value);
          if (inTargetMode) modeMinDuration = modeMinDuration === null ? value : Math.min(modeMinDuration, value);
        } else if (/max_?duration/i.test(key)) {
          maxDuration = maxDuration === null ? value : Math.max(maxDuration, value);
          if (inTargetMode) modeMaxDuration = modeMaxDuration === null ? value : Math.max(modeMaxDuration, value);
        } else if (/duration|second|secs|length/i.test(key)) {
          durations.add(value);
          if (inTargetMode) modeDurations.add(value);
        }
      }
      if (/generation_?types?/i.test(key) && Object.hasOwn(GEN_CODE_MAP, value)) {
        generations.add(GEN_CODE_MAP[value]);
      }
      return;
    }
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (HELP_RESOLUTION.test(v)) {
        resolutions.add(v);
        if (inTargetMode) modeResolutions.add(v);
      }
      if (HELP_ASPECT_RATIO.test(v) && /aspect|ratio/i.test(key)) {
        aspectRatios.add(v);
        if (inTargetMode) modeAspectRatios.add(v);
      }
      if (/generation_?types?/i.test(key) && GEN_NAME_MAP[v]) {
        generations.add(GEN_NAME_MAP[v]);
      }
      notePair(v, inTargetMode);
      return;
    }
    if (Array.isArray(value)) {
      value.slice(0, 200).forEach((item) => walk(item, key, depth + 1, inTargetMode));
      return;
    }
    if (typeof value === 'object') {
      const mappedMode = mapHelpGenerationMode(value);
      if (mappedMode) generations.add(mappedMode);
      const nextInTargetMode = mappedMode ? (Boolean(wantedGenerationType) && mappedMode === wantedGenerationType) : inTargetMode;
      for (const [name, child] of Object.entries(value).slice(0, 200)) {
        notePair(name, nextInTargetMode);
        const low = name.toLowerCase();
        // Price maps key their entries by resolution ("768p": 13) or by
        // resolution|duration pairs ("480p|5": 27); capture both shapes.
        if (HELP_RESOLUTION.test(low)) {
          resolutions.add(low);
          if (nextInTargetMode) modeResolutions.add(low);
        }
        walk(child, `${key}${key ? '.' : ''}${low}`, depth + 1, nextInTargetMode);
      }
    }
  }
  walk(help);
  const pickedDurations = modeDurations.size ? modeDurations : durations;
  const pickedResolutions = modeResolutions.size ? modeResolutions : resolutions;
  const pickedAspectRatios = modeAspectRatios.size ? modeAspectRatios : aspectRatios;
  const pickedMinDur = modeMinDuration ?? minDuration;
  const pickedMaxDur = modeMaxDuration ?? maxDuration;
  return {
    durations: [...pickedDurations].sort((a, b) => a - b),
    resolutions: [...pickedResolutions],
    generations: [...generations],
    aspectRatios: [...pickedAspectRatios],
    minDuration: pickedMinDur,
    maxDuration: pickedMaxDur,
  };
}
function normalizeVideoSettings(help, settings, wantedTarget) {
  const wanted = typeof wantedTarget === 'string' ? wantedTarget : (wantedTarget ? 'image' : 'text');
  const options = collectHelpOptions(help, wanted);
  const adjusted = [];
  const next = { ...settings };
  if (options.generations.length) {
    if (!options.generations.includes(wanted)) {
      throw fail(`Model ${settings.model_id} tidak mendukung mode '${wanted}' (mendukung: ${options.generations.join(', ')}). Ubah tipe input/jumlah gambar atau pilih model lain.`, 409);
    }
    if (next.generation_type !== wanted) { next.generation_type = wanted; adjusted.push('generation_type'); }
  }
  if (options.durations.length) {
    if (!options.durations.includes(next.duration)) {
      next.duration = options.durations.reduce((best, d) => (Math.abs(d - settings.duration) < Math.abs(best - settings.duration) ? d : best), options.durations[0]);
      adjusted.push('duration');
    }
  } else if (Number.isInteger(options.minDuration) && Number.isInteger(options.maxDuration) && options.minDuration <= options.maxDuration) {
    if (next.duration < options.minDuration) { next.duration = options.minDuration; adjusted.push('duration'); }
    else if (next.duration > options.maxDuration) { next.duration = options.maxDuration; adjusted.push('duration'); }
  }
  if (options.resolutions.length && !options.resolutions.includes(String(next.resolution).toLowerCase())) {
    const preference = ['480p', '768p', '720p', '1080p', '540p', '1440p', '2160p', '2k', '4k'];
    next.resolution = preference.find((item) => options.resolutions.includes(item)) ?? options.resolutions[0];
    adjusted.push('resolution');
  }
  if (options.aspectRatios.length && !options.aspectRatios.includes(String(next.aspect_ratio).toLowerCase())) {
    const preference = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', 'auto'];
    next.aspect_ratio = preference.find((item) => options.aspectRatios.includes(item)) ?? options.aspectRatios[0];
    adjusted.push('aspect_ratio');
  }
  return {
    settings: next,
    adjusted,
    options: {
      durations: options.durations,
      resolutions: options.resolutions,
      generations: options.generations,
      ...(options.aspectRatios.length ? { aspectRatios: options.aspectRatios } : {}),
      ...(Number.isInteger(options.minDuration) ? { minDuration: options.minDuration } : {}),
      ...(Number.isInteger(options.maxDuration) ? { maxDuration: options.maxDuration } : {}),
    },
  };
}
// Allow admin diagnostics on /admin/freebeat to quote and test models even
// when Freebeat MCP metadata marks `member_only: true` (e.g. Wan 3.0 on accounts
// that already have Studio access). Only fail early on `available === false`
// or when an operator explicitly opts out via FREEBEAT_ALLOW_MEMBER_ONLY=0.
function assertModelUsable(help, modelId, env) {
  const model = help && typeof help === 'object' && help.model && typeof help.model === 'object' ? help.model : null;
  if (!model) return;
  if (model.available === false) throw fail(`Model ${modelId} sedang tidak tersedia di Freebeat. Pilih model lain.`, 409);
  if (model.member_only === true && env && String(env.FREEBEAT_ALLOW_MEMBER_ONLY) === '0') {
    throw fail(`Model ${modelId} diblokir karena kebijakan FREEBEAT_ALLOW_MEMBER_ONLY=0.`, 409);
  }
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
    && typeof settings.aspect_ratio === 'string' && HELP_ASPECT_RATIO.test(settings.aspect_ratio);
}
function validateHttpsImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.trim().length > 2048) throw fail('URL gambar HTTPS tidak valid.', 400);
  const imageUrl = rawUrl.trim();
  let url;
  try { url = new URL(imageUrl); } catch { throw fail('URL gambar HTTPS tidak valid.', 400); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) throw fail('Gunakan URL gambar HTTPS dengan nama domain publik tanpa kredensial atau fragment.', 400);
  return imageUrl;
}
function validateVideoInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['prompt', 'image_url'].includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 2000 || typeof input.image_url !== 'string' || input.image_url.trim().length > 2048) throw fail('Masukkan prompt 1–2000 karakter dan satu URL gambar HTTPS.', 400);
  return { prompt: input.prompt.trim(), image_url: validateHttpsImageUrl(input.image_url) };
}
function normalizeInputMode(rawMode) {
  if (rawMode === undefined || rawMode === null || rawMode === '') return null;
  if (typeof rawMode !== 'string') throw fail('Tipe input video tidak valid (gunakan keyframe atau omni_reference).', 400);
  const clean = rawMode.trim().toLowerCase();
  if (clean === 'keyframe') return 'keyframe';
  if (clean === 'omni_reference' || clean === 'omni reference' || clean === 'omni-reference') return 'omni_reference';
  throw fail('Tipe input video harus keyframe atau omni_reference.', 400);
}
function validateMultiVideoInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['prompt', 'image_url', 'images', 'input_mode', 'generation_type'].includes(key))) {
    throw fail('Parameter input video tidak valid.', 400);
  }
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 2000) {
    throw fail('Masukkan prompt sepanjang 1–2000 karakter.', 400);
  }
  const inputMode = normalizeInputMode(input.input_mode);
  let explicitGenType = null;
  if (input.generation_type !== undefined && input.generation_type !== null && input.generation_type !== '') {
    if (typeof input.generation_type !== 'string' || !['text', 'image', 'transition', 'reference'].includes(input.generation_type.trim().toLowerCase())) {
      throw fail('Tipe generasi harus text, image, transition, atau reference.', 400);
    }
    explicitGenType = input.generation_type.trim().toLowerCase();
  }

  let images = [];
  if (input.images !== undefined) {
    if (!Array.isArray(input.images)) throw fail('Daftar gambar harus berupa array URL HTTPS.', 400);
    if (input.images.length > FREEBEAT_VIDEO_MAX_IMAGES) {
      throw fail(`Maksimal ${FREEBEAT_VIDEO_MAX_IMAGES} gambar untuk uji video Freebeat.`, 400);
    }
    images = input.images.map((item) => validateHttpsImageUrl(item));
    if (input.image_url !== undefined && input.image_url !== '') {
      const legacyUrl = validateHttpsImageUrl(input.image_url);
      if (images.length !== 1 || images[0] !== legacyUrl) {
        throw fail('Parameter image_url dan images tidak konsisten.', 400);
      }
    }
  } else if (input.image_url !== undefined) {
    if (typeof input.image_url !== 'string') throw fail('URL gambar HTTPS tidak valid.', 400);
    const trimmed = input.image_url.trim();
    if (trimmed) {
      images = [validateHttpsImageUrl(trimmed)];
    } else if (inputMode !== 'keyframe' && explicitGenType !== 'text') {
      throw fail('URL gambar HTTPS tidak valid.', 400);
    }
  } else if (inputMode !== 'keyframe' && explicitGenType !== 'text') {
    throw fail('Masukkan minimal 1 URL gambar HTTPS atau pilih tipe input keyframe.', 400);
  }

  let generationType;
  let resolvedInputMode;
  if (inputMode === 'omni_reference') {
    if (images.length < 1 || images.length > FREEBEAT_VIDEO_MAX_IMAGES) {
      throw fail(`Mode Omni Reference membutuhkan 1–${FREEBEAT_VIDEO_MAX_IMAGES} gambar referensi HTTPS.`, 400);
    }
    if (explicitGenType && explicitGenType !== 'reference') {
      throw fail('Mode Omni Reference harus menggunakan generation_type reference.', 400);
    }
    generationType = 'reference';
    resolvedInputMode = 'omni_reference';
  } else if (inputMode === 'keyframe') {
    if (images.length > 2) {
      throw fail('Mode Keyframe mendukung maksimal 2 gambar (First & Last Frame). Hapus 1 gambar atau ganti tipe input ke Omni Reference.', 400);
    }
    const autoType = images.length === 0 ? 'text' : images.length === 1 ? 'image' : 'transition';
    if (explicitGenType && explicitGenType !== autoType) {
      throw fail(`Tipe generasi ${explicitGenType} tidak sesuai dengan ${images.length} gambar pada mode Keyframe.`, 400);
    }
    generationType = autoType;
    resolvedInputMode = 'keyframe';
  } else if (explicitGenType) {
    if (explicitGenType === 'text' && images.length !== 0) throw fail('Mode text tidak memakai gambar.', 400);
    if (explicitGenType === 'image' && images.length !== 1) throw fail('Mode image membutuhkan tepat 1 gambar.', 400);
    if (explicitGenType === 'transition' && images.length !== 2) throw fail('Mode transition membutuhkan tepat 2 gambar (First & Last Frame).', 400);
    if (explicitGenType === 'reference' && (images.length < 1 || images.length > FREEBEAT_VIDEO_MAX_IMAGES)) {
      throw fail(`Mode reference membutuhkan 1–${FREEBEAT_VIDEO_MAX_IMAGES} gambar.`, 400);
    }
    generationType = explicitGenType;
    resolvedInputMode = explicitGenType === 'reference' ? 'omni_reference' : 'keyframe';
  } else {
    generationType = images.length === 0 ? 'text' : images.length === 1 ? 'image' : images.length === 2 ? 'transition' : 'reference';
    resolvedInputMode = generationType === 'reference' ? 'omni_reference' : 'keyframe';
  }

  return {
    prompt: input.prompt.trim(),
    images,
    image_url: images[0] || '',
    input_mode: resolvedInputMode,
    generation_type: generationType,
  };
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
// get_model_help tipe image: mengungkapkan opsi resmi model (resolusi, rasio,
// jumlah gambar, apakah butuh gambar referensi) tanpa menghabiskan kredit.
const HELP_TYPES = new Set(['image', 'image_edit', 'video']);
async function imageModelHelp(accessToken, modelId, raw = false, type = 'image') {
  const helpType = HELP_TYPES.has(type) ? type : 'image';
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_model_help', arguments: { type: helpType, model_id: modelId } } }, 'help', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('help', 'response');
  return raw ? content : safeVideoHelp(content);
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
async function imageJson(request, maxBytes = 16384) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw fail('Format permintaan tidak valid.', 400);
  try { return await boundedJson(request, maxBytes); } catch { throw fail('Permintaan tidak valid atau terlalu besar.', 400); }
}
async function imageDb(env, path, options = {}, kind = 'image') {
  const label = kind === 'music' ? 'musik' : kind === 'vocal' ? 'vokal' : kind === 'dance' ? 'dance' : kind === 'video' ? 'video' : 'gambar';
  const table = kind === 'music'
    ? 'freebeat_admin_music_tests'
    : kind === 'vocal'
      ? 'freebeat_admin_vocal_tests'
      : kind === 'dance'
        ? 'freebeat_admin_dance_tests'
        : kind === 'video'
          ? 'freebeat_admin_video_tests'
          : 'freebeat_admin_image_tests';
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
  const statuses = new Set(['pending', 'queued', 'processing', 'running', 'completed', 'failed', 'partial_failed', 'cancelled', 'expired', 'action_required']);
  const status = statuses.has(content.status) ? content.status : 'unknown';
  const images = Array.isArray(content.items) ? content.items.slice(0, 10).map((item) => safeImageUrl(item?.image_url)).filter(Boolean) : [];
  const billing = {};
  for (const field of ['charged', 'refunded', 'net']) billing[field] = typeof content.billing?.[field] === 'number' && Number.isFinite(content.billing[field]) ? content.billing[field] : null;
  if (billing.charged === null && Array.isArray(content.items)) {
    const usedCredits = content.items.slice(0, 10).map((item) => item?.used_credits).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (usedCredits.length > 0) billing.charged = usedCredits.reduce((sum, v) => sum + v, 0);
  }
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
// Narrow admin experiments only; never populate or bypass the consumer catalog.
function diagnosticModelId(kind) { return kind === 'hailuo' ? 106 : kind === 'ltx' ? 97 : null; }
function assertSingleImageDiagnostic(input, kind) {
  const modelId = diagnosticModelId(kind);
  if (!modelId || input.model_id !== modelId || input.generation_type !== 'image' || input.input_mode !== 'keyframe' || !Array.isArray(input.images) || input.images.length !== 1 || !Number.isSafeInteger(input.duration) || input.duration < 1 || input.duration > 600 || !input.resolution || !input.aspect_ratio
    || (kind === 'hailuo' && (input.duration !== 10 || input.resolution !== '768p' || !['16:9', '9:16', '1:1'].includes(input.aspect_ratio)))) throw fail(`Uji model ${modelId || '-'} hanya untuk satu gambar keyframe/image dengan durasi, resolusi dan rasio eksplisit yang valid.`, 400);
}
async function prepareVideo(env, user, session, input, diagnostic = null) {
  await requireImageSession(session);
  if (!diagnostic) {
    const models = await getModels(session.accessToken, 'video');
    const found = models.models.some((model) => {
      const id = model.model_id;
      return (typeof id === 'number' && id === input.model_id) || (typeof id === 'string' && /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) === input.model_id);
    });
    if (!found) throw fail('Model tidak ditemukan dalam daftar video Freebeat saat ini. Muat ulang daftar model.', 400);
  }
  if (diagnostic) assertSingleImageDiagnostic(input, diagnostic);
  const opened = diagnostic ? await openMcpSession(env, session) : null;
  if (opened) { session = opened.session; await requireImageSession(session); }
  const exact = { prompt: input.prompt, images: input.images, image_url: input.images[0] || '', input_mode: input.input_mode };
  const base = {
    ...videoSettings(input.model_id),
    generation_type: input.generation_type,
    ...(Number.isSafeInteger(input.duration) ? { duration: input.duration } : {}),
    ...(input.resolution ? { resolution: input.resolution } : {}),
    ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
  };
  const help = await videoDiagnostic(session.accessToken, 'video-help', null, true, base, opened?.headers);
  if (diagnostic && (help.model?.model_id !== diagnosticModelId(diagnostic) || help.model?.available !== true)) throw fail(`Help live belum mengonfirmasi model ${diagnosticModelId(diagnostic)} tersedia. Generasi diblokir.`, 409);
  assertModelUsable(help, input.model_id, env);
  const normalized = normalizeVideoSettings(help, base, input.generation_type);
  const settings = normalized.settings;
  if (diagnostic && normalized.adjusted.length) throw fail('Parameter berubah menurut help live. Sesuaikan input dengan informasi/quote baru; tidak ada video dikirim.', 409);
  const credits = quotedCredits(await videoDiagnostic(session.accessToken, 'video-quote', exact, true, settings, opened?.headers));
  if (credits === null) throw fail('Freebeat tidak memberikan quote numerik yang dapat digunakan. Generasi tidak diaktifkan.', 409);
  const expires = Date.now() + APPROVAL_LIFETIME;
  const approval = await seal({ id: crypto.randomUUID(), uid: user.id, sessionHash: await sessionHash(session), settings, prompt: exact.prompt, images: exact.images, credits, expires, ...(diagnostic === 'hailuo' ? { hailuo: true } : diagnostic === 'ltx' ? { ltx: true } : {}) }, env, 'video-approval');
  if (approval.length > 14000) throw fail('Input terlalu besar untuk persetujuan uji.', 400);
  return {
    approval,
    settings,
    ...exact,
    credits,
    max_credits: credits + videoHeadroom(credits),
    adjusted: normalized.adjusted,
    supported: normalized.options,
    member_only: help?.model?.member_only === true,
    expiresAt: expires,
  };
}
// Only deliberate local preflight rejections may unlock a consumed UI approval.
// HTTP 409 alone is NOT safe: it also represents duplicate/uncertain DB locks.
function videoNotSent(message, status = 409) { return Object.assign(fail(message, status), { videoDispatch: 'not_sent' }); }
async function submitVideo(env, user, session, request) {
  await requireImageSession(session);
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['approval', 'confirm', 'private_diagnostics'].includes(key)) || input.confirm !== true || (input.private_diagnostics !== undefined && typeof input.private_diagnostics !== 'boolean') || typeof input.approval !== 'string' || input.approval.length > 14000) throw fail('Persetujuan uji tidak valid.', 400);
  const ticket = await unseal(input.approval, env, 'video-approval', 14000);
  if (!ticket || ticket.uid !== user.id || ticket.sessionHash !== await sessionHash(session) || !TEST_ID.test(ticket.id || '') || !validVideoSettings(ticket.settings) || !Number.isFinite(ticket.expires) || ticket.expires > Date.now() + APPROVAL_LIFETIME || typeof ticket.credits !== 'number' || !Number.isFinite(ticket.credits) || ticket.credits < 0 || ticket.credits > 1000000) throw fail('Persetujuan kedaluwarsa atau tidak cocok. Buat quote baru.', 400);
  const rawImages = Array.isArray(ticket.images) ? ticket.images : (typeof ticket.image_url === 'string' && ticket.image_url ? [ticket.image_url] : []);
  const exact = validateMultiVideoInput({ prompt: ticket.prompt, images: rawImages, generation_type: ticket.settings.generation_type });
  if (exact.prompt !== ticket.prompt || exact.images.length !== rawImages.length || exact.images.some((url, idx) => url !== rawImages[idx])) throw fail('Persetujuan tidak valid.', 400);
  if (ticket.expires <= Date.now()) throw videoNotSent('Persetujuan kedaluwarsa; tidak ada video dikirim.', 400);
  let recoveredHeaders = null;
  const diagnostic = ticket.hailuo === true ? 'hailuo' : ticket.ltx === true ? 'ltx' : null;
  if (diagnostic) {
    const modelId = diagnosticModelId(diagnostic);
    assertSingleImageDiagnostic({ ...ticket.settings, images: exact.images, input_mode: 'keyframe' }, diagnostic);
    const opened = await openMcpSession(env, session);
    session = opened.session; recoveredHeaders = opened.headers;
    await requireImageSession(session);
    if (ticket.sessionHash !== await sessionHash(session)) throw videoNotSent('Sesi persetujuan berubah; buat quote baru.', 400);
    const help = await videoDiagnostic(session.accessToken, 'video-help', null, true, ticket.settings, recoveredHeaders);
    if (help.model?.model_id !== modelId || help.model?.available !== true) throw videoNotSent(`Model ${modelId} tidak lagi terkonfirmasi tersedia. Tidak ada video dikirim.`);
    try {
      assertModelUsable(help, modelId, env);
      if (normalizeVideoSettings(help, ticket.settings, 'image').adjusted.length) throw fail('Kemampuan model berubah. Tidak ada video dikirim; periksa quote baru.', 409);
    } catch (error) { if (error?.status === 409) throw videoNotSent(error.message); throw error; }
  }
  const current = quotedCredits(await videoDiagnostic(session.accessToken, 'video-quote', exact, true, ticket.settings, recoveredHeaders));
  if (current === null || current !== ticket.credits) throw videoNotSent('Quote berubah atau tidak tersedia. Tidak ada video dikirim; buat quote baru.');
  if (ticket.expires <= Date.now()) throw videoNotSent('Persetujuan kedaluwarsa; tidak ada video dikirim.', 400);
  const headers = recoveredHeaders || await openMcp(session.accessToken);
  if (ticket.expires <= Date.now()) throw videoNotSent('Persetujuan kedaluwarsa; tidak ada video dikirim.', 400);
  const cap = ticket.credits + videoHeadroom(ticket.credits);
  const rows = await videoDb(env, '', { method: 'POST', body: { id: ticket.id, admin_id: user.id, session_hash: ticket.sessionHash, model_id: ticket.settings.model_id, quote_credits: ticket.credits, max_credits: cap, status: 'dispatching' } });
  if (rows.length !== 1 || rows[0]?.id !== ticket.id) throw fail('Pencatatan belum dapat dipastikan. Jangan ulangi sebelum memeriksa catatan.', 503);
  if (ticket.expires <= Date.now()) {
    try { await videoMark(env, user.id, ticket.id, 'reviewed'); } catch { /* preserve lock */ }
    throw fail('Persetujuan kedaluwarsa sebelum pengiriman; tidak ada video dikirim. Periksa catatan.', 409);
  }
  let taskId;
  let initialDiagnostics = null;
  let batchSummary = null;
  try {
    // Dispatch mirrors the official generate_video schema (model_id, prompt,
    // generation_type enum string, images, duration, resolution, aspect_ratio,
    // max_credits) AND the proven web client shape (aspect ratio always sent).
    const { result } = await rpc(session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_video', arguments: { model_id: ticket.settings.model_id, generation_type: ticket.settings.generation_type, prompt: exact.prompt, ...(exact.images.length ? { images: exact.images } : {}), duration: ticket.settings.duration, resolution: ticket.settings.resolution, aspect_ratio: ticket.settings.aspect_ratio, max_credits: cap } } }, 'generate', headers, 262144, input.private_diagnostics === true);
    if (input.private_diagnostics === true) initialDiagnostics = { received: true, messages: initialVideoMessages(result) };
    if (result.isError) throw new Error('unrecognized');
    const content = modelContent(result);
    if (!content || typeof content.batch_id !== 'string' || !TASK_ID.test(content.batch_id)) throw new Error('unrecognized');
    taskId = content.batch_id;
    if (typeof content.accepted_count === 'number' || typeof content.failed_count === 'number' || typeof content.accepted_credits === 'number') {
      batchSummary = {
        accepted_count: typeof content.accepted_count === 'number' && Number.isFinite(content.accepted_count) ? content.accepted_count : null,
        failed_count: typeof content.failed_count === 'number' && Number.isFinite(content.failed_count) ? content.failed_count : null,
        accepted_credits: typeof content.accepted_credits === 'number' && Number.isFinite(content.accepted_credits) ? content.accepted_credits : null,
      };
    }
  } catch {
    try { await videoMark(env, user.id, ticket.id, 'unknown'); } catch { /* retain lock */ }
    return { id: ticket.id, status: 'unknown', ...(input.private_diagnostics === true ? { initial_diagnostics: initialDiagnostics || { received: false, messages: [] } } : {}) };
  }
  try { await videoMark(env, user.id, ticket.id, 'submitted', taskId); }
  catch { return { id: ticket.id, status: 'unknown', recoveryTaskId: taskId, ...(batchSummary ? { batch_summary: batchSummary } : {}), ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}) }; }
  return { id: ticket.id, status: 'submitted', ...(batchSummary ? { batch_summary: batchSummary } : {}), ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}) };
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
function safeOpenRpcFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawCode = value.error_code ?? value.code;
  const reason = typeof rawCode === 'string' && VIDEO_FAILURE_REASONS.has(rawCode.toLowerCase()) ? rawCode.toLowerCase() : null;
  const errorCode = !reason && ((typeof rawCode === 'number' && Number.isSafeInteger(rawCode)) || (typeof rawCode === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(rawCode))) ? String(rawCode) : null;
  const hasMessage = (typeof value.error_message === 'string' && value.error_message.trim().length > 0) || (typeof value.message === 'string' && value.message.trim().length > 0);
  const itemFailed = ['failed', 'failure', 'rejected', 'error'].includes(String(value.status || '').toLowerCase());
  const hasUnmappedCode = rawCode !== undefined && rawCode !== null && !reason && !errorCode;
  if (!reason && !errorCode && !hasMessage && !itemFailed && !hasUnmappedCode) return null;
  return {
    stage: null,
    stage_hidden: false,
    reason,
    reason_hidden: Boolean(hasMessage || hasUnmappedCode),
    retryable: null,
    ...(errorCode ? { error_code: errorCode } : {}),
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
  const failedStatus = ['failed', 'partial_failed', 'action_required'].includes(summary.status);
  const failure = content.failure ? safeVideoFailure(content.failure) : (failedStatus ? safeOpenRpcFailure(content) : null);
  const item_failures = Array.isArray(content.items)
    ? content.items.slice(0, 10).map((item) => item?.failure ? safeVideoFailure(item.failure) : safeOpenRpcFailure(item)).filter(Boolean)
    : [];
  return { status: summary.status, billing: summary.billing, videos: Array.isArray(content.items) ? content.items.slice(0, 10).map((item) => safeImageUrl(item?.video_url)).filter(Boolean) : [], failure, item_failures };
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

function formatProviderCode(value, prefix) {
  return typeof value === 'number' && Number.isFinite(value) ? `${prefix}: ${value}` : value;
}

// Extract only selected batch/item message fields from the original create
// response. The provider body is not stored or logged; redaction is best effort.
function initialVideoMessages(result) {
  const candidates = [];
  const fields = (value) => [
    value?.failure?.reason,
    formatProviderCode(value?.error_code, 'error_code'),
    formatProviderCode(value?.code, 'code'),
    value?.error_message,
    value?.message,
    typeof value?.error === 'string' ? value.error : value?.error?.message,
    value?.detail,
    value?.reason,
  ];
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
  const status = String(content.status || '').toLowerCase();
  if (!['failed', 'partial_failed', 'action_required', 'rejected'].includes(status)) throw fail('Pesan kegagalan tidak tersedia untuk status ini.', 409);
  // Status responses can carry useful details in failure.reason, error_code,
  // code, error_message or message at batch/item level.
  const fields = (value) => [value?.failure?.reason, formatProviderCode(value?.error_code, 'error_code'), formatProviderCode(value?.code, 'code'), value?.error_message, value?.message];
  const candidates = [...fields(content), ...(Array.isArray(content.items) ? content.items.slice(0, 10).flatMap(fields) : [])];
  const reasons = [...new Set(candidates.map(privateFailureReason).filter(Boolean))];
  if (reasons.length === 0 && Array.isArray(content.items)) {
    for (const [idx, item] of content.items.slice(0, 10).entries()) {
      const itemStatus = typeof item?.status === 'string' && item.status.trim() ? item.status.trim() : null;
      const usedCredits = typeof item?.used_credits === 'number' && Number.isFinite(item.used_credits) ? item.used_credits : null;
      if (itemStatus || usedCredits !== null) {
        const line = privateFailureReason(`Item #${idx + 1}: status=${itemStatus || '-'}, used_credits=${usedCredits ?? '-'}`);
        if (line) reasons.push(line);
      }
    }
  }
  return { reasons };
}

// --- Dance Video Director (generate_dance_video) ----------------------------
const DANCE_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4']);
const DANCE_ALLOWED_KEYS = new Set(['music_id', 'auto_mode', 'prompt', 'aspect_ratio', 'image_urls', 'start_ms', 'end_ms', 'remove_watermark']);
function normalizeDanceMusicId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw fail('music_id tidak valid.', 400);
    return value;
  }
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s || s.length > 256 || !/^[A-Za-z0-9_.:-]+$/.test(s)) throw fail('Masukkan music_id yang valid (atau unggah audio terlebih dahulu).', 400);
  return /^\d{1,15}$/.test(s) ? Number(s) : s;
}
function validateDanceInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !DANCE_ALLOWED_KEYS.has(k))) {
    throw fail('Parameter dance video tidak valid.', 400);
  }
  const music_id = normalizeDanceMusicId(input.music_id);
  const auto_mode = typeof input.auto_mode === 'boolean' ? input.auto_mode : true;
  const aspect_ratio = typeof input.aspect_ratio === 'string' && DANCE_RATIOS.has(input.aspect_ratio.trim()) ? input.aspect_ratio.trim() : '9:16';
  let prompt = '';
  if (input.prompt !== undefined && input.prompt !== null) {
    if (typeof input.prompt !== 'string' || input.prompt.trim().length > 2000) throw fail('Prompt arahan kreatif maksimal 2000 karakter.', 400);
    prompt = input.prompt.trim();
  }
  let image_urls = [];
  if (input.image_urls !== undefined && input.image_urls !== null) {
    if (!Array.isArray(input.image_urls) || input.image_urls.length > 5) throw fail('Maksimal 5 foto penari.', 400);
    image_urls = input.image_urls.map((raw) => {
      const safe = consumerImageUrl(typeof raw === 'string' ? raw : '');
      if (!safe) throw fail('Setiap foto penari harus berupa URL HTTPS publik yang valid.', 400);
      return safe;
    });
  }
  let start_ms;
  let end_ms;
  if (input.start_ms !== undefined && input.start_ms !== null && input.start_ms !== '') {
    if (!Number.isSafeInteger(input.start_ms) || input.start_ms < 0 || input.start_ms > 600000) throw fail('start_ms harus berupa bilangan bulat milidetik >= 0.', 400);
    start_ms = input.start_ms;
  }
  if (input.end_ms !== undefined && input.end_ms !== null && input.end_ms !== '') {
    if (!Number.isSafeInteger(input.end_ms) || input.end_ms <= 0 || input.end_ms > 600000) throw fail('end_ms harus berupa bilangan bulat milidetik > 0.', 400);
    end_ms = input.end_ms;
  }
  if ((start_ms !== undefined) !== (end_ms !== undefined)) throw fail('Isi start_ms dan end_ms bersama-sama, atau kosongkan keduanya.', 400);
  if (start_ms !== undefined && end_ms <= start_ms) throw fail('end_ms harus lebih besar dari start_ms.', 400);
  const remove_watermark = input.remove_watermark === true;
  return {
    music_id,
    auto_mode,
    aspect_ratio,
    ...(prompt ? { prompt } : {}),
    ...(image_urls.length ? { image_urls } : {}),
    ...(start_ms !== undefined ? { start_ms, end_ms } : {}),
    ...(remove_watermark ? { remove_watermark: true } : {}),
  };
}
function danceQuoteParameters(params) {
  return {
    music_id: params.music_id,
    auto_mode: params.auto_mode,
    aspect_ratio: params.aspect_ratio,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.image_urls?.length ? { image_urls: params.image_urls } : {}),
    ...(params.start_ms !== undefined ? { start_ms: params.start_ms, end_ms: params.end_ms } : {}),
    ...(params.remove_watermark ? { remove_watermark: true } : {}),
  };
}
async function danceUploadAudio(accessToken, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'audio_url')) {
    throw fail('Permintaan upload audio tidak valid.', 400);
  }
  const audioUrl = consumerImageUrl(typeof input.audio_url === 'string' ? input.audio_url : '');
  if (!audioUrl) throw fail('Masukkan URL audio HTTPS publik atau link platform musik yang valid (misal Suno, Udio, YouTube, SoundCloud, atau file MP3 publik).', 400);
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'upload_audio', arguments: { url: audioUrl } },
  }, 'upload', headers, 262144);
  if (result.isError) throw mcpFailure('upload', 'response');
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('upload', 'response');
  const rawId = content.music_id ?? content.musicId ?? content.id;
  if (rawId === undefined || rawId === null || !/^[A-Za-z0-9_.:-]{1,256}$/.test(String(rawId).trim())) {
    throw fail('Freebeat tidak mengembalikan music_id yang valid dari upload_audio.', 502);
  }
  return {
    music_id: String(rawId).trim(),
    status: content.status === 'preparing' ? 'preparing' : 'ready',
    retry_after_seconds: Number.isFinite(content.retry_after_seconds) ? content.retry_after_seconds : null,
  };
}
async function danceQuote(accessToken, params, raw = false) {
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'quote_generation', arguments: { tool: 'generate_dance_video', parameters: danceQuoteParameters(params) } },
  }, 'quote', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('quote', 'response');
  return raw ? content : safeQuote(content);
}
const danceDb = (env, path, options = {}) => imageDb(env, path, options, 'dance');
async function danceMark(env, uid, id, status, extra = {}) {
  const rows = await danceDb(env, `?id=eq.${encodeURIComponent(id)}&admin_id=eq.${encodeURIComponent(uid)}&status=eq.dispatching`, {
    method: 'PATCH',
    body: { status, ...extra, updated_at: new Date().toISOString() },
  });
  if (rows.length !== 1) throw fail('Status penyimpanan uji dance video tidak dapat dipastikan.', 503);
}
async function prepareDance(env, user, session, input) {
  await requireImageSession(session);
  const parameters = validateDanceInput(input);
  const rawQuote = await danceQuote(session.accessToken, parameters, true);
  const credits = quotedCredits(rawQuote);
  const accept_unknown_cost = credits === null;
  const max_credits = credits !== null ? credits + videoHeadroom(credits) : null;
  const expires = Date.now() + APPROVAL_LIFETIME;
  const approval = await seal({
    id: crypto.randomUUID(),
    uid: user.id,
    sessionHash: await sessionHash(session),
    parameters,
    credits,
    max_credits,
    accept_unknown_cost,
    expires,
  }, env, 'dance-approval');
  if (approval.length > 14000) throw fail('Input terlalu besar untuk persetujuan uji dance video.', 400);
  return {
    approval,
    parameters,
    credits,
    max_credits,
    accept_unknown_cost,
    cost_mode: accept_unknown_cost ? 'accept_unknown_cost' : 'max_credits',
    quote: safeQuote(rawQuote),
    expiresAt: expires,
  };
}
async function submitDance(env, user, session, request) {
  await requireImageSession(session);
  const input = await imageJson(request);
  const allowedKeys = new Set(['approval', 'confirm', 'confirm_unknown_cost']);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !allowedKeys.has(k)) || input.confirm !== true || typeof input.approval !== 'string' || input.approval.length > 14000) {
    throw fail('Persetujuan uji dance video tidak valid.', 400);
  }
  const ticket = await unseal(input.approval, env, 'dance-approval', 14000);
  if (!ticket || ticket.uid !== user.id || ticket.sessionHash !== await sessionHash(session) || !TEST_ID.test(ticket.id || '') || !Number.isFinite(ticket.expires) || ticket.expires <= Date.now() || ticket.expires > Date.now() + APPROVAL_LIFETIME) {
    throw fail('Persetujuan kedaluwarsa atau tidak cocok. Buat quote baru.', 400);
  }
  const parameters = validateDanceInput(ticket.parameters);
  if (ticket.accept_unknown_cost === true && input.confirm_unknown_cost !== true) {
    throw fail('Persetujuan biaya tidak diketahui di awal diperlukan untuk mengirimkan dance video tanpa quote pasti.', 400);
  }
  const current = quotedCredits(await danceQuote(session.accessToken, parameters, true));
  if (ticket.accept_unknown_cost === false) {
    if (current === null || current !== ticket.credits) throw fail('Quote berubah atau tidak tersedia. Tidak ada dance video dikirim; buat quote baru.', 409);
  } else if (current !== null) {
    throw fail('Quote numerik kini tersedia. Buat persetujuan ulang agar batas maksimum kredit dikirim.', 409);
  }
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa; tidak ada dance video dikirim.', 400);
  const headers = await openMcp(session.accessToken);
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa; tidak ada dance video dikirim.', 400);
  const rows = await danceDb(env, '', {
    method: 'POST',
    body: {
      id: ticket.id,
      admin_id: user.id,
      session_hash: ticket.sessionHash,
      music_id: String(parameters.music_id),
      aspect_ratio: parameters.aspect_ratio,
      auto_mode: parameters.auto_mode,
      quote_credits: ticket.credits,
      max_credits: ticket.accept_unknown_cost ? null : ticket.max_credits,
      accept_unknown_cost: ticket.accept_unknown_cost,
      status: 'dispatching',
    },
  });
  if (rows.length !== 1 || rows[0]?.id !== ticket.id) {
    throw fail('Pencatatan belum dapat dipastikan. Jangan ulangi sebelum memeriksa catatan.', 503);
  }
  if (ticket.expires <= Date.now()) {
    try { await danceMark(env, user.id, ticket.id, 'reviewed', { task_id: null }); } catch { /* retain lock */ }
    throw fail('Persetujuan kedaluwarsa sebelum pengiriman; tidak ada dance video dikirim.', 409);
  }
  let content;
  try {
    const args = {
      ...danceQuoteParameters(parameters),
      ...(ticket.accept_unknown_cost ? { accept_unknown_cost: true } : { max_credits: ticket.max_credits }),
    };
    const { result } = await rpc(session.accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'generate_dance_video', arguments: args },
    }, 'generate', headers, 262144);
    if (result.isError) throw new Error('unrecognized');
    content = modelContent(result);
    if (!content || typeof content !== 'object') throw new Error('unrecognized');
  } catch {
    try { await danceMark(env, user.id, ticket.id, 'unknown', { task_id: null }); } catch { /* retain lock */ }
    return { id: ticket.id, status: 'unknown' };
  }
  if (content.success === true && content.status === 'preparing' && content.music_id !== undefined && content.music_id !== null && !content.task_id) {
    try { await danceMark(env, user.id, ticket.id, 'reviewed', { task_id: null }); } catch { /* leave lock if unmarkable */ }
    return {
      id: ticket.id,
      status: 'preparing',
      music_id: String(content.music_id),
      retry_after_seconds: Number.isFinite(content.retry_after_seconds) ? content.retry_after_seconds : 10,
    };
  }
  const taskId = typeof content.task_id === 'string' && TASK_ID.test(content.task_id) ? content.task_id : null;
  if (!taskId) {
    try { await danceMark(env, user.id, ticket.id, 'unknown', { task_id: null }); } catch { /* retain lock */ }
    return { id: ticket.id, status: 'unknown' };
  }
  const sessionUrl = safeImageUrl(content.session_url);
  try {
    await danceMark(env, user.id, ticket.id, 'submitted', { task_id: taskId, ...(sessionUrl ? { session_url: sessionUrl } : {}) });
  } catch {
    return { id: ticket.id, status: 'unknown', recoveryTaskId: taskId };
  }
  return { id: ticket.id, status: 'submitted', ...(sessionUrl ? { session_url: sessionUrl } : {}) };
}
async function danceTests(env, user, session) {
  const rows = await danceDb(env, `?admin_id=eq.${encodeURIComponent(user.id)}&select=id,music_id,aspect_ratio,auto_mode,quote_credits,max_credits,accept_unknown_cost,status,session_url,created_at,session_hash&order=created_at.desc&limit=20`);
  const hash = await sessionHash(session);
  return rows.map((row) => ({
    id: row.id,
    music_id: row.music_id,
    aspect_ratio: row.aspect_ratio,
    auto_mode: row.auto_mode,
    quote_credits: row.quote_credits,
    max_credits: row.max_credits,
    accept_unknown_cost: row.accept_unknown_cost === true,
    status: row.status,
    session_url: safeImageUrl(row.session_url),
    created_at: row.created_at,
    canPoll: row.status === 'submitted' && row.session_hash === hash,
  }));
}
async function danceRowForTask(env, user, session, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !TEST_ID.test(input.id)) {
    throw fail('ID uji dance video tidak valid.', 400);
  }
  const rows = await danceDb(env, `?id=eq.${encodeURIComponent(input.id)}&admin_id=eq.${encodeURIComponent(user.id)}&select=status,task_id,session_hash,session_url&limit=1`);
  const row = rows[0];
  const sameSession = Boolean(row) && row.session_hash === await sessionHash(session);
  if (!row || row.status !== 'submitted' || typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id) || (!sameSession && input.acknowledge !== true)) {
    throw fail('Uji dance video tidak tersedia pada sesi Freebeat ini.', 404);
  }
  return row;
}
async function pollDance(env, user, session, request) {
  const input = await imageJson(request);
  if (Object.keys(input || {}).some((k) => !['id', 'acknowledge'].includes(k))) throw fail('Permintaan tidak valid.', 400);
  const row = await danceRowForTask(env, user, session, input);
  const headers = await openMcp(session.accessToken);
  const { result: statusRes } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_task_status', arguments: { task_id: row.task_id } },
  }, 'task', headers, 262144);
  const statusContent = modelContent(statusRes);
  if (!statusContent || typeof statusContent !== 'object' || Array.isArray(statusContent)) throw mcpFailure('task', 'response');
  const summary = safeTask(statusContent);
  let resultContent = null;
  if (['completed', 'failed', 'action_required'].includes(summary.status)) {
    try {
      const { result: finalRes } = await rpc(session.accessToken, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_task_result', arguments: { task_id: row.task_id } },
      }, 'task', headers, 262144);
      const parsed = modelContent(finalRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resultContent = parsed;
    } catch { /* fallback to statusContent only */ }
  }
  const source = resultContent || statusContent;
  const billingSummary = safeTask(source).billing;
  const videos = [];
  const pushVideo = (rawUrl) => {
    const safe = safeImageUrl(rawUrl);
    if (safe && !videos.includes(safe)) videos.push(safe);
  };
  pushVideo(source?.result?.video_url);
  pushVideo(source?.video_url);
  if (Array.isArray(source?.items)) for (const item of source.items.slice(0, 10)) pushVideo(item?.video_url);
  const cover_url = safeImageUrl(source?.result?.cover_url || source?.cover_url);
  return {
    status: summary.status,
    message: privateFailureReason(statusContent.message || source?.message || ''),
    session_url: safeImageUrl(source?.session_url || statusContent.session_url || row.session_url),
    billing: billingSummary,
    videos,
    cover_url,
    failure: safeVideoFailure(source?.failure || statusContent?.failure),
  };
}
function sanitizeDanceSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const messages = [];
  const rawMessages = Array.isArray(value.messages) ? value.messages.slice(-20) : Array.isArray(value.events) ? value.events.slice(-20) : [];
  for (const entry of rawMessages) {
    if (typeof entry === 'string') {
      const clean = privateFailureReason(entry);
      if (clean) messages.push({ role: 'agent', text: clean });
    } else if (entry && typeof entry === 'object') {
      const clean = privateFailureReason(entry.text || entry.content || entry.message || '');
      if (clean) messages.push({ role: String(entry.role || entry.sender || 'agent').slice(0, 20), text: clean });
    }
  }
  const media = [];
  const collectMedia = (item) => {
    const safe = safeImageUrl(typeof item === 'string' ? item : item?.url || item?.video_url || item?.image_url);
    if (safe && !media.includes(safe)) media.push(safe);
  };
  if (Array.isArray(value.media_links)) value.media_links.slice(0, 10).forEach(collectMedia);
  if (Array.isArray(value.artifacts)) value.artifacts.slice(0, 10).forEach(collectMedia);
  return {
    status: typeof value.status === 'string' ? value.status.slice(0, 40) : null,
    stage: typeof value.stage === 'string' ? privateFailureReason(value.stage) : null,
    auto_mode: typeof value.auto_mode === 'boolean' ? value.auto_mode : null,
    latest_message: privateFailureReason(value.latest_message || value.message || ''),
    session_url: safeImageUrl(value.session_url),
    messages,
    media,
  };
}
async function danceSession(env, user, session, request) {
  const input = await imageJson(request);
  if (Object.keys(input || {}).some((k) => !['id', 'acknowledge'].includes(k))) throw fail('Permintaan tidak valid.', 400);
  const row = await danceRowForTask(env, user, session, input);
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_video_session', arguments: { task_id: row.task_id } },
  }, 'task', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('task', 'response');
  return sanitizeDanceSession(content);
}
async function danceMessage(env, user, session, request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['id', 'message', 'auto_mode'].includes(k))) {
    throw fail('Permintaan pesan sesi tidak valid.', 400);
  }
  const msg = typeof input.message === 'string' ? input.message.trim() : '';
  if (!msg || msg.length > 2000) throw fail('Isi pesan untuk sutradara dance (1–2000 karakter).', 400);
  const row = await danceRowForTask(env, user, session, { id: input.id });
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'send_video_agent_message',
      arguments: {
        task_id: row.task_id,
        message: msg,
        ...(typeof input.auto_mode === 'boolean' ? { auto_mode: input.auto_mode } : {}),
      },
    },
  }, 'task', headers, 262144);
  const content = modelContent(result);
  return {
    reply: privateFailureReason(content?.reply || content?.message || ''),
    session: content ? sanitizeDanceSession(content) : null,
  };
}

// --- Singing & Lip-Sync Video Director (generate_singing_video / generate_lip_sync_video) ---
const SINGING_RATIOS = new Set(['9:16', '16:9', '1:1']);
const VOCAL_TOOLS_ALLOWED = new Set(['generate_singing_video', 'generate_lip_sync_video']);
const SINGING_ALLOWED_KEYS = new Set([
  'tool',
  'mode',
  'image_urls',
  'duration_seconds',
  'music_id',
  'audio_url',
  'audio_start_seconds',
  'aspect_ratio',
  'scene_prompt',
  'remove_watermark',
]);
const LIP_SYNC_ALLOWED_KEYS = new Set([
  'tool',
  'video_url',
  'video_duration_ms',
  'music_id',
  'audio_url',
  'audio_duration_ms',
  'name',
  'remove_watermark',
]);

let cachedVocalSchemaMeta = null;

function extractVocalSchemaMetaFromTools(toolList) {
  const meta = {
    singingModes: [],
    singingMinDuration: null,
    singingMaxDuration: null,
    singingMaxImages: 5,
    lipSyncMinDurationMs: null,
    lipSyncMaxDurationMs: null,
    lipSyncMinAudioMs: null,
    lipSyncMaxAudioMs: null,
  };
  if (!Array.isArray(toolList)) return meta;
  for (const tool of toolList) {
    if (!tool || typeof tool !== 'object') continue;
    if (tool.name === 'generate_singing_video') {
      const props = tool.inputSchema?.properties || {};
      if (Array.isArray(props.mode?.enum)) {
        meta.singingModes = props.mode.enum
          .filter((item) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item))
          .slice(0, 20);
      }
      if (typeof props.duration_seconds?.minimum === 'number' && Number.isFinite(props.duration_seconds.minimum)) {
        meta.singingMinDuration = props.duration_seconds.minimum;
      }
      if (typeof props.duration_seconds?.maximum === 'number' && Number.isFinite(props.duration_seconds.maximum)) {
        meta.singingMaxDuration = props.duration_seconds.maximum;
      }
      if (Number.isSafeInteger(props.image_urls?.maxItems) && props.image_urls.maxItems >= 1 && props.image_urls.maxItems <= 10) {
        meta.singingMaxImages = props.image_urls.maxItems;
      }
    }
    if (tool.name === 'generate_lip_sync_video') {
      const props = tool.inputSchema?.properties || {};
      if (typeof props.video_duration_ms?.minimum === 'number' && Number.isFinite(props.video_duration_ms.minimum)) {
        meta.lipSyncMinDurationMs = props.video_duration_ms.minimum;
      }
      if (typeof props.video_duration_ms?.maximum === 'number' && Number.isFinite(props.video_duration_ms.maximum)) {
        meta.lipSyncMaxDurationMs = props.video_duration_ms.maximum;
      }
      if (typeof props.audio_duration_ms?.minimum === 'number' && Number.isFinite(props.audio_duration_ms.minimum)) {
        meta.lipSyncMinAudioMs = props.audio_duration_ms.minimum;
      }
      if (typeof props.audio_duration_ms?.maximum === 'number' && Number.isFinite(props.audio_duration_ms.maximum)) {
        meta.lipSyncMaxAudioMs = props.audio_duration_ms.maximum;
      }
    }
  }
  return meta;
}

async function discoverVocalToolSchemaMeta(accessToken, existingHeaders = null) {
  try {
    const headers = existingHeaders || await openMcp(accessToken);
    const collected = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const { result } = await rpc(
        accessToken,
        { jsonrpc: '2.0', id: page + 10, method: 'tools/list', params: cursor ? { cursor } : {} },
        'inspect',
        headers,
        262144,
      );
      if (!Array.isArray(result?.tools)) break;
      for (const tool of result.tools) {
        if (tool && (tool.name === 'generate_singing_video' || tool.name === 'generate_lip_sync_video')) {
          collected.push(tool);
        }
      }
      if (collected.length >= 2 || !result.nextCursor) break;
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length > 1024 || cursors.has(result.nextCursor)) break;
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    if (!collected.length) return cachedVocalSchemaMeta;
    const parsed = extractVocalSchemaMetaFromTools(collected);
    cachedVocalSchemaMeta = parsed;
    return parsed;
  } catch {
    return cachedVocalSchemaMeta;
  }
}

function resolveSingingMode(rawMode, schemaMeta, imageCount = 1) {
  const clean = typeof rawMode === 'string' ? rawMode.trim() : '';
  if (clean && !/^[A-Za-z0-9_-]{1,64}$/.test(clean)) {
    throw fail('Format mode bernyanyi tidak valid.', 400);
  }
  const modes = Array.isArray(schemaMeta?.singingModes) ? schemaMeta.singingModes : [];
  if (modes.length > 0) {
    if (clean && modes.includes(clean)) return clean;
    const soloAlias = !clean || ['auto', 'solo', 'single', 'standard', 'normal', 'default'].includes(clean.toLowerCase());
    if (!clean || clean.toLowerCase() === 'auto') {
      if (imageCount >= 2 && modes.includes('duet')) return 'duet';
      return modes.find((m) => m.toLowerCase() !== 'duet') || modes[0];
    }
    if (soloAlias) {
      return modes.find((m) => m.toLowerCase() !== 'duet') || modes[0];
    }
    return clean;
  }
  if (!clean || clean.toLowerCase() === 'auto') {
    return imageCount >= 2 ? 'duet' : 'solo';
  }
  return clean;
}

function normalizeVocalMusicId(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw fail('music_id harus berupa bilangan bulat >= 0.', 400);
    return value;
  }
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return null;
  if (!/^\d{1,15}$/.test(s)) {
    throw fail('music_id untuk singing/lip-sync video harus berupa bilangan bulat (integer) atau gunakan audio_url.', 400);
  }
  return Number(s);
}

function validateSingingInput(input, schemaMeta = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !SINGING_ALLOWED_KEYS.has(k))) {
    throw fail('Parameter singing video tidak valid.', 400);
  }
  const maxImages = schemaMeta?.singingMaxImages || 5;
  if (!Array.isArray(input.image_urls) || input.image_urls.length === 0) {
    throw fail('Singing video wajib menyertakan minimal 1 foto karakter/penyanyi.', 400);
  }
  if (input.image_urls.length > maxImages) {
    throw fail(`Maksimal ${maxImages} foto penyanyi.`, 400);
  }
  const image_urls = input.image_urls.map((raw) => {
    const safe = consumerImageUrl(typeof raw === 'string' ? raw : '');
    if (!safe) throw fail('Setiap foto penyanyi harus berupa URL HTTPS publik yang valid.', 400);
    return safe;
  });
  const durNum = Number(input.duration_seconds);
  if (!Number.isFinite(durNum) || durNum <= 0 || durNum > 600) {
    throw fail('duration_seconds harus berupa angka > 0 dan <= 600 detik.', 400);
  }
  if (typeof schemaMeta?.singingMinDuration === 'number' && durNum < schemaMeta.singingMinDuration) {
    throw fail(`duration_seconds minimal ${schemaMeta.singingMinDuration} detik sesuai skema Freebeat.`, 400);
  }
  if (typeof schemaMeta?.singingMaxDuration === 'number' && durNum > schemaMeta.singingMaxDuration) {
    throw fail(`duration_seconds maksimal ${schemaMeta.singingMaxDuration} detik sesuai skema Freebeat.`, 400);
  }
  const mode = resolveSingingMode(input.mode, schemaMeta, image_urls.length);

  let music_id = null;
  if (input.music_id !== undefined && input.music_id !== null && input.music_id !== '') {
    music_id = normalizeVocalMusicId(input.music_id);
  }
  let audio_url = null;
  if (input.audio_url !== undefined && input.audio_url !== null && String(input.audio_url).trim() !== '') {
    audio_url = consumerImageUrl(typeof input.audio_url === 'string' ? input.audio_url : '');
    if (!audio_url) throw fail('audio_url harus berupa URL HTTPS publik yang valid.', 400);
  }
  if (music_id === null && !audio_url) {
    throw fail('Isi music_id atau audio_url HTTPS untuk singing video.', 400);
  }

  let audio_start_seconds;
  if (input.audio_start_seconds !== undefined && input.audio_start_seconds !== null && input.audio_start_seconds !== '') {
    const startNum = Number(input.audio_start_seconds);
    if (!Number.isFinite(startNum) || startNum < 0 || startNum > 600) {
      throw fail('audio_start_seconds harus berupa angka >= 0 dan <= 600 detik.', 400);
    }
    audio_start_seconds = startNum;
  }

  const rawRatio = typeof input.aspect_ratio === 'string' ? input.aspect_ratio.trim() : '';
  if (rawRatio && !SINGING_RATIOS.has(rawRatio)) {
    throw fail('Rasio aspek singing video harus 9:16, 16:9, atau 1:1.', 400);
  }
  const aspect_ratio = rawRatio || '9:16';

  let scene_prompt = '';
  if (input.scene_prompt !== undefined && input.scene_prompt !== null) {
    if (typeof input.scene_prompt !== 'string' || input.scene_prompt.trim().length > 2000) {
      throw fail('scene_prompt maksimal 2000 karakter.', 400);
    }
    scene_prompt = input.scene_prompt.trim();
  }
  const remove_watermark = input.remove_watermark === true;

  return {
    mode,
    image_urls,
    duration_seconds: durNum,
    aspect_ratio,
    ...(music_id !== null ? { music_id } : {}),
    ...(!music_id && audio_url ? { audio_url } : {}),
    ...(audio_start_seconds !== undefined ? { audio_start_seconds } : {}),
    ...(scene_prompt ? { scene_prompt } : {}),
    ...(remove_watermark ? { remove_watermark: true } : {}),
  };
}

function validateLipSyncInput(input, schemaMeta = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !LIP_SYNC_ALLOWED_KEYS.has(k))) {
    throw fail('Parameter lip-sync video tidak valid.', 400);
  }
  const video_url = consumerImageUrl(typeof input.video_url === 'string' ? input.video_url : '');
  if (!video_url) {
    throw fail('Lip-sync video wajib menyertakan video_url HTTPS publik yang valid.', 400);
  }
  const vidDurMs = Number(input.video_duration_ms);
  if (!Number.isSafeInteger(vidDurMs) || vidDurMs <= 0 || vidDurMs > 600000) {
    throw fail('video_duration_ms harus berupa bilangan bulat milidetik (> 0 dan <= 600000).', 400);
  }
  if (typeof schemaMeta?.lipSyncMinDurationMs === 'number' && vidDurMs < schemaMeta.lipSyncMinDurationMs) {
    throw fail(`video_duration_ms minimal ${schemaMeta.lipSyncMinDurationMs} ms sesuai skema Freebeat.`, 400);
  }
  if (typeof schemaMeta?.lipSyncMaxDurationMs === 'number' && vidDurMs > schemaMeta.lipSyncMaxDurationMs) {
    throw fail(`video_duration_ms maksimal ${schemaMeta.lipSyncMaxDurationMs} ms sesuai skema Freebeat.`, 400);
  }

  let music_id = null;
  if (input.music_id !== undefined && input.music_id !== null && input.music_id !== '') {
    music_id = normalizeVocalMusicId(input.music_id);
  }
  let audio_url = null;
  if (input.audio_url !== undefined && input.audio_url !== null && String(input.audio_url).trim() !== '') {
    audio_url = consumerImageUrl(typeof input.audio_url === 'string' ? input.audio_url : '');
    if (!audio_url) throw fail('audio_url harus berupa URL HTTPS publik yang valid.', 400);
  }
  if (music_id === null && !audio_url) {
    throw fail('Isi music_id atau audio_url HTTPS untuk lip-sync video.', 400);
  }

  let audio_duration_ms;
  if (input.audio_duration_ms !== undefined && input.audio_duration_ms !== null && input.audio_duration_ms !== '') {
    const audDurMs = Number(input.audio_duration_ms);
    if (!Number.isSafeInteger(audDurMs) || audDurMs <= 0 || audDurMs > 600000) {
      throw fail('audio_duration_ms harus berupa bilangan bulat milidetik (> 0 dan <= 600000).', 400);
    }
    if (typeof schemaMeta?.lipSyncMinAudioMs === 'number' && audDurMs < schemaMeta.lipSyncMinAudioMs) {
      throw fail(`audio_duration_ms minimal ${schemaMeta.lipSyncMinAudioMs} ms sesuai skema Freebeat.`, 400);
    }
    if (typeof schemaMeta?.lipSyncMaxAudioMs === 'number' && audDurMs > schemaMeta.lipSyncMaxAudioMs) {
      throw fail(`audio_duration_ms maksimal ${schemaMeta.lipSyncMaxAudioMs} ms sesuai skema Freebeat.`, 400);
    }
    audio_duration_ms = audDurMs;
  }

  let name = '';
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string' || input.name.trim().length > 200) {
      throw fail('Nama klip lip-sync maksimal 200 karakter.', 400);
    }
    name = input.name.trim();
  }
  const remove_watermark = input.remove_watermark === true;

  return {
    video_url,
    video_duration_ms: vidDurMs,
    ...(music_id !== null ? { music_id } : {}),
    ...(!music_id && audio_url ? { audio_url } : {}),
    ...(audio_duration_ms !== undefined ? { audio_duration_ms } : {}),
    ...(name ? { name } : {}),
    ...(remove_watermark ? { remove_watermark: true } : {}),
  };
}

function validateVocalRequest(input, schemaMeta = null) {
  const tool = typeof input?.tool === 'string' ? input.tool.trim() : '';
  if (!VOCAL_TOOLS_ALLOWED.has(tool)) {
    throw fail('Tool tidak valid. Pilih generate_singing_video atau generate_lip_sync_video.', 400);
  }
  const parameters = tool === 'generate_singing_video'
    ? validateSingingInput(input, schemaMeta)
    : validateLipSyncInput(input, schemaMeta);
  return { tool, parameters };
}

async function vocalUploadVideo(accessToken, input, existingHeaders = null, captureToolError = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'video_url')) {
    throw fail('Permintaan upload video tidak valid.', 400);
  }
  const videoUrl = consumerImageUrl(typeof input.video_url === 'string' ? input.video_url : '');
  if (!videoUrl) {
    throw fail('Masukkan URL video HTTPS publik yang valid (MP4, MOV, WebM).', 400);
  }
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'upload_video', arguments: { url: videoUrl } },
  }, 'upload', headers, 262144, captureToolError);
  if (captureToolError && (result?.isError || result?.error)) {
    if (isFreebeatBalanceExhausted(result)) throw fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 402);
    throw mcpFailure('upload', 'rpc');
  }
  if (result?.isError) throw mcpFailure('upload', 'response');
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('upload', 'response');

  const hostedUrl = safeImageUrl(
    content.video_url
    || content.url
    || content.download_url
    || content.file_url
    || content.result?.video_url
    || content.file?.download_url,
  );
  let durationMs = null;
  const rawMs = content.video_duration_ms ?? content.duration_ms;
  if (typeof rawMs === 'number' && Number.isFinite(rawMs) && rawMs > 0 && rawMs <= 600000) {
    durationMs = Math.round(rawMs);
  } else if (typeof content.duration === 'number' && Number.isFinite(content.duration) && content.duration > 0 && content.duration <= 600) {
    durationMs = Math.round(content.duration * 1000);
  }
  const rawFileId = content.file_id ?? content.video_id ?? content.id;
  const fileId = (typeof rawFileId === 'string' || typeof rawFileId === 'number')
    && /^[A-Za-z0-9_.:-]{1,256}$/.test(String(rawFileId).trim())
    ? String(rawFileId).trim()
    : null;
  return {
    video_url: hostedUrl || videoUrl,
    hosted: Boolean(hostedUrl),
    duration_ms: durationMs,
    file_id: fileId,
    status: content.status === 'preparing' ? 'preparing' : 'ready',
  };
}

async function vocalQuote(accessToken, tool, parameters, raw = false, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'quote_generation', arguments: { tool, parameters } },
  }, 'quote', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('quote', 'response');
  return raw ? content : safeQuote(content);
}

const vocalDb = (env, path, options = {}) => imageDb(env, path, options, 'vocal');

async function vocalMark(env, uid, id, status, extra = {}) {
  const rows = await vocalDb(env, `?id=eq.${encodeURIComponent(id)}&admin_id=eq.${encodeURIComponent(uid)}&status=eq.dispatching`, {
    method: 'PATCH',
    body: { status, ...extra, updated_at: new Date().toISOString() },
  });
  if (rows.length !== 1) throw fail('Status penyimpanan uji singing/lip-sync video tidak dapat dipastikan.', 503);
}

async function prepareVocal(env, user, session, input) {
  await requireImageSession(session);
  const headers = await openMcp(session.accessToken);
  const schemaMeta = await discoverVocalToolSchemaMeta(session.accessToken, headers);
  const { tool, parameters } = validateVocalRequest(input, schemaMeta);
  const rawQuote = await vocalQuote(session.accessToken, tool, parameters, true, headers);
  const credits = quotedCredits(rawQuote);
  const accept_unknown_cost = credits === null;
  const max_credits = credits !== null ? credits + videoHeadroom(credits) : null;
  const expires = Date.now() + APPROVAL_LIFETIME;
  const approval = await seal({
    id: crypto.randomUUID(),
    uid: user.id,
    sessionHash: await sessionHash(session),
    tool,
    parameters,
    credits,
    max_credits,
    accept_unknown_cost,
    expires,
  }, env, 'vocal-approval');
  if (approval.length > 14000) throw fail('Input terlalu besar untuk persetujuan uji singing/lip-sync video.', 400);
  return {
    approval,
    tool,
    parameters,
    schema_meta: schemaMeta,
    credits,
    max_credits,
    accept_unknown_cost,
    cost_mode: accept_unknown_cost ? 'accept_unknown_cost' : 'max_credits',
    quote: safeQuote(rawQuote),
    expiresAt: expires,
  };
}

async function submitVocal(env, user, session, request) {
  await requireImageSession(session);
  const input = await imageJson(request);
  const allowedKeys = new Set(['approval', 'confirm', 'confirm_unknown_cost', 'private_diagnostics']);
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).some((k) => !allowedKeys.has(k))
    || input.confirm !== true
    || (input.private_diagnostics !== undefined && typeof input.private_diagnostics !== 'boolean')
    || typeof input.approval !== 'string'
    || input.approval.length > 14000
  ) {
    throw fail('Persetujuan uji singing/lip-sync video tidak valid.', 400);
  }
  const captureDiagnostics = input.private_diagnostics === true;
  const ticket = await unseal(input.approval, env, 'vocal-approval', 14000);
  if (!ticket || ticket.uid !== user.id || ticket.sessionHash !== await sessionHash(session) || !TEST_ID.test(ticket.id || '') || !VOCAL_TOOLS_ALLOWED.has(ticket.tool) || !Number.isFinite(ticket.expires) || ticket.expires <= Date.now() || ticket.expires > Date.now() + APPROVAL_LIFETIME) {
    throw fail('Persetujuan kedaluwarsa atau tidak cocok. Buat quote baru.', 400);
  }
  const { tool, parameters } = validateVocalRequest({ tool: ticket.tool, ...ticket.parameters }, null);
  if (ticket.accept_unknown_cost === true && input.confirm_unknown_cost !== true) {
    throw fail('Persetujuan biaya tidak diketahui di awal diperlukan untuk mengirimkan video tanpa quote pasti.', 400);
  }
  const headers = await openMcp(session.accessToken);
  const current = quotedCredits(await vocalQuote(session.accessToken, tool, parameters, true, headers));
  if (ticket.accept_unknown_cost === false) {
    if (current === null || current !== ticket.credits) throw fail('Quote berubah atau tidak tersedia. Tidak ada video dikirim; buat quote baru.', 409);
  } else if (current !== null) {
    throw fail('Quote numerik kini tersedia. Buat persetujuan ulang agar batas maksimum kredit dikirim.', 409);
  }
  if (ticket.expires <= Date.now()) throw fail('Persetujuan kedaluwarsa; tidak ada video dikirim.', 400);
  const rows = await vocalDb(env, '', {
    method: 'POST',
    body: {
      id: ticket.id,
      admin_id: user.id,
      session_hash: ticket.sessionHash,
      tool_name: tool,
      mode: tool === 'generate_singing_video' ? parameters.mode : null,
      aspect_ratio: tool === 'generate_singing_video' ? parameters.aspect_ratio : null,
      duration_seconds: tool === 'generate_singing_video' ? parameters.duration_seconds : null,
      video_duration_ms: tool === 'generate_lip_sync_video' ? parameters.video_duration_ms : null,
      quote_credits: ticket.credits,
      max_credits: ticket.accept_unknown_cost ? null : ticket.max_credits,
      accept_unknown_cost: ticket.accept_unknown_cost,
      status: 'dispatching',
    },
  });
  if (rows.length !== 1 || rows[0]?.id !== ticket.id) {
    throw fail('Pencatatan belum dapat dipastikan. Jangan ulangi sebelum memeriksa catatan.', 503);
  }
  if (ticket.expires <= Date.now()) {
    try { await vocalMark(env, user.id, ticket.id, 'reviewed', { task_id: null }); } catch { /* retain lock */ }
    throw fail('Persetujuan kedaluwarsa sebelum pengiriman; tidak ada video dikirim.', 409);
  }
  let content;
  let initialDiagnostics = null;
  try {
    const args = {
      ...parameters,
      ...(ticket.accept_unknown_cost ? { accept_unknown_cost: true } : { max_credits: ticket.max_credits }),
    };
    const { result } = await rpc(session.accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }, 'generate', headers, 262144, captureDiagnostics);
    if (captureDiagnostics) {
      const messages = initialVideoMessages(result);
      if (!messages.length && result && typeof result === 'object') {
        const structured = modelContent(result);
        const target = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : result;
        const keys = Object.keys(target).filter((k) => !/secret|token|password|credential|key/i.test(k)).slice(0, 20);
        if (keys.length) messages.push(`root_keys: ${keys.join(', ')}`);
      }
      initialDiagnostics = { received: true, messages: messages.slice(0, 50) };
    }
    if (result.isError) throw new Error('unrecognized');
    content = modelContent(result);
    if (!content || typeof content !== 'object') throw new Error('unrecognized');
  } catch (err) {
    try { await vocalMark(env, user.id, ticket.id, 'unknown', { task_id: null }); } catch { /* retain lock */ }
    return {
      id: ticket.id,
      status: 'unknown',
      ...(captureDiagnostics
        ? {
            initial_diagnostics: initialDiagnostics || {
              received: false,
              messages: err?.message ? [privateFailureReason(err.message) || err.message] : [],
            },
          }
        : {}),
    };
  }
  if (content.success === true && content.status === 'preparing' && content.music_id !== undefined && content.music_id !== null && !content.task_id) {
    try { await vocalMark(env, user.id, ticket.id, 'reviewed', { task_id: null }); } catch { /* retain lock */ }
    return {
      id: ticket.id,
      status: 'preparing',
      music_id: String(content.music_id),
      retry_after_seconds: Number.isFinite(content.retry_after_seconds) ? content.retry_after_seconds : 10,
      ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
    };
  }
  const taskId = typeof content.task_id === 'string' && TASK_ID.test(content.task_id) ? content.task_id : null;
  if (!taskId) {
    try { await vocalMark(env, user.id, ticket.id, 'unknown', { task_id: null }); } catch { /* retain lock */ }
    return {
      id: ticket.id,
      status: 'unknown',
      ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
    };
  }
  const sessionUrl = safeImageUrl(content.session_url);
  try {
    await vocalMark(env, user.id, ticket.id, 'submitted', { task_id: taskId, ...(sessionUrl ? { session_url: sessionUrl } : {}) });
  } catch {
    return {
      id: ticket.id,
      status: 'unknown',
      recoveryTaskId: taskId,
      ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
    };
  }
  return {
    id: ticket.id,
    status: 'submitted',
    ...(sessionUrl ? { session_url: sessionUrl } : {}),
    ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
  };
}

async function vocalTests(env, user, session) {
  const rows = await vocalDb(env, `?admin_id=eq.${encodeURIComponent(user.id)}&select=id,tool_name,mode,aspect_ratio,duration_seconds,video_duration_ms,quote_credits,max_credits,accept_unknown_cost,status,session_url,created_at,session_hash&order=created_at.desc&limit=20`);
  const hash = await sessionHash(session);
  return rows.map((row) => ({
    id: row.id,
    tool_name: row.tool_name,
    mode: row.mode,
    aspect_ratio: row.aspect_ratio,
    duration_seconds: row.duration_seconds,
    video_duration_ms: row.video_duration_ms,
    quote_credits: row.quote_credits,
    max_credits: row.max_credits,
    accept_unknown_cost: row.accept_unknown_cost === true,
    status: row.status,
    session_url: safeImageUrl(row.session_url),
    created_at: row.created_at,
    canPoll: row.status === 'submitted' && row.session_hash === hash,
  }));
}

async function vocalRowForTask(env, user, session, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !TEST_ID.test(input.id)) {
    throw fail('ID uji vokal/lip-sync tidak valid.', 400);
  }
  const rows = await vocalDb(env, `?id=eq.${encodeURIComponent(input.id)}&admin_id=eq.${encodeURIComponent(user.id)}&select=status,task_id,session_hash,session_url&limit=1`);
  const row = rows[0];
  const sameSession = Boolean(row) && row.session_hash === await sessionHash(session);
  if (!row || row.status !== 'submitted' || typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id) || (!sameSession && input.acknowledge !== true)) {
    throw fail('Uji singing/lip-sync video tidak tersedia pada sesi Freebeat ini.', 404);
  }
  return row;
}

async function pollVocal(env, user, session, request) {
  const input = await imageJson(request);
  if (Object.keys(input || {}).some((k) => !['id', 'acknowledge'].includes(k))) throw fail('Permintaan tidak valid.', 400);
  const row = await vocalRowForTask(env, user, session, input);
  const headers = await openMcp(session.accessToken);
  const { result: statusRes } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_task_status', arguments: { task_id: row.task_id } },
  }, 'task', headers, 262144);
  const statusContent = modelContent(statusRes);
  if (!statusContent || typeof statusContent !== 'object' || Array.isArray(statusContent)) throw mcpFailure('task', 'response');
  const summary = safeTask(statusContent);
  let resultContent = null;
  if (['completed', 'failed', 'action_required'].includes(summary.status)) {
    try {
      const { result: finalRes } = await rpc(session.accessToken, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_task_result', arguments: { task_id: row.task_id } },
      }, 'task', headers, 262144);
      const parsed = modelContent(finalRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resultContent = parsed;
    } catch { /* fallback to statusContent */ }
  }
  const source = resultContent || statusContent;
  const billingSummary = safeTask(source).billing;
  const videos = [];
  const pushVideo = (rawUrl) => {
    const safe = safeImageUrl(rawUrl);
    if (safe && !videos.includes(safe)) videos.push(safe);
  };
  pushVideo(source?.result?.video_url);
  pushVideo(source?.video_url);
  if (Array.isArray(source?.items)) for (const item of source.items.slice(0, 10)) pushVideo(item?.video_url);
  const cover_url = safeImageUrl(source?.result?.cover_url || source?.cover_url);
  return {
    status: summary.status,
    message: privateFailureReason(statusContent.message || source?.message || ''),
    session_url: safeImageUrl(source?.session_url || statusContent.session_url || row.session_url),
    billing: billingSummary,
    videos,
    cover_url,
    failure: safeVideoFailure(source?.failure || statusContent?.failure),
  };
}

async function vocalSession(env, user, session, request) {
  const input = await imageJson(request);
  if (Object.keys(input || {}).some((k) => !['id', 'acknowledge'].includes(k))) throw fail('Permintaan tidak valid.', 400);
  const row = await vocalRowForTask(env, user, session, input);
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_video_session', arguments: { task_id: row.task_id } },
  }, 'task', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('task', 'response');
  return sanitizeDanceSession(content);
}

async function vocalMessage(env, user, session, request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['id', 'message', 'auto_mode'].includes(k))) {
    throw fail('Permintaan pesan sesi tidak valid.', 400);
  }
  const msg = typeof input.message === 'string' ? input.message.trim() : '';
  if (!msg || msg.length > 2000) throw fail('Isi pesan untuk agen video Freebeat (1–2000 karakter).', 400);
  const row = await vocalRowForTask(env, user, session, { id: input.id });
  const headers = await openMcp(session.accessToken);
  const { result } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'send_video_agent_message',
      arguments: {
        task_id: row.task_id,
        message: msg,
        ...(typeof input.auto_mode === 'boolean' ? { auto_mode: input.auto_mode } : {}),
      },
    },
  }, 'task', headers, 262144);
  const content = modelContent(result);
  return {
    reply: privateFailureReason(content?.reply || content?.message || ''),
    session: content ? sanitizeDanceSession(content) : null,
  };
}

// --- Admin Music Generation Diagnostics (generate_music) --------------------

const MUSIC_BODY_MAX_BYTES = 98304;
const MUSIC_APPROVAL_MAX_LEN = 98304;
const MUSIC_SUBMIT_MAX_BYTES = 114688;
const musicDb = (env, path, options = {}) => imageDb(env, path, options, 'music');

async function musicMark(env, uid, id, status, taskId = null) {
  const rows = await musicDb(env, `?id=eq.${encodeURIComponent(id)}&admin_id=eq.${encodeURIComponent(uid)}&status=eq.dispatching`, {
    method: 'PATCH',
    body: { status, task_id: taskId, updated_at: new Date().toISOString() },
  });
  if (rows.length !== 1) throw fail('Status penyimpanan uji musik tidak dapat dipastikan.', 503);
}

async function fetchRawMusicModels(accessToken, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_music_models', arguments: {} },
  }, 'models', headers, 262144);
  if (result?.isError || result?.error) throw mcpFailure('models', 'rpc');
  const content = modelContent(result);
  const list = extractCatalogList(content, 'models');
  if (!Array.isArray(list)) throw mcpFailure('models', 'response');
  return list.slice(0, 100).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const model_id = item.model_id ?? item.modelId ?? item.id;
    const rawName = item.display_name ?? item.displayName ?? item.name;
    if (!Number.isSafeInteger(model_id) || model_id <= 0 || typeof rawName !== 'string' || !rawName.trim()) return [];
    const name = privateFailureReason(rawName.trim())?.slice(0, 200) || `Model #${model_id}`;
    const rawCredits = item.pricing?.credits ?? item.credits;
    const credits = typeof rawCredits === 'number' && Number.isFinite(rawCredits) && rawCredits >= 0 ? rawCredits : null;
    const pricing_status = typeof item.pricing?.status === 'string' ? item.pricing.status : null;
    return [{
      model_id,
      name,
      available: item.available !== false,
      pricing_status,
      credits,
      supports_duration: item.supports_duration === true,
      supports_lyrics: typeof item.supports_lyrics === 'boolean' ? item.supports_lyrics : null,
      supports_instrumental: typeof item.supports_instrumental === 'boolean' ? item.supports_instrumental : null,
      requires_lyrics: item.requires_lyrics === true,
    }];
  });
}

function validateMusicRequest(input, catalogModels = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('Parameter uji musik tidak valid.', 400);
  }
  const allowed = new Set(['model_id', 'prompt', 'instrumental', 'lyrics', 'duration_seconds']);
  if (Object.keys(input).some((k) => !allowed.has(k))) {
    throw fail('Parameter uji musik tidak dikenali.', 400);
  }
  const modelId = input.model_id;
  if (!Number.isSafeInteger(modelId) || modelId < 1 || modelId > 999999999) {
    throw fail('model_id musik harus berupa bilangan bulat positif.', 400);
  }
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!prompt || prompt.length > 2000) {
    throw fail('Prompt musik wajib diisi (1–2000 karakter).', 400);
  }
  let instrumental = false;
  if (input.instrumental !== undefined) {
    if (typeof input.instrumental !== 'boolean') {
      throw fail('instrumental harus berupa boolean.', 400);
    }
    instrumental = input.instrumental;
  }
  let lyrics = null;
  if (input.lyrics !== undefined && input.lyrics !== null) {
    if (typeof input.lyrics !== 'string') {
      throw fail('lyrics harus berupa teks.', 400);
    }
    const cleanLyrics = input.lyrics.trim();
    if (cleanLyrics.length > 12000) {
      throw fail('lyrics maksimal 12000 karakter.', 400);
    }
    if (cleanLyrics.length > 0) lyrics = cleanLyrics;
  }
  if (instrumental && lyrics) {
    throw fail('Tidak dapat mengaktifkan instrumental=true sekaligus mengisi lyrics.', 400);
  }
  let durationSeconds = null;
  if (input.duration_seconds !== undefined && input.duration_seconds !== null && input.duration_seconds !== '') {
    if (typeof input.duration_seconds !== 'number' || !Number.isFinite(input.duration_seconds) || input.duration_seconds < 10 || input.duration_seconds > 300) {
      throw fail('duration_seconds harus berupa angka 10–300 detik.', 400);
    }
    durationSeconds = input.duration_seconds;
  }

  let matchedModel = null;
  if (Array.isArray(catalogModels)) {
    matchedModel = catalogModels.find((item) => item.model_id === modelId) || null;
    if (!matchedModel) {
      throw fail('Model musik tidak ditemukan pada katalog list_music_models saat ini.', 400);
    }
    if (!matchedModel.available || matchedModel.pricing_status === 'unavailable') {
      throw fail(`Model musik "${matchedModel.name}" sedang unavailable di Freebeat dan tidak dapat dikirim.`, 409);
    }
    if (matchedModel.requires_lyrics && !lyrics) {
      throw fail(`Model musik "${matchedModel.name}" mewajibkan lyrics.`, 400);
    }
    if (matchedModel.supports_lyrics === false && lyrics) {
      throw fail(`Model musik "${matchedModel.name}" tidak mendukung lyrics.`, 400);
    }
    if (matchedModel.supports_instrumental === false && instrumental) {
      throw fail(`Model musik "${matchedModel.name}" tidak mendukung mode instrumental.`, 400);
    }
    if (durationSeconds !== null && !matchedModel.supports_duration) {
      throw fail(`Model musik "${matchedModel.name}" tidak mendukung pengaturan duration_seconds.`, 400);
    }
  }

  return {
    model: matchedModel,
    parameters: {
      model_id: modelId,
      prompt,
      ...(instrumental ? { instrumental: true } : {}),
      ...(lyrics ? { lyrics, instrumental: false } : {}),
      ...(durationSeconds !== null ? { duration_seconds: durationSeconds } : {}),
    },
  };
}

async function musicQuote(accessToken, parameters, raw = false, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'quote_generation', arguments: { tool: 'generate_music', parameters } },
  }, 'quote', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('quote', 'response');
  return raw ? content : safeQuote(content);
}

async function prepareMusic(env, user, session, input) {
  await requireImageSession(session);
  const headers = await openMcp(session.accessToken);
  const catalogModels = await fetchRawMusicModels(session.accessToken, headers);
  const { model, parameters } = validateMusicRequest(input, catalogModels);
  const rawQuote = await musicQuote(session.accessToken, parameters, true, headers);
  const credits = quotedCredits(rawQuote);
  if (credits === null) {
    throw fail('Freebeat tidak memberikan quote numerik untuk model musik ini. Generasi tidak disiapkan.', 409);
  }
  const expires = Date.now() + APPROVAL_LIFETIME;
  const approval = await seal({
    id: crypto.randomUUID(),
    uid: user.id,
    sessionHash: await sessionHash(session),
    model_id: parameters.model_id,
    model_name: model?.name || null,
    parameters,
    credits,
    max_credits: credits,
    expires,
  }, env, 'music-approval');
  if (approval.length > MUSIC_APPROVAL_MAX_LEN) {
    throw fail('Input terlalu besar untuk persetujuan uji musik.', 400);
  }
  return {
    approval,
    model,
    parameters,
    credits,
    max_credits: credits,
    quote: safeQuote(rawQuote),
    expiresAt: expires,
  };
}

async function submitMusic(env, user, session, request) {
  await requireImageSession(session);
  const input = await imageJson(request, MUSIC_SUBMIT_MAX_BYTES);
  const allowedKeys = new Set(['approval', 'confirm', 'private_diagnostics']);
  if (
    !input
    || typeof input !== 'object'
    || Array.isArray(input)
    || Object.keys(input).some((k) => !allowedKeys.has(k))
    || input.confirm !== true
    || (input.private_diagnostics !== undefined && typeof input.private_diagnostics !== 'boolean')
    || typeof input.approval !== 'string'
    || input.approval.length > MUSIC_APPROVAL_MAX_LEN
  ) {
    throw fail('Persetujuan uji musik tidak valid.', 400);
  }
  const captureDiagnostics = input.private_diagnostics === true;
  const ticket = await unseal(input.approval, env, 'music-approval', MUSIC_APPROVAL_MAX_LEN);
  if (
    !ticket
    || ticket.uid !== user.id
    || ticket.sessionHash !== await sessionHash(session)
    || !TEST_ID.test(ticket.id || '')
    || !Number.isFinite(ticket.expires)
    || ticket.expires <= Date.now()
    || ticket.expires > Date.now() + APPROVAL_LIFETIME
    || typeof ticket.credits !== 'number'
    || !Number.isFinite(ticket.credits)
    || ticket.credits < 0
    || ticket.credits > 1000000
    || ticket.max_credits !== ticket.credits
  ) {
    throw fail('Persetujuan kedaluwarsa atau tidak cocok. Buat quote baru.', 400);
  }
  const { parameters } = validateMusicRequest(ticket.parameters, null);
  const headers = await openMcp(session.accessToken);
  const current = quotedCredits(await musicQuote(session.accessToken, parameters, true, headers));
  if (current === null || current !== ticket.credits) {
    throw fail('Quote berubah atau tidak tersedia. Tidak ada musik dikirim; buat quote baru.', 409);
  }
  if (ticket.expires <= Date.now()) {
    throw fail('Persetujuan kedaluwarsa; tidak ada musik dikirim.', 400);
  }
  const rows = await musicDb(env, '', {
    method: 'POST',
    body: {
      id: ticket.id,
      admin_id: user.id,
      session_hash: ticket.sessionHash,
      model_id: parameters.model_id,
      model_name: typeof ticket.model_name === 'string' && ticket.model_name.trim() ? ticket.model_name.trim().slice(0, 200) : null,
      instrumental: parameters.instrumental === true,
      has_lyrics: Boolean(parameters.lyrics),
      duration_seconds: parameters.duration_seconds ?? null,
      quote_credits: ticket.credits,
      max_credits: ticket.max_credits,
      status: 'dispatching',
    },
  });
  if (rows.length !== 1 || rows[0]?.id !== ticket.id) {
    throw fail('Pencatatan belum dapat dipastikan. Jangan ulangi sebelum memeriksa catatan.', 503);
  }
  if (ticket.expires <= Date.now()) {
    try { await musicMark(env, user.id, ticket.id, 'reviewed', null); } catch { /* retain lock */ }
    throw fail('Persetujuan kedaluwarsa sebelum pengiriman; tidak ada musik dikirim.', 409);
  }
  let content;
  let initialDiagnostics = null;
  try {
    const { result } = await rpc(session.accessToken, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'generate_music', arguments: { ...parameters, max_credits: ticket.max_credits } },
    }, 'generate', headers, 262144, captureDiagnostics);
    if (captureDiagnostics) {
      const messages = initialVideoMessages(result);
      if (!messages.length && result && typeof result === 'object') {
        const structured = modelContent(result);
        const target = structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : result;
        const keys = Object.keys(target).filter((k) => !/secret|token|password|credential|key/i.test(k)).slice(0, 20);
        if (keys.length) messages.push(`root_keys: ${keys.join(', ')}`);
      }
      initialDiagnostics = { received: true, messages: messages.slice(0, 50) };
    }
    if (result.isError) throw new Error('unrecognized');
    content = modelContent(result);
    if (!content || typeof content !== 'object') throw new Error('unrecognized');
  } catch (err) {
    try { await musicMark(env, user.id, ticket.id, 'unknown', null); } catch { /* retain lock */ }
    return {
      id: ticket.id,
      status: 'unknown',
      ...(captureDiagnostics
        ? {
            initial_diagnostics: initialDiagnostics || {
              received: false,
              messages: err?.message ? [privateFailureReason(err.message) || err.message] : [],
            },
          }
        : {}),
    };
  }
  const rawTaskId = typeof content.task_id === 'string' && TASK_ID.test(content.task_id)
    ? content.task_id
    : (typeof content.batch_id === 'string' && TASK_ID.test(content.batch_id) ? content.batch_id : null);
  if (!rawTaskId) {
    try { await musicMark(env, user.id, ticket.id, 'unknown', null); } catch { /* retain lock */ }
    return {
      id: ticket.id,
      status: 'unknown',
      ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
    };
  }
  try {
    await musicMark(env, user.id, ticket.id, 'submitted', rawTaskId);
  } catch {
    return {
      id: ticket.id,
      status: 'unknown',
      recoveryTaskId: rawTaskId,
      ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
    };
  }
  return {
    id: ticket.id,
    status: 'submitted',
    ...(initialDiagnostics ? { initial_diagnostics: initialDiagnostics } : {}),
  };
}

async function musicTests(env, user, session) {
  const rows = await musicDb(env, `?admin_id=eq.${encodeURIComponent(user.id)}&select=id,model_id,model_name,instrumental,has_lyrics,duration_seconds,quote_credits,max_credits,status,created_at,session_hash&order=created_at.desc&limit=20`);
  const hash = await sessionHash(session);
  return rows.map((row) => ({
    id: row.id,
    model_id: row.model_id,
    model_name: row.model_name,
    instrumental: row.instrumental === true,
    has_lyrics: row.has_lyrics === true,
    duration_seconds: row.duration_seconds,
    quote_credits: row.quote_credits,
    max_credits: row.max_credits,
    status: row.status,
    created_at: row.created_at,
    canPoll: row.status === 'submitted' && row.session_hash === hash,
  }));
}

function extractResultMusicId(source) {
  const candidates = [
    source?.result?.music_id,
    source?.music_id,
    source?.items?.[0]?.music_id,
    source?.result?.items?.[0]?.music_id,
    source?.audios?.[0]?.music_id,
    source?.result?.audios?.[0]?.music_id,
  ];
  for (const cand of candidates) {
    if (Number.isSafeInteger(cand) && cand > 0) return cand;
    if (typeof cand === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(cand.trim())) return cand.trim();
  }
  return null;
}

function extractMusicAudioUrls(source) {
  const audios = [];
  const push = (rawUrl) => {
    const safe = safeImageUrl(rawUrl);
    if (safe && !audios.includes(safe)) audios.push(safe);
  };
  for (const candidate of [
    source?.result?.audio_url,
    source?.result?.song_url,
    source?.result?.mp3_url,
    source?.result?.url,
    source?.audio_url,
    source?.song_url,
    source?.mp3_url,
  ]) {
    push(candidate);
  }
  for (const list of [source?.result?.audios, source?.audios, source?.result?.items, source?.items]) {
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, 10)) {
      if (typeof item === 'string') {
        push(item);
      } else if (item && typeof item === 'object') {
        push(item.audio_url);
        push(item.song_url);
        push(item.mp3_url);
        push(item.url);
      }
    }
  }
  return audios;
}

function extractMusicCoverUrl(source) {
  return safeImageUrl(
    source?.result?.cover_url
    || source?.cover_url
    || source?.result?.image_url
    || source?.image_url
    || source?.items?.[0]?.cover_url
    || source?.result?.items?.[0]?.cover_url,
  );
}

async function pollMusic(env, user, session, request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['id', 'acknowledge', 'private_result'].includes(k)) || typeof input.id !== 'string' || !TEST_ID.test(input.id)) {
    throw fail('ID uji musik tidak valid.', 400);
  }
  if (input.acknowledge !== undefined && typeof input.acknowledge !== 'boolean') {
    throw fail('acknowledge harus berupa boolean.', 400);
  }
  if (input.private_result !== undefined && typeof input.private_result !== 'boolean') {
    throw fail('private_result harus berupa boolean.', 400);
  }
  const rows = await musicDb(env, `?id=eq.${encodeURIComponent(input.id)}&admin_id=eq.${encodeURIComponent(user.id)}&select=status,task_id,session_hash&limit=1`);
  const row = rows[0];
  const sameSession = Boolean(row) && row.session_hash === await sessionHash(session);
  if (!row || row.status !== 'submitted' || typeof row.task_id !== 'string' || !TASK_ID.test(row.task_id) || (!sameSession && input.acknowledge !== true)) {
    throw fail('Uji musik tidak tersedia pada sesi Freebeat ini.', 404);
  }
  const headers = await openMcp(session.accessToken);
  const { result: statusRes } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_task_status', arguments: { task_id: row.task_id } },
  }, 'task', headers, 262144);
  const statusContent = modelContent(statusRes);
  if (!statusContent || typeof statusContent !== 'object' || Array.isArray(statusContent)) throw mcpFailure('task', 'response');
  const summary = safeTask(statusContent);
  let resultContent = null;
  if (['completed', 'failed', 'partial_failed', 'action_required'].includes(summary.status)) {
    try {
      const { result: finalRes } = await rpc(session.accessToken, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_task_result', arguments: { task_id: row.task_id } },
      }, 'task', headers, 262144);
      const parsed = modelContent(finalRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resultContent = parsed;
    } catch { /* fallback to statusContent */ }
  }
  const source = resultContent || statusContent;
  const billingSummary = safeTask(source).billing;
  if (billingSummary.charged === null && summary.billing.charged !== null) {
    billingSummary.charged = summary.billing.charged;
  }
  if (billingSummary.refunded === null && summary.billing.refunded !== null) {
    billingSummary.refunded = summary.billing.refunded;
  }
  if (billingSummary.net === null && summary.billing.net !== null) {
    billingSummary.net = summary.billing.net;
  }
  const cover_url = extractMusicCoverUrl(source);
  const isFailureStatus = ['failed', 'partial_failed', 'cancelled', 'expired', 'action_required'].includes(summary.status);
  const rawTitle = source?.result?.title ?? source?.title;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? privateFailureReason(rawTitle.trim())?.slice(0, 200) : null;
  const rawDurationMs = source?.result?.duration_ms ?? source?.duration_ms;
  const duration_ms = typeof rawDurationMs === 'number' && Number.isFinite(rawDurationMs) && rawDurationMs >= 0 ? Math.round(rawDurationMs) : null;
  return {
    status: summary.status,
    message: privateFailureReason(statusContent.message || source?.message || ''),
    billing: billingSummary,
    billing_message: privateFailureReason(source?.billing_message || source?.billing?.message || ''),
    music_id: extractResultMusicId(source),
    title,
    duration_ms,
    audios: extractMusicAudioUrls(source),
    cover_url,
    failure: safeVideoFailure(source?.failure || statusContent?.failure) || (isFailureStatus ? (safeOpenRpcFailure(source) || safeOpenRpcFailure(statusContent)) : null),
    ...(input.private_result === true ? { private_structure: privateModelHelp(source).help } : {}),
  };
}

async function optionalStartJson(request) {
  const length = request.headers.get('content-length');
  if (length === '0') return {};
  const type = (request.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('application/json')) return {};
  if (request.headers.get('origin') !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
  try {
    const raw = await boundedJson(request);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

async function dispatchFreebeat(request, url, env, user) {
  try {
    if (!user) return response({ error: 'Login diperlukan.' }, 401);
    if (user.app_metadata?.role !== 'admin') return response({ error: 'Koneksi Freebeat hanya untuk admin.' }, 403);
    const subpath = url.pathname.replace(/^\/api\/freebeat\/?/, '').replace(/\/+$/, '');
    const action = subpath;
    if (['start', 'start-image'].includes(action) && request.method === 'POST') {
      if (url.origin !== new URL(redirectUri(env)).origin) return response({ error: 'Buka BLEA melalui domain callback Freebeat yang dikonfigurasi sebelum menghubungkan akun.' }, 400);
      const startOpts = await optionalStartJson(request);
      return await startFreebeat(env, user.id, startOpts);
    }
    if (action === 'accounts' && request.method === 'GET') {
      const accounts = await listPoolAccountsAdmin(env);
      return response({
        ok: true,
        accounts,
        maxCycles: FREEBEAT_POOL_MAX_CYCLES,
        policy: { maxCycles: FREEBEAT_POOL_MAX_CYCLES, gatewayExhaustedMessage: FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE },
      });
    }
    if (action === 'accounts' && request.method === 'PATCH') {
      const input = await imageJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || !TEST_ID.test(input.id)) {
        throw fail('ID akun OAuth tidak valid.', 400);
      }
      const allowedKeys = new Set(['id', 'account_email', 'account_label', 'enabled', 'priority']);
      if (Object.keys(input).some((k) => !allowedKeys.has(k))) throw fail('Parameter pembaruan akun tidak valid.', 400);
      const patch = { updated_at: new Date().toISOString() };
      if (input.account_email !== undefined) {
        if (typeof input.account_email !== 'string' || input.account_email.trim().length > 320) throw fail('Format email akun tidak valid.', 400);
        const cleanEmail = input.account_email.trim();
        if (cleanEmail && !EMAIL_PATTERN.test(cleanEmail)) throw fail('Masukkan alamat email akun yang valid.', 400);
        patch.account_email = cleanEmail;
        patch.email_source = cleanEmail ? 'manual' : 'unverified';
      }
      if (input.account_label !== undefined) {
        if (typeof input.account_label !== 'string' || input.account_label.trim().length > 100) throw fail('Label akun maksimal 100 karakter.', 400);
        patch.account_label = input.account_label.trim();
      }
      if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') throw fail('Status aktif akun tidak valid.', 400);
        patch.enabled = input.enabled;
      }
      if (input.priority !== undefined) {
        if (!Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > 100000) throw fail('Prioritas harus berupa bilangan bulat 0–100000.', 400);
        patch.priority = input.priority;
      }
      const updated = await dbJson(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(input.id)}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: patch,
      });
      const row = Array.isArray(updated) ? updated[0] : null;
      if (!row) throw fail('Akun OAuth Freebeat tidak ditemukan.', 404);
      return response({ ok: true, account: sanitizePoolAccountRow(row, env) });
    }
    if (action === 'accounts' && request.method === 'DELETE') {
      const input = await imageJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'id') || typeof input.id !== 'string' || !TEST_ID.test(input.id)) {
        throw fail('ID akun OAuth tidak valid.', 400);
      }
      const rows = await dbJson(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(input.id)}&select=*&limit=1`);
      const target = Array.isArray(rows) ? rows[0] : null;
      if (!target) throw fail('Akun OAuth Freebeat tidak ditemukan.', 404);
      let revoked = false;
      const unsealed = target.sealed_session ? await unseal(target.sealed_session, env, 'session', 3800) : null;
      if (unsealed?.accessToken && unsealed?.clientId) {
        try {
          const res = await fetch(REVOKE, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UPSTREAM_MEDIA_USER_AGENT }, body: new URLSearchParams({ token: unsealed.accessToken, client_id: unsealed.clientId }).toString() });
          revoked = res.ok;
        } catch { /* lanjut hapus lokal */ }
      }
      await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(input.id)}`, { method: 'DELETE' });
      await syncLegacySessionFromPool(env, target.connected_by || user.id);
      return response({ ok: true, revoked, deletedId: input.id });
    }
    if (action === 'accounts/reorder' && request.method === 'POST') {
      const input = await imageJson(request);
      const ids = Array.isArray(input?.orderedIds) ? input.orderedIds : null;
      if (!ids || !ids.length || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !TEST_ID.test(id))) {
        throw fail('Daftar urutan akun tidak valid.', 400);
      }
      for (let idx = 0; idx < ids.length; idx += 1) {
        await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(ids[idx])}`, {
          method: 'PATCH',
          body: { priority: (idx + 1) * 10, updated_at: new Date().toISOString() },
        });
      }
      const accounts = await listPoolAccountsAdmin(env);
      return response({ ok: true, accounts });
    }
    if (action === 'accounts/balance' && request.method === 'POST') {
      const input = await optionalStartJson(request);
      if (input.id !== undefined && (typeof input.id !== 'string' || !TEST_ID.test(input.id))) {
        throw fail('ID akun OAuth tidak valid.', 400);
      }
      const result = await checkPoolAccountsBalance(env, input.id || null);
      return response({ ok: true, ...result });
    }
    if (action === 'status' && request.method === 'GET') {
      const session = await readSession(request, env, user.id);
      // expiresAt = umur access token (pendek, diperbarui otomatis).
      // sessionExpiresAt = batas umur koneksi sejak consent (30 hari bawaan).
      const issuedAt = Number.isFinite(session?.issuedAt) ? session.issuedAt : null;
      return response({ connected: Boolean(session), imageAccess: session?.imageAccess === true, expiresAt: session?.expiresAt || null, autoRenew: Boolean(session?.refreshToken), sessionExpiresAt: issuedAt ? issuedAt + sessionMaxAgeMs(env) : null });
    }
    if (action === 'image-model-help' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const input = await imageJson(request);
      const raw = action === 'image-model-help' && input?.acknowledge === true;
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['model_id', 'acknowledge', 'type'].includes(key)) || !Number.isSafeInteger(input.model_id) || input.model_id < 0) throw fail('Masukkan ID model gambar yang valid.', 400);
      const helpType = typeof input.type === 'string' && HELP_TYPES.has(input.type) ? input.type : 'image';
      const help = await imageModelHelp(session.accessToken, input.model_id, raw, helpType);
      return response({ ok: true, model_id: input.model_id, type: helpType, help }, 200, raw ? { 'referrer-policy': 'no-referrer' } : {});
    }
    if (action === 'image-upload-quote' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      await requireImageSession(session);
      const input = await imageJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'image_url')) throw fail('Permintaan tidak valid.', 400);
      const photoUrl = consumerImageUrl(typeof input.image_url === 'string' ? input.image_url : '');
      if (!photoUrl) throw fail('URL foto tidak valid. Gunakan URL HTTPS publik.', 400);
      const opened = await openMcpSession(env, session);
      await requireImageSession(opened.session);
      return response({ ok: true, ...(await imageUploadQuote(opened.session.accessToken, photoUrl, opened.headers)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (action === 'image-upload-host' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      await requireImageSession(session);
      const input = await imageJson(request);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['image_url', 'expected_credits', 'acknowledge', 'accept_unknown_cost'].includes(key)) || input.acknowledge !== true) throw fail('Konfirmasi biaya diperlukan.', 400);
      const photoUrl = consumerImageUrl(typeof input.image_url === 'string' ? input.image_url : '');
      if (!photoUrl) throw fail('URL foto tidak valid. Gunakan URL HTTPS publik.', 400);
      const unknownConsent = input.accept_unknown_cost === true;
      if ((input.accept_unknown_cost !== undefined && !unknownConsent) || (unknownConsent && input.expected_credits !== undefined)) throw fail('Pilih persetujuan biaya numerik atau biaya tidak diketahui, bukan keduanya.', 400);
      const expected = Number.isSafeInteger(input.expected_credits) && input.expected_credits >= 0 && input.expected_credits <= 100 ? input.expected_credits : null;
      if (!unknownConsent && expected === null) throw fail('Batas biaya yang disetujui tidak valid.', 400);
      const opened = await openMcpSession(env, session);
      await requireImageSession(opened.session);
      // A read-only quote rejection is never silently treated as free. An
      // unknown-price upload needs its own explicit, mutually exclusive consent.
      const quoted = await imageUploadQuote(opened.session.accessToken, photoUrl, opened.headers);
      if (unknownConsent) {
        if (quoted.credits !== null || quoted.unknown_cost_allowed !== true) throw fail('Kondisi quote berubah atau akses gagal. Periksa biaya lagi; upload tidak dikirim.', 409);
      } else {
        if (quoted.credits === null) throw fail('Quote upload_image tidak tersedia. Upload tidak dikirim; periksa diagnosis dan persetujuan biaya terpisah.', 409);
        if (quoted.credits > expected) throw fail(`Biaya upload ${quoted.credits} kredit melebihi batas ${expected} yang Anda setujui; upload tidak dikirim.`, 409);
      }
      return response({ ok: true, quote_credits: quoted.credits, accept_unknown_cost: unknownConsent, ...(await imageUploadHost(opened.session.accessToken, photoUrl, opened.headers)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (action === 'image-quote-probe' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      return response({ ok: true, ...(await imageQuoteProbe(session.accessToken, env, request)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (action === 'remaining-quote-probe' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
      return response({ ok: true, ...(await remainingQuoteProbe(session.accessToken, request)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (['balance', 'image-schemas', 'image-models', 'image-edit-models', 'image-quote', 'video-schemas', 'video-models'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'balance') {
        const opened = await openMcpSession(env, session);
        return response({ ok: true, balance: await getBalance(opened.session.accessToken, opened.headers) });
      }
      if (action === 'image-schemas') return response({ ok: true, ...(await getToolSchemas(session.accessToken, IMAGE_TOOLS)) });
      if (action === 'video-schemas') return response({ ok: true, ...(await getToolSchemas(session.accessToken, VIDEO_TOOLS)) });
      // Tipe katalog disertakan di respons: daftar image dan image_edit ternyata
      // bisa identik, jadi tanpa label hasilnya ambigu saat ditempel keluar.
      if (action === 'image-models') return response({ ok: true, catalog: 'image', ...(await getModels(session.accessToken, 'image')) });
      if (action === 'image-edit-models') return response({ ok: true, catalog: 'image_edit', ...(await getModels(session.accessToken, 'image_edit')) });
      if (action === 'video-models') return response({ ok: true, catalog: 'video', ...(await getModels(session.accessToken, 'video')) });
      return response({ ok: true, quote: await quoteImage(session.accessToken, await parseImageQuote(request)) });
    }
    if (['music-models', 'effects-list', 'text-models'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
      let bodyInput;
      const contentType = request.headers.get('content-type') || '';
      const contentLength = request.headers.get('content-length');
      if (contentType || (contentLength && contentLength !== '0')) {
        bodyInput = await imageJson(request);
      }
      if (action === 'effects-list') {
        return response({ ok: true, ...(await getEffectsCatalog(session.accessToken, bodyInput)) }, 200, { 'referrer-policy': 'no-referrer' });
      }
      if (bodyInput !== undefined && (!bodyInput || typeof bodyInput !== 'object' || Array.isArray(bodyInput) || Object.keys(bodyInput).length > 0)) {
        throw fail('Permintaan tidak valid.', 400);
      }
      if (action === 'music-models') {
        return response({ ok: true, ...(await getMusicModels(session.accessToken)) }, 200, { 'referrer-policy': 'no-referrer' });
      }
      return response({ ok: true, ...(await getTextModels(session.accessToken)) }, 200, { 'referrer-policy': 'no-referrer' });
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
      if (action === 'video-model-help') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'model_id') || !Number.isSafeInteger(input.model_id) || input.model_id < 0) throw fail('Masukkan ID model video yang valid.', 400);
        const settings = videoSettings(input.model_id);
        const opened = await openMcpSession(env, session);
        return response({ ok: true, model_id: settings.model_id, help: await videoDiagnostic(opened.session.accessToken, 'video-help', null, false, settings, opened.headers) });
      }
      const parsed = parseVideoModelRequest(input);
      const settings = {
        ...FREEBEAT_VIDEO_TEST,
        model_id: parsed.model_id,
        generation_type: parsed.generation_type,
        ...(parsed.duration !== undefined ? { duration: parsed.duration } : {}),
        ...(parsed.resolution ? { resolution: parsed.resolution } : {}),
        ...(parsed.aspect_ratio ? { aspect_ratio: parsed.aspect_ratio } : {}),
      };
      const opened = await openMcpSession(env, session);
      const help = await videoDiagnostic(opened.session.accessToken, 'video-help', null, true, settings, opened.headers);
      assertModelUsable(help, parsed.model_id, env);
      const normalized = normalizeVideoSettings(help, settings, parsed.generation_type);
      return response({
        ok: true,
        settings: normalized.settings,
        adjusted: normalized.adjusted,
        supported: normalized.options,
        member_only: help?.model?.member_only === true,
        quote: await videoDiagnostic(opened.session.accessToken, 'video-quote', parsed, false, normalized.settings, opened.headers),
      });
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
    if (['dance-schemas', 'dance-upload-audio', 'dance-quote', 'dance-prepare', 'dance-submit', 'dance-tests', 'dance-task', 'dance-session', 'dance-message'].includes(action)) {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'dance-tests' && request.method === 'GET') return response({ ok: true, tests: await danceTests(env, user, session) });
      if (action === 'dance-schemas' && request.method === 'POST') return response({ ok: true, ...(await getToolSchemas(session.accessToken, DANCE_TOOLS, SAFE_DANCE_SCHEMA_ENUMS)) });
      if (action === 'dance-upload-audio' && request.method === 'POST') return response({ ok: true, ...(await danceUploadAudio(session.accessToken, await imageJson(request))) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'dance-quote' && request.method === 'POST') {
        const params = validateDanceInput(await imageJson(request));
        const rawQuote = await danceQuote(session.accessToken, params, true);
        const credits = quotedCredits(rawQuote);
        return response({
          ok: true,
          parameters: params,
          credits,
          cost_mode: credits !== null ? 'max_credits' : 'accept_unknown_cost',
          quote: safeQuote(rawQuote),
        });
      }
      if (action === 'dance-prepare' && request.method === 'POST') return response({ ok: true, ...(await prepareDance(env, user, session, await imageJson(request))) });
      if (action === 'dance-submit' && request.method === 'POST') return response({ ok: true, ...(await submitDance(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'dance-task' && request.method === 'POST') return response({ ok: true, task: await pollDance(env, user, session, request) });
      if (action === 'dance-session' && request.method === 'POST') return response({ ok: true, session: await danceSession(env, user, session, request) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'dance-message' && request.method === 'POST') return response({ ok: true, ...(await danceMessage(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (['vocal-video-schemas', 'remaining-schemas'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
      let acknowledge = false;
      const contentType = request.headers.get('content-type') || '';
      const contentLength = request.headers.get('content-length');
      if (contentType || (contentLength && contentLength !== '0')) {
        const input = await imageJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'acknowledge')) {
          throw fail('Permintaan tidak valid.', 400);
        }
        if (input.acknowledge !== undefined && typeof input.acknowledge !== 'boolean') {
          throw fail('Parameter acknowledge harus boolean.', 400);
        }
        acknowledge = input.acknowledge === true;
      }
      const result = action === 'remaining-schemas'
        ? await getRemainingToolSchemas(session.accessToken, { acknowledge })
        : await getVocalVideoSchemas(session.accessToken, { acknowledge });
      return response({ ok: true, ...result }, 200, acknowledge ? { 'referrer-policy': 'no-referrer' } : {});
    }
    if (['vocal-upload-audio', 'vocal-upload-video', 'vocal-quote', 'vocal-prepare', 'vocal-submit', 'vocal-tests', 'vocal-task', 'vocal-session', 'vocal-message'].includes(action)) {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'vocal-tests' && request.method === 'GET') return response({ ok: true, tests: await vocalTests(env, user, session) });
      if (action === 'vocal-upload-audio' && request.method === 'POST') return response({ ok: true, ...(await danceUploadAudio(session.accessToken, await imageJson(request))) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'vocal-upload-video' && request.method === 'POST') return response({ ok: true, ...(await vocalUploadVideo(session.accessToken, await imageJson(request))) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'vocal-quote' && request.method === 'POST') {
        const opened = await openMcpSession(env, session);
        const quoteSession = opened.session;
        const headers = opened.headers;
        const schemaMeta = await discoverVocalToolSchemaMeta(quoteSession.accessToken, headers);
        const { tool, parameters } = validateVocalRequest(await imageJson(request), schemaMeta);
        const rawQuote = await vocalQuote(quoteSession.accessToken, tool, parameters, true, headers);
        const credits = quotedCredits(rawQuote);
        return response({
          ok: true,
          tool,
          parameters,
          schema_meta: schemaMeta,
          credits,
          cost_mode: credits !== null ? 'max_credits' : 'accept_unknown_cost',
          quote: safeQuote(rawQuote),
        });
      }
      if (action === 'vocal-prepare' && request.method === 'POST') return response({ ok: true, ...(await prepareVocal(env, user, session, await imageJson(request))) });
      if (action === 'vocal-submit' && request.method === 'POST') return response({ ok: true, ...(await submitVocal(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'vocal-task' && request.method === 'POST') return response({ ok: true, task: await pollVocal(env, user, session, request) });
      if (action === 'vocal-session' && request.method === 'POST') return response({ ok: true, session: await vocalSession(env, user, session, request) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'vocal-message' && request.method === 'POST') return response({ ok: true, ...(await vocalMessage(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    if (['music-quote', 'music-prepare', 'music-submit', 'music-tests', 'music-task'].includes(action)) {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'music-tests' && request.method === 'GET') return response({ ok: true, tests: await musicTests(env, user, session) });
      if (action === 'music-quote' && request.method === 'POST') {
        const input = await imageJson(request, MUSIC_BODY_MAX_BYTES);
        const headers = await openMcp(session.accessToken);
        const catalogModels = await fetchRawMusicModels(session.accessToken, headers);
        const { model, parameters } = validateMusicRequest(input, catalogModels);
        const rawQuote = await musicQuote(session.accessToken, parameters, true, headers);
        const credits = quotedCredits(rawQuote);
        return response({
          ok: true,
          model,
          parameters,
          credits,
          quote: safeQuote(rawQuote),
        });
      }
      if (action === 'music-prepare' && request.method === 'POST') return response({ ok: true, ...(await prepareMusic(env, user, session, await imageJson(request, MUSIC_BODY_MAX_BYTES))) });
      if (action === 'music-submit' && request.method === 'POST') return response({ ok: true, ...(await submitMusic(env, user, session, request)) }, 200, { 'referrer-policy': 'no-referrer' });
      if (action === 'music-task' && request.method === 'POST') return response({ ok: true, task: await pollMusic(env, user, session, request) }, 200, { 'referrer-policy': 'no-referrer' });
    }
    // These two explicit experiments can inspect models absent from truncated
    // catalogs; all generic/catalog and consumer generation guards stay intact.
    if (['hailuo-prepare', 'ltx-prepare'].includes(action) && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      const input = await parseVideoPrepare(request);
      const diagnostic = action === 'hailuo-prepare' ? 'hailuo' : 'ltx';
      assertSingleImageDiagnostic(input, diagnostic);
      return response({ ok: true, ...(await prepareVideo(env, user, session, input, diagnostic)) }, 200, { 'referrer-policy': 'no-referrer' });
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
    if (['image-prepare', 'image-submit', 'image-tests', 'image-task', 'image-task-inspect'].includes(action)) {
      const session = await readSession(request, env, user.id);
      if (!session) return response({ error: 'Koneksi Freebeat tidak tersedia atau kedaluwarsa. Hubungkan kembali.' }, 401);
      if (action === 'image-tests' && request.method === 'GET') return response({ ok: true, tests: await imageTests(env, user, session) });
      if (action === 'image-prepare' && request.method === 'POST') return response({ ok: true, ...(await prepareImage(env, user, session, await parseImageQuote(request))) });
      if (action === 'image-submit' && request.method === 'POST') return response({ ok: true, ...(await submitImage(env, user, session, request)) });
      if (action === 'image-task' && request.method === 'POST') return response({ ok: true, task: await pollImage(env, user, session, request) });
      if (action === 'image-task-inspect' && request.method === 'POST') {
        const input = await imageJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['job_id', 'acknowledge'].includes(key)) || typeof input.job_id !== 'string' || !TASK_ID.test(input.job_id.trim())) throw fail('Masukkan ID job yang valid.', 400);
        const raw = input.acknowledge === true;
        return response({ ok: true, ...(await imageTaskInspect(session.accessToken, input.job_id.trim(), raw)) }, 200, { 'referrer-policy': 'no-referrer' });
      }
    }
    if (action === 'disconnect' && request.method === 'POST') {
      const session = await readSession(request, env, user.id);
      let revoked = false;
      if (session) {
        try { const res = await fetch(REVOKE, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UPSTREAM_MEDIA_USER_AGENT }, body: new URLSearchParams({ token: session.accessToken, client_id: session.clientId }).toString() }); revoked = res.ok; } catch { /* local session is still removed */ }
      }
      // Hapus salinan sisi server agar generate gambar konsumen ikut berhenti.
      await clearProviderSession(env, user.id);
      if (session?.accountId) {
        try { await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(session.accountId)}`, { method: 'DELETE' }); } catch { /* ignore in legacy mocks */ }
      }
      return response({ ok: true, revoked }, 200, { 'set-cookie': cookie(SESSION, '', 0) });
    }
    return response({ error: 'Aksi Freebeat tidak dikenal.' }, 404);
  } catch (error) { return response({ error: error?.message || 'Koneksi Freebeat gagal.', ...(error?.videoDispatch === 'not_sent' ? { video_dispatch: 'not_sent' } : {}) }, error?.status || 502); }
}

export async function handleFreebeat(request, url, env, user) {
  const res = await dispatchFreebeat(request, url, env, user);
  // Persist silently renewed sessions so one connection keeps working.
  const setCookie = sessionCookies.get(request);
  if (setCookie) res.headers.append('Set-Cookie', setCookie);
  return res;
}

// ===================== Generasi gambar konsumen =====================
// Semua user dapat membuat gambar lewat provider Freebeat HANYA dengan
// text-to-image (model 122 = "Nano Banana 2 Lite", terbukti sukses via MCP).
// Mode edit foto (model 202) DIHAPUS: selalu gagal di provider dan kredit
// pengguna sempat terpotong sebelum di-refund. Biayanya dipotong dari kredit
// BLEA (credit_model_prices), sedangkan kredit Freebeat keluar dari saldo akun
// admin yang menghubungkan provider. Sesi admin disimpan tersegel di
// freebeat_oauth_accounts / freebeat_provider_sessions agar dapat dipakai
// request user lain secara round-robin.
const CONSUMER_IMAGE_MODEL_DEFAULT = 122;
// Default ID model untuk probe quote admin (diagnostik edit_image di halaman
// admin, BUKAN bagian dari generasi pengguna).
const QUOTE_PROBE_EDIT_MODEL_DEFAULT = 202;
// Daftar rasio yang diketahui dapat dihargai provider untuk tool edit_image;
// dipakai probe quote admin (get_model_help), bukan oleh pengguna.
const EDIT_ASPECT_RATIOS = ['9:16', '16:9', '1:1', '3:4', '4:3', '2:3', '3:2'];
function consumerImageUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096) return null;
  let url;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
  if (!url.hostname.includes('.') || url.hostname.endsWith('.local') || /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) return null;
  return url.toString();
}
// quote_generation untuk tool apa pun (generate_image / edit_image). Enum tool
// di skema resmi ditandai enum_incomplete, jadi edit_image dicoba langsung.
async function rawToolQuote(accessToken, tool, parameters, existingHeaders = null, captureToolError = false) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote_generation', arguments: { tool, parameters } } }, 'quote', headers, 262144, captureToolError);
  if (captureToolError && (result?.isError || result?.error)) {
    if (isFreebeatBalanceExhausted(result)) return { status: 'insufficient_credits' };
    throw mcpFailure('quote', 'rpc');
  }
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('quote', 'response');
  return content;
}
// Probe quote GRATIS: quote_generation tidak memotong kredit, jadi beberapa
// bentuk parameter dicoba sekaligus untuk menemukan kontrak model edit (202
// menolak quote dasar dengan status "unavailable").
const QUOTE_PROBE_PROMPT_DEFAULT = 'Ubah latar belakang foto menjadi biru polos.';
async function imageQuoteProbe(accessToken, env, request) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !['model_id', 'image_url', 'prompt'].includes(key))) throw fail('Permintaan probe tidak valid.', 400);
  const modelId = Number.isSafeInteger(input.model_id) && input.model_id > 0 && input.model_id < 1000000 ? input.model_id : QUOTE_PROBE_EDIT_MODEL_DEFAULT;
  const control = consumerImageModel(env);
  const prompt = typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim().slice(0, 500) : QUOTE_PROBE_PROMPT_DEFAULT;
  const imageUrl = consumerImageUrl(typeof input.image_url === 'string' ? input.image_url : '');
  const variants = [
    { label: `kontrol generate_image ${control} (teks saja)`, tool: 'generate_image', parameters: { model_id: control, prompt } },
  ];
  if (imageUrl) {
    // Bentuk parameter sudah diketahui; probe kini memetakan harga tiap
    // kombinasi rasio x resolusi supaya admin dapat menetapkan harga jual.
    for (const ratio of EDIT_ASPECT_RATIOS.slice(0, 5)) {
      variants.push({ label: `edit_image ${modelId} rasio ${ratio} resolusi 1K`, tool: 'edit_image', parameters: { model_id: modelId, image: imageUrl, prompt, aspect_ratio: ratio, resolution: '1K' } });
    }
    for (const ratio of ['9:16', '1:1']) {
      variants.push({ label: `edit_image ${modelId} rasio ${ratio} resolusi 2K`, tool: 'edit_image', parameters: { model_id: modelId, image: imageUrl, prompt, aspect_ratio: ratio, resolution: '2K' } });
    }
    // Kombinasi yang belum teruji: generation_type (8 = nilai dari help katalog
    // image_edit dan dari payload web) BERSAMA aspect_ratio + resolution.
    for (const generationType of [8, 6]) {
      variants.push({ label: `edit_image ${modelId} generation_type ${generationType} + rasio 9:16 1K`, tool: 'edit_image', parameters: { model_id: modelId, image: imageUrl, prompt, aspect_ratio: '9:16', resolution: '1K', generation_type: generationType } });
    }
  }
  const headers = await openMcp(accessToken);
  const results = [];
  for (const variant of variants) {
    const keys = Object.keys(variant.parameters);
    try {
      const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote_generation', arguments: { tool: variant.tool, parameters: variant.parameters, ...(variant.accept_unknown_cost ? { accept_unknown_cost: true } : {}) } } }, 'quote', headers, 262144);
      const content = modelContent(result);
      if (!content || typeof content !== 'object' || Array.isArray(content)) { results.push({ label: variant.label, tool: variant.tool, keys, usable: false, error: 'respons quote tidak dikenali' }); continue; }
      const credits = quotedCredits(content);
      results.push({ label: variant.label, tool: variant.tool, keys, usable: credits !== null, credits, status: typeof content.status === 'string' ? content.status : null, quote: safeQuote(content) });
    } catch (err) {
      results.push({ label: variant.label, tool: variant.tool, keys, usable: false, error: typeof err?.message === 'string' ? err.message.slice(0, 200) : 'permintaan gagal' });
    }
  }
  return { model_id: modelId, control_model_id: control, image_used: Boolean(imageUrl), results, usable: results.filter((item) => item.usable).map((item) => ({ label: item.label, credits: item.credits })) };
}

const REMAINING_QUOTE_GROUPS = new Set(['all', 'music', 'music_video', 'lyric_video', 'effect', 'text']);
const REMAINING_PROBE_LYRICS_SAMPLE = '[Verse]\nSoft neon rain across the glass\n[Chorus]\nStay until the midnight passes';
const REMAINING_PROBE_EFFECT_IMAGE_DEFAULT = 'https://static.freebeatfit.com/effects_display/baby_arrived/1/459.png';
async function remainingQuoteProbe(accessToken, request) {
  let rawBody = {};
  const contentType = request.headers.get('content-type') || '';
  const contentLength = request.headers.get('content-length');
  if (contentType || (contentLength && contentLength !== '0')) {
    rawBody = await imageJson(request);
  }
  const allowedKeys = new Set(['group', 'music_model_id', 'music_id', 'effect_id', 'effect_image_url', 'text_model', 'prompt', 'private_diagnostics']);
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody) || Object.keys(rawBody).some((k) => !allowedKeys.has(k))) {
    throw fail('Parameter probe quote tidak valid.', 400);
  }
  if (rawBody.private_diagnostics !== undefined && typeof rawBody.private_diagnostics !== 'boolean') {
    throw fail('private_diagnostics harus berupa boolean.', 400);
  }
  const privateDiagnostics = rawBody.private_diagnostics === true;
  const group = typeof rawBody.group === 'string' ? rawBody.group.trim() : 'all';
  if (!REMAINING_QUOTE_GROUPS.has(group)) {
    throw fail('Grup probe quote tidak didukung.', 400);
  }
  let musicModelId = 129;
  if (rawBody.music_model_id !== undefined && rawBody.music_model_id !== null && rawBody.music_model_id !== '') {
    if (!Number.isSafeInteger(rawBody.music_model_id) || rawBody.music_model_id < 1 || rawBody.music_model_id > 999999999) {
      throw fail('music_model_id harus bilangan bulat positif.', 400);
    }
    musicModelId = rawBody.music_model_id;
  }
  let musicId = 1076592;
  if (rawBody.music_id !== undefined && rawBody.music_id !== null && rawBody.music_id !== '') {
    if (!Number.isSafeInteger(rawBody.music_id) || rawBody.music_id < 1 || rawBody.music_id > 9999999999) {
      throw fail('music_id harus bilangan bulat positif.', 400);
    }
    musicId = rawBody.music_id;
  }
  let effectId = 459;
  if (rawBody.effect_id !== undefined && rawBody.effect_id !== null && rawBody.effect_id !== '') {
    if (!Number.isSafeInteger(rawBody.effect_id) || rawBody.effect_id < 1 || rawBody.effect_id > 9999999999) {
      throw fail('effect_id harus bilangan bulat positif.', 400);
    }
    effectId = rawBody.effect_id;
  }
  let effectImageUrl = REMAINING_PROBE_EFFECT_IMAGE_DEFAULT;
  if (rawBody.effect_image_url !== undefined && rawBody.effect_image_url !== null && String(rawBody.effect_image_url).trim() !== '') {
    const safeUrl = consumerImageUrl(typeof rawBody.effect_image_url === 'string' ? rawBody.effect_image_url : '');
    if (!safeUrl) throw fail('effect_image_url harus berupa URL HTTPS publik yang valid.', 400);
    effectImageUrl = safeUrl;
  }
  let textModel = 'gemini-3.5-flash';
  if (rawBody.text_model !== undefined && rawBody.text_model !== null && String(rawBody.text_model).trim() !== '') {
    if (typeof rawBody.text_model !== 'string' || !safeTextModelId(rawBody.text_model.trim())) {
      throw fail('text_model tidak valid.', 400);
    }
    textModel = rawBody.text_model.trim();
  }
  let prompt = 'Upbeat synthwave sunset anthem with clean beat';
  if (rawBody.prompt !== undefined && rawBody.prompt !== null && String(rawBody.prompt).trim() !== '') {
    if (typeof rawBody.prompt !== 'string' || rawBody.prompt.trim().length > 500) {
      throw fail('prompt maksimal 500 karakter.', 400);
    }
    prompt = rawBody.prompt.trim();
  }

  const variants = [];
  if (group === 'all' || group === 'music') {
    variants.push(
      { group: 'music', label: `generate_music #${musicModelId} (prompt saja)`, tool: 'generate_music', parameters: { model_id: musicModelId, prompt } },
      { group: 'music', label: 'generate_music #194 Suno v6 (dengan lyrics)', tool: 'generate_music', parameters: { model_id: 194, prompt, lyrics: REMAINING_PROBE_LYRICS_SAMPLE, instrumental: false } },
    );
    if (group === 'music') {
      variants.push(
        { group: 'music', label: `generate_music #${musicModelId} (instrumental: true)`, tool: 'generate_music', parameters: { model_id: musicModelId, prompt, instrumental: true } },
        { group: 'music', label: `generate_music #${musicModelId} (dengan lyrics)`, tool: 'generate_music', parameters: { model_id: musicModelId, prompt, lyrics: REMAINING_PROBE_LYRICS_SAMPLE, instrumental: false } },
        { group: 'music', label: 'generate_music #194 Suno v6 (prompt saja)', tool: 'generate_music', parameters: { model_id: 194, prompt } },
        { group: 'music', label: 'generate_music #194 Suno v6 (instrumental: true)', tool: 'generate_music', parameters: { model_id: 194, prompt, instrumental: true } },
        { group: 'music', label: 'generate_music #130 MiniMax Music 3 (dengan lyrics)', tool: 'generate_music', parameters: { model_id: 130, prompt, lyrics: REMAINING_PROBE_LYRICS_SAMPLE, instrumental: false } },
        { group: 'music', label: 'generate_music #185 Mureka V9.5 (dengan lyrics)', tool: 'generate_music', parameters: { model_id: 185, prompt, lyrics: REMAINING_PROBE_LYRICS_SAMPLE, instrumental: false } },
      );
    }
  }
  if (group === 'all' || group === 'music_video') {
    variants.push(
      { group: 'music_video', label: `generate_music_video auto 720p 16:9 15s (music_id ${musicId})`, tool: 'generate_music_video', parameters: { auto_mode: true, music_id: musicId, prompt, start_ms: 0, end_ms: 15000, aspect_ratio: '16:9', resolution: '720p', remove_watermark: false } },
      { group: 'music_video', label: `generate_music_video auto 1080p 9:16 15s (music_id ${musicId})`, tool: 'generate_music_video', parameters: { auto_mode: true, music_id: musicId, prompt, start_ms: 0, end_ms: 15000, aspect_ratio: '9:16', resolution: '1080p', remove_watermark: false } },
    );
    if (group === 'music_video') {
      variants.push(
        { group: 'music_video', label: `generate_music_video auto 720p 16:9 30s (music_id ${musicId})`, tool: 'generate_music_video', parameters: { auto_mode: true, music_id: musicId, prompt, start_ms: 0, end_ms: 30000, aspect_ratio: '16:9', resolution: '720p', remove_watermark: false } },
        { group: 'music_video', label: `generate_music_video agent auto_mode=false 720p 15s (music_id ${musicId})`, tool: 'generate_music_video', parameters: { auto_mode: false, music_id: musicId, prompt, start_ms: 0, end_ms: 15000, aspect_ratio: '16:9', resolution: '720p', remove_watermark: false } },
      );
    }
  }
  if (group === 'all' || group === 'lyric_video') {
    variants.push(
      { group: 'lyric_video', label: `generate_lyric_video auto 768P 16:9 15s (music_id ${musicId})`, tool: 'generate_lyric_video', parameters: { auto_mode: true, music_id: musicId, prompt, start_ms: 0, end_ms: 15000, aspect_ratio: '16:9', resolution: '768P', remove_watermark: false } },
      { group: 'lyric_video', label: `generate_lyric_video auto 2K 9:16 15s (music_id ${musicId})`, tool: 'generate_lyric_video', parameters: { auto_mode: true, music_id: musicId, prompt, start_ms: 0, end_ms: 15000, aspect_ratio: '9:16', resolution: '2K', remove_watermark: false } },
    );
    if (group === 'lyric_video') {
      variants.push(
        { group: 'lyric_video', label: `generate_lyric_video auto 768P 16:9 30s (music_id ${musicId})`, tool: 'generate_lyric_video', parameters: { auto_mode: true, music_id: musicId, prompt, start_ms: 0, end_ms: 30000, aspect_ratio: '16:9', resolution: '768P', remove_watermark: false } },
        { group: 'lyric_video', label: `generate_lyric_video agent auto_mode=false 768P 15s (music_id ${musicId})`, tool: 'generate_lyric_video', parameters: { auto_mode: false, music_id: musicId, prompt, start_ms: 0, end_ms: 15000, aspect_ratio: '16:9', resolution: '768P', remove_watermark: false } },
      );
    }
  }
  if (group === 'all' || group === 'effect') {
    variants.push(
      { group: 'effect', label: `generate_effect #${effectId} watermark=false (music_id ${musicId})`, tool: 'generate_effect', parameters: { effect_id: effectId, music_id: musicId, prompt, reference_image_urls: [effectImageUrl], watermark: false } },
      { group: 'effect', label: `generate_effect #${effectId} watermark=true (music_id ${musicId})`, tool: 'generate_effect', parameters: { effect_id: effectId, music_id: musicId, prompt, reference_image_urls: [effectImageUrl], watermark: true } },
    );
  }
  if (group === 'all' || group === 'text') {
    const secondaryTextModel = textModel === 'claude-sonnet-5' ? 'gpt-6-astra' : 'claude-sonnet-5';
    variants.push(
      { group: 'text', label: `generate_text ${textModel} (max_tokens 128)`, tool: 'generate_text', parameters: { model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 128, temperature: 0.7 } },
      { group: 'text', label: `generate_text ${secondaryTextModel} (max_tokens 128)`, tool: 'generate_text', parameters: { model: secondaryTextModel, messages: [{ role: 'user', content: prompt }], max_tokens: 128, temperature: 0.7 } },
    );
    if (group === 'text') {
      variants.push(
        { group: 'text', label: `generate_text ${textModel} (max_tokens 2048)`, tool: 'generate_text', parameters: { model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 2048, temperature: 0.7 } },
      );
    }
  }

  const headers = await openMcp(accessToken);
  const results = [];
  const privateDetails = [];
  let rpcId = 2;
  for (const variant of variants) {
    const keys = Object.keys(variant.parameters);
    try {
      const { result } = await rpc(accessToken, {
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'tools/call',
        params: { name: 'quote_generation', arguments: { tool: variant.tool, parameters: variant.parameters } },
      }, 'quote', headers, 262144, true);

      if (result?.isError || result?.error) {
        const msgs = initialVideoMessages(result).slice(0, 5);
        const errMsg = msgs.length ? msgs.join(' | ') : 'MCP mengembalikan isError';
        results.push({
          group: variant.group,
          label: variant.label,
          tool: variant.tool,
          keys,
          usable: false,
          credits: null,
          status: 'rpc_error',
          error: errMsg,
        });
        if (privateDiagnostics) {
          privateDetails.push({
            group: variant.group,
            label: variant.label,
            tool: variant.tool,
            status: 'rpc_error',
            error: errMsg,
            messages: msgs,
          });
        }
        continue;
      }
      const content = modelContent(result);
      if (!content || typeof content !== 'object' || Array.isArray(content)) {
        const msgs = initialVideoMessages(result).slice(0, 3);
        const errMsg = msgs.length ? msgs.join(' | ') : 'respons quote tidak dikenali';
        results.push({
          group: variant.group,
          label: variant.label,
          tool: variant.tool,
          keys,
          usable: false,
          credits: null,
          status: null,
          error: errMsg,
        });
        if (privateDiagnostics) {
          privateDetails.push({
            group: variant.group,
            label: variant.label,
            tool: variant.tool,
            status: null,
            error: errMsg,
            messages: msgs,
          });
        }
        continue;
      }
      const credits = quotedCredits(content);
      const statusStr = typeof content.status === 'string' ? content.status : null;
      results.push({
        group: variant.group,
        label: variant.label,
        tool: variant.tool,
        keys,
        usable: credits !== null,
        credits,
        status: statusStr,
        quote: safeQuote(content),
      });
      if (privateDiagnostics) {
        const { help } = privateModelHelp(content);
        privateDetails.push({
          group: variant.group,
          label: variant.label,
          tool: variant.tool,
          status: statusStr,
          credits,
          source: typeof content.source === 'string' ? (privateFailureReason(content.source)?.slice(0, 500) ?? null) : null,
          message: typeof content.message === 'string' ? (privateFailureReason(content.message)?.slice(0, 500) ?? null) : null,
          reason: typeof content.reason === 'string' ? (privateFailureReason(content.reason)?.slice(0, 500) ?? null) : null,
          detail: typeof content.detail === 'string' ? (privateFailureReason(content.detail)?.slice(0, 500) ?? null) : null,
          fields: help,
        });
      }
    } catch (err) {
      const errMsg = privateFailureReason(err?.message)?.slice(0, 200) || 'permintaan gagal';
      results.push({
        group: variant.group,
        label: variant.label,
        tool: variant.tool,
        keys,
        usable: false,
        credits: null,
        status: null,
        error: errMsg,
      });
      if (privateDiagnostics) {
        privateDetails.push({
          group: variant.group,
          label: variant.label,
          tool: variant.tool,
          status: null,
          error: errMsg,
        });
      }
    }
  }

  return {
    group,
    total_probed: results.length,
    usable: results.filter((item) => item.usable).map((item) => ({
      group: item.group,
      label: item.label,
      tool: item.tool,
      credits: item.credits,
    })),
    results,
    ...(privateDiagnostics ? { private_diagnostics: privateDetails } : {}),
  };
}
function consumerImageModel(env) {
  const raw = String(env?.FREEBEAT_IMAGE_MODEL ?? CONSUMER_IMAGE_MODEL_DEFAULT).trim();
  return /^\d{1,6}$/.test(raw) ? Number(raw) : CONSUMER_IMAGE_MODEL_DEFAULT;
}
// Plafon kredit Freebeat per gambar: melindungi saldo admin dari harga tak terduga.
function consumerProviderCeiling(env) {
  const value = Number(env?.FREEBEAT_IMAGE_MAX_PROVIDER_CREDITS);
  return Number.isFinite(value) && value >= 1 && value <= 100000 ? Math.floor(value) : 50;
}
// Rasio minimum harga BLEA terhadap biaya provider. 1.0 = impas (tanpa margin);
// 1.4 = margin 40%. Mencegah admin menjual rugi karena salah isi tabel harga.
function consumerMinMargin(env) {
  const value = Number(env?.FREEBEAT_IMAGE_MIN_MARGIN);
  return Number.isFinite(value) && value >= 1 && value <= 20 ? value : 1;
}
function supabaseBase(env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_ROLE_KEY) throw fail('Penyimpanan BLEA belum dikonfigurasi; generasi gambar tidak diaktifkan.', 503);
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw fail('Konfigurasi penyimpanan BLEA tidak valid.', 503);
  return base.toString().replace(/\/$/, '');
}
async function dbFetch(env, path, options = {}) {
  let res;
  try {
    res = await fetch(`${supabaseBase(env)}/rest/v1${path}`, {
      method: options.method || 'GET', redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, 'content-type': 'application/json', ...(options.prefer ? { prefer: options.prefer } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch { throw fail('Penyimpanan BLEA tidak dapat dihubungi.', 503); }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* ignore */ }
    throw fail('Penyimpanan BLEA menolak permintaan.', 503);
  }
  return res;
}
async function dbJson(env, path, options = {}) {
  const res = await dbFetch(env, path, options);
  return await res.json().catch(() => null);
}
async function dbRpc(env, fn, body) {
  const res = await dbFetch(env, `/rpc/${fn}`, { method: 'POST', body });
  return (await res.json().catch(() => null)) === true;
}
export async function persistProviderSession(env, userId, sealedSession, imageAccess) {
  try {
    await dbFetch(env, '/freebeat_provider_sessions', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { user_id: userId, sealed_session: sealedSession, image_access: imageAccess === true, updated_at: new Date().toISOString() } });
  } catch { /* cookie admin tetap sumber kebenaran; kegagalan simpan tidak memutus sesi */ }
}
export async function clearProviderSession(env, userId) {
  try { await dbFetch(env, `/freebeat_provider_sessions?user_id=eq.${encodeURIComponent(userId)}`, { method: 'DELETE' }); } catch { /* tidak ada yang perlu dipulihkan */ }
}

function sanitizePoolAccountRow(row, env, unsealed = null) {
  const issuedMs = row?.issued_at ? Date.parse(row.issued_at) : (Number.isFinite(unsealed?.issuedAt) ? unsealed.issuedAt : null);
  const maxMs = sessionMaxAgeMs(env);
  const accessExpiredNoRenew = !unsealed?.refreshToken && Number.isFinite(unsealed?.expiresAt) && unsealed.expiresAt <= Date.now();
  const sessionExpired = Number.isFinite(issuedMs) && (Date.now() - issuedMs > maxMs);
  const cleanEmail = String(row.account_email || unsealed?.accountEmail || '').trim();
  const rawSource = row.email_source || unsealed?.emailSource || (cleanEmail ? 'manual' : 'unverified');
  return {
    id: row.id,
    account_email: cleanEmail,
    account_label: String(row.account_label || '').trim(),
    email_source: rawSource,
    connected_by: row.connected_by || null,
    image_access: row.image_access === true,
    enabled: row.enabled !== false,
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : 100,
    last_balance_credits: row.last_balance_credits !== null && row.last_balance_credits !== undefined && Number.isFinite(Number(row.last_balance_credits)) ? Number(row.last_balance_credits) : null,
    last_balance: row.last_balance || null,
    last_balance_checked_at: row.last_balance_checked_at || null,
    consecutive_failures: Number.isFinite(Number(row.consecutive_failures)) ? Number(row.consecutive_failures) : 0,
    last_error: typeof row.last_error === 'string' ? row.last_error : null,
    last_used_at: row.last_used_at || null,
    last_success_at: row.last_success_at || null,
    issued_at: row.issued_at || null,
    expires_at: Number.isFinite(unsealed?.expiresAt) ? new Date(unsealed.expiresAt).toISOString() : null,
    session_expires_at: Number.isFinite(issuedMs) ? new Date(issuedMs + maxMs).toISOString() : null,
    auto_renew: Boolean(unsealed?.refreshToken),
    expired: Boolean(accessExpiredNoRenew || sessionExpired),
    updated_at: row.updated_at || null,
    created_at: row.created_at || null,
  };
}

async function listPoolAccountsAdmin(env) {
  const rows = await dbJson(env, '/freebeat_oauth_accounts?select=*&order=priority.asc,created_at.asc&limit=50');
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    const unsealed = row?.sealed_session ? await unseal(row.sealed_session, env, 'session', 3800) : null;
    out.push(sanitizePoolAccountRow(row, env, unsealed));
  }
  return out;
}

async function upsertPoolOAuthAccount(env, { id = null, accountEmail = '', accountLabel = '', oauthSubject = '', emailSource = 'manual', connectedBy = null, sealedSession, imageAccess = false, issuedAt = null }) {
  try {
    const nowIso = new Date().toISOString();
    let targetId = id && TEST_ID.test(id) ? id : null;
    if (!targetId && accountEmail) {
      const matched = await dbJson(env, `/freebeat_oauth_accounts?select=id&account_email=ilike.${encodeURIComponent(accountEmail.trim())}&limit=1`).catch(() => []);
      if (Array.isArray(matched) && matched[0]?.id) targetId = matched[0].id;
    }
    if (!targetId && oauthSubject) {
      const matchedSub = await dbJson(env, `/freebeat_oauth_accounts?select=id&oauth_subject=eq.${encodeURIComponent(oauthSubject)}&limit=1`).catch(() => []);
      if (Array.isArray(matchedSub) && matchedSub[0]?.id) targetId = matchedSub[0].id;
    }
    if (targetId) {
      const prevRows = await dbJson(env, `/freebeat_oauth_accounts?select=id,account_email,oauth_subject,email_source&id=eq.${encodeURIComponent(targetId)}&limit=1`).catch(() => []);
      const prev = Array.isArray(prevRows) ? prevRows[0] : null;
      const subjectChanged = Boolean(oauthSubject && prev?.oauth_subject && prev.oauth_subject !== oauthSubject);
      const patch = {
        sealed_session: sealedSession,
        image_access: imageAccess === true,
        enabled: true,
        consecutive_failures: 0,
        last_error: null,
        email_source: emailSource,
        ...(oauthSubject ? { oauth_subject: oauthSubject } : {}),
        issued_at: issuedAt || nowIso,
        updated_at: nowIso,
        ...(accountEmail ? { account_email: accountEmail } : (subjectChanged ? { account_email: '' } : {})),
        ...(accountLabel ? { account_label: accountLabel } : {}),
      };
      await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(targetId)}`, { method: 'PATCH', body: patch });
      return targetId;
    }
    const existing = await dbJson(env, '/freebeat_oauth_accounts?select=id,priority&order=priority.desc&limit=1').catch(() => []);
    const maxPrio = Array.isArray(existing) && existing[0] && Number.isFinite(Number(existing[0].priority)) ? Number(existing[0].priority) : 0;
    const nextPriority = Math.min(100000, maxPrio + 10);
    const created = await dbJson(env, '/freebeat_oauth_accounts', {
      method: 'POST',
      prefer: 'return=representation',
      body: {
        account_email: accountEmail || '',
        account_label: accountLabel || '',
        email_source: emailSource,
        ...(oauthSubject ? { oauth_subject: oauthSubject } : {}),
        ...(connectedBy ? { connected_by: connectedBy } : {}),
        sealed_session: sealedSession,
        image_access: imageAccess === true,
        enabled: true,
        priority: nextPriority,
        issued_at: issuedAt || nowIso,
        updated_at: nowIso,
      },
    });
    return Array.isArray(created) ? created[0]?.id || null : null;
  } catch {
    return null;
  }
}

async function updatePoolAccountSession(env, accountId, sealedSession, imageAccess) {
  if (!accountId) return;
  try {
    await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      body: { sealed_session: sealedSession, image_access: imageAccess === true, updated_at: new Date().toISOString() },
    });
  } catch { /* non-blocking */ }
}

async function syncLegacySessionFromPool(env, fallbackUserId) {
  try {
    const rows = await dbJson(env, '/freebeat_oauth_accounts?select=connected_by,sealed_session,image_access&enabled=eq.true&order=priority.asc,created_at.asc&limit=1');
    const top = Array.isArray(rows) ? rows[0] : null;
    if (top?.sealed_session) {
      await persistProviderSession(env, top.connected_by || fallbackUserId, top.sealed_session, top.image_access === true);
    } else if (fallbackUserId) {
      await clearProviderSession(env, fallbackUserId);
    }
  } catch { /* ignore in legacy tests */ }
}

async function recordPoolAccountOutcome(env, account, { success = false, error = null, balanceCredits = undefined, balancePayload = undefined } = {}) {
  if (!account?.id) return;
  try {
    const nowIso = new Date().toISOString();
    const patch = success
      ? {
          last_used_at: nowIso,
          last_success_at: nowIso,
          consecutive_failures: 0,
          last_error: null,
          updated_at: nowIso,
        }
      : {
          last_used_at: nowIso,
          consecutive_failures: Math.min(1000, Number(account.consecutive_failures || 0) + 1),
          last_error: typeof error === 'string' && error.trim() ? error.trim().slice(0, 300) : 'Gagal memproses permintaan Freebeat',
          updated_at: nowIso,
        };
    if (balanceCredits !== undefined) {
      patch.last_balance_credits = balanceCredits;
      patch.last_balance_checked_at = nowIso;
    }
    if (balancePayload !== undefined) {
      patch.last_balance = balancePayload;
      patch.last_balance_checked_at = nowIso;
    }
    await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(account.id)}`, { method: 'PATCH', body: patch });
  } catch { /* telemetry failure never aborts generation */ }
}

async function loadFreebeatAccountPool(env, { includeDisabled = false, preferredAccountId = null } = {}) {
  let poolRows = null;
  try {
    poolRows = await dbJson(env, '/freebeat_oauth_accounts?select=id,account_email,account_label,email_source,oauth_subject,connected_by,sealed_session,image_access,enabled,priority,consecutive_failures,last_balance_credits,last_balance,last_balance_checked_at,last_error,last_used_at,last_success_at,issued_at,updated_at,created_at&order=priority.asc,created_at.asc&limit=50');
  } catch { poolRows = null; }

  const entries = [];
  if (Array.isArray(poolRows) && poolRows.length > 0) {
    for (const row of poolRows) {
      if (!row?.sealed_session || row.sealed_session.length > 3800) continue;
      if (!includeDisabled && row.enabled === false) continue;
      const rawSession = await unseal(row.sealed_session, env, 'session', 3800);
      if (!rawSession || typeof rawSession.accessToken !== 'string' || !Number.isFinite(rawSession.expiresAt)) continue;
      const session = { ...rawSession, accountId: row.id, accountEmail: row.account_email || rawSession.accountEmail || '' };
      if (!includeDisabled && (!session.imageAccess || row.image_access !== true)) continue;
      entries.push({ ...row, session });
    }
  } else {
    const legacyRows = await dbJson(env, '/freebeat_provider_sessions?select=user_id,sealed_session,image_access,updated_at&order=updated_at.desc&limit=5').catch(() => []);
    for (const row of (Array.isArray(legacyRows) ? legacyRows : [])) {
      if (!row?.sealed_session || row.sealed_session.length > 3800) continue;
      const session = await unseal(row.sealed_session, env, 'session', 3800);
      if (!session || typeof session.accessToken !== 'string' || !Number.isFinite(session.expiresAt)) continue;
      if (!includeDisabled && !session.imageAccess) continue;
      entries.push({
        id: null,
        legacyUserId: row.user_id,
        account_email: session.accountEmail || '',
        account_label: 'Akun Utama',
        enabled: true,
        priority: 10,
        image_access: session.imageAccess === true,
        consecutive_failures: 0,
        session,
      });
    }
  }

  if (preferredAccountId && entries.length > 1) {
    entries.sort((a, b) => (a.id === preferredAccountId ? -1 : b.id === preferredAccountId ? 1 : 0));
  }
  return entries;
}

async function ensureUsablePoolAccount(env, entry) {
  const session = entry?.session;
  if (!session || typeof session.accessToken !== 'string' || !Number.isFinite(session.expiresAt)) return null;
  const issuedAt = Number.isFinite(session.issuedAt) ? session.issuedAt : session.expiresAt;
  if (Date.now() - issuedAt > sessionMaxAgeMs(env)) return null;
  if (session.expiresAt - Date.now() > REFRESH_WINDOW || !session.refreshToken) {
    return session.expiresAt > Date.now() ? { ...entry, session } : null;
  }
  try {
    const outcome = await renewAndPersist(session, env, 'db');
    if (!outcome?.session) return session.expiresAt > Date.now() ? { ...entry, session } : null;
    return { ...entry, session: { ...outcome.session, ...(entry.id ? { accountId: entry.id } : {}), ...(entry.account_email ? { accountEmail: entry.account_email } : {}) } };
  } catch {
    return session.expiresAt > Date.now() ? { ...entry, session } : null;
  }
}

async function openMcpSessionForAccount(env, entry) {
  const session = entry.session;
  try {
    return { headers: await openMcp(session.accessToken), session };
  } catch (error) {
    if (!error?.isMcpFailure || error?.httpStatus === 402 || error?.balanceExhausted) throw error;
    const fresh = entry.id
      ? await readDbSession(env, session.uid, entry.id)
      : await loadProviderSession(env);
    if (!fresh?.accessToken || fresh.accessToken === session.accessToken) throw error;
    console.warn('Freebeat MCP init ditolak; memakai salinan sesi terbaru');
    return { headers: await openMcp(fresh.accessToken), session: fresh };
  }
}

async function checkPoolAccountsBalance(env, targetId = null) {
  const pool = await loadFreebeatAccountPool(env, { includeDisabled: true });
  const targets = targetId ? pool.filter((item) => item.id === targetId) : pool;
  if (targetId && !targets.length) throw fail('Akun OAuth Freebeat tidak ditemukan.', 404);
  const results = [];
  for (const item of targets) {
    const usable = await ensureUsablePoolAccount(env, item);
    if (!usable) {
      await recordPoolAccountOutcome(env, item, { success: false, error: 'Sesi OAuth kedaluwarsa, perlu OAuth ulang' });
      results.push({ id: item.id, account_email: item.account_email, ok: false, error: 'Sesi OAuth kedaluwarsa, perlu OAuth ulang.' });
      continue;
    }
    try {
      const balance = await getBalance(usable.session.accessToken);
      const credits = extractNumericBalance(balance);
      let discoveredEmail = extractEmailFromObject(balance);
      if (!discoveredEmail && item.email_source !== 'oauth') {
        const identity = await resolveFreebeatOAuthIdentity({ access_token: usable.session.accessToken }).catch(() => ({ email: '' }));
        if (identity?.email) discoveredEmail = identity.email;
      }
      const nowIso = new Date().toISOString();
      const patch = {
        last_balance: balance,
        last_balance_credits: credits,
        last_balance_checked_at: nowIso,
        updated_at: nowIso,
        ...(discoveredEmail ? { account_email: discoveredEmail, email_source: 'oauth' } : {}),
        ...(credits !== null && credits > 0 ? { last_error: null, consecutive_failures: 0 } : {}),
        ...(credits === 0 ? { last_error: 'Saldo Freebeat habis (0 kredit)' } : {}),
      };
      await dbFetch(env, `/freebeat_oauth_accounts?id=eq.${encodeURIComponent(item.id)}`, { method: 'PATCH', body: patch });
      results.push({ id: item.id, account_email: discoveredEmail || item.account_email, ok: true, credits, balance });
    } catch (err) {
      const msg = err?.message || 'Gagal membaca saldo Freebeat';
      await recordPoolAccountOutcome(env, item, { success: false, error: msg });
      results.push({ id: item.id, account_email: item.account_email, ok: false, error: msg });
    }
  }
  const accounts = await listPoolAccountsAdmin(env);
  return { results, accounts };
}

function poolRetryDelayMs(env) {
  const raw = env?.FREEBEAT_RETRY_DELAY_MS;
  if (raw === undefined || raw === null || raw === '') return 150;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(2000, parsed) : 150;
}

async function sleepCycleDelay(ms) {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadProviderSession(env) {
  const pool = await loadFreebeatAccountPool(env);
  for (const item of pool) {
    const usable = await ensureUsablePoolAccount(env, item);
    if (usable?.session) return usable.session;
  }
  return null;
}
export function sanitizeImageRow(row) {
  const statuses = new Set(['queued', 'processing', 'completed', 'failed', 'cancelled', 'unknown']);
  const extraUrls = Array.isArray(row.metadata?.image_urls)
    ? row.metadata.image_urls.map(safeImageUrl).filter(Boolean)
    : [];
  return {
    id: row.id,
    provider: typeof row.provider === 'string' && row.provider ? row.provider.slice(0, 40) : 'freebeat',
    model: String(row.model ?? ''),
    prompt: typeof row.prompt === 'string' ? row.prompt.slice(0, 2000) : '',
    status: statuses.has(row.status) ? row.status : 'unknown',
    image_url: safeImageUrl(row.image_url),
    ...(extraUrls.length > 1 ? { image_urls: extraUrls } : {}),
    source_image_url: safeImageUrl(row.metadata?.source_image_url),
    credits_charged: Number.isSafeInteger(row.credits_charged) ? row.credits_charged : 0,
    credits_refunded: Number.isSafeInteger(row.credits_refunded) ? row.credits_refunded : 0,
    error_message: typeof row.error_message === 'string' ? row.error_message.slice(0, 300) : null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || row.created_at || null,
    canPoll: ['queued', 'processing'].includes(row.status) && typeof row.external_job_id === 'string' && TASK_ID.test(row.external_job_id),
  };
}
const FREEBEAT_BUILTIN_MUSIC_MODELS = [
  { model_id: 129, name: 'Lyria 3 Pro', supports_duration: false, supports_lyrics: null, supports_instrumental: null, requires_lyrics: false },
  { model_id: 194, name: 'Suno v6', supports_duration: false, supports_lyrics: null, supports_instrumental: null, requires_lyrics: false },
  { model_id: 130, name: 'MiniMax Music 3', supports_duration: false, supports_lyrics: null, supports_instrumental: null, requires_lyrics: false },
  { model_id: 185, name: 'Mureka V9.5', supports_duration: false, supports_lyrics: null, supports_instrumental: null, requires_lyrics: false },
];

async function consumerImagePrice(env, modelId, modality = 'image') {
  const rows = await dbJson(env, `/credit_model_prices?provider=eq.freebeat&model=eq.${encodeURIComponent(String(modelId))}&modality=eq.${encodeURIComponent(modality)}&active=eq.true&select=credits&limit=1`);
  const credits = Number(Array.isArray(rows) ? rows[0]?.credits : null);
  return Number.isSafeInteger(credits) && credits > 0 && credits <= 1000000 ? credits : null;
}
export async function consumerImageConfig(env) {
  const modelId = consumerImageModel(env);
  const credits = await consumerImagePrice(env, modelId);
  let ready = false;
  try { const session = await loadProviderSession(env); ready = Boolean(session?.imageAccess); } catch { ready = false; }
  return { model_id: modelId, credits, provider_ready: ready, ceiling: consumerProviderCeiling(env), min_margin: consumerMinMargin(env) };
}
export async function fetchFreebeatCatalogModels(env) {
  const byKey = new Map();
  const put = (item) => {
    const key = `${item.category}:${item.id}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      return;
    }
    const mergedTags = [...new Set([...(prev.tags || []), ...(item.tags || [])])];
    byKey.set(key, { ...prev, ...item, tags: mergedTags });
  };
  put({
    id: '122',
    name: 'Freebeat Image Model 122',
    provider: 'freebeat',
    category: 'Image',
    tags: ['Image', 'Freebeat'],
    description: 'Model gambar konsumen Freebeat (default 122).',
    isFree: false,
    online: true,
    priceLabel: 'Kredit BLEA',
  });
  put({
    id: '80',
    name: 'Freebeat Image Model 80',
    provider: 'freebeat',
    category: 'Image',
    tags: ['Image', 'Freebeat'],
    description: 'Model gambar Freebeat (80).',
    isFree: false,
    online: true,
    priceLabel: 'Kredit BLEA',
  });
  put({
    id: '202',
    name: 'Freebeat Image / Edit Model 202',
    provider: 'freebeat',
    category: 'Image',
    tags: ['Image', 'Image Edit', 'Freebeat'],
    description: 'Model gambar & edit gambar Freebeat (202).',
    isFree: false,
    online: true,
    priceLabel: 'Kredit BLEA',
  });
  put({
    id: 'generate_dance_video',
    name: 'Freebeat Music-to-Dance Video (720p)',
    provider: 'freebeat',
    category: 'Video',
    tags: ['Video', 'Dance', 'Freebeat'],
    description: 'Model video tari berbasis musik Freebeat MCP.',
    isFree: false,
    online: true,
    priceLabel: 'Kredit BLEA',
  });
  put({
    id: 'generate_singing_video',
    name: 'Freebeat Singing Video (AI Vocal & MV)',
    provider: 'freebeat',
    category: 'Video',
    tags: ['Video', 'Singing', 'Freebeat'],
    description: 'Model video bernyanyi AI (solo atau duet) dari foto karakter & audio via Freebeat MCP.',
    isFree: false,
    online: true,
    priceLabel: 'Kredit BLEA',
  });
  put({
    id: 'generate_lip_sync_video',
    name: 'Freebeat Lip-Sync Video',
    provider: 'freebeat',
    category: 'Video',
    tags: ['Video', 'Lip-Sync', 'Freebeat'],
    description: 'Model sinkronisasi bibir video sumber dengan audio/lagu via Freebeat MCP.',
    isFree: false,
    online: true,
    priceLabel: 'Kredit BLEA',
  });
  for (const seedMusic of FREEBEAT_BUILTIN_MUSIC_MODELS) {
    put({
      id: String(seedMusic.model_id),
      name: seedMusic.name,
      provider: 'freebeat',
      category: 'Music',
      tags: ['Music', 'Freebeat'],
      description: `${seedMusic.name} — generate_music Freebeat MCP.`,
      isFree: false,
      online: true,
      priceLabel: 'Kredit BLEA',
    });
  }
  try {
    const pool = await loadFreebeatAccountPool(env);
    for (const rawEntry of pool.slice(0, 3)) {
      const usable = await ensureUsablePoolAccount(env, rawEntry).catch(() => null);
      const accessToken = usable?.session?.accessToken;
      if (!accessToken) continue;
      const headers = await openMcp(accessToken);
      const [imgRes, editRes, vidRes, musRes] = await Promise.allSettled([
        getModels(accessToken, 'image', headers),
        getModels(accessToken, 'image_edit', headers),
        getModels(accessToken, 'video', headers),
        fetchRawMusicModels(accessToken, headers),
      ]);
      for (const [category, res, extraTag] of [
        ['Image', imgRes, null],
        ['Image', editRes, 'Image Edit'],
        ['Video', vidRes, null],
      ]) {
        if (res.status !== 'fulfilled' || !Array.isArray(res.value?.models)) continue;
        for (const m of res.value.models) {
          const id = String(m.model_id);
          put({
            id,
            name: m.name,
            provider: 'freebeat',
            category,
            tags: [category, 'Freebeat MCP', ...(extraTag ? [extraTag] : []), ...(m.member_only ? ['Member Only'] : [])],
            description: `${m.name}${m.member_only ? ' · khusus member' : ''}`,
            isFree: false,
            online: m.available !== false,
            priceLabel: m.member_only ? 'Member Only' : 'Freebeat MCP',
          });
        }
      }
      if (musRes.status === 'fulfilled' && Array.isArray(musRes.value)) {
        for (const m of musRes.value) {
          const id = String(m.model_id);
          const available = m.available !== false && m.pricing_status !== 'unavailable';
          put({
            id,
            name: m.name,
            provider: 'freebeat',
            category: 'Music',
            tags: [
              'Music',
              'Freebeat MCP',
              ...(m.requires_lyrics ? ['Wajib Lirik'] : []),
              ...(m.supports_duration ? ['Durasi Kustom'] : []),
            ],
            description: `${m.name}${m.credits !== null ? ` (~${m.credits} kredit Freebeat)` : ''}`,
            isFree: false,
            online: available,
            priceLabel: m.credits !== null ? `${m.credits} FB` : 'Freebeat MCP',
          });
        }
      }
      break;
    }
  } catch { /* fallback to built-in Freebeat models if live MCP is unreachable */ }
  return Array.from(byKey.values());
}
// Service_role menembus RLS, jadi status akun harus diperiksa di worker:
// policy database saja tidak cukup untuk menahan user yang di-suspend/banned.
async function assertAccountActive(env, userId) {
  const rows = await dbJson(env, `/profiles?id=eq.${encodeURIComponent(userId)}&select=status&limit=1`);
  const status = Array.isArray(rows) ? rows[0]?.status : null;
  if (status === 'banned') throw fail('Akun Anda diblokir. Hubungi admin BLEA.', 403);
  if (status === 'suspended') throw fail('Akun Anda sedang ditangguhkan sementara. Hubungi admin BLEA.', 403);
}
export async function consumerImageGenerate(env, request, user) {
  await assertAccountActive(env, user.id);
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Masukkan prompt sepanjang 1-2000 karakter.', 400);
  const allowedKeys = new Set(['prompt', 'provider', 'model', 'size', 'n']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw fail('Permintaan tidak valid.', 400);
  if (input.provider !== undefined && String(input.provider) !== 'freebeat') throw fail('Provider gambar tidak dikenal.', 400);
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.trim().length > 2000) throw fail('Masukkan prompt sepanjang 1-2000 karakter.', 400);
  const prompt = input.prompt.trim();
  const modelId = consumerImageModel(env);
  const price = await consumerImagePrice(env, modelId, 'image');
  if (price === null) throw fail('Harga kredit untuk model gambar ini belum diatur admin; generasi tidak dikirim.', 409);

  const pool = await loadFreebeatAccountPool(env);
  if (!pool.length) {
    throw fail('Provider gambar belum siap (admin belum menghubungkan Freebeat dengan izin generasi). Coba lagi nanti.', 503);
  }

  const ceiling = consumerProviderCeiling(env);
  const minMargin = consumerMinMargin(env);
  const retryDelayMs = poolRetryDelayMs(env);
  let spentState = null;
  let sawBalanceExhausted = false;
  let lastFailoverError = null;

  const refundImageSpend = async (reason, errorMessage) => {
    if (!spentState) return;
    const refunded = await dbRpc(env, 'refund_credits', {
      p_user_id: user.id,
      p_amount: price,
      p_description: reason,
      p_generation_id: spentState.rowId,
    }).catch(() => false);
    await dbFetch(env, `/image_generations?id=eq.${encodeURIComponent(spentState.rowId)}`, {
      method: 'PATCH',
      body: {
        status: 'failed',
        error_message: errorMessage,
        ...(refunded ? { credits_refunded: price } : {}),
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
  };

  for (let cycle = 1; cycle <= FREEBEAT_POOL_MAX_CYCLES; cycle += 1) {
    if (cycle > 1) await sleepCycleDelay(retryDelayMs);
    for (const rawAccount of pool) {
      const account = await ensureUsablePoolAccount(env, rawAccount);
      if (!account) {
        await recordPoolAccountOutcome(env, rawAccount, { success: false, error: 'Token OAuth kedaluwarsa atau belum memiliki izin generasi' });
        lastFailoverError = fail('Token OAuth Freebeat kedaluwarsa.', 401);
        continue;
      }

      let opened;
      let quoteContent;
      try {
        opened = await openMcpSessionForAccount(env, account);
        const catalog = await getModels(opened.session.accessToken, 'image', opened.headers);
        const entry = catalog.models.find((item) => item.model_id === modelId);
        if (!entry) throw fail(`Model gambar ${modelId} tidak tersedia di provider saat ini.`, 409);
        if (entry.member_only === true) throw fail('Model ini khusus member di sisi provider.', 409);
        if (entry.available === false) throw fail('Model ini sedang tidak tersedia di sisi provider.', 409);
        quoteContent = await rawToolQuote(opened.session.accessToken, 'generate_image', { model_id: modelId, prompt }, opened.headers, true);
      } catch (err) {
        if (isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis' : (err?.message || 'Koneksi akun gagal'),
          });
          lastFailoverError = err;
          continue;
        }
        await refundImageSpend('Refund: gagal memeriksa quote gambar Freebeat', err?.message || 'Generasi gambar gagal.');
        throw err;
      }

      if (isFreebeatBalanceExhausted(quoteContent)) {
        sawBalanceExhausted = true;
        await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis (quote)' });
        lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
        continue;
      }

      const quote = quotedCredits(quoteContent);
      if (quote === null) {
        const masked = safeQuote(quoteContent);
        const hint = masked && typeof masked === 'object' && typeof masked.status === 'string' ? ` Status provider: ${masked.status}.` : '';
        const err = fail(`Provider tidak memberikan quote biaya yang dapat dipakai untuk model ${modelId}; generasi tidak dikirim dan kredit tidak dipotong.${hint}`, 409);
        await refundImageSpend('Refund: quote gambar Freebeat tidak tersedia', err.message);
        throw err;
      }
      if (quote > ceiling) {
        const err = fail(`Biaya provider ${quote} kredit Freebeat melebihi plafon ${ceiling}; generasi tidak dikirim.`, 409);
        await refundImageSpend('Refund: biaya provider melebihi plafon', err.message);
        throw err;
      }
      if (price < quote * minMargin) {
        const err = fail(`Harga ${price} kredit BLEA lebih rendah dari biaya provider (${quote} kredit Freebeat x ${minMargin}). Admin perlu menaikkan harga model ini; generasi tidak dikirim dan kredit tidak dipotong.`, 409);
        await refundImageSpend('Refund: margin harga model gambar belum mencukupi', err.message);
        throw err;
      }

      if (!spentState) {
        const rowId = crypto.randomUUID();
        const spent = await dbRpc(env, 'spend_credits', { p_user_id: user.id, p_amount: price, p_description: `Generasi gambar Freebeat model ${modelId}`, p_generation_id: rowId });
        if (!spent) throw fail('Kredit BLEA tidak cukup untuk generasi ini.', 402);
        const metadata = {
          provider_quote: quote,
          quote_capped: false,
          catalog: 'image',
          mode: 'text',
          ...(account.id ? { freebeat_account_id: account.id } : {}),
          ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
        };
        let inserted = null;
        try {
          inserted = await dbJson(env, '/image_generations', { method: 'POST', prefer: 'return=representation', body: { id: rowId, user_id: user.id, provider: 'freebeat', model: String(modelId), prompt, credits_charged: price, status: 'processing', metadata } });
        } catch { inserted = null; }
        if (!Array.isArray(inserted) || inserted.length !== 1) {
          try { await dbRpc(env, 'refund_credits', { p_user_id: user.id, p_amount: price, p_description: 'Refund: riwayat generasi gambar tidak tersimpan', p_generation_id: rowId }); } catch { /* refund manual oleh admin */ }
          throw fail('Riwayat generasi tidak dapat disimpan; kredit BLEA dikembalikan. Silakan coba lagi.', 503);
        }
        spentState = { rowId, insertedRow: inserted[0], metadata };
      }

      try {
        const { result } = await rpc(
          opened.session.accessToken,
          { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { model_id: modelId, prompt, max_credits: quote } } },
          'generate',
          opened.headers,
          262144,
          true,
        );
        if (result?.isError || isFreebeatBalanceExhausted(result)) {
          if (isFreebeatBalanceExhausted(result)) {
            sawBalanceExhausted = true;
            await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat generate gambar' });
            lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            continue;
          }
          const err = fail('Provider menolak permintaan generasi gambar.', 502);
          await refundImageSpend('Refund: permintaan gambar ditolak Freebeat', err.message);
          throw err;
        }
        const content = modelContent(result);
        if (content && isFreebeatBalanceExhausted(content) && !content.batch_id) {
          sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat generate gambar' });
          lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
          continue;
        }
        if (!content || typeof content !== 'object' || typeof content.batch_id !== 'string' || !TASK_ID.test(content.batch_id)) {
          throw new Error('unrecognized');
        }
        const nextMeta = {
          ...spentState.metadata,
          provider_quote: quote,
          ...(account.id ? { freebeat_account_id: account.id } : {}),
          ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
        };
        await dbFetch(env, `/image_generations?id=eq.${encodeURIComponent(spentState.rowId)}`, {
          method: 'PATCH',
          body: { external_job_id: content.batch_id, status: 'processing', metadata: nextMeta, updated_at: new Date().toISOString() },
        });
        await recordPoolAccountOutcome(env, account, { success: true });
        return {
          status: 'submitted',
          credits: price,
          mode: 'text',
          generation: sanitizeImageRow({ ...spentState.insertedRow, external_job_id: content.batch_id, metadata: nextMeta }),
        };
      } catch (err) {
        if (err?.status && spentState && err.message?.includes('Provider menolak permintaan')) throw err;
        if (isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis saat generate gambar' : (err?.message || 'Gagal generate gambar'),
          });
          lastFailoverError = err;
          continue;
        }
        try { await dbFetch(env, `/image_generations?id=eq.${encodeURIComponent(spentState.rowId)}`, { method: 'PATCH', body: { status: 'unknown', error_message: 'Hasil pengiriman tidak pasti; periksa status sebelum mengulang.', updated_at: new Date().toISOString() } }); } catch { /* biarkan status processing */ }
        return { status: 'unknown', credits: price, mode: 'text', generation: sanitizeImageRow({ ...spentState.insertedRow, status: 'unknown' }) };
      }
    }
  }

  await refundImageSpend(
    sawBalanceExhausted ? 'Refund: saldo gateway Freebeat habis setelah 3 putaran' : 'Refund: semua akun Freebeat gagal memproses gambar',
    sawBalanceExhausted ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE : (lastFailoverError?.message || 'Generasi gambar gagal pada semua akun Freebeat.'),
  );
  if (sawBalanceExhausted) {
    const err = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
    err.code = 'gateway_balance_exhausted';
    throw err;
  }
  throw lastFailoverError || fail('Semua akun Freebeat tidak dapat memproses permintaan saat ini.', 503);
}
// Kosakata alasan kegagalan yang aman ditampilkan ke user biasa. Di luar daftar
// ini alasan hanya disimpan sebagai "lainnya" agar pesan mentah provider tidak
// bocor ke antarmuka konsumen.
const IMAGE_FAILURE_REASONS = new Set(['invalid_input', 'invalid_parameter', 'unsupported_model', 'unsupported_resolution', 'invalid_image', 'image_download_failed', 'insufficient_credits', 'membership_required', 'permission_denied', 'content_policy', 'moderation_failed', 'provider_error', 'generation_failed', 'timeout', 'unknown']);
function imageFailureFields(content) {
  const fields = (value) => [value?.failure?.reason, value?.error_code, value?.error_message, value?.message, value?.status_message];
  return [...fields(content), ...(Array.isArray(content?.items) ? content.items.slice(0, 10).flatMap(fields) : [])];
}
function imageFailureReasons(content) {
  const codes = (value) => (typeof value === 'string' && IMAGE_FAILURE_REASONS.has(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null);
  return [...new Set(imageFailureFields(content).map(codes).filter(Boolean))];
}
// Upload is a separate tool: some MCP deployments reject its quote while
// accepting the OAuth session. Keep diagnostics fixed/numeric, never raw prose.
async function imageUploadQuote(accessToken, photoUrl, existingHeaders = null) {
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'quote_generation', arguments: { tool: 'upload_image', parameters: { urls: [photoUrl] } } } }, 'quote', headers, 262144, true);
  if (result?.isError || result?.error) {
    const exhausted = isFreebeatBalanceExhausted(result);
    const rpcCode = Number.isSafeInteger(result?.error?.code) ? result.error.code : null;
    const content = modelContent(result);
    // SDK tool errors often have no JSON-RPC code or stable wording. An
    // unpriced tool rejection may be opted into explicitly; it is not proof
    // that upload is free/supported. Access/balance/transient failures stay shut.
    let remaining = 16000;
    const failureText = (value, depth = 0) => {
      if (remaining <= 0 || depth > 5 || value == null) return '';
      if (typeof value === 'string') { const part = value.slice(0, Math.min(2000, remaining)); remaining -= part.length; return part; }
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.slice(0, 10).map((item) => failureText(item, depth + 1)).join(' ');
      if (typeof value !== 'object') return '';
      return ['message', 'reason', 'code', 'status', 'error_code', 'error', 'structuredContent', 'content', 'text', 'detail', 'details', 'data'].filter((key) => key in value).map((key) => failureText(value[key], depth + 1)).join(' ');
    };
    // Classification only: never log or return provider text.
    const text = failureText(result);
    const accessDenied = /unauthori[sz]ed|forbidden|access[ _-]denied|permission[ _-]denied|invalid[ _-](?:access[ _-])?token|(?:expired|revoked)[ _-](?:access[ _-])?token|token[ _-](?:expired|invalid|revoked)|auth(?:entication)?[ _-](?:required|failed)|not[ _-](?:authenticated|logged[ _-]in)|insufficient[ _-]scope/i.test(text);
    const temporaryFailure = rpcCode === -32603 || /internal[ _-](?:server[ _-])?error|timed?[ _-]out|timeout|temporar(?:ily|y)[ _-](?:unavailable|failure)|rate[ _-]limit|too many requests|connection[ _-](?:reset|refused)|service[ _-]unavailable|bad[ _-]gateway/i.test(text);
    const toolRejected = result.isError === true && !result.error;
    const unpriced = toolRejected || [-32601, -32602].includes(rpcCode) || ['unavailable', 'unsupported', 'not_supported', 'unquotable', 'no_quote'].includes(content?.status);
    const kind = exhausted ? 'insufficient_credits' : accessDenied ? 'access_denied' : temporaryFailure ? 'temporary_failure' : toolRejected ? 'tool_rejected' : 'rpc_rejected';
    return { credits: null, status: exhausted ? 'insufficient_credits' : 'quote_rejected', unknown_cost_allowed: !exhausted && !accessDenied && !temporaryFailure && unpriced,
      diagnostic: { stage: 'upload_quote', kind, ...(rpcCode !== null ? { rpc_code: rpcCode } : {}) }, quote: null };
  }
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('quote', 'response');
  const credits = quotedCredits(content);
  const statuses = new Set(['quoted', 'available', 'unavailable', 'unsupported', 'insufficient_credits']);
  const status = statuses.has(content.status) ? content.status : 'unknown';
  return { credits, status, unknown_cost_allowed: credits === null && ['unavailable', 'unsupported'].includes(status), quote: safeQuote(content) };
}
// Only return a structured, validated Freebeat URL for quote handoff. Never
// scrape arbitrary message text or treat an echoed external source as hosted.
function hostedUploadImageUrl(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content) || content.success === false || ['failed', 'error', 'rejected'].includes(content.status)) return null;
  const raw = content.image_urls ?? content.urls ?? content.uploaded_urls ?? content.images ?? content.files ?? content.items ?? content.data?.image_urls ?? content.data?.urls ?? content.data?.uploaded_urls ?? content.data?.files ?? (Array.isArray(content.data) ? content.data : null);
  let candidate;
  if (Array.isArray(raw)) {
    if (raw.length !== 1) return null;
    candidate = typeof raw[0] === 'string' ? raw[0] : (raw[0]?.download_url ?? raw[0]?.image_url ?? raw[0]?.url);
  } else candidate = content.download_url ?? content.image_url ?? content.url ?? content.data?.download_url ?? content.data?.image_url ?? content.data?.url;
  const url = consumerImageUrl(candidate);
  return url && url.length <= 2048 && isFreebeatHostedMediaUrl(url) ? url : null;
}
async function imageUploadHost(accessToken, photoUrl, existingHeaders = null) {
  let content;
  try {
    const headers = existingHeaders || await openMcp(accessToken);
    const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'upload_image', arguments: { urls: [photoUrl] } } }, 'upload', headers, 262144);
    content = modelContent(result);
    if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('upload', 'response');
  } catch {
    // No retries: even a lost response can mean the photo was stored/charged.
    return { outcome: 'unknown', image_url: null, upload: null };
  }
  // Arbitrary strings stay hidden; only the structured validated image_url is exposed.
  const redact = (value, depth = 0) => {
    if (depth > 4) return '[terlalu dalam]';
    if (typeof value === 'string') return '[teks disembunyikan]';
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
    if (typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 25).map(([key, child]) => [key, redact(child, depth + 1)]));
    return null;
  };
  const image_url = hostedUploadImageUrl(content);
  return { outcome: image_url ? 'uploaded' : 'unknown', image_url, upload: redact(content) };
}
// Helper bersama untuk fase berikutnya (generate_music_video, generate_lyric_video,
// generate_effect): unggah URL gambar eksternal lewat tool upload_image dan
// lewatkan URL yang sudah di-host di domain Freebeat.
export async function freebeatUploadImages(accessToken, urls, existingHeaders = null, captureToolError = false) {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 5) {
    throw fail('Daftar URL gambar untuk upload_image harus 1 hingga 5 item.', 400);
  }
  const cleanUrls = urls.map((raw) => {
    const safe = consumerImageUrl(typeof raw === 'string' ? raw : '');
    if (!safe) throw fail('Setiap URL gambar harus berupa HTTPS publik yang valid.', 400);
    return safe;
  });
  const externalIndices = [];
  const externalUrls = [];
  cleanUrls.forEach((url, idx) => {
    if (!isFreebeatHostedMediaUrl(url)) {
      externalIndices.push(idx);
      externalUrls.push(url);
    }
  });
  if (externalUrls.length === 0) {
    return { urls: cleanUrls, uploaded_count: 0 };
  }
  const headers = existingHeaders || await openMcp(accessToken);
  const { result } = await rpc(accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'upload_image', arguments: { urls: externalUrls } },
  }, 'upload', headers, 262144, captureToolError);
  if (result?.isError || result?.error) throw mcpFailure('upload', 'rpc');
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('upload', 'response');
  const rawList = content.urls ?? content.uploaded_urls ?? content.images ?? content.files ?? content.items ?? content.data?.urls ?? content.data?.uploaded_urls ?? content.data?.files ?? (Array.isArray(content.data) ? content.data : null);
  const resolved = Array.isArray(rawList)
    ? rawList.map((entry) => safeImageUrl(typeof entry === 'string' ? entry : (entry?.download_url ?? entry?.image_url ?? entry?.url))).filter(Boolean)
    : (externalUrls.length === 1
      ? [safeImageUrl(content.download_url ?? content.image_url ?? content.url ?? content.data?.download_url ?? content.data?.image_url ?? content.data?.url)].filter(Boolean)
      : []);
  if (resolved.length !== externalUrls.length) {
    throw fail('Freebeat tidak mengembalikan URL upload_image lengkap untuk seluruh gambar.', 502);
  }
  const out = [...cleanUrls];
  externalIndices.forEach((origIdx, i) => {
    out[origIdx] = resolved[i];
  });
  return { urls: out, uploaded_count: externalUrls.length };
}
// Pemeriksaan job gambar apa pun oleh admin, termasuk job milik pengguna yang
// dibuat lewat halaman Generate (riwayat uji admin tidak memuatnya).
async function imageTaskInspect(accessToken, jobId, raw) {
  const headers = await openMcp(accessToken);
  const { result } = await rpc(accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task_status', arguments: { task_id: jobId } } }, 'task', headers, 262144);
  const content = modelContent(result);
  if (!content || typeof content !== 'object' || Array.isArray(content)) throw mcpFailure('task', 'response');
  const task = safeTask(content);
  const reasons = [...new Set(imageFailureFields(content).map(privateFailureReason).filter(Boolean))];
  // Provider menaruh detail di tingkat item, bukan di akar. Ringkasan ini
  // menampilkan kunci dan nilai aman tiap item agar alasan yang tidak termasuk
  // kosakata kita tetap terlihat tanpa harus membuka mode mentah.
  const items = Array.isArray(content.items) ? content.items.slice(0, 5).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    return Object.fromEntries(Object.entries(item).slice(0, 25).map(([key, value]) => {
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key, value];
      if (typeof value === 'string') return [key, privateFailureReason(value)?.slice(0, 400) ?? null];
      if (Array.isArray(value)) return [key, `[array ${value.length}]`];
      return [key, `[objek ${Object.keys(value).slice(0, 8).join(',')}]`];
    }));
  }).filter(Boolean) : [];
  return { job_id: jobId, status: task.status, billing: task.billing, images: task.images, reasons, root_keys: Object.keys(content).slice(0, 25), items, ...(raw ? { raw: content } : {}) };
}
async function loadPreferredAccountSession(env, preferredAccountId = null) {
  const pool = await loadFreebeatAccountPool(env, { includeDisabled: true, preferredAccountId });
  for (const item of pool) {
    if (!item?.session?.imageAccess) continue;
    const usable = await ensureUsablePoolAccount(env, item);
    if (usable?.session) return usable;
  }
  return null;
}

export async function pollFreebeatImageRow(env, row) {
  if (!row || !['queued', 'processing'].includes(row.status) || typeof row.external_job_id !== 'string' || !TASK_ID.test(row.external_job_id)) {
    return { generation: sanitizeImageRow(row || {}), task: null };
  }
  const preferredAccountId = row.metadata?.freebeat_account_id || null;
  const usable = await loadPreferredAccountSession(env, preferredAccountId);
  const session = usable?.session || null;
  if (!session?.imageAccess) throw fail('Provider belum siap; status tidak dapat diperiksa sekarang.', 503);
  const opened = await openMcpSessionForAccount(env, usable);
  const { result } = await rpc(opened.session.accessToken, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task_status', arguments: { task_id: row.external_job_id } } }, 'task', opened.headers, 262144);
  const content = modelContent(result);
  const task = safeTask(content);
  let patch = null;
  // Biaya riil provider (billing.charged) dan alasan kegagalan disimpan supaya
  // admin dapat mencocokkan harga jual dengan pengeluaran sebenarnya.
  const metaPatch = { ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}), provider_billing: task.billing };
  if (task.status === 'completed') {
    patch = { status: 'completed', image_url: task.images[0] || null, error_message: null, metadata: metaPatch, updated_at: new Date().toISOString() };
  } else if (task.status === 'failed' || task.status === 'partial_failed' || task.status === 'cancelled' || task.status === 'expired') {
    const reasons = imageFailureReasons(content);
    const detail = reasons.length ? reasons.join(', ') : (imageFailureFields(content).some((value) => typeof value === 'string' && value.trim()) ? 'lainnya (lihat pemeriksaan admin)' : null);
    const nextStatus = task.status === 'cancelled' ? 'cancelled' : 'failed';
    const errText = task.status === 'cancelled'
      ? 'Provider membatalkan generasi gambar.'
      : task.status === 'expired'
        ? 'Tugas generasi gambar kedaluwarsa di provider.'
        : (detail ? `Provider melaporkan generasi gagal: ${detail}.` : 'Provider melaporkan generasi gagal.');
    patch = { status: nextStatus, error_message: errText, metadata: { ...metaPatch, failure_reasons: reasons, failure_detail_hidden: detail === 'lainnya (lihat pemeriksaan admin)' }, updated_at: new Date().toISOString() };
  } else if (['pending', 'queued', 'processing', 'running'].includes(task.status)) {
    patch = { status: 'processing', updated_at: new Date().toISOString() };
  }
  if (patch) {
    try { await dbFetch(env, `/image_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: patch }); } catch { /* status lama tetap ditampilkan */ }
    if (['failed', 'cancelled'].includes(patch.status) && Number(row.credits_charged) > 0 && Number(row.credits_refunded) === 0) {
      let refunded = false;
      try { refunded = await dbRpc(env, 'refund_credits', { p_user_id: row.user_id, p_amount: Number(row.credits_charged), p_description: patch.status === 'cancelled' ? 'Refund: generasi gambar dibatalkan provider' : 'Refund: generasi gambar gagal', p_generation_id: row.id }); } catch { refunded = false; }
      if (refunded) {
        try { await dbFetch(env, `/image_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: { credits_refunded: Number(row.credits_charged), updated_at: new Date().toISOString() } }); } catch { /* ledger sudah benar */ }
        row.credits_refunded = Number(row.credits_charged);
      }
    }
  }
  return { generation: sanitizeImageRow({ ...row, ...(patch || {}) }), task: { status: task.status, billing: task.billing } };
}
export async function consumerImageStatus(env, request, user) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'id') || typeof input.id !== 'string' || !TEST_ID.test(input.id)) throw fail('ID generasi tidak valid.', 400);
  const rows = await dbJson(env, `/image_generations?id=eq.${encodeURIComponent(input.id)}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Riwayat generasi tidak ditemukan.', 404);
  return await pollFreebeatImageRow(env, row);
}
export async function consumerImageHistory(env, user) {
  const rows = await dbJson(env, `/image_generations?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=created_at.desc,id.desc&limit=40`);
  return { generations: (Array.isArray(rows) ? rows : []).map(sanitizeImageRow) };
}

// ===================== Generasi Freebeat Dance Video (konsumen) =====================
function consumerDanceCeiling(env) {
  const n = Number(env?.FREEBEAT_DANCE_MAX_PROVIDER_CREDITS);
  return Number.isSafeInteger(n) && n >= 100 && n <= 100000 ? n : 2000;
}
function consumerDanceMinBalance(env) {
  const raw = env?.FREEBEAT_DANCE_MIN_CREDITS;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) return n;
  }
  return 800;
}
function consumerDanceActionBalanceFloor(env) {
  const raw = env?.FREEBEAT_DANCE_ACTION_MIN_CREDITS;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) return n;
  }
  return 400;
}

export async function consumerDanceConfig(env) {
  let credits = null;
  try { credits = await consumerImagePrice(env, 'generate_dance_video', 'video'); } catch { credits = null; }
  let ready = false;
  try { const session = await loadProviderSession(env); ready = Boolean(session?.imageAccess); } catch { ready = false; }
  return { model: 'generate_dance_video', credits, provider_ready: ready };
}

function validateConsumerDancePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('Permintaan dance video tidak valid.', 400);
  }
  const model = String(payload.model || '').trim();
  if (model !== 'generate_dance_video') {
    throw fail('Model video Freebeat tidak didukung. Pilih generate_dance_video.', 400);
  }
  const audioUrl = consumerImageUrl(typeof payload.audio_url === 'string' ? payload.audio_url : '');
  if (!audioUrl) {
    throw fail('Unggah file audio / lagu atau masukkan URL musik HTTPS publik yang valid.', 400);
  }
  const rawRefs = Array.isArray(payload.reference_images) && payload.reference_images.length > 0
    ? payload.reference_images
    : (typeof payload.image_url === 'string' && payload.image_url.trim() ? [payload.image_url] : []);
  if (rawRefs.length > 5) throw fail('Maksimal 5 foto penari.', 400);
  const imageUrls = rawRefs.map((raw) => {
    const safe = consumerImageUrl(typeof raw === 'string' ? raw : '');
    if (!safe) throw fail('Setiap foto penari harus berupa URL HTTPS publik yang valid.', 400);
    return safe;
  });
  const aspectRatio = typeof payload.aspect_ratio === 'string' && DANCE_RATIOS.has(payload.aspect_ratio.trim())
    ? payload.aspect_ratio.trim()
    : '9:16';
  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (prompt.length > 2000) throw fail('Prompt maksimal 2000 karakter.', 400);
  let startMs;
  let endMs;
  if (payload.start_ms !== undefined && payload.start_ms !== null && payload.start_ms !== '') {
    if (!Number.isSafeInteger(payload.start_ms) || payload.start_ms < 0 || payload.start_ms > 600000) {
      throw fail('start_ms tidak valid.', 400);
    }
    startMs = payload.start_ms;
  }
  if (payload.end_ms !== undefined && payload.end_ms !== null && payload.end_ms !== '') {
    if (!Number.isSafeInteger(payload.end_ms) || payload.end_ms <= 0 || payload.end_ms > 600000) {
      throw fail('end_ms tidak valid.', 400);
    }
    endMs = payload.end_ms;
  }
  if ((startMs !== undefined) !== (endMs !== undefined)) {
    throw fail('Isi start_ms dan end_ms bersama-sama.', 400);
  }
  if (startMs !== undefined && endMs <= startMs) {
    throw fail('end_ms harus lebih besar dari start_ms.', 400);
  }
  return { audioUrl, imageUrls, aspectRatio, prompt, startMs, endMs };
}

export async function consumerDanceGenerate(env, user, payload) {
  const input = validateConsumerDancePayload(payload);
  await assertAccountActive(env, user.id);

  const price = await consumerImagePrice(env, 'generate_dance_video', 'video');
  if (price === null) {
    const err = fail('Harga kredit untuk model video "generate_dance_video" (freebeat) belum diatur admin. Atur dulu di Admin → API Key → Katalog Model.', 409);
    err.code = 'video_price_missing';
    throw err;
  }

  const pool = await loadFreebeatAccountPool(env);
  if (!pool.length) {
    throw fail('Provider Freebeat Dance belum siap (admin belum menghubungkan Freebeat dengan izin generasi). Coba lagi nanti.', 503);
  }

  const retryDelayMs = poolRetryDelayMs(env);
  let spentState = null;
  let sawBalanceExhausted = false;
  let lastFailoverError = null;

  const refundDanceSpend = async (reason, errorMessage, statusCode = 502) => {
    if (!spentState) return errorMessage;
    const refunded = await dbRpc(env, 'refund_credits', {
      p_user_id: user.id,
      p_amount: price,
      p_description: reason,
      p_generation_id: spentState.genId,
    }).catch(() => false);
    const fullMsg = statusCode === 503 && sawBalanceExhausted
      ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE
      : `${errorMessage}${refunded && !errorMessage.includes('Kredit BLEA dikembalikan') ? ' Kredit BLEA dikembalikan.' : ''}`;
    const failedPatch = {
      status: 'failed',
      progress: 0,
      error_message: fullMsg,
      ...(refunded ? { credits_refunded: price } : {}),
    };
    await dbFetch(env, `/video_generations?id=eq.${encodeURIComponent(spentState.genId)}`, { method: 'PATCH', body: failedPatch }).catch(() => {});
    return fullMsg;
  };

  for (let cycle = 1; cycle <= FREEBEAT_POOL_MAX_CYCLES; cycle += 1) {
    if (cycle > 1) await sleepCycleDelay(retryDelayMs);
    for (const rawAccount of pool) {
      const account = await ensureUsablePoolAccount(env, rawAccount);
      if (!account) {
        await recordPoolAccountOutcome(env, rawAccount, { success: false, error: 'Token OAuth kedaluwarsa atau belum memiliki izin generasi' });
        lastFailoverError = fail('Token OAuth Freebeat kedaluwarsa.', 401);
        continue;
      }

      let opened;
      let balanceCheck = { credits: null, payload: null };
      let musicId;
      try {
        opened = await openMcpSessionForAccount(env, account);
        if (account.id) {
          balanceCheck = await readMcpAccountBalance(opened.session.accessToken, opened.headers);
          if (balanceCheck.credits !== null && balanceCheck.credits <= 0) {
            const err = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            err.balanceExhausted = true;
            throw err;
          }
        }
        const { result: audioRes } = await rpc(opened.session.accessToken, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'upload_audio', arguments: { url: input.audioUrl } },
        }, 'upload', opened.headers, 262144, true);
        if (audioRes?.isError || audioRes?.error) {
          if (isFreebeatBalanceExhausted(audioRes)) {
            const err = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            err.balanceExhausted = true;
            throw err;
          }
          throw fail('Audio atau tautan lagu tidak dapat diproses oleh Freebeat. Periksa format file atau URL publik Anda.', 400);
        }
        const audioContent = modelContent(audioRes);
        const rawId = audioContent?.music_id ?? audioContent?.musicId ?? audioContent?.id;
        if (rawId === undefined || rawId === null || !/^[A-Za-z0-9_.:-]{1,256}$/.test(String(rawId).trim())) {
          throw fail('Audio atau tautan lagu tidak dapat diproses oleh Freebeat. Periksa format file atau URL publik Anda.', 400);
        }
        musicId = normalizeDanceMusicId(String(rawId).trim());
      } catch (err) {
        if (isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis' : (err?.message || 'Koneksi akun gagal'),
            ...(balanceCheck.credits !== null ? { balanceCredits: balanceCheck.credits, balancePayload: balanceCheck.payload } : {}),
          });
          lastFailoverError = err;
          continue;
        }
        if (err?.status === 400) {
          if (spentState) await refundDanceSpend('Refund: audio tidak dapat diproses Freebeat', err.message, 400);
          throw err;
        }
        const badAudioErr = fail('Audio atau tautan lagu tidak dapat diproses oleh Freebeat. Periksa format file atau URL publik Anda.', 400);
        if (spentState) await refundDanceSpend('Refund: audio tidak dapat diproses Freebeat', badAudioErr.message, 400);
        throw badAudioErr;
      }

      const danceParams = {
        music_id: musicId,
        auto_mode: true,
        aspect_ratio: input.aspectRatio,
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(input.imageUrls.length ? { image_urls: input.imageUrls } : {}),
        ...(input.startMs !== undefined ? { start_ms: input.startMs, end_ms: input.endMs } : {}),
      };

      let acceptUnknownCost = true;
      let maxCredits = null;
      let providerQuote = null;
      let quoteBalanceExhausted = false;
      try {
        const quoteContent = await rawToolQuote(opened.session.accessToken, 'generate_dance_video', danceParams, opened.headers, true);
        if (isFreebeatBalanceExhausted(quoteContent)) {
          quoteBalanceExhausted = true;
        } else {
          providerQuote = quotedCredits(quoteContent);
          if (providerQuote !== null) {
            const ceiling = consumerDanceCeiling(env);
            if (providerQuote > ceiling) {
              const err = fail(`Biaya provider (${providerQuote} kredit Freebeat) melebihi plafon layanan (${ceiling}); generasi tidak dikirim.`, 409);
              if (spentState) await refundDanceSpend('Refund: biaya provider dance melebihi plafon', err.message, 409);
              throw err;
            }
            acceptUnknownCost = false;
            maxCredits = providerQuote + videoHeadroom(providerQuote);
          }
        }
      } catch (err) {
        if (err?.status === 409) throw err;
        if (isAccountFailoverError(err)) {
          quoteBalanceExhausted = isFreebeatBalanceExhausted(err);
          if (!quoteBalanceExhausted) {
            await recordPoolAccountOutcome(env, account, { success: false, error: err?.message || 'Gagal menghubungi akun Freebeat' });
            lastFailoverError = err;
            continue;
          }
        }
      }

      if (quoteBalanceExhausted) {
        sawBalanceExhausted = true;
        await recordPoolAccountOutcome(env, account, {
          success: false,
          error: 'Saldo Freebeat habis (quote)',
          ...(balanceCheck.credits !== null ? { balanceCredits: balanceCheck.credits, balancePayload: balanceCheck.payload } : {}),
        });
        lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
        continue;
      }

      const requiredDanceCredits = providerQuote !== null ? providerQuote : consumerDanceMinBalance(env);
      if (balanceCheck.credits !== null && balanceCheck.credits < requiredDanceCredits) {
        sawBalanceExhausted = true;
        const lowErr = providerQuote !== null
          ? `Saldo Freebeat (${balanceCheck.credits} kredit) kurang dari biaya quote (${providerQuote} kredit)`
          : `Saldo Freebeat (${balanceCheck.credits} kredit) belum mencukupi minimal dance video (${requiredDanceCredits} kredit)`;
        await recordPoolAccountOutcome(env, account, {
          success: false,
          error: lowErr,
          balanceCredits: balanceCheck.credits,
          balancePayload: balanceCheck.payload,
        });
        lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
        continue;
      }

      if (!spentState) {
        const genId = crypto.randomUUID();
        const spent = await dbRpc(env, 'spend_credits', {
          p_user_id: user.id,
          p_amount: price,
          p_description: 'Generasi video freebeat model generate_dance_video',
          p_generation_id: genId,
        });
        if (!spent) {
          const err = fail(`Kredit BLEA tidak cukup untuk generasi ini (butuh ${price} kredit).`, 402);
          err.code = 'insufficient_credits';
          err.credits_required = price;
          throw err;
        }

        const metadata = {
          mode: 'dance_video',
          music_id: String(musicId),
          ...(input.imageUrls.length ? { image_urls: input.imageUrls } : {}),
          accept_unknown_cost: acceptUnknownCost,
          ...(maxCredits !== null ? { max_credits: maxCredits } : {}),
          ...(providerQuote !== null ? { provider_quote: providerQuote } : {}),
          ...(input.startMs !== undefined ? { start_ms: input.startMs, end_ms: input.endMs } : {}),
          ...(account.id ? { freebeat_account_id: account.id } : {}),
          ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
        };

        const insertBody = {
          id: genId,
          user_id: user.id,
          provider: 'freebeat',
          model: 'generate_dance_video',
          prompt: input.prompt,
          aspect_ratio: input.aspectRatio,
          resolution: '720p',
          duration: 15,
          generate_audio: true,
          image_url: input.imageUrls[0] || null,
          video_url: null,
          audio_url: input.audioUrl,
          external_job_id: null,
          polling_url: null,
          credits_charged: price,
          credits_refunded: 0,
          status: 'queued',
          progress: 5,
          metadata,
        };

        let inserted = null;
        try {
          inserted = await dbJson(env, '/video_generations', { method: 'POST', prefer: 'return=representation', body: insertBody });
        } catch { inserted = null; }
        if (!Array.isArray(inserted) || inserted.length !== 1) {
          try { await dbRpc(env, 'refund_credits', { p_user_id: user.id, p_amount: price, p_description: 'Refund: riwayat dance video tidak tersimpan', p_generation_id: genId }); } catch { /* manual review */ }
          throw fail('Riwayat generasi dance tidak dapat disimpan; kredit BLEA dikembalikan.', 503);
        }
        spentState = { genId, row: inserted[0], metadata };
      }

      const dispatchArgs = {
        ...danceParams,
        ...(acceptUnknownCost ? { accept_unknown_cost: true } : { max_credits: maxCredits }),
      };

      const activeMeta = {
        ...spentState.metadata,
        music_id: String(musicId),
        accept_unknown_cost: acceptUnknownCost,
        ...(maxCredits !== null ? { max_credits: maxCredits } : {}),
        ...(providerQuote !== null ? { provider_quote: providerQuote } : {}),
        ...(account.id ? { freebeat_account_id: account.id } : {}),
        ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
      };

      let content = null;
      let rejectedReason = null;
      try {
        const { result } = await rpc(opened.session.accessToken, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'generate_dance_video', arguments: dispatchArgs },
        }, 'generate', opened.headers, 262144, true);

        if (result?.isError || result?.error) {
          if (isFreebeatBalanceExhausted(result)) {
            sawBalanceExhausted = true;
            await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat generate dance video' });
            lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            continue;
          }
          rejectedReason = 'rejected';
          throw new Error('rejected');
        }
        content = modelContent(result);
        if (content && isFreebeatBalanceExhausted(content) && !content.task_id) {
          sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat generate dance video' });
          lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
          continue;
        }
        if (!content || typeof content !== 'object') throw new Error('invalid');
      } catch (err) {
        if (!rejectedReason && isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis saat generate dance video' : (err?.message || 'Gagal generate dance video'),
          });
          lastFailoverError = err;
          continue;
        }
        await recordPoolAccountOutcome(env, account, { success: false, error: 'Freebeat menolak permintaan dance video' });
        const fullMsg = await refundDanceSpend(
          'Refund: Freebeat generate_dance_video gagal dikirim',
          'Permintaan dance video gagal dikirim ke Freebeat.',
          502,
        );
        throw fail(fullMsg, 502);
      }

      if (content.success === true && content.status === 'preparing' && content.music_id !== undefined && content.music_id !== null && !content.task_id) {
        const prepMeta = { ...activeMeta, preparing_music_id: String(content.music_id), retry_after_seconds: Number(content.retry_after_seconds) || 10 };
        const prepRows = await dbJson(env, `/video_generations?id=eq.${encodeURIComponent(spentState.genId)}`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: { status: 'queued', progress: 5, metadata: prepMeta },
        }).catch(() => null);
        await recordPoolAccountOutcome(env, account, { success: true });
        return { credits: price, row: prepRows?.[0] || { ...spentState.row, status: 'queued', progress: 5, metadata: prepMeta } };
      }

      const taskId = typeof content.task_id === 'string' && TASK_ID.test(content.task_id) ? content.task_id : null;
      if (!taskId) {
        await recordPoolAccountOutcome(env, account, { success: false, error: 'ID tugas dance video tidak valid' });
        const fullMsg = await refundDanceSpend(
          'Refund: ID tugas dance video tidak diterima dari Freebeat',
          'Freebeat tidak mengembalikan ID tugas yang valid.',
          502,
        );
        throw fail(fullMsg, 502);
      }

      const sessionUrl = safeImageUrl(content.session_url);
      const submittedPatch = {
        external_job_id: taskId,
        polling_url: sessionUrl || null,
        status: 'in_progress',
        progress: 10,
        metadata: activeMeta,
      };
      const updated = await dbJson(env, `/video_generations?id=eq.${encodeURIComponent(spentState.genId)}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: submittedPatch,
      }).catch(() => null);
      await recordPoolAccountOutcome(env, account, { success: true });
      return { credits: price, row: updated?.[0] || { ...spentState.row, ...submittedPatch } };
    }
  }

  const finalErrorMsg = await refundDanceSpend(
    sawBalanceExhausted ? 'Refund: saldo gateway Freebeat habis setelah 3 putaran' : 'Refund: semua akun Freebeat gagal memproses dance video',
    sawBalanceExhausted ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE : (lastFailoverError?.message || 'Semua akun Freebeat gagal memulai generasi dance video.'),
    sawBalanceExhausted ? 503 : 502,
  );
  if (sawBalanceExhausted) {
    const err = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
    err.code = 'gateway_balance_exhausted';
    throw err;
  }
  throw fail(finalErrorMsg, lastFailoverError?.status || 502);
}

// ===================== Generasi Freebeat Singing & Lip-Sync Video (konsumen) =====================
function consumerVocalCeiling(env) {
  const raw = env?.FREEBEAT_VOCAL_MAX_PROVIDER_CREDITS ?? env?.FREEBEAT_DANCE_MAX_PROVIDER_CREDITS;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 100 && n <= 100000 ? n : 2000;
}
function consumerVocalMinBalance(env) {
  const raw = env?.FREEBEAT_VOCAL_MIN_CREDITS;
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100000) return n;
  }
  return 100;
}

export async function consumerFreebeatVideoConfigs(env) {
  let ready = false;
  try {
    const session = await loadProviderSession(env);
    ready = Boolean(session?.imageAccess);
  } catch { ready = false; }
  const readPrice = async (model) => {
    try { return await consumerImagePrice(env, model, 'video'); } catch { return null; }
  };
  const [danceCredits, singingCredits, lipSyncCredits] = await Promise.all([
    readPrice('generate_dance_video'),
    readPrice('generate_singing_video'),
    readPrice('generate_lip_sync_video'),
  ]);
  const liveModes = Array.isArray(cachedVocalSchemaMeta?.singingModes) && cachedVocalSchemaMeta.singingModes.length > 0
    ? cachedVocalSchemaMeta.singingModes
    : ['auto', 'duet'];
  return {
    provider_ready: ready,
    generate_dance_video: { model: 'generate_dance_video', credits: danceCredits, provider_ready: ready },
    generate_singing_video: {
      model: 'generate_singing_video',
      credits: singingCredits,
      provider_ready: ready,
      singingModes: liveModes,
      maxImages: cachedVocalSchemaMeta?.singingMaxImages || 5,
    },
    generate_lip_sync_video: { model: 'generate_lip_sync_video', credits: lipSyncCredits, provider_ready: ready },
  };
}

function isFreebeatHostedMediaUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'freebeat.ai' || host.endsWith('.freebeat.ai') || host === 'freebeatfit.com' || host.endsWith('.freebeatfit.com');
  } catch { return false; }
}

function validateConsumerVocalPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw fail('Permintaan video vokal/lip-sync tidak valid.', 400);
  }
  const tool = String(payload.model || '').trim();
  if (!VOCAL_TOOLS_ALLOWED.has(tool)) {
    throw fail('Model video Freebeat tidak didukung. Pilih generate_singing_video atau generate_lip_sync_video.', 400);
  }
  const audioUrl = consumerImageUrl(typeof payload.audio_url === 'string' ? payload.audio_url : '');
  if (!audioUrl) {
    throw fail('Unggah file audio / lagu atau masukkan URL musik HTTPS publik yang valid.', 400);
  }
  const removeWatermark = payload.remove_watermark === true;

  if (tool === 'generate_singing_video') {
    const rawRefs = Array.isArray(payload.reference_images) && payload.reference_images.length > 0
      ? payload.reference_images
      : (Array.isArray(payload.image_urls) && payload.image_urls.length > 0
        ? payload.image_urls
        : (typeof payload.image_url === 'string' && payload.image_url.trim() ? [payload.image_url] : []));
    if (rawRefs.length === 0) {
      throw fail('Singing Video wajib menyertakan minimal 1 foto karakter/penyanyi.', 400);
    }
    if (rawRefs.length > 5) throw fail('Maksimal 5 foto penyanyi.', 400);
    const imageUrls = rawRefs.map((raw) => {
      const safe = consumerImageUrl(typeof raw === 'string' ? raw : '');
      if (!safe) throw fail('Setiap foto penyanyi harus berupa URL HTTPS publik yang valid.', 400);
      return safe;
    });
    const rawDuration = payload.duration_seconds ?? payload.duration ?? 15;
    const durationSeconds = Number(rawDuration);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) {
      throw fail('Durasi singing video harus antara 1 dan 600 detik.', 400);
    }
    const rawRatio = typeof payload.aspect_ratio === 'string' ? payload.aspect_ratio.trim() : '';
    const aspectRatio = SINGING_RATIOS.has(rawRatio) ? rawRatio : '9:16';
    const rawMode = payload.singing_mode ?? payload.mode ?? 'auto';
    if (typeof rawMode !== 'string' || (rawMode.trim() && !/^[A-Za-z0-9_-]{1,64}$/.test(rawMode.trim()))) {
      throw fail('Mode bernyanyi tidak valid.', 400);
    }
    const prompt = typeof (payload.scene_prompt ?? payload.prompt) === 'string'
      ? String(payload.scene_prompt ?? payload.prompt).trim()
      : '';
    if (prompt.length > 2000) throw fail('Prompt maksimal 2000 karakter.', 400);

    let audioStartSeconds;
    if (payload.audio_start_seconds !== undefined && payload.audio_start_seconds !== null && payload.audio_start_seconds !== '') {
      const startSec = Number(payload.audio_start_seconds);
      if (!Number.isFinite(startSec) || startSec < 0 || startSec > 600) {
        throw fail('audio_start_seconds tidak valid (0–600 detik).', 400);
      }
      audioStartSeconds = startSec;
    }

    return {
      tool,
      audioUrl,
      imageUrls,
      durationSeconds,
      aspectRatio,
      requestedMode: rawMode.trim(),
      prompt,
      audioStartSeconds,
      removeWatermark,
    };
  }

  // generate_lip_sync_video
  const videoUrl = consumerImageUrl(typeof payload.video_url === 'string' ? payload.video_url : '');
  if (!videoUrl) {
    throw fail('Lip-Sync Video wajib menyertakan file video atau URL video HTTPS publik yang valid.', 400);
  }
  const videoDurationMsExplicit = payload.video_duration_ms !== undefined
    && payload.video_duration_ms !== null
    && payload.video_duration_ms !== '';
  const rawVideoDurMs = videoDurationMsExplicit
    ? Number(payload.video_duration_ms)
    : Math.round(Number(payload.duration || 5) * 1000);
  if (!Number.isSafeInteger(rawVideoDurMs) || rawVideoDurMs <= 0 || rawVideoDurMs > 600000) {
    throw fail('Durasi video lip-sync (video_duration_ms) harus antara 1 ms dan 600000 ms.', 400);
  }
  let audioDurationMs;
  if (payload.audio_duration_ms !== undefined && payload.audio_duration_ms !== null && payload.audio_duration_ms !== '') {
    const audMs = Number(payload.audio_duration_ms);
    if (!Number.isSafeInteger(audMs) || audMs <= 0 || audMs > 600000) {
      throw fail('audio_duration_ms tidak valid (1–600000 ms).', 400);
    }
    audioDurationMs = audMs;
  }
  const prompt = typeof (payload.name ?? payload.prompt) === 'string'
    ? String(payload.name ?? payload.prompt).trim().slice(0, 200)
    : '';
  return {
    tool,
    videoUrl,
    audioUrl,
    videoDurationMs: rawVideoDurMs,
    videoDurationMsExplicit,
    audioDurationMs,
    prompt,
    removeWatermark,
  };
}

// Consumer diagnostics contain only fixed categories, numeric protocol codes,
// and allowlisted provider reasons. Never persist/echo provider prose, URLs,
// credentials, or arbitrary object keys, even after best-effort redaction.
function vocalDispatchFailure(value, kind = 'tool_rejected') {
  const kinds = new Set(['tool_rejected', 'http', 'timeout', 'network', 'redirect', 'rpc', 'size', 'response', 'missing_task_id']);
  const safeKind = kinds.has(kind) ? kind : 'response';
  const reasons = new Set([...VIDEO_FAILURE_REASONS, 'invalid_audio', 'invalid_video', 'audio_download_failed', 'video_download_failed', 'audio_not_ready']);
  const content = value && typeof value === 'object' ? modelContent(value) : null;
  const candidates = [content?.failure?.reason, content?.error_code, content?.code, value?.error?.code, value?.error?.data?.reason];
  const reason = candidates.find((item) => typeof item === 'string' && reasons.has(item.toLowerCase()))?.toLowerCase();
  const httpStatus = Number.isInteger(value?.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599 ? value.httpStatus : null;
  const rpcCode = Number.isSafeInteger(value?.error?.code) ? value.error.code : null;
  const diagnostic = {
    kind: safeKind,
    ...(httpStatus !== null ? { http_status: httpStatus } : {}),
    ...(rpcCode !== null ? { rpc_code: rpcCode } : {}),
    ...(reason ? { reason } : {}),
  };
  const tag = `FB-VOCAL-${safeKind.toUpperCase().replaceAll('_', '-')}`;
  const detail = httpStatus !== null ? `HTTP ${httpStatus}` : rpcCode !== null ? `RPC ${rpcCode}` : null;
  return { diagnostic, message: `[${tag}${detail ? `; ${detail}` : ''}${reason ? `; ${reason}` : ''}]` };
}

export async function consumerVocalGenerate(env, user, payload) {
  const input = validateConsumerVocalPayload(payload);
  await assertAccountActive(env, user.id);

  const label = input.tool === 'generate_singing_video' ? 'singing video' : 'lip-sync video';
  const price = await consumerImagePrice(env, input.tool, 'video');
  if (price === null) {
    const err = fail(`Harga kredit untuk model video "${input.tool}" (freebeat) belum diatur admin. Atur dulu di Admin → API Key → Katalog Model.`, 409);
    err.code = 'video_price_missing';
    throw err;
  }

  const pool = await loadFreebeatAccountPool(env);
  if (!pool.length) {
    throw fail(`Provider Freebeat (${label}) belum siap (admin belum menghubungkan Freebeat dengan izin generasi). Coba lagi nanti.`, 503);
  }

  const retryDelayMs = poolRetryDelayMs(env);
  let spentState = null;
  let sawBalanceExhausted = false;
  let lastFailoverError = null;

  const refundVocalSpend = async (reason, errorMessage, statusCode = 502, dispatchFailure = null) => {
    if (!spentState) return errorMessage;
    const refunded = await dbRpc(env, 'refund_credits', {
      p_user_id: user.id,
      p_amount: price,
      p_description: reason,
      p_generation_id: spentState.genId,
    }).catch(() => false);
    const fullMsg = statusCode === 503 && sawBalanceExhausted
      ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE
      : `${errorMessage}${refunded && !errorMessage.includes('Kredit BLEA dikembalikan') ? ' Kredit BLEA dikembalikan.' : ''}`;
    const failedPatch = {
      status: 'failed',
      progress: 0,
      error_message: fullMsg,
      ...(refunded ? { credits_refunded: price } : {}),
      ...(dispatchFailure ? { metadata: { ...spentState.metadata, dispatch_failure: dispatchFailure } } : {}),
    };
    await dbFetch(env, `/video_generations?id=eq.${encodeURIComponent(spentState.genId)}`, { method: 'PATCH', body: failedPatch }).catch(() => {});
    return fullMsg;
  };

  for (let cycle = 1; cycle <= FREEBEAT_POOL_MAX_CYCLES; cycle += 1) {
    if (cycle > 1) await sleepCycleDelay(retryDelayMs);
    for (const rawAccount of pool) {
      const account = await ensureUsablePoolAccount(env, rawAccount);
      if (!account) {
        await recordPoolAccountOutcome(env, rawAccount, { success: false, error: 'Token OAuth kedaluwarsa atau belum memiliki izin generasi' });
        lastFailoverError = fail('Token OAuth Freebeat kedaluwarsa.', 401);
        continue;
      }

      let opened;
      let balanceCheck = { credits: null, payload: null };
      let musicId = null;
      let effectiveVideoUrl = input.videoUrl || null;
      let effectiveVideoDurationMs = input.videoDurationMs;
      let resolvedMode = input.requestedMode || null;
      let schemaMeta = cachedVocalSchemaMeta;

      try {
        opened = await openMcpSessionForAccount(env, account);
        if (account.id) {
          balanceCheck = await readMcpAccountBalance(opened.session.accessToken, opened.headers);
          if (balanceCheck.credits !== null && balanceCheck.credits <= 0) {
            sawBalanceExhausted = true;
            await recordPoolAccountOutcome(env, account, {
              success: false,
              error: 'Saldo Freebeat habis (0 kredit)',
              balanceCredits: balanceCheck.credits,
              balancePayload: balanceCheck.payload,
            });
            lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            continue;
          }
        }

        if (input.tool === 'generate_singing_video') {
          if (!resolvedMode || resolvedMode.toLowerCase() !== 'duet' || !schemaMeta?.singingModes?.length) {
            schemaMeta = await discoverVocalToolSchemaMeta(opened.session.accessToken, opened.headers);
          }
          resolvedMode = resolveSingingMode(input.requestedMode, schemaMeta, input.imageUrls.length);
          if (typeof schemaMeta?.singingMinDuration === 'number' && input.durationSeconds < schemaMeta.singingMinDuration) {
            throw fail(`duration_seconds minimal ${schemaMeta.singingMinDuration} detik sesuai skema Freebeat.`, 400);
          }
          if (typeof schemaMeta?.singingMaxDuration === 'number' && input.durationSeconds > schemaMeta.singingMaxDuration) {
            throw fail(`duration_seconds maksimal ${schemaMeta.singingMaxDuration} detik sesuai skema Freebeat.`, 400);
          }
        } else {
          if (!isFreebeatHostedMediaUrl(effectiveVideoUrl)) {
            const uploadedVideo = await vocalUploadVideo(opened.session.accessToken, { video_url: effectiveVideoUrl }, opened.headers, true);
            effectiveVideoUrl = uploadedVideo.video_url || effectiveVideoUrl;
            if (!input.videoDurationMsExplicit && Number.isSafeInteger(uploadedVideo.duration_ms) && uploadedVideo.duration_ms > 0) {
              effectiveVideoDurationMs = uploadedVideo.duration_ms;
            }
          }
        }

        const { result: upRes } = await rpc(opened.session.accessToken, {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'upload_audio', arguments: { url: input.audioUrl } },
        }, 'upload', opened.headers, 262144, true);

        if (upRes?.isError || upRes?.error) {
          if (isFreebeatBalanceExhausted(upRes)) {
            sawBalanceExhausted = true;
            await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat upload audio' });
            lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            continue;
          }
          throw fail('Audio / tautan lagu tidak dapat diproses oleh Freebeat.', 502);
        }
        const upContent = modelContent(upRes);
        const rawId = upContent?.music_id ?? upContent?.musicId ?? upContent?.id;
        if (rawId !== undefined && rawId !== null && /^\d{1,15}$/.test(String(rawId).trim())) {
          musicId = Number(String(rawId).trim());
        }
      } catch (err) {
        if (err?.status === 400 && !spentState) throw err;
        if (err?.status !== 400 && isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis' : (err?.message || 'Gagal menghubungi akun Freebeat'),
          });
          lastFailoverError = err;
          continue;
        }
        if (spentState) {
          const fullMsg = await refundVocalSpend(`Refund: persiapan ${label} ditolak`, err?.message || `Gagal memproses media ${label}.`, err?.status || 502);
          throw fail(fullMsg, err?.status || 502);
        }
        throw err;
      }

      const toolParams = input.tool === 'generate_singing_video'
        ? {
            mode: resolvedMode,
            image_urls: input.imageUrls,
            duration_seconds: input.durationSeconds,
            aspect_ratio: input.aspectRatio,
            ...(musicId !== null ? { music_id: musicId } : { audio_url: input.audioUrl }),
            ...(input.audioStartSeconds !== undefined ? { audio_start_seconds: input.audioStartSeconds } : {}),
            ...(input.prompt ? { scene_prompt: input.prompt } : {}),
            ...(input.removeWatermark ? { remove_watermark: true } : {}),
          }
        : {
            video_url: effectiveVideoUrl,
            video_duration_ms: effectiveVideoDurationMs,
            ...(musicId !== null ? { music_id: musicId } : { audio_url: input.audioUrl }),
            ...(input.audioDurationMs !== undefined ? { audio_duration_ms: input.audioDurationMs } : {}),
            ...(input.prompt ? { name: input.prompt } : {}),
            ...(input.removeWatermark ? { remove_watermark: true } : {}),
          };

      let acceptUnknownCost = true;
      let maxCredits = null;
      let providerQuote = null;
      let quoteBalanceExhausted = false;
      try {
        const quoteContent = await rawToolQuote(opened.session.accessToken, input.tool, toolParams, opened.headers, true);
        if (isFreebeatBalanceExhausted(quoteContent)) {
          quoteBalanceExhausted = true;
        } else {
          providerQuote = quotedCredits(quoteContent);
          if (providerQuote !== null) {
            const ceiling = consumerVocalCeiling(env);
            if (providerQuote > ceiling) {
              const err = fail(`Biaya provider (${providerQuote} kredit Freebeat) melebihi plafon layanan (${ceiling}); generasi tidak dikirim.`, 409);
              if (spentState) await refundVocalSpend(`Refund: biaya provider ${label} melebihi plafon`, err.message, 409);
              throw err;
            }
            acceptUnknownCost = false;
            maxCredits = providerQuote + videoHeadroom(providerQuote);
          }
        }
      } catch (err) {
        if (err?.status === 409) throw err;
        if (isAccountFailoverError(err)) {
          quoteBalanceExhausted = isFreebeatBalanceExhausted(err);
          if (!quoteBalanceExhausted) {
            await recordPoolAccountOutcome(env, account, { success: false, error: err?.message || 'Gagal menghubungi akun Freebeat' });
            lastFailoverError = err;
            continue;
          }
        }
      }

      if (quoteBalanceExhausted) {
        sawBalanceExhausted = true;
        await recordPoolAccountOutcome(env, account, {
          success: false,
          error: 'Saldo Freebeat habis (quote)',
          ...(balanceCheck.credits !== null ? { balanceCredits: balanceCheck.credits, balancePayload: balanceCheck.payload } : {}),
        });
        lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
        continue;
      }

      const requiredCredits = providerQuote !== null ? providerQuote : consumerVocalMinBalance(env);
      if (balanceCheck.credits !== null && balanceCheck.credits < requiredCredits) {
        sawBalanceExhausted = true;
        const lowErr = providerQuote !== null
          ? `Saldo Freebeat (${balanceCheck.credits} kredit) kurang dari biaya quote (${providerQuote} kredit)`
          : `Saldo Freebeat (${balanceCheck.credits} kredit) belum mencukupi minimal ${label} (${requiredCredits} kredit)`;
        await recordPoolAccountOutcome(env, account, {
          success: false,
          error: lowErr,
          balanceCredits: balanceCheck.credits,
          balancePayload: balanceCheck.payload,
        });
        lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
        continue;
      }

      if (!spentState) {
        const genId = crypto.randomUUID();
        const spent = await dbRpc(env, 'spend_credits', {
          p_user_id: user.id,
          p_amount: price,
          p_description: `Generasi video freebeat model ${input.tool}`,
          p_generation_id: genId,
        });
        if (!spent) {
          const err = fail(`Kredit BLEA tidak cukup untuk generasi ini (butuh ${price} kredit).`, 402);
          err.code = 'insufficient_credits';
          err.credits_required = price;
          throw err;
        }

        const rawDurationSec = input.tool === 'generate_singing_video'
          ? input.durationSeconds
          : (effectiveVideoDurationMs / 1000);
        const clampedDbDuration = Math.max(1, Math.min(120, Math.round(rawDurationSec)));

        const metadata = {
          mode: input.tool === 'generate_singing_video' ? 'singing_video' : 'lip_sync_video',
          vocal_tool: input.tool,
          dispatch_parameters: toolParams,
          ...(musicId !== null ? { music_id: String(musicId) } : {}),
          accept_unknown_cost: acceptUnknownCost,
          ...(maxCredits !== null ? { max_credits: maxCredits } : {}),
          ...(providerQuote !== null ? { provider_quote: providerQuote } : {}),
          ...(account.id ? { freebeat_account_id: account.id } : {}),
          ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
        };

        const insertBody = {
          id: genId,
          user_id: user.id,
          provider: 'freebeat',
          model: input.tool,
          prompt: input.prompt || '',
          aspect_ratio: input.tool === 'generate_singing_video' ? input.aspectRatio : '16:9',
          resolution: '720p',
          duration: clampedDbDuration,
          generate_audio: true,
          image_url: input.tool === 'generate_singing_video' ? (input.imageUrls[0] || null) : null,
          video_url: input.tool === 'generate_lip_sync_video' ? effectiveVideoUrl : null,
          audio_url: input.audioUrl,
          external_job_id: null,
          polling_url: null,
          credits_charged: price,
          credits_refunded: 0,
          status: 'queued',
          progress: 5,
          metadata,
        };

        let inserted = null;
        try {
          inserted = await dbJson(env, '/video_generations', { method: 'POST', prefer: 'return=representation', body: insertBody });
        } catch { inserted = null; }
        if (!Array.isArray(inserted) || inserted.length !== 1) {
          try { await dbRpc(env, 'refund_credits', { p_user_id: user.id, p_amount: price, p_description: `Refund: riwayat ${label} tidak tersimpan`, p_generation_id: genId }); } catch { /* manual review */ }
          throw fail(`Riwayat generasi ${label} tidak dapat disimpan; kredit BLEA dikembalikan.`, 503);
        }
        spentState = { genId, row: inserted[0], metadata };
      }

      const dispatchArgs = {
        ...toolParams,
        ...(acceptUnknownCost ? { accept_unknown_cost: true } : { max_credits: maxCredits }),
      };

      const activeMeta = {
        ...spentState.metadata,
        dispatch_parameters: toolParams,
        ...(musicId !== null ? { music_id: String(musicId) } : {}),
        accept_unknown_cost: acceptUnknownCost,
        ...(maxCredits !== null ? { max_credits: maxCredits } : {}),
        ...(providerQuote !== null ? { provider_quote: providerQuote } : {}),
        ...(account.id ? { freebeat_account_id: account.id } : {}),
        ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
      };

      let content = null;
      let rejectedReason = null;
      let dispatchFailure = null;
      try {
        const { result } = await rpc(opened.session.accessToken, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: input.tool, arguments: dispatchArgs },
        }, 'generate', opened.headers, 262144, true);

        if (result?.isError || result?.error) {
          if (isFreebeatBalanceExhausted(result)) {
            sawBalanceExhausted = true;
            await recordPoolAccountOutcome(env, account, { success: false, error: `Saldo Freebeat habis saat generate ${label}` });
            lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            continue;
          }
          rejectedReason = 'rejected';
          dispatchFailure = vocalDispatchFailure(result);
          throw new Error('rejected');
        }
        content = modelContent(result);
        if (content && isFreebeatBalanceExhausted(content) && !content.task_id) {
          sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, { success: false, error: `Saldo Freebeat habis saat generate ${label}` });
          lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
          continue;
        }
        if (!content || typeof content !== 'object') throw new Error('invalid');
      } catch (err) {
        if (!rejectedReason && isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? `Saldo Freebeat habis saat generate ${label}` : (err?.message || `Gagal generate ${label}`),
          });
          lastFailoverError = err;
          continue;
        }
        dispatchFailure ||= vocalDispatchFailure(err, err?.freebeatKind || 'response');
        spentState.metadata = activeMeta;
        await recordPoolAccountOutcome(env, account, { success: false, error: `Pengiriman ${label} gagal ${dispatchFailure.message}` });
        const fullMsg = await refundVocalSpend(
          `Refund: Freebeat ${input.tool} gagal dikirim`,
          `Permintaan ${label} gagal dikirim ke Freebeat. ${dispatchFailure.message}`,
          502,
          dispatchFailure.diagnostic,
        );
        throw fail(fullMsg, 502);
      }

      if (content.success === true && content.status === 'preparing' && content.music_id !== undefined && content.music_id !== null && !content.task_id) {
        const prepMeta = { ...activeMeta, preparing_music_id: String(content.music_id), retry_after_seconds: Number(content.retry_after_seconds) || 10 };
        const prepRows = await dbJson(env, `/video_generations?id=eq.${encodeURIComponent(spentState.genId)}`, {
          method: 'PATCH',
          prefer: 'return=representation',
          body: { status: 'queued', progress: 5, metadata: prepMeta },
        }).catch(() => null);
        await recordPoolAccountOutcome(env, account, { success: true });
        return { credits: price, row: prepRows?.[0] || { ...spentState.row, status: 'queued', progress: 5, metadata: prepMeta } };
      }

      const taskId = typeof content.task_id === 'string' && TASK_ID.test(content.task_id) ? content.task_id : null;
      if (!taskId) {
        await recordPoolAccountOutcome(env, account, { success: false, error: `ID tugas ${label} tidak valid` });
        const missingTask = vocalDispatchFailure(null, 'missing_task_id');
        spentState.metadata = activeMeta;
        const fullMsg = await refundVocalSpend(
          `Refund: ID tugas ${label} tidak diterima dari Freebeat`,
          `Freebeat tidak mengembalikan ID tugas yang valid. ${missingTask.message}`,
          502,
          missingTask.diagnostic,
        );
        throw fail(fullMsg, 502);
      }

      const sessionUrl = safeImageUrl(content.session_url);
      const updatedRows = await dbJson(env, `/video_generations?id=eq.${encodeURIComponent(spentState.genId)}`, {
        method: 'PATCH',
        prefer: 'return=representation',
        body: {
          external_job_id: taskId,
          polling_url: sessionUrl,
          status: 'in_progress',
          progress: 10,
          metadata: activeMeta,
        },
      }).catch(() => null);

      await recordPoolAccountOutcome(env, account, { success: true });
      return {
        credits: price,
        row: updatedRows?.[0] || {
          ...spentState.row,
          external_job_id: taskId,
          polling_url: sessionUrl,
          status: 'in_progress',
          progress: 10,
          metadata: activeMeta,
        },
      };
    }
  }

  const finalErrorMsg = await refundVocalSpend(
    `Refund: semua akun Freebeat gagal untuk ${label}`,
    sawBalanceExhausted
      ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE
      : (lastFailoverError?.message || `Semua akun Freebeat tidak tersedia atau gagal memproses ${label}.`),
    sawBalanceExhausted ? 503 : (lastFailoverError?.status || 502),
  );
  if (sawBalanceExhausted) {
    const err = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
    err.code = 'gateway_balance_exhausted';
    throw err;
  }
  throw fail(finalErrorMsg, lastFailoverError?.status || 502);
}

export async function consumerDanceStatus(env, row) {
  const preferredAccountId = row?.metadata?.freebeat_account_id || null;
  const usable = await loadPreferredAccountSession(env, preferredAccountId);
  if (!usable?.session?.imageAccess) {
    return {
      nextStatus: row.status,
      nextProgress: Number(row.progress || 0),
      upstreamUrl: row.upstream_result_url || null,
      errMsg: row.error_message || null,
      pollWarning: 'Sesi Freebeat tidak tersedia sementara.',
    };
  }
  const opened = await openMcpSessionForAccount(env, usable);
  const session = opened.session;
  const headers = opened.headers;
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? { ...row.metadata } : {};
  const videoKindLabel = row?.model === 'generate_singing_video'
    ? 'singing video'
    : row?.model === 'generate_lip_sync_video'
      ? 'lip-sync video'
      : 'dance video';

  if (meta.preparing_music_id && !row.external_job_id) {
    const vocalTool = VOCAL_TOOLS_ALLOWED.has(meta.vocal_tool)
      ? meta.vocal_tool
      : (VOCAL_TOOLS_ALLOWED.has(row?.model) ? row.model : null);
    const prepTool = vocalTool || 'generate_dance_video';
    let args;
    if (vocalTool) {
      const baseParams = meta.dispatch_parameters && typeof meta.dispatch_parameters === 'object' && !Array.isArray(meta.dispatch_parameters)
        ? { ...meta.dispatch_parameters }
        : {};
      const musicIdInt = /^\d{1,15}$/.test(String(meta.preparing_music_id).trim())
        ? Number(String(meta.preparing_music_id).trim())
        : null;
      args = {
        ...baseParams,
        ...(musicIdInt !== null ? { music_id: musicIdInt } : {}),
        ...(meta.accept_unknown_cost !== false ? { accept_unknown_cost: true } : { max_credits: meta.max_credits }),
      };
    } else {
      args = {
        music_id: normalizeDanceMusicId(meta.preparing_music_id),
        auto_mode: true,
        aspect_ratio: DANCE_RATIOS.has(row.aspect_ratio) ? row.aspect_ratio : '9:16',
        ...(row.prompt ? { prompt: row.prompt } : {}),
        ...(Array.isArray(meta.image_urls) && meta.image_urls.length ? { image_urls: meta.image_urls } : {}),
        ...(meta.start_ms !== undefined ? { start_ms: meta.start_ms, end_ms: meta.end_ms } : {}),
        ...(meta.accept_unknown_cost !== false ? { accept_unknown_cost: true } : { max_credits: meta.max_credits }),
      };
    }
    try {
      const { result } = await rpc(session.accessToken, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: prepTool, arguments: args },
      }, 'generate', headers, 262144, true);
      if (result?.isError || isFreebeatBalanceExhausted(result)) {
        const exhausted = isFreebeatBalanceExhausted(result);
        if (exhausted && usable?.id) {
          await recordPoolAccountOutcome(env, usable, { success: false, error: `Saldo Freebeat habis saat persiapan ${videoKindLabel}` });
        }
        return {
          nextStatus: 'failed',
          nextProgress: 0,
          upstreamUrl: null,
          errMsg: exhausted ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE : `Persiapan audio ${videoKindLabel} ditolak oleh Freebeat.`,
          ...(exhausted ? { metadata: { ...meta, agent_status: 'insufficient_credits', stopped_reason: 'balance_exhausted' } } : {}),
        };
      }
      const prepContent = modelContent(result);
      if (prepContent && isFreebeatBalanceExhausted(prepContent) && !prepContent?.task_id) {
        if (usable?.id) {
          await recordPoolAccountOutcome(env, usable, { success: false, error: `Saldo Freebeat habis saat persiapan ${videoKindLabel}` });
        }
        return {
          nextStatus: 'failed',
          nextProgress: 0,
          upstreamUrl: null,
          errMsg: FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE,
          metadata: { ...meta, agent_status: 'insufficient_credits', stopped_reason: 'balance_exhausted' },
        };
      }
      if (prepContent?.status === 'preparing' && !prepContent?.task_id) {
        return { nextStatus: 'queued', nextProgress: 5, upstreamUrl: null, errMsg: null };
      }
      const taskId = typeof prepContent?.task_id === 'string' && TASK_ID.test(prepContent.task_id) ? prepContent.task_id : null;
      if (!taskId) {
        return { nextStatus: 'failed', nextProgress: 0, upstreamUrl: null, errMsg: `ID tugas ${videoKindLabel} tidak tersedia setelah persiapan audio.` };
      }
      const nextMeta = { ...meta };
      delete nextMeta.preparing_music_id;
      return {
        nextStatus: 'in_progress',
        nextProgress: 10,
        upstreamUrl: null,
        errMsg: null,
        externalJobId: taskId,
        pollingUrl: safeImageUrl(prepContent.session_url) || row.polling_url || null,
        metadata: nextMeta,
      };
    } catch {
      return { nextStatus: 'queued', nextProgress: 5, upstreamUrl: null, errMsg: null, pollWarning: 'Menunggu persiapan audio selesai.' };
    }
  }

  if (typeof row.external_job_id !== 'string' || !TASK_ID.test(row.external_job_id)) {
    return { nextStatus: row.status, nextProgress: Number(row.progress || 0), upstreamUrl: row.upstream_result_url || null, errMsg: row.error_message || null };
  }

  const { result: statusRes } = await rpc(session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_task_status', arguments: { task_id: row.external_job_id } },
  }, 'task', headers, 262144);
  const statusContent = modelContent(statusRes);
  if (!statusContent || typeof statusContent !== 'object' || Array.isArray(statusContent)) {
    throw mcpFailure('task', 'response');
  }
  const summary = safeTask(statusContent);

  if (summary.status === 'completed') {
    let resultContent = statusContent;
    try {
      const { result: finalRes } = await rpc(session.accessToken, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_task_result', arguments: { task_id: row.external_job_id } },
      }, 'task', headers, 262144);
      const parsed = modelContent(finalRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resultContent = parsed;
    } catch { /* fallback to statusContent */ }

    if (String(resultContent?.status || '').toLowerCase() === 'running') {
      return { nextStatus: 'in_progress', nextProgress: 92, upstreamUrl: null, errMsg: null };
    }
    const videoUrl = safeImageUrl(
      resultContent?.result?.video_url
      || resultContent?.video_url
      || (Array.isArray(resultContent?.items) ? resultContent.items[0]?.video_url : null),
    );
    if (!videoUrl) {
      return { nextStatus: 'in_progress', nextProgress: 95, upstreamUrl: null, errMsg: null };
    }
    return {
      nextStatus: 'completed',
      nextProgress: 100,
      upstreamUrl: videoUrl,
      errMsg: null,
      metadata: { ...meta, provider_billing: safeTask(resultContent).billing },
    };
  }

  if (['failed', 'partial_failed', 'cancelled', 'expired'].includes(summary.status)) {
    let resultContent = statusContent;
    try {
      const { result: finalRes } = await rpc(session.accessToken, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_task_result', arguments: { task_id: row.external_job_id } },
      }, 'task', headers, 262144);
      const parsed = modelContent(finalRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resultContent = parsed;
    } catch { /* fallback to statusContent */ }
    const exhausted = isFreebeatBalanceExhausted(statusContent) || isFreebeatBalanceExhausted(resultContent);
    if (exhausted && usable?.id) {
      await recordPoolAccountOutcome(env, usable, { success: false, error: `Saldo Freebeat habis saat memproses ${videoKindLabel}` });
    }
    const failureInfo = safeVideoFailure(resultContent?.failure || statusContent?.failure);
    const reasonCode = Array.isArray(imageFailureReasons(resultContent)) && imageFailureReasons(resultContent)[0];
    const errMsg = exhausted
      ? `Saldo akun Freebeat tidak mencukupi saat memproses ${videoKindLabel}; proses gagal dan kredit BLEA dikembalikan.`
      : (reasonCode
        ? `Freebeat gagal memproses ${videoKindLabel} (${reasonCode}).`
        : (failureInfo?.stage && !failureInfo.stage_hidden ? `Freebeat gagal pada tahap ${failureInfo.stage}.` : `Freebeat melaporkan ${videoKindLabel} gagal dibuat.`));
    return {
      nextStatus: summary.status === 'cancelled' ? 'cancelled' : summary.status === 'expired' ? 'expired' : 'failed',
      nextProgress: 0,
      upstreamUrl: null,
      errMsg,
      metadata: {
        ...meta,
        agent_status: exhausted ? 'insufficient_credits' : summary.status,
        ...(exhausted ? { stopped_reason: 'balance_exhausted' } : {}),
        provider_billing: safeTask(resultContent).billing,
      },
    };
  }

  if (summary.status === 'action_required') {
    let insufficientCredits = isFreebeatBalanceExhausted(statusContent);
    let sessionContent = null;
    if (!insufficientCredits) {
      try {
        const { result: sessRes } = await rpc(session.accessToken, {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'get_video_session', arguments: { task_id: row.external_job_id } },
        }, 'task', headers, 262144);
        const parsed = modelContent(sessRes);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          sessionContent = parsed;
          if (isFreebeatBalanceExhausted(sessionContent)) insufficientCredits = true;
        }
      } catch { /* non-fatal: session inspection optional */ }
    }

    let resultContent = null;
    if (!insufficientCredits) {
      try {
        const { result: finalRes } = await rpc(session.accessToken, {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'get_task_result', arguments: { task_id: row.external_job_id } },
        }, 'task', headers, 262144);
        const parsed = modelContent(finalRes);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resultContent = parsed;
          if (isFreebeatBalanceExhausted(resultContent)) insufficientCredits = true;
        }
      } catch { /* non-fatal: task result optional during action_required */ }
    }

    let balanceCheck = { credits: null, payload: null };
    if (!insufficientCredits) {
      balanceCheck = await readMcpAccountBalance(session.accessToken, headers);
      if (balanceCheck.credits !== null) {
        if (balanceCheck.credits <= 0) {
          insufficientCredits = true;
        } else if (
          balanceCheck.credits < consumerDanceActionBalanceFloor(env)
          && sessionHasConfirmationPrompt(sessionContent || resultContent || statusContent)
        ) {
          insufficientCredits = true;
        }
      }
    }

    if (insufficientCredits) {
      if (usable?.id) {
        await recordPoolAccountOutcome(env, usable, {
          success: false,
          error: `Saldo Freebeat tidak mencukupi saat agen ${videoKindLabel} berjalan (action_required)`,
          ...(balanceCheck.credits !== null ? { balanceCredits: balanceCheck.credits, balancePayload: balanceCheck.payload } : {}),
        });
      }
      return {
        nextStatus: 'failed',
        nextProgress: 0,
        upstreamUrl: null,
        errMsg: `Saldo akun Freebeat tidak mencukupi saat memproses ${videoKindLabel}; proses dihentikan otomatis dan kredit BLEA dikembalikan.`,
        metadata: {
          ...meta,
          agent_status: 'insufficient_credits',
          stopped_reason: 'balance_exhausted',
          ...(balanceCheck.credits !== null ? { freebeat_balance_credits: balanceCheck.credits } : {}),
        },
      };
    }

    const nudgeCount = Number(meta.auto_nudge_count || (meta.auto_nudged ? 1 : 0));
    const rawLastNudge = meta.last_nudge_at;
    const parsedLastNudge = typeof rawLastNudge === 'number'
      ? rawLastNudge
      : (/^\d+$/.test(String(rawLastNudge || '')) ? Number(rawLastNudge) : Date.parse(String(rawLastNudge || '')));
    const lastNudgeAt = Number.isFinite(parsedLastNudge) ? parsedLastNudge : 0;

    if (nudgeCount >= 3 && lastNudgeAt > 0 && Date.now() - lastNudgeAt >= 60_000) {
      return {
        nextStatus: 'failed',
        nextProgress: 0,
        upstreamUrl: null,
        errMsg: 'Agen Freebeat menunggu konfirmasi terlalu lama setelah 3 percobaan otomatis. Proses dihentikan dan kredit BLEA dikembalikan.',
        metadata: {
          ...meta,
          agent_status: 'action_required_timeout',
          stopped_reason: 'nudge_limit_exceeded',
        },
      };
    }

    const canNudge = nudgeCount < 3 && (Date.now() - lastNudgeAt >= 30_000);
    if (canNudge) {
      try {
        await rpc(session.accessToken, {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'send_video_agent_message',
            arguments: {
              task_id: row.external_job_id,
              message: `Continue automatically and finish the ${videoKindLabel}. If credits are insufficient or cost exceeds remaining balance, stop immediately and report insufficient credits.`,
              auto_mode: true,
            },
          },
        }, 'task', headers, 262144);
        return {
          nextStatus: 'in_progress',
          nextProgress: Math.min(90, Math.max(20, Number(row.progress || 10) + 5)),
          upstreamUrl: null,
          errMsg: null,
          metadata: {
            ...meta,
            auto_nudged: true,
            auto_nudge_count: nudgeCount + 1,
            last_nudge_at: Date.now(),
            action_required_since: meta.action_required_since || Date.now(),
            agent_status: 'action_required',
          },
        };
      } catch { /* fall through */ }
    }
    return {
      nextStatus: 'in_progress',
      nextProgress: Math.min(90, Math.max(20, Number(row.progress || 10))),
      upstreamUrl: null,
      errMsg: null,
      metadata: { ...meta, agent_status: 'action_required' },
    };
  }

  const nextMeta = meta.agent_status !== summary.status
    ? { ...meta, agent_status: summary.status }
    : undefined;
  return {
    nextStatus: 'in_progress',
    nextProgress: Math.min(90, Math.max(15, Number(row.progress || 10) + 5)),
    upstreamUrl: null,
    errMsg: null,
    ...(nextMeta ? { metadata: nextMeta } : {}),
  };
}

// ===================== Generasi Freebeat Music (konsumen) =====================
function consumerMusicCeiling(env) {
  const n = Number(env?.FREEBEAT_MUSIC_MAX_PROVIDER_CREDITS);
  return Number.isSafeInteger(n) && n >= 10 && n <= 100000 ? n : 250;
}
function consumerMusicMinMargin(env) {
  const n = Number(env?.FREEBEAT_MUSIC_MIN_MARGIN);
  return Number.isFinite(n) && n >= 1 && n <= 20 ? n : 1;
}

export function sanitizeMusicRow(row) {
  if (!row || typeof row !== 'object') return null;
  const meta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
  const audioList = Array.isArray(meta.audios) ? meta.audios.filter((u) => typeof u === 'string' && u.trim()) : [];
  if (row.audio_url && !audioList.includes(row.audio_url)) audioList.unshift(row.audio_url);
  return {
    id: row.id,
    provider: row.provider || 'freebeat',
    model: row.model,
    model_name: row.model_name || null,
    prompt: row.prompt || '',
    lyrics: row.lyrics || null,
    instrumental: row.instrumental === true,
    duration_seconds: row.duration_seconds !== null && row.duration_seconds !== undefined ? Number(row.duration_seconds) : null,
    credits_charged: Number(row.credits_charged || 0),
    credits_refunded: Number(row.credits_refunded || 0),
    status: row.status,
    title: row.title || null,
    music_id: row.music_id || null,
    duration_ms: row.duration_ms !== null && row.duration_ms !== undefined ? Number(row.duration_ms) : null,
    audio_count: audioList.length,
    has_audio: audioList.length > 0,
    has_cover: Boolean(row.cover_url),
    error_message: row.error_message || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || row.created_at || null,
    canPoll: ['queued', 'processing'].includes(row.status) && typeof row.external_job_id === 'string' && TASK_ID.test(row.external_job_id),
  };
}

async function fetchLiveMusicCatalogFromPool(env) {
  const pool = await loadFreebeatAccountPool(env);
  if (!pool.length) return { poolReady: false, liveModels: null };
  let anyUsable = false;
  for (const rawAccount of pool.slice(0, 3)) {
    const usable = await ensureUsablePoolAccount(env, rawAccount).catch(() => null);
    if (!usable?.session?.accessToken) continue;
    anyUsable = true;
    try {
      const opened = await openMcpSessionForAccount(env, usable);
      const list = await fetchRawMusicModels(opened.session.accessToken, opened.headers);
      if (Array.isArray(list)) return { poolReady: true, liveModels: list };
    } catch { /* try next usable account */ }
  }
  return { poolReady: anyUsable, liveModels: null };
}

export async function consumerMusicConfig(env) {
  const [activeRes, pricesRes, catalogState] = await Promise.all([
    dbJson(env, '/provider_models?select=model&provider=eq.freebeat&active=eq.true&limit=500').catch(() => []),
    dbJson(env, '/credit_model_prices?select=model,credits&provider=eq.freebeat&modality=eq.music&active=eq.true&limit=500').catch(() => []),
    fetchLiveMusicCatalogFromPool(env).catch(() => ({ poolReady: false, liveModels: null })),
  ]);
  const activeSet = new Set((Array.isArray(activeRes) ? activeRes : []).map((r) => String(r?.model || '').trim()).filter(Boolean));
  const priceMap = new Map();
  for (const r of Array.isArray(pricesRes) ? pricesRes : []) {
    const id = String(r?.model || '').trim();
    const credits = Number(r?.credits);
    if (id && Number.isSafeInteger(credits) && credits > 0 && credits <= 1000000) priceMap.set(id, credits);
  }
  const metaById = new Map();
  for (const seed of FREEBEAT_BUILTIN_MUSIC_MODELS) {
    metaById.set(String(seed.model_id), {
      model_id: seed.model_id,
      name: seed.name,
      available: true,
      pricing_status: 'quoted',
      supports_duration: seed.supports_duration,
      supports_lyrics: seed.supports_lyrics,
      supports_instrumental: seed.supports_instrumental,
      requires_lyrics: seed.requires_lyrics,
    });
  }
  if (Array.isArray(catalogState.liveModels)) {
    for (const m of catalogState.liveModels) {
      metaById.set(String(m.model_id), m);
    }
  }

  const allMusicIds = new Set([...metaById.keys(), ...priceMap.keys()]);
  const models = [];
  const unpriced = [];
  for (const id of allMusicIds) {
    if (!/^\d{1,9}$/.test(id)) continue;
    const isActive = activeSet.has(id);
    const credits = priceMap.get(id) ?? null;
    const meta = metaById.get(id) || {
      model_id: Number(id),
      name: `Freebeat Music #${id}`,
      available: true,
      pricing_status: 'quoted',
      supports_duration: false,
      supports_lyrics: null,
      supports_instrumental: null,
      requires_lyrics: false,
    };
    const usableUpstream = meta.available !== false && meta.pricing_status !== 'unavailable';
    if (isActive && credits !== null && usableUpstream) {
      models.push({
        provider: 'freebeat',
        model: id,
        model_id: Number(id),
        name: meta.name,
        credits,
        ready: catalogState.poolReady && usableUpstream,
        supports_duration: meta.supports_duration === true,
        supports_lyrics: meta.supports_lyrics,
        supports_instrumental: meta.supports_instrumental,
        requires_lyrics: meta.requires_lyrics === true,
        params: {
          supports_duration: meta.supports_duration === true,
          supports_lyrics: meta.supports_lyrics,
          supports_instrumental: meta.supports_instrumental,
          requires_lyrics: meta.requires_lyrics === true,
          maxPromptChars: 2000,
          maxLyricsChars: 12000,
        },
      });
    } else if (isActive && credits === null && usableUpstream) {
      unpriced.push({ model: id, name: meta.name });
    }
  }
  models.sort((a, b) => a.model_id - b.model_id);
  return {
    provider_ready: catalogState.poolReady,
    models,
    unpriced,
    ceiling: consumerMusicCeiling(env),
    min_margin: consumerMusicMinMargin(env),
  };
}

function validateConsumerMusicPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fail('Parameter generasi musik tidak valid.', 400);
  }
  const allowedKeys = new Set(['provider', 'model', 'model_id', 'prompt', 'instrumental', 'lyrics', 'duration_seconds']);
  if (Object.keys(input).some((k) => !allowedKeys.has(k))) {
    throw fail('Parameter musik tidak dikenali.', 400);
  }
  if (input.provider !== undefined && String(input.provider).trim().toLowerCase() !== 'freebeat') {
    throw fail('Provider musik tidak dikenal.', 400);
  }
  const rawModel = input.model_id ?? input.model;
  const parsedModel = typeof rawModel === 'number' ? rawModel : Number(String(rawModel ?? '').trim());
  if (!Number.isSafeInteger(parsedModel) || parsedModel < 1 || parsedModel > 999999999) {
    throw fail('Pilih model musik yang valid.', 400);
  }
  const validated = validateMusicRequest({
    model_id: parsedModel,
    prompt: input.prompt,
    ...(input.instrumental !== undefined ? { instrumental: input.instrumental } : {}),
    ...(input.lyrics !== undefined ? { lyrics: input.lyrics } : {}),
    ...(input.duration_seconds !== undefined ? { duration_seconds: input.duration_seconds } : {}),
  }, null);
  return { modelId: parsedModel, parameters: validated.parameters };
}

export async function consumerMusicGenerate(env, request, user) {
  await assertAccountActive(env, user.id);
  const input = await imageJson(request, MUSIC_BODY_MAX_BYTES);
  const { modelId, parameters } = validateConsumerMusicPayload(input);
  const modelStr = String(modelId);

  const [pmRows, price] = await Promise.all([
    dbJson(env, `/provider_models?provider=eq.freebeat&model=eq.${encodeURIComponent(modelStr)}&active=eq.true&select=model&limit=1`),
    consumerImagePrice(env, modelStr, 'music'),
  ]);
  if (!Array.isArray(pmRows) || pmRows.length === 0) {
    throw fail(`Model musik #${modelStr} belum diaktifkan admin di Katalog Model.`, 409);
  }
  if (price === null) {
    throw fail(`Harga kredit untuk model musik #${modelStr} belum diatur admin; generasi tidak dikirim.`, 409);
  }

  const pool = await loadFreebeatAccountPool(env);
  if (!pool.length) {
    throw fail('Provider musik belum siap (admin belum menghubungkan Freebeat dengan izin generasi). Coba lagi nanti.', 503);
  }

  const ceiling = consumerMusicCeiling(env);
  const minMargin = consumerMusicMinMargin(env);
  const retryDelayMs = poolRetryDelayMs(env);
  let spentState = null;
  let sawBalanceExhausted = false;
  let lastFailoverError = null;

  const refundMusicSpend = async (reason, errorMessage) => {
    if (!spentState) return;
    const refunded = await dbRpc(env, 'refund_credits', {
      p_user_id: user.id,
      p_amount: price,
      p_description: reason,
      p_generation_id: spentState.rowId,
    }).catch(() => false);
    await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(spentState.rowId)}`, {
      method: 'PATCH',
      body: {
        status: 'failed',
        error_message: errorMessage,
        ...(refunded ? { credits_refunded: price } : {}),
        updated_at: new Date().toISOString(),
      },
    }).catch(() => {});
  };

  for (let cycle = 1; cycle <= FREEBEAT_POOL_MAX_CYCLES; cycle += 1) {
    if (cycle > 1) await sleepCycleDelay(retryDelayMs);
    for (const rawAccount of pool) {
      const account = await ensureUsablePoolAccount(env, rawAccount);
      if (!account) {
        await recordPoolAccountOutcome(env, rawAccount, { success: false, error: 'Token OAuth kedaluwarsa atau belum memiliki izin generasi' });
        lastFailoverError = fail('Token OAuth Freebeat kedaluwarsa.', 401);
        continue;
      }

      let opened;
      let quoteContent;
      let matchedModel = null;
      let exactParams = parameters;
      try {
        opened = await openMcpSessionForAccount(env, account);
        const catalogModels = await fetchRawMusicModels(opened.session.accessToken, opened.headers);
        const validated = validateMusicRequest(parameters, catalogModels);
        matchedModel = validated.model;
        exactParams = validated.parameters;
        quoteContent = await musicQuote(opened.session.accessToken, exactParams, true, opened.headers);
      } catch (err) {
        if (isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis' : (err?.message || 'Koneksi akun gagal'),
          });
          lastFailoverError = err;
          continue;
        }
        await refundMusicSpend('Refund: gagal memeriksa quote musik Freebeat', err?.message || 'Generasi musik gagal.');
        throw err;
      }

      if (isFreebeatBalanceExhausted(quoteContent)) {
        sawBalanceExhausted = true;
        await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis (quote musik)' });
        lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
        continue;
      }

      const quote = quotedCredits(quoteContent);
      if (quote === null) {
        const masked = safeQuote(quoteContent);
        const hint = masked && typeof masked === 'object' && typeof masked.status === 'string' ? ` Status provider: ${masked.status}.` : '';
        const err = fail(`Provider tidak memberikan quote biaya yang dapat dipakai untuk model musik #${modelStr}; generasi tidak dikirim dan kredit tidak dipotong.${hint}`, 409);
        await refundMusicSpend('Refund: quote musik Freebeat tidak tersedia', err.message);
        throw err;
      }
      if (quote > ceiling) {
        const err = fail(`Biaya provider ${quote} kredit Freebeat melebihi plafon musik ${ceiling}; generasi tidak dikirim.`, 409);
        await refundMusicSpend('Refund: biaya musik provider melebihi plafon', err.message);
        throw err;
      }
      if (price < quote * minMargin) {
        const err = fail(`Harga ${price} kredit BLEA lebih rendah dari biaya provider (${quote} kredit Freebeat x ${minMargin}). Admin perlu menaikkan harga model ini; generasi tidak dikirim dan kredit tidak dipotong.`, 409);
        await refundMusicSpend('Refund: margin harga model musik belum mencukupi', err.message);
        throw err;
      }

      const modelName = matchedModel?.name || FREEBEAT_BUILTIN_MUSIC_MODELS.find((m) => m.model_id === modelId)?.name || `Model #${modelStr}`;
      if (!spentState) {
        const rowId = crypto.randomUUID();
        const spent = await dbRpc(env, 'spend_credits', {
          p_user_id: user.id,
          p_amount: price,
          p_description: `Generasi musik Freebeat ${modelName}`,
          p_generation_id: rowId,
        });
        if (!spent) throw fail('Kredit BLEA tidak cukup untuk generasi musik ini.', 402);
        const metadata = {
          provider_quote: quote,
          max_credits: quote,
          catalog: 'music',
          ...(account.id ? { freebeat_account_id: account.id } : {}),
          ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
        };
        let inserted = null;
        try {
          inserted = await dbJson(env, '/music_generations', {
            method: 'POST',
            prefer: 'return=representation',
            body: {
              id: rowId,
              user_id: user.id,
              provider: 'freebeat',
              model: modelStr,
              model_name: modelName,
              prompt: exactParams.prompt,
              lyrics: exactParams.lyrics || null,
              instrumental: exactParams.instrumental === true,
              duration_seconds: exactParams.duration_seconds ?? null,
              credits_charged: price,
              status: 'processing',
              metadata,
            },
          });
        } catch { inserted = null; }
        if (!Array.isArray(inserted) || inserted.length !== 1) {
          try { await dbRpc(env, 'refund_credits', { p_user_id: user.id, p_amount: price, p_description: 'Refund: riwayat generasi musik tidak tersimpan', p_generation_id: rowId }); } catch { /* manual */ }
          throw fail('Riwayat generasi musik tidak dapat disimpan; kredit BLEA dikembalikan. Silakan coba lagi.', 503);
        }
        spentState = { rowId, insertedRow: inserted[0], metadata };
      }

      try {
        const { result } = await rpc(
          opened.session.accessToken,
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'generate_music', arguments: { ...exactParams, max_credits: quote } },
          },
          'generate',
          opened.headers,
          262144,
          true,
        );
        if (result?.isError || isFreebeatBalanceExhausted(result)) {
          if (isFreebeatBalanceExhausted(result)) {
            sawBalanceExhausted = true;
            await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat generate musik' });
            lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
            continue;
          }
          const err = fail('Provider menolak permintaan generasi musik.', 502);
          await refundMusicSpend('Refund: permintaan musik ditolak Freebeat', err.message);
          throw err;
        }
        const content = modelContent(result);
        if (content && isFreebeatBalanceExhausted(content) && !content.task_id && !content.batch_id) {
          sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, { success: false, error: 'Saldo Freebeat habis saat generate musik' });
          lastFailoverError = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
          continue;
        }
        const rawTaskId = typeof content?.task_id === 'string' && TASK_ID.test(content.task_id)
          ? content.task_id
          : (typeof content?.batch_id === 'string' && TASK_ID.test(content.batch_id) ? content.batch_id : null);
        if (!rawTaskId) {
          throw new Error('unrecognized');
        }
        const nextMeta = {
          ...spentState.metadata,
          provider_quote: quote,
          max_credits: quote,
          ...(account.id ? { freebeat_account_id: account.id } : {}),
          ...(account.account_email ? { freebeat_account_email: account.account_email } : {}),
        };
        await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(spentState.rowId)}`, {
          method: 'PATCH',
          body: { external_job_id: rawTaskId, status: 'processing', metadata: nextMeta, updated_at: new Date().toISOString() },
        });
        await recordPoolAccountOutcome(env, account, { success: true });
        return {
          status: 'submitted',
          credits: price,
          generation: sanitizeMusicRow({ ...spentState.insertedRow, external_job_id: rawTaskId, metadata: nextMeta }),
        };
      } catch (err) {
        if (err?.status && spentState && err.message?.includes('Provider menolak permintaan')) throw err;
        if (isAccountFailoverError(err)) {
          if (isFreebeatBalanceExhausted(err)) sawBalanceExhausted = true;
          await recordPoolAccountOutcome(env, account, {
            success: false,
            error: isFreebeatBalanceExhausted(err) ? 'Saldo Freebeat habis saat generate musik' : (err?.message || 'Gagal generate musik'),
          });
          lastFailoverError = err;
          continue;
        }
        try {
          await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(spentState.rowId)}`, {
            method: 'PATCH',
            body: { status: 'unknown', error_message: 'Hasil pengiriman tidak pasti; periksa status sebelum mengulang.', updated_at: new Date().toISOString() },
          });
        } catch { /* retain processing */ }
        return {
          status: 'unknown',
          credits: price,
          generation: sanitizeMusicRow({ ...spentState.insertedRow, status: 'unknown' }),
        };
      }
    }
  }

  await refundMusicSpend(
    sawBalanceExhausted ? 'Refund: saldo gateway Freebeat habis setelah 3 putaran' : 'Refund: semua akun Freebeat gagal memproses musik',
    sawBalanceExhausted ? FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE : (lastFailoverError?.message || 'Generasi musik gagal pada semua akun Freebeat.'),
  );
  if (sawBalanceExhausted) {
    const err = fail(FREEBEAT_GATEWAY_EXHAUSTED_MESSAGE, 503);
    err.code = 'gateway_balance_exhausted';
    throw err;
  }
  throw lastFailoverError || fail('Semua akun Freebeat tidak dapat memproses permintaan musik saat ini.', 503);
}

export async function pollFreebeatMusicRow(env, row) {
  if (!row || !['queued', 'processing'].includes(row.status) || typeof row.external_job_id !== 'string' || !TASK_ID.test(row.external_job_id)) {
    return { generation: sanitizeMusicRow(row || {}), task: null };
  }
  const preferredAccountId = row.metadata?.freebeat_account_id || null;
  const usable = await loadPreferredAccountSession(env, preferredAccountId);
  const session = usable?.session || null;
  if (!session?.imageAccess) throw fail('Provider musik belum siap; status tidak dapat diperiksa sekarang.', 503);
  const opened = await openMcpSessionForAccount(env, usable);
  const { result: statusRes } = await rpc(opened.session.accessToken, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'get_task_status', arguments: { task_id: row.external_job_id } },
  }, 'task', opened.headers, 262144);
  const statusContent = modelContent(statusRes);
  if (!statusContent || typeof statusContent !== 'object' || Array.isArray(statusContent)) throw mcpFailure('task', 'response');
  const task = safeTask(statusContent);

  let resultContent = null;
  if (['completed', 'failed', 'partial_failed', 'cancelled', 'expired'].includes(task.status)) {
    try {
      const { result: finalRes } = await rpc(opened.session.accessToken, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_task_result', arguments: { task_id: row.external_job_id } },
      }, 'task', opened.headers, 262144);
      const parsed = modelContent(finalRes);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) resultContent = parsed;
    } catch { /* fallback to statusContent */ }
  }

  const source = resultContent || statusContent;
  const baseMeta = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
  const sourceBilling = safeTask(source).billing;
  const billingSummary = {
    charged: sourceBilling.charged ?? task.billing.charged,
    refunded: sourceBilling.refunded ?? task.billing.refunded,
    net: sourceBilling.net ?? task.billing.net,
    refund_state: sourceBilling.refund_state ?? task.billing.refund_state,
  };
  let metaPatch = { ...baseMeta, provider_billing: billingSummary };
  let patch = null;
  let needRefund = false;
  let refundStatusLabel = 'failed';

  if (task.status === 'completed') {
    const audios = extractMusicAudioUrls(source);
    const coverUrl = extractMusicCoverUrl(source);
    const rawMusicId = extractResultMusicId(source);
    const rawTitle = source?.result?.title ?? source?.title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? privateFailureReason(rawTitle.trim())?.slice(0, 200) : null;
    const rawDurationMs = source?.result?.duration_ms ?? source?.duration_ms;
    const durationMs = typeof rawDurationMs === 'number' && Number.isFinite(rawDurationMs) && rawDurationMs >= 0 ? Math.round(rawDurationMs) : null;
    metaPatch = { ...metaPatch, audios };
    patch = {
      status: 'completed',
      audio_url: audios[0] || null,
      cover_url: coverUrl || null,
      music_id: rawMusicId !== null ? String(rawMusicId) : null,
      title,
      duration_ms: durationMs,
      error_message: null,
      metadata: metaPatch,
      updated_at: new Date().toISOString(),
    };
  } else if (['failed', 'partial_failed', 'cancelled', 'expired'].includes(task.status)) {
    const failureSource = resultContent || statusContent;
    const reasons = imageFailureReasons(failureSource);
    const detail = reasons.length
      ? reasons.join(', ')
      : (imageFailureFields(failureSource).some((value) => typeof value === 'string' && value.trim()) ? 'lainnya (lihat pemeriksaan admin)' : null);
    const nextStatus = task.status === 'cancelled' ? 'cancelled' : 'failed';
    refundStatusLabel = nextStatus;
    const errText = task.status === 'cancelled'
      ? 'Provider membatalkan generasi musik.'
      : task.status === 'expired'
        ? 'Tugas generasi musik kedaluwarsa di provider.'
        : (detail ? `Provider melaporkan generasi musik gagal: ${detail}.` : 'Provider melaporkan generasi musik gagal.');
    metaPatch = { ...metaPatch, failure_reasons: reasons, failure_detail_hidden: detail === 'lainnya (lihat pemeriksaan admin)' };
    patch = {
      status: nextStatus,
      error_message: errText,
      metadata: metaPatch,
      updated_at: new Date().toISOString(),
    };
    needRefund = Number(row.credits_charged) > 0 && Number(row.credits_refunded) === 0;
  } else if (['pending', 'queued', 'processing', 'running'].includes(task.status)) {
    patch = { status: 'processing', updated_at: new Date().toISOString() };
  }

  if (patch) {
    if (needRefund) {
      const charged = Number(row.credits_charged);
      const claimRes = await dbJson(
        env,
        `/music_generations?id=eq.${encodeURIComponent(row.id)}&credits_refunded=eq.0`,
        { method: 'PATCH', prefer: 'return=representation', body: { ...patch, credits_refunded: charged } },
      ).catch(() => null);
      if (Array.isArray(claimRes) && claimRes.length === 1) {
        let refunded = false;
        try {
          refunded = await dbRpc(env, 'refund_credits', {
            p_user_id: row.user_id,
            p_amount: charged,
            p_description: refundStatusLabel === 'cancelled' ? 'Refund: generasi musik dibatalkan provider' : 'Refund: generasi musik gagal',
            p_generation_id: row.id,
          });
        } catch { refunded = false; }
        if (refunded) {
          row.credits_refunded = charged;
        } else {
          await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH',
            body: { credits_refunded: 0, updated_at: new Date().toISOString() },
          }).catch(() => {});
        }
      } else {
        await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: patch }).catch(() => {});
      }
    } else {
      await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: patch }).catch(() => {});
    }
  }
  return { generation: sanitizeMusicRow({ ...row, ...(patch || {}) }), task: { status: task.status, billing: billingSummary } };
}

export async function refreshMusicRowUrls(env, row) {
  if (!row || typeof row.external_job_id !== 'string' || !TASK_ID.test(row.external_job_id)) return null;
  const preferredAccountId = row.metadata?.freebeat_account_id || null;
  const usable = await loadPreferredAccountSession(env, preferredAccountId).catch(() => null);
  if (!usable?.session?.imageAccess) return null;
  const opened = await openMcpSessionForAccount(env, usable);
  const { result: finalRes } = await rpc(opened.session.accessToken, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_task_result', arguments: { task_id: row.external_job_id } },
  }, 'task', opened.headers, 262144);
  const parsed = modelContent(finalRes);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const audios = extractMusicAudioUrls(parsed);
  const coverUrl = extractMusicCoverUrl(parsed);
  if (!audios.length && !coverUrl) return null;
  const meta = {
    ...(row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}),
    ...(audios.length ? { audios } : {}),
  };
  const patch = {
    ...(audios[0] ? { audio_url: audios[0] } : {}),
    ...(coverUrl ? { cover_url: coverUrl } : {}),
    metadata: meta,
    updated_at: new Date().toISOString(),
  };
  await dbFetch(env, `/music_generations?id=eq.${encodeURIComponent(row.id)}`, { method: 'PATCH', body: patch }).catch(() => {});
  return { audio_url: audios[0] || row.audio_url || null, cover_url: coverUrl || row.cover_url || null, metadata: meta };
}

export async function consumerMusicStatus(env, request, user) {
  const input = await imageJson(request);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => k !== 'id') || typeof input.id !== 'string' || !TEST_ID.test(input.id)) {
    throw fail('ID generasi musik tidak valid.', 400);
  }
  const rows = await dbJson(env, `/music_generations?id=eq.${encodeURIComponent(input.id)}&user_id=eq.${encodeURIComponent(user.id)}&select=*&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Riwayat generasi musik tidak ditemukan.', 404);
  return await pollFreebeatMusicRow(env, row);
}

export async function consumerMusicHistory(env, user) {
  const rows = await dbJson(env, `/music_generations?user_id=eq.${encodeURIComponent(user.id)}&select=*&order=created_at.desc,id.desc&limit=40`);
  return { generations: (Array.isArray(rows) ? rows : []).map(sanitizeMusicRow) };
}

