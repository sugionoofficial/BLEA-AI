import {
  METADATA_MAX_FILE_BYTES,
  METADATA_SERVICE_COST,
  METADATA_WORKER_PROCESS_MAX_BYTES,
  buildBinaryOnlyScan,
  compactScanSummary,
  detectMediaFormat,
  mergeAiScanFindings,
  scanMediaMetadata,
  stripMediaMetadata,
} from './mediaMetadata.js';
import { resolveProviderApiBase } from './videoCatalog.js';

const CLOUDFLARE_METADATA_VISION_MODELS = [
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/google/gemma-3-12b-it',
  '@cf/meta/llama-3.2-11b-vision-instruct',
];
const DATA_IMAGE_RE = /^data:image\/(?:jpeg|jpg|png|webp|gif);base64,[a-z0-9+/=]+$/i;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_BUCKET = 'ai-studio-uploads';

function supabaseBase(env) {
  return (env.SUPABASE_URL || 'https://lwknqvgnxgecptkvtkfb.supabase.co').replace(/\/+$/, '');
}

function base64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unbase64url(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeBase64(raw) {
  const clean = String(raw || '').replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function metadataMediaKey(env) {
  const secret = env.SUPABASE_SERVICE_ROLE_KEY || env.GITHUB_CLIENT_SECRET || env.SUPABASE_ANON_KEY || 'blea-metadata-media-dev';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`blea-metadata-media-v1:${secret}`));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signMetadataContentUrl(id, env, ttlMs = 2 * 60 * 60 * 1000) {
  const exp = String(Date.now() + ttlMs);
  const msg = new TextEncoder().encode(`meta:${id}:${exp}`);
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', await metadataMediaKey(env), msg));
  const sig = base64url(sigBytes);
  return `/api/metadata/content/${encodeURIComponent(id)}?exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
}

export async function verifyMetadataContentSig(id, exp, sig, env) {
  try {
    if (!id || !exp || !sig) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || Date.now() > expNum) return false;
    const msg = new TextEncoder().encode(`meta:${id}:${exp}`);
    return await crypto.subtle.verify('HMAC', await metadataMediaKey(env), unbase64url(sig), msg);
  } catch {
    return false;
  }
}

export function sanitizeCleanFilename(filename, ext = 'bin', jobId = '') {
  const base = String(filename || '')
    .replace(/^.*[\\/]/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140);
  const shortId = String(jobId || 'file').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'file';
  if (!base) return `clean-blea-${shortId}.${ext}`;
  const hasExt = /\.[a-z0-9]{2,5}$/i.test(base);
  const withExt = hasExt ? base : `${base}.${ext}`;
  return withExt.startsWith('clean-') ? withExt : `clean-${withExt}`;
}

function encodeStoragePath(objectPath) {
  return String(objectPath || '')
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

async function storageRequest(env, method, objectPath, { body, headers = {} } = {}) {
  const encoded = encodeStoragePath(objectPath);
  const url = `${supabaseBase(env)}/storage/v1/object/${STORAGE_BUCKET}/${encoded}`;
  return fetch(url, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY || 'sb_publishable_0M0DMfjajnpk6weWldy0iQ_lrzyuXTz',
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(45_000),
  });
}

function isSafeUserStoragePath(userId, storagePath) {
  const raw = String(storagePath || '').trim();
  if (!raw || raw.includes('..') || raw.startsWith('/')) return false;
  return raw.startsWith(`${userId}/`);
}

export async function sanitizeMetadataJobRow(row, env) {
  if (!row) return null;
  const completed = row.status === 'completed' && Boolean(row.cleaned_path);
  const resultUrl = completed ? await signMetadataContentUrl(row.id, env) : null;
  const downloadUrl = resultUrl ? `${resultUrl}&download=1` : null;
  return {
    id: row.id,
    user_id: row.user_id,
    kind: 'metadata',
    media_kind: row.media_kind,
    filename: row.filename,
    mime_type: row.mime_type,
    original_size: Number(row.original_size || 0),
    cleaned_size: Number(row.cleaned_size || 0),
    status: row.status,
    progress: Number(row.progress || 0),
    ai_detected: Boolean(row.ai_detected),
    detected_tools: Array.isArray(row.detected_tools) ? row.detected_tools : [],
    scan_before: row.scan_before && typeof row.scan_before === 'object' ? row.scan_before : {},
    scan_after: row.scan_after && typeof row.scan_after === 'object' ? row.scan_after : {},
    removed_count: Number(row.removed_count || 0),
    result_url: resultUrl,
    download_url: downloadUrl,
    credits_charged: Number(row.credits_charged || 0),
    credits_refunded: Number(row.credits_refunded || 0),
    error_message: row.error_message || null,
    created_at: row.created_at,
    updated_at: row.updated_at || row.created_at,
  };
}

async function refundMetadataCredits(env, creditRpc, userId, amount, jobId, description) {
  if (!amount || amount <= 0) return false;
  return creditRpc(env, 'refund_credits', {
    p_user_id: userId,
    p_amount: amount,
    p_description: description,
    p_generation_id: jobId,
  });
}

async function patchMetadataJob(servicePostgrest, env, jobId, patch) {
  const res = await servicePostgrest(env, `/metadata_jobs?id=eq.${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: { ...patch, updated_at: new Date().toISOString() },
  }).catch(() => null);
  if (!res?.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows?.[0] || null;
}

function extractCloudflareText(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  const raw = msg?.content;
  let text = '';
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    text = raw.map((p) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
  }
  if (!text.trim() && typeof data?.response === 'string') text = data.response;
  if (!text.trim() && typeof data?.result?.response === 'string') text = data.result.response;
  if (!text.trim() && typeof data?.output_text === 'string') text = data.output_text;
  return text.trim();
}

function parseAiScanJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const candidates = [stripped];
  const firstBrace = stripped.indexOf('{');
  const lastBrace = stripped.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1));
  }
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return {
    ai_detected: /terdeteksi|ai[-_\s]generated|c2pa|comfyui|sora|midjourney|stable diffusion|wan|kling|veo|imagen|dall-e|flux|runway/i.test(raw),
    confidence: 'sedang',
    visual_assessment: raw.slice(0, 500),
    detected_models: [],
    metadata_tags_to_remove: [],
    summary: raw.slice(0, 300),
  };
}

function hasValidCfRestBase(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!raw || !/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    return !/[<{]account[_-]?id[>}]/i.test(raw) && /\/accounts\/[^/]+\/ai/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

const METADATA_AI_SCAN_BUDGET_MS = 90_000; // total anggaran pindai AI multi-provider
const CLOUDFLARE_VISION_TIMEOUT_MS = 30_000;
const FALLBACK_VISION_TIMEOUT_MS = 25_000;
const MAX_FALLBACK_VISION_CANDIDATES = 5;

// Model vision cadangan di provider lain, dipakai setelah semua model
// Cloudflare gagal / kuota hariannya habis. Model vision yang benar-benar
// terdaftar di Admin Panel (provider_models) selalu dicoba lebih dulu.
const PROVIDER_FALLBACK_VISION_MODELS = {
  google: ['gemini-2.0-flash', 'gemini-2.5-flash'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini'],
  alibaba: ['qwen-vl-max-latest', 'qwen-vl-plus-latest'],
  unorouter: ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini'],
  pekpik: ['gpt-4o-mini', 'gemini-2.0-flash'],
};
const FALLBACK_PROVIDER_ORDER = [
  'google', 'openai', 'alibaba', 'unorouter', 'pekpik',
  'custom', 'ollama', 'xai', 'doubao', 'kling', 'hailuo',
];
const VISION_MODEL_RE = /(?:^|[/:_.-])(?:vl|vision|vlm|llava|internvl|pixtral|omni)(?:$|[/:_.-])|gemini|gpt-4o|gpt-4\.1|claude-(?:3|4)|glm-4\.?[0-9]?v|grok-[0-9.]*vision|qwen[0-9.]*-vl/i;
const NON_VISION_MODEL_RE = /embed|rerank|whisper|\btts\b|speech|image|flux|stable-diffusion|midjourney|moderation|bge-|dance|music|video|sora|veo|kling|hailuo/i;

// Kuota habis / rate limit / kapasitas penuh → model ini dilewati dan rantai
// berpindah ke model berikutnya. Error lain (model tidak dikenal, key salah)
// juga dilewati, tetapi dicatat sebagai kegagalan provider.
function isQuotaOrCapacityError(status, detail) {
  const msg = String(detail || '');
  if (status === 402 || status === 429) return true;
  if (!msg) return false;
  return /quota|neuron|rate.?limit|too many requests|daily free allocation|exceeded|out of capacity|no capacity|capacity|insufficient|credit balance|billing/i.test(msg);
}

function buildVisionChatUrl(provider, baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (provider === 'google') {
    const root = base.replace(/\/v1beta\/openai$/i, '').replace(/\/v1beta$/i, '').replace(/\/v1$/i, '');
    return `${root}/v1beta/openai/chat/completions`;
  }
  if (provider === 'alibaba') {
    const root = base.replace(/\/compatible-mode\/v1$/i, '').replace(/\/api\/v1$/i, '');
    return `${root}/compatible-mode/v1/chat/completions`;
  }
  if (/\/v1(?:beta)?$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

async function loadCloudflareVisionRest({ env, servicePostgrest }) {
  try {
    const keyRes = await servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url&provider=eq.cloudflare&limit=1');
    const rows = keyRes?.ok ? await keyRes.json().catch(() => []) : [];
    const row = rows?.[0];
    if (row?.api_key && row.api_key !== 'binding:AI' && hasValidCfRestBase(row.base_url)) {
      return {
        key: String(row.api_key).trim(),
        base: String(row.base_url).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, ''),
      };
    }
  } catch {
    // tabel key tidak terbaca → tetap boleh memakai binding env.AI
  }
  return { key: '', base: '' };
}

function buildFallbackVisionCandidates({ keyRows, modelRows }) {
  const keyByProvider = new Map();
  for (const row of Array.isArray(keyRows) ? keyRows : []) {
    const provider = String(row?.provider || '').trim().toLowerCase();
    if (!provider || provider === 'cloudflare' || provider === 'freebeat') continue;
    if (!row?.api_key || row.api_key === 'binding:AI') continue;
    keyByProvider.set(provider, row);
  }
  if (keyByProvider.size === 0) return [];

  const visionModelsByProvider = new Map();
  for (const row of Array.isArray(modelRows) ? modelRows : []) {
    const provider = String(row?.provider || '').trim().toLowerCase();
    const model = String(row?.model || '').trim();
    if (!provider || !model) continue;
    if (!VISION_MODEL_RE.test(model) || NON_VISION_MODEL_RE.test(model)) continue;
    if (!visionModelsByProvider.has(provider)) visionModelsByProvider.set(provider, []);
    const list = visionModelsByProvider.get(provider);
    if (!list.includes(model) && list.length < 2) list.push(model);
  }

  const ordered = [
    ...FALLBACK_PROVIDER_ORDER.filter((provider) => keyByProvider.has(provider)),
    ...[...keyByProvider.keys()].filter((provider) => !FALLBACK_PROVIDER_ORDER.includes(provider)),
  ];

  const candidates = [];
  for (const provider of ordered) {
    const keyRow = keyByProvider.get(provider);
    const baseUrl = resolveProviderApiBase(provider, keyRow?.base_url) || '';
    if (!baseUrl) continue;
    const models = [
      ...(visionModelsByProvider.get(provider) || []),
      ...(PROVIDER_FALLBACK_VISION_MODELS[provider] || []),
    ];
    for (const model of [...new Set(models)].slice(0, 2)) {
      candidates.push({ provider, model, apiKey: keyRow.api_key, baseUrl });
    }
  }
  return candidates.slice(0, MAX_FALLBACK_VISION_CANDIDATES);
}

async function loadFallbackVisionCandidates({ env, servicePostgrest }) {
  try {
    const [keysRes, modelsRes] = await Promise.all([
      servicePostgrest(env, '/provider_api_keys?select=provider,api_key,base_url&order=provider'),
      servicePostgrest(env, '/provider_models?select=provider,model,active&active=eq.true&limit=500').catch(() => null),
    ]);
    const keyRows = keysRes?.ok ? await keysRes.json().catch(() => []) : [];
    const modelRows = modelsRes?.ok ? await modelsRes.json().catch(() => []) : [];
    return buildFallbackVisionCandidates({ keyRows, modelRows });
  } catch {
    return [];
  }
}

// Satu panggilan chat-completions OpenAI-compatible dengan lampiran frame visual.
async function postVisionChat({ url, apiKey, model, messages, timeoutMs }) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: 1400 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const rawText = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, status: res.status, detail: (rawText || `HTTP ${res.status}`).replace(/\s+/g, ' ').slice(0, 260) };
  }
  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    data = {};
  }
  const text = extractCloudflareText(data);
  if (!text) return { ok: false, status: res.status, detail: 'Respons model kosong.' };
  return { ok: true, text };
}

// Rantai pindai AI: model Cloudflare (REST/binding) → model vision provider
// lain yang aktif → (jika semua gagal) pemindaian biner tanpa AI.
async function runMetadataVisionScan({ env, servicePostgrest, messages }) {
  const deadline = Date.now() + METADATA_AI_SCAN_BUDGET_MS;
  const failures = [];
  const hasBinding = Boolean(env?.AI && typeof env.AI.run === 'function');
  const cfRest = await loadCloudflareVisionRest({ env, servicePostgrest });

  const singleFrameMessages = messages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const textParts = msg.content.filter((p) => p?.type === 'text');
    const imgParts = msg.content.filter((p) => p?.type === 'image_url').slice(0, 1);
    return { ...msg, content: [...textParts, ...imgParts] };
  });
  const messageVariants = messages === singleFrameMessages ? [messages] : [messages, singleFrameMessages];

  if (!hasBinding && !cfRest.key) {
    failures.push('Cloudflare Workers AI belum aktif (binding env.AI / REST API)');
  } else {
    for (const model of CLOUDFLARE_METADATA_VISION_MODELS) {
      let quotaHit = false;
      for (const msgList of messageVariants) {
        if (Date.now() > deadline) break;
        if (cfRest.key) {
          try {
            const attempt = await postVisionChat({
              url: `${cfRest.base}/chat/completions`,
              apiKey: cfRest.key,
              model,
              messages: msgList,
              timeoutMs: CLOUDFLARE_VISION_TIMEOUT_MS,
            });
            if (attempt.ok) return { ok: true, provider: 'cloudflare', model, mode: 'rest', text: attempt.text, fallback: false };
            failures.push(`Cloudflare REST ${model}: ${attempt.detail}`);
            if (isQuotaOrCapacityError(attempt.status, attempt.detail)) quotaHit = true;
          } catch (err) {
            const message = String(err?.message || err).slice(0, 160);
            failures.push(`Cloudflare REST ${model}: ${message}`);
            if (isQuotaOrCapacityError(err?.status || err?.code, message)) quotaHit = true;
          }
        }
        if (hasBinding) {
          try {
            const data = await env.AI.run(model, {
              messages: msgList,
              temperature: 0.1,
              max_tokens: 1400,
            });
            const text = extractCloudflareText(data);
            if (text) return { ok: true, provider: 'cloudflare', model, mode: 'binding', text, fallback: false };
            failures.push(`Cloudflare ${model}: respons kosong`);
          } catch (err) {
            const message = String(err?.message || err).slice(0, 160);
            failures.push(`Cloudflare ${model}: ${message}`);
            if (isQuotaOrCapacityError(err?.status || err?.code, message)) quotaHit = true;
          }
        }
        // Kuota model ini sudah habis → tidak perlu mengulang dengan frame
        // lebih sedikit; langsung pindah ke model berikutnya.
        if (quotaHit) break;
      }
    }
  }

  const fallbackCandidates = await loadFallbackVisionCandidates({ env, servicePostgrest });
  for (const cand of fallbackCandidates) {
    if (Date.now() > deadline) break;
    const url = buildVisionChatUrl(cand.provider, cand.baseUrl);
    if (!url) continue;
    for (const msgList of messageVariants) {
      if (Date.now() > deadline) break;
      try {
        const attempt = await postVisionChat({
          url,
          apiKey: cand.apiKey,
          model: cand.model,
          messages: msgList,
          timeoutMs: FALLBACK_VISION_TIMEOUT_MS,
        });
        if (attempt.ok) {
          return {
            ok: true,
            provider: cand.provider,
            model: cand.model,
            mode: 'fallback',
            text: attempt.text,
            fallback: true,
          };
        }
        failures.push(`${cand.provider} ${cand.model}: ${attempt.detail}`);
        // Kuota/rate limit → coba model lain; error lain (model/endpoint salah)
        // → langsung pindah ke provider berikutnya.
        if (!isQuotaOrCapacityError(attempt.status, attempt.detail)) break;
      } catch (err) {
        failures.push(`${cand.provider} ${cand.model}: ${String(err?.message || err).slice(0, 160)}`);
        break;
      }
    }
  }

  return {
    ok: false,
    code: 'ai_scan_unavailable',
    error: failures.length
      ? `Kuota semua model AI habis atau model tidak tersedia (${failures.slice(-3).join(' · ')})`
      : 'Tidak ada model AI vision yang aktif untuk memindai media.',
    failures,
  };
}

export async function handleMetadataScan({ request, env, user, jsonResponse, servicePostgrest }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const filename = String(body.filename || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
  const mimeType = String(body.mime_type || '').trim().slice(0, 100);
  const mediaKind = body.media_kind === 'video' || mimeType.startsWith('video/') ? 'video' : 'image';
  const fileSize = Number(body.file_size || 0);
  const binaryScan = compactScanSummary(body.binary_scan || {});

  const rawFrames = Array.isArray(body.frames) ? body.frames : [];
  const validFrames = rawFrames
    .filter((item) => typeof item === 'string' && item.length <= 750_000 && DATA_IMAGE_RE.test(item.trim()))
    .map((item) => item.trim())
    .slice(0, 3);

  const entriesForPrompt = Array.isArray(binaryScan.entries)
    ? binaryScan.entries.slice(0, 40).map((e) => `- [${e.group}] ${e.key}: ${e.value} (${e.location})`).join('\n')
    : '';

  const promptText = [
    'Kamu adalah analis forensik media & metadata AI untuk BLEA AI. Jawab HANYA dalam JSON valid tanpa markdown tambahan.',
    `File: "${filename}" | Tipe: ${mediaKind === 'video' ? 'Video' : 'Gambar'} (${binaryScan.formatLabel || mimeType || 'media'}) | Ukuran: ${fileSize} byte | Frame visual terlampir: ${validFrames.length}`,
    '',
    'Tugasmu:',
    '1. Amati visual gambar / frame video terlampir secara teliti (cari ciri generasi AI, watermark/logo generator AI seperti Sora, Veo, Wan, Kling, Midjourney, DALL-E, Runway, Gemini, dll).',
    '2. Periksa seluruh daftar tag metadata file di bawah ini — temukan setiap NAMA MODEL AI, nama generator, workflow (ComfyUI/A1111/Flux), C2PA/JUMBF, AIGC, XMP, EXIF Software/CreatorTool/Artist/UserComment, atau atom video (udta/meta/ilst/hdlr/Tags/WritingApp) yang menandakan AI atau perlu dihapus.',
    '3. Kembalikan JSON persis berformat:',
    '{',
    '  "ai_detected": true/false,',
    '  "confidence": "tinggi" | "sedang" | "rendah",',
    '  "visual_assessment": "penjelasan singkat hasil pembacaan visual gambar/frame video dalam Bahasa Indonesia",',
    '  "detected_models": ["Daftar nama model / generator AI yang ditemukan"],',
    '  "metadata_tags_to_remove": [{"tag": "nama tag/chunk", "value": "isi/nama model", "category": "kategori", "model_name": "nama model jika ada", "reason": "alasan tag ini menandakan AI dan akan dihapus"}],',
    '  "summary": "ringkasan 1-2 kalimat dalam Bahasa Indonesia"',
    '}',
    '',
    entriesForPrompt
      ? `Daftar tag metadata mentah yang diekstrak dari file:\n${entriesForPrompt}`
      : 'Daftar tag metadata mentah dari file: (tidak ada tag metadata biner yang ditemukan di header/container file).',
  ].join('\n');

  const userContent = validFrames.length > 0
    ? [
        { type: 'text', text: promptText },
        ...validFrames.map((url) => ({ type: 'image_url', image_url: { url } })),
      ]
    : promptText;

  const messages = [
    {
      role: 'system',
      content: 'Anda adalah sistem inspeksi visual & metadata AI. Selalu keluarkan JSON valid.',
    },
    { role: 'user', content: userContent },
  ];

  const aiResult = await runMetadataVisionScan({ env, servicePostgrest, messages });
  if (!aiResult.ok) {
    // Semua model AI gagal / kuota habis → jangan blokir pengguna. Pembersihan
    // metadata tetap berjalan penuh lewat pemindai container biner lossless.
    const binaryOnly = buildBinaryOnlyScan(binaryScan, aiResult.error);
    return jsonResponse({
      ok: true,
      ai_skipped: true,
      ai_skip_reason: aiResult.error,
      ai_attempts: Array.isArray(aiResult.failures) ? aiResult.failures.slice(-5) : [],
      scan: binaryOnly,
    });
  }

  const parsed = parseAiScanJson(aiResult.text);
  const merged = mergeAiScanFindings(binaryScan, parsed, {
    provider: aiResult.provider,
    model: aiResult.model,
    mode: aiResult.mode,
    fallback: Boolean(aiResult.fallback),
    framesAnalyzed: validFrames.length,
  });

  return jsonResponse({
    ok: true,
    ai_skipped: false,
    ai: {
      provider: aiResult.provider,
      model: aiResult.model,
      mode: aiResult.mode,
      fallback: Boolean(aiResult.fallback),
    },
    scan: merged,
  });
}

export async function handleMetadataStart({ request, env, user, jsonResponse, servicePostgrest, creditRpc }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const filename = String(body.filename || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
  const mimeType = String(body.mime_type || '').trim().slice(0, 100);
  const mediaKind = body.media_kind === 'video' || mimeType.startsWith('video/') ? 'video' : 'image';
  const originalSize = Number(body.original_size || 0);
  const scanBefore = compactScanSummary(body.scan_before);

  if (!Number.isFinite(originalSize) || originalSize <= 0 || originalSize > METADATA_MAX_FILE_BYTES) {
    return jsonResponse({
      error: `Ukuran file harus antara 1 byte dan ${Math.round(METADATA_MAX_FILE_BYTES / (1024 * 1024))} MB.`,
    }, 400);
  }

  const jobId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  const insertRes = await servicePostgrest(env, '/metadata_jobs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: [{
      id: jobId,
      user_id: user.id,
      media_kind: mediaKind,
      filename,
      mime_type: mimeType,
      original_size: originalSize,
      cleaned_size: 0,
      status: 'processing',
      progress: 15,
      ai_detected: Boolean(scanBefore.aiDetected),
      detected_tools: scanBefore.detectedTools || [],
      scan_before: scanBefore,
      scan_after: {},
      removed_count: 0,
      credits_charged: 0,
      credits_refunded: 0,
      created_at: nowIso,
      updated_at: nowIso,
    }],
  });
  if (!insertRes?.ok) {
    const errText = insertRes ? await insertRes.text().catch(() => '') : '';
    return jsonResponse({ error: 'Gagal membuat antrean pembersihan metadata.', detail: errText.slice(0, 200) }, 500);
  }
  const insertedRows = await insertRes.json().catch(() => []);
  const row = insertedRows?.[0];
  if (!row) return jsonResponse({ error: 'Gagal membaca antrean pembersihan metadata.' }, 500);

  const spent = await creditRpc(env, 'spend_credits', {
    p_user_id: user.id,
    p_amount: METADATA_SERVICE_COST,
    p_description: `Hapus metadata AI (${filename.slice(0, 120)})`,
    p_generation_id: jobId,
  });

  if (!spent) {
    await servicePostgrest(env, `/metadata_jobs?id=eq.${encodeURIComponent(jobId)}`, { method: 'DELETE' }).catch(() => {});
    return jsonResponse({
      error: `Saldo kredit BLEA Anda tidak cukup. Biaya pembersihan metadata adalah ${METADATA_SERVICE_COST} kredit.`,
      code: 'insufficient_credits',
      required: METADATA_SERVICE_COST,
    }, 402);
  }

  const patched = await patchMetadataJob(servicePostgrest, env, jobId, {
    credits_charged: METADATA_SERVICE_COST,
    progress: 25,
  });
  return jsonResponse({
    ok: true,
    cost: METADATA_SERVICE_COST,
    job: await sanitizeMetadataJobRow(patched || { ...row, credits_charged: METADATA_SERVICE_COST, progress: 25 }, env),
  });
}

export async function handleMetadataProcess({ request, env, user, jsonResponse, servicePostgrest, creditRpc }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);

  const contentType = (request.headers.get('content-type') || '').toLowerCase();
  let jobId = '';
  let filename = '';
  let mimeType = '';
  let inputBytes = null;
  let storagePath = '';
  let clientCleaned = false;
  let clientFailed = false;
  let clientErrorMessage = '';
  let clientCleanedSize = 0;
  let clientRemovedCount = 0;
  let clientScanBefore = null;
  let clientScanAfter = null;
  let clientCleanedStoragePath = '';

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return jsonResponse({ error: 'Payload form tidak valid.' }, 400);
    jobId = String(form.get('id') || '').trim();
    const file = form.get('file');
    filename = String(form.get('filename') || (file && typeof file === 'object' ? file.name : '') || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
    mimeType = String(form.get('mime_type') || (file && typeof file === 'object' ? file.type : '') || '').trim();
    if (file && typeof file === 'object' && typeof file.arrayBuffer === 'function') {
      const buf = await file.arrayBuffer();
      inputBytes = new Uint8Array(buf);
    }
  } else {
    const body = await request.json().catch(() => ({}));
    jobId = String(body.id || '').trim();
    filename = String(body.filename || 'media').replace(/^.*[\\/]/, '').trim().slice(0, 260) || 'media';
    mimeType = String(body.mime_type || '').trim();
    storagePath = String(body.storage_path || '').trim();
    clientCleaned = body.client_cleaned === true;
    clientFailed = body.client_failed === true;
    clientErrorMessage = String(body.error_message || '').trim().slice(0, 300);
    clientCleanedSize = Number(body.cleaned_size || 0);
    clientRemovedCount = Number(body.removed_count || 0);
    clientScanBefore = body.scan_before && typeof body.scan_before === 'object' ? body.scan_before : null;
    clientScanAfter = body.scan_after && typeof body.scan_after === 'object' ? body.scan_after : null;
    clientCleanedStoragePath = String(body.cleaned_storage_path || '').trim();
    if (typeof body.base64 === 'string' && body.base64.trim()) {
      try {
        inputBytes = decodeBase64(body.base64);
      } catch {
        return jsonResponse({ error: 'Data base64 file tidak valid.' }, 400);
      }
    }
  }

  let existingJob = null;
  let chargedAmount = 0;

  if (jobId) {
    if (!UUID_RE.test(jobId)) return jsonResponse({ error: 'ID proses metadata tidak valid.' }, 400);
    const rowRes = await servicePostgrest(env, `/metadata_jobs?select=*&id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(user.id)}&limit=1`);
    const rows = rowRes?.ok ? await rowRes.json().catch(() => []) : [];
    existingJob = rows?.[0] || null;
    if (!existingJob) return jsonResponse({ error: 'Proses pembersihan metadata tidak ditemukan.' }, 404);
    if (existingJob.status === 'completed') {
      return jsonResponse({
        ok: true,
        job: await sanitizeMetadataJobRow(existingJob, env),
      });
    }
    if (existingJob.status === 'cancelled' || existingJob.status === 'failed') {
      return jsonResponse({ error: existingJob.error_message || 'Proses ini sudah dihentikan.' }, 409);
    }
    filename = existingJob.filename || filename;
    mimeType = existingJob.mime_type || mimeType;
    chargedAmount = Number(existingJob.credits_charged || 0);
  }

  const failAndRefund = async (message, status = 500) => {
    if (existingJob?.id) {
      let refunded = Number(existingJob.credits_refunded || 0);
      if (chargedAmount > 0 && refunded === 0) {
        const didRefund = await refundMetadataCredits(
          env,
          creditRpc,
          user.id,
          chargedAmount,
          existingJob.id,
          `Refund: gagal membersihkan metadata (${filename.slice(0, 100)})`,
        );
        if (didRefund) refunded = chargedAmount;
      }
      await patchMetadataJob(servicePostgrest, env, existingJob.id, {
        status: 'failed',
        progress: 0,
        credits_refunded: refunded,
        error_message: String(message || 'Gagal membersihkan metadata').slice(0, 300),
      });
    }
    return jsonResponse({ error: message }, status);
  };

  try {
    if (clientFailed) {
      if (!existingJob) return jsonResponse({ error: 'Proses metadata tidak ditemukan.' }, 404);
      return await failAndRefund(clientErrorMessage || 'Pembersihan metadata pada browser gagal diproses.', 500);
    }

    if (clientCleaned) {
      if (!existingJob) return jsonResponse({ error: 'Proses pembersihan metadata wajib dimulai lewat /api/metadata/start.' }, 400);
      let verifiedCleanedPath = null;
      if (clientCleanedStoragePath) {
        if (
          !isSafeUserStoragePath(user.id, clientCleanedStoragePath)
          || !clientCleanedStoragePath.includes(`/metadata-clean/${existingJob.id}/`)
        ) {
          return await failAndRefund('Path file hasil bersih tidak valid.', 403);
        }
        const probeRes = await storageRequest(env, 'GET', clientCleanedStoragePath, {
          headers: { range: 'bytes=0-0' },
        }).catch(() => null);
        if (probeRes?.ok || probeRes?.status === 206) {
          verifiedCleanedPath = clientCleanedStoragePath;
        }
      }

      const existingBefore = existingJob.scan_before && typeof existingJob.scan_before === 'object' ? existingJob.scan_before : {};
      const nextBefore = clientScanBefore ? compactScanSummary(clientScanBefore) : {};
      const mergedTools = Array.from(new Set([
        ...(Array.isArray(nextBefore.detectedTools) ? nextBefore.detectedTools : []),
        ...(Array.isArray(existingJob.detected_tools) ? existingJob.detected_tools : []),
        ...(Array.isArray(existingBefore.detectedTools) ? existingBefore.detectedTools : []),
      ].filter(Boolean))).slice(0, 16);
      const beforeSummary = {
        ...existingBefore,
        ...nextBefore,
        aiDetected: Boolean(nextBefore.aiDetected || existingJob.ai_detected || existingBefore.aiDetected),
        detectedTools: mergedTools,
        ...(existingBefore.aiEngine ? { aiEngine: existingBefore.aiEngine } : {}),
        ...(existingBefore.confidence ? { confidence: existingBefore.confidence } : {}),
        ...(existingBefore.visualAssessment ? { visualAssessment: existingBefore.visualAssessment } : {}),
        ...(existingBefore.aiSummary ? { aiSummary: existingBefore.aiSummary } : {}),
        ...(Array.isArray(existingBefore.entries) && existingBefore.entries.length >= (nextBefore.entries?.length || 0)
          ? { entries: existingBefore.entries }
          : {}),
      };
      const afterSummary = compactScanSummary(clientScanAfter || { totalEntries: 0, aiDetected: false, detectedTools: [], entries: [] });
      const finalCleanedSize = Number.isFinite(clientCleanedSize) && clientCleanedSize > 0
        ? Math.min(clientCleanedSize, METADATA_MAX_FILE_BYTES)
        : Number(existingJob.original_size || 0);
      const finalRemovedCount = Math.max(0, Math.round(Number(clientRemovedCount || 0)));

      const doneRow = await patchMetadataJob(servicePostgrest, env, existingJob.id, {
        cleaned_size: finalCleanedSize,
        status: 'completed',
        progress: 100,
        ai_detected: Boolean(beforeSummary.aiDetected),
        detected_tools: beforeSummary.detectedTools || [],
        scan_before: beforeSummary,
        scan_after: afterSummary,
        removed_count: finalRemovedCount,
        cleaned_path: verifiedCleanedPath,
        error_message: null,
      });

      const sanitized = await sanitizeMetadataJobRow(doneRow || {
        ...existingJob,
        cleaned_size: finalCleanedSize,
        status: 'completed',
        progress: 100,
        ai_detected: Boolean(beforeSummary.aiDetected),
        detected_tools: beforeSummary.detectedTools || [],
        scan_before: beforeSummary,
        scan_after: afterSummary,
        removed_count: finalRemovedCount,
        cleaned_path: verifiedCleanedPath,
      }, env);

      return jsonResponse({
        ok: true,
        job: sanitized,
        removedCount: finalRemovedCount,
        before: beforeSummary,
        after: afterSummary,
        localOnlyDownload: !verifiedCleanedPath,
      });
    }

    if (!inputBytes && storagePath) {
      if (!isSafeUserStoragePath(user.id, storagePath)) {
        return await failAndRefund('Path file unggahan tidak valid.', 403);
      }
      const dlRes = await storageRequest(env, 'GET', storagePath);
      if (!dlRes.ok) {
        return await failAndRefund('Gagal mengunduh file sementara dari penyimpanan.', 502);
      }
      inputBytes = new Uint8Array(await dlRes.arrayBuffer());
    }

    if (!inputBytes || inputBytes.length === 0) {
      return await failAndRefund('File media wajib disertakan untuk dibersihkan.', 400);
    }
    if (inputBytes.length > METADATA_MAX_FILE_BYTES) {
      return await failAndRefund(`Ukuran file melebihi batas ${Math.round(METADATA_MAX_FILE_BYTES / (1024 * 1024))} MB.`, 400);
    }
    if (inputBytes.length > METADATA_WORKER_PROCESS_MAX_BYTES) {
      return await failAndRefund(`File di atas ${Math.round(METADATA_WORKER_PROCESS_MAX_BYTES / (1024 * 1024))} MB diproses langsung melalui mode browser.`, 413);
    }

    const detected = detectMediaFormat(inputBytes, { fileName: filename, mimeType });
    if (detected.format === 'unsupported') {
      return await failAndRefund('Format file tidak didukung. Gunakan PNG, JPG/JPEG, WebP, GIF, MP4, MOV, atau WebM.', 400);
    }

    // Create & charge job now if caller hit /api/metadata/process directly without /start
    if (!existingJob) {
      const scanBefore = compactScanSummary(await scanMediaMetadata(inputBytes, { fileName: filename, mimeType: detected.mimeType }));
      const newId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const ins = await servicePostgrest(env, '/metadata_jobs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: [{
          id: newId,
          user_id: user.id,
          media_kind: detected.mediaKind,
          filename,
          mime_type: detected.mimeType,
          original_size: inputBytes.length,
          cleaned_size: 0,
          status: 'processing',
          progress: 25,
          ai_detected: Boolean(scanBefore.aiDetected),
          detected_tools: scanBefore.detectedTools || [],
          scan_before: scanBefore,
          scan_after: {},
          removed_count: 0,
          credits_charged: 0,
          credits_refunded: 0,
          created_at: nowIso,
          updated_at: nowIso,
        }],
      });
      if (!ins?.ok) {
        return jsonResponse({ error: 'Gagal membuat catatan pembersihan metadata.' }, 500);
      }
      const rows = await ins.json().catch(() => []);
      existingJob = rows?.[0];
      const spent = await creditRpc(env, 'spend_credits', {
        p_user_id: user.id,
        p_amount: METADATA_SERVICE_COST,
        p_description: `Hapus metadata AI (${filename.slice(0, 120)})`,
        p_generation_id: newId,
      });
      if (!spent) {
        await servicePostgrest(env, `/metadata_jobs?id=eq.${encodeURIComponent(newId)}`, { method: 'DELETE' }).catch(() => {});
        return jsonResponse({
          error: `Saldo kredit BLEA Anda tidak cukup. Biaya pembersihan metadata adalah ${METADATA_SERVICE_COST} kredit.`,
          code: 'insufficient_credits',
          required: METADATA_SERVICE_COST,
        }, 402);
      }
      chargedAmount = METADATA_SERVICE_COST;
      existingJob = await patchMetadataJob(servicePostgrest, env, newId, {
        credits_charged: METADATA_SERVICE_COST,
        progress: 45,
      }) || { ...existingJob, credits_charged: METADATA_SERVICE_COST };
    } else {
      await patchMetadataJob(servicePostgrest, env, existingJob.id, { progress: 50 });
    }

    const stripped = await stripMediaMetadata(inputBytes, { fileName: filename, mimeType: detected.mimeType });

    await patchMetadataJob(servicePostgrest, env, existingJob.id, { progress: 80 });

    const cleanName = sanitizeCleanFilename(filename, stripped.ext, existingJob.id);
    const cleanedPath = `${user.id}/metadata-clean/${existingJob.id}/${cleanName}`;
    const upRes = await storageRequest(env, 'POST', cleanedPath, {
      body: stripped.cleanedBytes,
      headers: {
        'content-type': stripped.mimeType || 'application/octet-stream',
        'x-upsert': 'true',
      },
    });
    if (!upRes.ok) {
      const upErr = await upRes.text().catch(() => '');
      return await failAndRefund(`Gagal menyimpan file hasil bersih (${upRes.status}). ${upErr.slice(0, 120)}`, 502);
    }

    if (storagePath && isSafeUserStoragePath(user.id, storagePath)) {
      await storageRequest(env, 'DELETE', storagePath).catch(() => {});
    }

    const existingBefore = existingJob.scan_before && typeof existingJob.scan_before === 'object' ? existingJob.scan_before : {};
    const rawBeforeSummary = compactScanSummary(stripped.before);
    const mergedTools = Array.from(new Set([
      ...(Array.isArray(rawBeforeSummary.detectedTools) ? rawBeforeSummary.detectedTools : []),
      ...(Array.isArray(existingJob.detected_tools) ? existingJob.detected_tools : []),
      ...(Array.isArray(existingBefore.detectedTools) ? existingBefore.detectedTools : []),
    ].filter(Boolean))).slice(0, 16);
    const beforeSummary = {
      ...rawBeforeSummary,
      aiDetected: Boolean(rawBeforeSummary.aiDetected || existingJob.ai_detected || existingBefore.aiDetected),
      detectedTools: mergedTools,
      ...(existingBefore.aiEngine ? { aiEngine: existingBefore.aiEngine } : {}),
      ...(existingBefore.confidence ? { confidence: existingBefore.confidence } : {}),
      ...(existingBefore.visualAssessment ? { visualAssessment: existingBefore.visualAssessment } : {}),
      ...(existingBefore.aiSummary ? { aiSummary: existingBefore.aiSummary } : {}),
      ...(Array.isArray(existingBefore.entries) && existingBefore.entries.length >= rawBeforeSummary.entries.length
        ? { entries: existingBefore.entries }
        : {}),
    };
    const afterSummary = compactScanSummary(stripped.after);
    const doneRow = await patchMetadataJob(servicePostgrest, env, existingJob.id, {
      media_kind: stripped.mediaKind,
      mime_type: stripped.mimeType,
      original_size: stripped.originalSize,
      cleaned_size: stripped.cleanedSize,
      status: 'completed',
      progress: 100,
      ai_detected: Boolean(beforeSummary.aiDetected),
      detected_tools: beforeSummary.detectedTools || [],
      scan_before: beforeSummary,
      scan_after: afterSummary,
      removed_count: stripped.removedCount,
      cleaned_path: cleanedPath,
      error_message: null,
    });

    const sanitized = await sanitizeMetadataJobRow(doneRow || {
      ...existingJob,
      media_kind: stripped.mediaKind,
      mime_type: stripped.mimeType,
      original_size: stripped.originalSize,
      cleaned_size: stripped.cleanedSize,
      status: 'completed',
      progress: 100,
      ai_detected: Boolean(beforeSummary.aiDetected),
      detected_tools: beforeSummary.detectedTools || [],
      scan_before: beforeSummary,
      scan_after: afterSummary,
      removed_count: stripped.removedCount,
      cleaned_path: cleanedPath,
    }, env);

    return jsonResponse({
      ok: true,
      job: sanitized,
      removedCount: stripped.removedCount,
      before: stripped.before,
      after: stripped.after,
    });
  } catch (err) {
    return await failAndRefund(String(err?.message || err || 'Gagal memproses metadata.'), 500);
  }
}

export async function handleMetadataHistory({ request, env, user, jsonResponse, servicePostgrest }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Number(body?.offset || 0) || 0);
  const limit = 20;
  const res = await servicePostgrest(
    env,
    `/metadata_jobs?select=*&user_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&offset=${offset}&limit=${limit + 1}`,
  );
  if (!res?.ok) {
    return jsonResponse({ error: 'Gagal memuat riwayat cek metadata.' }, 500);
  }
  const rows = await res.json().catch(() => []);
  const hasMore = Array.isArray(rows) && rows.length > limit;
  const slice = Array.isArray(rows) ? rows.slice(0, limit) : [];
  const jobs = await Promise.all(slice.map((row) => sanitizeMetadataJobRow(row, env)));
  return jsonResponse({ ok: true, jobs, hasMore });
}

export async function handleMetadataStatus({ request, env, user, jsonResponse, servicePostgrest }) {
  if (!user) return jsonResponse({ error: 'Login diperlukan.' }, 401);
  const body = await request.json().catch(() => ({}));
  const id = String(body?.id || '').trim();
  if (!UUID_RE.test(id)) return jsonResponse({ error: 'ID metadata tidak valid.' }, 400);
  const res = await servicePostgrest(env, `/metadata_jobs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  const rows = res?.ok ? await res.json().catch(() => []) : [];
  const row = rows?.[0];
  if (!row) return jsonResponse({ error: 'Riwayat metadata tidak ditemukan.' }, 404);
  if (row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }
  return jsonResponse({ ok: true, job: await sanitizeMetadataJobRow(row, env) });
}

export async function handleMetadataContent({ request, url, env, path, getUser, jsonResponse, servicePostgrest }) {
  const id = decodeURIComponent(path.slice('metadata/content/'.length));
  if (!UUID_RE.test(id)) return jsonResponse({ error: 'Missing or invalid metadata job id' }, 400);

  const exp = url.searchParams.get('exp');
  const sig = url.searchParams.get('sig');
  const sigOk = await verifyMetadataContentSig(id, exp, sig, env);
  let user = null;
  if (!sigOk) {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    user = bearer ? await getUser(env, bearer) : null;
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const rowRes = await servicePostgrest(env, `/metadata_jobs?select=id,user_id,filename,mime_type,cleaned_path,status&id=eq.${encodeURIComponent(id)}&limit=1`);
  const rows = rowRes?.ok ? await rowRes.json().catch(() => []) : [];
  const row = rows?.[0];
  if (!row || !row.cleaned_path) return jsonResponse({ error: 'Cleaned media not found' }, 404);
  if (!sigOk && row.user_id !== user.id && user?.app_metadata?.role !== 'admin') {
    return jsonResponse({ error: 'Forbidden' }, 403);
  }

  const storageRes = await storageRequest(env, 'GET', row.cleaned_path);
  if (!storageRes.ok) {
    return jsonResponse({ error: 'Gagal mengambil file bersih dari penyimpanan.' }, 502);
  }

  const wantDownload = url.searchParams.get('download') === '1';
  const ext = row.mime_type === 'video/webm' ? 'webm'
    : row.mime_type === 'video/quicktime' ? 'mov'
      : row.mime_type?.startsWith('video/') ? 'mp4'
        : row.mime_type === 'image/jpeg' ? 'jpg'
          : row.mime_type === 'image/webp' ? 'webp'
            : row.mime_type === 'image/gif' ? 'gif'
              : 'png';
  const attachmentName = sanitizeCleanFilename(row.filename, ext, row.id);
  const headers = new Headers();
  headers.set('content-type', row.mime_type || storageRes.headers.get('content-type') || 'application/octet-stream');
  const len = storageRes.headers.get('content-length');
  if (len) headers.set('content-length', len);
  headers.set('content-disposition', `${wantDownload ? 'attachment' : 'inline'}; filename="${attachmentName}"`);
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');

  return new Response(request.method === 'HEAD' ? null : storageRes.body, {
    status: 200,
    headers,
  });
}
