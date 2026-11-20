import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, RefreshCw } from 'lucide-react';
import { fetchImageHistory, fetchImageStatus, fetchVideoHistory, fetchVideoStatus } from '../api/generation';
import { DropXLayout } from '../dropx/DropXLayout';
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

  const visible = items.filter((item) => filter === 'all' || item.kind === filter);

  return (
    <DropXLayout title="History" description="Riwayat generasi milik Anda.">
      <div className="history-page">
        <div className="history-toolbar">
          <p>Video dan gambar yang Anda buat ditampilkan di sini. Status yang sedang diproses diperbarui otomatis.</p>
          <div className="history-filters" role="group" aria-label="Saring riwayat">
            <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>Semua</button>
            <button type="button" className={filter === 'video' ? 'is-active' : ''} onClick={() => setFilter('video')}>Video</button>
            <button type="button" className={filter === 'image' ? 'is-active' : ''} onClick={() => setFilter('image')}>Gambar</button>
            <button type="button" onClick={() => load()} disabled={loading}><RefreshCw size={15} /> Perbarui</button>
          </div>
        </div>
        {error && <div className="history-error" role="alert">{error}</div>}
        {loading && !visible.length ? <p role="status">Memuat riwayat…</p> : !visible.length && !error ? (
          <div className="history-empty"><History size={28} /><h2>Belum ada riwayat</h2><p>Video dan gambar yang dibuat akan muncul di sini.</p><Link to="/generate">Buat generasi</Link></div>
        ) : (
          <div className="history-grid">
            {visible.map((item) => (
              <article className="history-card" key={`${item.kind}-${item.id}`}>
                {item.kind === 'image'
                  ? (item.status === 'completed' && item.image_url
                    ? <img src={item.image_url} alt={item.prompt || 'Hasil generasi gambar'} loading="lazy" />
                    : <div className="history-preview">{labels[item.status] || item.status}</div>)
                  : (item.status === 'completed' && item.result_url
                    ? <video controls preload="metadata" src={item.result_url} />
                    : <div className="history-preview">{labels[item.status] || item.status}</div>)}
                <div className="history-card-body">
                  <span className={`history-status status-${item.status}`}>{labels[item.status] || item.status}</span>
                  <h2>{item.kind === 'image' ? `Gambar · ${item.model || '—'}` : (item.model || 'Video')}</h2>
                  <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
                  <p className="history-meta">{item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · {item.provider}{item.kind === 'image' && item.credits_charged ? ` · ${item.credits_charged} kredit${item.credits_refunded > 0 ? ` · ${item.credits_refunded} dikembalikan` : ''}` : ''}</p>
                  {item.error_message && <p className="history-error-text">{item.error_message}</p>}
                  {item.kind === 'image' && item.status === 'completed' && item.image_url && <div className="history-card-actions"><a href={item.image_url} target="_blank" rel="noopener noreferrer">Buka gambar</a></div>}
                  {item.kind === 'video' && item.status === 'completed' && item.result_url && <div className="history-card-actions"><a href={item.result_url} target="_blank" rel="noopener noreferrer">Buka video</a></div>}
                </div>
              </article>
            ))}
          </div>
        )}
        {hasMore && filter !== 'image' && <button className="history-more" type="button" onClick={() => load(nextOffset)} disabled={loading}>{loading ? 'Memuat…' : 'Muat lebih banyak'}</button>}
      </div>
    </DropXLayout>
  );
}
