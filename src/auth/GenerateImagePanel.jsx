import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { deleteFreebeatImage, uploadFreebeatImage } from '../lib/freebeatVideoUpload';
import { fetchImageConfig, fetchImageHistory, fetchImageStatus, generateImage } from '../api/generation';
import './generate.css';
import './history.css';

const STATUS_LABEL = {
  queued: 'Dalam antrean',
  processing: 'Sedang diproses',
  completed: 'Selesai',
  failed: 'Gagal',
  unknown: 'Hasil tidak pasti',
};
const isPending = (item) => item.status === 'queued' || item.status === 'processing';

// Generate gambar untuk semua pengguna. Model dikunci admin (teks: 122, edit
// foto: 202) dan biayanya dipotong dari kredit BLEA di server; kredit Freebeat
// keluar dari akun admin yang menghubungkan provider. Panel ini tidak pernah
// melihat token.
export function GenerateImagePanel({ initialPrompt = '' }) {
  const [config, setConfig] = useState(null);
  const [balance, setBalance] = useState(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [uploaded, setUploaded] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [aspect, setAspect] = useState('9:16');
  const [resolution, setResolution] = useState('1K');
  const fileInput = useRef(null);
  const pollVersion = useRef(0);

  async function uploadPhoto() {
    if (!file || uploadBusy) return;
    setUploadBusy(true); setUploadError('');
    try {
      const { data } = await supabase.auth.getUser();
      const userId = data?.user?.id;
      if (!userId) throw new Error('Sesi login tidak tersedia. Silakan login kembali.');
      const result = await uploadFreebeatImage(supabase.storage, userId, file);
      if (!result.url) throw new Error('Upload berhasil tetapi URL publik tidak tersedia. Hapus objeknya di dashboard Supabase lalu coba lagi.');
      setUploaded(result);
    } catch (err) { setUploadError(err.message || 'Upload gagal.'); }
    finally { setUploadBusy(false); }
  }
  async function removePhoto() {
    if (!uploaded?.path || uploadBusy) return;
    setUploadBusy(true); setUploadError('');
    try { await deleteFreebeatImage(supabase.storage, uploaded.path); setUploaded(null); setFile(null); if (fileInput.current) fileInput.current.value = ''; }
    catch (err) { setUploadError(err.message || 'Penghapusan gagal.'); }
    finally { setUploadBusy(false); }
  }

  const loadBalance = useCallback(async () => {
    const { data } = await supabase.auth.getUser();
    const userId = data?.user?.id;
    if (!userId) { setBalance(null); return; }
    const row = await supabase.from('credit_wallets').select('balance').eq('user_id', userId).maybeSingle();
    setBalance(Number(row?.data?.balance ?? 0));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [configRes, historyRes] = await Promise.all([fetchImageConfig(), fetchImageHistory()]);
    if (configRes.ok) {
      setConfig(configRes.data);
      // Rasio harus salah satu yang dapat dihargai provider; bila daftar admin
      // berubah, pilihan lama dikembalikan ke default.
      const ratios = Array.isArray(configRes.data?.edit_aspect_ratios) && configRes.data.edit_aspect_ratios.length ? configRes.data.edit_aspect_ratios : ['9:16'];
      setAspect((current) => (ratios.includes(current) ? current : (configRes.data?.edit_aspect_default || ratios[0])));
      const resolutions = Array.isArray(configRes.data?.edit_resolutions) && configRes.data.edit_resolutions.length ? configRes.data.edit_resolutions : ['1K'];
      setResolution((current) => (resolutions.includes(current) ? current : (configRes.data?.edit_resolution || resolutions[0])));
    }
    if (historyRes.ok && Array.isArray(historyRes.data?.generations)) setItems(historyRes.data.generations);
    await loadBalance();
    setLoading(false);
  }, [loadBalance]);

  useEffect(() => { load(); }, [load]);

  // Perbarui tugas yang masih diproses tanpa mengirim generasi baru.
  useEffect(() => {
    const pending = items.filter((item) => isPending(item) && item.canPoll).slice(0, 4);
    if (!pending.length) return undefined;
    const version = ++pollVersion.current;
    const timer = setInterval(async () => {
      const results = await Promise.all(pending.map((item) => fetchImageStatus(item.id)));
      if (version !== pollVersion.current) return;
      const updates = new Map(results.filter((res) => res.ok && res.data?.generation).map((res) => [res.data.generation.id, res.data.generation]));
      if (!updates.size) return;
      setItems((current) => current.map((item) => updates.get(item.id) || item));
      if ([...updates.values()].some((item) => !isPending(item))) loadBalance();
    }, 10000);
    return () => { clearInterval(timer); };
  }, [items, loadBalance]);

  async function submit(event) {
    event.preventDefault();
    const text = prompt.trim();
    if (busy || !text) return;
    setBusy(true); setError(''); setNotice('');
    const res = await generateImage(text, uploaded?.url || '', uploaded?.url ? aspect : '', uploaded?.url ? resolution : '');
    if (!res.ok) {
      setError(res.data?.error || 'Generasi gambar gagal. Kredit tidak dipotong bila kegagalan terjadi sebelum pengiriman.');
      setBusy(false);
      return;
    }
    const generation = res.data?.generation || null;
    if (generation) setItems((current) => [generation, ...current.filter((item) => item.id !== generation.id)]);
    if (res.data?.status === 'unknown') {
      setError('Hasil pengiriman tidak pasti dan kredit mungkin sudah terpakai. Jangan ulangi; periksa status di riwayat terlebih dahulu.');
    } else {
      setNotice(`Permintaan diterima (${res.data?.credits ?? config?.credits ?? 0} kredit BLEA). Gambar biasanya selesai dalam beberapa detik hingga satu menit.`);
    }
    await loadBalance();
    setBusy(false);
  }

  const editMode = Boolean(uploaded?.url);
  // Provider mengambil foto secara asinkron SESUDAH job dikirim: menghapus foto
  // saat generasi masih berjalan membuat job gagal di sisi provider.
  const pendingCount = items.filter(isPending).length;
  // Harga edit bergantung resolusi (biaya provider 1K = 18, 2K = 27 kredit).
  const resolutionPrice = config?.edit_price_by_resolution?.[resolution];
  const editPrice = Number.isSafeInteger(resolutionPrice) ? resolutionPrice : config?.edit_credits;
  const price = Number.isSafeInteger(editMode ? editPrice : config?.credits) ? (editMode ? editPrice : config.credits) : null;
  const ready = config?.provider_ready === true && price !== null;
  const insufficient = price !== null && balance !== null && balance < price;

  return <div className="generate-card">
    <div className="generate-card-head">
      <div>
        <h2 className="generate-card-title">Generate gambar</h2>
        <p className="generate-card-sub">{editMode ? `Edit foto · model ${config?.edit_model_id ?? '—'}` : `Dari teks · model ${config?.model_id ?? '—'}`} · {price !== null ? `${price} kredit BLEA per gambar` : 'harga belum diatur admin'}</p>
      </div>
      {balance !== null && <span className="generate-pill is-accent">Saldo {balance} kredit</span>}
    </div>

    {loading && <p className="generate-hint" role="status">Memuat konfigurasi provider…</p>}
    {!loading && config?.provider_ready === false && <div className="generate-banner" role="status"><span>Provider gambar belum dihubungkan oleh admin, jadi generasi belum dapat dikirim. Tidak ada kredit yang dipotong.</span></div>}
    {!loading && config?.provider_ready && price === null && <div className="generate-banner" role="status"><span>Harga kredit untuk model ini belum diatur admin. Buka Admin → Kredit untuk mengisinya.</span>{<Link className="generate-banner-link" to="/admin">Atur harga</Link>}</div>}
    {error && <div className="generate-banner is-error" role="alert">{error}</div>}
    {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
    {insufficient && ready && <div className="generate-banner" role="status"><span>Saldo kredit BLEA Anda kurang dari {price} kredit.</span><Link className="generate-banner-link" to="/credits">Tambah kredit</Link></div>}

    <form onSubmit={submit}>
      <div className="generate-field">
        <span className="generate-label">Foto referensi (opsional — mengaktifkan mode edit gambar)</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || uploadBusy || Boolean(uploaded)} onChange={(event) => { setFile(event.target.files?.[0] || null); setUploadError(''); setPublicConfirmed(false); }} />
        <p className="generate-hint">JPG, PNG, atau WebP maksimal 10 MB. Foto disimpan di bucket <b>publik</b> Supabase agar provider dapat mengambilnya: siapa pun yang punya URL-nya bisa membuka, dan provider dapat menyimpan salinannya. Jangan unggah foto pribadi yang sensitif. Jangan hapus foto selama generasi masih berjalan — provider mengambilnya setelah permintaan dikirim, dan foto yang hilang membuat generasi gagal. Hapus setelah semua gambar selesai bila tidak diperlukan lagi.</p>
        {!uploaded && <label className="freebeat-confirm"><input type="checkbox" checked={publicConfirmed} disabled={busy || uploadBusy || !file} onChange={(event) => setPublicConfirmed(event.target.checked)} /> Saya memahami foto ini akan disimpan secara publik dan dikirim ke provider.</label>}
        <div className="generate-actions">
          {!uploaded
            ? <button className="generate-secondary-btn" type="button" disabled={busy || uploadBusy || !file || !publicConfirmed} onClick={uploadPhoto}>{uploadBusy ? 'Mengunggah…' : 'Unggah foto'}</button>
            : <button className="generate-secondary-btn" type="button" disabled={busy || uploadBusy || pendingCount > 0} onClick={removePhoto}>{uploadBusy ? 'Menghapus…' : pendingCount > 0 ? `Hapus foto (tunggu ${pendingCount} generasi selesai)` : 'Hapus foto'}</button>}
        </div>
        {uploadError && <div className="generate-banner is-error" role="alert">{uploadError}</div>}
        {uploaded?.url && <div className="generate-source-preview"><img src={uploaded.url} alt="Foto referensi yang akan dikirim ke provider" /><p className="generate-hint">Mode edit aktif · model {config?.edit_model_id ?? '—'} · {config?.edit_credits ?? '—'} kredit BLEA · rasio {aspect} · resolusi {resolution}</p></div>}
        {uploaded?.url && <div className="generate-field">
          <span className="generate-label">Rasio dan resolusi hasil edit</span>
          <select className="generate-select" value={aspect} disabled={busy || uploadBusy} onChange={(event) => { setAspect(event.target.value); setNotice(''); }} aria-label="Rasio hasil edit">
            {(Array.isArray(config?.edit_aspect_ratios) && config.edit_aspect_ratios.length ? config.edit_aspect_ratios : ['9:16']).map((ratio) => <option key={ratio} value={ratio}>Rasio {ratio}</option>)}
          </select>
          <select className="generate-select" value={resolution} disabled={busy || uploadBusy} onChange={(event) => { setResolution(event.target.value); setNotice(''); setError(''); }} aria-label="Resolusi hasil edit">
            {(Array.isArray(config?.edit_resolutions) && config.edit_resolutions.length ? config.edit_resolutions : ['1K']).map((item) => <option key={item} value={item}>Resolusi {item}{Number.isSafeInteger(config?.edit_price_by_resolution?.[item]) ? ` — ${config.edit_price_by_resolution[item]} kredit` : ' — harga belum diatur'}</option>)}
          </select>
          <p className="generate-hint">Rasio tidak memengaruhi biaya; resolusi memengaruhi (1K lebih murah daripada 2K). Keduanya wajib dikirim agar provider dapat menghitung biaya model edit.</p>
        </div>}
      </div>
      <label className="generate-field">
        <span className="generate-label">{editMode ? 'Instruksi edit' : 'Prompt gambar'}</span>
        <textarea className="generate-textarea" rows={4} maxLength={2000} value={prompt} placeholder="Contoh: potret studio seekor kucing hitam, cahaya lembut, latar abu-abu" onChange={(event) => { setPrompt(event.target.value); setNotice(''); }} />
      </label>
      <p className="generate-hint">{prompt.trim().length}/2000 karakter · mode {editMode ? 'edit foto' : 'teks ke gambar'} · biaya {price !== null ? price : '—'} kredit dipotong saat pengiriman berhasil{price !== null && balance !== null ? ` · saldo setelahnya ${Math.max(0, balance - price)} kredit` : ''}.</p>
      <div className="generate-actions">
        <button className="generate-submit-btn" type="submit" disabled={busy || !ready || insufficient || !prompt.trim()}>
          {busy ? 'Mengirim…' : `Buat gambar${price !== null ? ` (${price} kredit)` : ''}`}
        </button>
        <button className="generate-secondary-btn" type="button" disabled={busy || loading} onClick={load}>Perbarui</button>
      </div>
    </form>

    {items.length > 0 && <div className="generate-history">
      <h3 className="generate-card-title">Riwayat gambar</h3>
      <div className="history-grid">
        {items.slice(0, 12).map((item) => <article className="history-card" key={item.id}>
          {item.status === 'completed' && item.image_url
            ? <img src={item.image_url} alt={item.prompt || 'Hasil generasi gambar'} loading="lazy" />
            : <div className="history-preview">{STATUS_LABEL[item.status] || item.status}</div>}
          <div className="history-card-body">
            <span className={`history-status status-${item.status}`}>{STATUS_LABEL[item.status] || item.status}</span>
            <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
            {item.source_image_url && <p className="history-meta">Foto referensi: <a href={item.source_image_url} target="_blank" rel="noopener noreferrer">buka</a></p>}
            <p className="history-meta">{item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · model {item.model} · {item.credits_charged} kredit{item.credits_refunded > 0 ? ` · ${item.credits_refunded} dikembalikan` : ''}</p>
            {item.error_message && <p className="history-error-text">{item.error_message}</p>}
            {item.status === 'unknown' && <p className="history-error-text">Jangan ulangi sebelum statusnya jelas; kredit mungkin sudah terpakai.</p>}
            {item.status === 'completed' && item.image_url && <div className="history-card-actions"><a href={item.image_url} target="_blank" rel="noopener noreferrer">Buka gambar</a></div>}
          </div>
        </article>)}
      </div>
      <p className="generate-hint">Riwayat lengkap tersedia di <Link to="/history">halaman History</Link>.</p>
    </div>}
  </div>;
}
