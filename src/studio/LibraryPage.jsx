import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FolderDown,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Music,
  RefreshCw,
  Scissors,
  Video,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { fetchLibrary } from './studioClient';
import { TOOL_SEPARATION_REASONS } from './toolCatalog';
import './library.css';

// Halaman hasil: satu tempat untuk mengambil hasil dari tool yang BERBEDA.
// Yang dilakukan halaman ini hanya membaca: hasil tiap tool sudah dipisah di
// tabelnya sendiri, jadi tidak ada pencampuran data antar tool di sini.
const TABS = [
  { id: 'all', label: 'Semua', icon: FolderDown },
  { id: 'image', label: 'Gambar', icon: ImageIcon },
  { id: 'video', label: 'Video', icon: Video },
  { id: 'music', label: 'Musik', icon: Music },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'metadata', label: 'Metadata', icon: Scissors },
];

const STATUS_LABELS = {
  completed: 'Selesai',
  queued: 'Antre',
  processing: 'Diproses',
  in_progress: 'Diproses',
  failed: 'Gagal',
  cancelled: 'Batal',
  unknown: 'Tak pasti',
  expired: 'Kedaluwarsa',
};

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
}

function fileExtension(item) {
  if (item.media_kind === 'image') return 'png';
  if (item.media_kind === 'video') return 'mp4';
  if (item.media_kind === 'audio') return 'mp3';
  if (item.tool === 'metadata') return '';
  return 'txt';
}

function downloadName(item, index = 0) {
  const ext = fileExtension(item);
  const base = `blea-${item.tool}-${String(item.created_at || '').slice(0, 10) || 'hasil'}-${index + 1}`;
  return ext ? `${base}.${ext}` : base;
}

function triggerBlobDownload(name, content, type) {
  const blob = new Blob([content], { type });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

export function LibraryPage() {
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState({});
  const [tool, setTool] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState('');
  const [showReasons, setShowReasons] = useState(false);

  const load = useCallback(async (nextTool = 'all') => {
    setLoading(true);
    setError('');
    const res = await fetchLibrary({ tool: nextTool });
    if (!res.ok) {
      setError(res.data?.error || 'Hasil tidak dapat dimuat.');
      setItems([]);
    } else {
      setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      setCounts(res.data?.counts || {});
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load(tool);
  }, [load, tool]);

  const visible = useMemo(
    () => (tool === 'all' ? items : items.filter((item) => item.tool === tool)),
    [items, tool],
  );

  const copyItem = useCallback(async (item) => {
    const text = item.text || item.title || '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setCopiedId(item.id);
    setTimeout(() => setCopiedId((current) => (current === item.id ? '' : current)), 1600);
  }, []);

  const downloadText = useCallback((item) => {
    triggerBlobDownload(downloadName(item), item.text || item.title || '', 'text/plain;charset=utf-8');
  }, []);

  return (
    <DropXLayout
      title="Hasil & Unduhan"
      description="Ambil hasil dari tool yang berbeda: salin teksnya, unduh medianya."
      actions={(
        <button type="button" className="studio-home-connection" onClick={() => load(tool)} disabled={loading}>
          {loading ? <Loader2 size={13} className="agent-spin" /> : <RefreshCw size={13} />} Muat ulang
        </button>
      )}
    >
      <div className="library">
        <section className="library-hero">
          <span className="library-badge"><FolderDown size={12} /> Hasil</span>
          <h1>Satu halaman untuk semua hasil.</h1>
          <p>
            Setiap tool menulis ke tabelnya sendiri, jadi hasil di sini tidak pernah tercampur.
            Salin teks atau unduh berkasnya; tautan unduhan bertanda tangan dan berlaku ±2 jam.
          </p>
          <button type="button" className="library-why" onClick={() => setShowReasons((open) => !open)} aria-expanded={showReasons}>
            {showReasons ? 'Sembunyikan alasan tool dipisah' : 'Kenapa tool dipisah?'}
          </button>
          {showReasons && (
            <ul className="library-reasons">
              {TOOL_SEPARATION_REASONS.map((reason) => (
                <li key={reason.title}>
                  <b>{reason.title}</b>
                  <small>{reason.body}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="library-tabs">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const count = tab.id === 'all' ? Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0) : counts[tab.id];
            return (
              <button
                type="button"
                key={tab.id}
                className={`library-tab ${tool === tab.id ? 'is-active' : ''}`}
                onClick={() => setTool(tab.id)}
              >
                <Icon size={12} /> {tab.label}
                {Number.isFinite(count) && count > 0 && <em>{count}</em>}
              </button>
            );
          })}
        </div>

        {error && <p className="library-error"><CircleAlert size={13} /> {error}</p>}

        {loading && !items.length && (
          <p className="library-empty"><Loader2 size={14} className="agent-spin" /> Memuat hasil…</p>
        )}

        {!loading && !visible.length && !error && (
          <div className="library-empty-block">
            <p>Belum ada hasil{tool === 'all' ? '' : ` dari tool ${tool}`}.</p>
            <p className="library-empty-hint">
              Buka salah satu tool di <Link to="/studio">Studio</Link> lalu buat sesuatu — hasilnya
              otomatis muncul di sini.
            </p>
          </div>
        )}

        <ul className="library-list">
          {visible.map((item) => (
            <li key={item.id} className={`library-item is-${item.tool}`}>
              <div className="library-item-head">
                <span className="library-item-tool">{item.tool_label}</span>
                <span className={`library-item-status is-${item.status}`}>{STATUS_LABELS[item.status] || item.status}</span>
                <time>{formatTime(item.created_at)}</time>
              </div>
              {item.preview_url && item.media_kind === 'image' && (
                <a className="library-thumb" href={item.preview_url} target="_blank" rel="noreferrer">
                  <img src={item.preview_url} alt={item.title} loading="lazy" />
                </a>
              )}
              {item.preview_url && item.media_kind === 'video' && (
                <video className="library-player" src={item.preview_url} controls preload="metadata" />
              )}
              {item.preview_url && item.media_kind === 'audio' && (
                <audio className="library-audio" src={item.preview_url} controls preload="metadata" />
              )}
              <p className="library-item-title">{item.title}</p>
              {item.error && <p className="library-item-error"><CircleAlert size={12} /> {item.error}</p>}
              <div className="library-item-actions">
                {(item.text || item.title) && (
                  <button type="button" onClick={() => copyItem(item)} className={copiedId === item.id ? 'is-copied' : ''}>
                    {copiedId === item.id ? <Check size={12} /> : <Copy size={12} />}
                    {copiedId === item.id ? 'Tersalin' : 'Salin'}
                  </button>
                )}
                {item.download_url ? (
                  <a href={item.download_url} download={downloadName(item)} className="library-download">
                    <Download size={12} /> Unduh
                  </a>
                ) : (
                  <button type="button" onClick={() => downloadText(item)}>
                    <Download size={12} /> Unduh .txt
                  </button>
                )}
                {item.preview_url && (
                  <a href={item.preview_url} target="_blank" rel="noreferrer">
                    <ExternalLink size={12} /> Buka
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </DropXLayout>
  );
}

export default LibraryPage;
