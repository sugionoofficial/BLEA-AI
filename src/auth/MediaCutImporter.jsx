import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { resolveSocialMediaUrl } from '../api/generation';
import { probeMediaDurationMs } from '../lib/freebeatVideoUpload';
import { trimAudioToWav, trimVideoToWebm } from '../lib/mediaTrim';

const SOCIAL_URL_RE = /(facebook\.com|fb\.watch|fb\.me|tiktok\.com)/i;

export function isSocialMediaUrl(url) {
  return SOCIAL_URL_RE.test(String(url || ''));
}

function formatSec(s) {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.max(0, Math.floor(s % 60));
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Mengunggah Blob hasil (utuh atau terpotong) ke Supabase Storage — jalur &
// batas ukuran sama seperti upload manual lain di halaman Generate.
async function uploadResultBlob({ userId, kind, blob, baseName }) {
  const maxBytes = kind === 'video' ? 100 * 1024 * 1024 : 25 * 1024 * 1024;
  if (blob.size > maxBytes) {
    throw new Error(`Ukuran hasil (${(blob.size / 1024 / 1024).toFixed(1)}MB) melebihi batas ${kind === 'video' ? '100MB' : '25MB'}.`);
  }
  const type = String(blob.type || '').toLowerCase();
  const ext = type.includes('webm') ? 'webm'
    : type.includes('wav') ? 'wav'
    : type.includes('mp4') ? 'mp4'
    : type.includes('mpeg') ? 'mp3'
    : kind === 'video' ? 'mp4' : 'mp3';
  const safeName = `${baseName}-${Date.now()}.${ext}`;
  const path = `${userId}/video-inputs/${kind}-${Date.now()}-${safeName}`;
  const { data, error } = await supabase.storage
    .from('ai-studio-uploads')
    .upload(path, blob, { contentType: blob.type || undefined, upsert: false });
  if (error) throw new Error(`Upload ke Supabase gagal: ${error.message}`);
  const { data: pub } = supabase.storage.from('ai-studio-uploads').getPublicUrl(data.path);
  return { url: pub.publicUrl, name: safeName, size: blob.size, localPreview: URL.createObjectURL(blob) };
}

// Panel pratinjau + kontrol potong, dipakai setelah sumber (resolve FB/TikTok
// ATAU media yang sudah diunggah/di-paste) siap diputar di <video>/<audio>.
function TrimPanel({ kind, sourceUrl, via, quality, userId, disabled, onUseMedia, onCancel, showUseFull = true, baseName = 'media' }) {
  const [duration, setDuration] = useState(null);
  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    probeMediaDurationMs(sourceUrl, kind === 'video' ? 'video' : 'audio').then((ms) => {
      if (cancelled) return;
      const dur = ms ? ms / 1000 : null;
      setDuration(dur);
      setStartSec(0);
      setEndSec(dur || 0);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [sourceUrl, kind]);

  const handleUseFull = async () => {
    setWorking('full');
    setError('');
    try {
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error('Gagal mengambil media sumber.');
      const blob = await res.blob();
      const media = await uploadResultBlob({ userId, kind, blob, baseName: `${baseName}-full` });
      onUseMedia(media);
    } catch (err) {
      setError(err?.message || 'Gagal menggunakan media.');
    } finally {
      setWorking('');
    }
  };

  const handleCut = async () => {
    setWorking('cut');
    setError('');
    try {
      const blob = kind === 'video'
        ? await trimVideoToWebm(sourceUrl, startSec, endSec)
        : await trimAudioToWav(sourceUrl, startSec, endSec);
      const media = await uploadResultBlob({ userId, kind, blob, baseName: `${baseName}-cut` });
      onUseMedia(media);
    } catch (err) {
      setError(err?.message || 'Gagal memotong media.');
    } finally {
      setWorking('');
    }
  };

  return (
    <div className="generate-field" style={{ marginTop: 8, padding: 10, border: '1px dashed rgba(255,255,255,0.18)', borderRadius: 8 }}>
      {(via || quality) && (
        <p className="generate-hint" style={{ margin: '0 0 6px' }}>
          {via ? `Berhasil via ${via}` : ''}{quality ? ` · kualitas ${String(quality).toUpperCase()}` : ''}
        </p>
      )}
      {kind === 'video' ? (
        <video src={sourceUrl} controls muted playsInline className="generate-preview-thumb" style={{ width: '100%', maxHeight: 220 }} />
      ) : (
        <audio src={sourceUrl} controls className="generate-preview-audio" style={{ width: '100%' }} />
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="generate-hint" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Mulai (detik)
          <input type="number" className="generate-select" min={0} max={duration || 600} step="0.5" value={startSec} onChange={(e) => setStartSec(Number(e.target.value))} style={{ width: 100 }} />
        </label>
        <label className="generate-hint" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          Selesai (detik)
          <input type="number" className="generate-select" min={0} max={duration || 600} step="0.5" value={endSec} onChange={(e) => setEndSec(Number(e.target.value))} style={{ width: 100 }} />
        </label>
        {duration ? <span className="generate-hint">Durasi penuh: {formatSec(duration)}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {showUseFull && (
          <button type="button" className="generate-select" style={{ cursor: 'pointer' }} disabled={disabled || Boolean(working)} onClick={handleUseFull}>
            {working === 'full' ? 'Mengunggah…' : 'Gunakan Utuh'}
          </button>
        )}
        <button type="button" className="generate-select" style={{ cursor: 'pointer' }} disabled={disabled || Boolean(working) || endSec <= startSec} onClick={handleCut}>
          {working === 'cut' ? 'Memotong…' : `Potong (${formatSec(startSec)}–${formatSec(endSec)}) & Gunakan`}
        </button>
        {onCancel && (
          <button type="button" className="generate-clear-btn" disabled={Boolean(working)} onClick={onCancel}>
            Batal
          </button>
        )}
      </div>
      {error && <p className="generate-hint" style={{ color: '#ff6b6b', marginTop: 6 }}>{error}</p>}
    </div>
  );
}

// Dipasang di bawah input URL audio/video: mendeteksi tautan Facebook/TikTok,
// menawarkan tombol "Proses Tautan" (scrape getmyfb.com/ssstik.io lewat
// backend), lalu menampilkan pratinjau + kontrol potong setelah berhasil.
export default function MediaCutImporter({ kind, pastedUrl, userId, disabled, onUseMedia }) {
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(null);
  const [error, setError] = useState('');
  const lastUrlRef = useRef('');

  useEffect(() => {
    if (pastedUrl !== lastUrlRef.current) {
      lastUrlRef.current = pastedUrl;
      setResolved(null);
      setError('');
    }
  }, [pastedUrl]);

  const looksSocial = isSocialMediaUrl(pastedUrl);
  if (!looksSocial && !resolved) return null;

  const isTikTok = /tiktok\.com/i.test(pastedUrl);

  const handleResolve = async () => {
    setResolving(true);
    setError('');
    try {
      const res = await resolveSocialMediaUrl(pastedUrl.trim());
      if (!res.ok || !res.data?.ok) throw new Error(res.data?.error || 'Gagal memproses tautan.');
      setResolved(res.data);
    } catch (err) {
      setError(err?.message || 'Gagal memproses tautan.');
    } finally {
      setResolving(false);
    }
  };

  if (!resolved) {
    return (
      <div className="generate-field" style={{ marginTop: 8 }}>
        <p className="generate-hint" style={{ margin: 0 }}>
          Terdeteksi tautan {isTikTok ? 'TikTok' : 'Facebook'}. BLEA akan mencoba mengambil link unduhan langsungnya
          ({isTikTok ? 'via ssstik.io' : 'via getmyfb.com'}) — situs pihak ketiga ini tidak resmi dan bisa gagal/berubah sewaktu-waktu.
        </p>
        <button type="button" className="generate-select" style={{ marginTop: 6, cursor: 'pointer', width: 'auto' }} disabled={disabled || resolving} onClick={handleResolve}>
          {resolving ? 'Memproses tautan…' : 'Proses Tautan'}
        </button>
        {error && <p className="generate-hint" style={{ color: '#ff6b6b', marginTop: 6 }}>{error}</p>}
      </div>
    );
  }

  return (
    <TrimPanel
      kind={kind}
      sourceUrl={resolved.proxyUrl}
      via={resolved.via}
      quality={resolved.quality}
      userId={userId}
      disabled={disabled}
      baseName={resolved.platform || 'media'}
      onUseMedia={(media) => { onUseMedia(media); setResolved(null); }}
      onCancel={() => setResolved(null)}
    />
  );
}

// Dipasang di sebelah tombol "Hapus" pada kotak media yang sudah diunggah:
// memotong file yang sudah ada tanpa perlu melalui tahap resolve.
export function ExistingMediaCutTool({ kind, sourceUrl, userId, disabled, onUseMedia, onClose }) {
  if (!sourceUrl) return null;
  return (
    <TrimPanel
      kind={kind}
      sourceUrl={sourceUrl}
      userId={userId}
      disabled={disabled}
      showUseFull={false}
      baseName={`${kind}-upload`}
      onUseMedia={onUseMedia}
      onCancel={onClose}
    />
  );
}
