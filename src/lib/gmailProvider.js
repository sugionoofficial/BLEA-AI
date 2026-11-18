/* =========================================================
   GEN-Z.AI — GMAIL CONNECT UNTUK TEMPMAIL
   ---------------------------------------------------------
   Admin menghubungkan akun Gmail sekali lewat OAuth2 di
   /email.html. Worker lalu:
   - menyimpan refresh token terenkripsi AES-GCM di Supabase
     (hanya service_role yang bisa membacanya),
   - membuat alias plus-addressing: nama+tag@gmail.com,
   - membaca inbox lewat Gmail REST API (bukan IMAP/TCP).

   Tidak ada Docker, VPS, Codespace, Tempmail-MCP, atau BIOS.
   Yang dibutuhkan hanya Google Cloud OAuth client + secret Worker.
========================================================= */

export const GMAIL_API_PROVIDER = "gmailapi";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
const OAUTH_TIMEOUT_MS = 12000;
const STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_COOKIE_NAME = "genzai_gmail_oauth";

function configError(message, status = 500, hint = "") {
    const error = new Error(message);
    error.status = status;
    if (hint) error.hint = hint;
    return error;
}

function textToBytes(value) {
    return new TextEncoder().encode(String(value ?? ""));
}

function bytesToText(bytes) {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function base64UrlEncode(bytes) {
    let binary = "";
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function constantTimeEqual(a, b) {
    const left = String(a || "");
    const right = String(b || "");
    if (left.length !== right.length) return false;
    let diff = 0;
    for (let index = 0; index < left.length; index += 1) {
        diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return diff === 0;
}

async function hmacSign(payloadB64, secret) {
    const key = await crypto.subtle.importKey(
        "raw",
        textToBytes(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, textToBytes(payloadB64));
    return base64UrlEncode(new Uint8Array(signature));
}

async function createOAuthState(userId, secret, secureCookie) {
    const sid = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
    const exp = Date.now() + STATE_TTL_MS;
    const payload = {
        uid: String(userId),
        exp,
        sid,
        nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(12)))
    };
    const payloadB64 = base64UrlEncode(textToBytes(JSON.stringify(payload)));
    const state = `${payloadB64}.${await hmacSign(payloadB64, secret)}`;

    /* Ikatan state ke browser yang memulai OAuth. Tanpa cookie HttpOnly ini,
       penyerang bisa memberi state bertanda uid-nya ke korban; korban lalu
       tanpa sadar menyimpan refresh token Gmail-nya ke akun penyerang. */
    const cookiePayloadB64 = base64UrlEncode(textToBytes(JSON.stringify({ uid: payload.uid, exp, sid })));
    const cookieValue = `${cookiePayloadB64}.${await hmacSign(cookiePayloadB64, secret)}`;
    const cookie = [
        `${OAUTH_COOKIE_NAME}=${cookieValue}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${Math.floor(STATE_TTL_MS / 1000)}`,
        ...(secureCookie ? ["Secure"] : [])
    ].join("; ");
    return { state, cookie };
}

function clearOAuthCookie(secureCookie) {
    return [
        `${OAUTH_COOKIE_NAME}=`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=0",
        ...(secureCookie ? ["Secure"] : [])
    ].join("; ");
}

function readCookie(header, name) {
    for (const part of String(header || "").split(";")) {
        const separator = part.indexOf("=");
        if (separator === -1) continue;
        if (part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim();
        }
    }
    return "";
}

async function verifyOAuthState(state, secret) {
    const [payloadB64, signature] = String(state || "").split(".");
    if (!payloadB64 || !signature) return null;
    const expected = await hmacSign(payloadB64, secret);
    if (!constantTimeEqual(expected, signature)) return null;
    try {
        const payload = JSON.parse(bytesToText(base64UrlDecode(payloadB64)));
        if (!payload?.uid || !payload?.sid || Date.now() > Number(payload.exp || 0)) return null;
        return payload;
    } catch {
        return null;
    }
}

async function verifyOAuthCookie(request, secret, statePayload) {
    const [cookiePayloadB64, signature] = readCookie(
        request.headers.get("Cookie"),
        OAUTH_COOKIE_NAME
    ).split(".");
    if (!cookiePayloadB64 || !signature) return false;
    const expected = await hmacSign(cookiePayloadB64, secret);
    if (!constantTimeEqual(expected, signature)) return false;
    try {
        const cookiePayload = JSON.parse(bytesToText(base64UrlDecode(cookiePayloadB64)));
        return cookiePayload.uid === statePayload.uid &&
            cookiePayload.sid === statePayload.sid &&
            Date.now() <= Number(cookiePayload.exp || 0);
    } catch {
        return false;
    }
}

function oauthClient(env) {
    const clientId = String(env.GMAIL_CLIENT_ID || "").trim();
    const clientSecret = String(env.GMAIL_CLIENT_SECRET || "").trim();
    if (!clientId || !clientSecret) {
        throw configError(
            "GMAIL_CLIENT_ID dan GMAIL_CLIENT_SECRET belum di-set di Cloudflare Worker.",
            500,
            "Buat OAuth client 'Web application' di Google Cloud, aktifkan Gmail API, lalu: npx wrangler@4 secret put GMAIL_CLIENT_ID dan GMAIL_CLIENT_SECRET."
        );
    }
    return { clientId, clientSecret };
}

function oauthRedirectUri(env, requestUrl) {
    const override = String(env.GMAIL_OAUTH_REDIRECT_URI || "").trim();
    if (override) return override;
    try {
        return new URL("/api/tempmail-gmail-callback", requestUrl).toString();
    } catch {
        throw configError("URL callback OAuth tidak bisa ditentukan. Set GMAIL_OAUTH_REDIRECT_URI.");
    }
}

export function isGmailApiConfigured(env) {
    return Boolean(
        String(env.GMAIL_CLIENT_ID || "").trim() &&
        String(env.GMAIL_CLIENT_SECRET || "").trim() &&
        String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || "").trim()
    );
}

/* Ikut pola lib/security/provider-credential-vault.js: terima 64 hex,
   base64 32 byte, atau secret teks panjang yang di-SHA-256. Ini penting
   supaya project yang SUDAH punya PROVIDER_CREDENTIAL_ENCRYPTION_KEY tidak
   perlu merotasi kunci vault lama hanya untuk mengaktifkan Mode C. */
async function encryptionKey(env) {
    const raw = String(env.PROVIDER_CREDENTIAL_ENCRYPTION_KEY || "").trim();
    if (!raw) {
        throw configError(
            "PROVIDER_CREDENTIAL_ENCRYPTION_KEY belum di-set.",
            500,
            "npx wrangler@4 secret put PROVIDER_CREDENTIAL_ENCRYPTION_KEY (disarankan 64 hex dari: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")."
        );
    }
    let bytes;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
        bytes = new Uint8Array(32);
        for (let index = 0; index < 32; index += 1) {
            bytes[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
        }
    } else {
        let decoded = new Uint8Array(0);
        try {
            decoded = base64UrlDecode(raw);
        } catch {
            /* bukan base64 -> turunan SHA-256 dari teks secret */
        }
        bytes = decoded.length === 32
            ? decoded
            : new Uint8Array(await crypto.subtle.digest("SHA-256", textToBytes(raw)));
    }
    return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptRefreshToken(refreshToken, env) {
    const key = await encryptionKey(env);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        textToBytes(refreshToken)
    );
    return {
        ciphertext: base64UrlEncode(new Uint8Array(encrypted)),
        iv: base64UrlEncode(iv)
    };
}

async function decryptRefreshToken(row, env) {
    const key = await encryptionKey(env);
    try {
        const decrypted = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: base64UrlDecode(row.refresh_token_iv) },
            key,
            base64UrlDecode(row.refresh_token_ciphertext)
        );
        return bytesToText(new Uint8Array(decrypted));
    } catch {
        throw configError(
            "Refresh token Gmail tidak bisa dibuka. Kunci enkripsi berubah atau data rusak.",
            500,
            "Putuskan lalu hubungkan ulang akun Gmail dari halaman TempMail."
        );
    }
}

function supabaseAdminConfig(env) {
    const supabaseUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const serviceRoleKey = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    if (!supabaseUrl || !serviceRoleKey) {
        throw configError("Konfigurasi database TempMail belum lengkap (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
    }
    return { supabaseUrl, serviceRoleKey };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = OAUTH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function supabaseRequest(env, path, options = {}) {
    const { supabaseUrl, serviceRoleKey } = supabaseAdminConfig(env);
    const url = new URL(`${supabaseUrl}/rest/v1/${path}`);
    for (const [key, value] of Object.entries(options.search || {})) {
        url.searchParams.set(key, value);
    }
    const response = await fetchWithTimeout(url, {
        method: options.method || "GET",
        headers: {
            "apikey": serviceRoleKey,
            "Authorization": `Bearer ${serviceRoleKey}`,
            "Accept": "application/json",
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...(options.prefer ? { "Prefer": options.prefer } : {})
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {})
    });
    if (!response.ok) {
        const detail = await response.text();
        throw configError(
            `Gagal mengakses tempmail_gmail_connections (HTTP ${response.status}). ${detail.slice(0, 160)}`,
            502,
            "Jalankan supabase/tempmail-gmail-connections.sql lalu NOTIFY pgrst, 'reload schema'."
        );
    }
    return response;
}

export async function getGmailConnection(env, userId) {
    const response = await supabaseRequest(env, "tempmail_gmail_connections", {
        search: {
            select: "email,refresh_token_ciphertext,refresh_token_iv",
            user_id: `eq.${userId}`,
            limit: "1"
        }
    });
    const rows = await response.json();
    return Array.isArray(rows) ? rows[0] || null : null;
}

export async function saveGmailConnection(env, userId, email, refreshToken) {
    const encrypted = await encryptRefreshToken(refreshToken, env);
    await supabaseRequest(env, "tempmail_gmail_connections", {
        method: "POST",
        prefer: "resolution=merge-duplicates,return=minimal",
        search: { on_conflict: "user_id" },
        body: {
            user_id: userId,
            email,
            refresh_token_ciphertext: encrypted.ciphertext,
            refresh_token_iv: encrypted.iv,
            updated_at: new Date().toISOString()
        }
    });
}

export async function deleteGmailConnection(env, userId) {
    await supabaseRequest(env, "tempmail_gmail_connections", {
        method: "DELETE",
        prefer: "return=minimal",
        search: { user_id: `eq.${userId}` }
    });
}

export async function buildGmailAuthUrl(env, userId, requestUrl) {
    const { clientId, clientSecret } = oauthClient(env);
    const redirectUri = oauthRedirectUri(env, requestUrl);
    let secureCookie = true;
    try {
        secureCookie = new URL(requestUrl).protocol === "https:";
    } catch {
        secureCookie = true;
    }
    const { state, cookie } = await createOAuthState(userId, clientSecret, secureCookie);
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", GMAIL_SCOPE);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return { authUrl: url.toString(), cookie };
}

async function googleTokenRequest(body) {
    const response = await fetchWithTimeout(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json"
        },
        body: new URLSearchParams(body).toString()
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
        throw configError(
            `Google menolak permintaan token (HTTP ${response.status}). ${String(payload.error_description || payload.error || "").slice(0, 180)}`,
            502,
            "Pastikan GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET benar, Gmail API aktif, dan akun Gmail ditambahkan sebagai test user di OAuth consent screen."
        );
    }
    return payload;
}

async function gmailFetch(accessToken, path) {
    const response = await fetchWithTimeout(`${GMAIL_API}${path}`, {
        headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json"
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const hint = response.status === 401
            ? "Refresh token Gmail dicabut / kedaluwarsa. Putuskan lalu hubungkan ulang dari halaman TempMail."
            : response.status === 403
                ? "Gmail API belum aktif atau scope gmail.readonly belum diberikan. Cek Google Cloud project."
                : "Cek kuota Gmail API dan koneksi Worker ke googleapis.com.";
        throw configError(
            `Gmail API gagal (HTTP ${response.status}). ${String(payload?.error?.message || "").slice(0, 180)}`,
            response.status === 429 ? 429 : 502,
            hint
        );
    }
    return payload;
}

async function gmailAccessToken(env, refreshToken) {
    const { clientId, clientSecret } = oauthClient(env);
    let payload;
    try {
        payload = await googleTokenRequest({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token"
        });
    } catch (error) {
        if (/invalid_grant/i.test(String(error?.message || ""))) {
            throw configError(
                "Refresh token Gmail tidak lagi berlaku (invalid_grant).",
                401,
                "Putuskan lalu hubungkan ulang akun Gmail dari halaman TempMail. Bila consent screen masih Testing, token kedaluwarsa setelah 7 hari."
            );
        }
        throw error;
    }
    return String(payload.access_token);
}

function gmailErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/refresh[_-]?token[\w-]*|access[_-]?token[\w-]*/gi, "<disamarkan>");
}

export async function handleGmailOAuthCallback(request, env) {
    const url = new URL(request.url);
    const origin = url.origin;
    const secureCookie = url.protocol === "https:";
    const clearCookie = clearOAuthCookie(secureCookie);
    const redirect = (location, reason) => new Response(null, {
        status: 302,
        headers: {
            "Location": reason
                ? `${origin}/tempmail?gmail=error&reason=${encodeURIComponent(reason)}`
                : `${origin}/tempmail?gmail=connected`,
            "Cache-Control": "no-store",
            "Set-Cookie": clearCookie
        }
    });
    const fail = reason => redirect("", reason);

    try {
        const oauthError = url.searchParams.get("error");
        if (oauthError) return fail(String(oauthError).slice(0, 120));

        const { clientId, clientSecret } = oauthClient(env);
        const state = await verifyOAuthState(url.searchParams.get("state"), clientSecret);
        if (!state) return fail("State OAuth tidak valid atau kedaluwarsa. Ulangi dari tombol Hubungkan Gmail.");
        if (!(await verifyOAuthCookie(request, clientSecret, state))) {
            return fail("Sesi OAuth tidak cocok dengan browser yang memulai koneksi. Ulangi dari tombol Hubungkan Gmail.");
        }

        const code = url.searchParams.get("code");
        if (!code) return fail("Kode otorisasi tidak ditemukan.");

        const tokenPayload = await googleTokenRequest({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: "authorization_code",
            redirect_uri: oauthRedirectUri(env, request.url)
        });
        const accessToken = String(tokenPayload.access_token || "");
        const refreshToken = String(tokenPayload.refresh_token || "");
        if (!refreshToken) {
            return fail("Google tidak mengirim refresh token. Pastikan access_type=offline dan prompt=consent, lalu ulangi.");
        }

        const profile = await gmailFetch(accessToken, "/users/me/profile");
        const email = String(profile.emailAddress || "").trim();
        if (!email) return fail("Alamat email Google tidak ditemukan.");

        await saveGmailConnection(env, state.uid, email, refreshToken);
        return redirect("", "");
    } catch (error) {
        return fail(gmailErrorMessage(error));
    }
}

function randomTag(length = 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    let tag = "";
    for (const byte of bytes) tag += String(byte % 10);
    return tag;
}

export function createGmailApiAlias(connectionEmail, requestedTag = "") {
    const email = String(connectionEmail || "").trim();
    const at = email.lastIndexOf("@");
    if (at <= 0 || at === email.length - 1) {
        throw configError("Alamat Gmail yang terhubung tidak valid. Hubungkan ulang akun Gmail.");
    }
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    if (local.includes("+")) {
        throw configError("Akun Gmail yang terhubung sudah memakai plus-addressing. Pakai alamat dasar tanpa +tag.");
    }
    /* Permintaan user: hasil harus selalu @gmail.com. Domain lain
       (termasuk salah ketik "gamil.com") tidak boleh masuk ke alias. */
    if (domain.toLowerCase() !== "gmail.com") {
        throw configError(
            "Akun yang terhubung harus memakai @gmail.com, bukan @" + domain + ".",
            400,
            "Hubungkan ulang akun Gmail yang benar. Plus-addressing tidak bisa membuat domain baru."
        );
    }
    const tag = String(requestedTag ?? "").trim();
    if (tag && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(tag)) {
        throw configError(
            "Akhiran hanya boleh huruf, angka, titik, garis bawah, atau tanda hubung (maks. 32 karakter).",
            400,
            "Contoh akhiran yang benar: 1, shop-2026, verif_2. Jangan menyertakan @ atau +."
        );
    }
    return {
        email: `${local}+${tag || randomTag()}@${domain}`,
        token: "",
        provider: GMAIL_API_PROVIDER
    };
}

function headerMap(headers) {
    const result = {};
    for (const header of Array.isArray(headers) ? headers : []) {
        if (header?.name) result[String(header.name).toLowerCase()] = String(header.value || "");
    }
    return result;
}

const EMAIL_ADDRESS_RE = /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/gi;

/* Gmail API memakai scope gmail.readonly untuk SELURUH mailbox akun yang
   terhubung. Karena itu hasil pencarian tidak boleh langsung dipercaya:
   setiap pesan harus benar-benar ditujukan ke alias milik user ini. */
function recipientMatchesAlias(headers, aliasEmail) {
    const expected = String(aliasEmail || "").trim().toLowerCase();
    if (!expected) return false;
    const recipientHeaders = [
        "to", "delivered-to", "x-original-to", "x-forwarded-to",
        "cc", "bcc", "resent-to"
    ];
    return recipientHeaders.some(key => {
        const matches = [...String(headers[key] || "").matchAll(EMAIL_ADDRESS_RE)];
        return matches.some(match => String(match[0]).toLowerCase() === expected);
    });
}

function notAliasMessageError(status = 404) {
    return configError(
        "Pesan tidak ditemukan untuk alamat TempMail ini.",
        status,
        "Gmail API punya akses baca ke seluruh mailbox; Worker hanya menampilkan pesan yang benar-benar ditujukan ke alias plus-addressing milik akun ini."
    );
}

function collectPayloadParts(payload, collected) {
    if (!payload || typeof payload !== "object") return;
    const mimeType = String(payload.mimeType || "");
    const body = payload.body || {};
    const data = typeof body.data === "string" ? body.data : "";

    if (data) {
        const decoded = bytesToText(base64UrlDecode(data));
        if (mimeType === "text/html") collected.html.push(decoded);
        else if (mimeType === "text/plain" || !mimeType) collected.text.push(decoded);
    }
    if (body.attachmentId && payload.filename) {
        collected.attachments.push({
            filename: String(payload.filename),
            contentType: mimeType || "application/octet-stream",
            size: Number(body.size) || 0,
            url: null
        });
    }
    for (const part of Array.isArray(payload.parts) ? payload.parts : []) {
        collectPayloadParts(part, collected);
    }
}

function gmailMessagePath(messageId, params) {
    const search = new URLSearchParams(params);
    return `/users/me/messages/${encodeURIComponent(messageId)}?${search.toString()}`;
}

export async function listGmailMessages(env, connection, aliasEmail) {
    const refreshToken = await decryptRefreshToken(connection, env);
    const accessToken = await gmailAccessToken(env, refreshToken);
    const query = new URLSearchParams({
        q: `to:${aliasEmail}`,
        maxResults: "20"
    });
    const list = await gmailFetch(accessToken, `/users/me/messages?${query.toString()}`);
    const ids = (Array.isArray(list.messages) ? list.messages : [])
        .map(item => String(item?.id || ""))
        .filter(Boolean);

    const metadataParams = new URLSearchParams({ format: "metadata" });
    for (const header of [
        "From", "To", "Subject", "Date", "Delivered-To",
        "X-Original-To", "X-Forwarded-To", "Cc", "Bcc", "Resent-To"
    ]) {
        metadataParams.append("metadataHeaders", header);
    }
    const messages = await Promise.all(ids.map(async id => {
        const message = await gmailFetch(
            accessToken,
            gmailMessagePath(id, metadataParams)
        );
        const headers = headerMap(message?.payload?.headers ?? message?.headers);
        return {
            id,
            subject: headers.subject || "(tanpa subject)",
            from: headers.from || "",
            to: aliasEmail,
            preview: String(message.snippet || "").replace(/\s+/g, " ").trim().slice(0, 180),
            createdAt: headers.date || null,
            matchesAlias: recipientMatchesAlias(headers, aliasEmail)
        };
    }));
    return messages
        .filter(message => message.matchesAlias)
        .map(({ matchesAlias, ...message }) => message);
}

export async function getGmailMessage(env, connection, aliasEmail, messageId) {
    const refreshToken = await decryptRefreshToken(connection, env);
    const accessToken = await gmailAccessToken(env, refreshToken);
    const message = await gmailFetch(
        accessToken,
        gmailMessagePath(messageId, { format: "full" })
    );
    const headers = headerMap(message?.payload?.headers ?? message?.headers);
    if (!recipientMatchesAlias(headers, aliasEmail)) {
        throw notAliasMessageError();
    }
    const collected = { text: [], html: [], attachments: [] };
    collectPayloadParts(message.payload, collected);
    return {
        id: String(message.id || messageId),
        subject: headers.subject || "(tanpa subject)",
        from: headers.from || "",
        to: aliasEmail,
        bodyText: collected.text.join("\n"),
        bodyHtml: collected.html.join("\n"),
        createdAt: headers.date || null,
        attachments: collected.attachments
    };
}

export async function checkGmailOAuthHealth(env) {
    try {
        oauthClient(env);
        await encryptionKey(env);
        return {
            ok: true,
            status: 200,
            detail: "GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, dan kunci enkripsi tersedia.",
            hint: "",
            endpoints: [{ path: "/gmail-oauth", status: 200, json: true }],
            providers: [{ name: GMAIL_API_PROVIDER, disabled: false, failures: 0 }],
            capabilities: {
                create_email: true,
                messages: true,
                providers: true,
                health: true
            }
        };
    } catch (error) {
        return {
            ok: false,
            status: 500,
            detail: gmailErrorMessage(error),
            hint: error?.hint || "Lengkapi secret OAuth Gmail di Cloudflare Worker.",
            endpoints: [],
            providers: []
        };
    }
}
