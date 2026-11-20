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

// Generate gambar untuk semua pengguna. Model dikunci admin (Freebeat 122,
// atau model gambar Alibaba yang diaktifkan admin di Katalog Model) dan biayanya
// dipotong dari kredit BLEA di server; kredit provider keluar dari akun admin
// yang menghubungkan provider. Panel ini tidak pernah melihat token.
export function GenerateImagePanel({ initialPrompt = '' }) {
  const { user } = useAuth();
  const userId = user?.id;
  const { balance, refresh: refreshBalance } = useCredits(userId);
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState('');
  const [size, setSize] = useState('');
  const [count, setCount] = useState(1);
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

  // Daftar model: utamakan models dari server; fallback ke entri Freebeat tunggal
  // dari config lama agar provider_ready=false tetap informatif.
  const models = (() => {
    if (Array.isArray(config?.models) && config.models.length) return config.models;
    if (!config) return [];
    const fbCredits = Number.isSafeInteger(config.credits) ? config.credits : null;
    return [{
      provider: 'freebeat',
      model: config.model_id == null ? '' : String(config.model_id),
      name: `Freebeat: model ${config.model_id ?? '—'}`,
      credits: fbCredits,
      ready: config.provider_ready === true && fbCredits !== null,
      params: null,
    }];
  })();
  const isWxhValid = (value, params) => {
    if (params?.sizeMode !== 'wxh') return false;
    const match = /^(\d{3,4})\*(\d{3,4})$/.exec(String(value || ''));
    if (!match) return false;
    const min = Number(params.minSide), max = Number(params.maxSide);
    return [Number(match[1]), Number(match[2])].every((n) => n >= min && n <= max);
  };
  const isSizeOk = (value, params) => (params?.sizes?.includes(value) || isWxhValid(value, params));
  const active = models.find((model) => `${model.provider}:${model.model}` === selected) || models.find((model) => model.ready) || models[0] || null;
  useEffect(() => {
    if (!active) return;
    if (selected !== `${active.provider}:${active.model}`) setSelected(`${active.provider}:${active.model}`);
    const nextSize = active.params?.defaultSize || '';
    setSize((current) => (isSizeOk(current, active.params) ? current : nextSize));
    setCount((current) => (active.params?.maxN ? Math.min(Math.max(1, Number(current) || 1), active.params.maxN) : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.provider, active?.model]);

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
    const res = await generateImage(text, active ? { provider: active.provider, model: active.model, ...(active.params ? { size, n: count } : {}) } : {});
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

  const price = active && Number.isSafeInteger(active.credits) ? active.credits : null;
  const ready = active?.ready === true && price !== null;
  const insufficient = price !== null && balance !== null && balance < price;
  const isFreebeat = active?.provider === 'freebeat';
  const headerSub = active
    ? `Dari teks · ${active.name} · ${price !== null ? `${price} kredit BLEA per gambar` : 'harga belum diatur admin'}`
    : 'Dari teks · belum ada model yang diaktifkan admin';

  return <div className="generate-card">
    <div className="generate-card-head">
      <div>
        <h2 className="generate-card-title">Generate gambar</h2>
        <p className="generate-card-sub">{headerSub}</p>
      </div>
    </div>

    {loading && <p className="generate-hint" role="status">Memuat konfigurasi provider…</p>}
    {!loading && models.length === 0 && <div className="generate-banner" role="status"><span>Belum ada model gambar yang diaktifkan admin. Minta admin membuka Katalog Model dan menetapkannya.</span></div>}
    {!loading && active && !ready && active.provider === 'freebeat' && <div className="generate-banner" role="status"><span>Provider gambar belum dihubungkan oleh admin, jadi generasi belum dapat dikirim. Tidak ada kredit yang dipotong.</span></div>}
    {!loading && active && !ready && active.provider === 'alibaba' && <div className="generate-banner" role="status"><span>{active.credits == null || price === null ? 'Harga kredit untuk model ini belum diatur admin. Buka Admin → Kredit untuk mengisinya.' : 'Belum ada akun Alibaba Cloud yang terhubung di pool admin, jadi generasi belum dapat dikirim.'}</span><Link className="generate-banner-link" to="/admin">Atur di admin</Link></div>}
    {!loading && active && ready && price === null && <div className="generate-banner" role="status"><span>Harga kredit untuk model ini belum diatur admin. Buka Admin → Kredit untuk mengisinya.</span><Link className="generate-banner-link" to="/admin">Atur harga</Link></div>}
    {error && <div className="generate-banner is-error" role="alert">{error}</div>}
    {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
    {insufficient && ready && <div className="generate-banner" role="status"><span>Saldo kredit BLEA Anda kurang dari {price} kredit. Saldo ada di pojok kanan atas.</span><Link className="generate-banner-link" to="/credits">Tambah kredit</Link></div>}

    <form onSubmit={submit}>
      {models.length > 0 && <label className="generate-field">
        <span className="generate-label">Model gambar</span>
        <select className="generate-select" value={active ? `${active.provider}:${active.model}` : ''} onChange={(event) => {
          const next = models.find((model) => `${model.provider}:${model.model}` === event.target.value);
          setSelected(event.target.value);
          setError('');
          setNotice('');
          const nextSize = next?.params?.defaultSize || '';
          setSize(nextSize);
          setCount(1);
        }}>
          {models.map((model) => <option key={`${model.provider}:${model.model}`} value={`${model.provider}:${model.model}`}>{model.name}{Number.isSafeInteger(model.credits) ? ` · ${model.credits} kredit` : ' · harga belum diatur'}</option>)}
        </select>
      </label>}
      {active?.params && (active.params.sizeMode === 'wxh' || active.params.sizes?.length > 0) && <div className="generate-params-row">
        <label className="generate-field">
          <span className="generate-label">Ukuran</span>
          {active.params.sizeMode === 'wxh'
            ? <>
                <input className="generate-select generate-size-input" type="text" inputMode="numeric" list="alibaba-size-suggest" value={size} onChange={(event) => { setSize(event.target.value); setNotice(''); }} placeholder={active.params.defaultSize} aria-label="Ukuran gambar (lebar*tinggi)" />
                <datalist id="alibaba-size-suggest">
                  {[...new Set([active.params.defaultSize, '2048*2048', '1664*928', '1472*1104', '1328*1328', '1280*1280', '1104*1472', '928*1664'])].map((option) => <option key={option} value={option} />)}
                </datalist>
                <span className="generate-hint">Format LEBAR*TINGGI · sisi {active.params.minSide}–{active.params.maxSide} piksel</span>
              </>
            : <select className="generate-select" value={size} onChange={(event) => { setSize(event.target.value); setNotice(''); }}>
                {active.params.sizes.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>}
        </label>
        <label className="generate-field">
          <span className="generate-label">Jumlah gambar</span>
          <select className="generate-select" value={String(count)} onChange={(event) => { setCount(Number(event.target.value)); setNotice(''); }}>
            {Array.from({ length: active.params.maxN }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>}
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
