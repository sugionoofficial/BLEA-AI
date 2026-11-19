import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { uploadFreebeatImage, deleteFreebeatImage } from '../lib/freebeatVideoUpload';

export function FreebeatVideoDiagnostic({ connected, imageAccess, loading, request, userId, storage, videoModels, videoBusy }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(null);
  const [privateHelp, setPrivateHelp] = useState(null);
  const [privateHelpConsent, setPrivateHelpConsent] = useState(false);
  const [quote, setQuote] = useState(null);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [initialConsent, setInitialConsent] = useState(false);
  const [initialDiagnostics, setInitialDiagnostics] = useState(null);
  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const [privateFailure, setPrivateFailure] = useState({});
  const [privacyConsent, setPrivacyConsent] = useState({});
  const visibilityVersion = useRef(0);
  const catalogVersion = useRef(0);
  const uploadCheckVersion = useRef(0);
  const [uploadCheckConsent, setUploadCheckConsent] = useState(false);
  const [freebeatUploadConsent, setFreebeatUploadConsent] = useState(false);
  const [freebeatUploadCheck, setFreebeatUploadCheck] = useState(null);
  const [freebeatUploadResult, setFreebeatUploadResult] = useState(null);
  useEffect(() => {
    uploadCheckVersion.current += 1;
    setUploadCheckConsent(false); setFreebeatUploadConsent(false); setFreebeatUploadCheck(null); setFreebeatUploadResult(null);
    return () => { uploadCheckVersion.current += 1; };
  }, [connected, imageUrl]);
  useEffect(() => {
    if (!connected) { setPrivateFailure({}); setPrivacyConsent({}); setTaskResults({}); setHelp(null); setPrivateHelp(null); setPrivateHelpConsent(false); setQuote(null); setModel(''); setApproval(null); setConfirmed(false); setInitialConsent(false); setInitialDiagnostics(null); }
    return () => { visibilityVersion.current += 1; };
  }, [connected]);
  useEffect(() => { catalogVersion.current += 1; setHelp(null); setPrivateHelp(null); setPrivateHelpConsent(false); setQuote(null); setApproval(null); setConfirmed(false); setInitialConsent(false); }, [videoModels, videoBusy]);
  const [testNotice, setTestNotice] = useState('');
  function clearApproval() { setApproval(null); setConfirmed(false); setInitialConsent(false); }
  function updatePrompt(value) { setPrompt(value); setQuote(null); clearApproval(); }
  function updateImageUrl(value) { setImageUrl(value); setQuote(null); clearApproval(); }
  const [file, setFile] = useState(null);
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [uploaded, setUploaded] = useState(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadNotice, setUploadNotice] = useState('');
  const fileInput = useRef(null);

  async function uploadImage() {
    if (busy || uploadBusy || !file || !publicConfirmed || uploaded || !userId || !storage) return;
    setUploadBusy(true); setUploadError(''); setUploadNotice('');
    try {
      const item = await uploadFreebeatImage(storage, userId, file);
      setUploaded(item);
      if (item.url) { setImageUrl(item.url); setQuote(null); clearApproval(); setUploadNotice('Gambar tersimpan dan URL publik terisi di bawah.'); }
      else setUploadError('Gambar tersimpan, tetapi URL tidak tersedia. Anda dapat menghapusnya di bawah.');
    } catch (err) { setUploadError(err.message || 'Upload tidak berhasil; periksa Supabase Storage.'); }
    finally { setUploadBusy(false); }
  }
  async function removeImage() {
    if (!uploaded || busy || uploadBusy) return;
    setUploadBusy(true); setUploadError(''); setUploadNotice('');
    try {
      await deleteFreebeatImage(storage, uploaded.path);
      if (imageUrl === uploaded.url) { setImageUrl(''); setQuote(null); clearApproval(); }
      setUploaded(null); setFile(null); setPublicConfirmed(false);
      if (fileInput.current) fileInput.current.value = '';
      setUploadNotice('Gambar dihapus dari Supabase. Salinan atau cache pihak lain mungkin masih ada.');
    } catch (err) { setUploadError(err.message || 'Penghapusan gagal; periksa Supabase Storage.'); }
    finally { setUploadBusy(false); }
  }
  async function inspectFreebeatUpload(submit) {
    if (loading || !connected || !imageAccess || busy || uploadBusy || !imageUrl.trim() || (submit ? (!freebeatUploadCheck?.eligible || !freebeatUploadConsent) : !uploadCheckConsent)) return;
    const version = uploadCheckVersion.current;
    setBusy(true); setError(''); setFreebeatUploadResult(null); setFreebeatUploadConsent(false);
    try {
      const result = await request(submit ? 'video-upload-image' : 'video-upload-check', 'POST', { image_url: imageUrl.trim(), acknowledge: true });
      if (version !== uploadCheckVersion.current) return;
      setFreebeatUploadCheck({ eligible: result.eligible === true, reason: result.reason });
      if (submit && result.eligible === true) { setFreebeatUploadResult(result.outcome || 'unknown'); setUploadCheckConsent(false); setFreebeatUploadCheck(null); }
    } catch (err) {
      if (version === uploadCheckVersion.current) {
        setFreebeatUploadCheck(null); setUploadCheckConsent(false);
        if (submit) setFreebeatUploadResult('unknown');
        else setError(err.message || 'Pemeriksaan upload belum tersedia.');
      }
    } finally { setBusy(false); }
  }

  async function copyUrl() {
    try { await navigator.clipboard.writeText(imageUrl); setUploadNotice('URL disalin.'); }
    catch { setUploadNotice('Tidak dapat menyalin otomatis. Pilih dan salin URL secara manual.'); }
  }

  // Only numeric IDs can be used by Freebeat's video diagnostic API.
  const modelOptions = [];
  const seen = new Set();
  for (const item of videoModels?.models || []) {
    const id = item?.model_id;
    if (!(typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))) continue;
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number < 0 || typeof item.name !== 'string' || seen.has(number)) continue;
    seen.add(number);
    modelOptions.push({ id: number, name: item.member_only === true ? `${item.name} · khusus member` : item.name, member_only: item.member_only === true });
  }
  const selected = model !== '' && modelOptions.some((item) => String(item.id) === model);
  async function inspect(action) {
    if (loading || !connected || videoBusy || busy || uploadBusy || !selected || (action === 'video-model-quote' && (!prompt.trim() || !imageUrl.trim()))) return;
    const version = catalogVersion.current, connectionVersion = visibilityVersion.current;
    setBusy(true); setError(''); clearApproval();
    if (action === 'video-model-help') setHelp(null); else setQuote(null);
    try {
      const input = action === 'video-model-help' ? { model_id: Number(model) } : { model_id: Number(model), prompt, image_url: imageUrl };
      const result = await request(action, 'POST', input);
      if (version !== catalogVersion.current || connectionVersion !== visibilityVersion.current) return;
      if (action === 'video-model-help') setHelp({ model_id: result.model_id, help: result.help });
      else setQuote({ ...result.settings, quote: result.quote });
    } catch (err) { setError(err.message || 'Pemeriksaan video gagal.'); }
    finally { setBusy(false); }
  }
  async function inspectPrivateHelp() {
    if (loading || !connected || videoBusy || busy || uploadBusy || !selected || !privateHelpConsent) return;
    const version = catalogVersion.current, connectionVersion = visibilityVersion.current;
    setBusy(true); setError(''); setPrivateHelp(null); clearApproval();
    try {
      const result = await request('video-model-private-help', 'POST', { model_id: Number(model), acknowledge: true });
      if (version === catalogVersion.current && connectionVersion === visibilityVersion.current && result.model_id === Number(model)) setPrivateHelp(result);
    } catch (err) { setError(err.message || 'Informasi model privat tidak tersedia.'); }
    finally { setBusy(false); }
  }
  async function refreshTests() {
    const result = await request('video-tests');
    setTests(result.tests);
  }
  async function prepare() {
    if (busy || uploadBusy || videoBusy || loading || !connected || !imageAccess || !selected || !prompt.trim() || !imageUrl.trim()) return;
    const version = catalogVersion.current, connectionVersion = visibilityVersion.current;
    setBusy(true); setError(''); setTestNotice(''); setInitialDiagnostics(null); clearApproval();
    try {
      const result = await request('video-prepare', 'POST', { model_id: Number(model), prompt, image_url: imageUrl });
      // Settings are now normalized per model by the Worker (resolution,
      // duration, generation type follow get_model_help), so validate internal
      // consistency and the exact input echo instead of fixed global defaults.
      const s = result.settings;
      if (!s || s.model_id !== Number(model) || typeof s.generation_type !== 'string' || !s.generation_type || !Number.isSafeInteger(s.duration) || s.duration <= 0 || s.duration > 600 || typeof s.resolution !== 'string' || !s.resolution || result.prompt !== prompt.trim() || result.image_url !== imageUrl.trim() || typeof result.credits !== 'number' || !Number.isFinite(result.credits) || result.credits < 0 || typeof result.approval !== 'string') throw new Error('Persetujuan tidak cocok dengan input yang dipilih. Tidak ada video dikirim; buat quote baru.');
      await refreshTests();
      if (version === catalogVersion.current && connectionVersion === visibilityVersion.current) setApproval(result);
    }
    catch (err) { setError(err.message || 'Persiapan uji video gagal.'); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!approval || !confirmed || busy || uploadBusy || videoBusy || !connected || !imageAccess || !selected || approval.settings?.model_id !== Number(model)) return;
    const receipt = approval.approval;
    const capture = initialConsent, version = visibilityVersion.current;
    clearApproval(); setBusy(true); setError(''); setTestNotice(''); setInitialDiagnostics(null);
    try {
      const result = await request('video-submit', 'POST', { approval: receipt, confirm: true, ...(capture ? { private_diagnostics: true } : {}) });
      if (capture && version === visibilityVersion.current) setInitialDiagnostics(result.initial_diagnostics || { received: false, messages: [] });
      if (result.status === 'submitted') setTestNotice('Permintaan diterima untuk dipantau, bukan konfirmasi video selesai atau biaya akhir.');
      else setError(`Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan ulangi; periksa Freebeat dan catatan uji.${result.recoveryTaskId ? ` ID tugas untuk pemulihan pribadi: ${result.recoveryTaskId}` : ''}`);
    } catch (err) {
      if (capture && version === visibilityVersion.current) setInitialDiagnostics({ received: false, messages: [] });
      setError(`${err.message || 'Permintaan gagal.'} Jika pengiriman sempat terjadi, hasil dan biaya mungkin tidak pasti. Jangan ulangi sebelum memeriksa catatan.`);
    }
    try { await refreshTests(); } catch { /* warning above still applies */ }
    setBusy(false);
  }
  async function inspectTests() {
    if (busy) return;
    setBusy(true); setError('');
    try { await refreshTests(); } catch (err) { setError(err.message || 'Catatan tidak tersedia.'); }
    finally { setBusy(false); }
  }
  async function poll(id, acknowledge = false) {
    if (busy) return;
    setBusy(true); setError('');
    setPrivateFailure((old) => { const next = { ...old }; delete next[id]; return next; });
    setPrivacyConsent((old) => ({ ...old, [id]: false }));
    try { const result = await request('video-task', 'POST', acknowledge ? { id, acknowledge: true } : { id }); setTaskResults((old) => ({ ...old, [id]: result.task })); }
    catch (err) { setError(err.message || 'Status belum tersedia.'); }
    finally { setBusy(false); }
  }
  async function viewPrivateFailure(id) {
    if (busy || !connected || !privacyConsent[id]) return;
    const version = visibilityVersion.current;
    setBusy(true); setError('');
    try {
      const result = await request('video-private-failure', 'POST', { id, acknowledge: true });
      if (version === visibilityVersion.current) setPrivateFailure((old) => ({ ...old, [id]: result.reasons }));
    } catch (err) { setError(err.message || 'Pesan kegagalan tidak tersedia.'); }
    finally { setBusy(false); }
  }
  function hidePrivateFailure(id) {
    setPrivateFailure((old) => { const next = { ...old }; delete next[id]; return next; });
    setPrivacyConsent((old) => ({ ...old, [id]: false }));
  }
  const blockers = [
    ...(loading ? ['Menunggu pemeriksaan koneksi Freebeat.'] : !connected ? ['Hubungkan Freebeat terlebih dahulu.'] : []),
    ...(videoBusy ? ['Menunggu daftar model video.'] : []),
    ...(busy || uploadBusy ? ['Tunggu pemeriksaan atau upload yang sedang berjalan.'] : []),
    ...(!selected ? ['Pilih model dari daftar Freebeat.'] : []),
    ...(!prompt.trim() ? ['Isi prompt video.'] : []),
    ...(!imageUrl.trim() ? ['Isi URL HTTPS gambar atau upload gambar.'] : []),
  ];
  return <div className="freebeat-result">
    <h3>Pemeriksaan video · baca saja</h3>
    <p>Pilih model dari daftar Freebeat. Quote menggunakan gambar ke video; durasi dan resolusi dimulai dari nilai bawaan lalu disesuaikan otomatis dengan kemampuan model menurut bantuan model. Pemeriksaan tidak membuat video atau memakai kredit.</p>
    <label className="freebeat-field">Model video
      <select id="freebeat-video-model" value={selected ? model : ''} disabled={loading || !connected || videoBusy || busy || uploadBusy || !modelOptions.length} onChange={(event) => { setModel(event.target.value); setHelp(null); setPrivateHelp(null); setPrivateHelpConsent(false); setInitialDiagnostics(null); setQuote(null); setError(''); clearApproval(); }}>
        <option value="">{videoBusy ? 'Memuat model…' : 'Pilih model video'}</option>
        {modelOptions.map((item) => <option key={item.id} value={String(item.id)}>{item.name} · ID {item.id}</option>)}
      </select>
    </label>
    {connected && !videoBusy && !modelOptions.length && <p>Belum ada model ber-ID angka yang dapat dipilih. Muat ulang daftar model di atas.</p>}
    {videoModels?.truncated && <p>Daftar Freebeat dibatasi sampai 100 model; mungkin belum lengkap.</p>}
    {videoModels?.models?.length > modelOptions.length && <p>Hanya model dengan ID angka yang dapat diperiksa; ID lain atau duplikat tidak ditampilkan.</p>}
    <details className="freebeat-upload"><summary>Upload gambar ke Supabase (opsional)</summary>
    <p>Gambar disimpan di bucket publik: gambar dan URL dapat ditemukan atau dibuka tanpa login. Jangan unggah gambar pribadi atau rahasia. Gambar tetap tersimpan sampai dihapus; link tidak kedaluwarsa otomatis. Penghapusan tidak menjamin salinan atau cache pihak lain ikut terhapus.</p>
    <p>JPG, PNG, atau WebP, maksimal 10 MB. Setelah upload, URL terisi otomatis. Tombol hapus hanya tersedia selama halaman ini terbuka; setelah dimuat ulang, hapus melalui dashboard Supabase Storage pada folder akun Anda.</p>
    <label className="freebeat-field">Pilih gambar<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || uploadBusy || Boolean(uploaded)} onChange={(event) => { setFile(event.target.files?.[0] || null); setUploadError(''); setUploadNotice(''); }} /></label>
    <label className="freebeat-confirm"><input type="checkbox" checked={publicConfirmed} disabled={busy || uploadBusy || Boolean(uploaded)} onChange={(event) => setPublicConfirmed(event.target.checked)} /> Saya memahami gambar akan disimpan secara publik di Supabase.</label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={busy || uploadBusy || !file || !publicConfirmed || !userId || Boolean(uploaded)} onClick={uploadImage}>{uploadBusy ? 'Memproses…' : 'Upload gambar ke Supabase'}</button>
      {uploaded && <button type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={removeImage}>Hapus gambar dari Supabase</button>}
    </div>
    {uploadError && <div className="freebeat-alert is-error" role="alert">{uploadError}</div>}
    {uploadNotice && <p role="status">{uploadNotice}</p>}
    </details>
    <p>Untuk memeriksa quote, gunakan URL hasil upload atau masukkan URL HTTPS lain yang dapat diakses Freebeat. Menekan tombol quote mengirim prompt dan URL tersebut ke Freebeat; jangan gunakan gambar pribadi atau URL bertanda tangan yang tidak ingin Anda bagikan.</p>
    <label className="freebeat-field">Prompt video<input type="text" value={prompt} maxLength={2000} disabled={busy || uploadBusy} onChange={(event) => updatePrompt(event.target.value)} /></label>
    <label className="freebeat-field">URL HTTPS gambar<input type="url" value={imageUrl} maxLength={2048} disabled={busy || uploadBusy} autoComplete="off" onChange={(event) => updateImageUrl(event.target.value)} /></label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={!imageUrl || busy || uploadBusy} onClick={copyUrl}>Salin URL gambar</button>
      <button type="button" className="is-secondary" disabled={loading || !connected || videoBusy || busy || uploadBusy || !selected} onClick={() => inspect('video-model-help')}>Periksa informasi model</button>
      <button type="button" className="is-secondary" aria-describedby="video-quote-help" disabled={blockers.length > 0} onClick={() => inspect('video-model-quote')}>Periksa quote</button>
    </div>
    <div id="video-quote-help" className="freebeat-prepare-help" role="status" aria-live="polite">{blockers.length ? <>Untuk memeriksa quote:<ul>{blockers.map((message) => <li key={message}>{message}</li>)}</ul></> : 'Siap memeriksa quote tanpa membuat video atau memakai kredit.'}</div>
    {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
    {help !== null && <FreebeatCopyResult title="Informasi model video yang disaring" value={help} />}
    <details className="freebeat-upload">
      <summary>Informasi model lebih lengkap (privat)</summary>
      <p>Data Freebeat mungkin mengandung informasi pribadi atau rahasia. Penyaringan dilakukan sebisa mungkin tetapi tidak dijamin lengkap. Jangan salin atau bagikan data mentah, URL, token atau kredensial. Pemeriksaan hanya membaca informasi model dan tidak memakai kredit.</p>
      {privateHelp === null ? <>
        <label className="freebeat-confirm"><input type="checkbox" checked={privateHelpConsent} disabled={busy || videoBusy || !connected || !selected} onChange={(event) => setPrivateHelpConsent(event.target.checked)} /> Saya memahami data mungkin sensitif dan hanya akan melihatnya secara pribadi.</label>
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || videoBusy || busy || uploadBusy || !selected || !privateHelpConsent} onClick={inspectPrivateHelp}>Tampilkan informasi model privat</button></div>
      </> : <>
        <div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => { setPrivateHelp(null); setPrivateHelpConsent(false); }}>Sembunyikan informasi privat</button></div>
        {privateHelp.truncated && <p>Hasil mungkin terpotong atau sebagian field disembunyikan demi privasi.</p>}
        <pre aria-label="Informasi model privat">{JSON.stringify(privateHelp.help, null, 2)}</pre>
      </>}
    </details>
    {quote !== null && <FreebeatCopyResult title="Quote video yang disaring" value={quote} description="Hasil tidak memuat prompt atau URL gambar; quote bukan biaya akhir atau persetujuan generasi." />}
    <div className="freebeat-result">
      <h3>Uji generasi video khusus admin</h3>
      <p>Ini memakai kredit akun Freebeat admin, bukan kredit BLEA. Gunakan hanya sesuai ketentuan plan Freebeat. Biaya aktual dan refund tidak dijamin, termasuk jika tugas gagal. Jika hasil pengiriman tidak pasti, jangan ulangi sebelum memeriksa Freebeat dan catatan.</p>
      <p>Menyiapkan quote tidak membuat video. Pengiriman memerlukan konfirmasi terpisah, dengan batas maksimum quote ditambah margin keamanan agar pembulatan harga penyedia tidak menolak item. URL gambar dan prompt dikirim ke Freebeat; isi di URL dapat berubah setelah persetujuan.</p>
      {!imageAccess && <p>Hubungkan Freebeat dan setujui izin generasi terlebih dahulu di atas.</p>}
      {!selected && <p>Pilih model video di atas untuk menyiapkan quote persetujuan.</p>}
      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || videoBusy || busy || uploadBusy || !selected || !prompt.trim() || !imageUrl.trim()} onClick={prepare}>Siapkan quote untuk persetujuan video</button>
        <button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy} onClick={inspectTests}>Periksa catatan uji video</button>
      </div>
      {approval && <div className="freebeat-result">
        <h3>Periksa dan setujui satu video</h3>
        <p>Model {modelOptions.find((item) => item.id === approval.settings.model_id)?.name || 'video'} · ID {approval.settings.model_id} · {approval.settings.generation_type === 'image' ? 'gambar ke video' : 'teks ke video'} · {approval.settings.duration} detik · {approval.settings.resolution} · quote <strong>{approval.credits} kredit</strong> · batas maksimum <strong>{approval.max_credits ?? approval.credits} kredit Freebeat</strong>. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}; jika quote berubah, pengiriman ditolak.</p>
        {Array.isArray(approval.adjusted) && approval.adjusted.length > 0 && <p className="freebeat-alert" role="status">Setting uji disesuaikan otomatis dengan kemampuan model menurut bantuan model: {approval.adjusted.join(', ')}.</p>}
        <p>Prompt dan URL gambar yang akan dikirim:</p><pre>{approval.prompt}</pre><pre>{approval.image_url}</pre>
        <label className="freebeat-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !connected || !imageAccess} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui satu kali generasi video ini dengan batas maksimum {approval.max_credits ?? approval.credits} kredit Freebeat. Biaya aktual dan refund belum dipastikan.</label>
        <label className="freebeat-confirm"><input type="checkbox" checked={initialConsent} disabled={busy || !connected || !imageAccess} onChange={(event) => setInitialConsent(event.target.checked)} /> Opsional: tampilkan pesan respons awal secara privat setelah pengiriman ini. Pesan mungkin mengandung data sensitif; penyamaran tidak dijamin lengkap. Jangan bagikan pesan mentah, URL atau kredensial.</label>
        <div className="freebeat-actions"><button type="button" disabled={!confirmed || busy || uploadBusy || videoBusy || !connected || !imageAccess || !selected || approval.settings?.model_id !== Number(model)} onClick={submit}>Setujui dan kirim satu video</button></div>
      </div>}
      {testNotice && <div className="freebeat-alert" role="status">{testNotice}</div>}
      {initialDiagnostics && <div className="freebeat-result" aria-label="Diagnostik respons awal privat">
        <h3>Pesan respons awal privat</h3>
        <p>Hanya untuk Anda. Jangan bagikan pesan mentah; jelaskan dengan kata sendiri tanpa URL, token atau data pribadi. Pesan ini tidak disimpan dan hilang saat halaman ditutup. Pesan bukan kepastian biaya atau hasil tugas.</p>
        <div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => setInitialDiagnostics(null)}>Sembunyikan respons awal</button></div>
        {!initialDiagnostics.received ? <p>Respons awal tidak tersedia. Hasil pengiriman mungkin tidak pasti; jangan ulangi sebelum memeriksa catatan.</p> : initialDiagnostics.messages?.length ? initialDiagnostics.messages.map((message, index) => <pre key={index}>{message}</pre>) : <p>Tidak ada pesan awal dalam field yang dapat ditampilkan.</p>}
      </div>}
      {tests.length > 0 && <div className="freebeat-result"><h3>Catatan uji video admin</h3>{tests.map((test) => <div key={test.id} className="freebeat-test-row">
        <p>Model {test.model_id} · Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · {test.status}</p>
        {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil tidak pasti; pengiriman video baru diblokir. Jangan ulangi. Periksa aktivitas Freebeat dan minta operator meninjau catatan.</p>}
        {test.status === 'submitted' && !test.canPoll && <p>Uji ini dikirim dari sesi Freebeat yang lebih lama.</p>}
        {test.status === 'submitted' && !test.canPoll && connected && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy} onClick={() => poll(test.id, true)}>Periksa status (sesi lama)</button></div>}
        {test.canPoll && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy} onClick={() => poll(test.id)}>Periksa status video</button></div>}
        {taskResults[test.id] && <div className="freebeat-task-result"><p>Status tugas: {taskResults[test.id].status}. Biaya/refund yang tidak dilaporkan tidak diketahui.</p><pre>{JSON.stringify(taskResults[test.id].billing, null, 2)}</pre>
          {['failed', 'partial_failed', 'action_required'].includes(taskResults[test.id].status) && <>
            <p>Rincian kegagalan di bawah disaring; nilai kosong berarti tidak diketahui atau tidak dilaporkan. Pesan bebas disembunyikan demi privasi. Nilai retryable bukan persetujuan membuat ulang video.</p>
            <FreebeatCopyResult title="Status video dan rincian kegagalan yang disaring" value={{ status: taskResults[test.id].status, billing: taskResults[test.id].billing, failure: taskResults[test.id].failure, item_failures: taskResults[test.id].item_failures }} />
            {(test.canPoll || Boolean(taskResults[test.id])) && connected && <div className="freebeat-result">
              <h3>Pesan kegagalan pribadi</h3>
              <p>Pesan status dan kesalahan batch/item dari Freebeat mungkin berisi prompt, data pribadi atau kredensial. Beberapa pola sensitif disamarkan, tetapi penyaringan tidak dijamin lengkap. Jangan salin atau bagikan pesan mentah; jika perlu bantuan, jelaskan penyebabnya dengan kata-kata sendiri tanpa URL, token atau data pribadi.</p>
              {!Object.hasOwn(privateFailure, test.id) && <>
                <label className="freebeat-confirm"><input type="checkbox" checked={Boolean(privacyConsent[test.id])} disabled={busy} onChange={(event) => setPrivacyConsent((old) => ({ ...old, [test.id]: event.target.checked }))} /> Saya memahami pesan mungkin mengandung informasi sensitif dan hanya akan melihatnya secara pribadi.</label>
                <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy || !privacyConsent[test.id]} onClick={() => viewPrivateFailure(test.id)}>Tampilkan pesan kegagalan pribadi</button></div>
              </>}
              {Object.hasOwn(privateFailure, test.id) && <><div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => hidePrivateFailure(test.id)}>Sembunyikan pesan pribadi</button></div>
                {privateFailure[test.id].length ? privateFailure[test.id].map((reason, index) => <pre key={index}>{reason}</pre>) : <p>Freebeat tidak memberikan pesan kegagalan berbentuk teks yang dapat ditampilkan.</p>}
              </>}
            </div>}
          </>}
          {taskResults[test.id].videos.length > 0 && <div className="freebeat-result-links">{taskResults[test.id].videos.map((url, index) => <a className="freebeat-result-link" href={url} key={url} target="_blank" rel="noopener noreferrer">Buka hasil video {index + 1}</a>)}</div>}
          {taskResults[test.id].status === 'completed' && taskResults[test.id].videos.length === 0 && <p>Video selesai tetapi tautan belum tersedia. Periksa lagi atau lihat Freebeat; jangan ulangi generasi.</p>}
          {taskResults[test.id].videos.length > 0 && <p>Membuka tautan menghubungkan browser ke host penyedia; jangan bagikan tautan pribadi.</p>}
        </div>}
      </div>)}</div>}
    </div>
    <details className="freebeat-upload"><summary>Periksa pengambilan gambar oleh Freebeat</summary>
      <p>Pemeriksaan mengirim URL gambar di atas ke Freebeat untuk memeriksa skema dan quote, tanpa upload atau generasi. Gunakan hanya gambar yang boleh dibagikan; jangan gunakan URL bertanda tangan atau rahasia.</p>
      <p>Upload berikutnya hanya tersedia jika Freebeat mengembalikan quote tepat 0 dan skema menyediakan batas kredit; server memeriksa ulang sebelum mengirim batas 0. Quote dan batas bukan jaminan biaya aktual. Jika biaya atau batas tidak tersedia, upload diblokir.</p>
      <label className="freebeat-confirm"><input type="checkbox" checked={uploadCheckConsent} disabled={busy || uploadBusy || !connected} onChange={(event) => setUploadCheckConsent(event.target.checked)} /> Saya mengizinkan pengiriman URL ini ke Freebeat untuk pemeriksaan skema dan quote.</label>
      <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || busy || uploadBusy || !imageUrl.trim() || !uploadCheckConsent} onClick={() => inspectFreebeatUpload(false)}>Periksa biaya dan batas upload Freebeat</button></div>
      {freebeatUploadCheck && (freebeatUploadCheck.eligible ? <>
        <p>Freebeat mengutip 0 kredit dan menyediakan parameter batas. Upload akan meminta batas 0; biaya aktual tidak dijamin. Gambar dapat disalin dan disimpan di Freebeat, dengan retensi dan akses yang diatur Freebeat. Ini tidak membuat video.</p>
        <label className="freebeat-confirm"><input type="checkbox" checked={freebeatUploadConsent} disabled={busy || !connected} onChange={(event) => setFreebeatUploadConsent(event.target.checked)} /> Saya menyetujui satu upload gambar ini ke Freebeat dengan batas 0 kredit.</label>
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy || uploadBusy || !connected || !freebeatUploadConsent} onClick={() => inspectFreebeatUpload(true)}>Uji upload gambar ke Freebeat</button></div>
      </> : <p role="status">{freebeatUploadCheck.reason === 'cap_unavailable' ? 'Skema Freebeat tidak menyediakan batas kredit yang dapat digunakan. Upload diblokir.' : 'Quote nol tidak tersedia. Upload diblokir.'}</p>)}
      {freebeatUploadResult === 'uploaded' && <p role="status">Freebeat melaporkan upload berhasil dan mengembalikan URL gambar. Ini bukan jaminan generasi video akan berhasil; URL tidak disimpan atau dipakai otomatis.</p>}
      {freebeatUploadResult === 'unknown' && <p role="alert">Hasil upload tidak pasti; Freebeat mungkin sudah menyimpan salinan. Jangan ulangi sebelum memeriksa akun Freebeat.</p>}
    </details>
  </div>;
}
