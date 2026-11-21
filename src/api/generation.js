import { edgeFormRequest, edgeRequest } from './client';

// Generate Video — daftar model video & status provider.
export async function fetchVideoModels() {
  return edgeRequest('/video/models', {});
}

// Generate Video — kirim tugas generasi video asinkron.
export async function generateVideo(payload) {
  return edgeRequest('/video/generate', payload);
}

// Generate Video — periksa status job video.
export async function fetchVideoStatus(id) {
  return edgeRequest('/video/status', { id });
}

// Generate Video — ambil riwayat generasi milik pengguna dengan URL putar bertanda tangan.
export async function fetchVideoHistory({ offset = 0 } = {}) {
  return edgeRequest('/video/history', { offset });
}

// Generate Gambar (Freebeat) — konfigurasi model & harga kredit BLEA.
export async function fetchImageConfig() {
  return edgeRequest('/image/config', {});
}

// Generate Gambar — kirim satu generasi teks-ke-gambar; kredit BLEA dipotong
// di server.
export async function generateImage(prompt, options = {}) {
  const payload = { prompt };
  if (options && typeof options === 'object') {
    if (options.provider) payload.provider = String(options.provider);
    if (options.model) payload.model = String(options.model);
    if (options.size) payload.size = String(options.size);
    if (options.n != null) payload.n = Number(options.n);
    if (Array.isArray(options.images) && options.images.length > 0) payload.images = options.images;
  }
  return edgeRequest('/image/generate', payload);
}

// Generate Gambar — periksa status tugas & hasil.
export async function fetchImageStatus(id) {
  return edgeRequest('/image/status', { id });
}

// Generate Gambar — riwayat milik pengguna.
export async function fetchImageHistory() {
  return edgeRequest('/image/history', {});
}

// Proses Live — daftar generasi aktif di platform (user biasa: milik lain disamarkan, admin: lengkap).
export async function fetchLiveGenerations({ poll = false } = {}) {
  return edgeRequest('/generations/live', { poll: Boolean(poll) });
}

// Admin-only — batalkan proses generasi yang macet/berjalan & kembalikan kredit yang belum dikembalikan.
export async function cancelAdminGeneration({ id, kind, reason = '' }) {
  return edgeRequest('/admin/generations/cancel', { id, kind, reason });
}

// Cek & Bersihkan Metadata AI — mulai job pembersihan (potong 100 kredit & tampilkan di Live Proses).
export async function startMetadataClean(payload) {
  return edgeRequest('/metadata/start', payload);
}

// Cek & Bersihkan Metadata AI — proses penghapusan metadata & simpan hasil bersih (via FormData, JSON storage_path, atau hasil bersih client-side untuk file besar).
export async function processMetadataClean({
  id,
  file,
  storagePath,
  filename,
  mimeType,
  clientCleaned = false,
  clientFailed = false,
  errorMessage = '',
  cleanedSize = 0,
  removedCount = 0,
  scanBefore = null,
  scanAfter = null,
  cleanedStoragePath = '',
} = {}) {
  if (file && typeof file.arrayBuffer === 'function') {
    const form = new FormData();
    if (id) form.append('id', id);
    if (filename) form.append('filename', filename);
    if (mimeType) form.append('mime_type', mimeType);
    const uploadBlob = (typeof Blob !== 'undefined' && file instanceof Blob)
      ? file
      : new Blob([await file.arrayBuffer()], { type: mimeType || file.type || 'application/octet-stream' });
    form.append('file', uploadBlob, filename || 'media');
    return edgeFormRequest('/metadata/process', form);
  }
  if (clientFailed) {
    return edgeRequest('/metadata/process', {
      id,
      client_failed: true,
      error_message: errorMessage,
    });
  }
  if (clientCleaned) {
    return edgeRequest('/metadata/process', {
      id,
      client_cleaned: true,
      cleaned_size: cleanedSize,
      removed_count: removedCount,
      ...(scanBefore ? { scan_before: scanBefore } : {}),
      ...(scanAfter ? { scan_after: scanAfter } : {}),
      ...(cleanedStoragePath ? { cleaned_storage_path: cleanedStoragePath } : {}),
    });
  }
  return edgeRequest('/metadata/process', {
    ...(id ? { id } : {}),
    ...(storagePath ? { storage_path: storagePath } : {}),
    ...(filename ? { filename } : {}),
    ...(mimeType ? { mime_type: mimeType } : {}),
  });
}

// Cek & Bersihkan Metadata AI — scan multimodal (gambar/video + tag metadata) via Cloudflare Workers AI.
export async function scanMetadataWithCloudflareAI({
  filename,
  mimeType = '',
  mediaKind = 'image',
  fileSize = 0,
  binaryScan = {},
  frames = [],
}) {
  return edgeRequest('/metadata/scan', {
    filename,
    mime_type: mimeType,
    media_kind: mediaKind,
    file_size: fileSize,
    binary_scan: binaryScan,
    frames,
  });
}

// Cek & Bersihkan Metadata AI — riwayat job milik pengguna.
export async function fetchMetadataHistory({ offset = 0 } = {}) {
  return edgeRequest('/metadata/history', { offset });
}

// Cek & Bersihkan Metadata AI — detail/status satu job.
export async function fetchMetadataStatus(id) {
  return edgeRequest('/metadata/status', { id });
}

export function withDownloadParam(url) {
  if (typeof url !== 'string' || !url) return '';
  if (/^\/api\/(?:video|image|metadata)\/content\//.test(url)) {
    return /[?&]download=1(?:&|$)/.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}download=1`;
  }
  return url;
}

export function inferImageExtension(url) {
  if (typeof url !== 'string' || !url) return 'png';
  try {
    const pathname = new URL(url, 'https://blea.local').pathname.toLowerCase();
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'jpg';
    if (pathname.endsWith('.webp')) return 'webp';
    if (pathname.endsWith('.gif')) return 'gif';
    if (pathname.endsWith('.png')) return 'png';
  } catch { /* fallback to png */ }
  return 'png';
}

export function buildDownloadFilename({ kind = 'image', id = '', index = 0, total = 1, url = '', filename = '', mimeType = '' } = {}) {
  const shortId = String(id || 'hasil').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'hasil';
  if (kind === 'metadata') {
    const cleanBase = String(filename || '')
      .replace(/^.*[\\/]/, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (cleanBase) return cleanBase.startsWith('clean-') ? cleanBase : `clean-${cleanBase}`;
    const ext = mimeType === 'video/webm' ? 'webm'
      : mimeType === 'video/quicktime' ? 'mov'
        : mimeType?.startsWith('video/') ? 'mp4'
          : inferImageExtension(url);
    return `clean-blea-${shortId}.${ext}`;
  }
  if (kind === 'video') return `blea-video-${shortId}.mp4`;
  const suffix = total > 1 ? `-${index + 1}` : '';
  return `blea-image-${shortId}${suffix}.${inferImageExtension(url)}`;
}
