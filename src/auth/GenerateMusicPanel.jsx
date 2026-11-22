import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Disc3, Download, Music } from 'lucide-react';
import {
  buildDownloadFilename,
  fetchMusicConfig,
  fetchMusicHistory,
  fetchMusicStatus,
  generateMusic,
  withDownloadParam,
} from '../api/generation';
import { useAuth } from './AuthProvider';
import { useCredits } from '../lib/useCredits';
import { formatCredits, formatModelDisplayName, formatProviderBadge } from '../lib/formatCredits';
import { formatElapsedRuntime, useNowTick } from '../lib/formatRuntime';
import { ModelSelect } from './ModelSelect';
import './generate.css';
import './history.css';

const MUSIC_PROMPT_CHIPS = [
  {
    label: 'Synthwave Sunset',
    text: 'Upbeat synthwave sunset anthem with warm analog synths, punchy retro snare, and driving bassline.',
  },
  {
    label: 'Akustik Indie',
    text: 'Warm Indonesian indie folk acoustic guitar ballad with soft brushed drums, gentle strings, and heartfelt melody.',
  },
  {
    label: 'Lo-Fi Chill',
    text: 'Relaxing late-night lo-fi chillhop beat with dusty vinyl crackle, electric Rhodes chords, and mellow bass.',
  },
  {
    label: 'Orkestra Epik',
    text: 'Cinematic orchestral trailer score with soaring strings, brass swells, taiko drums, and dramatic choir.',
  },
];

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

function formatTrackDuration(ms) {
  const num = Number(ms);
  if (!Number.isFinite(num) || num <= 0) return '';
  const totalSec = Math.round(num / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function GenerateMusicPanel({ initialPrompt = '' }) {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const userId = user?.id;
  const { balance, refresh: refreshBalance } = useCredits(userId);
  const [config, setConfig] = useState(null);
  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [instrumental, setInstrumental] = useState(false);
  const [lyrics, setLyrics] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitStartedAt, setSubmitStartedAt] = useState(null);
  const pollVersion = useRef(0);

  const hasActiveMusicJobs = busy || items.some(isPending);
  const liveNowMs = useNowTick(hasActiveMusicJobs, 1000);

  const load = useCallback(async () => {
    setLoading(true);
    const [configRes, historyRes] = await Promise.all([fetchMusicConfig(), fetchMusicHistory()]);
    if (configRes.ok) setConfig(configRes.data);
    if (historyRes.ok && Array.isArray(historyRes.data?.generations)) setItems(historyRes.data.generations);
    refreshBalance();
    setLoading(false);
  }, [refreshBalance]);

  useEffect(() => { load(); }, [load]);

  const models = Array.isArray(config?.models) ? config.models : [];
  const active = models.find((m) => `${m.provider}:${m.model}` === selected)
    || models.find((m) => m.ready)
    || models[0]
    || null;

  useEffect(() => {
    if (!active) return;
    if (selected !== `${active.provider}:${active.model}`) {
      setSelected(`${active.provider}:${active.model}`);
    }
    if (active.supports_instrumental === false && instrumental) {
      setInstrumental(false);
    }
    if (active.supports_lyrics === false && lyrics) {
      setLyrics('');
    }
    if (!active.supports_duration && durationSeconds !== '') {
      setDurationSeconds('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.provider, active?.model]);

  useEffect(() => {
    const pending = items.filter((item) => isPending(item) && item.canPoll).slice(0, 4);
    if (!pending.length) return undefined;
    const version = ++pollVersion.current;
    const timer = setInterval(async () => {
      const results = await Promise.all(pending.map((item) => fetchMusicStatus(item.id)));
      if (version !== pollVersion.current) return;
      const updates = new Map(
        results
          .filter((res) => res.ok && res.data?.generation)
          .map((res) => [res.data.generation.id, res.data.generation]),
      );
      if (!updates.size) return;
      setItems((current) => current.map((item) => updates.get(item.id) || item));
      if ([...updates.values()].some((item) => !isPending(item))) refreshBalance();
    }, 10000);
    return () => { clearInterval(timer); };
  }, [items, refreshBalance]);

  async function submit(event) {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    const cleanLyrics = lyrics.trim();
    if (busy || !active || !cleanPrompt) return;
    if (instrumental && cleanLyrics) {
      setError('Nonaktifkan mode instrumental jika ingin mengisi lirik lagu.');
      return;
    }
    if (active.requires_lyrics && !cleanLyrics) {
      setError(`Model ${active.name || active.model} mewajibkan lirik lagu.`);
      return;
    }
    let cleanDuration;
    if (active.supports_duration && String(durationSeconds).trim() !== '') {
      const parsed = Number(String(durationSeconds).trim());
      if (!Number.isFinite(parsed) || parsed < 10 || parsed > 300) {
        setError('Durasi lagu harus antara 10 hingga 300 detik.');
        return;
      }
      cleanDuration = parsed;
    }

    setBusy(true);
    setError('');
    setNotice('');
    setSubmitStartedAt(Date.now());
    const res = await generateMusic({
      provider: active.provider,
      model: active.model,
      prompt: cleanPrompt,
      ...(instrumental ? { instrumental: true } : {}),
      ...(!instrumental && cleanLyrics ? { lyrics: cleanLyrics } : {}),
      ...(cleanDuration !== undefined ? { duration_seconds: cleanDuration } : {}),
    });

    if (!res.ok) {
      setError(res.data?.error || 'Generasi musik gagal. Kredit tidak dipotong bila kegagalan terjadi sebelum pengiriman.');
      refreshBalance();
      setBusy(false);
      setSubmitStartedAt(null);
      return;
    }
    const generation = res.data?.generation || null;
    if (generation) {
      setItems((current) => [generation, ...current.filter((item) => item.id !== generation.id)]);
    }
    const billed = res.data?.credits ?? active.credits ?? 0;
    if (res.data?.status === 'unknown') {
      setError('Hasil pengiriman tidak pasti dan kredit mungkin sudah terpakai. Jangan ulangi; periksa status di riwayat terlebih dahulu.');
    } else {
      setNotice(`Permintaan musik diterima (${formatCredits(billed)} kredit BLEA). Musik sedang dibuat dan akan tampil otomatis saat selesai.`);
    }
    refreshBalance();
    setBusy(false);
    setSubmitStartedAt(null);
  }

  const price = active && Number.isSafeInteger(active.credits) ? active.credits : null;
  const ready = active?.ready === true && price !== null;
  const insufficient = price !== null && balance !== null && balance < price;
  const missingRequiredLyrics = Boolean(active?.requires_lyrics && !lyrics.trim());

  return (
    <div className="generate-card">
      <div className="generate-card-head">
        <div>
          <h2 className="generate-card-title">Generate musik</h2>
          <p className="generate-card-sub">Dari teks, gaya musik, atau lirik</p>
        </div>
      </div>

      {loading && <p className="generate-hint" role="status">Memuat konfigurasi musik…</p>}

      {!loading && models.length === 0 && (
        <div className="generate-banner" role="status">
          <span>Belum ada model musik yang diaktifkan &amp; diberi harga kredit oleh admin.</span>
          {isAdmin && <Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur di Katalog Model</Link>}
        </div>
      )}

      {!loading && isAdmin && Array.isArray(config?.freebeat_unpriced) && config.freebeat_unpriced.length > 0 && (
        <div className="generate-banner" role="status">
          <span>
            {config.freebeat_unpriced.length} model musik Freebeat sudah aktif di Katalog Model tetapi belum punya harga kredit BLEA, sehingga belum tampil di daftar konsumen ({config.freebeat_unpriced.slice(0, 3).map((m) => m.name || m.model).join(', ')}{config.freebeat_unpriced.length > 3 ? ', …' : ''}).
          </span>
          <Link className="generate-banner-link" to="/admin?tab=api-keys&sub=catalog">Atur harga kredit</Link>
        </div>
      )}

      {!loading && active && !config?.provider_ready && (
        <div className="generate-banner" role="status">
          <span>Provider musik belum dihubungkan oleh admin di Pool Freebeat OAuth, jadi generasi belum dapat dikirim. Tidak ada kredit yang dipotong.</span>
          {isAdmin && <Link className="generate-banner-link" to="/admin?tab=freebeat-oauth">Kelola Pool OAuth</Link>}
        </div>
      )}

      {error && <div className="generate-banner is-error" role="alert">{error}</div>}
      {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
      {insufficient && ready && (
        <div className="generate-banner" role="status">
          <span>Saldo kredit BLEA Anda kurang dari {formatCredits(price)} kredit. Saldo ada di pojok kanan atas.</span>
          <Link className="generate-banner-link" to="/credits">Tambah kredit</Link>
        </div>
      )}

      <form onSubmit={submit}>
        {models.length > 0 && (
          <div className="generate-field">
            <div className="generate-label-row">
              <span className="generate-label">Model musik</span>
              <span className="generate-hint">{models.length} model</span>
            </div>
            <ModelSelect
              ariaLabel="Model musik"
              value={active ? `${active.provider}:${active.model}` : ''}
              options={models.map((model) => {
                const badge = formatProviderBadge(model.provider);
                const displayName = formatModelDisplayName(model.name, model.provider);
                const creditLabel = Number.isSafeInteger(model.credits) ? `${formatCredits(model.credits)} kredit` : 'Belum bertarif';
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
                setSelected(nextValue);
                setError('');
                setNotice('');
              }}
            />
          </div>
        )}

        <div className="generate-field">
          <div className="generate-label-row">
            <span className="generate-label">Inspirasi genre</span>
            <span className="generate-hint">Klik untuk mengisi prompt</span>
          </div>
          <div className="generate-chips">
            {MUSIC_PROMPT_CHIPS.map((chip) => (
              <button
                key={chip.label}
                type="button"
                className="generate-chip"
                onClick={() => { setPrompt(chip.text); setNotice(''); }}
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>

        <label className="generate-field">
          <div className="generate-label-row">
            <span className="generate-label">Prompt musik</span>
            <span className="generate-hint">{prompt.trim().length}/2000</span>
          </div>
          <textarea
            className="generate-textarea"
            rows={3}
            maxLength={2000}
            value={prompt}
            placeholder="Contoh: lagu pop upbeat bertempo cepat dengan vokal hangat, synth modern, dan beat drum renyah"
            onChange={(event) => { setPrompt(event.target.value); setNotice(''); }}
          />
        </label>

        {active?.supports_instrumental !== false && (
          <label className="generate-toggle" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={instrumental}
              disabled={busy || active?.requires_lyrics}
              onChange={(event) => {
                const checked = event.target.checked;
                setInstrumental(checked);
                if (checked) setLyrics('');
                setError('');
                setNotice('');
              }}
            />
            <span>Instrumental (tanpa vokal)</span>
          </label>
        )}

        {active?.supports_lyrics !== false && (
          <label className="generate-field" style={{ marginTop: 10 }}>
            <div className="generate-label-row">
              <span className="generate-label">
                Lirik lagu {active?.requires_lyrics ? '(wajib)' : '(opsional)'}
              </span>
              <span className="generate-hint">
                {instrumental ? 'Nonaktif saat mode instrumental' : `${lyrics.trim().length}/12000`}
              </span>
            </div>
            <textarea
              className="generate-textarea"
              rows={4}
              maxLength={12000}
              value={lyrics}
              disabled={busy || instrumental}
              placeholder={instrumental ? 'Mode instrumental aktif (tanpa vokal/lirik)' : '[Verse 1]\nDi bawah langit senja kota...\n\n[Chorus]\nMelangkah jauh menuju bintang...'}
              onChange={(event) => { setLyrics(event.target.value); setNotice(''); }}
            />
          </label>
        )}

        {active?.supports_duration && (
          <label className="generate-field" style={{ marginTop: 10 }}>
            <div className="generate-label-row">
              <span className="generate-label">Target durasi (opsional, 10–300 detik)</span>
            </div>
            <input
              type="number"
              min={10}
              max={300}
              step={1}
              className="generate-select"
              value={durationSeconds}
              disabled={busy}
              placeholder="Kosongkan untuk durasi bawaan model"
              onChange={(event) => { setDurationSeconds(event.target.value); setNotice(''); }}
            />
          </label>
        )}

        <div className="generate-actions" style={{ marginTop: 12 }}>
          <button
            className="generate-submit-btn"
            type="submit"
            disabled={busy || !ready || insufficient || missingRequiredLyrics || !prompt.trim()}
          >
            {busy && <span className="generate-btn-spinner" aria-hidden="true" />}
            {busy ? 'Mengirim…' : 'Buat musik'}
          </button>
          <button className="generate-secondary-btn" type="button" disabled={busy || loading} onClick={load}>
            Perbarui
          </button>
        </div>
      </form>

      {(busy || items.some(isPending)) && (() => {
        const pendingItem = items.find(isPending);
        const stageStatus = busy ? 'Mengirim ke Studio Musik AI…' : (STATUS_LABEL[pendingItem?.status] || 'Sedang diproses');
        const stageModel = formatModelDisplayName(pendingItem?.model_name || active?.name || 'Musik AI', 'freebeat');
        const stagePrompt = (pendingItem?.prompt || prompt || '').trim();
        const stageStartedAt = busy ? submitStartedAt : (pendingItem?.created_at || null);
        const stageRuntime = stageStartedAt ? formatElapsedRuntime(stageStartedAt, liveNowMs) : '00:00';
        return (
          <div className="generate-img-live-stage" role="status" aria-live="polite">
            <div className="generate-aurora" aria-hidden="true" />
            <div className="generate-scanbeam" aria-hidden="true" />
            <div className="generate-orbit is-image" aria-hidden="true">
              <span className="generate-orbit-ring" />
              <span className="generate-orbit-ring is-inner" />
              <span className="generate-img-core">
                <Music size={18} />
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
                <div className="generate-progress-fill is-animated" style={{ width: busy ? '34%' : '70%' }} />
              </div>
              <span className="generate-loader-sub">
                {stageModel} · Berjalan {stageRuntime} · Menyusun aransemen &amp; vokal…
              </span>
              <Link className="generate-banner-link" style={{ alignSelf: 'center', marginTop: 4 }} to="/live">
                Pantau di Proses Live
              </Link>
            </div>
            {stagePrompt && <p className="generate-img-live-prompt">{stagePrompt}</p>}
          </div>
        );
      })()}

      {items.length > 0 && (
        <div className="generate-history">
          <h3 className="generate-card-title">Riwayat musik</h3>
          <div className="history-grid">
            {items.slice(0, 12).map((item) => {
              const audioStreams = Array.isArray(item.audio_stream_urls) && item.audio_stream_urls.length > 0
                ? item.audio_stream_urls
                : (item.audio_stream_url ? [item.audio_stream_url] : []);
              const audioDownloads = Array.isArray(item.download_urls) && item.download_urls.length > 0
                ? item.download_urls
                : (item.download_url ? [item.download_url] : audioStreams);
              const isLoadingItem = isPending(item);
              const trackDuration = formatTrackDuration(item.duration_ms);
              return (
                <article className="history-card" key={item.id}>
                  {item.status === 'completed' ? (
                    item.cover_stream_url ? (
                      <img src={item.cover_stream_url} alt={item.title || item.prompt || 'Cover musik'} loading="lazy" />
                    ) : (
                      <div className="history-preview is-music-cover" aria-hidden="true">
                        <Disc3 size={34} />
                      </div>
                    )
                  ) : isLoadingItem ? (
                    <div className="history-preview generate-img-loader" role="status" aria-live="polite">
                      <div className="generate-aurora is-subtle" aria-hidden="true" />
                      <div className="generate-scanbeam" aria-hidden="true" />
                      <div className="generate-orbit is-compact" aria-hidden="true">
                        <span className="generate-orbit-ring" />
                        <span className="generate-orbit-ring is-inner" />
                        <Music size={13} className="generate-img-core-icon" />
                      </div>
                      <span className="generate-loader-badge">
                        <span className="generate-pulse-dot" aria-hidden="true" />
                        {STATUS_LABEL[item.status] || 'Memproses…'}
                      </span>
                      <span className="generate-img-loader-sub">Berjalan {formatElapsedRuntime(item.created_at, liveNowMs)} · Merender musik AI…</span>
                    </div>
                  ) : (
                    <div className="history-preview">{STATUS_LABEL[item.status] || item.status}</div>
                  )}
                  <div className="history-card-body">
                    <span className={`history-status status-${item.status}`}>
                      {STATUS_LABEL[item.status] || item.status}
                      {isLoadingItem ? ` · ${formatElapsedRuntime(item.created_at, liveNowMs)}` : ''}
                    </span>
                    {item.title && <h4 className="history-music-title">{item.title}</h4>}
                    <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
                    <p className="history-meta">
                      {item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · {item.model_name || `model ${item.model}`}
                      {trackDuration ? ` · ${trackDuration}` : ''}
                      {item.instrumental ? ' · Instrumental' : ''}
                      {` · ${formatCredits(item.credits_charged)} kredit`}
                      {item.credits_refunded > 0 ? ` · ${formatCredits(item.credits_refunded)} dikembalikan` : ''}
                    </p>
                    {item.error_message && <p className="history-error-text">{item.error_message}</p>}
                    {item.status === 'unknown' && (
                      <p className="history-error-text">Jangan ulangi sebelum statusnya jelas; kredit mungkin sudah terpakai.</p>
                    )}
                    {item.status === 'completed' && audioStreams.length > 0 && (
                      <div className="history-music-players">
                        {audioStreams.map((streamUrl, idx) => {
                          const downloadHref = withDownloadParam(audioDownloads[idx] || streamUrl);
                          return (
                            <div className="history-music-track" key={`${item.id}-track-${idx}`}>
                              <audio controls preload="none" src={streamUrl} aria-label={item.title || `Audio ${idx + 1}`} />
                              <div className="history-card-actions">
                                <a
                                  className="history-download-btn"
                                  href={downloadHref}
                                  download={buildDownloadFilename({ kind: 'music', id: item.id, index: idx, total: audioStreams.length, url: downloadHref })}
                                >
                                  <Download size={14} aria-hidden="true" />
                                  {audioStreams.length > 1 ? `Unduh audio #${idx + 1}` : 'Unduh audio'}
                                </a>
                                <a href={streamUrl} target="_blank" rel="noopener noreferrer">
                                  {audioStreams.length > 1 ? `Buka audio #${idx + 1}` : 'Buka audio'}
                                </a>
                                {idx === 0 && item.cover_download_url && (
                                  <a
                                    href={withDownloadParam(item.cover_download_url)}
                                    download={buildDownloadFilename({ kind: 'music_cover', id: item.id, url: item.cover_download_url })}
                                  >
                                    Unduh cover
                                  </a>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
          <p className="generate-hint">Riwayat lengkap tersedia di <Link to="/history">halaman History</Link>.</p>
        </div>
      )}
    </div>
  );
}
