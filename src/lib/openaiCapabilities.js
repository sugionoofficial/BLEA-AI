// Kapabilitas akun OpenAI ↔ tool Studio.
//
// Satu daftar, tiga pemakai: validasi kolom `capabilities` di akun pool, pilihan
// centang di halaman Akun OpenAI, dan pemeriksaan isolasi tool di
// src/lib/toolCapabilities.js. Karena itu daftarnya ada di sini, bukan disalin
// ke tiap modul.
//
// `tool` = id tool Studio (lihat src/studio/toolCatalog.js), `api` = kemampuan
// platform OpenAI yang dipakai saat tool itu jalan. Kalau sebuah tool belum
// punya rute OpenAI di BLEA, `api` kosong dan `status` menjelaskan apa adanya —
// lebih baik "belum dipakai" daripada tombol yang mengecewakan.

export const OPENAI_CAPABILITIES = [
  'chat',
  'agent',
  'image',
  'video',
  'audio',
  'music',
  'metadata',
];

/**
 * Baris tabel "Kemampuan API" di platform.openai.com, dipetakan ke tool Studio.
 * Urutan mengikuti tab itu supaya mudah dicocokkan saat memeriksa billing.
 */
export const OPENAI_CAPABILITY_MATRIX = [
  {
    key: 'responses',
    platform: 'Respons dan penyelesaian obrolan',
    capability: 'chat',
    tool: 'chat',
    toolLabel: 'Chat & Tulis',
    api: 'POST /v1/responses',
    status: 'dipakai',
    note: 'Semua percakapan dan penulisan lewat jalur ini.',
  },
  {
    key: 'reasoning',
    platform: 'Keputusan (reasoning)',
    capability: 'agent',
    tool: 'agent',
    toolLabel: 'Agen Otonom',
    api: 'POST /v1/responses (model penalaran + loop alat)',
    status: 'dipakai',
    note: 'Loop agen: model memilih alat, BLEA yang menjalankan alatnya.',
  },
  {
    key: 'web-search',
    platform: 'Pencarian web',
    capability: 'agent',
    tool: 'agent',
    toolLabel: 'Agen Otonom & Riset',
    api: 'Alat web_search / read_url milik BLEA',
    status: 'dipakai',
    note: 'Dijalankan BLEA sendiri (DuckDuckGo + fetch halaman), bukan alat bawaan OpenAI.',
  },
  {
    key: 'images',
    platform: 'Gambar',
    capability: 'image',
    tool: 'image',
    toolLabel: 'Buat Gambar',
    api: 'POST /v1/images/generations',
    status: 'dipakai',
    note: 'Butuh API key; izin OAuth teks saja tidak cukup.',
  },
  {
    key: 'audio-speech',
    platform: 'Audio pidato (text-to-speech)',
    capability: 'audio',
    tool: 'clip',
    toolLabel: 'Klip & Subtitle',
    api: 'v1/audio/speech',
    status: 'belum-dipakai',
    note: 'Katalog model sudah memuat tts-1, tetapi belum ada rute BLEA yang memanggilnya.',
  },
  {
    key: 'audio-transcribe',
    platform: 'Transkripsi audio',
    capability: 'audio',
    tool: 'analyze-file',
    toolLabel: 'Analisis Berkas',
    api: 'Workers AI Whisper (env.AI)',
    status: 'dipakai',
    note: 'Transkrip berjalan di Workers AI, jadi tidak menagih kuota OpenAI.',
  },
  {
    key: 'embeddings',
    platform: 'Penyematan (embeddings)',
    capability: '',
    tool: '',
    toolLabel: '',
    api: 'v1/embeddings',
    status: 'belum-dipakai',
    note: 'Tidak ada tool Studio yang memakai embedding, jadi tidak ditawarkan sebagai centang.',
  },
  {
    key: 'files',
    platform: 'Pencarian file',
    capability: '',
    tool: '',
    toolLabel: '',
    api: 'v1/files + v1/vector_stores',
    status: 'belum-dipakai',
    note: 'Belum ada unggah berkas ke OpenAI; berkas dibaca langsung di browser.',
  },
  {
    key: 'moderation',
    platform: 'Moderasi',
    capability: '',
    tool: '',
    toolLabel: '',
    api: 'v1/moderations',
    status: 'belum-dipakai',
    note: 'Model vision di metadataJobs.js sudah menyaring model non-vision, bukan moderasi.',
  },
  {
    key: 'vector-stores',
    platform: 'Penyimpanan vektor',
    capability: '',
    tool: '',
    toolLabel: '',
    api: 'v1/vector_stores',
    status: 'belum-dipakai',
    note: 'Butuh pencarian file lebih dulu.',
  },
  {
    key: 'code-interpreter',
    platform: 'Sesi interpreter kode',
    capability: '',
    tool: '',
    toolLabel: '',
    api: 'POST /v1/responses (alat code_interpreter)',
    status: 'belum-dipakai',
    note: 'Ruang "Kode" memakai chat biasa; eksekusi kode terkendali belum ada.',
  },
  {
    key: 'containers',
    platform: 'Kontainer yang dihosting OpenAI',
    capability: '',
    tool: '',
    toolLabel: '',
    api: 'v1/containers',
    status: 'belum-dipakai',
    note: 'Menyusul interpreter kode.',
  },
];

/** Label kapabilitas yang tampil di form akun. */
export const OPENAI_CAPABILITY_LABELS = {
  chat: 'Chat & tulis (Respons API)',
  agent: 'Agen & penalaran',
  image: 'Gambar',
  video: 'Video (Sora)',
  audio: 'Audio & transkrip',
  music: 'Musik',
  metadata: 'Metadata',
  library: 'Daftar hasil',
};

/**
 * Kemampuan platform yang belum punya rute di BLEA. Ditampilkan di panel akun
 * supaya admin tahu kenapa tab "Kemampuan API" di platform tetap nol untuk
 * baris-baris ini.
 */
export function unpipedCapabilities() {
  return OPENAI_CAPABILITY_MATRIX.filter((row) => !row.capability).map((row) => ({
    platform: row.platform,
    api: row.api,
    note: row.note,
  }));
}

/** Kapabilitas yang benar-benar dipakai tool Studio (punya `capability`). */
export function wiredCapabilities() {
  return OPENAI_CAPABILITY_MATRIX.filter((row) => row.capability);
}

/** Baris matriks untuk satu kapabilitas pool (bisa lebih dari satu). */
export function capabilitiesForTool(toolId) {
  return OPENAI_CAPABILITY_MATRIX.filter((row) => row.capability && row.tool === toolId);
}
