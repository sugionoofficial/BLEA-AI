// Katalog tool Studio: satu entri per kemampuan yang benar-benar ada di mesin
// BLEA. Ini bukan daftar fitur ChatGPT — setiap entri harus punya rute yang
// jalan, kalau tidak ia hanya tombol yang mengecewakan.
//
// Field `capabilities`: rute API yang boleh dipanggil dari ruang tool ini
// (lihat src/lib/toolCapabilities.js). Satu tool hanya menjalankan fungsinya
// sendiri — ruang gambar tidak bisa memicu video, ruang riset tidak bisa
// menghasilkan klip. Pemisahan ini bukan kosmetik: biaya kredit, kredensial
// provider, dan tabel riwayat tiap tool berbeda.
//
// Field `status`:
//   'ready'    — bisa dipakai sekarang.
//   'degraded' — jalan, tapi ada syarat (mis. OAuth provider terputus).
//   'soon'     — belum diimplementasikan; tetap tampil, tetapi tidak bisa diklik.

export const STUDIO_TOOL_STATUS = {
  ready: 'Siap',
  degraded: 'Terbatas',
  soon: 'Segera',
};

export const STUDIO_TOOLS = [
  {
    id: 'chat',
    label: 'Chat & Tulis',
    href: '/studio/chat',
    icon: 'MessageSquare',
    group: 'Teks',
    description: 'Percakapan, penulisan, ringkasan, dan penyuntingan teks.',
    skills: ['frontend-design', 'internal-comms', 'web-artifacts-builder'],
    note: 'Model chat yang aktif + riwayat percakapan.',
    capabilities: ['chat'],
    status: 'ready',
    cta: 'Buka ruang chat',
  },
  {
    id: 'agent',
    label: 'Agen Otonom',
    href: '/studio/agent',
    icon: 'Bot',
    group: 'Teks',
    description: 'Satu agen yang mengerjakan tugas bertahap: riset, tulis, rancang.',
    skills: ['web_search', 'read_url', 'load_skill', 'propose_clips'],
    note: 'Maksimal 3 putaran alat per giliran; setiap langkah tampil di feed.',
    capabilities: ['agent', 'search'],
    status: 'ready',
    cta: 'Buka ruang agen',
  },
  {
    id: 'image',
    label: 'Buat Gambar',
    href: '/studio/image',
    icon: 'Image',
    group: 'Visual',
    description: 'Text-to-image dengan model ChatGPT (gpt-image-1).',
    skills: ['prompt-gambar', 'rasio & ukuran', 'referensi gambar'],
    note: 'Dibuat lewat pool akun ChatGPT. Kuota akun, bukan kredit BLEA.',
    capabilities: ['image'],
    status: 'ready',
    cta: 'Buka ruang gambar',
  },
  {
    id: 'video',
    label: 'Buat Video',
    href: '/studio/video',
    icon: 'Clapperboard',
    group: 'Visual',
    description: 'Video dari teks, gambar, atau klip yang sudah ada.',
    skills: ['prompt-video', 'durasi & rasio', 'image-to-video'],
    note: 'Dibuat lewat pool akun ChatGPT (Sora). Kuota akun, bukan kredit BLEA.',
    capabilities: ['video'],
    status: 'ready',
    cta: 'Buka ruang video',
  },
  {
    id: 'music',
    label: 'Buat Musik',
    href: '/studio/music',
    icon: 'Music',
    group: 'Audio',
    description: 'Musik dan vokal dari deskripsi teks.',
    skills: ['genre & mood', 'lirik', 'durasi'],
    note: 'Sama seperti video: bergantung provider musik yang aktif.',
    capabilities: ['music'],
    status: 'degraded',
    cta: 'Buka ruang musik',
  },
  {
    id: 'clip',
    label: 'Klip & Subtitle',
    href: '/studio/agent',
    icon: 'Scissors',
    group: 'Video',
    description: 'Cari hook, potong klip, transkrip ASR, lalu bakar subtitle ke video.',
    skills: ['scene-cut', 'energi audio', 'Whisper ASR', '4 template subtitle'],
    note: 'Pemotongan dan burn-in berjalan di browser (realtime), bukan di server.',
    capabilities: ['agent', 'search', 'audio'],
    status: 'ready',
    cta: 'Buka ruang klip',
  },
  {
    id: 'metadata',
    label: 'Cek Metadata',
    href: '/studio/metadata',
    icon: 'FileSearch2',
    group: 'Utilitas',
    description: 'Pindai dan bersihkan metadata buatan AI dari gambar atau video.',
    skills: ['EXIF/XMP', 'C2PA', 'deteksi generator'],
    note: 'Pemindaian AI memakai Workers AI / model vision aktif.',
    capabilities: ['metadata'],
    status: 'ready',
    cta: 'Buka pemindai',
  },
  {
    id: 'research',
    label: 'Riset Web',
    href: '/studio/agent',
    icon: 'Globe',
    group: 'Teks',
    description: 'Cari sumber di web, baca halaman, lalu rangkum dengan kutipan.',
    skills: ['web_search', 'read_url', 'kutipan sumber'],
    note: 'Hasil pencarian bisa usang atau salah; selalu periksa sumbernya.',
    capabilities: ['agent', 'search'],
    status: 'ready',
    cta: 'Mulai riset',
  },
  {
    id: 'code',
    label: 'Bantuan Kode',
    href: '/studio/chat',
    icon: 'Code',
    group: 'Teks',
    description: 'Menulis, menjelaskan, dan men-debug kode.',
    skills: ['frontend-design', 'web-artifacts-builder'],
    note: 'Tidak ada eksekusi kode di server; hasilnya berupa teks.',
    capabilities: ['chat'],
    status: 'ready',
    cta: 'Buka ruang kode',
  },
  {
    id: 'analyze-file',
    label: 'Analisis Berkas',
    href: '/studio/agent',
    icon: 'FileText',
    group: 'Utilitas',
    description: 'Unggah gambar, video, audio, atau dokumen lalu tanya isinya.',
    skills: ['lampiran 100MB', 'vision', 'transkrip'],
    note: 'Gambar dibaca model vision; video/audio lewat transkrip, bukan ditonton.',
    capabilities: ['agent', 'search', 'audio'],
    status: 'ready',
    cta: 'Unggah berkas',
  },
  {
    id: 'study',
    label: 'Belajar & Jelaskan',
    href: '/studio/chat',
    icon: 'GraduationCap',
    group: 'Teks',
    description: 'Penjelasan bertahap, latihan soal, dan ringkasan materi.',
    skills: ['penjelasan bertahap', 'latihan soal'],
    note: 'Tanpa kurikulum resmi; kualitas bergantung model aktif.',
    capabilities: ['chat'],
    status: 'ready',
    cta: 'Mulai belajar',
  },
  {
    id: 'translate',
    label: 'Terjemah',
    href: '/studio/chat',
    icon: 'Languages',
    group: 'Teks',
    description: 'Terjemahan teks dan subtitle antar bahasa.',
    skills: ['terjemahan', 'SRT/VTT'],
    note: 'Belum ada mode terjemahan subtitle sekali klik; untuk sekarang lewat chat.',
    capabilities: ['chat'],
    status: 'ready',
    cta: 'Mulai terjemah',
  },
  {
    id: 'connect-ai',
    label: 'Koneksi AI Pihak Ketiga',
    href: '/studio/connection',
    icon: 'Plug',
    group: 'Koneksi',
    description: 'Menghubungkan penyedia AI milikmu sendiri lewat API key atau OAuth.',
    skills: ['provider API key', 'OAuth', 'pemilihan model'],
    note: 'BLEA hanya mendukung koneksi provider lewat API key/OAuth resmi. Membuat akun otomatis di layanan pihak ketiga tidak didukung.',
    capabilities: [],
    status: 'degraded',
    cta: 'Lihat koneksi',
  },
  {
    id: 'library',
    label: 'Hasil & Unduhan',
    href: '/studio/library',
    icon: 'FolderDown',
    group: 'Hasil',
    description: 'Semua hasil dari tool yang berbeda di satu tempat: salin teks, unduh media.',
    skills: ['gambar', 'video', 'musik', 'metadata', 'chat'],
    note: 'Hanya menampilkan hasil milikmu. Tautan unduhan bertanda tangan dan kedaluwarsa ±2 jam.',
    capabilities: ['library'],
    status: 'ready',
    cta: 'Buka hasil',
  },
];

/**
 * Kenapa tool Studio dipisah, bukan satu kotak "apa saja".
 *
 * Empat alasan yang menentukan desainnya:
 *   1. Biaya. Harga kredit tiap tool berbeda jauh (chat per giliran, gambar
 *      per gambar, video per detik). Satu kotak serba bisa membuat pengguna
 *      bisa membakar kredit mahal tanpa pernah membuka tool itu.
 *   2. Kredensial. Tiap provider punya kunci sendiri. Loop chat yang bebas
 *      memanggil tool gambar berarti kunci gambar terbuka untuk tugas yang
 *      tidak memintanya.
 *   3. Riwayat. Hasil tiap tool disimpan di tabelnya sendiri, jadi halaman
 *      Hasil bisa menampilkan dan mengunduh tanpa menebak-nebak.
 *   4. Prompt injection. Teks dari web/berkas hanya boleh memengaruhi tool
 *      yang sedang dipakai; ia tidak boleh tiba-tiba memicu generasi video.
 *
 * Diterapkan dua lapis: UI tidak menampilkan aksi lintas-tool, dan Worker
 * menolak panggilan API yang kapabilitasnya tidak dideklarasikan tool itu.
 */
export const TOOL_SEPARATION_REASONS = [
  {
    title: 'Biaya kredit berbeda per tool',
    body: 'Satu giliran chat, satu gambar, dan satu video 5 detik punya harga yang tidak sebanding. Kalau semuanya satu tombol, pengguna tidak tahu tool mana yang sedang menagih.',
  },
  {
    title: 'Kredensial provider terpisah',
    body: 'Kunci gambar, video, audio, dan chat berbeda. Tool yang tidak meminta gambar tidak boleh menyentuh kunci gambar.',
  },
  {
    title: 'Riwayat dan unduhan bisa dipercaya',
    body: 'Setiap tool menulis ke tabelnya sendiri (gambar, video, musik, metadata, chat), jadi daftar hasil tidak tercampur dan unduhan selalu menunjuk berkas yang benar.',
  },
  {
    title: 'Tahan prompt injection',
    body: 'Teks dari halaman web atau berkas hanya memengaruhi tool yang sedang dipakai. Agen riset tidak bisa tiba-tiba menjalankan generasi video.',
  },
];

export function toolsByGroup(tools = STUDIO_TOOLS) {
  const groups = [];
  for (const tool of tools) {
    let group = groups.find((item) => item.group === tool.group);
    if (!group) {
      group = { group: tool.group, tools: [] };
      groups.push(group);
    }
    group.tools.push(tool);
  }
  return groups;
}

export function findStudioTool(id) {
  return STUDIO_TOOLS.find((tool) => tool.id === id) || null;
}
