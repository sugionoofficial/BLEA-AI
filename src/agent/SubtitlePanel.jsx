import { useMemo, useState } from 'react';
import { Check, Download, Loader2, Pencil, Subtitles, X } from 'lucide-react';
import { SUBTITLE_TEMPLATES, sliceTranscript, toPlainText, toSrt, toVtt } from '../lib/subtitles';

/**
 * Panel transkrip + subtitle untuk satu lampiran video/audio.
 *
 * Dua hal yang disengaja:
 *   1. Transkrip bisa diedit. Whisper salah pada slang Indonesia dan nama merek,
 *      dan kesalahan itu tidak boleh masuk ke subtitle final tanpa bisa dicek.
 *   2. Belum ada burn-in. Yang diekspor adalah SRT/VTT, yang bisa langsung
 *      diimpor CapCut/TikTok/YouTube. Encoder canvas realtime belum dibangun
 *      karena hasilnya lebih buruk dan akan diganti begitu provider server-side
 *      tersedia.
 */
export function SubtitlePanel({ source, transcript, onTranscript, status, progress, onTranscribe, template, onTemplate }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const segments = transcript?.segments || [];
  const cues = useMemo(() => sliceTranscript(segments, 0, transcript?.durationSec || 1e9), [segments, transcript]);

  const srt = useMemo(() => (segments.length ? toSrt(segments) : ''), [segments]);
  const vtt = useMemo(() => (segments.length ? toVtt(segments) : ''), [segments]);

  const baseName = String(source?.name || 'transkrip').replace(/\.[^.]+$/, '');

  function download(text, extension, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${baseName}.${extension}`;
    link.click();
    // Ditunda supaya klik sempat diproses di Safari.
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function startEdit() {
    setDraft(toPlainText(segments));
    setEditing(true);
  }

  /**
   * Hasil edit dipetakan balik ke segmen: jumlah baris boleh berbeda (pengguna
   * menghapus/menambah baris), jadi dipetakan berurutan dan segmen berlebih
   * dibuang. Timestamp segmen yang tersisa tidak diubah — menggeser waktu
   * secara otomatis dari panjang teks akan lebih sering salah daripada benar.
   */
  function commitEdit() {
    const lines = draft.split('\n').map((line) => line.trim()).filter(Boolean);
    const next = segments.slice(0, lines.length).map((segment, index) => ({ ...segment, text: lines[index] }));
    onTranscript?.({ ...transcript, segments: next, text: next.map((s) => s.text).join(' ') });
    setEditing(false);
  }

  return (
    <div className="agent-clips agent-subtitles">
      <header>
        <span className="agent-clips-title"><Subtitles size={13} /> Transkrip &amp; subtitle</span>
        <small>
          Whisper mendengarkan audio video ini. Timestamp per kata. Ekspor SRT/VTT bisa langsung
          diimpor CapCut/TikTok — belum ada burn-in ke dalam video.
        </small>
      </header>

      {status === 'running' && (
        <p className="agent-clip-progress" role="status">
          <Loader2 size={12} className="agent-spin" /> Mentranskripsi… {Math.round((progress || 0) * 100)}%
        </p>
      )}

      {status === 'error' && transcript?.error && (
        <p className="agent-clips-error"><X size={11} /> {transcript.error}</p>
      )}

      {status === 'idle' && !segments.length && (
        <div className="agent-clip-actions">
          <button type="button" className="agent-send" onClick={onTranscribe}>
            <span>Buat transkrip</span>
            <Subtitles size={13} />
          </button>
        </div>
      )}

      {segments.length > 0 && (
        <>
          <ul className="agent-subtitle-list">
            {cues.slice(0, 8).map((cue) => (
              <li key={`${cue.startSec}-${cue.text}`}>
                <span className="agent-clip-range">{cue.startSec.toFixed(1)}s</span>
                <span className="agent-clip-meta"><b>{cue.text}</b></span>
              </li>
            ))}
            {cues.length > 8 && <li className="agent-subtitle-more">+{cues.length - 8} baris lagi</li>}
          </ul>

          <div className="agent-subtitle-templates">
            {SUBTITLE_TEMPLATES.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`agent-subtitle-template ${template === item.id ? 'is-active' : ''}`}
                onClick={() => onTemplate?.(item.id)}
                title={item.note}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="agent-subtitle-hint">
            {SUBTITLE_TEMPLATES.find((item) => item.id === template)?.note || ''}
          </p>

          {editing ? (
            <div className="agent-subtitle-edit">
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={Math.min(12, Math.max(4, draft.split('\n').length))}
              />
              <div className="agent-clip-actions">
                <button type="button" className="agent-send" onClick={commitEdit}>
                  <span>Simpan transkrip</span>
                  <Check size={13} />
                </button>
                <button type="button" className="agent-analysis-trigger" onClick={() => setEditing(false)}>Batal</button>
              </div>
            </div>
          ) : (
            <div className="agent-clip-actions">
              <button type="button" className="agent-analysis-trigger" onClick={startEdit}>
                <Pencil size={11} /> Edit transkrip
              </button>
              <button type="button" className="agent-analysis-trigger" onClick={() => download(srt, 'srt', 'application/x-subrip')}>
                <Download size={11} /> SRT
              </button>
              <button type="button" className="agent-analysis-trigger" onClick={() => download(vtt, 'vtt', 'text/vtt')}>
                <Download size={11} /> VTT
              </button>
            </div>
          )}

          {transcript?.failures?.length > 0 && (
            <p className="agent-clips-error">
              <X size={11} /> {transcript.failures.length} potongan audio gagal ditranskripsi; transkrip tidak lengkap.
            </p>
          )}
        </>
      )}
    </div>
  );
}
