import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  buildDownloadFilename,
  fetchImageConfig,
  fetchImageHistory,
  fetchImageStatus,
  generateImage,
  withDownloadParam,
} from '../api/generation';
import { fetchStudioImageConfig, generateStudioImage } from '../studio/studioClient';
import { useAuth } from './AuthProvider';
import { useCredits } from '../lib/useCredits';
import { formatCredits, formatModelDisplayName, formatProviderBadge } from '../lib/formatCredits';
import { formatElapsedRuntime, useNowTick } from '../lib/formatRuntime';
import { ModelSelect } from './ModelSelect';
import './generate.css';
import './history.css';

const STATUS_LABEL = {
  submitted: 'Sedang diproses',
  queued: 'Dalam antrean',
  processing: 'Sedang diproses',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  unknown: 'Hasil tidak pasti',
};
const isPending = (item) => item.status === 'queued' || item.status === 'processing' || item.status === 'submitted';
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// Generate gambar untuk semua pengguna. Model dikunci admin (Freebeat 122,
// atau model gambar Alibaba yang diaktifkan admin di Katalog Model) dan biayanya
// dipotong dari kredit BLEA di server; kredit provider keluar dari akun admin
// yang menghubungkan provider. Panel ini tidak pernah melihat token.
export function GenerateImagePanel({ initialPrompt = '' }) {
  const { user } = useAuth();
  // Di dalam Studio, gambar dibuat lewat pool akun OpenAI (gpt-image-1), bukan
  // freebeat/Alibaba. Kredit BLEA tidak dipotong; yang dibatasi kuota harian
  // akun. Halaman /generate di luar Studio tetap memakai jalur lama.
  const studioMode = typeof window !== 'undefined' && /^\/studio(\/|$)/.test(window.location.pathname || '');
  const [studioGeneration, setStudioGeneration] = useState(null);
  const userId = user?.id;
  const { balance, refresh: refreshBalance } = useCredits(userId);
  const [config, setConfig] = useState(null);
  const [studioConfig, setStudioConfig] = useState(null);
  const [selected, setSelected] = useState('');
  const [size, setSize] = useState('');
  const [count, setCount] = useState(1);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [sourceImages, setSourceImages] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitStartedAt, setSubmitStartedAt] = useState(null);
  const pollVersion = useRef(0);
  const hasActiveImageJobs = busy || items.some(isPending);
  const liveNowMs = useNowTick(hasActiveImageJobs, 1000);

  const load = useCallback(async () => {
    setLoading(true);
    if (studioMode) {
      const studioRes = await fetchStudioImageConfig();
      if (studioRes.ok) setStudioConfig(studioRes.data);
      setLoading(false);
      return;
    }
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
    // Studio: hanya model OpenAI dari pool akun. Kredit tidak dipotong, jadi
    // label biayanya "kuota akun", bukan "kredit BLEA".
    if (studioMode) {
      const list = Array.isArray(studioConfig?.models) ? studioConfig.models : [];
      return list.map((model) => ({
        provider: 'openai',
        model: model.id,
        name: model.id,
        credits: null,
        ready: Boolean(studioConfig?.ready),
        params: { sizeMode: 'preset', sizes: ['1024x1024', '1024x1536', '1536x1024'], defaultSize: '1024x1024', maxN: 1, maxPromptChars: 4000, maxInputImages: 0 },
      }));
    }
    if (Array.isArray(config?.models)) return config.models;
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
  const active = models.find((model) => `${model.provider}:${model.model}` === selected) || models.find((model) => model.ready) || models[0] || null;
  const maxInputImages = Number(active?.params?.maxInputImages) || 0;
  const requiresImageInput = Boolean(active?.params?.requiresImageInput);
  const maxPromptChars = Number(active?.params?.maxPromptChars) || 2000;
  const isWan26InterleaveImage = active?.model === 'wan2.6-image';
  const effectiveMaxN = isWan26InterleaveImage && sourceImages.length > 0 ? 4 : (active?.params?.maxN || 1);

  const isWxhValid = (value, params) => {
    if (params?.sizeMode !== 'wxh') return false;
    const match = /^(\d{3,4})\*(\d{3,4})$/.exec(String(value || ''));
    if (!match) return false;
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (params.minSide && (w < Number(params.minSide) || h < Number(params.minSide))) return false;
    if (params.maxSide && (w > Number(params.maxSide) || h > Number(params.maxSide))) return false;
    const product = w * h;
    if (params.minProduct && product < Number(params.minProduct)) return false;
    const maxProduct = isWan26InterleaveImage && sourceImages.length > 0 ? 2048 * 2048 : params.maxProduct;
    if (maxProduct && product > Number(maxProduct)) return false;
    if (params.minRatio && w / h < Number(params.minRatio)) return false;
    if (params.maxRatio && w / h > Number(params.maxRatio)) return false;
    return true;
  };
  const isSizeOk = (value, params) => {
    if (params?.sizes?.includes(value)) return true;
    if (isWan26InterleaveImage && sourceImages.length > 0 && (value === '1K' || value === '2K')) return true;
    return isWxhValid(value, params);
  };

  useEffect(() => {
    if (!active) return;
    if (selected !== `${active.provider}:${active.model}`) setSelected(`${active.provider}:${active.model}`);
    const nextSize = active.params?.defaultSize || '';
    setSize((current) => (isSizeOk(current, active.params) ? current : nextSize));
    setCount((current) => (active.params?.maxN ? Math.min(Math.max(1, Number(current) || 1), effectiveMaxN) : 1));
    setSourceImages((current) => (maxInputImages > 0 ? current.slice(0, maxInputImages) : []));
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

  async function handleImageFiles(event) {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length || !maxInputImages) return;
    if (!userId) {
      setError('Sesi belum siap untuk mengunggah gambar.');
      return;
    }
    const slotsLeft = maxInputImages - sourceImages.length;
    if (slotsLeft <= 0) {
      setError(`Maksimal ${maxInputImages} gambar sumber untuk model ini.`);
      return;
    }
    setUploading(true);
    setError('');
    setNotice('');
    try {
      const uploaded = [];
      for (const file of files.slice(0, slotsLeft)) {
        if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
          throw new Error('Format gambar hanya mendukung PNG, JPG, atau WEBP.');
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          throw new Error('Ukuran tiap gambar maksimal 10 MB.');
        }
        const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
        const path = `${userId}/image-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
        const { data, error: uploadError } = await supabase.storage
          .from('ai-studio-uploads')
          .upload(path, file, { contentType: file.type || 'image/png' });
        if (uploadError) throw uploadError;
        const { data: pub } = supabase.storage.from('ai-studio-uploads').getPublicUrl(data.path);
        if (pub?.publicUrl) uploaded.push(pub.publicUrl);
      }
      if (uploaded.length) setSourceImages((current) => [...current, ...uploaded].slice(0, maxInputImages));
    } catch (err) {
      setError(err?.message || 'Gagal mengunggah gambar sumber.');
    } finally {
      setUploading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const text = prompt.trim();
    if (busy || uploading || !text) return;
    if (requiresImageInput && sourceImages.length === 0) {
      setError(`Model ${active?.name || 'ini'} wajib menyertakan minimal 1 gambar sumber.`);
      return;
    }
    setBusy(true); setError(''); setNotice('');
    setSubmitStartedAt(Date.now());
    if (studioMode) {
      const studioRes = await generateStudioImage({
        prompt: text,
        model: active?.model || 'gpt-image-1',
        size: size || '1024x1024',
      });
      if (!studioRes.ok) {
        setError(studioRes.data?.error || 'Generasi gambar gagal di pool akun OpenAI.');
        setBusy(false);
        setSubmitStartedAt(null);
        return;
      }
      const studioRow = studioRes.data?.generation || null;
      if (studioRow) {
        setStudioGeneration(studioRow);
        setNotice('Gambar selesai dibuat lewat akun OpenAI. Tidak ada kredit BLEA yang dipotong.');
      }
      setBusy(false);
      setSubmitStartedAt(null);
      return;
    }
    const res = await generateImage(
      text,
      active
        ? {
            provider: active.provider,
            model: active.model,
            ...(active.params ? { size, n: Math.min(count, effectiveMaxN) } : {}),
            ...(maxInputImages > 0 && sourceImages.length > 0 ? { images: sourceImages } : {}),
          }
        : {},
    );
    if (!res.ok) {
      setError(res.data?.error || 'Generasi gambar gagal. Kredit tidak dipotong bila kegagalan terjadi sebelum pengiriman.');
      refreshBalance();
      setBusy(false);
      setSubmitStartedAt(null);
      return;
    }
    const generation = res.data?.generation || null;
    if (generation) setItems((current) => [generation, ...current.filter((item) => item.id !== generation.id)]);
    const billed = res.data?.credits ?? config?.credits ?? 0;
    if (res.data?.status === 'unknown') {
      setError('Hasil pengiriman tidak pasti dan kredit mungkin sudah terpakai. Jangan ulangi; periksa status di riwayat terlebih dahulu.');
    } else if (res.data?.status === 'completed') {
      setNotice(`Permintaan diterima dan selesai (${formatCredits(billed)} kredit BLEA).`);
    } else {
      setNotice(`Permintaan diterima (${formatCredits(billed)} kredit BLEA). Gambar biasanya selesai dalam beberapa detik hingga satu menit.`);
    }
    refreshBalance();
    setBusy(false);
    setSubmitStartedAt(null);
  }

  const price = studioMode ? 0 : (active && Number.isSafeInteger(active.credits) ? active.credits : null);
  const ready = studioMode ? (Boolean(studioConfig?.ready) && Boolean(active)) : (active?.ready === true && price !== null);
  const insufficient = price !== null && balance !== null && balance < price;
  const missingRequiredImage = requiresImageInput && sourceImages.length === 0;
  const headerSub = active
    ? (requiresImageInput ? 'Dari gambar + teks' : maxInputImages > 0 ? 'Dari teks / gambar' : 'Dari teks')
    : 'Dari teks · belum ada model yang diaktifkan admin';

  const wxhSuggestions = [...new Set([
    active?.params?.defaultSize,
    ...(isWan26InterleaveImage && sourceImages.length > 0 ? ['1K', '2K'] : []),
    ...(active?.params?.minSide && active.params.minSide >= 1280 ? ['1280*1280', '1440*1440', '1440*1080', '1080*1440'] : ['2048*2048', '1664*928', '1472*1104', '1328*1328', '1280*1280', '1024*1024', '1104*1472', '928*1664']),
  ].filter(Boolean))];

  const sizeHintText = active?.params?.sizeHint
    ? `Format ${active.params.sizeHint}`
    : active?.params?.minSide && active?.params?.maxSide
      ? `Format LEBAR*TINGGI · sisi ${active.params.minSide}–${active.params.maxSide} piksel`
      : 'Format LEBAR*TINGGI';

  return <div className="generate-card">
    <div className="generate-card-head">
      <div>
        <h2 className="generate-card-title">Generate gambar</h2>
        <p className="generate-card-sub">{headerSub}</p>
      </div>
    </div>

    {loading && <p className="generate-hint" role="status">Memuat konfigurasi provider…</p>}
    {!loading && models.length === 0 && studioMode && <div className="generate-banner" role="status"><span>Ruang gambar Studio memakai model OpenAI. Muat ulang bila daftar model kosong, atau tambahkan akun di Studio → Akun OpenAI.</span><Link className="generate-banner-link" to="/studio/openai-accounts">Kelola akun</Link></div>}
    {!loading && models.length === 0 && !studioMode && <div className="generate-banner" role="status"><span>Belum ada model gambar yang diaktifkan admin. Minta admin membuka Katalog Model dan menetapkannya.</span></div>}
    {studioMode && !studioConfig?.ready && <div className="generate-banner" role="status"><span>{studioConfig?.hint || 'Pool akun OpenAI belum siap, jadi gambar belum bisa dikirim. Tidak ada kredit yang dipotong.'}</span><Link className="generate-banner-link" to="/studio/openai-accounts">Kelola akun</Link></div>}
    {!loading && Array.isArray(config?.alibaba_unpriced) && config.alibaba_unpriced.length > 0 && <div className="generate-banner" role="status"><span>{config.alibaba_unpriced.length} model gambar Alibaba sudah aktif di Katalog Model tetapi belum punya harga kredit BLEA, sehingga belum tampil di daftar ini ({config.alibaba_unpriced.slice(0, 3).map((m) => m.model).join(', ')}{config.alibaba_unpriced.length > 3 ? ', …' : ''}).</span><Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur harga kredit</Link></div>}
    {!loading && active && !ready && active.provider === 'freebeat' && <div className="generate-banner" role="status"><span>Provider gambar belum dihubungkan oleh admin, jadi generasi belum dapat dikirim. Tidak ada kredit yang dipotong.</span></div>}
    {!loading && active && !ready && active.provider === 'alibaba' && <div className="generate-banner" role="status"><span>{active.credits == null || price === null ? 'Harga kredit untuk model ini belum diatur admin. Buka Admin → API Key → Katalog Model untuk mengisinya.' : 'Belum ada akun Alibaba Cloud yang terhubung di pool admin, jadi generasi belum dapat dikirim.'}</span><Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur di admin</Link></div>}
    {!loading && active && ready && price === null && <div className="generate-banner" role="status"><span>Harga kredit untuk model ini belum diatur admin. Buka Admin → API Key → Katalog Model untuk mengisinya.</span><Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur harga</Link></div>}
    {error && <div className="generate-banner is-error" role="alert">{error}</div>}
    {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
    {insufficient && ready && <div className="generate-banner" role="status"><span>Saldo kredit BLEA Anda kurang dari {formatCredits(price)} kredit. Saldo ada di pojok kanan atas.</span><Link className="generate-banner-link" to="/credits">Tambah kredit</Link></div>}

    {studioGeneration && studioGeneration.media_url && (
      <div className="generate-studio-result">
        <img src={studioGeneration.media_url} alt={studioGeneration.prompt || 'Hasil gambar OpenAI'} />
        <div className="generate-studio-result-meta">
          <b>{studioGeneration.model || 'gpt-image-1'}</b>
          <small>Akun: {studioGeneration.openai_account_label || 'pool OpenAI'} · tanpa potongan kredit BLEA</small>
          <a href={studioGeneration.media_url} download={`blea-studio-${String(studioGeneration.id || '').slice(0, 8)}.png`}>Unduh gambar</a>
        </div>
      </div>
    )}

    <form className="generate-form" onSubmit={submit}>
      {models.length > 0 && <div className="generate-field">
        <div className="generate-label-row">
          <span className="generate-label">Model gambar</span>
          <span className="generate-hint">{models.length} model</span>
        </div>
        <ModelSelect
          ariaLabel="Model gambar"
          value={active ? `${active.provider}:${active.model}` : ''}
          options={models.map((model) => {
            const badge = formatProviderBadge(model.provider);
            const displayName = formatModelDisplayName(model.name, model.provider);
            const creditLabel = studioMode
              ? 'kuota akun OpenAI'
              : (Number.isSafeInteger(model.credits) ? `${formatCredits(model.credits)} kredit` : 'Belum bertarif');
            return {
              value: `${model.provider}:${model.model}`,
              badge,
              label: displayName,
              meta: creditLabel,
              tone: Number.isSafeInteger(model.credits) ? 'accent' : 'warn',
              nativeLabel: `[${badge}] ${displayName}${Number.isSafeInteger(model.credits) ? ` · ${creditLabel}` : ' · harga belum diatur'}`,
            };
          })}
          onChange={(nextValue) => {
            const next = models.find((model) => `${model.provider}:${model.model}` === nextValue);
            setSelected(nextValue);
            setError('');
            setNotice('');
            const nextSize = next?.params?.defaultSize || '';
            setSize(nextSize);
            setCount(1);
            const nextMaxImgs = Number(next?.params?.maxInputImages) || 0;
            setSourceImages((current) => (nextMaxImgs > 0 ? current.slice(0, nextMaxImgs) : []));
          }}
        />
      </div>}
      {active?.params && (active.params.sizeMode === 'wxh' || active.params.sizes?.length > 0) && <div className="generate-params-row">
        <label className="generate-field">
          <span className="generate-label">Ukuran</span>
          {active.params.sizeMode === 'wxh'
            ? <>
                <input className="generate-select generate-size-input" type="text" list="alibaba-size-suggest" value={size} onChange={(event) => { setSize(event.target.value); setNotice(''); }} placeholder={active.params.defaultSize} aria-label="Ukuran gambar (lebar*tinggi)" />
                <datalist id="alibaba-size-suggest">
                  {wxhSuggestions.map((option) => <option key={option} value={option} />)}
                </datalist>
                <span className="generate-hint">{sizeHintText}</span>
              </>
            : <select className="generate-select" value={size} onChange={(event) => { setSize(event.target.value); setNotice(''); }}>
                {active.params.sizes.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>}
        </label>
        <label className="generate-field">
          <span className="generate-label">Jumlah gambar</span>
          <select className="generate-select" value={String(Math.min(count, effectiveMaxN))} onChange={(event) => { setCount(Number(event.target.value)); setNotice(''); }}>
            {Array.from({ length: effectiveMaxN }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      </div>}
      {maxInputImages > 0 && <div className="generate-field">
        <span className="generate-label">Gambar sumber {requiresImageInput ? '(wajib)' : `(opsional, maks ${maxInputImages})`}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" multiple={maxInputImages > 1} disabled={busy || uploading || sourceImages.length >= maxInputImages} onChange={handleImageFiles} aria-label="Unggah gambar sumber" />
        {uploading && <span className="generate-hint">Mengunggah gambar sumber…</span>}
        {sourceImages.length > 0 && <div className="history-grid">
          {sourceImages.map((url, idx) => <div key={`${url}-${idx}`} className="history-card">
            <img src={url} alt={`Gambar sumber ${idx + 1}`} />
            <div className="history-card-body">
              <button type="button" className="generate-secondary-btn" onClick={() => setSourceImages((current) => current.filter((_, itemIdx) => itemIdx !== idx))}>Hapus</button>
            </div>
          </div>)}
        </div>}
      </div>}
      <label className="generate-field">
        <div className="generate-label-row">
          <span className="generate-label">Prompt gambar</span>
          <span className="generate-hint">{prompt.trim().length}/{maxPromptChars}</span>
        </div>
        <textarea className="generate-textarea" rows={4} maxLength={maxPromptChars} value={prompt} placeholder="Contoh: potret studio seekor kucing hitam, cahaya lembut, latar abu-abu" onChange={(event) => { setPrompt(event.target.value); setNotice(''); }} />
      </label>
      <div className="generate-actions">
        <button className="generate-submit-btn" type="submit" disabled={busy || uploading || !ready || insufficient || missingRequiredImage || !prompt.trim()}>
          {(busy || uploading) && <span className="generate-btn-spinner" aria-hidden="true" />}
          {busy ? 'Mengirim…' : 'Buat gambar'}
        </button>
        <button className="generate-secondary-btn" type="button" disabled={busy || loading} onClick={load}>Perbarui</button>
      </div>
    </form>

    {(busy || items.some(isPending)) && (() => {
      const pendingItem = items.find(isPending);
      const stageStatus = busy ? 'Mengirim ke Studio AI…' : (STATUS_LABEL[pendingItem?.status] || 'Sedang diproses');
      const stageModel = formatModelDisplayName(pendingItem?.model || active?.name || 'AI Image', active?.provider);
      const stagePrompt = (pendingItem?.prompt || prompt || '').trim();
      const stageStartedAt = busy ? submitStartedAt : (pendingItem?.created_at || null);
      const stageRuntime = stageStartedAt ? formatElapsedRuntime(stageStartedAt, liveNowMs) : '00:00';
      return (
        <div className="generate-img-live-stage" role="status" aria-live="polite">
          <div className="generate-aurora" aria-hidden="true" />
          <div className="generate-scanbeam" aria-hidden="true" />
          <div className="generate-img-reticle" aria-hidden="true">
            <span /><span /><span /><span />
          </div>
          <div className="generate-orbit is-image" aria-hidden="true">
            <span className="generate-orbit-ring" />
            <span className="generate-orbit-ring is-inner" />
            <span className="generate-img-core">
              <Sparkles size={18} />
            </span>
          </div>
          <span className="generate-loader-badge">
            <span className="generate-pulse-dot" aria-hidden="true" />
            {stageStatus}
          </span>
          <div className="generate-eq" aria-hidden="true">
            <i /><i /><i /><i /><i />
          </div>
          <div className="generate-progress-wrap">
            <div className="generate-progress-bar">
              <div className="generate-progress-fill is-animated" style={{ width: busy ? '38%' : '72%' }} />
            </div>
            <span className="generate-loader-sub">
              {stageModel} · Berjalan {stageRuntime} · Merender komposisi &amp; pencahayaan AI…
            </span>
            <Link className="generate-banner-link" style={{ alignSelf: 'center', marginTop: 4 }} to="/live">
              Pantau di Proses Live
            </Link>
          </div>
          {stagePrompt && (
            <p className="generate-img-live-prompt">{stagePrompt}</p>
          )}
        </div>
      );
    })()}

    {items.length > 0 && <div className="generate-history">
      <h3 className="generate-card-title">Riwayat gambar</h3>
      <div className="history-grid">
        {items.slice(0, 12).map((item) => {
          const allUrls = Array.isArray(item.image_urls) && item.image_urls.length > 0
            ? item.image_urls
            : (item.image_url ? [item.image_url] : []);
          const isLoadingItem = item.status === 'queued' || item.status === 'processing' || item.status === 'submitted';
          return <article className="history-card" key={item.id}>
            {item.status === 'completed' && allUrls[0] ? (
              <img src={allUrls[0]} alt={item.prompt || 'Hasil generasi gambar'} loading="lazy" />
            ) : isLoadingItem ? (
              <div className="history-preview generate-img-loader" role="status" aria-live="polite">
                <div className="generate-aurora is-subtle" aria-hidden="true" />
                <div className="generate-scanbeam" aria-hidden="true" />
                <div className="generate-orbit is-compact" aria-hidden="true">
                  <span className="generate-orbit-ring" />
                  <span className="generate-orbit-ring is-inner" />
                  <Sparkles size={13} className="generate-img-core-icon" />
                </div>
                <span className="generate-loader-badge">
                  <span className="generate-pulse-dot" aria-hidden="true" />
                  {STATUS_LABEL[item.status] || 'Memproses…'}
                </span>
                <span className="generate-img-loader-sub">Berjalan {formatElapsedRuntime(item.created_at, liveNowMs)} · Merender gambar AI…</span>
              </div>
            ) : (
              <div className="history-preview">{STATUS_LABEL[item.status] || item.status}</div>
            )}
            <div className="history-card-body">
              <span className={`history-status status-${item.status}`}>
                {STATUS_LABEL[item.status] || item.status}
                {isLoadingItem ? ` · ${formatElapsedRuntime(item.created_at, liveNowMs)}` : ''}
              </span>
              <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
              <p className="history-meta">{item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · model {item.model} · {formatCredits(item.credits_charged)} kredit{item.credits_refunded > 0 ? ` · ${formatCredits(item.credits_refunded)} dikembalikan` : ''}</p>
              {item.error_message && <p className="history-error-text">{item.error_message}</p>}
              {item.status === 'unknown' && <p className="history-error-text">Jangan ulangi sebelum statusnya jelas; kredit mungkin sudah terpakai.</p>}
              {item.status === 'completed' && allUrls.length > 0 && <div className="history-card-actions">
                {allUrls.map((url, idx) => {
                  const downloadHref = withDownloadParam(
                    (Array.isArray(item.download_urls) && item.download_urls[idx])
                    || (idx === 0 ? item.download_url : '')
                    || url,
                  );
                  return (
                    <div className="history-action-pair" key={`${item.id}-${idx}`}>
                      <a
                        className="history-download-btn"
                        href={downloadHref}
                        download={buildDownloadFilename({ kind: 'image', id: item.id, index: idx, total: allUrls.length, url })}
                      >
                        <Download size={14} aria-hidden="true" />
                        {allUrls.length > 1 ? `Unduh gambar #${idx + 1}` : 'Unduh gambar'}
                      </a>
                      <a href={url} target="_blank" rel="noopener noreferrer">{allUrls.length > 1 ? `Buka gambar #${idx + 1}` : 'Buka gambar'}</a>
                    </div>
                  );
                })}
              </div>}
            </div>
          </article>;
        })}
      </div>
      <p className="generate-hint">Riwayat lengkap tersedia di <Link to="/history">halaman History</Link>.</p>
    </div>}
  </div>;
}
