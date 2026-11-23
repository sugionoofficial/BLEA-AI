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
    // Tanpa eksekusi: hanya mengusulkan. Halaman menampilkan tombol konfirmasi.
    name: 'propose_clips',
    description: 'Usulkan rentang klip dari video yang sudah dianalisis. Butuh konfirmasi pengguna.',
    run: async (args) => {
      const result = normalizeClipProposal(args);
      if (result.error) return `Alat gagal: ${result.error}`;
      return `Rencana klip tersimpan (menunggu konfirmasi pengguna):\n${result.clips
        .map((clip) => `${clip.index}. ${clip.startSec}–${clip.endSec}s${clip.title ? ` — ${clip.title}` : ''}${clip.reason ? ` (${clip.reason})` : ''}`)
        .join('\n')}`;
    },
    describe: (args) => `${Array.isArray(args?.clips) ? args.clips.length : 0} klip`,
    summarize: (result, args) => `${Array.isArray(args?.clips) ? args.clips.length : 0} klip diusulkan`,
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

// ---------------------------------------------------------------- lampiran
//
// Lampiran dari /agent dan /studio masuk ke prompt sebagai URL. Worker tidak
// bisa menakar ukuran byte tanpa mengunduh berkasnya (mahal dan tanpa manfaat),
// jadi yang divalidasi adalah hal-hal yang bisa dipalsukan dan berdampak:
// jumlah, bentuk URL, dan kepemilikan path di bucket BLEA. Batas 100MB adalah
// urusan klien saat mengunggah; lihat src/lib/uploads.js.
export const MAX_ATTACHMENTS = 6;
// Path public bucket BLEA. Tidak ada allowlist host: proyek bisa memakai domain
// kustom atau lokal, dan batas keamanan yang sebenarnya adalah path bucket +
// prefiks user di bawah ini, bukan nama host.
const ATTACHMENT_BUCKET_PATH = '/storage/v1/object/public/ai-studio-uploads/';

export function normalizeAgentAttachments(raw, userId = '') {
  if (!Array.isArray(raw) || !raw.length) return { items: [] };
  if (raw.length > MAX_ATTACHMENTS) {
    return { error: `Maksimal ${MAX_ATTACHMENTS} lampiran per pesan.` };
  }
  const items = [];
  for (const entry of raw) {
    const url = String(entry?.url || '').trim();
    if (!isHttpUrl(url)) return { error: 'Lampiran harus berupa URL https yang sah.' };
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { error: 'Lampiran harus berupa URL https yang sah.' };
    }
    if (isPrivateHost(parsed.hostname)) return { error: 'Lampiran tidak boleh menunjuk jaringan privat.' };
    // Wajib berada di bucket unggahan BLEA: mencegah agen dijadikan proxy untuk
    // menyuruh provider mengambil URL sembarangan.
    if (!parsed.pathname.includes(ATTACHMENT_BUCKET_PATH)) {
      return { error: 'Lampiran harus berkas yang diunggah lewat BLEA.' };
    }
    // Path per pengguna (migrasi 20261111000006): <user_id>/<...>. Path milik
    // akun lain ditolak supaya tidak bisa dipakai membaca unggahan orang lain.
    if (userId) {
      const objectPath = decodeURIComponent(parsed.pathname.split(ATTACHMENT_BUCKET_PATH)[1] || '');
      if (!objectPath.startsWith(`${userId}/`)) return { error: 'Lampiran bukan milik akun ini.' };
    }
    items.push({
      name: String(entry?.name || 'lampiran').slice(0, 120),
      kind: ['image', 'video', 'audio'].includes(entry?.kind) ? entry.kind : 'file',
      type: String(entry?.type || '').slice(0, 120),
      size: Number(entry?.size) || 0,
      url,
    });
  }
  return { items };
}

export function buildAttachmentContent(text, attachments = []) {
  const parts = [{ type: 'text', text }];
  for (const attachment of attachments) {
    if (!attachment?.url) continue;
    if (attachment.kind === 'image') {
      parts.push({ type: 'image_url', image_url: { url: attachment.url } });
    } else {
      const size = attachment.size ? `, ${Math.round(attachment.size / 1024)} KB` : '';
      parts.push({ type: 'text', text: `[Lampiran ${attachment.kind}: ${attachment.name}${size}](${attachment.url})` });
    }
  }
  return parts;
}

// ---------------------------------------------------------------- klip video
//
// Alat ini TIDAK memotong apa pun. Ia hanya menyimpan rencana klip (rentang
// waktu + alasan) sebagai event agar halaman bisa menampilkan tombol konfirmasi.
// Pemotongan berjalan di browser (src/lib/mediaTrim.js) setelah pengguna setuju,
// karena Worker tidak punya ffmpeg dan tidak bisa men-decode video.
const CLIP_TOOL_MAX = 6;

export function normalizeClipProposal(args, { durationSec } = {}) {
  const clips = Array.isArray(args?.clips) ? args.clips : [];
  if (!clips.length) return { error: 'Rencana klip kosong.' };
  const duration = Number(durationSec) || Number(args?.durationSec) || 0;
  const cleaned = [];
  for (const clip of clips.slice(0, CLIP_TOOL_MAX)) {
    const start = Number(clip?.startSec);
    const end = Number(clip?.endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { error: 'Rentang klip harus berupa angka detik.' };
    if (start < 0 || end <= start) return { error: `Klip ${cleaned.length + 1} punya rentang tidak sah.` };
    if (duration && start >= duration) return { error: `Klip ${cleaned.length + 1} mulai di luar durasi video.` };
    const safeEnd = duration ? Math.min(end, duration) : end;
    if (safeEnd - start < 2) return { error: `Klip ${cleaned.length + 1} terlalu pendek (< 2 detik).` };
    if (safeEnd - start > 60) return { error: `Klip ${cleaned.length + 1} lebih dari 60 detik.` };
    cleaned.push({
      index: cleaned.length + 1,
      startSec: Math.round(start * 100) / 100,
      endSec: Math.round(safeEnd * 100) / 100,
      durationSec: Math.round((safeEnd - start) * 100) / 100,
      title: String(clip?.title || '').slice(0, 80),
      reason: String(clip?.reason || '').slice(0, 200),
    });
  }
  return { clips: cleaned };
}

export function describeClipProposal(clips) {
  if (!clips?.length) return 'tidak ada klip';
  return clips.map((clip) => `${clip.startSec}-${clip.endSec}s`).join(', ');
}

/**
 * Digest analisis video dikirim oleh browser, jadi bentuknya diperiksa ketat
 * sebelum masuk system prompt. Nilai yang tidak masuk akal dibuang; teks bebas
 * dibatasi panjangnya supaya tidak bisa dipakai menyelipkan instruksi.
 */
export const MAX_VIDEO_ANALYSIS_CHARS = 1_800;

export function normalizeVideoAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return { text: '', durationSec: 0 };
  const durationSec = Number(raw.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return { text: '', durationSec: 0 };

  const nums = (list, limit) => (Array.isArray(list) ? list : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 86_400)
    .slice(0, limit);

  const sceneCuts = nums(raw.sceneCuts, 40);
  const peaks = nums(raw.audio?.peaks, 24);
  const silence = nums(raw.audio?.silence, 16);

  const lines = [
    `Durasi video: ${Math.round(durationSec * 100) / 100} detik`,
    raw.width && raw.height ? `Resolusi: ${Number(raw.width)}x${Number(raw.height)}` : '',
    `Scene cut (detik): ${sceneCuts.length ? sceneCuts.join(', ') : 'tidak terdeteksi'}`,
    peaks.length ? `Lonjakan energi audio (detik): ${peaks.join(', ')}` : 'Lonjakan audio: tidak terdeteksi',
    silence.length ? `Bagian hening (detik): ${silence.slice(0, 12).join(', ')}` : '',
    raw.truncated ? `Catatan: hanya bagian awal video yang dianalisis.` : '',
  ].filter(Boolean);

  return {
    text: lines.join('\n').slice(0, MAX_VIDEO_ANALYSIS_CHARS),
    durationSec: Math.round(durationSec * 100) / 100,
  };
}
