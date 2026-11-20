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
    label: 'Alibaba Wan 3.0',
    defaultBaseUrl: '',
    baseUrl: '',
    protocol: 'alibaba_video',
    description: 'Alibaba Model Studio Wan 3.0 Video (async task API). Base URL wajib: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com (ap-southeast-1 = Singapura)',
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

export const BUILTIN_VIDEO_MODELS = [
  {
    id: 'gemini-omni-1.2-flash:free',
    name: 'Google: Gemini Omni 1.2 Flash',
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
    name: 'Google: Gemini Omni 1.1 Flash',
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
    name: 'Google: Veo 3.1',
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
    name: 'Google: Veo 3.1 Fast',
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
    name: 'ByteDance: Seedance 1.5 Pro',
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
    name: 'xAI: Grok Video 3',
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
    id: 'wan3.0-video',
    name: 'Alibaba: Wan 3.0 Video',
    provider: 'alibaba',
    vendor: 'Alibaba',
    isFree: false,
    priceLabel: 'Berbayar (per detik)',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', 'adaptive'],
    resolutions: ['480p', '720p', '1080p'],
    durations: [2, 5, 10, 15, 20, 25, 30],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Wan 3.0 Video (Model Studio ap-southeast-1): text-to-video, image-to-video (first/last frame, mode frame) ATAU referensi multi-modal (maks 10 foto + 5 video + 5 audio; video/audio total ≤15 dtk; total ≤20) — kedua mode tidak bisa digabung. Base URL workspace wajib diisi di Admin Panel → API Key.',
  },
].map(withAudioFlag);

// Model video Alibaba yang punya adapter + pengujian di BLEA. provider_models
// bisa memuat ratusan model alibaba yang BUKAN video (chat/image/tts/asr) atau
// id kampanye yang belum diverifikasi — hanya id di sini yang boleh tampil di
// /api/video/models dan diterima /api/video/generate.
// 2026-11-20: happyhorse-1.1-i2v/t2v aktif di admin tapi ditolak Alibaba
// (i2v hanya menerima media type first_frame); belum ada adapter di BLEA.
export const ALIBABA_VIDEO_SUPPORTED_MODELS = Object.freeze(['wan3.0-video']);
export function isAlibabaVideoModelSupported(modelId) {
  return ALIBABA_VIDEO_SUPPORTED_MODELS.includes(String(modelId || '').toLowerCase().trim());
}

export function isVideoModelId(modelId) {
  const id = String(modelId || '').toLowerCase().trim();
  if (!id) return false;
  return /(^|\/)(veo|doubao-seedance|seedance|grok-video|grok-imagine-video|kling|wan\d|wan-|minimax-hailuo|minimax-h3|hailuo|vidu|jimeng|sora|gemini-omni)/i.test(id);
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

function resolveRawVideoProfile(modelId, provider = 'unorouter') {
  const id = String(modelId || '').trim();
  const lower = id.toLowerCase();
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
