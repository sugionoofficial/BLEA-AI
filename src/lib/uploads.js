// Unggahan lampiran untuk /agent dan /studio.
//
// Modul ini sengaja TIDAK mengimpor klien Supabase: helper murni (batas ukuran,
// deteksi jenis, format) harus bisa diuji tanpa jaringan, dan pemanggil yang
// menyuntikkan klien. `uploadAttachments` menerima `client` sebagai argumen.
//
// Batas 100MB ditegakkan di sini (satu sumber kebenaran), bukan disalin ke tiap
// komponen: sebelumnya angka 30MB muncul di dua tempat dan mudah melenceng.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_LABEL = '100MB';
export const UPLOAD_BUCKET = 'ai-studio-uploads';

export const UPLOAD_ACCEPT = 'image/*,video/*,audio/*,.pdf,.zip,.txt,.md,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.json';

// Bucket `ai-studio-uploads` bersifat public-read (migrasi
// 20261111000006) karena URL-nya harus bisa diambil model/provider. Batas
// efektif Storage adalah nilai terendah antara batas global proyek dan batas
// bucket (100 MiB, migrasi 20261207000000). Validasi klien bukan penggantinya.

export function formatBytes(size) {
  const bytes = Number(size) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fileKind(type = '', name = '') {
  const mime = String(type).toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime) return 'file';
  const ext = String(name).toLowerCase().split('.').pop();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'ogg', 'aac', 'flac'].includes(ext)) return 'audio';
  return 'file';
}

export function safeStorageName(name = 'file') {
  return String(name).replace(/[^a-z0-9._-]/gi, '_').slice(0, 80) || 'file';
}

/**
 * Pisahkan berkas yang boleh diunggah dari yang ditolak, tanpa memotong diam-diam.
 * @returns {{accepted: File[], rejected: Array<{name:string,size:number}>}}
 */
export function partitionBySize(files, limit = MAX_UPLOAD_BYTES) {
  const accepted = [];
  const rejected = [];
  for (const file of files || []) {
    if (!file) continue;
    if (Number(file.size) > limit) rejected.push({ name: file.name, size: Number(file.size) || 0 });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

export function oversizeMessage(rejected, limit = MAX_UPLOAD_BYTES) {
  if (!rejected?.length) return '';
  const names = rejected.map((file) => `${file.name} (${formatBytes(file.size)})`).join(', ');
  return `${names} melebihi batas ${formatBytes(limit)} per berkas.`;
}

export async function uploadAttachments({ client, files, userId, folder = '' }) {
  if (!client) throw new Error('uploadAttachments membutuhkan klien Supabase');
  const uploaded = [];
  const failures = [];
  for (const file of files) {
    const path = [
      userId,
      folder,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeStorageName(file.name)}`,
    ].filter(Boolean).join('/');
    const { data, error } = await client.storage
      .from(UPLOAD_BUCKET)
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (error) {
      failures.push({ name: file.name, error: error.message });
      continue;
    }
    const { data: pub } = client.storage.from(UPLOAD_BUCKET).getPublicUrl(data.path);
    uploaded.push({
      id: data.path,
      name: file.name,
      size: file.size,
      type: file.type || '',
      kind: fileKind(file.type, file.name),
      url: pub.publicUrl,
    });
  }
  return { uploaded, failures };
}

/**
 * Ubah lampiran menjadi part konten untuk model chat (format OpenAI multimodal).
 * Gambar dikirim sebagai image_url; berkas lain sebagai tautan teks supaya model
 * tetap tahu berkas itu ada tanpa berpura-pura bisa membacanya.
 */
export function buildAttachmentContent(text, attachments = []) {
  const parts = [{ type: 'text', text }];
  for (const attachment of attachments) {
    if (!attachment?.url) continue;
    if (attachment.kind === 'image' || String(attachment.type).startsWith('image/')) {
      parts.push({ type: 'image_url', image_url: { url: attachment.url } });
    } else {
      const size = attachment.size ? `, ${formatBytes(attachment.size)}` : '';
      parts.push({ type: 'text', text: `[Lampiran ${attachment.kind || 'file'}: ${attachment.name}${size}](${attachment.url})` });
    }
  }
  return parts;
}

/** Ringkasan lampiran untuk pesan yang disimpan sebagai teks biasa. */
export function appendAttachmentSummary(text, attachments = []) {
  if (!attachments.length) return text;
  const lines = attachments.map((attachment) => `- ${attachment.name} (${attachment.kind}, ${formatBytes(attachment.size)}): ${attachment.url}`);
  return `${text}\n\nLampiran:\n${lines.join('\n')}`;
}
