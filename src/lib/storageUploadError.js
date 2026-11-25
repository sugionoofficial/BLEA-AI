// Storage's effective per-object limit is the lower of the global project
// setting and the bucket setting. A 100 MiB bucket does not override the former.
// Never reflect raw storage responses (which can contain paths/URLs) in the UI.
export function isStorageSizeError(error) {
  return String(error?.statusCode ?? error?.status ?? '') === '413'
    || ['EntityTooLarge', 'PayloadTooLarge'].includes(error?.code)
    || /object exceeded the maximum allowed size|maximum allowed size|payload too large|entity too large/i.test(String(error?.message || ''));
}

export function storageUploadErrorMessage(error, { kind = 'file', size, fallback = 'Upload gagal. Periksa koneksi dan izin penyimpanan.' } = {}) {
  if (!isStorageSizeError(error)) return fallback;
  const label = { video: 'video', audio: 'audio', image: 'gambar', image_last: 'gambar' }[kind] || 'file';
  const sizeText = Number.isFinite(size) && size > 0 ? ` (${(size / 1024 / 1024).toFixed(1)} MB)` : '';
  return `Ukuran ${label}${sizeText} ditolak oleh batas penyimpanan Supabase. Batas global proyek dapat lebih kecil daripada batas upload aplikasi. Kompres atau potong file menjadi lebih kecil, atau gunakan URL HTTPS publik. Admin perlu memeriksa batas global Storage dan batas bucket.`;
}
