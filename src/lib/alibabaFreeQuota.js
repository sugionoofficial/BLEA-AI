// Katalog statis model Alibaba Cloud Model Studio yang menerbitkan free quota,
// sesuai dokumentasi resmi & halaman resmi Alibaba Cloud (diperiksa Nov 2026).
// Dikelompokkan per kategori agar bisa ditampilkan di Admin Panel → Alibaba
// Cloud → Katalog Free Quota, dan dipakai worker untuk daftar model Alibaba.
//
// CATATAN REGION: sebagian free quota hanya berlaku di China (Beijing);
// halaman kampanye internasional (ap-southeast-1) menampilkan angka tersendiri.
// Wan3.0-Video: kampanye marketing menyebut free quota 30 detik/90 hari di
// Singapore, sementara halaman pricing resmi menyebut tidak ada free quota di
// China (Beijing). Selalu verifikasi di konsol sebelum bergantung pada kuota.
//
// `blea` menandai bagaimana model terhubung di BLEA:
//   'video' → terhubung (wan3.0-video), 'chat' → bisa diaktifkan untuk AI Studio,
//   'image' → bisa diaktifkan untuk Generate Image (wan2.7-image, wan2.7-image-pro,
//             qwen-image-3.0, qwen-image-3.0-pro — aktifkan di Katalog Model +
//             tetapkan harga di Admin → Kredit),
//   null    → katalog saja (belum ada jalur generasi di BLEA).

export const ALIBABA_FREE_QUOTA_DOCS = 'https://help.aliyun.com/en/model-studio/model-pricing';

export const ALIBABA_FREE_QUOTA_CATEGORIES = [
  { id: 'Text', label: 'LLM / Teks' },
  { id: 'Image', label: 'Gambar' },
  { id: 'Video', label: 'Video' },
  { id: 'Speech', label: 'Speech & ASR' },
];

export const ALIBABA_FREE_QUOTA_MODELS = [
  // ---- LLM / Teks (1 juta token per model, 90 hari) ----
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Flagship multimodal reasoning, context 1M token.', docs: 'https://help.aliyun.com/en/model-studio/model-list' },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Cost-optimal multimodal, context 1M token.' },
  { id: 'qwen3.8-omni-flash', name: 'Qwen3.8-Omni-Flash', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Omni-modal (audio-visual), context 1M token.' },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Flagship; agent/programming; context 1M token.' },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Vision-language; agent/tool use/GUI; context 1M token.' },
  { id: 'qwen3.5-plus', name: 'Qwen3.5-Plus', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Hybrid-architecture Plus; context 1M token.' },
  { id: 'qwen3.5-omni-plus', name: 'Qwen3.5-Omni-Plus', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Omni-modal; context 262K token.' },
  { id: 'qwen4-max', name: 'Qwen4-Max', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Max output 393K token.' },
  { id: 'qwen3-livetranslate-flash', name: 'Qwen3-LiveTranslate-Flash', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: 'chat', note: 'Realtime terjemahan audio/video 19 bahasa.' },
  { id: 'gui-plus', name: 'GUI-Plus', category: 'Text', freeQuota: '1 juta token (input & output masing-masing) / 90 hari', blea: null, note: 'Otomasi UI interaction; context 256K token.' },
  { id: 'qwen-flash', name: 'Qwen-Flash', category: 'Text', freeQuota: '1 juta token / 90 hari (khusus China Beijing)', blea: 'chat', note: 'Free quota hanya tersedia region China (Beijing).' },
  { id: 'qwen3-vl-plus', name: 'Qwen3-VL-Plus (visual understanding)', category: 'Text', freeQuota: '1 juta token / 90 hari', blea: null, note: 'Pemahaman gambar/video; Beijing & Singapore.' },

  // ---- Gambar ----
  { id: 'qwen-image-3.0-pro', name: 'Qwen-Image-3.0-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'Text-to-image & editing; 4.5k-token layouts; 12 bahasa. Sinkron & async.' },
  { id: 'qwen-image-3.0', name: 'Qwen-Image-3.0', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'Text-to-image & editing; sinkron & async.' },
  { id: 'qwen-image-2.1-pro', name: 'Qwen-Image-2.1-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: null, note: 'Output price 0.25 CNY/gambar setelah kuota habis.' },
  { id: 'qwen-image-2.1-turbo', name: 'Qwen-Image-2.1-Turbo', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'T2I; messages async (image-generation); n 1-6 (keluarga 2.0); default 2048*2048. 0.1 CNY/gambar setelah kuota habis.' },
  // ---- Tambahan dari konsol pengguna (screenshot free quota, 20/11/2026) ----
  { id: 'qwen-image-2.0', name: 'Qwen-Image-2.0', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I; messages async (image-generation); n 1-6; ukuran W*H 512-2048 (default 2048*2048).' },
  { id: 'qwen-image-2.0-2026-03-03', name: 'Qwen-Image-2.0 (2026-03-03)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0; parameter sama.' },
  { id: 'qwen-image-2.0-pro', name: 'Qwen-Image-2.0-Pro', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I; messages async; n 1-6; default 2048*2048.' },
  { id: 'qwen-image-2.0-pro-2026-03-03', name: 'Qwen-Image-2.0-Pro (2026-03-03)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0-pro.' },
  { id: 'qwen-image-2.0-pro-2026-04-22', name: 'Qwen-Image-2.0-Pro (2026-04-22)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0-pro.' },
  { id: 'qwen-image-2.0-pro-2026-06-22', name: 'Qwen-Image-2.0-Pro (2026-06-22)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0-pro.' },
  { id: 'qwen-image-2.1-pro', name: 'Qwen-Image-2.1-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'T2I; messages async; n 1-6 (keluarga 2.0); default 2048*2048.' },
  { id: 'wan2.6-t2i', name: 'Wan2.6-T2I', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'T2I; messages async (image-generation); n 1-4; 1280*1280 s/d 1440*1440.' },
  { id: 'wan2.6-image', name: 'Wan2.6-Image', category: 'Image', freeQuota: '47 / 50 gambar', blea: null, note: 'T2I & editing; endpoint sama dgn wan2.7-image tapi parameter/size belum diverifikasi di BLEA; katalog saja.' },
  { id: 'wan2.2-t2i-plus', name: 'Wan2.2-T2I-Plus', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: null, note: 'T2I; endpoint text2image/image-synthesis (prompt-string); adapter terpisah belum ada.' },
  { id: 'wan2.2-t2i-flash', name: 'Wan2.2-T2I-Flash', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: null, note: 'T2I; endpoint belum diverifikasi; katalog saja.' },
  { id: 'wan2.1-t2i-plus', name: 'Wan2.1-T2I-Plus', category: 'Image', freeQuota: '200 gambar / 90 hari', blea: null, note: 'T2I; legacy text2image/image-synthesis (prompt-string, max 500 karakter); adapter terpisah belum ada.' },
  { id: 'wan2.1-t2i-turbo', name: 'Wan2.1-T2I-Turbo', category: 'Image', freeQuota: '200 gambar / 90 hari', blea: null, note: 'T2I; legacy text2image/image-synthesis (prompt-string); adapter terpisah belum ada.' },
  { id: 'wan2.5-t2i-preview', name: 'Wan2.5-T2I-Preview', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: null, note: 'Preview; endpoint/parameter belum diverifikasi; katalog saja.' },
  { id: 'wan2.5-i2i-preview', name: 'Wan2.5-I2I-Preview', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: null, note: 'Image-to-image (editing); belum diverifikasi; katalog saja.' },
  { id: 'z-image-turbo', name: 'Z-Image-Turbo', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: null, note: 'Belum ada docs terverifikasi di BLEA; katalog saja.' },
  { id: 'qwen-mt-image-2.0', name: 'Qwen-MT-Image-2.0', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: null, note: 'Qwen-MT: terjemahan teks di dalam gambar, bukan T2I umum; tidak untuk Generate Image.' },
  // ---- Video (output video; daftar terpisah dari model chat) ----
  { id: 'happyhorse-1.0-video-edit', name: 'HappyHorse 1.0 (Video Edit)', category: 'Video', freeQuota: '10 video / 90 hari (kampanye)', blea: null, note: 'Edit video kampanye; API & parameter belum diverifikasi; belum ada adapter.' },
  { id: 'wan2.1-kf2iv-plus', name: 'Wan2.1-KF2IV-Plus', category: 'Video', freeQuota: '200 video / 90 hari', blea: null, note: 'Keyframe-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.1-i2v-plus', name: 'Wan2.1-I2V-Plus', category: 'Video', freeQuota: '200 video / 90 hari', blea: null, note: 'Image-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.1-i2v-turbo', name: 'Wan2.1-I2V-Turbo', category: 'Video', freeQuota: '200 video / 90 hari', blea: null, note: 'Image-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.1-t2v-plus', name: 'Wan2.1-T2V-Plus', category: 'Video', freeQuota: '200 video / 90 hari', blea: null, note: 'Text-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.1-t2v-turbo', name: 'Wan2.1-T2V-Turbo', category: 'Video', freeQuota: '200 video / 90 hari', blea: null, note: 'Text-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.1-vace-plus', name: 'Wan2.1-VACE-Plus', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'VACE (video creation/edit); API berbeda dari Wan 3.0; belum ada adapter.' },
  { id: 'wan2.2-i2v-plus', name: 'Wan2.2-I2V-Plus', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'Image-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.2-i2v-flash', name: 'Wan2.2-I2V-Flash', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'Image-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.2-t2v-plus', name: 'Wan2.2-T2V-Plus', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'Text-to-video (legacy); belum ada adapter/verifikasi; katalog saja.' },
  { id: 'wan2.2-animate-move', name: 'Wan2.2-Animate-Move', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'Animate karakter (image-to-animation); API berbeda; belum ada adapter.' },
  { id: 'wan2.2-animate-mix', name: 'Wan2.2-Animate-Mix', category: 'Video', freeQuota: '38.28 / 50 video', blea: null, note: 'Animate mix (image-to-animation); API berbeda; belum ada adapter.' },
  { id: 'wan2.5-t2v-preview', name: 'Wan2.5-T2V-Preview', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'Preview t2v; endpoint/parameter belum diverifikasi; katalog saja.' },
  { id: 'wan2.5-i2v-preview', name: 'Wan2.5-I2V-Preview', category: 'Video', freeQuota: '50 video / 90 hari', blea: null, note: 'Preview i2v; endpoint/parameter belum diverifikasi; katalog saja.' },
  { id: 'wan2.6-i2v', name: 'Wan2.6-I2V', category: 'Video', freeQuota: '30 / 50 video', blea: null, note: 'Image-to-video; parameter belum diverifikasi di BLEA; katalog saja.' },
  { id: 'wan2.6-i2v-flash', name: 'Wan2.6-I2V-Flash', category: 'Video', freeQuota: '40 / 50 video', blea: null, note: 'Image-to-video flash; parameter belum diverifikasi di BLEA; katalog saja.' },
  { id: 'wan2.6-r2v', name: 'Wan2.6-R2V', category: 'Video', freeQuota: '25 / 50 video', blea: null, note: 'Reference-to-video; parameter belum diverifikasi di BLEA; katalog saja.' },
  { id: 'wan2.6-r2v-flash', name: 'Wan2.6-R2V-Flash', category: 'Video', freeQuota: '37.5 / 50 video', blea: null, note: 'Reference-to-video flash; parameter belum diverifikasi di BLEA; katalog saja.' },
  { id: 'wan2.7-image', name: 'Wan2.7-Image', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'Text-to-image & editing; RPM 300.' },
  { id: 'wan2.7-image-pro', name: 'Wan2.7-Image-Pro', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'Text rendering & subject consistency; 0.075 USD/gambar.' },

  // ---- Video ----
  { id: 'wan3.0-video', name: 'Wan 3.0 Video', category: 'Video', freeQuota: '30 detik / 90 hari (Singapore/internasional)', blea: 'video', note: 'T2V, I2V (first/last frame), referensi; hingga 30 detik. Pricing China: tidak ada free quota.', docs: 'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference' },
  { id: 'happyhorse-1.1-i2v', name: 'HappyHorse 1.1 (Image-to-Video)', category: 'Video', freeQuota: '10 detik / 90 hari (kampanye)', blea: null, note: 'i2v: Alibaba menolak media reference_image — hanya media type first_frame (terverifikasi 2026-11-20). Belum ada adapter di BLEA; jangan diaktifkan untuk pengguna.', verifiedId: false },
  { id: 'happyhorse-1.1-t2v', name: 'HappyHorse 1.1 (Text-to-Video)', category: 'Video', freeQuota: '10 detik / 90 hari (kampanye)', blea: null, note: 'Text-to-video kampanye; belum diuji adapter di BLEA; katalog saja.', verifiedId: false },

  // ---- Speech & ASR ----
  { id: 'qwen3-tts-flash', name: 'Qwen3-TTS-Flash', category: 'Speech', freeQuota: '10.000 karakter / 90 hari', blea: null, note: 'Text-to-speech; endpoint multimodal-generation/generation; output 24.000 Hz.' },
  { id: 'qwen-tts-flash', name: 'Qwen-TTS-Flash', category: 'Speech', freeQuota: '1 juta token / 90 hari', blea: null, note: 'Token-based TTS; CNY 1.6 input / CNY 10 output per 1M token.' },
  { id: 'qwen3-asr-flash', name: 'Qwen3-ASR-Flash', category: 'Speech', freeQuota: '36.000 detik / 90 hari', blea: null, note: 'Multilingual speech recognition; deteksi bahasa otomatis 11 bahasa.' },
  { id: 'qwen3-asr-flash-realtime', name: 'Qwen3-ASR-Flash-Realtime', category: 'Speech', freeQuota: '36.000 detik / 90 hari', blea: null, note: 'Versi realtime dari Qwen3-ASR-Flash.' },
];
