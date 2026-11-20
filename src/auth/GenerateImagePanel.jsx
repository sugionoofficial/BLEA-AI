import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { fetchImageConfig, fetchImageHistory, fetchImageStatus, generateImage } from '../api/generation';
import { useAuth } from './AuthProvider';
import { useCredits } from '../lib/useCredits';
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

// Generate gambar untuk semua pengguna. Model dikunci admin (teks: 122) dan
// biayanya dipotong dari kredit BLEA di server; kredit Freebeat keluar dari
// akun admin yang menghubungkan provider. Panel ini tidak pernah melihat token.
export function GenerateImagePanel({ initialPrompt = '' }) {
  const { user } = useAuth();
  const userId = user?.id;
  const { balance, refresh: refreshBalance } = useCredits(userId);
  const [config, setConfig] = useState(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const pollVersion = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    const [configRes, historyRes] = await Promise.all([fetchImageConfig(), fetchImageHistory()]);
    if (configRes.ok) setConfig(configRes.data);
    if (historyRes.ok && Array.isArray(historyRes.data?.generations)) setItems(historyRes.data.generations);
    refreshBalance();
    setLoading(false);
  }, [refreshBalance]);

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
      if ([...updates.values()].some((item) => !isPending(item))) refreshBalance();
    }, 10000);
    return () => { clearInterval(timer); };
  }, [items, refreshBalance]);

  async function submit(event) {
    event.preventDefault();
    const text = prompt.trim();
    if (busy || !text) return;
    setBusy(true); setError(''); setNotice('');
    const res = await generateImage(text);
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
    refreshBalance();
    setBusy(false);
  }

  const price = Number.isSafeInteger(config?.credits) ? config.credits : null;
  const ready = config?.provider_ready === true && price !== null;
  const insufficient = price !== null && balance !== null && balance < price;

  return <div className="generate-card">
    <div className="generate-card-head">
      <div>
        <h2 className="generate-card-title">Generate gambar</h2>
        <p className="generate-card-sub">Dari teks · model {config?.model_id ?? '—'} · {price !== null ? `${price} kredit BLEA per gambar` : 'harga belum diatur admin'}</p>
      </div>
    </div>

    {loading && <p className="generate-hint" role="status">Memuat konfigurasi provider…</p>}
    {!loading && config?.provider_ready === false && <div className="generate-banner" role="status"><span>Provider gambar belum dihubungkan oleh admin, jadi generasi belum dapat dikirim. Tidak ada kredit yang dipotong.</span></div>}
    {!loading && config?.provider_ready && price === null && <div className="generate-banner" role="status"><span>Harga kredit untuk model ini belum diatur admin. Buka Admin → Kredit untuk mengisinya.</span>{<Link className="generate-banner-link" to="/admin">Atur harga</Link>}</div>}
    {error && <div className="generate-banner is-error" role="alert">{error}</div>}
    {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
    {insufficient && ready && <div className="generate-banner" role="status"><span>Saldo kredit BLEA Anda kurang dari {price} kredit. Saldo ada di pojok kanan atas.</span><Link className="generate-banner-link" to="/credits">Tambah kredit</Link></div>}

    <form onSubmit={submit}>
      <label className="generate-field">
        <span className="generate-label">Prompt gambar</span>
        <textarea className="generate-textarea" rows={4} maxLength={2000} value={prompt} placeholder="Contoh: potret studio seekor kucing hitam, cahaya lembut, latar abu-abu" onChange={(event) => { setPrompt(event.target.value); setNotice(''); }} />
      </label>
      <p className="generate-hint">{prompt.trim().length}/2000 karakter · biaya {price !== null ? price : '—'} kredit dipotong saat pengiriman berhasil.</p>
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
