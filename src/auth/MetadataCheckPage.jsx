import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coins,
  Download,
  Eraser,
  FileSearch2,
  Film,
  History,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import {
  buildDownloadFilename,
  processMetadataClean,
  startMetadataClean,
  withDownloadParam,
} from '../api/generation';
import { DropXLayout } from '../dropx/DropXLayout';
import { formatCredits } from '../lib/formatCredits';
import {
  METADATA_MAX_FILE_BYTES,
  METADATA_SERVICE_COST,
  compactScanSummary,
  formatBytesCompact,
  scanMediaMetadata,
} from '../lib/mediaMetadata';
import { supabase } from '../lib/supabase';
import { useCredits } from '../lib/useCredits';
import { useAuth } from './AuthProvider';
import './metadata.css';

const ACCEPTED_TYPES =
  'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm';

const DIRECT_UPLOAD_LIMIT = 12 * 1024 * 1024; // 12 MB via FormData; >12 MB via Storage

export function MetadataCheckPage() {
  const { user } = useAuth();
  const { balance: credits, refresh: refreshCredits } = useCredits(user?.id);
  const creditsLoading = credits === null;
  const fileInputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [mediaKind, setMediaKind] = useState('image');
  const [phase, setPhase] = useState('idle'); // idle | ready | scanning | scanned | removing | cleaned
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const [cleanResult, setCleanResult] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function resetAll() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl('');
    setMediaKind('image');
    setPhase('idle');
    setProgress(0);
    setProgressLabel('');
    setScanResult(null);
    setCleanResult(null);
    setError('');
    setNotice('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function selectFile(picked) {
    if (!picked) return;
    setError('');
    setNotice('');
    setScanResult(null);
    setCleanResult(null);
    setProgress(0);
    setProgressLabel('');

    if (picked.size <= 0) {
      setError('File kosong tidak dapat dipindai.');
      return;
    }
    if (picked.size > METADATA_MAX_FILE_BYTES) {
      setError(`Ukuran file terlalu besar (${formatBytesCompact(picked.size)}). Batas maksimal adalah ${Math.round(METADATA_MAX_FILE_BYTES / (1024 * 1024))} MB.`);
      return;
    }

    const isVideo = picked.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(picked.name || '');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
    setMediaKind(isVideo ? 'video' : 'image');
    setPhase('ready');
  }

  async function handleScan() {
    if (!file || phase === 'scanning' || phase === 'removing') return;
    setError('');
    setNotice('');
    setPhase('scanning');
    setProgress(35);
    setProgressLabel('Membaca struktur biner & header media…');

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      setProgress(75);
      setProgressLabel('Memeriksa EXIF, XMP, C2PA, dan tanda tangan AI…');
      const report = await scanMediaMetadata(bytes, {
        fileName: file.name,
        mimeType: file.type,
      });

      if (!report.supported) {
        setPhase('ready');
        setProgress(0);
        setProgressLabel('');
        setError(report.error || 'Format file tidak didukung.');
        return;
      }

      setMediaKind(report.mediaKind);
      setScanResult(report);
      setPhase('scanned');
      setProgress(100);
      setProgressLabel('');
    } catch (err) {
      setPhase('ready');
      setProgress(0);
      setProgressLabel('');
      setError(`Gagal memindai file: ${String(err?.message || err)}`);
    }
  }

  async function handleRemove() {
    if (!file || !scanResult || phase === 'removing') return;
    setError('');
    setNotice('');

    if (credits !== null && credits < METADATA_SERVICE_COST) {
      setError(`Saldo kredit BLEA Anda (${formatCredits(credits)} kredit) tidak mencukupi. Dibutuhkan ${METADATA_SERVICE_COST} kredit untuk menghapus metadata.`);
      return;
    }

    setPhase('removing');
    setProgress(15);
    setProgressLabel(`Memotong ${METADATA_SERVICE_COST} kredit & mendaftarkan proses ke Proses Live…`);

    let storageInputPath = '';
    try {
      const startRes = await startMetadataClean({
        filename: file.name,
        mime_type: scanResult.mimeType || file.type || '',
        media_kind: scanResult.mediaKind || mediaKind,
        original_size: file.size,
        scan_before: compactScanSummary(scanResult),
      });

      if (!startRes.ok || !startRes.data?.job?.id) {
        setPhase('scanned');
        setProgress(0);
        setProgressLabel('');
        setError(startRes.data?.error || 'Tidak dapat memulai pembersihan metadata.');
        refreshCredits();
        return;
      }

      refreshCredits();
      const jobId = startRes.data.job.id;
      setProgress(40);
      setProgressLabel('Mengunggah media & menghapus seluruh metadata AI secara lossless…');

      let processRes;
      if (file.size <= DIRECT_UPLOAD_LIMIT) {
        processRes = await processMetadataClean({
          id: jobId,
          file,
          filename: file.name,
          mimeType: scanResult.mimeType || file.type || '',
        });
      } else {
        if (!user?.id) throw new Error('Sesi login diperlukan untuk mengunggah file besar.');
        const safeName = String(file.name || 'media').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
        storageInputPath = `${user.id}/metadata-inputs/${jobId}-${safeName}`;
        const { error: upErr } = await supabase.storage
          .from('ai-studio-uploads')
          .upload(storageInputPath, file, { contentType: scanResult.mimeType || file.type || 'application/octet-stream', upsert: true });
        if (upErr) {
          throw new Error(`Gagal mengunggah file sementara: ${upErr.message}`);
        }
        setProgress(65);
        setProgressLabel('Menghapus metadata AI & memverifikasi hasil bersih…');
        processRes = await processMetadataClean({
          id: jobId,
          storagePath: storageInputPath,
          filename: file.name,
          mimeType: scanResult.mimeType || file.type || '',
        });
      }

      if (!processRes.ok || !processRes.data?.job) {
        setPhase('scanned');
        setProgress(0);
        setProgressLabel('');
        setError(processRes.data?.error || 'Gagal membersihkan metadata. Jika kredit sempat terpotong, refund otomatis diproses.');
        refreshCredits();
        return;
      }

      setProgress(100);
      setProgressLabel('Pembersihan selesai! File bersih siap diunduh.');
      setCleanResult(processRes.data);
      setPhase('cleaned');
      setNotice(`Berhasil membersihkan ${processRes.data.removedCount ?? scanResult.totalEntries} metadata (${METADATA_SERVICE_COST} kredit BLEA). Riwayat & file bersih tersimpan di History.`);
      refreshCredits();
    } catch (err) {
      setPhase('scanned');
      setProgress(0);
      setProgressLabel('');
      setError(String(err?.message || err || 'Gagal memproses pembersihan metadata.'));
      refreshCredits();
    }
  }

  function handleDownload() {
    const job = cleanResult?.job;
    const rawUrl = job?.download_url || job?.result_url;
    if (!rawUrl) return;
    const downloadUrl = withDownloadParam(rawUrl);
    const cleanName = buildDownloadFilename({
      kind: 'metadata',
      id: job.id,
      filename: job.filename || file?.name || 'media',
      mimeType: job.mime_type || scanResult?.mimeType || file?.type || '',
      url: downloadUrl,
    });
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = cleanName;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  function handlePrimaryAction() {
    if (phase === 'idle') {
      fileInputRef.current?.click();
      return;
    }
    if (phase === 'ready') {
      handleScan();
      return;
    }
    if (phase === 'scanned') {
      if (scanResult?.removable) {
        handleRemove();
      } else {
        fileInputRef.current?.click();
      }
      return;
    }
    if (phase === 'cleaned') {
      handleDownload();
    }
  }

  const canAfford = credits === null || credits >= METADATA_SERVICE_COST;
  const activeStep = phase === 'idle' ? 1
    : (phase === 'ready' || phase === 'scanning') ? 2
      : (phase === 'scanned' || phase === 'removing') ? 3
        : 4;

  const primaryButtonConfig = (() => {
    if (phase === 'idle') {
      return { label: 'Pilih Gambar / Video', icon: Upload, disabled: false, tone: 'default' };
    }
    if (phase === 'ready') {
      return { label: 'Scan Metadata', icon: FileSearch2, disabled: false, tone: 'default' };
    }
    if (phase === 'scanning') {
      return { label: 'Memindai Metadata…', icon: Loader2, disabled: true, spin: true, tone: 'default' };
    }
    if (phase === 'scanned') {
      if (!scanResult?.removable) {
        return { label: 'Upload File Lain', icon: Upload, disabled: false, tone: 'default' };
      }
      return {
        label: `Remove Metadata (${METADATA_SERVICE_COST} Kredit)`,
        icon: Eraser,
        disabled: !canAfford,
        tone: 'remove',
      };
    }
    if (phase === 'removing') {
      return { label: `Membersihkan… (${progress}%)`, icon: Loader2, disabled: true, spin: true, tone: 'remove' };
    }
    return { label: 'Download Hasil Bersih', icon: Download, disabled: false, tone: 'download' };
  })();

  const PrimaryIcon = primaryButtonConfig.icon;
  const cleanedPreviewSrc = cleanResult?.job?.result_url || previewUrl;

  return (
    <DropXLayout
      title="Cek Metadata AI"
      description="Pindai gambar atau video untuk mendeteksi jejak metadata buatan AI (C2PA, EXIF, XMP, ComfyUI, Sora, Wan) dan bersihkan secara lossless."
    >
      <div className="meta-page">
        <section className="meta-hero">
          <div className="meta-hero-main">
            <div className="meta-hero-badges">
              <span className="meta-chip is-brand">
                <FileSearch2 size={13} aria-hidden="true" />
                AI Metadata Inspector &amp; Cleaner
              </span>
              <span className="meta-chip is-cost">
                <Coins size={13} aria-hidden="true" />
                Scan Gratis · Remove {METADATA_SERVICE_COST} Kredit
              </span>
            </div>
            <p className="meta-hero-desc">
              Unggah gambar (<strong>PNG, JPG, WebP, GIF</strong>) atau video (<strong>MP4, MOV, WebM</strong>) maksimal{' '}
              <strong>{Math.round(METADATA_MAX_FILE_BYTES / (1024 * 1024))} MB</strong>. Pembersihan menghapus metadata EXIF, XMP, IPTC, C2PA,
              dan tag AI tanpa re-encoding kualitas visual, tercatat otomatis di <Link to="/live">Proses Live</Link> dan{' '}
              <Link to="/history">History</Link>.
            </p>
          </div>
          <div className="meta-hero-side">
            <div className="meta-balance-box">
              <span className="meta-balance-label">Saldo Kredit Anda</span>
              <strong className="meta-balance-val">
                {creditsLoading ? '…' : formatCredits(credits ?? 0)} kredit
              </strong>
              {!creditsLoading && !canAfford && (
                <Link className="meta-topup-link" to="/credits">Isi kredit →</Link>
              )}
            </div>
          </div>
        </section>

        <ol className="meta-steps" aria-label="Alur pemeriksaan metadata">
          <li className={`meta-step ${file ? 'is-done' : activeStep === 1 ? 'is-active' : ''}`}>
            <span>1</span> Upload Media
          </li>
          <li className={`meta-step ${scanResult ? 'is-done' : activeStep === 2 ? 'is-active' : ''}`}>
            <span>2</span> Scan Metadata
          </li>
          <li className={`meta-step ${phase === 'cleaned' ? 'is-done' : activeStep === 3 ? 'is-active' : ''}`}>
            <span>3</span> Remove AI ({METADATA_SERVICE_COST} Kredit)
          </li>
          <li className={`meta-step ${phase === 'cleaned' ? 'is-done is-active' : ''}`}>
            <span>4</span> Download Bersih
          </li>
        </ol>

        {error && (
          <div className="meta-alert is-error" role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <div>
              <strong>Terjadi masalah:</strong> {error}
              {!canAfford && (
                <>
                  {' '}
                  <Link to="/credits">Buka halaman Kredit</Link>
                </>
              )}
            </div>
          </div>
        )}

        {notice && (
          <div className="meta-alert is-success" role="status">
            <CheckCircle2 size={16} aria-hidden="true" />
            <div>
              {notice}{' '}
              {cleanResult?.job?.id && (
                <Link to={`/history?highlight=${encodeURIComponent(cleanResult.job.id)}`}>
                  Lihat di History →
                </Link>
              )}
            </div>
          </div>
        )}

        <div className="meta-grid">
          {/* Left Panel: Upload, Preview & Unified Primary Action Button */}
          <section className="meta-card">
            <div className="meta-card-head">
              <h2>
                {file ? (mediaKind === 'video' ? <Film size={17} aria-hidden="true" /> : <ImageIcon size={17} aria-hidden="true" />) : <Upload size={17} aria-hidden="true" />}
                {file ? 'Media Terpilih' : 'Upload Gambar / Video'}
              </h2>
              {file && phase !== 'removing' && phase !== 'scanning' && (
                <button type="button" className="meta-reset-btn" onClick={resetAll}>
                  <RefreshCw size={13} aria-hidden="true" />
                  Ganti File
                </button>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES}
              className="meta-file-input"
              aria-label="Pilih file gambar atau video"
              onChange={(e) => selectFile(e.target.files?.[0])}
            />

            {!file ? (
              <div
                className={`meta-dropzone ${dragActive ? 'is-drag' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  selectFile(e.dataTransfer?.files?.[0]);
                }}
              >
                <div className="meta-drop-icon" aria-hidden="true">
                  <Upload size={26} />
                </div>
                <strong>Seret &amp; lepas gambar atau video di sini</strong>
                <span>atau klik untuk memilih file dari perangkat Anda</span>
                <small>PNG · JPG/JPEG · WebP · GIF · MP4 · MOV · WebM (maks 30 MB)</small>
              </div>
            ) : (
              <div className="meta-preview-wrap">
                <div className="meta-preview-box">
                  {mediaKind === 'video' ? (
                    <video src={cleanedPreviewSrc} controls preload="metadata" />
                  ) : (
                    <img src={cleanedPreviewSrc} alt={file.name} />
                  )}
                </div>
                <div className="meta-file-meta">
                  <strong className="meta-file-name" title={file.name}>{file.name}</strong>
                  <span>
                    {scanResult?.formatLabel || (mediaKind === 'video' ? 'Video' : 'Gambar')} · Asli{' '}
                    {formatBytesCompact(file.size)}
                    {cleanResult?.job?.cleaned_size
                      ? ` → Bersih ${formatBytesCompact(cleanResult.job.cleaned_size)}`
                      : ''}
                  </span>
                </div>
              </div>
            )}

            {(phase === 'scanning' || phase === 'removing') && (
              <div className="meta-progress-box" role="status">
                <div className="meta-progress-head">
                  <span>{progressLabel || 'Memproses…'}</span>
                  <strong>{progress}%</strong>
                </div>
                <div className="meta-progress-track">
                  <div className="meta-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                {phase === 'removing' && (
                  <div className="meta-live-hint">
                    <Activity size={13} aria-hidden="true" />
                    <span>Progres aktif juga ditampilkan di</span>
                    <Link to="/live">Halaman Proses Live →</Link>
                  </div>
                )}
              </div>
            )}

            <div className="meta-action-footer">
              <button
                type="button"
                data-testid="metadata-primary-action"
                className={`meta-primary-btn is-${primaryButtonConfig.tone}`}
                disabled={primaryButtonConfig.disabled}
                onClick={handlePrimaryAction}
              >
                <PrimaryIcon size={17} className={primaryButtonConfig.spin ? 'is-spin' : ''} aria-hidden="true" />
                <span>{primaryButtonConfig.label}</span>
              </button>

              {phase === 'scanned' && scanResult?.removable && !canAfford && (
                <p className="meta-cost-warning">
                  Saldo kredit Anda belum cukup untuk pembersihan ({METADATA_SERVICE_COST} kredit).{' '}
                  <Link to="/credits">Beli / isi kredit</Link>
                </p>
              )}

              {phase === 'cleaned' && cleanResult?.job && (
                <div className="meta-quick-links">
                  <Link to={`/history?highlight=${encodeURIComponent(cleanResult.job.id)}`}>
                    <History size={14} aria-hidden="true" />
                    Buka di History
                  </Link>
                  <Link to="/live">
                    <Activity size={14} aria-hidden="true" />
                    Lihat Proses Live
                  </Link>
                </div>
              )}
            </div>
          </section>

          {/* Right Panel: Scan Report & Verified After-Clean Result */}
          <section className="meta-card">
            <div className="meta-card-head">
              <h2>
                <FileSearch2 size={17} aria-hidden="true" />
                Hasil Scan Metadata
              </h2>
              {scanResult && (
                <span
                  className={`meta-verdict-pill ${
                    phase === 'cleaned'
                      ? 'is-clean'
                      : scanResult.aiDetected
                        ? 'is-ai'
                        : scanResult.totalEntries > 0
                          ? 'is-warn'
                          : 'is-clean'
                  }`}
                >
                  {phase === 'cleaned' ? (
                    <>
                      <ShieldCheck size={13} aria-hidden="true" />
                      Bersih Terverifikasi
                    </>
                  ) : scanResult.aiDetected ? (
                    <>
                      <ShieldAlert size={13} aria-hidden="true" />
                      Metadata AI Terdeteksi
                    </>
                  ) : scanResult.totalEntries > 0 ? (
                    <>
                      <AlertTriangle size={13} aria-hidden="true" />
                      Metadata Standar ({scanResult.totalEntries})
                    </>
                  ) : (
                    <>
                      <ShieldCheck size={13} aria-hidden="true" />
                      Tidak Ada Metadata AI
                    </>
                  )}
                </span>
              )}
            </div>

            {!scanResult ? (
              <div className="meta-empty-report">
                <FileSearch2 size={30} aria-hidden="true" />
                <h3>Belum ada hasil scan</h3>
                <p>
                  {file
                    ? 'Klik tombol "Scan Metadata" untuk memeriksa apakah file ini mengandung jejak generator AI, Content Credentials (C2PA), EXIF, atau XMP.'
                    : 'Unggah gambar atau video terlebih dahulu lalu tekan Scan Metadata.'}
                </p>
                <ul className="meta-detect-list">
                  <li>C2PA / Content Credentials (JUMBF, caBX, OpenAI Sora / DALL-E)</li>
                  <li>Alibaba Wan / Qwen AIGC, Kling, Seedance, Hailuo, Runway</li>
                  <li>ComfyUI workflow JSON, Stable Diffusion parameters, Midjourney</li>
                  <li>Google Veo / Imagen / SynthID, IPTC DigitalSourceType, EXIF &amp; XMP</li>
                </ul>
              </div>
            ) : (
              <div className="meta-report-body">
                {phase === 'cleaned' && cleanResult && (
                  <div className="meta-cleaned-summary">
                    <div className="meta-cleaned-stat">
                      <span>Metadata Sebelum</span>
                      <strong>{scanResult.totalEntries} item ({scanResult.aiEntriesCount} AI)</strong>
                    </div>
                    <div className="meta-cleaned-stat">
                      <span>Berhasil Dihapus</span>
                      <strong>{cleanResult.removedCount ?? scanResult.totalEntries} item</strong>
                    </div>
                    <div className="meta-cleaned-stat">
                      <span>Verifikasi Setelah</span>
                      <strong className="is-clean-txt">
                        {cleanResult.after?.aiDetected
                          ? 'Masih ada sisa'
                          : `${cleanResult.after?.totalEntries ?? 0} tersisa · Bersih`}
                      </strong>
                    </div>
                  </div>
                )}

                {scanResult.aiDetected ? (
                  <div className="meta-ai-box">
                    <div className="meta-ai-box-head">
                      <ShieldAlert size={18} aria-hidden="true" />
                      <div>
                        <strong>Terdeteksi Metadata Buatan AI</strong>
                        <p>
                          Ditemukan {scanResult.aiEntriesCount} indikator AI dari total {scanResult.totalEntries} entri metadata.
                          Klik tombol <strong>Remove Metadata ({METADATA_SERVICE_COST} Kredit)</strong> untuk membersihkan lalu unduh hasilnya.
                        </p>
                      </div>
                    </div>
                    {scanResult.detectedTools.length > 0 && (
                      <div className="meta-tool-chips">
                        {scanResult.detectedTools.map((tool) => (
                          <span className="meta-tool-chip" key={tool}>{tool}</span>
                        ))}
                      </div>
                    )}
                    {scanResult.aiSignals.length > 0 && (
                      <ul className="meta-reasons">
                        {scanResult.aiSignals.map((reason) => (
                          <li key={reason}>{reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : scanResult.totalEntries > 0 ? (
                  <div className="meta-warn-box">
                    <AlertTriangle size={17} aria-hidden="true" />
                    <div>
                      <strong>Tidak ditemukan tanda khusus buatan AI</strong>
                      <p>
                        Namun file ini memiliki {scanResult.totalEntries} metadata standar (EXIF / XMP / Tag Container). Anda tetap dapat
                        menghapus semua metadata tersebut ({METADATA_SERVICE_COST} kredit).
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="meta-clean-box">
                    <ShieldCheck size={18} aria-hidden="true" />
                    <div>
                      <strong>File sudah bersih</strong>
                      <p>Tidak ada metadata AI, C2PA, EXIF, XMP, atau tag tersembunyi yang terdeteksi pada media ini.</p>
                    </div>
                  </div>
                )}

                {scanResult.entries.length > 0 && (
                  <div className="meta-entries-wrap">
                    <div className="meta-entries-head">
                      <h3>Detail Metadata Terdeteksi ({scanResult.entries.length})</h3>
                      {phase === 'cleaned' && <span className="meta-stripped-note">Semua item berikut telah dihapus</span>}
                    </div>
                    <div className="meta-entries-list">
                      {scanResult.entries.map((entry, idx) => (
                        <div className={`meta-entry ${entry.isAi ? 'is-ai' : ''} ${phase === 'cleaned' ? 'is-removed' : ''}`} key={`${entry.group}-${entry.key}-${idx}`}>
                          <div className="meta-entry-top">
                            <span className="meta-entry-group">{entry.group}</span>
                            <code className="meta-entry-key">{entry.key}</code>
                            {entry.isAi && <span className="meta-entry-ai-tag">AI Indicator</span>}
                          </div>
                          <p className="meta-entry-val">{entry.value}</p>
                          <span className="meta-entry-loc">{entry.location}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </DropXLayout>
  );
}

export default MetadataCheckPage;
