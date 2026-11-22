// Shared video model catalog, provider presets, and capability normalization
// Used by both Cloudflare Worker (src/worker.js) and frontend components.

export const DEFAULT_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
export const DEFAULT_RESOLUTIONS = ['480p', '720p', '1080p', '4K'];
export const DEFAULT_DURATIONS = [4, 5, 6, 8, 10, 12, 15];

export const PROVIDER_PRESETS = {
  unorouter: {
    id: 'unorouter',
    label: 'UnoRouter',
    defaultBaseUrl: 'https://api.unorouter.com',
    baseUrl: 'https://api.unorouter.com',
    protocol: 'openai_video',
    description: 'Gateway multi-model UnoRouter (/v1/videos)',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai_video',
    description: 'OpenAI Sora Video API (/v1/videos)',
  },
  google: {
    id: 'google',
    label: 'Google Veo / Gemini',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'openai_video',
    description: 'Google Veo & Gemini Omni',
  },
  xai: {
    id: 'xai',
    label: 'xAI Grok Video',
    defaultBaseUrl: 'https://api.x.ai',
    baseUrl: 'https://api.x.ai',
    protocol: 'xai_video',
    description: 'Grok Imagine Video (/v1/videos/generations)',
  },
  doubao: {
    id: 'doubao',
    label: 'ByteDance Seedance',
    defaultBaseUrl: 'https://ark.cn-beijing.volces.com',
    baseUrl: 'https://ark.cn-beijing.volces.com',
    protocol: 'openai_video',
    description: 'Doubao Seedance 1.5 / 2.0 / 2.5',
  },
  alibaba: {
    id: 'alibaba',
    label: 'Alibaba',
    defaultBaseUrl: '',
    baseUrl: '',
    protocol: 'alibaba_video',
    description: 'Alibaba Model Studio Video (Wan 2.1–3.0, Animate, VACE, HappyHorse). Base URL: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com atau dashscope-intl.aliyuncs.com',
  },
  kling: {
    id: 'kling',
    label: 'Kling AI',
    defaultBaseUrl: 'https://api.klingai.com',
    baseUrl: 'https://api.klingai.com',
    protocol: 'openai_video',
    description: 'Kling v2.6 / v3 / 4.0',
  },
  hailuo: {
    id: 'hailuo',
    label: 'MiniMax Hailuo',
    defaultBaseUrl: 'https://api.minimax.io',
    baseUrl: 'https://api.minimax.io',
    protocol: 'openai_video',
    description: 'MiniMax Hailuo 2.3 / H3',
  },
  pekpik: {
    id: 'pekpik',
    label: 'PEKPIK (Free / OpenAI-Compatible)',
    defaultBaseUrl: 'https://aiapiv2.pekpik.com',
    baseUrl: 'https://aiapiv2.pekpik.com',
    protocol: 'openai_video',
    description: 'PEKPIK API gateway (/v1/chat/completions & /v1/models)',
  },
  cloudflare: {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    defaultBaseUrl: '',
    baseUrl: '',
    protocol: 'cloudflare_ai',
    description: 'Gratis 10.000 Neurons/hari via Workers AI Binding (env.AI) atau REST API Account ID.',
  },
  // Chat-only: Ollama tidak punya endpoint video, jadi preset ini sengaja
  // tidak pernah muncul di /api/video/models (lihat filter di worker.js).
  ollama: {
    id: 'ollama',
    label: 'Ollama (self-host)',
    // Tidak ada default: Worker di edge tidak bisa memanggil localhost pengguna,
    // jadi base URL publik (Cloudflare Tunnel) wajib diisi admin.
    defaultBaseUrl: '',
    baseUrl: '',
    protocol: 'openai_chat',
    description: 'Server Ollama sendiri lewat Cloudflare Tunnel — OpenAI-compatible (/v1/chat/completions & /v1/models). Base URL wajib diisi, mis. https://xxxx.trycloudflare.com',
  },
  custom: {
    id: 'custom',
    label: 'Custom Gateway',
    defaultBaseUrl: '',
    baseUrl: '',
    protocol: 'openai_video',
    description: 'Endpoint OpenAI-compatible (/v1/videos)',
  },
};

const withAudioFlag = (m) => ({
  ...m,
  supportsAudio: Boolean(m.supportsAudio ?? (m.supportsAudioOutput || m.supportsAudioInput)),
});

// Spesifikasi terverifikasi per famili model video Alibaba Model Studio.
// Setiap entri mengontrol payload adapter di src/worker.js DAN kapabilitas UI di GeneratePage.jsx.
const WAN_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const HH_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'];
const ENDPOINT_SYNTHESIS = 'video-generation/video-synthesis';
const ENDPOINT_IMAGE2VIDEO = 'image2video/video-synthesis';

export const ALIBABA_VIDEO_MODEL_SPECS = Object.freeze({
  // ---- Wan 3.0 ----
  'wan3.0-video': {
    id: 'wan3.0-video',
    name: 'Wan 3.0 Video',
    family: 'wan3',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'wan3',
    aspectRatios: [...WAN_RATIOS, 'adaptive'],
    resolutions: ['480p', '720p', '1080p'],
    durations: [2, 5, 10, 15, 20, 25, 30],
    minDuration: 2,
    maxDuration: 30,
    maxPrompt: 2000,
    supportsImage: true,
    supportsLastFrame: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'Wan 3.0 Video: T2V, First/Last Frame ATAU referensi multi-modal (maks 10 foto + 5 video + 5 audio, total ≤20).',
  },
  'wan3.0-video-prime': {
    id: 'wan3.0-video-prime',
    name: 'Wan 3.0 Video Prime',
    family: 'wan3',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'wan3',
    aspectRatios: [...WAN_RATIOS, 'adaptive'],
    resolutions: ['480p', '720p', '1080p'],
    durations: [2, 5, 10, 15, 20, 25, 30],
    minDuration: 2,
    maxDuration: 30,
    maxPrompt: 2000,
    supportsImage: true,
    supportsLastFrame: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'Wan 3.0 Video Prime (dioptimalkan kecepatan): T2V, First/Last Frame, atau multi-referensi.',
  },

  // ---- Wan T2V ----
  'wan2.6-t2v': {
    id: 'wan2.6-t2v',
    name: 'Wan 2.6 T2V',
    family: 'wan-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: WAN_RATIOS,
    resolutions: ['720p', '1080p'],
    durations: [2, 3, 4, 5, 6, 8, 10, 12, 15],
    minDuration: 2,
    maxDuration: 15,
    maxPrompt: 1500,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'Wan 2.6 Text-to-Video: 720p/1080p, 2–15 dtk, narasi multi-shot + audio sinkron (opsional audio referensi).',
  },
  'wan2.5-t2v-preview': {
    id: 'wan2.5-t2v-preview',
    name: 'Wan 2.5 T2V Preview',
    family: 'wan-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: WAN_RATIOS,
    resolutions: ['480p', '720p', '1080p'],
    durations: [5, 10],
    minDuration: 5,
    maxDuration: 10,
    maxPrompt: 1500,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'Wan 2.5 Text-to-Video Preview: 480p/720p/1080p, 5 atau 10 dtk, audio bawaan/referensi.',
  },
  'wan2.2-t2v-plus': {
    id: 'wan2.2-t2v-plus',
    name: 'Wan 2.2 T2V Plus',
    family: 'wan-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: WAN_RATIOS,
    resolutions: ['480p', '1080p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: true,
    description: 'Wan 2.2 Text-to-Video Plus: 480p/1080p, 5 detik tanpa audio.',
  },
  'wan2.1-t2v-plus': {
    id: 'wan2.1-t2v-plus',
    cnId: 'wanx2.1-t2v-plus',
    name: 'Wan 2.1 T2V Plus',
    family: 'wan-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: WAN_RATIOS,
    resolutions: ['720p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: true,
    description: 'Wan 2.1 Text-to-Video Plus: 720p, 5 detik tanpa audio.',
  },
  'wan2.1-t2v-turbo': {
    id: 'wan2.1-t2v-turbo',
    cnId: 'wanx2.1-t2v-turbo',
    name: 'Wan 2.1 T2V Turbo',
    family: 'wan-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: WAN_RATIOS,
    resolutions: ['480p', '720p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: true,
    description: 'Wan 2.1 Text-to-Video Turbo: 480p/720p, 5 detik tanpa audio.',
  },

  // ---- Wan I2V (First Frame wajib) ----
  'wan2.6-i2v': {
    id: 'wan2.6-i2v',
    name: 'Wan 2.6 I2V',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [2, 3, 4, 5, 6, 8, 10, 12, 15],
    minDuration: 2,
    maxDuration: 15,
    maxPrompt: 1500,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: false,
    description: 'Wan 2.6 Image-to-Video: wajib First Frame; rasio mengikuti gambar; 720p/1080p, 2–15 dtk + audio.',
  },
  'wan2.6-i2v-flash': {
    id: 'wan2.6-i2v-flash',
    name: 'Wan 2.6 I2V Flash',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [2, 3, 4, 5, 6, 8, 10, 12, 15],
    minDuration: 2,
    maxDuration: 15,
    maxPrompt: 1500,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: false,
    description: 'Wan 2.6 Image-to-Video Flash: generasi cepat dari First Frame; 720p/1080p, 2–15 dtk + audio.',
  },
  'wan2.5-i2v-preview': {
    id: 'wan2.5-i2v-preview',
    name: 'Wan 2.5 I2V Preview',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['480p', '720p', '1080p'],
    durations: [5, 10],
    minDuration: 5,
    maxDuration: 10,
    maxPrompt: 1500,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    supportsRatio: false,
    description: 'Wan 2.5 Image-to-Video Preview: wajib First Frame; 480p/720p/1080p, 5 atau 10 dtk + audio.',
  },
  'wan2.2-i2v-flash': {
    id: 'wan2.2-i2v-flash',
    name: 'Wan 2.2 I2V Flash',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['480p', '720p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.2 Image-to-Video Flash: wajib First Frame; 480p/720p, 5 detik tanpa audio.',
  },
  'wan2.2-i2v-plus': {
    id: 'wan2.2-i2v-plus',
    name: 'Wan 2.2 I2V Plus',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['480p', '1080p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.2 Image-to-Video Plus: wajib First Frame; 480p/1080p, 5 detik tanpa audio.',
  },
  'wan2.1-i2v-turbo': {
    id: 'wan2.1-i2v-turbo',
    cnId: 'wanx2.1-i2v-turbo',
    name: 'Wan 2.1 I2V Turbo',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['480p', '720p'],
    durations: [3, 4, 5],
    minDuration: 3,
    maxDuration: 5,
    maxPrompt: 800,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.1 Image-to-Video Turbo: wajib First Frame; 480p/720p, 3–5 detik tanpa audio.',
  },
  'wan2.1-i2v-plus': {
    id: 'wan2.1-i2v-plus',
    cnId: 'wanx2.1-i2v-plus',
    name: 'Wan 2.1 I2V Plus',
    family: 'wan-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['720p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.1 Image-to-Video Plus: wajib First Frame; 720p, 5 detik tanpa audio.',
  },

  // ---- Wan R2V ----
  'wan2.6-r2v': {
    id: 'wan2.6-r2v',
    name: 'Wan 2.6 R2V',
    family: 'wan-r2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'reference_urls',
    aspectRatios: WAN_RATIOS,
    resolutions: ['720p', '1080p'],
    durations: [2, 3, 4, 5, 6, 8, 10],
    minDuration: 2,
    maxDuration: 10,
    maxPrompt: 1500,
    requiresPrompt: true,
    requiresReference: true,
    maxRefImages: 3,
    maxRefVideos: 5,
    maxRefAudios: 0,
    maxRefTotal: 5,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: true,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'Wan 2.6 Reference-to-Video: gunakan identifier character1, character2 di prompt dengan 1–3 foto atau 1–5 video referensi; 720p/1080p, 2–10 dtk.',
  },
  'wan2.6-r2v-flash': {
    id: 'wan2.6-r2v-flash',
    name: 'Wan 2.6 R2V Flash',
    family: 'wan-r2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'reference_urls',
    aspectRatios: WAN_RATIOS,
    resolutions: ['720p', '1080p'],
    durations: [2, 3, 4, 5, 6, 8, 10],
    minDuration: 2,
    maxDuration: 10,
    maxPrompt: 1500,
    requiresPrompt: true,
    requiresReference: true,
    maxRefImages: 3,
    maxRefVideos: 5,
    maxRefAudios: 0,
    maxRefTotal: 5,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: true,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'Wan 2.6 Reference-to-Video Flash: versi cepat R2V; 720p/1080p, 2–10 dtk.',
  },

  // ---- Wan KF2V (First + Last Frame wajib, endpoint image2video/video-synthesis) ----
  'wan2.2-kf2v-flash': {
    id: 'wan2.2-kf2v-flash',
    name: 'Wan 2.2 KF2V Flash',
    family: 'wan-kf2v',
    endpoint: ENDPOINT_IMAGE2VIDEO,
    mediaMode: 'keyframes',
    aspectRatios: [],
    resolutions: ['480p', '720p', '1080p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresFirstFrame: true,
    requiresLastFrame: true,
    supportsImage: true,
    supportsLastFrame: true,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.2 Keyframe-to-Video Flash: wajib First Frame & Last Frame; 480p/720p/1080p, 5 detik tanpa audio.',
  },
  'wan2.1-kf2v-plus': {
    id: 'wan2.1-kf2v-plus',
    cnId: 'wanx2.1-kf2v-plus',
    name: 'Wan 2.1 KF2V Plus',
    family: 'wan-kf2v',
    endpoint: ENDPOINT_IMAGE2VIDEO,
    mediaMode: 'keyframes',
    aspectRatios: [],
    resolutions: ['720p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresFirstFrame: true,
    requiresLastFrame: true,
    supportsImage: true,
    supportsLastFrame: true,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.1 Keyframe-to-Video Plus: wajib First Frame & Last Frame; 720p, 5 detik tanpa audio.',
  },

  // ---- Wan Animate (Image + Video wajib, endpoint image2video/video-synthesis) ----
  'wan2.2-animate-move': {
    id: 'wan2.2-animate-move',
    name: 'Wan 2.2 Animate Move',
    family: 'wan-animate',
    endpoint: ENDPOINT_IMAGE2VIDEO,
    mediaMode: 'animate',
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [5, 10, 15, 20, 30],
    minDuration: 2,
    maxDuration: 30,
    maxPrompt: 800,
    requiresFirstFrame: true,
    requiresVideo: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: true,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.2 Animate Move: animasikan gambar karakter mengikuti gerakan video penggerak (720p wan-std / 1080p wan-pro).',
  },
  'wan2.2-animate-mix': {
    id: 'wan2.2-animate-mix',
    name: 'Wan 2.2 Animate Mix',
    family: 'wan-animate',
    endpoint: ENDPOINT_IMAGE2VIDEO,
    mediaMode: 'animate',
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [5, 10, 15, 20, 30],
    minDuration: 2,
    maxDuration: 30,
    maxPrompt: 800,
    requiresFirstFrame: true,
    requiresVideo: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: true,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: false,
    description: 'Wan 2.2 Animate Mix: ganti karakter pada video dengan subjek di gambar karakter (720p wan-std / 1080p wan-pro).',
  },

  // ---- Wan VACE ----
  'wan2.1-vace-plus': {
    id: 'wan2.1-vace-plus',
    cnId: 'wanx2.1-vace-plus',
    name: 'Wan 2.1 VACE Plus',
    family: 'wan-vace',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'vace',
    aspectRatios: WAN_RATIOS,
    resolutions: ['720p'],
    durations: [5],
    minDuration: 5,
    maxDuration: 5,
    maxPrompt: 800,
    requiresPrompt: true,
    maxRefImages: 4,
    maxRefVideos: 1,
    maxRefAudios: 0,
    maxRefTotal: 5,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: true,
    supportsAudioInput: false,
    supportsAudioOutput: false,
    supportsRatio: true,
    description: 'Wan 2.1 VACE Plus: editing/kreasi video berbasis referensi gambar (image_reference) atau repainting video (video_repainting); 720p 5 detik.',
  },

  // ---- HappyHorse 1.1 & 1.0 ----
  'happyhorse-1.1-t2v': {
    id: 'happyhorse-1.1-t2v',
    name: 'HappyHorse 1.1 T2V',
    family: 'happyhorse-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: HH_RATIOS,
    resolutions: ['480p', '720p', '1080p'],
    durations: [3, 5, 8, 10, 12, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'HappyHorse 1.1 Text-to-Video: 480p/720p/1080p, 3–15 detik dengan audio bawaan.',
  },
  'happyhorse-1.0-t2v': {
    id: 'happyhorse-1.0-t2v',
    name: 'HappyHorse 1.0 T2V',
    family: 'happyhorse-t2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'none',
    aspectRatios: HH_RATIOS,
    resolutions: ['720p', '1080p'],
    durations: [3, 5, 8, 10, 12, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresPrompt: true,
    supportsImage: false,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'HappyHorse 1.0 Text-to-Video: 720p/1080p, 3–15 detik dengan audio bawaan.',
  },
  'happyhorse-1.1-i2v': {
    id: 'happyhorse-1.1-i2v',
    name: 'HappyHorse 1.1 I2V',
    family: 'happyhorse-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['480p', '720p', '1080p'],
    durations: [3, 5, 8, 10, 12, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: false,
    description: 'HappyHorse 1.1 Image-to-Video: wajib First Frame (rasio mengikuti gambar), 480p/720p/1080p, 3–15 detik + audio.',
  },
  'happyhorse-1.0-i2v': {
    id: 'happyhorse-1.0-i2v',
    name: 'HappyHorse 1.0 I2V',
    family: 'happyhorse-i2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'first_frame',
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [3, 5, 8, 10, 12, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresFirstFrame: true,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: false,
    description: 'HappyHorse 1.0 Image-to-Video: wajib First Frame (rasio mengikuti gambar), 720p/1080p, 3–15 detik + audio.',
  },
  'happyhorse-1.1-r2v': {
    id: 'happyhorse-1.1-r2v',
    name: 'HappyHorse 1.1 R2V',
    family: 'happyhorse-r2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'reference_images',
    aspectRatios: HH_RATIOS,
    resolutions: ['480p', '720p', '1080p'],
    durations: [3, 5, 8, 10, 12, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresPrompt: true,
    requiresReference: true,
    maxRefImages: 9,
    maxRefVideos: 0,
    maxRefAudios: 0,
    maxRefTotal: 9,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'HappyHorse 1.1 Reference-to-Video: wajib 1–9 gambar referensi ([Image 1], [Image 2] di prompt); 480p/720p/1080p, 3–15 dtk + audio.',
  },
  'happyhorse-1.0-r2v': {
    id: 'happyhorse-1.0-r2v',
    name: 'HappyHorse 1.0 R2V',
    family: 'happyhorse-r2v',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'reference_images',
    aspectRatios: HH_RATIOS,
    resolutions: ['720p', '1080p'],
    durations: [3, 5, 8, 10, 12, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresPrompt: true,
    requiresReference: true,
    maxRefImages: 9,
    maxRefVideos: 0,
    maxRefAudios: 0,
    maxRefTotal: 9,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: true,
    description: 'HappyHorse 1.0 Reference-to-Video: wajib 1–9 gambar referensi; 720p/1080p, 3–15 dtk + audio.',
  },
  'happyhorse-1.0-video-edit': {
    id: 'happyhorse-1.0-video-edit',
    name: 'HappyHorse 1.0 Video Edit',
    family: 'happyhorse-edit',
    endpoint: ENDPOINT_SYNTHESIS,
    mediaMode: 'video_edit',
    aspectRatios: [],
    resolutions: ['720p', '1080p'],
    durations: [5, 10, 15],
    minDuration: 3,
    maxDuration: 15,
    maxPrompt: 5000,
    requiresVideo: true,
    maxRefImages: 5,
    maxRefVideos: 0,
    maxRefAudios: 0,
    maxRefTotal: 5,
    supportsImage: true,
    supportsLastFrame: false,
    supportsVideo: true,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    supportsRatio: false,
    description: 'HappyHorse 1.0 Video Edit: wajib 1 video sumber + opsional 0–5 foto referensi; 720p/1080p.',
  },
});

export const ALIBABA_VIDEO_SUPPORTED_MODELS = Object.freeze(Object.keys(ALIBABA_VIDEO_MODEL_SPECS));

export function getAlibabaVideoModelSpec(modelId) {
  const key = String(modelId || '').toLowerCase().trim();
  return ALIBABA_VIDEO_MODEL_SPECS[key] || null;
}

export function isAlibabaVideoModelSupported(modelId) {
  return Boolean(getAlibabaVideoModelSpec(modelId));
}

export const BUILTIN_VIDEO_MODELS = [
  {
    id: 'gemini-omni-1.2-flash:free',
    name: 'Gemini Omni 1.2 Flash',
    provider: 'unorouter',
    vendor: 'Google',
    isFree: true,
    priceLabel: 'Gratis',
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['480p', '720p', '1080p', '4K'],
    durations: [4, 5, 6, 8, 10, 12, 15],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Model multimodal Google hingga 15 detik dengan audio bawaan, gambar & referensi video.',
  },
  {
    id: 'gemini-omni-1.1-flash:free',
    name: 'Gemini Omni 1.1 Flash',
    provider: 'unorouter',
    vendor: 'Google',
    isFree: true,
    priceLabel: 'Gratis',
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['480p', '720p', '1080p', '4K'],
    durations: [4, 5, 6, 8, 10, 15],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Generasi & editing video multimodal dengan dukungan audio, gambar, dan klip referensi.',
  },
  {
    id: 'veo3.1',
    name: 'Veo 3.1',
    provider: 'unorouter',
    vendor: 'Google',
    isFree: false,
    priceLabel: '$0.40/s',
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4K'],
    durations: [4, 6, 8],
    supportsImage: true,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    description: 'Kualitas sinematik Google Veo 3.1 dengan audio terpadu hingga 4K.',
  },
  {
    id: 'veo3.1-fast',
    name: 'Veo 3.1 Fast',
    provider: 'unorouter',
    vendor: 'Google',
    isFree: false,
    priceLabel: '$0.40/s',
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4K'],
    durations: [4, 6, 8],
    supportsImage: true,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    description: 'Versi cepat Veo 3.1 untuk iterasi preview & produksi konten.',
  },
  {
    id: 'doubao-seedance-1-5-pro-251215',
    name: 'Seedance 1.5 Pro',
    provider: 'unorouter',
    vendor: 'ByteDance',
    isFree: false,
    priceLabel: '$0.48/s',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['480p', '720p', '1080p'],
    durations: [4, 5, 6, 8, 10, 12],
    supportsImage: true,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    description: 'Gerakan realistis & audio sinkron dari ByteDance Seedance 1.5 Pro.',
  },
  {
    id: 'grok-video-3',
    name: 'Grok Video 3',
    provider: 'unorouter',
    vendor: 'xAI',
    isFree: false,
    priceLabel: '$0.05/s',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['480p', '720p', '1080p'],
    durations: [5, 6, 8, 10, 12, 15],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Model video cepat xAI Grok Imagine dengan dukungan teks, gambar, video & audio.',
  },
  {
    ...ALIBABA_VIDEO_MODEL_SPECS['wan3.0-video'],
    provider: 'alibaba',
    vendor: 'Alibaba',
    isFree: false,
    priceLabel: 'Berbayar (per detik)',
  },
].map(withAudioFlag);

export function isVideoModelId(modelId) {
  const id = String(modelId || '').toLowerCase().trim();
  if (!id) return false;
  if (ALIBABA_VIDEO_MODEL_SPECS[id]) return true;
  return /(^|\/)(veo|doubao-seedance|seedance|grok-video|grok-imagine-video|kling|wan\d|wan-|happyhorse|minimax-hailuo|minimax-h3|hailuo|vidu|jimeng|sora|gemini-omni)/i.test(id);
}

export function isVideoCatalogModel(row, meta = {}) {
  const type = String(row?.type || '').toLowerCase();
  const mode = String(meta?.mode || '').toLowerCase();
  const outputModalities = Array.isArray(meta?.outputModalities)
    ? meta.outputModalities.map((m) => String(m).toLowerCase())
    : [];
  if (type === 'video') return true;
  if (mode === 'video' || mode === 'video_generation') return true;
  if (outputModalities.includes('video')) return true;
  return isVideoModelId(row?.model_name);
}

export const BUILTIN_CATALOG_PROVIDER_MODELS = Object.freeze({
  openai: [
    { id: 'sora-2', name: 'OpenAI Sora 2', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'OpenAI Sora 2 text/image-to-video.' },
    { id: 'sora-2-pro', name: 'OpenAI Sora 2 Pro', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'OpenAI Sora 2 Pro video generasi resolusi tinggi.' },
    { id: 'gpt-image-1', name: 'GPT Image 1', category: 'Image', isFree: false, priceLabel: 'API', description: 'Model generasi & edit gambar OpenAI.' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', category: 'Text', isFree: false, priceLabel: 'API', description: 'Model teks cepat & hemat OpenAI.' },
  ],
  google: [
    { id: 'veo3.1', name: 'Google Veo 3.1', category: 'Video', isFree: false, priceLabel: '$0.40/s', description: 'Google Veo 3.1 dengan audio terpadu.' },
    { id: 'veo3.1-fast', name: 'Google Veo 3.1 Fast', category: 'Video', isFree: false, priceLabel: '$0.40/s', description: 'Google Veo 3.1 Fast.' },
    { id: 'gemini-omni-1.2-flash:free', name: 'Gemini Omni 1.2 Flash', category: 'Video', isFree: true, priceLabel: 'Gratis', description: 'Video multimodal Google hingga 15 detik.' },
    { id: 'gemini-omni-1.1-flash:free', name: 'Gemini Omni 1.1 Flash', category: 'Video', isFree: true, priceLabel: 'Gratis', description: 'Generasi & editing video multimodal Google.' },
  ],
  xai: [
    { id: 'grok-video-3', name: 'xAI Grok Video 3', category: 'Video', isFree: false, priceLabel: '$0.05/s', description: 'Model video cepat xAI Grok Imagine.' },
    { id: 'grok-imagine-video', name: 'xAI Grok Imagine Video', category: 'Video', isFree: false, priceLabel: 'API', description: 'Endpoint resmi xAI Grok Imagine Video.' },
    { id: 'grok-3', name: 'xAI Grok 3', category: 'Text', isFree: false, priceLabel: 'API', description: 'Model chat & penalaran xAI.' },
  ],
  doubao: [
    { id: 'doubao-seedance-1-5-pro-251215', name: 'ByteDance Seedance 1.5 Pro', category: 'Video', isFree: false, priceLabel: '$0.48/s', description: 'ByteDance Seedance 1.5 Pro video & audio sinkron.' },
  ],
  kling: [
    { id: 'kling-v2.6', name: 'Kling v2.6', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'Kling AI v2.6 video generation.' },
    { id: 'kling-v3', name: 'Kling v3', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'Kling AI v3 video generation.' },
    { id: 'kling-v4.0', name: 'Kling v4.0', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'Kling AI v4.0 video generation.' },
  ],
  hailuo: [
    { id: 'minimax-hailuo-2.3', name: 'MiniMax Hailuo 2.3', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'MiniMax Hailuo 2.3 video generation.' },
    { id: 'minimax-h3', name: 'MiniMax H3', category: 'Video', isFree: false, priceLabel: 'Berbayar', description: 'MiniMax H3 video generation.' },
  ],
});

function resolveRawVideoProfile(modelId, provider = 'unorouter') {
  const id = String(modelId || '').trim();
  const lower = id.toLowerCase();
  const alibabaSpec = provider === 'alibaba' || !provider ? getAlibabaVideoModelSpec(lower) : null;
  if (alibabaSpec && provider === 'alibaba') {
    return {
      ...alibabaSpec,
      provider: 'alibaba',
      vendor: 'Alibaba',
      isFree: false,
      priceLabel: 'Free Quota / Berbayar',
    };
  }
  const exact = BUILTIN_VIDEO_MODELS.find((m) => m.id.toLowerCase() === lower && (!provider || m.provider === provider))
    || BUILTIN_VIDEO_MODELS.find((m) => m.id.toLowerCase() === lower);
  if (exact) return exact;

  if (lower.includes('veo')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'Google',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p', '4K'],
      durations: [4, 6, 8],
      supportsImage: true,
      supportsVideo: false,
      supportsAudioInput: false,
      supportsAudioOutput: true,
      description: 'Google Veo video generation model.',
    };
  }
  if (lower.includes('gemini-omni')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'Google',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['480p', '720p', '1080p', '4K'],
      durations: [4, 5, 6, 8, 10, 12, 15],
      supportsImage: true,
      supportsVideo: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      description: 'Gemini Omni multimodal video generation.',
    };
  }
  if (lower.includes('seedance')) {
    const isV2 = lower.includes('2-0') || lower.includes('2.0') || lower.includes('2-5') || lower.includes('2.5');
    return {
      id,
      name: id,
      provider,
      vendor: 'ByteDance',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: isV2 ? ['480p', '720p', '1080p', '4K'] : ['480p', '720p', '1080p'],
      durations: isV2 ? [4, 5, 6, 8, 10, 12, 15] : [4, 5, 6, 8, 10, 12],
      supportsImage: true,
      supportsVideo: isV2,
      supportsAudioInput: isV2,
      supportsAudioOutput: true,
      description: 'ByteDance Seedance video generation.',
    };
  }
  if (lower.includes('wan3')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'Alibaba',
      isFree: false,
      priceLabel: 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      resolutions: ['480p', '720p', '1080p'],
      durations: [5, 10, 15, 20, 30],
      supportsImage: true,
      supportsVideo: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      supportsAudio: true,
      description: 'Alibaba Wan 3.0 video generation (Model Studio async task).',
    };
  }
  if (lower.includes('wan')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'Alibaba',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      resolutions: ['480p', '720p', '1080p'],
      durations: [5, 10, 15],
      supportsImage: true,
      supportsVideo: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      description: 'Alibaba Wan video generation.',
    };
  }
  if (lower.includes('kling')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'Kuaishou',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1', '21:9'],
      resolutions: ['720p', '1080p'],
      durations: [5, 10],
      supportsImage: true,
      supportsVideo: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      description: 'Kling AI video generation.',
    };
  }
  if (lower.includes('hailuo') || lower.includes('minimax-h3')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'MiniMax',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1'],
      resolutions: ['480p', '720p', '1080p'],
      durations: [5, 6, 10],
      supportsImage: true,
      supportsVideo: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      description: 'MiniMax Hailuo video generation.',
    };
  }
  if (lower.includes('grok')) {
    return {
      id,
      name: id,
      provider,
      vendor: 'xAI',
      isFree: lower.endsWith(':free'),
      priceLabel: lower.endsWith(':free') ? 'Gratis' : 'Berbayar',
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: ['480p', '720p', '1080p'],
      durations: [5, 6, 8, 10, 12, 15],
      supportsImage: true,
      supportsVideo: true,
      supportsAudioInput: true,
      supportsAudioOutput: true,
      description: 'xAI Grok Imagine video generation.',
    };
  }

  return {
    id,
    name: id,
    provider,
    vendor: PROVIDER_PRESETS[provider]?.label || provider || 'Custom',
    isFree: lower.endsWith(':free'),
    priceLabel: lower.endsWith(':free') ? 'Gratis' : 'API',
    aspectRatios: DEFAULT_ASPECT_RATIOS,
    resolutions: DEFAULT_RESOLUTIONS,
    durations: DEFAULT_DURATIONS,
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Model video dari provider terkonfigurasi.',
  };
}

export function getVideoModelProfile(modelId, provider = 'unorouter') {
  return withAudioFlag(resolveRawVideoProfile(modelId, provider));
}

const SIZE_MAP = {
  '480p': { '16:9': '854x480', '9:16': '480x854', '1:1': '480x480', '4:3': '640x480', '3:4': '480x640', '21:9': '1120x480' },
  '720p': { '16:9': '1280x720', '9:16': '720x1280', '1:1': '720x720', '4:3': '960x720', '3:4': '720x960', '21:9': '1680x720' },
  '1080p': { '16:9': '1920x1080', '9:16': '1080x1920', '1:1': '1080x1080', '4:3': '1440x1080', '3:4': '1080x1440', '21:9': '2520x1080' },
  '2k': { '16:9': '2560x1440', '9:16': '1440x2560', '1:1': '2048x2048', '4:3': '2048x1536', '3:4': '1536x2048', '21:9': '2560x1080' },
  '4k': { '16:9': '3840x2160', '9:16': '2160x3840', '1:1': '2160x2160', '4:3': '2880x2160', '3:4': '2160x2880', '21:9': '3840x1644' },
};

export function computeVideoSize(aspectRatio = '16:9', resolution = '720p') {
  const resKey = String(resolution || '720p').toLowerCase();
  const ratioKey = String(aspectRatio || '16:9');
  return SIZE_MAP[resKey]?.[ratioKey] || SIZE_MAP[resKey]?.['16:9'] || '1280x720';
}

export const CLOUDFLARE_FREE_LLM_MODELS = [
  {
    id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
    name: 'Meta Llama 3.1 8B Fast',
    starter: true,
    tags: ['Chat', 'Cepat', 'Hemat Neurons'],
    description: 'Cepat & hemat (~286K output token/hari dalam kuota gratis 10K Neurons).',
  },
  {
    id: '@cf/openai/gpt-oss-20b',
    name: 'OpenAI GPT-OSS 20B',
    starter: true,
    tags: ['Chat', 'Open-Weight', 'Hemat Neurons'],
    description: 'Model open-weight OpenAI 20B (~366K output token/hari gratis).',
  },
  {
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    name: 'Meta Llama 3.3 70B Fast',
    starter: true,
    tags: ['Chat', '70B', 'Kualitas Tinggi'],
    description: 'Model besar 70B berkualitas tinggi untuk analisis & penulisan kompleks.',
  },
  {
    id: '@cf/qwen/qwen3-30b-a3b-fp8',
    name: 'Qwen 3 30B A3B',
    starter: true,
    tags: ['Chat', 'MoE', 'Cepat'],
    description: 'Qwen 3 30B MoE cepat, akurat, dan hemat Neurons.',
  },
  {
    id: '@cf/google/gemma-3-12b-it',
    name: 'Google Gemma 3 12B',
    starter: true,
    tags: ['Chat', 'Multilingual'],
    description: 'Google Gemma 3 12B instruksional yang seimbang untuk percakapan umum.',
  },
  {
    id: '@cf/openai/gpt-oss-120b',
    name: 'OpenAI GPT-OSS 120B',
    starter: true,
    tags: ['Chat', '120B', 'Flagship', 'Reasoning'],
    description: 'Model open-weight terbesar OpenAI 120B (~146K output token/hari gratis) untuk penalaran mendalam.',
  },
  {
    id: '@cf/meta/llama-4-scout-17b-16e-instruct',
    name: 'Meta Llama 4 Scout 17B',
    starter: true,
    tags: ['Chat', 'Vision', 'Llama 4'],
    description: 'Llama 4 Scout multimodal dengan konteks panjang & dukungan gambar.',
  },
  {
    id: '@cf/qwen/qwen2.5-coder-32b-instruct',
    name: 'Qwen 2.5 Coder 32B',
    starter: true,
    tags: ['Chat', 'Coding'],
    description: 'Model spesialis pemrograman, debugging, dan pembuatan skrip.',
  },
  {
    id: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    name: 'Mistral Small 3.1 24B',
    starter: false,
    tags: ['Chat', '24B'],
    description: 'Mistral Small 3.1 24B responsif untuk penalaran & ringkasan.',
  },
  {
    id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
    name: 'DeepSeek R1 Distill Qwen 32B',
    starter: true,
    tags: ['Chat', 'Reasoning'],
    description: 'Model reasoning terdistilasi dari DeepSeek R1 berbasis Qwen 32B.',
  },
  {
    id: '@cf/zai-org/glm-4.7-flash',
    name: 'GLM 4.7 Flash',
    starter: false,
    tags: ['Chat', 'Flash'],
    description: 'Model cepat & efisien untuk percakapan sehari-hari.',
  },
  {
    id: '@cf/ibm-granite/granite-4.0-h-micro',
    name: 'IBM Granite 4.0 H-Micro',
    starter: false,
    tags: ['Chat', 'Ultra Hemat'],
    description: 'Sangat hemat Neurons (~980K output token/hari dalam jatah gratis).',
  },
];

export function isValidHttpBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function validateProviderBaseUrl(value, provider = 'custom') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.includes('@') && !/^https?:\/\//i.test(trimmed)) {
    return {
      ok: false,
      error: 'Base URL terlihat seperti alamat email (terisi otomatis oleh browser). Kosongkan atau isi URL valid yang dimulai dengan https://.',
    };
  }
  if (!isValidHttpBaseUrl(trimmed)) {
    return {
      ok: false,
      error: 'Base URL tidak valid. Gunakan URL lengkap yang dimulai dengan https:// (misal https://api.provider.com/v1).',
    };
  }
  if (provider === 'cloudflare') {
    const parsed = new URL(trimmed);
    if (/[<{]account[_-]?id[>}]/i.test(trimmed) || !/\/accounts\/[^/]+\/ai/i.test(parsed.pathname)) {
      return {
        ok: false,
        error: 'Base URL REST Cloudflare harus berbentuk https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1 — atau kosongkan untuk memakai Binding env.AI.',
      };
    }
  }
  return { ok: true, value: trimmed };
}

export function resolveProviderApiBase(provider, baseUrl) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  const candidate = String(baseUrl || '').trim().replace(/\/+$/, '');
  const validCandidate = candidate && isValidHttpBaseUrl(candidate) ? candidate : '';
  const presetBase = String(preset.defaultBaseUrl || '').trim().replace(/\/+$/, '');
  const rawBase = validCandidate || presetBase;
  if (provider === 'cloudflare' && !rawBase) return '';
  // Never route an unknown or unconfigured provider to another provider's API.
  let base = rawBase;
  if (!base) return '';
  // Strip known endpoint suffixes if an admin pasted a full endpoint URL
  base = base
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/videos(?:\/generations)?$/i, '')
    .replace(/\/+$/, '');
  if (provider === 'alibaba') {
    // Model Studio memakai prefix {WorkspaceId}.<region>.maas.aliyuncs.com
    // tanpa akhiran /v1; endpoint dibangun worker dari base apa adanya.
    return base.replace(/\/api\/v1$/i, '').replace(/\/v1$/i, '');
  }
  if (/\/v1(?:beta)?$/i.test(base)) return base;
  return `${base}/v1`;
}

export function normalizeVideoStatus(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s || ['queued', 'pending', 'not_start', 'submitted', 'created'].includes(s)) return 'queued';
  if (['in_progress', 'processing', 'running', 'generating', 'started'].includes(s)) return 'in_progress';
  if (['completed', 'succeeded', 'success', 'done', 'finished'].includes(s)) return 'completed';
  if (['cancelled', 'canceled', 'aborted'].includes(s)) return 'cancelled';
  if (['expired', 'timeout', 'timed_out'].includes(s)) return 'expired';
  if (['failed', 'failure', 'error'].includes(s)) return 'failed';
  return 'in_progress';
}
