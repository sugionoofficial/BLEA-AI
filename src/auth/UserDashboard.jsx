import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Image as ImageIcon, Film, Link2, Loader2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import './showcase.css';

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};
const ACCEPT = Object.keys(MEDIA_TYPES).join(',');

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
  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [uploading, setUploading] = useState(false);
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

  async function uploadMedia(file) {
    if (!file || uploading) return null;
    const extension = MEDIA_TYPES[file.type];
    if (!extension || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_MEDIA_BYTES) {
      setError('Pilih berkas JPG, PNG, WebP, MP4, MOV, atau WebM maksimal 25 MB.');
      return null;
    }
    const path = `showcase/${crypto.randomUUID()}.${extension}`;
    setUploading(true);
    try {
      const { error: uploadError } = await supabase.storage.from('ai-studio-uploads').upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) throw new Error('Upload gagal.');
      const { data } = supabase.storage.from('ai-studio-uploads').getPublicUrl(path);
      const url = cleanUrl(data?.publicUrl);
      if (!url) throw new Error('URL publik tidak tersedia.');
      return { url, isVideo: extension !== 'jpg' && extension !== 'png' && extension !== 'webp' };
    } catch (err) {
      setError(err.message || 'Upload media gagal.');
      return null;
    } finally {
      setUploading(false);
    }
  }

  function validateForm(values) {
    const media = cleanUrl(values.media_url);
    if (media === null || !media) return 'URL media wajib berupa tautan HTTPS yang valid.';
    const poster = cleanUrl(values.poster_url);
    if (values.poster_url.trim() && poster === null) return 'URL poster harus berupa tautan HTTPS yang valid.';
    if (!String(values.prompt).trim()) return 'Prompt wajib diisi.';
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
      prompt: form.prompt.trim().slice(0, 2000),
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
      prompt: values.prompt.trim().slice(0, 2000),
      media_url: cleanUrl(values.media_url),
      poster_url: cleanUrl(values.poster_url) || '',
      sort_order: Math.trunc(Number(values.sort_order) || 0),
      published: values.published === true,
    }).eq('id', id);
    setBusyId('');
    if (updateError) { setError('Gagal menyimpan perubahan.'); return; }
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

  return (
    <div className="showcase">
      <div className="showcase-hero">
        <div>
          <span className="showcase-kicker">GALERI CONTOH</span>
          <h1>Inspirasi dari karya BLEA AI</h1>
          <p>Lihat contoh gambar dan video buatan AI beserta prompt-nya. Salin prompt, lalu buat versi Anda sendiri di halaman Generate.</p>
        </div>
        {isAdmin && (
          <button type="button" className={`showcase-admin-toggle ${editMode ? 'is-active' : ''}`} onClick={() => setEditMode((v) => !v)} aria-pressed={editMode}>
            {editMode ? <X size={15} /> : <Pencil size={15} />}
            {editMode ? 'Selesai mengedit' : 'Mode edit (admin)'}
          </button>
        )}
      </div>

      {notice && <div className="showcase-alert" role="status">{notice}</div>}
      {error && <div className="showcase-alert is-error" role="alert">{error}</div>}

      {isAdmin && editMode && (
        <div className="showcase-admin-panel">
          <button type="button" className="showcase-add-toggle" onClick={() => setAddOpen((v) => !v)} aria-expanded={addOpen}>
            {addOpen ? <X size={15} /> : <Plus size={15} />}
            {addOpen ? 'Tutup formulir' : 'Tambah contoh baru'}
          </button>
          {addOpen && (
            <ExampleForm
              values={form}
              onChange={setForm}
              onSubmit={addExample}
              submitLabel="Tambah contoh"
              busy={saving || uploading}
              uploadLabel={uploading ? 'Mengunggah…' : 'Unggah media'}
              onUpload={async (file) => {
                const result = await uploadMedia(file);
                if (result) setForm((cur) => ({ ...cur, kind: result.isVideo ? 'video' : 'image', media_url: result.url }));
              }}
              fileRef={addFileRef}
            />
          )}
        </div>
      )}

      {loading && <p className="showcase-status" role="status"><Loader2 size={16} className="showcase-spin" /> Memuat contoh…</p>}
      {!loading && visible.length === 0 && (
        <div className="showcase-empty">
          <ImageIcon size={26} />
          <h2>Contoh belum tersedia</h2>
          <p>{isAdmin ? 'Gunakan Mode edit di atas untuk menambahkan contoh gambar atau video pertama.' : 'Galeri contoh sedang disiapkan. Silakan kembali lagi nanti.'}</p>
        </div>
      )}

      <div className="showcase-grid">
        {visible.map((item) => (
          <ShowcaseCard
            key={item.id}
            item={item}
            isAdmin={isAdmin}
            editMode={editMode}
            busy={busyId === item.id}
            copied={copiedId === item.id}
            onCopy={() => copyPrompt(item)}
            onSave={(values) => updateExample(item.id, values)}
            onDelete={() => removeExample(item)}
            onUpload={async (file) => {
              const result = await uploadMedia(file);
              return result;
            }}
            editFileRef={(node) => { editFileRefs.current[item.id] = node; }}
            uploading={uploading}
          />
        ))}
      </div>
    </div>
  );
}

function ShowcaseCard({ item, isAdmin, editMode, busy, copied, onCopy, onSave, onDelete, onUpload, editFileRef, uploading }) {
  const [values, setValues] = useState(item);
  useEffect(() => { setValues(item); }, [item]);
  const isVideo = item.kind === 'video';

  if (isAdmin && editMode) {
    return (
      <article className="showcase-card is-editing">
        <ExampleForm
          values={values}
          onChange={setValues}
          onSubmit={() => onSave(values)}
          submitLabel="Simpan perubahan"
          busy={busy || uploading}
          uploadLabel={uploading ? 'Mengunggah…' : 'Unggah media'}
          onUpload={async (file) => {
            const result = await onUpload(file);
            if (result) setValues((cur) => ({ ...cur, kind: result.isVideo ? 'video' : 'image', media_url: result.url }));
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
            <button type="button" className="showcase-copy-btn" onClick={onCopy} aria-label="Salin prompt">
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? 'Tersalin' : 'Salin prompt'}
            </button>
          </div>
        )}
        <Link className="showcase-use-btn" to={`/generate?prompt=${encodeURIComponent(item.prompt || '')}`}>
          <Link2 size={14} /> Gunakan prompt di Generate
        </Link>
      </div>
    </article>
  );
}

function ExampleForm({ values, onChange, onSubmit, submitLabel, busy, uploadLabel, onUpload, onDelete, fileRef, compact = false }) {
  const set = (patch) => onChange((cur) => ({ ...cur, ...patch }));
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
      <label className="showcase-field">Prompt
        <textarea rows={compact ? 3 : 4} maxLength={2000} value={values.prompt} onChange={(event) => set({ prompt: event.target.value })} disabled={busy} placeholder="Prompt lengkap yang ditampilkan ke pengguna…" required />
      </label>
      <label className="showcase-field">URL media (HTTPS)
        <input type="url" value={values.media_url} onChange={(event) => set({ media_url: event.target.value })} disabled={busy} placeholder="https://…" required />
      </label>
      {values.kind === 'video' && (
        <label className="showcase-field">URL poster video (opsional)
          <input type="url" value={values.poster_url} onChange={(event) => set({ poster_url: event.target.value })} disabled={busy} placeholder="https://…" />
        </label>
      )}
      <div className="showcase-form-actions">
        <label className="showcase-upload-btn">
          <Upload size={14} /> {uploadLabel}
          <input ref={fileRef} type="file" accept={ACCEPT} className="showcase-file-input" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file && onUpload) onUpload(file); event.target.value = ''; }} />
        </label>
        <button type="submit" className="showcase-primary-btn" disabled={busy}>{busy ? 'Menyimpan…' : submitLabel}</button>
        {onDelete && (
          <button type="button" className="showcase-danger-btn" onClick={onDelete} disabled={busy}>
            <Trash2 size={14} /> Hapus
          </button>
        )}
      </div>
    </form>
  );
}
