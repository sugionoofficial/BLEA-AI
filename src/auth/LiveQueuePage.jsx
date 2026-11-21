import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Clock,
  Film,
  Image as ImageIcon,
  RefreshCw,
  ShieldAlert,
  UserRound,
  XCircle,
} from 'lucide-react';
import { cancelAdminGeneration, fetchLiveGenerations } from '../api/generation';
import { DropXLayout } from '../dropx/DropXLayout';
import { formatCredits, formatModelDisplayName, formatProviderBadge } from '../lib/formatCredits';
import { formatElapsedHuman, formatElapsedRuntime, useNowTick } from '../lib/formatRuntime';
import { maskEmailAfter4 } from '../lib/liveQueue';
import { useCredits } from '../lib/useCredits';
import { useAuth } from './AuthProvider';
import './live.css';

const STATUS_LABELS = {
  queued: 'Dalam Antrean',
  in_progress: 'Sedang Diproses',
  processing: 'Sedang Diproses',
  unknown: 'Status Tidak Pasti',
  cancelled: 'Dibatalkan',
};

function getOwnerInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'BL';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

function formatShortTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function LiveQueuePage() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const { refresh: refreshBalance } = useCredits(user?.id);
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({ total: 0, video: 0, image: 0, own: 0, stalled: 0 });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('all');
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [confirmKey, setConfirmKey] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [cancellingKey, setCancellingKey] = useState('');
  const didInitialLoad = useRef(false);

  const loadLive = useCallback(async ({ poll = true, background = false } = {}) => {
    if (!user?.id) return;
    if (!background) setLoading(true);
    setSyncing(true);
    if (!background) setError('');
    try {
      const res = await fetchLiveGenerations({ poll });
      if (!res.ok) {
        if (!background || items.length === 0) {
          setError(res.data?.error || 'Daftar proses live tidak dapat dimuat.');
        }
        return;
      }
      const nextItems = Array.isArray(res.data?.items) ? res.data.items : [];
      const nextCounts = res.data?.counts || {
        total: nextItems.length,
        video: nextItems.filter((item) => item.kind === 'video').length,
        image: nextItems.filter((item) => item.kind === 'image').length,
        own: nextItems.filter((item) => item.is_own).length,
        stalled: nextItems.filter((item) => item.stalled).length,
      };
      if (res.data?.server_time) {
        const srv = Date.parse(res.data.server_time);
        if (Number.isFinite(srv)) setServerOffsetMs(srv - Date.now());
      }
      setItems(nextItems);
      setCounts(nextCounts);
      setLastSyncedAt(new Date());
      setError('');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [user?.id, items.length]);

  useEffect(() => {
    if (!user?.id || didInitialLoad.current) return;
    didInitialLoad.current = true;
    loadLive({ poll: true, background: false });
  }, [user?.id, loadLive]);

  const pollIntervalMs = items.length > 0 ? 8000 : 15000;
  useEffect(() => {
    if (!user?.id) return undefined;
    const timer = setInterval(() => {
      loadLive({ poll: true, background: true });
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [user?.id, pollIntervalMs, loadLive]);

  const clientNowMs = useNowTick(true, 1000);
  const effectiveNowMs = clientNowMs + serverOffsetMs;

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filter === 'own') return item.is_own;
      if (filter === 'video') return item.kind === 'video';
      if (filter === 'image') return item.kind === 'image';
      if (filter === 'stalled') return item.stalled;
      return true;
    });
  }, [items, filter]);

  async function handleConfirmCancel(item) {
    if (!isAdmin || cancellingKey) return;
    const key = `${item.kind}:${item.id}`;
    setCancellingKey(key);
    setError('');
    setNotice('');
    try {
      const res = await cancelAdminGeneration({
        id: item.id,
        kind: item.kind,
        reason: cancelReason.trim(),
      });
      if (!res.ok) {
        setError(res.data?.error || 'Pembatalan proses gagal.');
        return;
      }
      const refunded = Number(res.data?.refunded || 0);
      setItems((prev) => prev.filter((row) => !(row.id === item.id && row.kind === item.kind)));
      setCounts((prev) => ({
        ...prev,
        total: Math.max(0, prev.total - 1),
        [item.kind]: Math.max(0, (prev[item.kind] || 0) - 1),
        own: item.is_own ? Math.max(0, prev.own - 1) : prev.own,
        stalled: item.stalled ? Math.max(0, prev.stalled - 1) : prev.stalled,
      }));
      setConfirmKey('');
      setCancelReason('');
      setNotice(
        refunded > 0
          ? `Proses dibatalkan. ${formatCredits(refunded)} kredit BLEA telah dikembalikan ke pengguna.`
          : 'Proses berhasil dibatalkan.',
      );
      if (item.is_own || refunded > 0) refreshBalance();
    } finally {
      setCancellingKey('');
    }
  }

  return (
    <DropXLayout
      title="Proses Live"
      description="Pantau antrean dan proses generasi video maupun gambar yang sedang berjalan secara langsung."
    >
      <div className="live-page">
        <div className="live-hero-bar">
          <div className="live-hero-info">
            <div className="live-hero-title-row">
              <span className="live-badge-pulse">
                <span className="live-badge-dot" aria-hidden="true" />
                Live Queue
              </span>
              {isAdmin && (
                <span className="live-pill is-stalled">
                  <ShieldAlert size={12} aria-hidden="true" />
                  Mode Admin · Pembatalan &amp; Refund Aktif
                </span>
              )}
            </div>
            <p className="live-hero-desc">
              {isAdmin
                ? 'Pantau seluruh proses aktif secara real-time dengan nama akun, email tersensor, durasi berjalan, diagnosa hambatan, dan tombol Cancel + Refund otomatis.'
                : 'Semua proses generasi yang sedang berjalan di platform ditampilkan secara live dengan nama akun dan email tersensor; prompt milik pengguna lain disamarkan demi privasi.'}
            </p>
          </div>
          <div className="live-toolbar-actions">
            <button
              type="button"
              className="live-refresh-btn"
              onClick={() => loadLive({ poll: true, background: false })}
              disabled={syncing}
            >
              <RefreshCw size={15} className={`live-refresh-icon ${syncing ? 'is-spinning' : ''}`} aria-hidden="true" />
              {syncing ? 'Menyinkronkan…' : 'Perbarui & Cek Status'}
            </button>
          </div>
        </div>

        <div className="live-stats-row">
          <div className="live-stat-card">
            <div className="live-stat-meta">
              <span className="live-stat-label">Sedang Berjalan</span>
              <span className="live-stat-value">{counts.total}</span>
            </div>
            <span className="live-stat-icon" aria-hidden="true">
              <Activity size={18} />
            </span>
          </div>
          <div className="live-stat-card is-video">
            <div className="live-stat-meta">
              <span className="live-stat-label">Video Aktif</span>
              <span className="live-stat-value">{counts.video}</span>
            </div>
            <span className="live-stat-icon" aria-hidden="true">
              <Film size={18} />
            </span>
          </div>
          <div className="live-stat-card is-image">
            <div className="live-stat-meta">
              <span className="live-stat-label">Gambar Aktif</span>
              <span className="live-stat-value">{counts.image}</span>
            </div>
            <span className="live-stat-icon" aria-hidden="true">
              <ImageIcon size={18} />
            </span>
          </div>
          <div className={`live-stat-card ${counts.stalled > 0 ? 'is-warn' : ''}`}>
            <div className="live-stat-meta">
              <span className="live-stat-label">Perlu Perhatian</span>
              <span className="live-stat-value">{counts.stalled}</span>
            </div>
            <span className="live-stat-icon" aria-hidden="true">
              <AlertTriangle size={18} />
            </span>
          </div>
        </div>

        <div className="live-filters">
          <div className="live-filter-tabs" role="group" aria-label="Saring proses aktif">
            <button type="button" className={`live-filter-tab ${filter === 'all' ? 'is-active' : ''}`} onClick={() => setFilter('all')}>
              Semua ({items.length})
            </button>
            <button type="button" className={`live-filter-tab ${filter === 'own' ? 'is-active' : ''}`} onClick={() => setFilter('own')}>
              Milik Saya ({counts.own})
            </button>
            <button type="button" className={`live-filter-tab ${filter === 'video' ? 'is-active' : ''}`} onClick={() => setFilter('video')}>
              Video ({counts.video})
            </button>
            <button type="button" className={`live-filter-tab ${filter === 'image' ? 'is-active' : ''}`} onClick={() => setFilter('image')}>
              Gambar ({counts.image})
            </button>
            {counts.stalled > 0 && (
              <button type="button" className={`live-filter-tab ${filter === 'stalled' ? 'is-active' : ''}`} onClick={() => setFilter('stalled')}>
                Terindikasi Macet ({counts.stalled})
              </button>
            )}
          </div>
          <span className="live-sync-note">
            {lastSyncedAt
              ? `Terakhir sinkron: ${lastSyncedAt.toLocaleTimeString('id-ID')} · pembaruan otomatis`
              : 'Menyiapkan pemantauan live…'}
          </span>
        </div>

        {error && <div className="live-banner is-error" role="alert">{error}</div>}
        {notice && <div className="live-banner is-success" role="status">{notice}</div>}

        {loading && !items.length ? (
          <div className="live-empty" role="status">
            <Activity size={26} aria-hidden="true" />
            <h2>Memuat proses live…</h2>
            <p>Menyinkronkan status antrean video dan gambar dengan server provider.</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="live-empty">
            <Activity size={28} aria-hidden="true" />
            <h2>Tidak ada proses aktif saat ini</h2>
            <p>
              {filter === 'all'
                ? 'Semua generasi video dan gambar saat ini sudah selesai atau belum ada proses baru yang berjalan.'
                : 'Tidak ada proses aktif yang cocok dengan filter ini.'}
            </p>
            <Link className="live-empty-link" to="/generate">Buka Halaman Generate</Link>
          </div>
        ) : (
          <div className="live-list">
            {filteredItems.map((item) => {
              const itemKey = `${item.kind}:${item.id}`;
              const isConfirming = confirmKey === itemKey;
              const isBusyCancel = cancellingKey === itemKey;
              const providerLabel = formatProviderBadge(item.provider);
              const modelLabel = formatModelDisplayName(item.model, item.provider) || item.model || 'Model AI';
              const elapsedClock = formatElapsedRuntime(item.created_at, effectiveNowMs);
              const elapsedHuman = formatElapsedHuman(item.created_at, effectiveNowMs);
              const canSeeFull = item.is_own || isAdmin;
              const ownerName = item.owner_name || 'Pengguna BLEA';
              const maskedEmail = item.owner_email_masked || (item.user_email ? maskEmailAfter4(item.user_email) : '—');
              const progressPct = item.kind === 'video'
                ? Math.max(8, Math.min(100, Number(item.progress || 15)))
                : (item.status === 'unknown' ? 100 : 65);

              return (
                <article
                  key={itemKey}
                  className={`live-card ${item.is_own ? 'is-own' : ''} ${item.stalled ? 'is-stalled' : ''}`}
                >
                  <div className="live-card-top">
                    <div className="live-card-badges">
                      <span className="live-pill">
                        {item.kind === 'video'
                          ? <Film size={11} aria-hidden="true" />
                          : <ImageIcon size={11} aria-hidden="true" />}
                        {item.kind === 'video' ? 'Video' : 'Gambar'}
                      </span>
                      <span className="live-pill">{providerLabel}</span>
                      <span className="live-pill is-status">
                        <span className="live-badge-dot" aria-hidden="true" />
                        {STATUS_LABELS[item.status] || item.status}
                      </span>
                      {item.stalled && (
                        <span className="live-pill is-stalled">
                          <AlertTriangle size={11} aria-hidden="true" />
                          Macet
                        </span>
                      )}
                    </div>

                    <div
                      className="live-runtime-box"
                      title={`Mulai ${item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'}`}
                    >
                      <Clock size={12} aria-hidden="true" />
                      <span>{elapsedClock}</span>
                    </div>
                  </div>

                  <div className="live-owner-strip">
                    <span className="live-owner-avatar" aria-hidden="true">
                      {ownerName === 'Pengguna BLEA' ? <UserRound size={14} /> : getOwnerInitials(ownerName)}
                    </span>
                    <div className="live-owner-text">
                      <div className="live-owner-name-row">
                        <span className="live-owner-name">{ownerName}</span>
                        {item.is_own && <span className="live-pill is-own">Milik Anda</span>}
                      </div>
                      <span className="live-owner-email">{maskedEmail}</span>
                    </div>
                  </div>

                  <div className="live-card-main">
                    <h2 className="live-card-title" title={modelLabel}>{modelLabel}</h2>
                    {canSeeFull ? (
                      <p className="live-card-prompt">
                        {item.prompt || '(Permintaan berbasis media tanpa prompt teks)'}
                      </p>
                    ) : (
                      <p className="live-card-prompt">
                        Prompt &amp; media milik pengguna lain disamarkan demi privasi.
                      </p>
                    )}

                    <div className="live-progress-row">
                      <div className="live-progress-track">
                        <div className="live-progress-fill" style={{ width: `${progressPct}%` }} />
                      </div>
                      <span className="live-progress-label">
                        {item.kind === 'video'
                          ? `${Number(item.progress || 0)}%`
                          : (item.status === 'unknown' ? 'Tdk Pasti' : 'Proses')}
                      </span>
                    </div>

                    {item.diagnostic && (
                      <div className="live-diagnostic" role="note">
                        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                        <span>{item.diagnostic}</span>
                      </div>
                    )}
                  </div>

                  <div className="live-telemetry-grid">
                    <div className="live-telemetry-cell">
                      <span className="live-telemetry-label">Berjalan</span>
                      <span className="live-telemetry-value">{elapsedHuman}</span>
                    </div>
                    <div className="live-telemetry-cell">
                      <span className="live-telemetry-label">Mulai</span>
                      <span className="live-telemetry-value">{formatShortTime(item.created_at)}</span>
                    </div>
                    <div className="live-telemetry-cell">
                      <span className="live-telemetry-label">Update</span>
                      <span className="live-telemetry-value">{formatShortTime(item.updated_at)}</span>
                    </div>
                    <div className="live-telemetry-cell">
                      <span className="live-telemetry-label">{canSeeFull ? 'Biaya / Spek' : 'Status'}</span>
                      <span className="live-telemetry-value">
                        {canSeeFull
                          ? (item.credits_charged > 0
                              ? `${formatCredits(item.credits_charged)} kredit`
                              : ([item.aspect_ratio, item.resolution, item.duration ? `${item.duration}s` : null].filter(Boolean).join(' · ') || 'Aktif'))
                          : (STATUS_LABELS[item.status] || item.status)}
                      </span>
                    </div>
                  </div>

                  {(item.is_own || isAdmin) && (
                    <div className="live-card-footer">
                      {isAdmin && (
                        <span className="live-job-id" title={item.external_job_id || 'belum tersimpan'}>
                          ID: {item.external_job_id || 'belum tersimpan'}
                        </span>
                      )}
                      <div className="live-admin-actions">
                        {item.is_own && (
                          <Link className="live-link-btn" to={`/history?highlight=${encodeURIComponent(item.id)}`}>
                            History
                          </Link>
                        )}
                        {isAdmin && !isConfirming && (
                          <button
                            type="button"
                            className="live-cancel-btn"
                            onClick={() => {
                              setConfirmKey(itemKey);
                              setCancelReason('');
                            }}
                          >
                            <XCircle size={13} aria-hidden="true" />
                            Batalkan &amp; Refund
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {isAdmin && isConfirming && (
                    <div className="live-confirm-panel" role="region" aria-label="Konfirmasi pembatalan proses">
                      <span>
                        Batalkan <strong>{modelLabel}</strong> ({ownerName} · {maskedEmail})
                        {item.credits_charged > 0
                          ? ` & refund ${formatCredits(item.credits_charged)} kredit BLEA?`
                          : '?'}
                      </span>
                      <div className="live-confirm-row">
                        <input
                          type="text"
                          className="live-reason-input"
                          placeholder="Alasan pembatalan (opsional)"
                          maxLength={180}
                          value={cancelReason}
                          onChange={(e) => setCancelReason(e.target.value)}
                          disabled={isBusyCancel}
                        />
                        <div className="live-confirm-btns">
                          <button
                            type="button"
                            className="live-confirm-submit"
                            disabled={isBusyCancel}
                            onClick={() => handleConfirmCancel(item)}
                          >
                            {isBusyCancel ? 'Membatalkan…' : 'Ya, Batalkan & Refund'}
                          </button>
                          <button
                            type="button"
                            className="live-confirm-abort"
                            disabled={isBusyCancel}
                            onClick={() => {
                              setConfirmKey('');
                              setCancelReason('');
                            }}
                          >
                            Tutup
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </DropXLayout>
  );
}

export default LiveQueuePage;
