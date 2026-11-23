// Tool adapters for /api/agent. Every tool returns a plain string that is fed
// back to the model, so the output format matters: keep it compact (free-tier
// context is small) and always say what failed, in words the model can act on.
//
// Nothing here executes code, touches a filesystem, or writes anything. The
// agent can read the public web and load its own instruction files — that's it.

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 400_000;
const MAX_RESULT_CHARS = 6_000;

export const MAX_SEARCH_QUERY_CHARS = 300;

export function isHttpUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return false;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

// Literal private-network check on the hostname only. DNS rebinding is out of
// scope for a page-reading tool; Cloudflare's egress blocks the rest.
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  }
  return false;
}

export function htmlToText(html) {
  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return stripped
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const key = entity.toLowerCase();
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16) || 32);
      if (key.startsWith('#')) return String.fromCodePoint(Number.parseInt(key.slice(1), 10) || 32);
      return named[key] ?? match;
    })
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncateResult(text, limit = MAX_RESULT_CHARS) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n…[dipotong: ${value.length - limit} karakter tidak ditampilkan]`;
}

export function formatSources(results, limit = 8) {
  const rows = (results || []).slice(0, limit);
  if (!rows.length) return 'Tidak ada hasil.';
  return rows.map((row, index) => {
    const snippet = truncateResult(row.snippet || row.excerpt || '', 400).replace(/\n+/g, ' ');
    return `${index + 1}. ${row.title}\n   ${row.url}\n   ${snippet}`;
  }).join('\n');
}

export async function runWebSearch(args, { search } = {}) {
  const q = String(args?.query || '').trim();
  if (!q) return 'Alat gagal: `query` kosong. Isi kata kunci pencarian.';
  if (q.length > MAX_SEARCH_QUERY_CHARS) return `Alat gagal: \`query\` melebihi ${MAX_SEARCH_QUERY_CHARS} karakter; persempit pencarian.`;
  if (typeof search !== 'function') return 'Alat gagal: pencarian web tidak tersedia di server ini.';
  const results = await search(q);
  if (!results?.length) return `Tidak ada hasil untuk "${q}". Coba kata kunci lain, atau jawab dengan menyebut keterbatasan data.`;
  return `Hasil pencarian untuk "${q}":\n${formatSources(results)}`;
}

export async function runReadUrl(args, { fetchImpl = fetch } = {}) {
  const raw = String(args?.url || '').trim();
  if (!isHttpUrl(raw)) return 'Alat gagal: `url` harus diawali http:// atau https://.';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return 'Alat gagal: `url` tidak valid.';
  }
  if (isPrivateHost(parsed.hostname)) return 'Alat gagal: alamat jaringan privat tidak diizinkan.';

  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'user-agent': 'Mozilla/5.0 (compatible; BLEA-Agent/1.0; +https://blea.ai)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    return `Alat gagal mengambil halaman: ${String(error?.message || error).slice(0, 200)}`;
  }
  if (!response.ok) return `Alat gagal: server membalas HTTP ${response.status}.`;

  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  const rawBody = await response.text().catch(() => '');
  if (rawBody.length > MAX_PAGE_BYTES) return `Alat gagal: halaman terlalu besar (${rawBody.length} byte).`;

  const isTextual = contentType.includes('text/') || contentType.includes('html') || contentType.includes('json') || contentType.includes('xml');
  if (!isTextual) return `Alat gagal: tipe konten "${contentType || 'tidak diketahui'}" bukan teks.`;

  const isHtml = contentType.includes('html') || /^\s*<(!doctype|html)/i.test(rawBody.slice(0, 200));
  const text = isHtml ? htmlToText(rawBody) : rawBody;
  if (!text.trim()) return `Halaman ${parsed.toString()} tidak memuat teks yang bisa dibaca (kemungkinan dirender dengan JavaScript).`;
  return `Isi ${parsed.toString()}:\n\n${truncateResult(text)}`;
}

export async function runLoadSkill(args, { loadSkillSection, availableSkillIds = [] } = {}) {
  const skillId = String(args?.skill || '').trim();
  const resourceId = String(args?.resource || '').trim();
  if (!availableSkillIds.includes(skillId)) {
    return `Alat gagal: skill "${skillId}" tidak tersedia. Pilihan: ${availableSkillIds.join(', ')}.`;
  }
  try {
    return await loadSkillSection(skillId, { resourceId });
  } catch (error) {
    return `Alat gagal memuat skill: ${String(error?.message || error).slice(0, 200)}`;
  }
}

export const AGENT_TOOL_DEFINITIONS = [
  {
    name: 'web_search',
    description: 'Cari informasi terkini di web.',
    run: runWebSearch,
    describe: (args) => `"${String(args?.query || '').slice(0, 120)}"`,
    summarize: (result) => {
      const count = (String(result).match(/^\d+\. /gm) || []).length;
      return count ? `${count} sumber` : 'tanpa hasil';
    },
  },
  {
    name: 'read_url',
    description: 'Ambil isi satu halaman web publik.',
    run: runReadUrl,
    describe: (args) => {
      try {
        return new URL(String(args?.url || '')).host;
      } catch {
        return String(args?.url || '').slice(0, 60);
      }
    },
    summarize: (result, args) => (String(result).startsWith('Alat gagal') ? 'gagal' : `${String(result).length} karakter dari ${String(args?.url || 'halaman')}`),
  },
  {
    name: 'load_skill',
    description: 'Muat panduan skill pihak ketiga yang tersedia.',
    run: runLoadSkill,
    describe: (args) => [args?.skill, args?.resource].filter(Boolean).join(' · '),
    summarize: (result, args) => `${String(args?.skill || 'skill')} dimuat (${String(result).length} karakter)`,
  },
];

export function findAgentTool(name) {
  return AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name) || null;
}

export const AGENT_TOOL_NAMES = AGENT_TOOL_DEFINITIONS.map((tool) => tool.name);

/** Parse the first ```tool block out of a model reply. */
export function parseAgentToolCall(text) {
  const match = /```tool\s*([\s\S]*?)```/.exec(String(text || ''));
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1].trim());
  } catch {
    return { name: '', arguments: {}, error: 'JSON tidak valid' };
  }
  const name = String(parsed?.name || '').trim();
  if (!name) return { name: '', arguments: {}, error: 'tanpa field `name`' };
  return {
    name,
    arguments: parsed?.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {},
  };
}

export function stripAgentToolCalls(text) {
  return String(text || '')
    .replace(/```tool\s*[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
