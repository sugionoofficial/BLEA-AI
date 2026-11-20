import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Image as ImageIcon, Film, Link2, Loader2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { supabase, supabaseKey, supabaseUrl } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import './showcase.css';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_PROMPT_CHARS = 10000;
const TUS_THRESHOLD_BYTES = 6 * 1024 * 1024;
const TUS_CHUNK_BYTES = 5 * 1024 * 1024;

const IMAGE_MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};
const VIDEO_MIME_EXT = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-m4v': 'm4v',
  'video/m4v': 'm4v',
  'video/3gpp': '3gp',
  'video/mpeg': 'mpeg',
  'video/x-matroska': 'mkv',
};
const EXT_TO_MIME = {
  jpg: { isVideo: false, mime: 'image/jpeg' },
  jpeg: { isVideo: false, mime: 'image/jpeg' },
  png: { isVideo: false, mime: 'image/png' },
  webp: { isVideo: false, mime: 'image/webp' },
  avif: { isVideo: false, mime: 'image/avif' },
  mp4: { isVideo: true, mime: 'video/mp4' },
  mov: { isVideo: true, mime: 'video/quicktime' },
  m4v: { isVideo: true, mime: 'video/mp4' },
  webm: { isVideo: true, mime: 'video/webm' },
  '3gp': { isVideo: true, mime: 'video/3gpp' },
  mpeg: { isVideo: true, mime: 'video/mpeg' },
  mkv: { isVideo: true, mime: 'video/x-matroska' },
};
const ACCEPT_MEDIA = 'image/jpeg,image/png,image/webp,image/avif,video/mp4,video/quicktime,video/webm,video/*,.mp4,.mov,.m4v,.webm,.3gp,.mkv,.jpg,.jpeg,.png,.webp';
const ACCEPT_THUMB = 'image/jpeg,image/png,image/webp,image/avif,.jpg,.jpeg,.png,.webp,.avif';

function detectMediaMeta(file) {
  if (!file) return null;
  const type = String(file.type || '').toLowerCase().split(';')[0].trim();
  if (IMAGE_MIME_EXT[type]) return { ext: IMAGE_MIME_EXT[type], mime: type, isVideo: false };
  if (VIDEO_MIME_EXT[type]) return { ext: VIDEO_MIME_EXT[type], mime: type, isVideo: true };
  const nameMatch = String(file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  const ext = nameMatch?.[1];
  if (ext && EXT_TO_MIME[ext]) return { ext, mime: EXT_TO_MIME[ext].mime, isVideo: EXT_TO_MIME[ext].isVideo };
  if (type.startsWith('video/')) return { ext: 'mp4', mime: type, isVideo: true };
  if (type.startsWith('image/')) return { ext: 'png', mime: type, isVideo: false };
  return null;
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(String(text || ''));
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

async function uploadTusResumable(path, file, contentType, onProgress) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Sesi login tidak ditemukan. Masuk ulang lalu coba lagi.');

  const endpoint = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/upload/resumable`;
  const metadata = [
    `bucketName ${encodeBase64('ai-studio-uploads')}`,
    `objectName ${encodeBase64(path)}`,
    `contentType ${encodeBase64(contentType)}`,
    `cacheControl ${encodeBase64('3600')}`,
  ].join(',');

  const createRes = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: supabaseKey,
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(file.size),
      'Upload-Metadata': metadata,
      'x-upsert': 'false',
    },
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => '');
    if (createRes.status === 413 || /maximum allowed size|payload too large/i.test(errBody)) {
      throw new Error('Ukuran video melebihi batas paket penyimpanan Supabase. Kompres video agar lebih kecil atau gunakan URL HTTPS.');
    }
    throw new Error(errBody || `Upload gagal (${createRes.status}).`);
  }
  const locationHeader = createRes.headers.get('location') || '';
  const uploadUrl = locationHeader.startsWith('http')
    ? locationHeader
    : new URL(locationHeader, endpoint).toString();

  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(offset + TUS_CHUNK_BYTES, file.size);
    const chunk = file.slice(offset, end);
    const patchRes = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseKey,
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      body: chunk,
    });
    if (!patchRes.ok) {
      const errBody = await patchRes.text().catch(() => '');
      throw new Error(errBody || `Upload terhenti pada ${Math.round((offset / file.size) * 100)}%.`);
    }
    const nextOffset = Number(patchRes.headers.get('upload-offset'));
    offset = Number.isFinite(nextOffset) && nextOffset > offset ? nextOffset : end;
    onProgress?.(Math.min(100, Math.round((offset / file.size) * 100)));
  }
}

function emptyForm() {
  return { kind: 'image', title: '', prompt: '', media_url: '', poster_url: '', sort_order: 0, published: true };
}

function cleanUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// Dashboard untuk pengguna biasa: galeri contoh hasil (gambar/video + prompt)
// yang dikelola admin. Pengguna hanya dapat melihat dan menyalin prompt; tidak
// ada tombol unduh dan tidak ada mode edit.
export function UserDashboard() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState(emptyForm());
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadingThumb, setUploadingThumb] = useState(false);
  const addFileRef = useRef(null);
  const editFileRefs = useRef({});

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: fetchError } = await supabase
      .from('showcase_examples')
      .select('id,kind,title,prompt,media_url,poster_url,sort_order,published,created_at')
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (fetchError) setError('Contoh belum dapat dimuat. Coba beberapa saat lagi.');
    else setItems(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function copyPrompt(item) {
    const text = String(item.prompt || '').trim();
    if (!text) { setNotice('Prompt kosong.'); return; }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(item.id);
      setNotice('Prompt disalin ke papan klip.');
      window.setTimeout(() => setCopiedId((cur) => (cur === item.id ? '' : cur)), 1600);
    } catch {
      setNotice('Tidak dapat menyalin otomatis; pilih dan salin teks prompt secara manual.');
    }
  }

  async function uploadToStorage(file, { allowVideo = true, prefix = 'showcase', onProgress } = {}) {
    const meta = detectMediaMeta(file);
    if (!meta || (!allowVideo && meta.isVideo)) {
      throw new Error(allowVideo
        ? 'Format tidak didukung. Pilih JPG, PNG, WebP, MP4, MOV, M4V, atau WebM.'
        : 'Thumbnail harus berupa gambar JPG, PNG, atau WebP.');
    }
    const maxBytes = meta.isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > maxBytes) {
      throw new Error(meta.isVideo
        ? 'Ukuran video maksimal 100 MB.'
        : 'Ukuran gambar maksimal 25 MB.');
    }
    const ownerPrefix = user?.id ? `${user.id}/` : '';
    const path = `${ownerPrefix}showcase/${prefix}-${crypto.randomUUID()}.${meta.ext}`;
    if (file.size > TUS_THRESHOLD_BYTES) {
      await uploadTusResumable(path, file, meta.mime, onProgress);
    } else {
      const { error: uploadError } = await supabase.storage
        .from('ai-studio-uploads')
        .upload(path, file, { contentType: meta.mime, upsert: false });
      if (uploadError) throw new Error(uploadError.message || 'Upload gagal.');
      onProgress?.(100);
    }
    const { data } = supabase.storage.from('ai-studio-uploads').getPublicUrl(path);
    const url = cleanUrl(data?.publicUrl);
    if (!url) throw new Error('URL publik tidak tersedia.');
    return { url, isVideo: meta.isVideo };
  }

  async function uploadMedia(file) {
    if (!file || uploading || uploadingThumb) return null;
    setError('');
    setUploading(true);
    setUploadProgress(0);
    try {
      return await uploadToStorage(file, {
        allowVideo: true,
        prefix: 'media',
        onProgress: (pct) => setUploadProgress(pct),
      });
    } catch (err) {
      setError(err.message || 'Upload media gagal.');
      return null;
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function uploadThumbnail(file) {
    if (!file || uploading || uploadingThumb) return null;
    setError('');
    setUploadingThumb(true);
    try {
      const result = await uploadToStorage(file, { allowVideo: false, prefix: 'thumb' });
      return result?.url || null;
    } catch (err) {
      setError(err.message || 'Upload thumbnail gagal.');
      return null;
    } finally {
      setUploadingThumb(false);
    }
  }

  function validateForm(values) {
    const media = cleanUrl(values.media_url);
    if (media === null || !media) return 'URL media wajib berupa tautan HTTPS yang valid.';
    const poster = cleanUrl(values.poster_url);
    if (values.poster_url.trim() && poster === null) return 'URL thumbnail/poster harus berupa tautan HTTPS yang valid.';
    if (!String(values.prompt).trim()) return 'Prompt wajib diisi.';
    if (String(values.prompt).trim().length > MAX_PROMPT_CHARS) return `Prompt maksimal ${MAX_PROMPT_CHARS.toLocaleString('id-ID')} karakter.`;
    const sort = Number(values.sort_order);
    if (!Number.isFinite(sort) || sort < -100000 || sort > 100000) return 'Urutan harus berupa angka.';
    return null;
  }

  async function addExample() {
    if (saving) return;
    const invalid = validateForm(form);
    if (invalid) { setError(invalid); return; }
    setSaving(true); setError(''); setNotice('');
    const { error: insertError } = await supabase.from('showcase_examples').insert({
      kind: form.kind,
      title: form.title.trim().slice(0, 120),
      prompt: form.prompt.trim().slice(0, MAX_PROMPT_CHARS),
      media_url: cleanUrl(form.media_url),
      poster_url: cleanUrl(form.poster_url) || '',
      sort_order: Math.trunc(Number(form.sort_order) || 0),
      published: form.published === true,
    });
    setSaving(false);
    if (insertError) { setError('Gagal menambah contoh. Periksa hak admin Anda.'); return; }
    setForm(emptyForm());
    setAddOpen(false);
    setNotice('Contoh ditambahkan.');
    await load();
  }

  async function updateExample(id, values) {
    if (busyId) return;
    const invalid = validateForm(values);
    if (invalid) { setError(invalid); return; }
    setBusyId(id); setError(''); setNotice('');
    const { error: updateError } = await supabase.from('showcase_examples').update({
      kind: values.kind,
      title: values.title.trim().slice(0, 120),
      prompt: values.prompt.trim().slice(0, MAX_PROMPT_CHARS),
      media_url: cleanUrl(values.media_url),
      poster_url: cleanUrl(values.poster_url) || '',
      sort_order: Math.trunc(Number(values.sort_order) || 0),
      published: values.published === true,
    }).eq('id', id);
    setBusyId('');
    if (updateError) { setError('Gagal menyimpan perubahan.'); return; }
    setEditingId('');
    setNotice('Perubahan disimpan.');
    await load();
  }

  async function removeExample(item) {
    if (busyId) return;
    if (!window.confirm(`Hapus contoh "${item.title || item.id}"? Tindakan ini tidak bisa dibatalkan.`)) return;
    setBusyId(item.id); setError('');
    const { error: deleteError } = await supabase.from('showcase_examples').delete().eq('id', item.id);
    setBusyId('');
    if (deleteError) { setError('Gagal menghapus contoh.'); return; }
    setNotice('Contoh dihapus.');
    await load();
  }

  const visible = isAdmin ? items : items.filter((item) => item.published);
  const uploadButtonText = uploading
    ? (uploadProgress > 0 ? `Mengunggah ${uploadProgress}%…` : 'Mengunggah…')
    : 'Unggah gambar / video';
  const thumbButtonText = uploadingThumb ? 'Mengunggah thumbnail…' : 'Unggah thumbnail';

  return (
    <div className="showcase">
      <div className="showcase-hero">
        <div>
          <span className="showcase-kicker">GALERI CONTOH</span>
          <h1>Inspirasi karya BLEA AI</h1>
          <p>Salin prompt dari contoh di bawah lalu pakai langsung di halaman Generate.</p>
        </div>
        {isAdmin && (
          <div className="showcase-hero-actions">
            <button
              type="button"
              className={`showcase-admin-toggle ${addOpen ? 'is-active' : ''}`}
              onClick={() => {
                setAddOpen((v) => {
                  const next = !v;
                  if (next) setEditingId('');
                  return next;
                });
              }}
              aria-expanded={addOpen}
            >
              {addOpen ? <X size={14} /> : <Plus size={14} />}
              {addOpen ? 'Tutup form baru' : 'Tambah contoh baru'}
            </button>
          </div>
        )}
      </div>

      {notice && <div className="showcase-alert" role="status">{notice}</div>}
      {error && <div className="showcase-alert is-error" role="alert">{error}</div>}

      {isAdmin && addOpen && (
        <div className="showcase-admin-panel">
          <div className="showcase-admin-panel-head">
            <strong>Tambah contoh baru</strong>
            <button type="button" className="showcase-cancel-btn" onClick={() => setAddOpen(false)}>
              <X size={14} /> Tutup
            </button>
          </div>
          <ExampleForm
            values={form}
            onChange={setForm}
            onSubmit={addExample}
            onCancel={() => setAddOpen(false)}
            submitLabel="Tambah contoh"
            busy={saving || uploading || uploadingThumb}
            uploadLabel={uploadButtonText}
            thumbLabel={thumbButtonText}
            onUpload={async (file) => {
              const result = await uploadMedia(file);
              if (result) setForm((cur) => ({ ...cur, kind: result.isVideo ? 'video' : 'image', media_url: result.url }));
            }}
            onUploadThumb={async (file) => {
              const url = await uploadThumbnail(file);
              if (url) setForm((cur) => ({ ...cur, kind: 'video', poster_url: url }));
            }}
            fileRef={addFileRef}
          />
        </div>
      )}

      {loading && <p className="showcase-status" role="status"><Loader2 size={16} className="showcase-spin" /> Memuat contoh…</p>}
      {!loading && visible.length === 0 && (
        <div className="showcase-empty">
          <ImageIcon size={26} />
          <h2>Contoh belum tersedia</h2>
          <p>{isAdmin ? 'Klik "Tambah contoh baru" di atas untuk menambahkan contoh gambar atau video pertama.' : 'Galeri contoh sedang disiapkan. Silakan kembali lagi nanti.'}</p>
        </div>
      )}

      <div className="showcase-grid">
        {visible.map((item) => (
          <ShowcaseCard
            key={item.id}
            item={item}
            isAdmin={isAdmin}
            isEditing={isAdmin && editingId === item.id}
            onStartEdit={() => {
              setAddOpen(false);
              setEditingId((cur) => (cur === item.id ? '' : item.id));
            }}
            onCancelEdit={() => setEditingId('')}
            busy={busyId === item.id}
            copied={copiedId === item.id}
            onCopy={() => copyPrompt(item)}
            onSave={(values) => updateExample(item.id, values)}
            onDelete={() => removeExample(item)}
            onUpload={async (file) => uploadMedia(file)}
            onUploadThumb={async (file) => uploadThumbnail(file)}
            uploadLabel={uploadButtonText}
            thumbLabel={thumbButtonText}
            editFileRef={(node) => { editFileRefs.current[item.id] = node; }}
            uploading={uploading || uploadingThumb}
          />
        ))}
      </div>
    </div>
  );
}

function ShowcaseCard({ item, isAdmin, isEditing, onStartEdit, onCancelEdit, busy, copied, onCopy, onSave, onDelete, onUpload, onUploadThumb, uploadLabel, thumbLabel, uploading }) {
  const [values, setValues] = useState(item);
  useEffect(() => { setValues(item); }, [item]);
  const isVideo = item.kind === 'video';

  if (isAdmin && isEditing) {
    return (
      <article className="showcase-card is-editing">
        <div className="showcase-admin-panel-head">
          <strong>Edit contoh</strong>
          <button type="button" className="showcase-cancel-btn" onClick={onCancelEdit} disabled={busy || uploading}>
            <X size={13} /> Batal
          </button>
        </div>
        <ExampleForm
          values={values}
          onChange={setValues}
          onSubmit={() => onSave(values)}
          onCancel={onCancelEdit}
          submitLabel="Simpan perubahan"
          busy={busy || uploading}
          uploadLabel={uploadLabel}
          thumbLabel={thumbLabel}
          onUpload={async (file) => {
            const result = await onUpload(file);
            if (result) setValues((cur) => ({ ...cur, kind: result.isVideo ? 'video' : 'image', media_url: result.url }));
          }}
          onUploadThumb={async (file) => {
            const url = await onUploadThumb(file);
            if (url) setValues((cur) => ({ ...cur, kind: 'video', poster_url: url }));
          }}
          onDelete={onDelete}
          compact
        />
      </article>
    );
  }

  return (
    <article className="showcase-card">
      <div className="showcase-media">
        {isVideo ? (
          <video
            className="showcase-video"
            src={item.media_url}
            poster={item.poster_url || undefined}
            controls
            controlsList="nodownload noplaybackrate"
            disablePictureInPicture
            preload="metadata"
            playsInline
          />
        ) : (
          <img className="showcase-image" src={item.media_url} alt={item.title || 'Contoh hasil BLEA AI'} loading="lazy" draggable={false} />
        )}
        <span className="showcase-badge">{isVideo ? <><Film size={12} /> Video</> : <><ImageIcon size={12} /> Gambar</>}</span>
        {isAdmin && !item.published && <span className="showcase-badge is-draft">Draf</span>}
      </div>
      <div className="showcase-body">
        {item.title && <h3 className="showcase-title">{item.title}</h3>}
        {item.prompt && (
          <div className="showcase-prompt-wrap">
            <p className="showcase-prompt">{item.prompt}</p>
          </div>
        )}
        <div className="showcase-card-actions">
          {item.prompt && (
            <button type="button" className="showcase-copy-btn" onClick={onCopy} aria-label="Salin prompt">
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Tersalin' : 'Salin prompt'}
            </button>
          )}
          <Link className="showcase-use-btn" to={`/generate?prompt=${encodeURIComponent(item.prompt || '')}`}>
            <Link2 size={13} /> Pakai prompt
          </Link>
          {isAdmin && (
            <button type="button" className="showcase-edit-btn" onClick={onStartEdit} aria-label={`Edit ${item.title || 'contoh'}`}>
              <Pencil size={12} /> Edit
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function ExampleForm({ values, onChange, onSubmit, onCancel, submitLabel, busy, uploadLabel, thumbLabel, onUpload, onUploadThumb, onDelete, fileRef, compact = false }) {
  const set = (patch) => onChange((cur) => ({ ...cur, ...patch }));
  const promptLen = (values.prompt || '').length;
  return (
    <form className={`showcase-form ${compact ? 'is-compact' : ''}`} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="showcase-form-row">
        <label className="showcase-field">Jenis
          <select value={values.kind} onChange={(event) => set({ kind: event.target.value })} disabled={busy}>
            <option value="image">Gambar</option>
            <option value="video">Video</option>
          </select>
        </label>
        <label className="showcase-field">Urutan
          <input type="number" value={values.sort_order} onChange={(event) => set({ sort_order: event.target.value })} disabled={busy} aria-label="Urutan tampil" />
        </label>
        <label className="showcase-check">
          <input type="checkbox" checked={values.published === true} onChange={(event) => set({ published: event.target.checked })} disabled={busy} />
          Tampilkan
        </label>
      </div>
      <label className="showcase-field">Judul
        <input type="text" value={values.title} maxLength={120} onChange={(event) => set({ title: event.target.value })} disabled={busy} placeholder="Contoh: Potret kucing studio" />
      </label>
      <label className="showcase-field">
        <span className="showcase-field-head">
          <span>Prompt</span>
          <small className="showcase-char-count">{promptLen.toLocaleString('id-ID')} / {MAX_PROMPT_CHARS.toLocaleString('id-ID')}</small>
        </span>
        <textarea rows={compact ? 4 : 5} maxLength={MAX_PROMPT_CHARS} value={values.prompt} onChange={(event) => set({ prompt: event.target.value })} disabled={busy} placeholder="Prompt lengkap yang ditampilkan ke pengguna (maks 10.000 karakter)…" required />
      </label>
      <label className="showcase-field">URL media (HTTPS · gambar ≤25MB, video ≤100MB)
        <input type="url" value={values.media_url} onChange={(event) => set({ media_url: event.target.value })} disabled={busy} placeholder="https://…" required />
      </label>
      <div className="showcase-field">
        <span>Thumbnail / poster video (opsional)</span>
        <div className="showcase-thumb-row">
          {values.poster_url && (
            <img src={values.poster_url} alt="Pratinjau thumbnail" className="showcase-thumb-preview" />
          )}
          <input type="url" value={values.poster_url || ''} onChange={(event) => set({ poster_url: event.target.value })} disabled={busy} placeholder="https://… atau unggah gambar thumbnail" aria-label="URL thumbnail video" />
          <label className="showcase-upload-btn">
            <ImageIcon size={14} /> {thumbLabel || 'Unggah thumbnail'}
            <input type="file" accept={ACCEPT_THUMB} className="showcase-file-input" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file && onUploadThumb) onUploadThumb(file); event.target.value = ''; }} />
          </label>
        </div>
      </div>
      <div className="showcase-form-actions">
        <label className="showcase-upload-btn">
          <Upload size={14} /> {uploadLabel}
          <input ref={fileRef} type="file" accept={ACCEPT_MEDIA} className="showcase-file-input" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file && onUpload) onUpload(file); event.target.value = ''; }} />
        </label>
        <button type="submit" className="showcase-primary-btn" disabled={busy}>{busy ? 'Menyimpan…' : submitLabel}</button>
        {onCancel && (
          <button type="button" className="showcase-cancel-btn" onClick={onCancel} disabled={busy}>
            Batal
          </button>
        )}
        {onDelete && (
          <button type="button" className="showcase-danger-btn" onClick={onDelete} disabled={busy}>
            <Trash2 size={14} /> Hapus
          </button>
        )}
      </div>
    </form>
  );
}
