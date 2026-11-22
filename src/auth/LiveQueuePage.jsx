import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  FileSearch2,
  Film,
  Flag,
  Image as ImageIcon,
  Music,
  RefreshCw,
  ShieldAlert,
  Trophy,
  UserRound,
  XCircle,
  Zap,
} from 'lucide-react';
import { cancelAdminGeneration, fetchLiveGenerations } from '../api/generation';
import { DropXLayout } from '../dropx/DropXLayout';
import { formatCredits, formatModelDisplayName, formatProviderBadge } from '../lib/formatCredits';
import { formatElapsedHuman, formatElapsedRuntime, useNowTick } from '../lib/formatRuntime';
import {
  LIVE_FINISH_HOLD_MS,
  computeLiveProgress,
  maskEmailAfter4,
  reconcileRaceEntries,
} from '../lib/liveQueue';
import { useCredits } from '../lib/useCredits';
import { useAuth } from './AuthProvider';
import './live.css';

const STATUS_LABELS = {
  completed: 'Selesai · Sukses',
  queued: 'Dalam Antrean',
  in_progress: 'Sedang Dikerjakan',
  processing: 'Sedang Dikerjakan',
  unknown: 'Status Tidak Pasti',
  cancelled: 'Dibatalkan',
};

function getOwnerInitials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'BL';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

export function LiveQueuePage() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const { refresh: refreshBalance } = useCredits(user?.id);
  const [rawItems, setRawItems] = useState([]);
  const [counts, setCounts] = useState({ total: 0, video: 0, image: 0, music: 0, metadata: 0, completed: 0, own: 0, stalled: 0 });
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
  const [hasActiveFinishHold, setHasActiveFinishHold] = useState(false);
  const [rankDeltas, setRankDeltas] = useState({});

  const didInitialLoad = useRef(false);
  const holdMapRef = useRef(new Map());
  const dismissedRef = useRef(new Set());
  const prevRanksRef = useRef(new Map());
  const deltaExpiryRef = useRef(new Map());
  const rowRefs = useRef(new Map());
  const prevTopsRef = useRef(new Map());

  const clientNowMs = useNowTick(true, hasActiveFinishHold ? 250 : 1000);
  const effectiveNowMs = clientNowMs + serverOffsetMs;

  const applyRaceState = useCallback((incoming, nowLocalMs) => {
    const result = reconcileRaceEntries({
      holdMap: holdMapRef.current,
      dismissedSet: dismissedRef.current,
      incomingItems: incoming,
      nowMs: nowLocalMs,
      holdMs: LIVE_FINISH_HOLD_MS,
    });
    holdMapRef.current = result.holdMap;
    dismissedRef.current = result.dismissedSet;
    setHasActiveFinishHold(result.completedHoldCount > 0);
    setRawItems(incoming);
    return result;
  }, []);

  const loadLive = useCallback(async ({ poll = true, background = false } = {}) => {
    if (!user?.id) return;
    if (!background) setLoading(true);
    setSyncing(true);
    if (!background) setError('');
    try {
      const res = await fetchLiveGenerations({ poll });
      if (!res.ok) {
        if (!background || rawItems.length === 0) {
          setError(res.data?.error || 'Daftar proses live tidak dapat dimuat.');
        }
        return;
      }
      const nextItems = Array.isArray(res.data?.items) ? res.data.items : [];
      const activeOnly = nextItems.filter((item) => item.status !== 'completed');
      const nextCounts = res.data?.counts || {
        total: activeOnly.length,
        video: activeOnly.filter((item) => item.kind === 'video').length,
        image: activeOnly.filter((item) => item.kind === 'image').length,
        music: activeOnly.filter((item) => item.kind === 'music').length,
        metadata: activeOnly.filter((item) => item.kind === 'metadata').length,
        completed: nextItems.filter((item) => item.status === 'completed').length,
        own: nextItems.filter((item) => item.is_own).length,
        stalled: activeOnly.filter((item) => item.stalled).length,
      };
      if (res.data?.server_time) {
        const srv = Date.parse(res.data.server_time);
        if (Number.isFinite(srv)) setServerOffsetMs(srv - Date.now());
      }
      applyRaceState(nextItems, Date.now());
      setCounts(nextCounts);
      setLastSyncedAt(new Date());
      setError('');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }, [user?.id, rawItems.length, applyRaceState]);

  useEffect(() => {
    if (!user?.id || didInitialLoad.current) return;
    didInitialLoad.current = true;
    loadLive({ poll: true, background: false });
  }, [user?.id, loadLive]);

  const pollIntervalMs = (counts.total > 0 || hasActiveFinishHold) ? 3000 : 8000;
  useEffect(() => {
    if (!user?.id) return undefined;
    const timer = setInterval(() => {
      loadLive({ poll: true, background: true });
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [user?.id, pollIntervalMs, loadLive]);

  // Reconcile the race board on every tick so 5-second finish holds vanish promptly at 5s
  // and climbing progress naturally overtakes slower processes in real time.
  const raceState = useMemo(() => {
    const result = reconcileRaceEntries({
      holdMap: holdMapRef.current,
      dismissedSet: dismissedRef.current,
      incomingItems: rawItems,
      nowMs: clientNowMs,
      holdMs: LIVE_FINISH_HOLD_MS,
    });
    holdMapRef.current = result.holdMap;
    dismissedRef.current = result.dismissedSet;
    return result;
  }, [rawItems, clientNowMs]);

  useEffect(() => {
    setHasActiveFinishHold(raceState.completedHoldCount > 0);
  }, [raceState.completedHoldCount]);

  // Track rank movements (overtakes up / drops down) so riders visibly move on the board
  const orderSignature = raceState.items.map((item) => `${item.kind}:${item.id}:${item.status}`).join('|');
  useEffect(() => {
    const now = Date.now();
    const prevRanks = prevRanksRef.current;
    const nextRanks = new Map();
    const nextDeltas = {};

    raceState.items.forEach((item, index) => {
      const key = `${item.kind}:${item.id}`;
      const rank = index + 1;
      nextRanks.set(key, rank);

      if (prevRanks.size > 0) {
        if (!prevRanks.has(key)) {
          deltaExpiryRef.current.set(key, { type: 'new', delta: 0, until: now + 5000 });
        } else {
          const oldRank = prevRanks.get(key);
          if (oldRank !== rank) {
            deltaExpiryRef.current.set(key, {
              type: oldRank > rank ? 'up' : 'down',
              delta: Math.abs(oldRank - rank),
              until: now + 6000,
            });
          }
        }
      }

      const activeBadge = deltaExpiryRef.current.get(key);
      if (activeBadge && now < activeBadge.until) {
        nextDeltas[key] = activeBadge;
      } else if (activeBadge) {
        deltaExpiryRef.current.delete(key);
      }
    });

    prevRanksRef.current = nextRanks;
    setRankDeltas(nextDeltas);
  }, [orderSignature]);

  const filteredItems = useMemo(() => {
    return raceState.items.map((item, idx) => ({ item, raceRank: idx + 1 })).filter(({ item }) => {
      if (filter === 'own') return item.is_own;
      if (filter === 'video') return item.kind === 'video';
      if (filter === 'image') return item.kind === 'image';
      if (filter === 'music') return item.kind === 'music';
      if (filter === 'metadata') return item.kind === 'metadata';
      if (filter === 'stalled') return item.stalled;
      return true;
    });
  }, [raceState.items, filter]);

  // Smooth FLIP transition whenever row positions change up or down
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const nextTops = new Map();
    for (const [key, el] of rowRefs.current.entries()) {
      if (!el) continue;
      const top = el.getBoundingClientRect().top;
      nextTops.set(key, top);
      const prevTop = prevTopsRef.current.get(key);
      if (prevTop !== undefined) {
        const deltaY = prevTop - top;
        if (Math.abs(deltaY) > 2) {
          el.style.transition = 'none';
          el.style.transform = `translateY(${deltaY}px)`;
          el.getBoundingClientRect();
          el.style.transition = 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1)';
          el.style.transform = '';
        }
      }
    }
    prevTopsRef.current = nextTops;
  }, [orderSignature, filter]);

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
      setRawItems((prev) => prev.filter((row) => !(row.id === item.id && row.kind === item.kind)));
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
      description="Papan peringkat antrean live: posisi #1 adalah proses terdepan yang dikerjakan, dan proses selesai langsung naik ke atas selama 5 detik sebelum keluar."
    >
      <div className="live-page">
        <div className="live-hero-bar">
          <div className="live-hero-info">
            <div className="live-hero-title-row">
              <span className="live-badge-pulse">
                <span className="live-badge-dot" aria-hidden="true" />
                Live Queue · Race Leaderboard
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
                ? 'Peringkat #1 selalu menampilkan proses terdepan yang paling dekat selesai. Proses yang selesai otomatis naik ke #1 dengan status Sukses selama 5 detik lalu keluar; prompt pengguna lain tetap transparan untuk admin bersama Cancel + Refund.'
                : 'Peringkat #1 menampilkan proses paling terdepan yang sedang dikerjakan sistem. Posisi naik-turun real-time sesuai progres; proses yang selesai naik ke atas 5 detik (Sukses) lalu keluar, dan prompt pengguna lain disamarkan demi privasi.'}
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
          <div className="live-stat-card is-music">
            <div className="live-stat-meta">
              <span className="live-stat-label">Musik Aktif</span>
              <span className="live-stat-value">{counts.music || 0}</span>
            </div>
            <span className="live-stat-icon" aria-hidden="true">
              <Music size={18} />
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
              Semua ({raceState.items.length})
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
            <button type="button" className={`live-filter-tab ${filter === 'music' ? 'is-active' : ''}`} onClick={() => setFilter('music')}>
              Musik ({counts.music || 0})
            </button>
            <button type="button" className={`live-filter-tab ${filter === 'metadata' ? 'is-active' : ''}`} onClick={() => setFilter('metadata')}>
              Metadata ({counts.metadata || 0})
            </button>
            {counts.stalled > 0 && (
              <button type="button" className={`live-filter-tab ${filter === 'stalled' ? 'is-active' : ''}`} onClick={() => setFilter('stalled')}>
                Terindikasi Macet ({counts.stalled})
              </button>
            )}
          </div>
          <span className="live-sync-note">
            {lastSyncedAt
              ? `Sinkron ${lastSyncedAt.toLocaleTimeString('id-ID')} · update tiap ${pollIntervalMs / 1000}d`
              : 'Menyiapkan papan peringkat live…'}
          </span>
        </div>

        {error && <div className="live-banner is-error" role="alert">{error}</div>}
        {notice && <div className="live-banner is-success" role="status">{notice}</div>}

        {loading && !raceState.items.length ? (
          <div className="live-empty" role="status">
            <Activity size={26} aria-hidden="true" />
            <h2>Memuat papan peringkat proses…</h2>
            <p>Menyinkronkan posisi antrean video dan gambar dengan server provider.</p>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="live-empty">
            <Flag size={28} aria-hidden="true" />
            <h2>Lintasan antrean sedang kosong</h2>
            <p>
              {filter === 'all'
                ? 'Semua generasi video dan gambar saat ini sudah selesai atau belum ada proses baru yang berjalan.'
                : 'Tidak ada proses aktif yang cocok dengan filter ini.'}
            </p>
            <Link className="live-empty-link" to="/generate">Buka Halaman Generate</Link>
          </div>
        ) : (
          <div className="live-board">
            <div className="live-board-head">
              <span>Posisi &amp; Peserta</span>
              <span>Progres Balapan</span>
              <span>Waktu</span>
            </div>
            <div className="live-list">
              {filteredItems.map(({ item, raceRank }) => {
                const itemKey = `${item.kind}:${item.id}`;
                const isCompleted = item.status === 'completed';
                const isLeader = !isCompleted && raceRank === 1 && !item.stalled;
                const isConfirming = confirmKey === itemKey;
                const isBusyCancel = cancellingKey === itemKey;
                const providerLabel = formatProviderBadge(item.provider);
                const modelLabel = formatModelDisplayName(item.model, item.provider) || item.model || 'Model AI';
                const elapsedClock = formatElapsedRuntime(item.created_at, effectiveNowMs);
                const elapsedHuman = formatElapsedHuman(item.created_at, effectiveNowMs);
                const canSeeFull = item.is_own || isAdmin;
                const ownerName = item.owner_name || 'Pengguna BLEA';
                const maskedEmail = item.owner_email_masked || (item.user_email ? maskEmailAfter4(item.user_email) : '—');
                const progressPct = computeLiveProgress(item, effectiveNowMs);
                const delta = rankDeltas[itemKey];
                const finishRemainingMs = Number(item.finish_remaining_ms ?? 0);
                const finishSecondsLeft = Math.max(1, Math.ceil(finishRemainingMs / 1000));
                const finishPct = Math.max(0, Math.min(100, (finishRemainingMs / LIVE_FINISH_HOLD_MS) * 100));

                return (
                  <article
                    key={itemKey}
                    ref={(el) => {
                      if (el) rowRefs.current.set(itemKey, el);
                      else rowRefs.current.delete(itemKey);
                    }}
                    className={`live-card ${item.is_own ? 'is-own' : ''} ${isLeader ? 'is-leader' : ''} ${isCompleted ? 'is-completed' : ''} ${item.stalled ? 'is-stalled' : ''}`}
                  >
                    <div className="live-race-row">
                      <div className="live-rank-col">
                        <span className={`live-rank-badge rank-${raceRank <= 3 ? raceRank : 'other'}`}>
                          {isCompleted ? <Trophy size={18} aria-hidden="true" /> : `#${raceRank}`}
                        </span>
                        {delta?.type === 'up' && (
                          <span className="live-delta-pill is-up" title={`Naik ${delta.delta} peringkat`}>
                            <ArrowUp size={10} aria-hidden="true" />+{delta.delta}
                          </span>
                        )}
                        {delta?.type === 'down' && (
                          <span className="live-delta-pill is-down" title={`Turun ${delta.delta} peringkat`}>
                            <ArrowDown size={10} aria-hidden="true" />-{delta.delta}
                          </span>
                        )}
                        {delta?.type === 'new' && (
                          <span className="live-delta-pill is-new">BARU</span>
                        )}
                      </div>

                      <div className="live-race-center">
                        <div className="live-row-header">
                          <div className="live-owner-strip">
                            <span className="live-owner-avatar" aria-hidden="true">
                              {ownerName === 'Pengguna BLEA' ? <UserRound size={12} /> : getOwnerInitials(ownerName)}
                            </span>
                            <div className="live-owner-text">
                              <span className="live-owner-name">{ownerName}</span>
                              <span className="live-owner-email">{maskedEmail}</span>
                            </div>
                          </div>

                          <div className="live-card-badges">
                            <span className="live-pill">
                              {item.kind === 'video'
                                ? <Film size={11} aria-hidden="true" />
                                : item.kind === 'music'
                                  ? <Music size={11} aria-hidden="true" />
                                  : item.kind === 'metadata'
                                    ? <FileSearch2 size={11} aria-hidden="true" />
                                    : <ImageIcon size={11} aria-hidden="true" />}
                              {item.kind === 'video' ? 'Video' : item.kind === 'music' ? 'Musik' : item.kind === 'metadata' ? 'Metadata' : 'Gambar'}
                            </span>
                            <span className="live-pill">{providerLabel}</span>
                            {isCompleted ? (
                              <span className="live-pill is-completed">
                                <CheckCircle2 size={11} aria-hidden="true" />
                                Selesai · Sukses
                              </span>
                            ) : isLeader ? (
                              <span className="live-pill is-leader">
                                <Zap size={11} aria-hidden="true" />
                                Posisi #1 · Dikerjakan
                              </span>
                            ) : (
                              <span className="live-pill is-status">
                                <span className="live-badge-dot" aria-hidden="true" />
                                {STATUS_LABELS[item.status] || item.status}
                              </span>
                            )}
                            {item.is_own && <span className="live-pill is-own">Milik Anda</span>}
                            {item.stalled && (
                              <span className="live-pill is-stalled">
                                <AlertTriangle size={11} aria-hidden="true" />
                                Macet
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="live-card-main">
                          <div className="live-title-line">
                            <h2 className="live-card-title">{modelLabel}</h2>
                            {canSeeFull ? (
                              <p className="live-card-prompt" title={item.prompt || ''}>
                                {item.prompt || '(Permintaan berbasis media tanpa prompt teks)'}
                              </p>
                            ) : (
                              <p className="live-card-prompt">
                                Prompt &amp; media milik pengguna lain disamarkan demi privasi.
                              </p>
                            )}
                          </div>

                          <div className="live-progress-row">
                            <div className="live-progress-track">
                              <div className="live-progress-fill" style={{ width: `${progressPct}%` }} />
                            </div>
                            <span className="live-progress-label">{progressPct}%</span>
                          </div>

                          {isCompleted && (
                            <div className="live-finish-bar" role="status">
                              <div className="live-finish-top">
                                <span>🏁 Proses Sukses! Hasil siap dipakai.</span>
                                <span>Menghilang dalam {finishSecondsLeft}d</span>
                              </div>
                              <div className="live-finish-track">
                                <div className="live-finish-countdown" style={{ width: `${finishPct}%` }} />
                              </div>
                            </div>
                          )}

                          {item.diagnostic && (
                            <div className="live-diagnostic" role="note">
                              <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                              <span>{item.diagnostic}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="live-race-right">
                        <div
                          className="live-runtime-box"
                          title={`Mulai ${item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'}`}
                        >
                          <Clock size={12} aria-hidden="true" />
                          <span>{elapsedClock}</span>
                        </div>

                        <div className="live-telemetry-grid">
                          <span>{elapsedHuman}</span>
                          {canSeeFull && item.credits_charged > 0 && (
                            <span>· {formatCredits(item.credits_charged)} kredit</span>
                          )}
                          {isAdmin && item.external_job_id && (
                            <span title={item.external_job_id}>· ID {item.external_job_id.slice(0, 10)}</span>
                          )}
                        </div>

                        {(item.is_own || (isAdmin && !isCompleted)) && (
                          <div className="live-admin-actions">
                            {item.is_own && (
                              <Link className="live-link-btn" to={`/history?highlight=${encodeURIComponent(item.id)}`}>
                                History
                              </Link>
                            )}
                            {isAdmin && !isCompleted && !isConfirming && (
                              <button
                                type="button"
                                className="live-cancel-btn"
                                onClick={() => {
                                  setConfirmKey(itemKey);
                                  setCancelReason('');
                                }}
                              >
                                <XCircle size={12} aria-hidden="true" />
                                Batalkan &amp; Refund
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {isAdmin && !isCompleted && isConfirming && (
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
          </div>
        )}
      </div>
    </DropXLayout>
  );
}

export default LiveQueuePage;
