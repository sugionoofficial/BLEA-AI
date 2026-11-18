import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, RefreshCw } from 'lucide-react';
import { fetchVideoHistory, fetchVideoStatus } from '../api/generation';
import { DropXLayout } from '../dropx/DropXLayout';
import './history.css';

const labels = { queued: 'Dalam antrean', in_progress: 'Sedang diproses', completed: 'Selesai', failed: 'Gagal', cancelled: 'Dibatalkan', expired: 'Kedaluwarsa' };
const isPending = (item) => item.status === 'queued' || item.status === 'in_progress';

export function HistoryPage() {
  const [items, setItems] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchVideoHistory({ offset });
      if (!result.ok || !Array.isArray(result.data?.generations)) {
        setError(result.data?.error || 'Riwayat tidak dapat dimuat. Coba lagi.');
        return;
      }
      setItems((previous) => offset === 0 ? result.data.generations : [...previous, ...result.data.generations.filter((item) => !previous.some((old) => old.id === item.id))]);
      setHasMore(Boolean(result.data.hasMore));
      setNextOffset(offset + result.data.generations.length);
    } catch {
      setError('Riwayat tidak dapat dimuat. Coba lagi.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const pending = items.filter(isPending).slice(0, 4);
    if (!pending.length) return undefined;
    let active = true;
    const timer = setInterval(async () => {
      const results = await Promise.all(pending.map((item) => fetchVideoStatus(item.id)));
      if (!active) return;
      const updates = new Map(results.filter((result) => result.ok && result.data?.generation).map((result) => [result.data.generation.id, result.data.generation]));
      setItems((current) => current.map((item) => updates.get(item.id) || item));
    }, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [items]);

  return (
    <DropXLayout title="History" description="Riwayat generasi milik Anda.">
      <div className="history-page">
        <div className="history-toolbar">
          <p>Video yang Anda buat ditampilkan di sini. Status yang sedang diproses diperbarui otomatis.</p>
          <button type="button" onClick={() => load()} disabled={loading}><RefreshCw size={15} /> Perbarui</button>
        </div>
        {error && <div className="history-error" role="alert">{error}</div>}
        {loading && !items.length ? <p role="status">Memuat riwayat…</p> : !items.length && !error ? (
          <div className="history-empty"><History size={28} /><h2>Belum ada riwayat</h2><p>Video yang dibuat akan muncul di sini.</p><Link to="/generate">Buat video</Link></div>
        ) : (
          <div className="history-grid">
            {items.map((item) => (
              <article className="history-card" key={item.id}>
                {item.status === 'completed' && item.result_url ? <video controls preload="metadata" src={item.result_url} /> : <div className="history-preview">{labels[item.status] || item.status}</div>}
                <div className="history-card-body">
                  <span className={`history-status status-${item.status}`}>{labels[item.status] || item.status}</span>
                  <h2>{item.model || 'Video'}</h2>
                  <p className="history-prompt">{item.prompt || 'Tanpa prompt'}</p>
                  <p className="history-meta">{item.created_at ? new Date(item.created_at).toLocaleString('id-ID') : '—'} · {item.provider}</p>
                  {item.error_message && <p className="history-error-text">{item.error_message}</p>}
                  {item.status === 'completed' && item.result_url && <div className="history-card-actions"><a href={item.result_url} target="_blank" rel="noopener noreferrer">Buka video</a></div>}
                </div>
              </article>
            ))}
          </div>
        )}
        {hasMore && <button className="history-more" type="button" onClick={() => load(nextOffset)} disabled={loading}>{loading ? 'Memuat…' : 'Muat lebih banyak'}</button>}
      </div>
    </DropXLayout>
  );
}
