import { useEffect, useId, useRef, useState } from 'react';
import { videoHeadroom } from '../lib/freebeatVideoTestSettings';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { videoPrepareState } from '../lib/freebeatVideoPrepareState';

const expiresAt = (value) => typeof value === 'number' ? value : Date.parse(value);
const pending = (test) => ['unknown', 'dispatching'].includes(test.status);
const failed = (task) => ['failed', 'partial_failed', 'action_required', 'rejected'].includes(task?.status);
function resultUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}

export function FreebeatSingleImageVideoGeneration({ connected, imageAccess, loading, disabled, request, userId, imageUrl, prompt, aspectRatio, quote, onBusyChange, modelId = 106, modelLabel = 'Hailuo', duration = 10, resolution = '768p', prepareAction = 'hailuo-prepare' }) {
  const prepareHelpId = useId();
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [tests, setTests] = useState([]);
  const [results, setResults] = useState({});
  const [privateConsent, setPrivateConsent] = useState({});
  const [privateFailure, setPrivateFailure] = useState({});
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const version = useRef(0), lock = useRef(false);
  const signature = JSON.stringify([modelId, modelLabel, prepareAction, duration, resolution, imageUrl, prompt.trim(), aspectRatio]);
  useEffect(() => {
    version.current += 1; setApproval(null); setConfirmed(false); setError('');
    // Keep local submission/uncertainty locks across input/quote changes.
    setResults({}); setPrivateConsent({}); setPrivateFailure({}); setNotice('');
    return () => { version.current += 1; };
  }, [signature, connected, imageAccess, userId, quote]);
  useEffect(() => { setTests([]); }, [connected, userId]);
  useEffect(() => {
    if (!approval) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [approval]);
  const blocked = loading || !connected || !imageAccess || disabled || busy;
  const unresolved = tests.some(pending);
  const { blockers: prepareBlockers, diagnostic: prepareDiagnostic } = videoPrepareState({
    loading, connected, imageAccess, disabled, busy, imageUrl, prompt, modelId, modelLabel,
    duration, resolution, aspectRatio, quote, attempted, uncertain, unresolved,
  });
  const expires = approval ? expiresAt(approval.expiresAt) : 0;
  const liveApproval = approval && approval.signature === signature && approval.quote === quote && Number.isFinite(expires) && expires > now;
  function start() {
    if (lock.current) return false;
    lock.current = true; setBusy(true); onBusyChange(true); setError(''); return true;
  }
  function finish() { lock.current = false; setBusy(false); onBusyChange(false); }
  async function history() {
    const result = await request('video-tests');
    if (!Array.isArray(result.tests)) throw new Error('Catatan uji video tidak valid.');
    return result.tests;
  }
  async function prepare() {
    if (prepareBlockers.length || !start()) return;
    const stamp = version.current;
    setApproval(null); setConfirmed(false); setNotice('');
    try {
      const records = await history();
      if (stamp !== version.current) return;
      setTests(records);
      if (records.some(pending)) throw new Error('Ada pengiriman video dengan hasil tidak pasti. Minta operator meninjau catatan sebelum membuat uji baru.');
      const result = await request(prepareAction, 'POST', {
        model_id: modelId, generation_type: 'image', input_mode: 'keyframe', images: [imageUrl], prompt: prompt.trim(), duration, resolution, aspect_ratio: aspectRatio,
      });
      if (stamp !== version.current) return;
      const s = result.settings;
      if (s?.model_id !== modelId || s.generation_type !== 'image' || s.duration !== duration || s.resolution !== resolution || s.aspect_ratio !== aspectRatio
        || result.prompt !== prompt.trim() || !Array.isArray(result.images) || result.images.length !== 1 || result.images[0] !== imageUrl
        || typeof result.credits !== 'number' || !Number.isFinite(result.credits) || result.credits < 0 || result.credits > 1000000
        || result.max_credits !== result.credits + videoHeadroom(result.credits)
        || typeof result.approval !== 'string' || !result.approval || !Number.isFinite(expiresAt(result.expiresAt)) || expiresAt(result.expiresAt) <= Date.now()) throw new Error(`Persetujuan ${modelLabel} tidak cocok atau kedaluwarsa. Tidak ada video dikirim.`);
      setNow(Date.now()); setApproval({ ...result, signature, quote });
    } catch (err) { if (stamp === version.current) setError(err.message || `Persiapan ${modelLabel} gagal.`); }
    finally { finish(); }
  }
  async function submit() {
    if (blocked || !liveApproval || !confirmed || expiresAt(approval.expiresAt) <= Date.now() || attempted || uncertain || unresolved || !start()) return;
    const receipt = approval.approval, stamp = version.current;
    // Consume before awaiting anything; never reuse a receipt after a lost reply.
    setApproval(null); setConfirmed(false); setAttempted(true); setUncertain(true); setNotice('');
    try {
      const result = await request('video-submit', 'POST', { approval: receipt, confirm: true });
      if (stamp !== version.current) return;
      if (result.status === 'submitted') {
        setUncertain(false);
        setNotice('Permintaan diterima untuk dipantau. Ini bukan konfirmasi render berhasil atau tagihan akhir. Periksa status video; jangan langsung mengirim ulang.');
        if (result.batch_summary) setNotice(`Batch tercatat: accepted_count=${result.batch_summary.accepted_count ?? 'tidak diketahui'}, failed_count=${result.batch_summary.failed_count ?? 'tidak diketahui'}, accepted_credits=${result.batch_summary.accepted_credits ?? 'tidak diketahui'}. Batch ID bukan bukti render berhasil; periksa status video.`);
      } else setError('Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan kirim ulang; periksa Freebeat dan catatan uji.');
    } catch (err) {
      if (stamp === version.current) {
        if (err.videoDispatch === 'not_sent' && [400, 409].includes(err.status)) {
          setUncertain(false); setAttempted(false);
          setError(`${err.message || 'Pengiriman ditolak.'} Permintaan ini tidak dikirim. Siapkan persetujuan baru; tiket lama sudah dibuang.`);
        } else setError(`${err.message || 'Pengiriman gagal.'} Jika sempat dikirim, biaya/hasil mungkin tidak pasti. Jangan kirim ulang sebelum meninjau catatan.`);
      }
    } finally {
      if (stamp === version.current) {
        try { const records = await history(); if (stamp === version.current) setTests(records); } catch { if (stamp === version.current) setError((old) => `${old} Catatan uji belum dapat dimuat; periksa kembali tanpa mengirim ulang.`.trim()); }
      }
      finish();
    }
  }
  async function inspectTests() {
    if (blocked || !start()) return;
    const stamp = version.current;
    setPrivateConsent({}); setPrivateFailure({});
    try { const records = await history(); if (stamp === version.current) setTests(records); }
    catch (err) { if (stamp === version.current) setError(err.message || 'Catatan belum tersedia.'); }
    finally { finish(); }
  }
  async function poll(test) {
    if (blocked || test.status !== 'submitted' || !start()) return;
    const stamp = version.current;
    hidePrivateFailure(test.id);
    try {
      const result = await request('video-task', 'POST', { id: test.id, ...(!test.canPoll ? { acknowledge: true } : {}) });
      if (stamp === version.current) setResults((old) => ({ ...old, [test.id]: result.task }));
    } catch (err) { if (stamp === version.current) setError(err.message || 'Status belum tersedia.'); }
    finally { finish(); }
  }
  function hidePrivateFailure(id) {
    setPrivateConsent((old) => ({ ...old, [id]: false }));
    setPrivateFailure((old) => { const next = { ...old }; delete next[id]; return next; });
  }
  async function viewPrivateFailure(test) {
    if (blocked || test.status !== 'submitted' || !failed(results[test.id]) || !privateConsent[test.id] || !start()) return;
    const stamp = version.current;
    try {
      // Read-only status inspection, never a prepare/submit/generate call.
      const result = await request('video-private-failure', 'POST', { id: test.id, acknowledge: true });
      if (stamp !== version.current) return;
      if (!Array.isArray(result.reasons) || result.reasons.some((reason) => typeof reason !== 'string')) throw new Error('Pesan kegagalan pribadi tidak valid.');
      setPrivateFailure((old) => ({ ...old, [test.id]: result.reasons }));
    } catch (err) { if (stamp === version.current) setError(err.message || 'Pesan kegagalan pribadi belum tersedia.'); }
    finally { finish(); }
  }
  return <section className="freebeat-result" aria-label={`Generasi ${modelLabel} admin`}>
    <h4>3. Quote baru → setujui satu video {modelLabel}</h4>
    <p>Memakai kredit Freebeat admin, bukan kredit BLEA. Keberhasilan quote bukan jaminan render atau refund. Biaya upload foto sebelumnya terpisah dan mungkin belum diketahui.</p>
    <p>Persiapan memeriksa help dan quote baru, tanpa membuat video. Batas pengiriman mencakup headroom 15% (minimal 10 kredit); jumlah pastinya ditampilkan sebelum persetujuan. Batas yang dikirim bukan bukti tagihan akhir.</p>
    {!imageAccess && <p className="freebeat-note">Izin generasi Freebeat belum tersedia; hubungkan ulang melalui halaman utama.</p>}
    {(uncertain || unresolved) && <p role="alert">Pengiriman baru diblokir karena hasil belum pasti. Periksa aktivitas Freebeat dan minta operator meninjau catatan. Jangan memuat ulang untuk mengulang pengiriman.</p>}
    {attempted && !uncertain && <p role="status">Satu pengiriman sudah dicoba pada halaman ini. Pantau catatannya, bukan menekan kirim lagi.</p>}
    <div className="freebeat-actions">
      <button type="button" disabled={prepareBlockers.length > 0} aria-describedby={prepareHelpId} onClick={prepare}>Siapkan persetujuan video {modelLabel}</button>
      <button type="button" className="is-secondary" disabled={blocked} onClick={inspectTests}>Periksa catatan video {modelLabel}</button>
    </div>
    <div id={prepareHelpId} className="freebeat-prepare-help" aria-label={`Syarat persiapan ${modelLabel}`} aria-live="polite">
      {prepareBlockers.length ? <><strong>Persetujuan belum bisa disiapkan:</strong><ul>{prepareBlockers.map(({ code, message }) => <li key={code}>{message}</li>)}</ul></> : <span>Siap meminta quote baru untuk persetujuan. Persiapan belum membuat video; server tetap memeriksa help, harga, sesi dan catatan pengiriman.</span>}
    </div>
    {prepareBlockers.length > 0 && <details className="freebeat-result">
      <summary>Diagnosis persiapan {modelLabel} (aman disalin)</summary>
      <FreebeatCopyResult title={`Diagnosis persiapan ${modelLabel}`} value={prepareDiagnostic} description="Hanya kode syarat, status sesi, angka biaya dan parameter yang dikenal. Tidak memuat prompt, URL gambar, token persetujuan, atau pesan mentah Freebeat. Membuka/menyalin diagnosis tidak mengirim request." />
    </details>}
    {approval && <div className="freebeat-result" aria-label={`Persetujuan satu video ${modelLabel}`}>
      <p>Model {modelId} · image-to-video · {approval.settings.duration} detik · {approval.settings.resolution} · {approval.settings.aspect_ratio} · quote <strong>{approval.credits} kredit</strong> · batas maksimum yang diminta <strong>{approval.max_credits} kredit Freebeat</strong>. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}. Quote berubah saat kirim → pengiriman ditolak.</p>
      <p>Prompt dan URL foto yang disetujui:</p><pre>{approval.prompt}</pre><pre>{approval.images[0]}</pre>
      {!liveApproval && <p role="alert">Persetujuan kedaluwarsa atau input berubah. Siapkan persetujuan baru.</p>}
      <label className="freebeat-confirm"><input type="checkbox" aria-label={`Setujui satu generasi ${modelLabel}`} checked={confirmed} disabled={blocked || !liveApproval} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui satu generasi {modelLabel} ini dengan batas maksimum yang diminta {approval.max_credits} kredit Freebeat, termasuk headroom. Saya memahami biaya aktual dan refund belum dipastikan.</label>
      <div className="freebeat-actions"><button type="button" disabled={blocked || !liveApproval || !confirmed || attempted || uncertain || unresolved} onClick={submit}>Setujui dan kirim satu video {modelLabel}</button></div>
    </div>}
    {busy && <p role="status">Memproses permintaan {modelLabel}…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {tests.length > 0 && <div className="freebeat-result"><h4>Catatan uji video admin</h4>{tests.map((test) => <div className="freebeat-test-row" key={test.id}>
      <p>ID uji: <code>{test.id}</code> · Model {test.model_id} · {test.status} · batas {test.max_credits ?? 'tidak diketahui'} kredit · {new Date(test.created_at).toLocaleString('id-ID')}</p>
      {pending(test) && <p>Hasil tidak pasti. Jangan membuat ulang; perlu tinjauan operator.</p>}
      {test.status === 'submitted' && <>
        {!test.canPoll && <p>Sesi berbeda: tombol berikut mengizinkan pemeriksaan ID tugas lama melalui akun Freebeat sesi saat ini.</p>}
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={blocked} onClick={() => poll(test)}>{test.canPoll ? `Periksa status video ${modelLabel}` : 'Periksa status video (sesi lama)'}</button></div>
      </>}
      {results[test.id] && <>
        <FreebeatCopyResult title={`Status video ${test.id}`} value={{ status: results[test.id].status, billing: results[test.id].billing, failure: results[test.id].failure, item_failures: results[test.id].item_failures }} description="Biaya/refund yang tidak dilaporkan tetap tidak diketahui. Kode gagal bukan izin mengirim ulang." />
        {failed(results[test.id]) && <div className="freebeat-result" aria-label={`Pesan kegagalan pribadi ${test.id}`}>
          <h4>Pesan kegagalan pribadi</h4>
          <p>Penyebab rinci mungkin disembunyikan dari ringkasan di atas demi privasi. Pemeriksaan ini hanya membaca status Freebeat, tidak membuat video baru. Pesan mungkin memuat prompt, URL, data pribadi atau kredensial; penyamaran tidak dijamin lengkap. Jangan salin atau bagikan pesan mentah. Jika perlu bantuan, sampaikan kode atau inti penyebab tanpa data sensitif.</p>
          {!test.canPoll && <p>Catatan ini berasal dari sesi lama. Konfirmasi di bawah juga mengizinkan pembacaan pesan tugas lama melalui akun Freebeat sesi saat ini.</p>}
          {!Object.hasOwn(privateFailure, test.id) ? <>
            <label className="freebeat-confirm"><input type="checkbox" aria-label={`Setujui pesan kegagalan pribadi ${test.id}`} checked={Boolean(privateConsent[test.id])} disabled={blocked} onChange={(event) => setPrivateConsent((old) => ({ ...old, [test.id]: event.target.checked }))} /> Saya memahami pesan mungkin mengandung informasi sensitif dan hanya akan melihatnya secara pribadi.</label>
            <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={blocked || !privateConsent[test.id]} onClick={() => viewPrivateFailure(test)}>Tampilkan pesan kegagalan pribadi</button></div>
          </> : <>
            <div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => hidePrivateFailure(test.id)}>Sembunyikan pesan pribadi</button></div>
            {privateFailure[test.id].length ? privateFailure[test.id].map((reason, index) => <pre key={index}>{reason}</pre>) : <p>Freebeat tidak memberikan pesan kegagalan berbentuk teks yang dapat ditampilkan.</p>}
          </>}
        </div>}
        <div className="freebeat-result-links">{(results[test.id].videos || []).map(resultUrl).filter(Boolean).map((url) => <a className="freebeat-result-link" key={url} href={url} target="_blank" rel="noopener noreferrer">Buka hasil video {modelLabel}</a>)}</div>
        {results[test.id].status === 'completed' && !results[test.id].videos?.length && <p>Video dilaporkan selesai tetapi URL belum tersedia. Periksa lagi; jangan membuat ulang.</p>}
      </>}
    </div>)}</div>}
    <p className="freebeat-note">Jika status tugas gagal, panel Pesan kegagalan pribadi tersedia langsung di bawah status setelah pemeriksaan manual. Tidak ada pembacaan pesan privat, pemantauan atau pemutaran media otomatis.</p>
  </section>;
}
