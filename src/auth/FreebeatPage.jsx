import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Link2, RefreshCw, ShieldCheck, Unplug } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { FreebeatImageForm } from './FreebeatImageForm';
import { FreebeatTaskResult } from './FreebeatTaskResult';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { FreebeatDanceDiagnostic } from './FreebeatDanceDiagnostic';
import { FreebeatSingingLipSyncDiagnostic } from './FreebeatSingingLipSyncDiagnostic';
import { FreebeatVideoDiagnostic } from './FreebeatVideoDiagnostic';
import { FreebeatHailuoDiagnostic } from './FreebeatHailuoDiagnostic';
import { FreebeatLtxDiagnostic } from './FreebeatLtxDiagnostic';
import { FreebeatVocalSchemaDiagnostic } from './FreebeatVocalSchemaDiagnostic';
import { FreebeatRemainingSchemaDiagnostic } from './FreebeatRemainingSchemaDiagnostic';
import { FreebeatCatalogInspector } from './FreebeatCatalogInspector';
import { FreebeatRemainingQuoteProbe } from './FreebeatRemainingQuoteProbe';
import { FreebeatMusicDiagnostic } from './FreebeatMusicDiagnostic';
import { useAuth } from './AuthProvider';
import { supabase } from '../lib/supabase';
import { freebeatRequest as request } from '../api/freebeat';
import { uploadFreebeatImage, deleteFreebeatImage } from '../lib/freebeatVideoUpload';
import { FREEBEAT_EXPERIMENTS, FREEBEAT_EXPERIMENT_CATEGORIES, freebeatExperimentPath } from './freebeatExperiments';
import './freebeat.css';

const resultMessage = {
  connected: 'Otorisasi Freebeat berhasil. Tekan Periksa saldo untuk menguji MCP.',
  'connected-limited': 'Freebeat hanya memberikan izin baca. Izin generasi belum diberikan; saldo dan pemeriksaan model tetap dapat dicoba.',
  denied: 'Otorisasi dibatalkan atau ditolak oleh Freebeat.',
  invalid: 'Sesi otorisasi tidak cocok atau kedaluwarsa. Coba hubungkan kembali.',
  failed: 'Otorisasi Freebeat tidak berhasil. Coba lagi atau periksa akses akun Anda.',
  'failed-network': 'Worker tidak dapat terhubung ke Freebeat saat penukaran token. [FB-TOKEN-NETWORK]',
  'failed-timeout': 'Freebeat tidak merespons saat penukaran token. [FB-TOKEN-TIMEOUT]',
  'failed-redirect': 'Freebeat mengirim pengalihan token yang tidak didukung atau tidak aman. [FB-TOKEN-REDIRECT]',
  'failed-http': 'Freebeat menolak penukaran token. [FB-TOKEN-HTTP]',
  'failed-response': 'Respons token Freebeat tidak valid. [FB-TOKEN-RESPONSE]',
};

export function FreebeatPage() {
  const { experimentId = '' } = useParams();
  const experiment = FREEBEAT_EXPERIMENTS.find((item) => item.id === experimentId);
  if (experimentId && !experiment) return <DropXLayout title="Percobaan tidak ditemukan"><div className="freebeat-page freebeat-card"><h2>Percobaan Freebeat tidak ditemukan</h2><Link to="/admin/freebeat">Kembali ke Freebeat MCP</Link></div></DropXLayout>;
  // Route changes deliberately unmount forms, private responses and approvals.
  // OAuth remains in its encrypted cookie/server session, not in page state.
  return <FreebeatWorkspace key={experimentId || 'home'} experiment={experiment || null} />;
}

function FreebeatWorkspace({ experiment }) {
  const page = experiment?.id || 'home';
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [imageAccess, setImageAccess] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState(null);
  const [autoRenew, setAutoRenew] = useState(false);
  const [balance, setBalance] = useState(null);
  const [balanceCheck, setBalanceCheck] = useState('unchecked');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageModels, setImageModels] = useState(null);
  const [imageEditModels, setImageEditModels] = useState(null);
  const [imageHelpModel, setImageHelpModel] = useState('202');
  const [imageHelp, setImageHelp] = useState(null);
  const [imageHelpConsent, setImageHelpConsent] = useState(false);
  const [imageHelpType, setImageHelpType] = useState('image');
  const [probeModel, setProbeModel] = useState('202');
  const [probeFile, setProbeFile] = useState(null);
  const [probeUrl, setProbeUrl] = useState('');
  const [probePath, setProbePath] = useState('');
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeError, setProbeError] = useState('');
  const [probeResult, setProbeResult] = useState(null);
  const [jobId, setJobId] = useState('');
  const [jobConsent, setJobConsent] = useState(false);
  const [jobResult, setJobResult] = useState(null);
  const [uploadQuote, setUploadQuote] = useState(null);
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadConsent, setUploadConsent] = useState(false);
  const [imageSchemas, setImageSchemas] = useState(null);
  const [videoModels, setVideoModels] = useState(null);
  const [videoSchemas, setVideoSchemas] = useState(null);
  const [videoError, setVideoError] = useState('');
  const [videoBusy, setVideoBusy] = useState(false);
  const videoRequestVersion = useRef(0);
  const [quoteModel, setQuoteModel] = useState('');
  const [quotePrompt, setQuotePrompt] = useState('');
  const [imageQuote, setImageQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [approval, setApproval] = useState(null);
  const [spendConfirmed, setSpendConfirmed] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState('');
  const [testNotice, setTestNotice] = useState('');
  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const load = useCallback(async () => {
    try { const result = await request('status'); setBalanceCheck('unchecked'); setConnected(result.connected); setImageAccess(result.imageAccess === true); setExpiresAt(result.expiresAt); setSessionExpiresAt(result.sessionExpiresAt || null); setAutoRenew(result.autoRenew === true); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('freebeat');
    if (result && resultMessage[result]) {
      if (result === 'connected') setNotice(resultMessage[result]); else setError(resultMessage[result]);
      url.searchParams.delete('freebeat');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    load();
  }, [load]);
  async function run(action) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'start') {
        const result = await request(action, 'POST');
        const url = new URL(result.url);
        if (url.origin !== 'https://freebeat.ai' || url.pathname !== '/oauth/authorize') throw new Error('Alamat otorisasi Freebeat tidak valid.');
        window.location.assign(url.toString());
        return;
      }
      if (action === 'balance') {
        const result = await request('balance', 'POST');
        setBalance(result.balance);
        setBalanceCheck('verified');
        setNotice('Permintaan baca saldo selesai tanpa menjalankan generasi.');
      } else {
        const result = await request('disconnect', 'POST');
        setBalanceCheck('unchecked'); setConnected(false); setImageAccess(false); setExpiresAt(null); setBalance(null); setImageModels(null); setImageSchemas(null); setVideoModels(null); setVideoSchemas(null); setVideoError(''); setImageQuote(null); setApproval(null); setSpendConfirmed(false); setTests([]); setTaskResults({});
        setNotice(result.revoked ? 'Koneksi lokal dihapus dan token dicabut di Freebeat.' : 'Koneksi lokal dihapus. Pencabutan token di Freebeat belum dapat dikonfirmasi; periksa pengaturan akses di akun Freebeat.');
      }
    } catch (err) {
      if (action === 'balance') { setBalanceCheck('failed'); setBalance(null); }
      setError(err.message || 'Koneksi gagal.');
    }
    finally { setBusy(false); }
  }
  async function inspectImages(action) {
    if (imageBusy) return;
    setImageBusy(true); setImageError('');
    if (action === 'image-models') setImageModels(null); else if (action === 'image-edit-models') setImageEditModels(null); else setImageSchemas(null);
    try {
      const result = await request(action, 'POST');
      if (action === 'image-models') setImageModels(result); else if (action === 'image-edit-models') setImageEditModels(result); else setImageSchemas(result);
    } catch (err) { setImageError(err.message || 'Pemeriksaan gambar gagal.'); }
    finally { setImageBusy(false); }
  }
  async function inspectImageHelp(raw) {
    if (imageBusy) return;
    const modelId = Number(imageHelpModel);
    if (!Number.isSafeInteger(modelId) || modelId < 0) { setImageError('Masukkan ID model gambar yang valid.'); return; }
    setImageBusy(true); setImageError(''); setImageHelp(null);
    try {
      const result = await request('image-model-help', 'POST', { model_id: modelId, type: imageHelpType, ...(raw ? { acknowledge: true } : {}) });
      setImageHelp(result);
    } catch (err) { setImageError(err.message || 'Pemeriksaan informasi model gagal.'); }
    finally { setImageBusy(false); }
  }
  // Probe quote: unggah satu foto ke bucket publik, lalu minta quote_generation
  // untuk delapan bentuk parameter. Semua panggilan ini gratis (tanpa kredit).
  async function runQuoteProbe() {
    if (probeBusy) return;
    setProbeBusy(true); setProbeError(''); setProbeResult(null);
    let url = probeUrl; let path = probePath;
    try {
      if (!url && probeFile && user?.id) {
        const uploaded = await uploadFreebeatImage(supabase.storage, user.id, probeFile);
        url = uploaded.url; path = uploaded.path;
        setProbeUrl(url); setProbePath(path);
      }
      if (!/^https:\/\//.test(url || '')) { setProbeError('Pilih satu foto (jpg/png/webp, maks 10 MB) atau tempel URL HTTPS publik.'); return; }
      const modelId = Number(probeModel);
      const body = { image_url: url, ...(Number.isSafeInteger(modelId) && modelId > 0 ? { model_id: modelId } : {}) };
      setProbeResult(await request('image-quote-probe', 'POST', body));
    } catch (err) { setProbeError(err?.message || 'Probe quote gagal.'); }
    finally { setProbeBusy(false); }
  }
  async function clearProbePhoto() {
    const path = probePath;
    setProbeFile(null); setProbeUrl(''); setProbePath(''); setProbeResult(null);
    if (path) { try { await deleteFreebeatImage(supabase.storage, path); } catch { /* foto yatim tidak berbahaya */ } }
  }
  // Periksa job gambar apa pun (termasuk job milik user dari halaman Generate):
  // status, tagihan riil provider, dan alasan kegagalan. Gratis.
  async function inspectJob(raw) {
    if (imageBusy) return;
    const id = jobId.trim();
    if (!id) { setImageError('Tempel ID job yang ingin diperiksa.'); return; }
    setImageBusy(true); setImageError(''); setJobResult(null);
    try {
      setJobResult(await request('image-task-inspect', 'POST', raw ? { job_id: id, acknowledge: true } : { job_id: id }));
    } catch (err) { setImageError(err?.message || 'Pemeriksaan job gagal.'); }
    finally { setImageBusy(false); }
  }
  // Uji dugaan bahwa backend Freebeat tidak mengambil URL eksternal: quote
  // upload_image lebih dulu (gratis), lalu host foto di storage Freebeat.
  async function quoteUpload() {
    if (imageBusy) return;
    if (!probeUrl) { setImageError('Jalankan probe quote lebih dulu supaya foto terunggah dan URL publiknya tersedia.'); return; }
    setImageBusy(true); setImageError(''); setUploadQuote(null); setUploadResult(null);
    try { setUploadQuote(await request('image-upload-quote', 'POST', { image_url: probeUrl })); }
    catch (err) { setImageError(err?.message || 'Quote upload gagal.'); }
    finally { setImageBusy(false); }
  }
  async function runUpload() {
    if (imageBusy) return;
    if (!probeUrl || !Number.isSafeInteger(uploadQuote?.credits)) { setImageError('Periksa biaya upload lebih dulu.'); return; }
    setImageBusy(true); setImageError(''); setUploadResult(null);
    try { setUploadResult(await request('image-upload-host', 'POST', { image_url: probeUrl, expected_credits: uploadQuote.credits, acknowledge: true })); }
    catch (err) { setImageError(err?.message || 'Upload ke Freebeat gagal.'); }
    finally { setImageBusy(false); }
  }
  async function inspectVideos(action, version = videoRequestVersion.current) {
    setVideoBusy(true); setVideoError('');
    if (action === 'video-models') setVideoModels(null); else setVideoSchemas(null);
    try {
      const result = await request(action, 'POST');
      if (videoRequestVersion.current !== version) return;
      if (action === 'video-models') setVideoModels(result); else setVideoSchemas(result);
    } catch (err) { if (videoRequestVersion.current === version) setVideoError(err.message || 'Pemeriksaan video gagal.'); }
    finally { if (videoRequestVersion.current === version) setVideoBusy(false); }
  }
  useEffect(() => {
    const version = ++videoRequestVersion.current;
    if (connected && (page === 'video' || page === 'hailuo')) inspectVideos('video-models', version);
    else { setVideoModels(null); setVideoSchemas(null); setVideoBusy(false); setVideoError(''); }
    return () => { videoRequestVersion.current += 1; };
  }, [connected, page]);
  async function inspectQuote(event) {
    event.preventDefault();
    if (imageBusy) return;
    setImageBusy(true); setQuoteError(''); setImageQuote(null);
    try {
      const result = await request('image-quote', 'POST', { model_id: Number(quoteModel), prompt: quotePrompt });
      setImageQuote(result.quote);
    } catch (err) { setQuoteError(err.message || 'Pemeriksaan quote gagal.'); }
    finally { setImageBusy(false); }
  }
  async function refreshTests() {
    const result = await request('image-tests');
    setTests(result.tests);
  }
  async function prepareTest(event) {
    event.preventDefault();
    if (testBusy) return;
    setTestBusy(true); setTestError(''); setTestNotice(''); setApproval(null); setSpendConfirmed(false);
    try {
      const result = await request('image-prepare', 'POST', { model_id: Number(quoteModel), prompt: quotePrompt });
      setApproval(result);
      await refreshTests();
    } catch (err) { setApproval(null); setTestError(err.message || 'Persiapan uji gagal.'); }
    finally { setTestBusy(false); }
  }
  async function submitTest() {
    if (!approval || !spendConfirmed || testBusy) return;
    const receipt = approval.approval;
    setApproval(null); setSpendConfirmed(false); setTestBusy(true); setTestError(''); setTestNotice('');
    try {
      const result = await request('image-submit', 'POST', { approval: receipt, confirm: true });
      if (result.status === 'submitted') setTestNotice('Permintaan diterima untuk dipantau. Ini bukan konfirmasi gambar selesai atau biaya akhir.');
      else setTestError(`Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan ulangi; periksa Freebeat dan catatan uji.${result.recoveryTaskId ? ` ID tugas untuk pemulihan pribadi: ${result.recoveryTaskId}` : ''}`);
    } catch (err) { setTestError(`${err.message || 'Permintaan gagal.'} Jika pengiriman sempat terjadi, hasil dan biaya mungkin tidak pasti. Jangan ulangi sebelum memeriksa catatan.`); }
    try { await refreshTests(); } catch { /* the warning above still applies */ }
    setTestBusy(false);
  }
  async function inspectTests() {
    if (testBusy) return;
    setTestBusy(true); setTestError('');
    try { await refreshTests(); } catch (err) { setTestError(err.message || 'Catatan tidak tersedia.'); }
    finally { setTestBusy(false); }
  }
  async function pollTest(id) {
    if (testBusy) return;
    setTestBusy(true); setTestError('');
    try { const result = await request('image-task', 'POST', { id }); setTaskResults((old) => ({ ...old, [id]: result.task })); }
    catch (err) { setTestError(err.message || 'Status belum tersedia.'); }
    finally { setTestBusy(false); }
  }
  return <DropXLayout title={experiment ? `Freebeat · ${experiment.title}` : "Freebeat MCP"} description={experiment?.description || "Pusat koneksi dan percobaan Freebeat khusus admin."}>
    <div className="freebeat-page">
      {experiment && <header className="freebeat-workspace-header">
        <nav aria-label="Navigasi percobaan Freebeat"><Link to="/admin/freebeat">← Freebeat MCP</Link><span aria-hidden="true"> / </span><span aria-current="page">{experiment.title}</span></nav>
        <h2>{experiment.title}</h2><p>{experiment.description}</p>
        {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
        <p className="freebeat-note">{loading ? 'Memeriksa sesi…' : connected ? 'Sesi OAuth tersimpan; akses MCP tetap perlu diperiksa.' : 'Sesi belum tersedia. Hubungkan akun di halaman utama Freebeat MCP.'}</p>
        <p className="freebeat-note">Form, respons privat, dan persetujuan direset ketika berpindah halaman. Upload yang sudah tersimpan tidak dihapus otomatis; kelola melalui Supabase Storage jika meninggalkan halaman.</p>
      </header>}
      {page === 'home' && <><section className="freebeat-card">
        <span className="freebeat-kicker">MCP · OAUTH · KHUSUS ADMIN</span><h2>Hubungkan Freebeat</h2>
        <p>Tombol ini meminta izin membaca dan generasi Freebeat. Setujui izin tersebut di Freebeat. Pemeriksaan saldo tidak memakai kredit; setiap uji generasi tetap memerlukan persetujuan eksplisit.</p>
        <p>Sesi OAuth disimpan terenkripsi dalam cookie HttpOnly dan salinan server; akun pool dapat dipakai layanan Generate. Token diperbarui otomatis jika refresh token tersedia. Sesi tersimpan belum membuktikan akses MCP masih diterima Freebeat. Gunakan Periksa saldo untuk menguji akses baca tanpa generasi; keberhasilannya tidak menjamin izin generasi. Input form tidak disimpan.</p>
        <p>Menurut ketentuan Freebeat, kredit gratis hanya untuk penggunaan nonkomersial. Pastikan penggunaan Anda sesuai ketentuan penyedia.</p>
        {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
        {notice && <div className="freebeat-alert" role="status">{notice}</div>}
        <div className="freebeat-status"><strong>Status:</strong> {loading ? 'Memeriksa…' : connected ? 'Sesi OAuth tersimpan' : 'Belum terhubung'}{connected && expiresAt && <> · Token akses berakhir {new Date(expiresAt).toLocaleTimeString('id-ID')}{autoRenew ? ' (diperbarui otomatis)' : ' (tanpa refresh token — akan terputus)'}</>}{connected && sessionExpiresAt && <> · Koneksi berlaku sampai {new Date(sessionExpiresAt).toLocaleString('id-ID')}</>}</div>
        {connected && <p role="status">{balanceCheck === 'verified'
          ? 'Pemeriksaan saldo terakhir berhasil. Akses generasi belum diverifikasi.'
          : balanceCheck === 'failed'
            ? 'Pemeriksaan saldo terakhir gagal. Sesi masih tersimpan; akses MCP belum terkonfirmasi.'
            : 'Akses MCP belum diverifikasi pada halaman ini. Tekan Periksa saldo.'}</p>}
        <div className="freebeat-actions">
          <button type="button" disabled={busy || loading} onClick={() => run('start')}><Link2 size={15} /> {connected ? 'Hubungkan ulang' : 'Hubungkan Freebeat'}</button>
          <button type="button" className="is-secondary" disabled={busy || loading || !connected} onClick={() => run('balance')}><RefreshCw size={15} /> Periksa saldo</button>
          {connected && <button type="button" className="is-secondary" disabled={busy} onClick={() => run('disconnect')}><Unplug size={15} /> Putuskan</button>}
          <Link className="freebeat-pool-link" to="/admin?tab=freebeat-oauth"><ShieldCheck size={15} /> Kelola Pool Multi-Akun &amp; Email OAuth →</Link>
        </div>
        {balance !== null && <div className="freebeat-result"><h3>Respons saldo dari Freebeat</h3><pre>{typeof balance === 'string' ? balance : JSON.stringify(balance, null, 2)}</pre></div>}
      </section>
      <section className="freebeat-experiment-hub" aria-label="Daftar percobaan Freebeat">
        <h2>Pilih percobaan</h2><p>Setiap percobaan memiliki halaman sendiri. Membuka halaman tidak menjalankan upload atau generasi berbayar.</p>
        {FREEBEAT_EXPERIMENT_CATEGORIES.map((category) => <section key={category} className="freebeat-experiment-category" aria-label={category}>
          <h3>{category}</h3><div className="freebeat-experiment-grid">
            {FREEBEAT_EXPERIMENTS.filter((item) => item.category === category).map((item) => <Link key={item.id} className="freebeat-experiment-link" to={freebeatExperimentPath(item.id)}>
              <span className="freebeat-experiment-badge">{item.access}</span><strong>{item.title}</strong><span>{item.description}</span><span className="freebeat-experiment-open">Buka percobaan →</span>
            </Link>)}
          </div>
        </section>)}
      </section></>}
      {['image-models', 'image-edit', 'image-job'].includes(page) && <section className="freebeat-card freebeat-site-test">
        <span className="freebeat-kicker">GAMBAR · KHUSUS ADMIN</span>
        {page === 'image-models' && <>
        <p>Periksa daftar model, struktur tool MCP dan respons quote tanpa membuat gambar atau memakai kredit. Pembelian BLEA belum diaktifkan; uji generasi admin memerlukan persetujuan terpisah di halaman Generasi gambar.</p>
        <p>Koneksi Freebeat meminta izin <code>freebeat:read</code> dan <code>freebeat:generate</code>. Jika izin generasi tidak diberikan, hubungkan ulang dan setujui di Freebeat.</p>
        <div className="freebeat-status">Izin gambar: {imageAccess ? 'diminta dan terindikasi diberikan' : 'belum diberikan atau belum terverifikasi'}</div>
        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy} onClick={() => inspectImages('image-models')}>Lihat model gambar</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy} onClick={() => inspectImages('image-edit-models')}>Lihat model edit gambar</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy} onClick={() => inspectImages('image-schemas')}>Periksa skema tool gambar</button>
        </div>
        {imageModels && <div className="freebeat-result"><h3>Model gambar dari Freebeat (katalog {imageModels.catalog}) · {imageModels.models?.length ?? 0} model</h3><pre>{JSON.stringify(imageModels.models, null, 2)}</pre>{imageModels.truncated && <p>Daftar dibatasi hingga 100 model.</p>}</div>}
        <div className="freebeat-field">Informasi model gambar (get_model_help, gratis)
          <div className="freebeat-actions">
            <input type="text" value={imageHelpModel} maxLength={6} onChange={(event) => { setImageHelpModel(event.target.value); setImageHelp(null); }} aria-label="ID model gambar" />
            <select value={imageHelpType} onChange={(event) => { setImageHelpType(event.target.value); setImageHelp(null); }} aria-label="Tipe katalog model">
              <option value="image">katalog image</option>
              <option value="image_edit">katalog image_edit</option>
              <option value="video">katalog video</option>
            </select>
            <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy} onClick={() => inspectImageHelp(false)}>Periksa informasi model</button>
            <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy || !imageHelpConsent} onClick={() => inspectImageHelp(true)}>Tampilkan informasi privat</button>
          </div>
          <label className="freebeat-confirm"><input type="checkbox" checked={imageHelpConsent} onChange={(event) => setImageHelpConsent(event.target.checked)} /> Saya memahami respons privat dapat memuat pesan mentah provider dan tidak boleh dibagikan publik.</label>
        </div>
        {imageHelp && <div className="freebeat-result"><h3>Informasi model {imageHelp.model_id} (katalog {imageHelp.type})</h3><pre>{JSON.stringify(imageHelp.help, null, 2)}</pre></div>}
        {imageEditModels && <div className="freebeat-result"><h3>Model edit gambar dari Freebeat (katalog {imageEditModels.catalog}) · {imageEditModels.models?.length ?? 0} model</h3><pre>{JSON.stringify(imageEditModels.models, null, 2)}</pre>{imageEditModels.truncated && <p>Daftar dibatasi hingga 100 model.</p>}</div>}
        {imageSchemas && <div className="freebeat-result"><h3>Struktur tool gambar</h3><p>Hanya nama parameter dan tipe dasar; deskripsi dan data sesi tidak ditampilkan. Bagikan hasil ini untuk memeriksa format biaya.</p><pre>{JSON.stringify(imageSchemas.tools, null, 2)}</pre>{imageSchemas.truncated && <p>Daftar dibatasi hingga lima halaman; sebagian tool mungkin tidak ditampilkan.</p>}</div>}
        </>}
        {page === 'image-edit' && <>
        <div className="freebeat-field">Probe quote mode edit (quote_generation, gratis)
          <p className="freebeat-note">Model 202 menolak quote dasar dengan status <code>unavailable</code>. Probe ini mencoba delapan bentuk parameter sekaligus untuk menemukan yang diterima provider. Foto diunggah ke bucket publik BLEA lalu dihapus otomatis saat Anda membersihkannya.</p>
          <div className="freebeat-actions">
            <input type="text" value={probeModel} maxLength={6} onChange={(event) => { setProbeModel(event.target.value); setProbeResult(null); }} aria-label="ID model edit gambar" />
            <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { setProbeFile(event.target.files?.[0] || null); setProbeResult(null); }} aria-label="Foto untuk probe" />
            <button type="button" className="is-secondary" disabled={loading || !connected || probeBusy || imageBusy} onClick={runQuoteProbe}>{probeBusy ? 'Memeriksa…' : 'Jalankan probe quote'}</button>
            <button type="button" className="is-secondary" disabled={probeBusy || (!probeFile && !probeUrl)} onClick={clearProbePhoto}>Bersihkan foto</button>
          </div>
          {probeUrl && <div className="freebeat-status">Foto siap: {probeUrl.slice(0, 96)}{probeUrl.length > 96 ? '…' : ''}</div>}
          {probeError && <div className="freebeat-alert is-error" role="alert">{probeError}</div>}
        </div>
        {probeResult && <div className="freebeat-result"><h3>Hasil probe quote (model {probeResult.model_id}, kontrol {probeResult.control_model_id})</h3>
          <p>Varian yang dapat dipakai: {probeResult.usable?.length ? probeResult.usable.map((item) => `${item.label} = ${item.credits} kredit`).join(' · ') : 'tidak ada — semua ditolak provider.'}</p>
          <pre>{JSON.stringify(probeResult.results, null, 2)}</pre>
        </div>}
        <div className="freebeat-field">Uji host foto di Freebeat (upload_image)
          <p className="freebeat-note">Item edit yang gagal menunjukkan <code>edit_images: []</code> dan 0 kredit — dugaan: backend Freebeat tidak mengambil URL eksternal, jadi foto harus di-host di storage mereka (web mengirim URL <code>static.freebeat.ai</code>). Langkah 1 gratis; langkah 2 memotong kredit Freebeat admin sebesar hasil quote.</p>
          <div className="freebeat-actions">
            <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy || !probeUrl} onClick={quoteUpload}>1. Periksa biaya upload (gratis)</button>
            <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy || !probeUrl || !uploadConsent || !Number.isSafeInteger(uploadQuote?.credits)} onClick={runUpload}>2. Jalankan upload_image</button>
          </div>
          <label className="freebeat-confirm"><input type="checkbox" checked={uploadConsent} onChange={(event) => setUploadConsent(event.target.checked)} /> Saya menyetujui pemotongan kredit Freebeat admin sebesar hasil quote untuk uji upload ini.</label>
          {uploadQuote && <div className="freebeat-status">Quote upload_image: {Number.isSafeInteger(uploadQuote.credits) ? `${uploadQuote.credits} kredit Freebeat` : `tidak tersedia (status ${uploadQuote.status || 'tidak diketahui'})`}</div>}
          {uploadQuote && <pre>{JSON.stringify(uploadQuote.quote, null, 2)}</pre>}
        </div>
        {uploadResult && <div className="freebeat-result"><h3>Hasil upload_image (quote {uploadResult.quote_credits} kredit; bukan tagihan akhir)</h3>
          {uploadResult.image_url && <FreebeatCopyResult title="URL hasil hosting gambar Freebeat" value={{ image_url: uploadResult.image_url }} />}
          {uploadResult.outcome === 'unknown' && <p role="alert">Hasil upload tidak pasti atau URL tidak tersedia. Salinan/biaya mungkin sudah tercatat; jangan ulangi sebelum memeriksa akun Freebeat.</p>}
          <pre>{JSON.stringify(uploadResult.upload, null, 2)}</pre></div>}
        </>}
        {page === 'image-job' && <>
        <div className="freebeat-field">Periksa job gambar (get_task_status, gratis)
          <p className="freebeat-note">Tempel ID job dari riwayat generasi — termasuk job milik pengguna dari halaman Generate. Menampilkan status, tagihan riil provider (<code>billing.charged</code>) dan alasan kegagalan yang selama ini tersembunyi.</p>
          <div className="freebeat-actions">
            <input type="text" value={jobId} maxLength={256} onChange={(event) => { setJobId(event.target.value); setJobResult(null); }} placeholder="Contoh: OB0015730429059944980484L00" aria-label="ID job gambar" />
            <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy || !jobId.trim()} onClick={() => inspectJob(false)}>Periksa job</button>
            <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy || !jobId.trim() || !jobConsent} onClick={() => inspectJob(true)}>Tampilkan respons mentah</button>
          </div>
          <label className="freebeat-confirm"><input type="checkbox" checked={jobConsent} onChange={(event) => setJobConsent(event.target.checked)} /> Saya memahami respons mentah dapat memuat pesan provider dan URL hasil, serta tidak boleh dibagikan publik.</label>
        </div>
        {jobResult && <div className="freebeat-result"><h3>Job {jobResult.job_id}</h3>
          <p>Status: <b>{jobResult.status}</b> · ditagih provider: {jobResult.billing?.charged ?? '—'} · dikembalikan: {jobResult.billing?.refunded ?? '—'} · bersih: {jobResult.billing?.net ?? '—'} · refund: {jobResult.billing?.refund_state ?? '—'} · gambar: {jobResult.images?.length ?? 0}</p>
          {jobResult.reasons?.length > 0 && <p>Alasan/pesan dari provider: {jobResult.reasons.join(' · ')}</p>}
          {jobResult.root_keys?.length > 0 && <p>Kunci respons provider: {jobResult.root_keys.join(', ')}</p>}
          <pre>{JSON.stringify(jobResult.raw ?? jobResult, null, 2)}</pre>
        </div>}
        </>}
        {imageError && <div className="freebeat-alert is-error" role="alert">{imageError}</div>}
      </section>}
      {page === 'image-generation' && <section className="freebeat-card freebeat-site-test">
        <span className="freebeat-kicker">UJI GAMBAR · KHUSUS ADMIN · KREDIT FREEBEAT</span>
        <h2>Uji generasi gambar admin</h2><p><Link to="/admin/freebeat/image-models">Buka katalog model gambar</Link> untuk memeriksa ID model sebelum mengisi form ini.</p>
        <p>Hanya akun Freebeat di browser admin ini yang digunakan. Ini bukan pembelian atau pemakaian kredit BLEA. Isi ID model dan prompt di bawah, lalu siapkan quote baru. Pastikan penggunaan sesuai ketentuan dan plan Freebeat; manfaat plan yang hanya untuk aplikasi web tidak otomatis berlaku untuk MCP.</p>
        <p>Freebeat melaporkan quote, bukan biaya akhir; saldo dapat terpakai meskipun tugas gagal, dan refund tidak dijamin. Jika hasil pengiriman tidak pasti, jangan mengulang sebelum memeriksa Freebeat. Uji dengan hasil tidak pasti akan mengunci pengiriman berikutnya hingga ditinjau operator.</p>
        <FreebeatImageForm loading={loading} connected={connected} imageAccess={imageAccess} busy={busy} imageBusy={imageBusy} testBusy={testBusy} model={quoteModel} prompt={quotePrompt}
          onModelChange={(value) => { setQuoteModel(value); setImageQuote(null); setQuoteError(''); setApproval(null); setSpendConfirmed(false); }}
          onPromptChange={(value) => { setQuotePrompt(value); setImageQuote(null); setQuoteError(''); setApproval(null); setSpendConfirmed(false); }}
          onInspect={inspectQuote} onPrepare={prepareTest} />
        {quoteError && <div className="freebeat-alert is-error" role="alert">{quoteError}</div>}
        {imageQuote !== null && <div className="freebeat-result"><h3>Respons quote yang disaring</h3><p>Hanya status dalam daftar aman yang ditampilkan; status lain tetap disembunyikan. Nilai ini belum diverifikasi sebagai biaya final atau izin generasi. Tidak ada kredit yang dipakai.</p><pre>{JSON.stringify(imageQuote, null, 2)}</pre></div>}
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || testBusy} onClick={inspectTests}>Periksa catatan uji</button></div>
        {approval && <div className="freebeat-result">
          <h3>Periksa dan setujui satu kali</h3>
          <p>Model: <strong>{approval.model_id}</strong> · Quote Freebeat: <strong>{approval.credits} kredit</strong> · Batas maksimum yang dikirim: <strong>{approval.credits} kredit</strong>. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}. Jika quote berubah, pengiriman ditolak.</p>
          <p>Prompt yang akan dikirim:</p><pre>{approval.prompt}</pre>
          <label className="freebeat-confirm"><input type="checkbox" checked={spendConfirmed} onChange={(event) => setSpendConfirmed(event.target.checked)} /> Saya menyetujui satu kali generasi ini dengan batas maksimum {approval.credits} kredit Freebeat. Saya memahami biaya aktual dan refund belum dipastikan.</label>
          <div className="freebeat-actions"><button type="button" disabled={!spendConfirmed || testBusy} onClick={submitTest}>Setujui dan kirim satu gambar</button></div>
        </div>}
        {testError && <div className="freebeat-alert is-error" role="alert">{testError}</div>}
        {testNotice && <div className="freebeat-alert" role="status">{testNotice}</div>}
        {tests.length > 0 && <div className="freebeat-result"><h3>Catatan uji admin</h3>{tests.map((test) => <div key={test.id} className="freebeat-test-row">
          <p>Model {test.model_id} · Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · {test.status}</p>
          {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil tidak pasti; pengiriman baru diblokir. Jangan mencoba ulang. Periksa aktivitas Freebeat dan minta operator meninjau catatan.</p>}
          {test.status === 'submitted' && !test.canPoll && <p>Status hanya dapat diperiksa dari sesi Freebeat yang digunakan saat pengiriman.</p>}
          {test.canPoll && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={testBusy} onClick={() => pollTest(test.id)}>Periksa status</button></div>}
          {taskResults[test.id] && <FreebeatTaskResult task={taskResults[test.id]} />}
        </div>)}</div>}
      </section>}
      {page === 'video' && <section className="freebeat-card freebeat-site-test">
        <span className="freebeat-kicker">VIDEO · KHUSUS ADMIN · BACA SAJA</span>
        <h2>Persiapan uji video</h2>
        <p>Periksa model dan skema video tanpa memakai kredit. Uji generasi video admin di bawah hanya dikirim setelah quote dan persetujuan eksplisit.</p>
        <div className="freebeat-actions">
          <button type="button" disabled={loading || !connected || videoBusy} onClick={() => inspectVideos('video-models')}>Muat ulang model video</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || videoBusy} onClick={() => inspectVideos('video-schemas')}>Periksa skema tool video</button>
        </div>
        {videoError && <div className="freebeat-alert is-error" role="alert">{videoError}</div>}
        {videoSchemas && <FreebeatCopyResult title="Struktur tool video" value={{ tools: videoSchemas.tools, truncated: videoSchemas.truncated === true }} description={`Hanya struktur dan nilai enumerasi aman; deskripsi dan data sesi tidak ditampilkan.${videoSchemas.truncated ? ' Daftar dibatasi hingga lima halaman; sebagian tool mungkin tidak ditampilkan.' : ''}`} />}
        <FreebeatVideoDiagnostic key={user?.id || ''} connected={connected} imageAccess={imageAccess} loading={loading} request={request} userId={user?.id} storage={supabase.storage} videoModels={videoModels} videoBusy={videoBusy} />
      </section>}
      {page === 'hailuo' && <section className="freebeat-card freebeat-site-test">
        {videoError && <div className="freebeat-alert is-error" role="alert">{videoError}<div className="freebeat-actions"><button type="button" disabled={loading || !connected || videoBusy} onClick={() => inspectVideos('video-models')}>Muat ulang model video</button></div></div>}
        <FreebeatHailuoDiagnostic key={`hailuo-${user?.id || ''}`} connected={connected} imageAccess={imageAccess} loading={loading} request={request} videoModels={videoModels} userId={user?.id} storage={supabase.storage} /></section>}
      {page === 'ltx' && <section className="freebeat-card freebeat-site-test">
        <FreebeatLtxDiagnostic key={`ltx-${user?.id || ''}`} connected={connected} imageAccess={imageAccess} loading={loading} request={request} userId={user?.id} storage={supabase.storage} /></section>}
      {page === 'dance' && <FreebeatDanceDiagnostic key={`dance-${user?.id || ''}`} connected={connected} imageAccess={imageAccess} loading={loading} request={request} userId={user?.id} storage={supabase.storage} />}
      {['singing', 'lip-sync'].includes(page) && <FreebeatSingingLipSyncDiagnostic key={`vocal-${user?.id || ''}`} onlyTool={page === 'singing' ? 'generate_singing_video' : 'generate_lip_sync_video'} connected={connected} imageAccess={imageAccess} loading={loading} request={request} userId={user?.id} storage={supabase.storage} />}
      {page === 'vocal-schemas' && <FreebeatVocalSchemaDiagnostic key={`vocal-schema-${user?.id || ''}`} connected={connected} loading={loading} request={request} />}
      {page === 'remaining-schemas' && <FreebeatRemainingSchemaDiagnostic key={`remaining-schema-${user?.id || ''}`} connected={connected} loading={loading} request={request} />}
      {page === 'catalog' && <FreebeatCatalogInspector key={`catalog-inspector-${user?.id || ''}`} connected={connected} loading={loading} request={request} />}
      {page === 'remaining-quotes' && <FreebeatRemainingQuoteProbe key={`remaining-quote-probe-${user?.id || ''}`} connected={connected} loading={loading} request={request} />}
      {page === 'music' && <FreebeatMusicDiagnostic key={`music-${user?.id || ''}`} connected={connected} imageAccess={imageAccess} loading={loading} request={request} />}
    </div>
  </DropXLayout>;
}
