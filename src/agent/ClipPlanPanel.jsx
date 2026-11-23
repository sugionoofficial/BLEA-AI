import { useState } from 'react';
import { Check, Clapperboard, Loader2, Scissors, X } from 'lucide-react';
import { trimVideoToWebm } from '../lib/mediaTrim';
import { uploadAttachments } from '../lib/uploads';
import { fmtRange } from '../lib/clipPlanner';
import { sliceTranscript, toSrt } from '../lib/subtitles';
import { burnInSubtitles } from '../lib/subtitleBurnIn';

/**
 * Panel konfirmasi rencana klip. Pemotongan terjadi di sini, di browser, HANYA
 * setelah pengguna mencentang klip dan menekan tombol — bukan saat model
 * mengusulkan. Worker tidak punya ffmpeg, jadi re-encode berjalan lokal lalu
 * hasilnya diunggah ke storage.
 */
export function ClipPlanPanel({
  plan,
  client,
  userId,
  videoName,
  transcript = [],
  subtitleTemplate = 'boxed',
  subtitlePosition = 'bottom',
}) {
  const [selected, setSelected] = useState(() => new Set(plan.clips.map((clip) => clip.index)));
  const [working, setWorking] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  // Subtitle dibakar hanya untuk klip yang dipilih, satu per satu, dan hanya
  // kalau pengguna mencentang opsi ini. Biayanya realtime: klip 40 detik =
  // ~40 detik render.
  const [burnIn, setBurnIn] = useState(false);
  const [burnProgress, setBurnProgress] = useState(0);

  if (!plan?.sourceUrl) {
    return (
      <div className="agent-clips is-blocked">
        <p><Clapperboard size={13} /> Rencana klip butuh video yang diunggah lewat BLEA di pesan yang sama.</p>
      </div>
    );
  }

  const toggle = (index) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  /**
   * SRT per klip: timestamp transkrip digeser agar relatif terhadap awal klip,
   * sehingga subtitle yang diimpor CapCut langsung pas tanpa digeser manual.
   */
  function downloadClipSrt(clip) {
    const cues = sliceTranscript(transcript, clip.startSec, clip.endSec);
    if (!cues.length) return;
    const blob = new Blob([toSrt(cues)], { type: 'application/x-subrip' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(videoName || 'klip').replace(/\.[^.]+$/, '')}-${clip.index}.srt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function cutClips() {
    const chosen = plan.clips.filter((clip) => selected.has(clip.index));
    if (!chosen.length) {
      setError('Pilih minimal satu klip.');
      return;
    }
    const withSubtitles = burnIn && transcript.length > 0;
    setWorking(true);
    setError('');
    setResults([]);
    const out = [];
    try {
      for (const [position, clip] of chosen.entries()) {
        setProgress(position / chosen.length);
        setBurnProgress(0);
        let blob;
        if (withSubtitles) {
          const cues = sliceTranscript(transcript, clip.startSec, clip.endSec);
          // eslint-disable-next-line no-await-in-loop
          ({ blob } = await burnInSubtitles({
            sourceUrl: plan.sourceUrl,
            startSec: clip.startSec,
            endSec: clip.endSec,
            cues,
            words: [],
            template: subtitleTemplate,
            position: subtitlePosition,
            onProgress: (value) => setBurnProgress((position + value) / chosen.length),
          }));
        } else {
          // eslint-disable-next-line no-await-in-loop
          blob = await trimVideoToWebm(plan.sourceUrl, clip.startSec, clip.endSec);
        }
        // eslint-disable-next-line no-await-in-loop
        const { uploaded, failures } = await uploadAttachments({
          client,
          files: [new File(
            [blob],
            `${(videoName || 'klip').replace(/\.[^.]+$/, '')}-${clip.index}.${blob.type?.includes('mp4') ? 'mp4' : 'webm'}`,
            { type: blob.type || 'video/webm' },
          )],
          userId,
          folder: 'clips',
        });
        if (failures.length) throw new Error(failures[0].error);
        if (uploaded[0]) out.push({ ...uploaded[0], clip });
      }
      setProgress(1);
      setResults(out);
    } catch (err) {
      setError(err?.message || 'Pemotongan klip gagal.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="agent-clips">
      <header>
        <span className="agent-clips-title"><Scissors size={13} /> Rencana klip</span>
        <small>Perlu konfirmasi. Pemotongan berjalan di browser ini, bukan di server.</small>
      </header>

      <ul className="agent-clip-list">
        {plan.clips.map((clip) => (
          <li key={clip.index} className={selected.has(clip.index) ? 'is-selected' : ''}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(clip.index)}
                onChange={() => toggle(clip.index)}
                disabled={working}
              />
              <span className="agent-clip-range">{fmtRange(clip.startSec, clip.endSec)}</span>
              <span className="agent-clip-meta">
                <b>{clip.title || `Klip ${clip.index}`}</b>
                <small>{clip.durationSec}s · {clip.reason || 'tanpa alasan'}</small>
              </span>
            </label>
            {transcript.length > 0 && sliceTranscript(transcript, clip.startSec, clip.endSec).length > 0 && (
              <button
                type="button"
                className="agent-analysis-trigger agent-clip-srt"
                onClick={() => downloadClipSrt(clip)}
                title="Unduh subtitle klip ini (SRT, timestamp sudah relatif ke klip)"
              >
                SRT
              </button>
            )}
          </li>
        ))}
      </ul>

      {transcript.length > 0 ? (
        <label className="agent-clip-burnin">
          <input
            type="checkbox"
            checked={burnIn}
            onChange={() => setBurnIn((value) => !value)}
            disabled={working}
          />
          <span>
            <b>Bakar subtitle ke video</b>
            <small>
              Realtime: klip 40 detik butuh ~40 detik. Kualitas turun karena re-encode,
              dan tab harus tetap terbuka. Tanpa centang ini, klip dipotong tanpa subtitle
              (SRT tetap bisa diunduh).
            </small>
          </span>
        </label>
      ) : (
        <p className="agent-clip-burnin-hint">
          Buat transkrip dulu di panel atas untuk bisa membakar subtitle ke video.
        </p>
      )}

      {error && <p className="agent-clips-error"><X size={11} /> {error}</p>}

      {results.length > 0 && (
        <div className="agent-clip-results">
          <p><Check size={12} /> {results.length} klip selesai. Bisa diunduh atau dipakai sebagai input video.</p>
          <ul>
            {results.map((result) => (
              <li key={result.id}>
                <a href={result.url} target="_blank" rel="noopener noreferrer">{result.name}</a>
                <span>{fmtRange(result.clip.startSec, result.clip.endSec)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="agent-clip-actions">
        {working && (
          <span className="agent-clip-progress" role="status">
            <Loader2 size={12} className="agent-spin" />
            {burnIn && transcript.length > 0
              ? `Merender subtitle… ${Math.round(burnProgress * 100)}%`
              : `Memotong… ${Math.round(progress * 100)}%`}
          </span>
        )}
        <button type="button" className="agent-send" onClick={cutClips} disabled={working || !selected.size}>
          <span>{burnIn && transcript.length > 0 ? `Render ${selected.size} klip + subtitle` : `Potong ${selected.size} klip`}</span>
          <Scissors size={13} />
        </button>
      </div>
    </div>
  );
}
