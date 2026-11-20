import { edgeRequest } from './client';

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

export function withDownloadParam(url) {
  if (typeof url !== 'string' || !url) return '';
  if (/^\/api\/(?:video|image)\/content\//.test(url)) {
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

export function buildDownloadFilename({ kind = 'image', id = '', index = 0, total = 1, url = '' } = {}) {
  const shortId = String(id || 'hasil').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'hasil';
  if (kind === 'video') return `blea-video-${shortId}.mp4`;
  const suffix = total > 1 ? `-${index + 1}` : '';
  return `blea-image-${shortId}${suffix}.${inferImageExtension(url)}`;
}
