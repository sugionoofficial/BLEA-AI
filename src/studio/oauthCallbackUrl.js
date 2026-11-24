// Normalisasi URL callback OAuth "Connect OpenAI".
//
// Modul ini SENGAJA tanpa dependensi apa pun supaya bisa diuji langsung dengan
// Node (tanpa bundler). Logikanya lahir dari satu kegagalan nyata: URL callback
// yang ditempel dari chat/HTML membawa `&amp;` bukan `&`, sehingga `state` dan
// `client_id` terbaca null dan login berhenti dengan pesan yang menyesatkan
// ("state tidak cocok").

const CALLBACK_PATH = '/auth/callback';

/**
 * Ubah input pengguna menjadi query string (`?...`) yang siap diurai
 * `URLSearchParams`. Mengembalikan null bila input bukan callback OAuth.
 */
export function parseCallbackInput(rawUrl) {
  let text = String(rawUrl || '').trim();
  if (!text) return null;
  // Karakter tak terlihat sisa copy-paste (zero width, BOM, spasi non-breaking).
  text = text.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
  // HTML entity yang ikut tersalin, termasuk yang ter-encode dua kali.
  text = text.replace(/&amp;/gi, '&').replace(/&#0*38;/g, '&').replace(/&#x0*26;/gi, '&');
  text = text.replace(/&amp;/gi, '&');
  // Seluruh URL ter-encode (http%3A%2F%2F127.0.0.1…).
  if (/^https?%3A%2F%2F/i.test(text)) {
    try { text = decodeURIComponent(text); } catch { /* biarkan apa adanya */ }
    text = text.replace(/&amp;/gi, '&');
  }
  // Bisa berupa query saja: `?code=…` atau `code=…&state=…` (tanpa skema).
  const hasScheme = /^https?:\/\//i.test(text);
  // Teks tanpa skema hanya diperlakukan sebagai query kalau benar-benar memuat
  // parameter `code` — supaya tempelan asal-asalan tidak lolos jadi percobaan login.
  if (!hasScheme && !/(^|[&?\s])code=/.test(text)) return null;
  const url = hasScheme ? text : `http://127.0.0.1${CALLBACK_PATH}?${text.replace(/^\?/, '')}`;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.pathname && !parsed.pathname.endsWith(CALLBACK_PATH)) return null;
  const params = parsed.searchParams.toString();
  if (!params) return null;
  return `?${params}`;
}
