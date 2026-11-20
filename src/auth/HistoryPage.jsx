import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, History, RefreshCw } from 'lucide-react';
import {
  buildDownloadFilename,
  fetchImageHistory,
  fetchImageStatus,
  fetchVideoHistory,
  fetchVideoStatus,
  withDownloadParam,
} from '../api/generation';
import { DropXLayout } from '../dropx/DropXLayout';
import { Pager, PerPageSelect, usePagedList } from '../components/Pagination';
import './history.css';

const labels = { queued: 'Dalam antrean', in_progress: 'Sedang diproses', processing: 'Sedang diproses', completed: 'Selesai', failed: 'Gagal', cancelled: 'Dibatalkan', expired: 'Kedaluwarsa', unknown: 'Hasil tidak pasti' };
const isVideoPending = (item) => item.status === 'queued' || item.status === 'in_progress';
const isImagePending = (item) => item.status === 'queued' || item.status === 'processing';

export function HistoryPage() {
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('all');
  const [searchParams] = useSearchParams();
  const highlight = searchParams.get('highlight');
  const highlightTried = useRef(false);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError('');
    try {
      const [videoRes, imageRes] = await Promise.all([
        fetchVideoHistory({ offset }),
        offset === 0 ? fetchImageHistory() : Promise.resolve({ ok: true, data: { generations: [] } }),
      ]);
      if (!videoRes.ok || !Array.isArray(videoRes.data?.generations)) {
        setError(videoRes.data?.error || 'Riwayat tidak dapat dimuat. Coba lagi.');
        return;
      }
      const videos = videoRes.data.generations.map((item) => ({ ...item, kind: 'video' }));
      const images = (imageRes.ok && Array.isArray(imageRes.data?.generations) ? imageRes.data.generations : []).map((item) => ({ ...item, kind: 'image' }));
      setItems((previous) => {
        const base = offset === 0 ? previous.filter((item) => item.kind === 'image') : previous;
        const merged = [...base.filter((item) => !videos.some((video) => video.id === item.id)), ...videos, ...images.filter((image) => !base.some((old) => old.id === image.id))];
        return merged.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
      });
      setHasMore(Boolean(videoRes.data.hasMore));
      setNextOffset(offset + videoRes.data.generations.length);
    } catch {
      setError('Riwayat tidak dapat dimuat. Coba lagi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Datang dari tombol "Lihat hasil di History" di Riwayat Kredit: pastikan item
  // sorotan ikut dimuat walau bukan di halaman pertama, lalu gulir ke & kedipkan.
  useEffect(() => {
    if (!highlight || highlightTried.current) return;
    highlightTried.current = true;
    setFilter('all');
    // Sorotan selalu diangkat ke urutan teratas supaya terlihat tanpa ganti halaman.
    setItems((previous) => {
      const target = previous.find((item) => item.id === highlight);
      return target ? [target, ...previous.filter((item) => item.id !== highlight)] : previous;
    });
    if (items.some((item) => item.id === highlight)) return undefined;
    let active = true;
    (async () => {
      const video = await fetchVideoStatus(highlight);
      if (active && video.ok && video.data?.generation) {
        setItems((previous) => [{ ...video.data.generation, kind: 'video' }, ...previous.filter((item) => item.id !== highlight)]);
        return;
      }
      const image = await fetchImageStatus(highlight);
      if (active && image.ok && image.data?.generation) {
        setItems((previous) => [{ ...image.data.generation, kind: 'image' }, ...previous.filter((item) => item.id !== highlight)]);
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight]);

  useEffect(() => {
    if (!highlight) return undefined;
    const target = document.getElementById(`history-item-${highlight}`);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return undefined;
  }, [items, highlight]);

  useEffect(() => {
    const pendingVideos = items.filter((item) => item.kind === 'video' && isVideoPending(item)).slice(0, 4);
    const pendingImages = items.filter((item) => item.kind === 'image' && isImagePending(item) && item.canPoll).slice(0, 4);
    if (!pendingVideos.length && !pendingImages.length) return undefined;
    let active = true;
    const timer = setInterval(async () => {
      const [videoResults, imageResults] = await Promise.all([
        Promise.all(pendingVideos.map((item) => fetchVideoStatus(item.id))),
        Promise.all(pendingImages.map((item) => fetchImageStatus(item.id))),
      ]);
      if (!active) return;
      const updates = new Map([
        ...videoResults.filter((result) => result.ok && result.data?.generation).map((result) => [result.data.generation.id, { ...result.data.generation, kind: 'video' }]),
        ...imageResults.filter((result) => result.ok && result.data?.generation).map((result) => [result.data.generation.id, { ...result.data.generation, kind: 'image' }]),
      ]);
      if (updates.size) setItems((current) => current.map((item) => updates.get(item.id) || item));
    }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [items]);

  const filtered = items.filter((item) => filter === 'all' || item.kind === filter);
  const { perPage, setPerPage, page, setPage, pageCount, slice, total } = usePagedList(filtered);
  const visible = slice;
  // Tautan dari Riwayat Kredit selalu menunjukkan halaman pertama (item sorotan diangkat paling atas).
  useEffect(() => { setPage(1); }, [highlight, setPage]);

  return (
    <DropXLayout title="History" description="Riwayat generasi milik Anda.">
      <div className="history-page">
        <div className="history-toolbar">
          <p>Video dan gambar yang Anda buat ditampilkan di sini. Status yang sedang diproses diperbarui otomatis.</p>
          <div className="history-filters" role="group" aria-label="Saring riwayat">
            <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Semua</button>
            <button type="button" className={filter === 'video' ? 'is-active' : ''} onClick={() => setFilter('video')}>Video</button>
            <button type="button" className={filter === 'image' ? 'is-active' : ''} onClick={() => setFilter('image')}>Gambar</button>
            <PerPageSelect id="history-per-page" value={perPage} onChange={setPerPage} options={[10, 50, 100]} />
            <button type="button" onClick={() => load()} disabled={loading}><RefreshCw size={15} /> Perbarui</button>
          </div>
        </div>
        {error && <div className="history-error" role="alert">{error}</div>}
        {loading && !visible.length ? <p role="status">Memuat riwayat…</p> : !visible.length && !error ? (
          <div className="history-empty"><History size={28} /><h2>Belum ada riwayat</h2><p>Video dan gambar yang dibuat akan muncul di sini.</p><Link to="/generate">Buat generasi</Link></div>
        ) : (
          <div className="history-grid">
            {visible.map((item) => {
              const imageUrls = item.kind === 'image'
                ? (Array.isArray(item.image_urls) && item.image_urls.length > 0
                  ? item.image_urls
                  : (item.image_url ? [item.image_url] : []))
                : [];
              const pending = item.kind === 'image' ? isImagePending(item) : isVideoPending(item);
              return (
              <article className={`history-card${highlight === item.id ? ' is-highlighted' : ''}`} id={`history-item-${item.id}`} key={`${item.kind}-${item.id}`}>
                {item.kind === 'image'
                  ? (item.status === 'completed' && imageUrls[0]
                    ? <img src={imageUrls[0]} alt={item.prompt || 'Hasil generasi gambar'} loading="lazy" />
                    : pending
                      ? <div className="history-preview generate-img-loader" role="status"><div className="generate-aurora is-subtle" aria-hidden="true" /><span className="generate-img-orbit" aria-hidden="true" /><span className="generate-loader-badge"><span className="generate-pulse-dot" aria-hidden="true" />{labels[item.status] || item.status}</span></div>
                      : <div className="history-preview">{labels[item.status] || item.status}</div>)
                  : (item.status === 'completed' && item.result_url
                    ? <video controls preload="metadata" src={item.result_url} />
                    : pending
                      ? <div className="history-preview generate-img-loader" role="status"><div className="generate-aurora is-subtle" aria-hidden="true" /><span className="generate-img-orbit" aria-hidden="true" /><span className="generate-loader-badge"><span className="generate-pulse-dot" aria-hidden="true" />{labels[item.status] || item.status}</span></div>
                      : <div className="history-preview">{labels[item.status] || item.status}</div>)}
                <div className="history-card-body">
                  <span className={`history-status status-${item.status}`}>{labels[item.status] || item.status}</span>
                  <h2>{item.kind === 'image' ? `Gambar · ${item.model || '—'}` : (item.model || 'Video')}</h2>
                  <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
                  <p className="history-meta">{item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · {item.provider}{item.credits_charged ? ` · ${item.credits_charged} kredit${item.credits_refunded > 0 ? ` · ${item.credits_refunded} dikembalikan` : ''}` : ''}</p>
                  {item.error_message && <p className="history-error-text">{item.error_message}</p>}
                  {item.kind === 'image' && item.status === 'completed' && imageUrls.length > 0 && (
                    <div className="history-card-actions">
                      {imageUrls.map((url, idx) => {
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
                              download={buildDownloadFilename({ kind: 'image', id: item.id, index: idx, total: imageUrls.length, url })}
                            >
                              <Download size={14} aria-hidden="true" />
                              {imageUrls.length > 1 ? `Unduh gambar #${idx + 1}` : 'Unduh gambar'}
                            </a>
                            <a href={url} target="_blank" rel="noopener noreferrer">
                              {imageUrls.length > 1 ? `Buka gambar #${idx + 1}` : 'Buka gambar'}
                            </a>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {item.kind === 'video' && item.status === 'completed' && item.result_url && (
                    <div className="history-card-actions">
                      <a
                        className="history-download-btn"
                        href={withDownloadParam(item.result_url)}
                        download={buildDownloadFilename({ kind: 'video', id: item.id })}
                      >
                        <Download size={14} aria-hidden="true" />
                        Unduh video
                      </a>
                      <a href={item.result_url} target="_blank" rel="noopener noreferrer">Buka video</a>
                    </div>
                  )}
                </div>
              </article>
              );
            })}
          </div>
        )}
        <Pager page={page} pageCount={pageCount} total={total} onPage={setPage} />
        {hasMore && filter !== 'image' && <button className="history-more" type="button" onClick={() => load(nextOffset)} disabled={loading}>{loading ? 'Memuat…' : 'Muat lebih banyak'}</button>}
      </div>
    </DropXLayout>
  );
}
