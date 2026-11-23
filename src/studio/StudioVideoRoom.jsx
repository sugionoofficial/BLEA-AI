import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Clapperboard, Film, RefreshCw } from 'lucide-react';
import { fetchStudioVideoConfig, fetchStudioVideoStatus, generateStudioVideo } from './studioClient';
import './video-room.css';

const STATUS_LABEL = {
  queued: 'Dalam antrean',
  processing: 'Sedang dibuat',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
};
const PENDING = new Set(['queued', 'processing']);
const SECONDS = ['4', '8', '12'];
const SIZES = [
  { id: '1280x720', label: 'Lanskap 720p' },
  { id: '720x1280', label: 'Potret 720p' },
  { id: '1024x1024', label: 'Kotak' },
];

/**
 * Ruang video Studio (Sora lewat pool akun ChatGPT).
 *
 * Tidak ada potongan kredit BLEA di sini: yang berbayar adalah akun OpenAI
 * milik admin, dan kuota harian akun itu yang membatasi pemakaian. Karena video
 * selalu asinkron, halaman ini menyimpan id internal di server dan mem-poll
 * statusnya sampai selesai.
 */
export function StudioVideoRoom() {
  const [config, setConfig] = useState(null);
  const [model, setModel] = useState('');
  const [seconds, setSeconds] = useState('8');
  const [size, setSize] = useState('1280x720');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    const res = await fetchStudioVideoConfig();
    if (res.ok) {
      setConfig(res.data);
      setModel((current) => current || res.data?.recommended || res.data?.models?.[0]?.id || 'sora-2');
    } else {
      setError(res.data?.error || 'Konfigurasi video belum bisa dimuat.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll status selama tugas masih berjalan. Interval dibersihkan saat unmount
  // supaya tidak ada permintaan yang berjalan setelah pengguna pindah halaman.
  useEffect(() => {
    if (!job?.id || !PENDING.has(job.status)) return undefined;
    pollRef.current = setInterval(async () => {
      const res = await fetchStudioVideoStatus(job.id);
      if (res.ok && res.data?.generation) {
        setJob(res.data.generation);
        if (res.data.generation.status === 'completed') setNotice('Video selesai. Unduhan tersedia di bawah.');
      }
    }, 10_000);
    return () => clearInterval(pollRef.current);
  }, [job?.id, job?.status]);

  async function submit(event) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true); setError(''); setNotice('');
    const res = await generateStudioVideo({ prompt: text, model: model || 'sora-2', seconds, size });
    if (!res.ok) {
      setError(res.data?.error || 'Permintaan video gagal.');
    } else {
      setJob(res.data?.generation || null);
      setNotice('Permintaan diterima. Video biasanya selesai dalam beberapa menit; halaman ini memantau statusnya otomatis.');
    }
    setBusy(false);
  }

  const ready = config?.ready === true;

  return (
    <div className="studio-video">
      {config && !ready && (
        <div className="studio-video-banner" role="status">
          <span>{config.hint || 'Pool akun ChatGPT belum siap untuk video.'}</span>
          <Link to="/studio/chatgpt-accounts">Kelola akun</Link>
        </div>
      )}

      <form className="studio-video-form" onSubmit={submit}>
        <label className="studio-video-field">
          <span>Model video</span>
          <select value={model} onChange={(event) => setModel(event.target.value)} aria-label="Model video">
            {(config?.models || [{ id: 'sora-2' }, { id: 'sora-2-pro' }]).map((item) => (
              <option key={item.id} value={item.id}>{item.id}</option>
            ))}
          </select>
        </label>
        <div className="studio-video-row">
          <label className="studio-video-field">
            <span>Durasi</span>
            <select value={seconds} onChange={(event) => setSeconds(event.target.value)} aria-label="Durasi video">
              {SECONDS.map((value) => <option key={value} value={value}>{value} detik</option>)}
            </select>
          </label>
          <label className="studio-video-field">
            <span>Rasio</span>
            <select value={size} onChange={(event) => setSize(event.target.value)} aria-label="Ukuran video">
              {SIZES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
        </div>
        <label className="studio-video-field">
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="Contoh: ombak pecah di pantai berbatu saat matahari terbit, kamera bergerak lambat ke kanan."
          />
        </label>
        <div className="studio-video-actions">
          <button type="submit" className="studio-video-submit" disabled={!ready || busy || !prompt.trim()}>
            <Clapperboard size={15} /> {busy ? 'Mengirim…' : 'Buat video'}
          </button>
          <span className="studio-video-hint">Kuota akun ChatGPT, bukan kredit BLEA.</span>
        </div>
      </form>

      {error && <div className="studio-video-banner is-error" role="alert"><span>{error}</span></div>}
      {notice && <div className="studio-video-banner" role="status"><span>{notice}</span></div>}

      {job && (
        <section className="studio-video-job">
          <header>
            <b><Film size={14} /> {STATUS_LABEL[job.status] || job.status}</b>
            {PENDING.has(job.status) && (
              <button type="button" onClick={async () => {
                const res = await fetchStudioVideoStatus(job.id);
                if (res.ok && res.data?.generation) setJob(res.data.generation);
              }}>
                <RefreshCw size={12} /> Perbarui
              </button>
            )}
          </header>
          <p className="studio-video-prompt">{job.prompt}</p>
          <small>
            {job.model} · {job.metadata?.seconds || seconds} detik · akun {job.chatgpt_account_label || 'pool ChatGPT'}
          </small>
          {job.status === 'completed' && job.media_url && (
            <video className="studio-video-player" src={job.media_url} controls playsInline />
          )}
          {job.status === 'completed' && job.media_url && (
            <a className="studio-video-download" href={job.media_url} download={`blea-studio-${String(job.id || '').slice(0, 8)}.mp4`}>
              Unduh video
            </a>
          )}
          {job.error_message && <p className="studio-video-error">{job.error_message}</p>}
        </section>
      )}
    </div>
  );
}

export default StudioVideoRoom;
