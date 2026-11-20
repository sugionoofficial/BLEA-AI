// Katalog statis model Alibaba Cloud Model Studio yang menerbitkan free quota,
// sesuai dokumentasi resmi & halaman resmi Alibaba Cloud (diperiksa Nov 2026).
// Dikelompokkan per kategori agar bisa ditampilkan di Admin Panel → Alibaba
// Cloud → Katalog Free Quota, dan dipakai worker untuk daftar model Alibaba.
//
// CATATAN REGION: sebagian free quota hanya berlaku di China (Beijing);
// halaman kampanye internasional (ap-southeast-1) menampilkan angka tersendiri.
// Model Wan 2.1 otomatis dipetakan ke ID `wanx2.1-*` bila base URL menunjuk
// region China (cn-beijing / dashscope.aliyuncs.com). Selalu verifikasi di
// konsol sebelum bergantung pada kuota.
//
// `blea` menandai bagaimana model terhubung di BLEA:
//   'video' → memiliki adapter terverifikasi untuk Generate Video (aktifkan di Katalog Model)
//   'chat'  → bisa diaktifkan untuk AI Studio
//   'image' → memiliki adapter terverifikasi untuk Generate Image (aktifkan di
//             Katalog Model + tetapkan harga di Admin → Kredit)
//   null    → katalog saja (bukan model generasi gambar/video umum atau ID tidak valid).

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
  { id: 'wan2.7-image', name: 'Wan2.7-Image', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'T2I & editing (opsional 1–4 gambar sumber); ukuran 1K/2K; n=1.' },
  { id: 'wan2.7-image-pro', name: 'Wan2.7-Image-Pro', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'T2I & editing (opsional 1–4 gambar sumber); text rendering & konsistensi subjek.' },
  { id: 'qwen-image-3.0-pro', name: 'Qwen-Image-3.0-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'T2I & editing (opsional ≤3 gambar sumber); 5 preset ukuran; n 1–6.' },
  { id: 'qwen-image-3.0', name: 'Qwen-Image-3.0', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'T2I & editing (opsional ≤3 gambar sumber); 5 preset ukuran; n 1–6.' },
  { id: 'qwen-image-2.0', name: 'Qwen-Image-2.0', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I & edit (≤3 gambar); messages async; n 1–6; ukuran W*H 512–2048 (default 2048*2048).' },
  { id: 'qwen-image-2.0-2026-03-03', name: 'Qwen-Image-2.0 (2026-03-03)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0; parameter sama.' },
  { id: 'qwen-image-2.0-pro', name: 'Qwen-Image-2.0-Pro', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I & edit (≤3 gambar); messages async; n 1–6; default 2048*2048.' },
  { id: 'qwen-image-2.0-pro-2026-03-03', name: 'Qwen-Image-2.0-Pro (2026-03-03)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0-pro.' },
  { id: 'qwen-image-2.0-pro-2026-04-22', name: 'Qwen-Image-2.0-Pro (2026-04-22)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0-pro.' },
  { id: 'qwen-image-2.0-pro-2026-06-22', name: 'Qwen-Image-2.0-Pro (2026-06-22)', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'Snapshot bertanggal qwen-image-2.0-pro.' },
  { id: 'qwen-image-2.1-pro', name: 'Qwen-Image-2.1-Pro', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'T2I & edit (≤3 gambar); messages async; n 1–6; default 2048*2048.' },
  { id: 'qwen-image-2.1-turbo', name: 'Qwen-Image-2.1-Turbo', category: 'Image', freeQuota: '10 gambar / 90 hari', blea: 'image', note: 'T2I & edit (≤3 gambar); messages async; n 1–6; default 2048*2048.' },
  { id: 'wan2.6-t2i', name: 'Wan2.6-T2I', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'T2I; messages async (image-generation); n 1–4; 1280*1280 s/d 1440*1440.' },
  { id: 'wan2.6-image', name: 'Wan2.6-Image', category: 'Image', freeQuota: '47 / 50 gambar', blea: 'image', note: 'T2I interleaved (enable_interleave=true, max_images 1–5) & editing (1–4 gambar sumber, n 1–4).' },
  { id: 'wan2.5-t2i-preview', name: 'Wan2.5-T2I-Preview', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'T2I legacy (text2image/image-synthesis); total piksel 1280^2–1440^2, rasio 1:4–4:1, n 1–4.' },
  { id: 'wan2.5-i2i-preview', name: 'Wan2.5-I2I-Preview', category: 'Image', freeQuota: '50 gambar / 90 hari', blea: 'image', note: 'Editing gambar (wajib 1–4 gambar sumber, image2image/image-synthesis); total 768^2–1280^2, n 1–4.' },
  { id: 'wan2.2-t2i-plus', name: 'Wan2.2-T2I-Plus', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I legacy (text2image/image-synthesis); sisi 512–1440, maks 1440*1440, prompt ≤500 karakter.' },
  { id: 'wan2.2-t2i-flash', name: 'Wan2.2-T2I-Flash', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I legacy cepat (text2image/image-synthesis); sisi 512–1440, prompt ≤500 karakter.' },
  { id: 'wan2.1-t2i-plus', name: 'Wan2.1-T2I-Plus', category: 'Image', freeQuota: '200 gambar / 90 hari', blea: 'image', note: 'T2I legacy (Singapore: wan2.1-t2i-plus, Beijing: wanx2.1-t2i-plus); sisi 512–1440, prompt ≤500 karakter.' },
  { id: 'wan2.1-t2i-turbo', name: 'Wan2.1-T2I-Turbo', category: 'Image', freeQuota: '200 gambar / 90 hari', blea: 'image', note: 'T2I legacy cepat (Singapore: wan2.1-t2i-turbo, Beijing: wanx2.1-t2i-turbo); prompt ≤500 karakter.' },
  { id: 'z-image-turbo', name: 'Z-Image-Turbo', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: 'image', note: 'T2I sinkron (multimodal-generation); sisi 512–2048, n=1, prompt ≤800 karakter.' },
  { id: 'qwen-mt-image-2.0', name: 'Qwen-MT-Image-2.0', category: 'Image', freeQuota: '100 gambar / 90 hari', blea: null, note: 'Qwen-MT: terjemahan teks di dalam gambar, bukan T2I umum; tidak untuk Generate Image.' },

  // ---- Video (adapter per famili terverifikasi) ----
  { id: 'wan3.0-video', name: 'Wan 3.0 Video', category: 'Video', freeQuota: '30 detik / 90 hari (Singapore/internasional)', blea: 'video', note: 'T2V, I2V (first/last frame), atau multi-referensi (maks 10 foto + 5 video + 5 audio); 2–30 detik.', docs: 'https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference' },
  { id: 'wan3.0-video-prime', name: 'Wan 3.0 Video Prime', category: 'Video', freeQuota: 'Kampanye / berbayar', blea: 'video', note: 'Wan 3.0 versi kecepatan tinggi; parameter & media sama dengan wan3.0-video.' },
  { id: 'wan2.6-t2v', name: 'Wan2.6-T2V', category: 'Video', freeQuota: 'Kampanye / berbayar', blea: 'video', note: 'T2V 720p/1080p, 2–15 detik, narasi multi-shot + audio sinkron.' },
  { id: 'wan2.6-i2v', name: 'Wan2.6-I2V', category: 'Video', freeQuota: '30 / 50 video', blea: 'video', note: 'I2V (wajib First Frame, opsional audio); 720p/1080p, 2–15 detik.' },
  { id: 'wan2.6-i2v-flash', name: 'Wan2.6-I2V-Flash', category: 'Video', freeQuota: '40 / 50 video', blea: 'video', note: 'I2V cepat (wajib First Frame, opsional audio); 720p/1080p, 2–15 detik.' },
  { id: 'wan2.6-r2v', name: 'Wan2.6-R2V', category: 'Video', freeQuota: '25 / 50 video', blea: 'video', note: 'Reference-to-video (input.reference_urls); gunakan character1, character2; 720p/1080p, 2–10 detik.' },
  { id: 'wan2.6-r2v-flash', name: 'Wan2.6-R2V-Flash', category: 'Video', freeQuota: '37.5 / 50 video', blea: 'video', note: 'Reference-to-video cepat (input.reference_urls); 720p/1080p, 2–10 detik.' },
  { id: 'wan2.5-t2v-preview', name: 'Wan2.5-T2V-Preview', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'T2V preview; 480p/720p/1080p, 5 atau 10 detik + audio.' },
  { id: 'wan2.5-i2v-preview', name: 'Wan2.5-I2V-Preview', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'I2V preview (wajib First Frame); 480p/720p/1080p, 5 atau 10 detik + audio.' },
  { id: 'wan2.2-t2v-plus', name: 'Wan2.2-T2V-Plus', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'T2V 480p/1080p, 5 detik tanpa audio, prompt ≤800 karakter.' },
  { id: 'wan2.2-i2v-plus', name: 'Wan2.2-I2V-Plus', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'I2V (wajib First Frame); 480p/1080p, 5 detik tanpa audio.' },
  { id: 'wan2.2-i2v-flash', name: 'Wan2.2-I2V-Flash', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'I2V cepat (wajib First Frame); 480p/720p (batas API ref), 5 detik tanpa audio.' },
  { id: 'wan2.2-kf2v-flash', name: 'Wan2.2-KF2V-Flash', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'Keyframe-to-video (image2video/video-synthesis); wajib First + Last Frame; 480p/720p/1080p, 5 dtk.' },
  { id: 'wan2.2-animate-move', name: 'Wan2.2-Animate-Move', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'Animate Move (image2video/video-synthesis); wajib gambar karakter + video penggerak; 720p wan-std / 1080p wan-pro.' },
  { id: 'wan2.2-animate-mix', name: 'Wan2.2-Animate-Mix', category: 'Video', freeQuota: '38.28 / 50 video', blea: 'video', note: 'Animate Mix (image2video/video-synthesis); ganti karakter video dgn foto karakter; 720p wan-std / 1080p wan-pro.' },
  { id: 'wan2.1-t2v-plus', name: 'Wan2.1-T2V-Plus', category: 'Video', freeQuota: '200 video / 90 hari', blea: 'video', note: 'T2V legacy (Singapore: wan2.1-t2v-plus, Beijing: wanx2.1-t2v-plus); 720p, 5 dtk.' },
  { id: 'wan2.1-t2v-turbo', name: 'Wan2.1-T2V-Turbo', category: 'Video', freeQuota: '200 video / 90 hari', blea: 'video', note: 'T2V legacy cepat (Singapore: wan2.1-t2v-turbo, Beijing: wanx2.1-t2v-turbo); 480p/720p, 5 dtk.' },
  { id: 'wan2.1-i2v-plus', name: 'Wan2.1-I2V-Plus', category: 'Video', freeQuota: '200 video / 90 hari', blea: 'video', note: 'I2V legacy (Singapore: wan2.1-i2v-plus, Beijing: wanx2.1-i2v-plus); wajib First Frame; 720p, 5 dtk.' },
  { id: 'wan2.1-i2v-turbo', name: 'Wan2.1-I2V-Turbo', category: 'Video', freeQuota: '200 video / 90 hari', blea: 'video', note: 'I2V legacy cepat (Singapore: wan2.1-i2v-turbo, Beijing: wanx2.1-i2v-turbo); wajib First Frame; 480p/720p, 3–5 dtk.' },
  { id: 'wan2.1-kf2v-plus', name: 'Wan2.1-KF2V-Plus', category: 'Video', freeQuota: '200 video / 90 hari', blea: 'video', note: 'Keyframe-to-video resmi (Singapore: wan2.1-kf2v-plus, Beijing: wanx2.1-kf2v-plus); wajib First + Last Frame; 720p, 5 dtk.' },
  { id: 'wan2.1-kf2iv-plus', name: 'Wan2.1-KF2IV-Plus (Salah Ejaan)', category: 'Video', freeQuota: '200 video / 90 hari', blea: null, note: 'Salah ketik di daftar kuota; ID resmi adalah wan2.1-kf2v-plus (Beijing: wanx2.1-kf2v-plus). Jangan diaktifkan.', verifiedId: false },
  { id: 'wan2.1-vace-plus', name: 'Wan2.1-VACE-Plus', category: 'Video', freeQuota: '50 video / 90 hari', blea: 'video', note: 'VACE (Singapore: wan2.1-vace-plus, Beijing: wanx2.1-vace-plus); image_reference / video_repainting / video_extension; 720p, 5 dtk.' },
  { id: 'happyhorse-1.1-t2v', name: 'HappyHorse 1.1 (Text-to-Video)', category: 'Video', freeQuota: '10 detik / 90 hari (kampanye)', blea: 'video', note: 'T2V kampanye; 480p/720p/1080p, 3–15 detik + audio bawaan.' },
  { id: 'happyhorse-1.0-t2v', name: 'HappyHorse 1.0 (Text-to-Video)', category: 'Video', freeQuota: 'Kampanye', blea: 'video', note: 'T2V 720p/1080p, 3–15 detik + audio bawaan.' },
  { id: 'happyhorse-1.1-i2v', name: 'HappyHorse 1.1 (Image-to-Video)', category: 'Video', freeQuota: '10 detik / 90 hari (kampanye)', blea: 'video', note: 'I2V wajib First Frame (media type first_frame); 480p/720p/1080p, 3–15 dtk + audio.' },
  { id: 'happyhorse-1.0-i2v', name: 'HappyHorse 1.0 (Image-to-Video)', category: 'Video', freeQuota: 'Kampanye', blea: 'video', note: 'I2V wajib First Frame (media type first_frame); 720p/1080p, 3–15 dtk + audio.' },
  { id: 'happyhorse-1.1-r2v', name: 'HappyHorse 1.1 (Reference-to-Video)', category: 'Video', freeQuota: 'Kampanye', blea: 'video', note: 'R2V wajib 1–9 foto referensi (type reference_image; rujuk [Image 1] di prompt); 480p/720p/1080p, 3–15 dtk.' },
  { id: 'happyhorse-1.0-r2v', name: 'HappyHorse 1.0 (Reference-to-Video)', category: 'Video', freeQuota: 'Kampanye', blea: 'video', note: 'R2V wajib 1–9 foto referensi (type reference_image); 720p/1080p, 3–15 dtk.' },
  { id: 'happyhorse-1.0-video-edit', name: 'HappyHorse 1.0 (Video Edit)', category: 'Video', freeQuota: '10 video / 90 hari (kampanye)', blea: 'video', note: 'Video edit: wajib 1 video sumber + opsional 0–5 foto referensi; 720p/1080p.' },

  // ---- Speech & ASR ----
  { id: 'qwen3-tts-flash', name: 'Qwen3-TTS-Flash', category: 'Speech', freeQuota: '10.000 karakter / 90 hari', blea: null, note: 'Text-to-speech; endpoint multimodal-generation/generation; output 24.000 Hz.' },
  { id: 'qwen-tts-flash', name: 'Qwen-TTS-Flash', category: 'Speech', freeQuota: '1 juta token / 90 hari', blea: null, note: 'Token-based TTS; CNY 1.6 input / CNY 10 output per 1M token.' },
  { id: 'qwen3-asr-flash', name: 'Qwen3-ASR-Flash', category: 'Speech', freeQuota: '36.000 detik / 90 hari', blea: null, note: 'Multilingual speech recognition; deteksi bahasa otomatis 11 bahasa.' },
  { id: 'qwen3-asr-flash-realtime', name: 'Qwen3-ASR-Flash-Realtime', category: 'Speech', freeQuota: '36.000 detik / 90 hari', blea: null, note: 'Versi realtime dari Qwen3-ASR-Flash.' },
];
