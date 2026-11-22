// Shared SSRF-safe remote media URL validator. Any Worker code that fetches a
// user-supplied or third-party-resolved HTTPS URL on the server (video/image/
// music content proxies, the social media resolver/proxy) must gate it
// through this check before calling fetch().
export function isSafeRemoteMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Cloudflare Workers' fetch() sends no User-Agent by default; Freebeat's media
// CDN (CloudFront) rejects empty-UA requests with a 403 "Request blocked" HTML
// page (see the 2026-11-22 music-streaming incident). Every subrequest that
// proxies already-trusted BLEA/Freebeat media must identify itself with this.
export const UPSTREAM_MEDIA_USER_AGENT = 'Mozilla/5.0 (compatible; BLEA-AI/1.0; +https://blea.ai)';

// A realistic desktop-Chrome User-Agent for requests to third-party downloader
// sites (getmyfb.com, ssstik.io) and social platform pages (facebook.com,
// tiktok.com) that bot-block or serve degraded markup to non-browser agents.
export const BROWSER_LIKE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
