import { isStorageSizeError, storageUploadErrorMessage } from './storageUploadError.js';

const BUCKET = 'ai-studio-uploads';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const AUDIO_EXTENSIONS = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/webm': 'webm',
};
const VIDEO_EXTENSIONS = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
};

// This bucket is public. The random name is not an access control mechanism.
export async function uploadFreebeatImage(storage, userId, file) {
  const extension = IMAGE_EXTENSIONS[file?.type];
  if (!extension || !Number.isFinite(file?.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error('Pilih gambar JPG, PNG, atau WebP berukuran maksimal 10 MB.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId || '')) throw new Error('Sesi login tidak tersedia. Silakan login kembali.');
  const path = `${userId}/freebeat-video/${crypto.randomUUID()}.${extension}`;
  const bucket = storage.from(BUCKET);
  let error;
  try { ({ error } = await bucket.upload(path, file, { contentType: file.type, upsert: false })); }
  catch (error) {
    if (isStorageSizeError(error)) throw new Error(storageUploadErrorMessage(error, { kind: 'image', size: file.size }));
    throw new Error('Hasil upload tidak pasti; gambar mungkin sudah tersimpan. Periksa Supabase Storage sebelum mengunggah ulang.');
  }
  if (isStorageSizeError(error)) throw new Error(storageUploadErrorMessage(error, { kind: 'image', size: file.size }));
  if (error) throw new Error('Upload gagal atau hasilnya tidak pasti. Periksa Supabase Storage sebelum mengunggah ulang.');
  // Use our original path, not a provider-supplied path. Keep it for deletion
  // even if constructing the public URL fails after a successful upload.
  let url = '';
  try {
    const value = bucket.getPublicUrl(path)?.data?.publicUrl;
    if (typeof value === 'string' && new URL(value).protocol === 'https:') url = value;
  } catch { /* the UI still offers deletion of the uploaded object */ }
  return { path, url };
}

export async function uploadFreebeatAudio(storage, userId, file) {
  const mime = String(file?.type || '').toLowerCase();
  const allowExtFallback = !mime || mime === 'application/octet-stream';
  const extFromName = allowExtFallback && typeof file?.name === 'string' ? file.name.split('.').pop()?.toLowerCase() : '';
  const fallbackExt = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'webm'].includes(extFromName) ? extFromName : '';
  const extension = AUDIO_EXTENSIONS[mime] || fallbackExt;
  if (!extension || !Number.isFinite(file?.size) || file.size <= 0 || file.size > MAX_AUDIO_BYTES) throw new Error('Pilih file audio (MP3, WAV, M4A, AAC, OGG, FLAC, atau WebM) maksimal 25 MB.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId || '')) throw new Error('Sesi login tidak tersedia. Silakan login kembali.');
  const path = `${userId}/freebeat-audio/${crypto.randomUUID()}.${extension}`;
  const bucket = storage.from(BUCKET);
  let error;
  try { ({ error } = await bucket.upload(path, file, { contentType: mime || `audio/${extension}`, upsert: false })); }
  catch (error) {
    if (isStorageSizeError(error)) throw new Error(storageUploadErrorMessage(error, { kind: 'audio', size: file.size }));
    throw new Error('Hasil upload audio tidak pasti; file mungkin sudah tersimpan. Periksa Supabase Storage sebelum mengunggah ulang.');
  }
  if (isStorageSizeError(error)) throw new Error(storageUploadErrorMessage(error, { kind: 'audio', size: file.size }));
  if (error) throw new Error('Upload audio gagal atau hasilnya tidak pasti. Periksa Supabase Storage sebelum mengunggah ulang.');
  let url = '';
  try {
    const value = bucket.getPublicUrl(path)?.data?.publicUrl;
    if (typeof value === 'string' && new URL(value).protocol === 'https:') url = value;
  } catch { /* UI still allows removal */ }
  return { path, url };
}

export async function uploadFreebeatVideo(storage, userId, file) {
  const mime = String(file?.type || '').toLowerCase();
  const allowExtFallback = !mime || mime === 'application/octet-stream';
  const extFromName = allowExtFallback && typeof file?.name === 'string' ? file.name.split('.').pop()?.toLowerCase() : '';
  const fallbackExt = ['mp4', 'mov', 'webm', 'm4v'].includes(extFromName) ? extFromName : '';
  const extension = VIDEO_EXTENSIONS[mime] || fallbackExt;
  if (!extension || !Number.isFinite(file?.size) || file.size <= 0 || file.size > MAX_VIDEO_BYTES) {
    throw new Error('Pilih file video (MP4, MOV, WebM, atau M4V) maksimal 100 MB.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId || '')) {
    throw new Error('Sesi login tidak tersedia. Silakan login kembali.');
  }
  const path = `${userId}/freebeat-source-video/${crypto.randomUUID()}.${extension}`;
  const bucket = storage.from(BUCKET);
  let error;
  try { ({ error } = await bucket.upload(path, file, { contentType: mime || `video/${extension === 'mov' ? 'quicktime' : extension}`, upsert: false })); }
  catch (error) {
    if (isStorageSizeError(error)) throw new Error(storageUploadErrorMessage(error, { kind: 'video', size: file.size }));
    throw new Error('Hasil upload video tidak pasti; file mungkin sudah tersimpan. Periksa Supabase Storage sebelum mengunggah ulang.');
  }
  if (isStorageSizeError(error)) throw new Error(storageUploadErrorMessage(error, { kind: 'video', size: file.size }));
  if (error) throw new Error('Upload video gagal atau hasilnya tidak pasti. Periksa Supabase Storage sebelum mengunggah ulang.');
  let url = '';
  try {
    const value = bucket.getPublicUrl(path)?.data?.publicUrl;
    if (typeof value === 'string' && new URL(value).protocol === 'https:') url = value;
  } catch { /* UI still allows removal */ }
  return { path, url };
}

export async function probeMediaDurationMs(fileOrUrl, kind = 'video') {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return null;
  const tag = kind === 'audio' ? 'audio' : 'video';
  let objectUrl = null;
  let src = '';
  if (typeof fileOrUrl === 'string') {
    src = fileOrUrl.trim();
  } else if (fileOrUrl && typeof URL.createObjectURL === 'function') {
    try {
      objectUrl = URL.createObjectURL(fileOrUrl);
      src = objectUrl;
    } catch { return null; }
  }
  if (!src) return null;
  return new Promise((resolve) => {
    let settled = false;
    let el = null;
    const cleanup = (ms) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (el) {
        try {
          el.onloadedmetadata = null;
          el.onerror = null;
          el.removeAttribute('src');
          el.load?.();
        } catch { /* ignore */ }
      }
      if (objectUrl && typeof URL.revokeObjectURL === 'function') {
        try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
      }
      resolve(ms);
    };
    const timer = setTimeout(() => cleanup(null), 4000);
    try {
      el = document.createElement(tag);
      el.preload = 'metadata';
      el.onloadedmetadata = () => {
        const dur = Number(el.duration);
        cleanup(Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null);
      };
      el.onerror = () => cleanup(null);
      el.src = src;
    } catch {
      cleanup(null);
    }
  });
}

export async function deleteFreebeatImage(storage, path) {
  let result;
  try { result = await storage.from(BUCKET).remove([path]); }
  catch { throw new Error('Penghapusan gambar belum dapat dikonfirmasi. Periksa dashboard Supabase Storage.'); }
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1 || result.data[0]?.name !== path) throw new Error('Penghapusan gambar belum dapat dikonfirmasi. Periksa dashboard Supabase Storage.');
}

export const deleteFreebeatMedia = deleteFreebeatImage;
