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
  { id: 'qwen-image-3.0-pro', name: 'Qwen-Image-3.0-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: null, note: 'Text-to-image & editing; 4.5k-token layouts; 12 bahasa. Sinkron & async.' },
  { id: 'qwen-image-3.0', name: 'Qwen-Image-3.0', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: null, note: 'Text-to-image & editing; sinkron & async.' },
  { id: 'qwen-image-2.1-pro', name: 'Qwen-Image-2.1-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: null, note: 'Output price 0.25 CNY/gambar setelah kuota habis.' },
  { id: 'qwen-image-2.1-turbo', name: 'Qwen-Image-2.1-Turbo', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: null, note: 'Versi turbo; 0.1 CNY/gambar setelah kuota habis.' },
  { id: 'wan2.7-image', name: 'Wan2.7-Image', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: null, note: 'Text-to-image & editing; RPM 300.' },
  { id: 'wan2.7-image-pro', name: 'Wan2.7-Image-Pro', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: null, note: 'Text rendering & subject consistency; 0.075 USD/gambar.' },

  // ---- Video ----
  { id: 'wan3.0-video', name: 'Wan 3.0 Video', category: 'Video', freeQuota: '30 detik / 90 hari (Singapore/internasional)', blea: 'video', note: 'T2V, I2V (first/last frame), referensi; hingga 30 detik. Pricing China: tidak ada free quota.', docs: 'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference' },
  { id: 'happyhorse-1.1-i2v', name: 'HappyHorse 1.1 (Image-to-Video)', category: 'Video', freeQuota: '10 detik / 90 hari (kampanye)', blea: null, note: 'Reference-to-video; id API perlu dikonfirmasi di docs; katalog saja.', verifiedId: false },
  { id: 'happyhorse-1.1-t2v', name: 'HappyHorse 1.1 (Text-to-Video)', category: 'Video', freeQuota: '10 detik / 90 hari (kampanye)', blea: null, note: 'Text-to-video; id API perlu dikonfirmasi di docs; katalog saja.', verifiedId: false },

  // ---- Speech & ASR ----
  { id: 'qwen3-tts-flash', name: 'Qwen3-TTS-Flash', category: 'Speech', freeQuota: '10.000 karakter / 90 hari', blea: null, note: 'Text-to-speech; endpoint multimodal-generation/generation; output 24.000 Hz.' },
  { id: 'qwen-tts-flash', name: 'Qwen-TTS-Flash', category: 'Speech', freeQuota: '1 juta token / 90 hari', blea: null, note: 'Token-based TTS; CNY 1.6 input / CNY 10 output per 1M token.' },
  { id: 'qwen3-asr-flash', name: 'Qwen3-ASR-Flash', category: 'Speech', freeQuota: '36.000 detik / 90 hari', blea: null, note: 'Multilingual speech recognition; deteksi bahasa otomatis 11 bahasa.' },
  { id: 'qwen3-asr-flash-realtime', name: 'Qwen3-ASR-Flash-Realtime', category: 'Speech', freeQuota: '36.000 detik / 90 hari', blea: null, note: 'Versi realtime dari Qwen3-ASR-Flash.' },
];
