/* =========================================================
   GEN-Z.AI — BUILT-IN TEMPMAIL PROVIDER (mail.tm)
   ---------------------------------------------------------
   Provider REST yang dipanggil langsung dari Cloudflare Worker,
   sehingga fitur /email.html tidak lagi bergantung pada
   Tempmail-MCP / GitHub Codespaces / TEMPMAIL_API_URL.

   Kontrak API: https://docs.mail.tm/
   - GET  /domains                 -> daftar domain aktif
   - POST /accounts                -> buat mailbox
   - POST /token                   -> Bearer token (disimpan di Supabase)
   - GET  /messages?page=1         -> daftar pesan
   - GET  /messages/{id}           -> isi pesan

   Kredensial (token + password) TIDAK pernah dikirim ke browser:
   disimpan sebagai JSON string di kolom `token` milik user,
   dibaca hanya oleh Worker dengan service_role Supabase.
========================================================= */

export const MAILTM_PROVIDER = "mailtm";
export const MAILTM_API_URL = "https://api.mail.tm";
const MAILTM_TIMEOUT_MS = 12000;

function fetchWithTimeout(url, options = {}, timeoutMs = MAILTM_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
        .finally(() => clearTimeout(timer));
}

async function readJsonSafe(response) {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function randomString(length) {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let result = "";
    for (const byte of bytes) result += alphabet[byte % alphabet.length];
    return result;
}

function providerError(response, payload, fallback) {
    const detail = payload?.detail || payload?.message || payload?.["hydra:description"] || "";
    const suffix = detail ? `: ${String(detail).slice(0, 200)}` : "";
    const error = new Error(`${fallback} (HTTP ${response.status})${suffix}`);
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502;
    error.providerStatus = response.status;
    return error;
}

async function mailtmRequest(path, { method = "GET", token = "", body, timeoutMs } = {}) {
    const headers = { "Accept": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchWithTimeout(
        `${MAILTM_API_URL}${path}`,
        {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {})
        },
        timeoutMs || MAILTM_TIMEOUT_MS
    );
    return { response, payload: await readJsonSafe(response) };
}

function activeDomain(payload) {
    const members = Array.isArray(payload?.["hydra:member"]) ? payload["hydra:member"] : [];
    const usable = members.find(item =>
        item?.domain && item.isActive !== false && item.isPrivate !== true
    );
    return String((usable || members.find(item => item?.domain))?.domain || "");
}

export function formatMailAddress(value) {
    if (!value) return "";
    if (Array.isArray(value)) return value.map(formatMailAddress).filter(Boolean).join(", ");
    if (typeof value === "object") {
        const address = String(value.address || "");
        const name = String(value.name || "").trim();
        if (name && address) return `${name} <${address}>`;
        return address || name;
    }
    return String(value);
}

export function parseMailtmCredentials(raw) {
    try {
        const parsed = JSON.parse(String(raw || ""));
        if (parsed && typeof parsed === "object" && parsed.token) {
            return { token: String(parsed.token), password: String(parsed.password || "") };
        }
    } catch {
        /* token lama / plain string */
    }
    return { token: String(raw || ""), password: "" };
}

export function serializeMailtmCredentials(token, password) {
    return JSON.stringify({ token: String(token), password: String(password || "") });
}

export async function createMailtmAlias() {
    const { response: domainsResponse, payload: domainsPayload } = await mailtmRequest("/domains");
    if (!domainsResponse.ok) {
        throw providerError(domainsResponse, domainsPayload, "Gagal mengambil domain mail.tm");
    }
    const domain = activeDomain(domainsPayload);
    if (!domain) {
        const error = new Error("mail.tm tidak mengembalikan domain aktif. Coba lagi beberapa saat.");
        error.status = 502;
        throw error;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const address = `${randomString(10)}@${domain}`;
        const password = randomString(20);

        const { response: createResponse, payload: createPayload } =
            await mailtmRequest("/accounts", { method: "POST", body: { address, password } });
        if (createResponse.status === 409 || createResponse.status === 422) continue;
        if (!createResponse.ok) {
            throw providerError(createResponse, createPayload, "mail.tm menolak pembuatan mailbox");
        }

        const { response: tokenResponse, payload: tokenPayload } =
            await mailtmRequest("/token", { method: "POST", body: { address, password } });
        if (!tokenResponse.ok || !tokenPayload?.token) {
            throw providerError(tokenResponse, tokenPayload, "Gagal mengambil token mail.tm");
        }

        return {
            email: address,
            token: serializeMailtmCredentials(tokenPayload.token, password),
            provider: MAILTM_PROVIDER
        };
    }

    const error = new Error("Alamat mail.tm bentrok berulang kali. Coba lagi.");
    error.status = 502;
    throw error;
}

export async function refreshMailtmToken(email, password) {
    const { response, payload } = await mailtmRequest("/token", {
        method: "POST",
        body: { address: email, password }
    });
    if (!response.ok || !payload?.token) {
        throw providerError(response, payload, "Gagal memperbarui token mail.tm");
    }
    return String(payload.token);
}

export async function checkMailtmHealth() {
    try {
        const { response, payload } = await mailtmRequest("/domains", { timeoutMs: 8000 });
        const domain = activeDomain(payload);
        return {
            ok: Boolean(response.ok && domain),
            status: response.status,
            detail: domain
                ? `Domain aktif: ${domain} · ${MAILTM_API_URL}/domains = HTTP ${response.status}`
                : `HTTP ${response.status}: daftar domain mail.tm kosong`,
            hint: response.ok && domain
                ? ""
                : "Worker tidak bisa menghubungi api.mail.tm. Cek egress Cloudflare Worker / status layanan mail.tm, lalu coba lagi.",
            endpoints: [{ path: "/domains", status: response.status, json: true }],
            providers: [{ name: MAILTM_PROVIDER, disabled: false, failures: 0 }]
        };
    } catch (error) {
        return {
            ok: false,
            status: 502,
            detail: error?.message || "Gagal menghubungi api.mail.tm",
            hint: "Worker tidak bisa menghubungi api.mail.tm. Cek egress Cloudflare Worker / status layanan mail.tm.",
            endpoints: [],
            providers: []
        };
    }
}

export function normalizeMailtmMessages(payload) {
    const members = Array.isArray(payload?.["hydra:member"]) ? payload["hydra:member"] : [];
    return members
        .filter(item => item?.id)
        .map(item => ({
            id: String(item.id),
            subject: String(item.subject ?? ""),
            from: formatMailAddress(item.from),
            to: formatMailAddress(item.to),
            preview: String(item.intro ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
            createdAt: item.createdAt ? String(item.createdAt) : null
        }));
}

export function normalizeMailtmMessage(raw, fallbackId) {
    if (!raw || typeof raw !== "object") return null;

    const html = Array.isArray(raw.html)
        ? raw.html.filter(item => typeof item === "string").join("\n")
        : (typeof raw.html === "string" ? raw.html : "");
    const attachments = Array.isArray(raw.attachments)
        ? raw.attachments
            .filter(item => item && typeof item === "object")
            .map(item => ({
                filename: String(item.filename ?? ""),
                contentType: String(item.contentType ?? item.content_type ?? ""),
                size: Number(item.size) || 0,
                url: typeof item.downloadUrl === "string" ? item.downloadUrl : null
            }))
        : [];

    return {
        id: String(raw.id ?? fallbackId ?? ""),
        subject: String(raw.subject ?? ""),
        from: formatMailAddress(raw.from),
        to: formatMailAddress(raw.to),
        bodyText: typeof raw.text === "string" ? raw.text : "",
        bodyHtml: html,
        createdAt: raw.createdAt ? String(raw.createdAt) : null,
        attachments
    };
}

export async function fetchMailtmMessages(token) {
    const { response, payload } = await mailtmRequest("/messages?page=1", { token });
    if (!response.ok) {
        throw providerError(response, payload, "Gagal membaca inbox mail.tm");
    }
    return normalizeMailtmMessages(payload);
}

export async function fetchMailtmMessage(token, messageId) {
    const { response, payload } = await mailtmRequest(
        `/messages/${encodeURIComponent(messageId)}`,
        { token }
    );
    if (!response.ok) {
        throw providerError(response, payload, "Gagal membaca pesan mail.tm");
    }
    const message = normalizeMailtmMessage(payload, messageId);
    if (!message) {
        const error = new Error("Isi pesan tidak ditemukan pada mail.tm.");
        error.status = 404;
        throw error;
    }
    return message;
}
