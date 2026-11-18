const BUCKET = 'ai-studio-uploads';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// This bucket is public. The random name is not an access control mechanism.
export async function uploadFreebeatImage(storage, userId, file) {
  const extension = IMAGE_EXTENSIONS[file?.type];
  if (!extension || !Number.isFinite(file?.size) || file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new Error('Pilih gambar JPG, PNG, atau WebP berukuran maksimal 10 MB.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId || '')) throw new Error('Sesi login tidak tersedia. Silakan login kembali.');
  const path = `${userId}/freebeat-video/${crypto.randomUUID()}.${extension}`;
  const bucket = storage.from(BUCKET);
  let error;
  try { ({ error } = await bucket.upload(path, file, { contentType: file.type, upsert: false })); }
  catch { throw new Error('Hasil upload tidak pasti; gambar mungkin sudah tersimpan. Periksa Supabase Storage sebelum mengunggah ulang.'); }
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

export async function deleteFreebeatImage(storage, path) {
  let result;
  try { result = await storage.from(BUCKET).remove([path]); }
  catch { throw new Error('Penghapusan gambar belum dapat dikonfirmasi. Periksa dashboard Supabase Storage.'); }
  if (result.error || !Array.isArray(result.data) || result.data.length !== 1 || result.data[0]?.name !== path) throw new Error('Penghapusan gambar belum dapat dikonfirmasi. Periksa dashboard Supabase Storage.');
}
