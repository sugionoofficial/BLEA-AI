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
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultBaseUrl: 'https://openrouter.ai/api',
    baseUrl: 'https://openrouter.ai/api',
    protocol: 'openrouter_video',
    description: 'OpenRouter Video API (/api/v1/videos)',
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
    label: 'Alibaba Wan',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com',
    baseUrl: 'https://dashscope.aliyuncs.com',
    protocol: 'openai_video',
    description: 'Alibaba Wan 2.6 / 2.7',
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
    id: 'google/veo-3.1',
    name: 'Google: Veo 3.1 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'Google',
    isFree: false,
    priceLabel: 'Berbayar',
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p', '4K'],
    durations: [4, 6, 8],
    supportsImage: true,
    supportsVideo: false,
    supportsAudioInput: false,
    supportsAudioOutput: true,
    description: 'Google Veo 3.1 melalui OpenRouter Video API (/api/v1/videos).',
  },
  {
    id: 'bytedance/seedance-2.0',
    name: 'ByteDance: Seedance 2.0 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'ByteDance',
    isFree: false,
    priceLabel: 'Berbayar',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['480p', '720p', '1080p', '4K'],
    durations: [4, 5, 6, 8, 10, 12, 15],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Seedance 2.0 multimodal dengan dukungan gambar, referensi video & audio.',
  },
  {
    id: 'alibaba/wan-2.7',
    name: 'Alibaba: Wan 2.7 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'Alibaba',
    isFree: false,
    priceLabel: 'Berbayar',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resolutions: ['480p', '720p', '1080p'],
    durations: [5, 10, 15],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Alibaba Wan 2.7 untuk text-to-video, image-to-video & style guidance.',
  },
  {
    id: 'kwaivgi/kling-3.0',
    name: 'Kuaishou: Kling 3.0 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'Kuaishou',
    isFree: false,
    priceLabel: 'Berbayar',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9'],
    resolutions: ['720p', '1080p'],
    durations: [5, 10],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'Kling 3.0 dengan kontrol gerak sinematik dan referensi multimodal.',
  },
  {
    id: 'minimax/hailuo-3',
    name: 'MiniMax: Hailuo 3 (OpenRouter)',
    provider: 'openrouter',
    vendor: 'MiniMax',
    isFree: false,
    priceLabel: 'Berbayar',
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p', '1080p', '2K'],
    durations: [5, 6, 10],
    supportsImage: true,
    supportsVideo: true,
    supportsAudioInput: true,
    supportsAudioOutput: true,
    description: 'MiniMax Hailuo 3 mendukung gambar, referensi video & audio hingga 2K.',
  },
].map(withAudioFlag);

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

export function resolveProviderApiBase(provider, baseUrl) {
  const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.custom;
  let base = String(baseUrl || preset.defaultBaseUrl || 'https://api.unorouter.com').trim().replace(/\/+$/, '');
  if (!base) base = 'https://api.unorouter.com';
  // Strip known endpoint suffixes if an admin pasted a full endpoint URL
  base = base
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/videos(?:\/generations)?$/i, '')
    .replace(/\/+$/, '');
  if (provider === 'openrouter') {
    if (base.endsWith('/api/v1') || base.endsWith('/v1')) return base;
    if (base.endsWith('/api')) return `${base}/v1`;
    return `${base}/api/v1`;
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
