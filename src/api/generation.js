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

// Generate Gambar — kirim satu generasi; kredit BLEA dipotong di server.
// Sertakan image_url (HTTPS publik) untuk memakai mode edit foto (edit_image).
export async function generateImage(prompt, imageUrl = '', aspectRatio = '', resolution = '') {
  const body = { prompt };
  if (imageUrl) {
    body.image_url = imageUrl;
    if (aspectRatio) body.aspect_ratio = aspectRatio;
    if (resolution) body.resolution = resolution;
  }
  return edgeRequest('/image/generate', body);
}

// Generate Gambar — periksa status tugas & hasil.
export async function fetchImageStatus(id) {
  return edgeRequest('/image/status', { id });
}

// Generate Gambar — riwayat milik pengguna.
export async function fetchImageHistory() {
  return edgeRequest('/image/history', {});
}
