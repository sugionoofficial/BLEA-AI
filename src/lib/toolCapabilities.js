// Isolasi kapabilitas per tool Studio.
//
// Kenapa tool dipisah (bukan satu asisten serba bisa):
//   1. Uang. Tiap tool memotong kredit dengan harga berbeda. Satu tombol "apa
//      saja" berarti pengguna bisa tidak sengaja membakar kredit video 3000
//      hanya karena ia bertanya "buatkan video". Kapabilitas eksplisit membuat
//      biaya selalu mengikuti tool yang dibuka.
//   2. Kunci. Tool gambar/video memakai kredensial provider berbeda dari chat.
//      Kalau loop chat bebas memanggil tool gambar, kunci gambar ikut terbuka
//      untuk tugas yang tidak pernah memintanya.
//   3. Jejak & pemulihan. Hasil tiap tool disimpan di tabel sendiri
//      (image_generations, video_generations, metadata_jobs). Isolasi menjaga
//      satu tool tidak menulis ke tabel milik tool lain, jadi Riwayat dan
//      halaman Hasil tetap bisa dipercaya.
//   4. Prompt injection. Teks dari web/berkas hanya boleh memengaruhi tool yang
//      memang sedang dipakai. Agen riset yang tiba-tiba bisa menjalankan
//      generasi video adalah jalur eskalasi, bukan fitur.
//
// Aturan: satu entri per tool Studio. `capabilities` = rute API yang boleh
// dipanggil dari ruang itu. `agentTools` = alat yang boleh dijalankan loop agen
// di ruang itu (null berarti ruang itu tidak memakai loop agen).

export const TOOL_CAPABILITY_LABELS = {
  chat: 'Percakapan teks',
  agent: 'Loop agen bertahap',
  search: 'Pencarian & baca web',
  image: 'Generasi gambar',
  video: 'Generasi video',
  music: 'Generasi musik/audio',
  audio: 'Transkrip audio',
  metadata: 'Pemindaian metadata',
  library: 'Daftar hasil',
  admin: 'Pengelolaan akun',
};

export const STUDIO_TOOL_CAPABILITIES = {
  chat: { capabilities: ['chat'], agentTools: null },
  agent: { capabilities: ['agent', 'search'], agentTools: ['web_search', 'read_url', 'load_skill', 'propose_clips'] },
  image: { capabilities: ['image'], agentTools: null },
  video: { capabilities: ['video'], agentTools: null },
  music: { capabilities: ['music'], agentTools: null },
  clip: { capabilities: ['agent', 'search', 'audio'], agentTools: ['propose_clips', 'load_skill'] },
  metadata: { capabilities: ['metadata'], agentTools: null },
  research: { capabilities: ['agent', 'search'], agentTools: ['web_search', 'read_url', 'load_skill'] },
  code: { capabilities: ['chat'], agentTools: null },
  'analyze-file': { capabilities: ['agent', 'search', 'audio'], agentTools: ['web_search', 'read_url', 'load_skill'] },
  study: { capabilities: ['chat'], agentTools: null },
  translate: { capabilities: ['chat'], agentTools: null },
  'connect-ai': { capabilities: [], agentTools: null },
  library: { capabilities: ['library'], agentTools: null },
};

// Peta rute API → kapabilitas. Prefix terpanjang menang, supaya
// /api/agent/transcribe tidak dianggap bagian dari kapabilitas `agent`.
const API_CAPABILITY_RULES = [
  ['agent/transcribe', 'audio'],
  ['agent/skills', 'agent'],
  ['agent', 'agent'],
  ['search', 'search'],
  ['chat', 'chat'],
  ['image', 'image'],
  ['video', 'video'],
  ['music', 'music'],
  ['metadata', 'metadata'],
  ['library', 'library'],
];

export function capabilityForApiPath(path) {
  const clean = String(path || '').replace(/^\/?api\/?/, '').replace(/^\/+/, '');
  for (const [prefix, capability] of API_CAPABILITY_RULES) {
    if (clean === prefix || clean.startsWith(`${prefix}/`)) return capability;
  }
  return null;
}

export function studioToolCapabilities(toolId) {
  return STUDIO_TOOL_CAPABILITIES[String(toolId || '')] || null;
}

export function canToolUseCapability(toolId, capability) {
  const entry = studioToolCapabilities(toolId);
  if (!entry) return false;
  return entry.capabilities.includes(String(capability || ''));
}

export function agentToolsForStudioTool(toolId) {
  const entry = studioToolCapabilities(toolId);
  if (!entry) return null;
  return entry.agentTools;
}

/**
 * Alasan penolakan, dalam bahasa yang bisa ditampilkan ke pengguna.
 * `null` berarti permintaan boleh dilanjutkan.
 */
export function toolCapabilityViolation(toolId, apiPath) {
  const declared = String(toolId || '').trim();
  if (!declared) return null;
  const entry = studioToolCapabilities(declared);
  if (!entry) return { code: 'tool_unknown', message: `Tool Studio "${declared}" tidak dikenal.` };
  const capability = capabilityForApiPath(apiPath);
  if (!capability) return null;
  if (entry.capabilities.includes(capability)) return null;
  return {
    code: 'tool_capability_mismatch',
    message: `Ruang "${declared}" tidak boleh memanggil kapabilitas "${capability}". Setiap tool hanya menjalankan fungsinya sendiri.`,
    capability,
  };
}
