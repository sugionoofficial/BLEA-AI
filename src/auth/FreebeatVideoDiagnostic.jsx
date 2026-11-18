import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { uploadFreebeatImage, deleteFreebeatImage } from '../lib/freebeatVideoUpload';
import { FREEBEAT_VIDEO_TEST, FREEBEAT_GEMINI_DIAGNOSTIC } from '../lib/freebeatVideoTestSettings';

export function FreebeatVideoDiagnostic({ connected, imageAccess, loading, request, userId, storage }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(null);
  const [quote, setQuote] = useState(null);
  const [geminiHelp, setGeminiHelp] = useState(null);
  const [geminiQuote, setGeminiQuote] = useState(null);
  const [geminiError, setGeminiError] = useState('');
  const [otherModel, setOtherModel] = useState('184');
  const [otherHelp, setOtherHelp] = useState(null);
  const [otherQuote, setOtherQuote] = useState(null);
  const [otherError, setOtherError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const [privateFailure, setPrivateFailure] = useState({});
  const [privacyConsent, setPrivacyConsent] = useState({});
  const visibilityVersion = useRef(0);
  useEffect(() => {
    if (!connected) { setPrivateFailure({}); setPrivacyConsent({}); setTaskResults({}); setGeminiHelp(null); setGeminiQuote(null); setOtherHelp(null); setOtherQuote(null); }
    return () => { visibilityVersion.current += 1; };
  }, [connected]);
  const [testNotice, setTestNotice] = useState('');
  function clearApproval() { setApproval(null); setConfirmed(false); }
  function updatePrompt(value) { setPrompt(value); setQuote(null); setGeminiQuote(null); setGeminiError(''); setOtherQuote(null); setOtherError(''); clearApproval(); }
  function updateImageUrl(value) { setImageUrl(value); setQuote(null); setGeminiQuote(null); setGeminiError(''); setOtherQuote(null); setOtherError(''); clearApproval(); }
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
      if (item.url) { setImageUrl(item.url); setQuote(null); setGeminiQuote(null); setOtherQuote(null); setOtherError(''); clearApproval(); setUploadNotice('Gambar tersimpan dan URL publik terisi di bawah.'); }
      else setUploadError('Gambar tersimpan, tetapi URL tidak tersedia. Anda dapat menghapusnya di bawah.');
    } catch (err) { setUploadError(err.message || 'Upload tidak berhasil; periksa Supabase Storage.'); }
    finally { setUploadBusy(false); }
  }
  async function removeImage() {
    if (!uploaded || busy || uploadBusy) return;
    setUploadBusy(true); setUploadError(''); setUploadNotice('');
    try {
      await deleteFreebeatImage(storage, uploaded.path);
      if (imageUrl === uploaded.url) { setImageUrl(''); setQuote(null); setGeminiQuote(null); setOtherQuote(null); setOtherError(''); clearApproval(); }
      setUploaded(null); setFile(null); setPublicConfirmed(false);
      if (fileInput.current) fileInput.current.value = '';
      setUploadNotice('Gambar dihapus dari Supabase. Salinan atau cache pihak lain mungkin masih ada.');
    } catch (err) { setUploadError(err.message || 'Penghapusan gagal; periksa Supabase Storage.'); }
    finally { setUploadBusy(false); }
  }
  async function copyUrl() {
    try { await navigator.clipboard.writeText(imageUrl); setUploadNotice('URL disalin.'); }
    catch { setUploadNotice('Tidak dapat menyalin otomatis. Pilih dan salin URL secara manual.'); }
  }

  async function inspect(action) {
    if (busy) return;
    setBusy(true); setError('');
    if (action === 'video-help') setHelp(null); else { setQuote(null); clearApproval(); }
    try {
      const result = await request(action, 'POST', action === 'video-help' ? {} : { prompt, image_url: imageUrl });
      if (action === 'video-help') setHelp(result.help); else setQuote(result.quote);
    } catch (err) { setError(err.message || 'Pemeriksaan video gagal.'); }
    finally { setBusy(false); }
  }
  async function inspectGemini(action) {
    if (busy || uploadBusy || loading || !connected || (action === 'video-gemini-quote' && (!prompt.trim() || !imageUrl.trim()))) return;
    setBusy(true); setGeminiError(''); clearApproval();
    if (action === 'video-gemini-help') setGeminiHelp(null); else setGeminiQuote(null);
    try {
      const result = await request(action, 'POST', action === 'video-gemini-help' ? {} : { prompt, image_url: imageUrl });
      if (action === 'video-gemini-help') setGeminiHelp(result.help); else setGeminiQuote(result.quote);
    } catch (err) { setGeminiError(err.message || 'Pemeriksaan Gemini gagal.'); }
    finally { setBusy(false); }
  }
  const validOtherModel = /^\d+$/.test(otherModel) && Number.isSafeInteger(Number(otherModel));
  async function inspectOther(action) {
    if (busy || uploadBusy || loading || !connected || !validOtherModel || (action === 'video-model-quote' && (!prompt.trim() || !imageUrl.trim()))) return;
    setBusy(true); setOtherError(''); clearApproval();
    if (action === 'video-model-help') setOtherHelp(null); else setOtherQuote(null);
    try {
      const input = action === 'video-model-help' ? { model_id: Number(otherModel) } : { model_id: Number(otherModel), prompt, image_url: imageUrl };
      const result = await request(action, 'POST', input);
      if (action === 'video-model-help') setOtherHelp({ model_id: result.model_id, help: result.help });
      else setOtherQuote({ ...result.settings, quote: result.quote });
    } catch (err) { setOtherError(err.message || 'Pemeriksaan model video gagal.'); }
    finally { setBusy(false); }
  }
  async function refreshTests() {
    const result = await request('video-tests');
    setTests(result.tests);
  }
  async function prepare() {
    if (busy || uploadBusy) return;
    setBusy(true); setError(''); setTestNotice(''); clearApproval();
    try { const result = await request('video-prepare', 'POST', { prompt, image_url: imageUrl }); await refreshTests(); setApproval(result); }
    catch (err) { setError(err.message || 'Persiapan uji video gagal.'); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!approval || !confirmed || busy) return;
    const receipt = approval.approval;
    clearApproval(); setBusy(true); setError(''); setTestNotice('');
    try {
      const result = await request('video-submit', 'POST', { approval: receipt, confirm: true });
      if (result.status === 'submitted') setTestNotice('Permintaan diterima untuk dipantau, bukan konfirmasi video selesai atau biaya akhir.');
      else setError(`Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan ulangi; periksa Freebeat dan catatan uji.${result.recoveryTaskId ? ` ID tugas untuk pemulihan pribadi: ${result.recoveryTaskId}` : ''}`);
    } catch (err) { setError(`${err.message || 'Permintaan gagal.'} Jika pengiriman sempat terjadi, hasil dan biaya mungkin tidak pasti. Jangan ulangi sebelum memeriksa catatan.`); }
    try { await refreshTests(); } catch { /* warning above still applies */ }
    setBusy(false);
  }
  async function inspectTests() {
    if (busy) return;
    setBusy(true); setError('');
    try { await refreshTests(); } catch (err) { setError(err.message || 'Catatan tidak tersedia.'); }
    finally { setBusy(false); }
  }
  async function poll(id) {
    if (busy) return;
    setBusy(true); setError('');
    setPrivateFailure((old) => { const next = { ...old }; delete next[id]; return next; });
    setPrivacyConsent((old) => ({ ...old, [id]: false }));
    try { const result = await request('video-task', 'POST', { id }); setTaskResults((old) => ({ ...old, [id]: result.task })); }
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
  const geminiBlockers = [
    ...(loading ? ['Menunggu pemeriksaan koneksi Freebeat.'] : !connected ? ['Freebeat belum terhubung atau sesi sudah berakhir. Hubungkan melalui tombol di atas.'] : []),
    ...(busy || uploadBusy ? ['Tunggu pemeriksaan atau upload yang sedang berjalan.'] : []),
    ...(!prompt.trim() ? ['Isi prompt video pada kolom Gemini di bawah.'] : []),
    ...(!imageUrl.trim() ? ['Isi URL gambar HTTPS pada kolom Gemini, atau upload gambar di bagian atas.'] : []),
  ];
  const otherBlockers = [
    ...(loading ? ['Menunggu pemeriksaan koneksi Freebeat.'] : !connected ? ['Hubungkan Freebeat terlebih dahulu.'] : []),
    ...(busy || uploadBusy ? ['Tunggu pemeriksaan atau upload yang sedang berjalan.'] : []),
    ...(!validOtherModel ? ['Isi ID model video berupa angka bulat nonnegatif.'] : []),
    ...(!prompt.trim() ? ['Isi prompt video di bawah.'] : []),
    ...(!imageUrl.trim() ? ['Isi URL HTTPS gambar atau upload gambar di atas.'] : []),
  ];
  return <div className="freebeat-result">
    <h3>Wan 3.0 · ID 182 · gambar ke video</h3>
    <p>Periksa opsi model sebelum quote. Respons disaring: beberapa opsi, harga atau pesan mungkin tersembunyi. Hasil ini tidak membuktikan dukungan gambar-ke-video jika informasinya tidak terlihat.</p>
    <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || busy} onClick={() => inspect('video-help')}>Periksa informasi Wan 3.0</button></div>
    {help !== null && <FreebeatCopyResult title="Informasi Wan 3.0 yang disaring" value={{ model_id: 182, help }} />}
    <p><strong>Upload gambar ke Supabase (opsional).</strong> Gambar disimpan di bucket publik: gambar dan URL dapat ditemukan atau dibuka tanpa login. Jangan unggah gambar pribadi atau rahasia. Gambar tetap tersimpan sampai dihapus; link tidak kedaluwarsa otomatis. Penghapusan tidak menjamin salinan atau cache pihak lain ikut terhapus.</p>
    <p>JPG, PNG, atau WebP, maksimal 10 MB. Setelah upload, URL terisi otomatis. Tombol hapus hanya tersedia selama halaman ini terbuka; setelah dimuat ulang, hapus melalui dashboard Supabase Storage pada folder akun Anda.</p>
    <label className="freebeat-field">Pilih gambar<input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || uploadBusy || Boolean(uploaded)} onChange={(event) => { setFile(event.target.files?.[0] || null); setUploadError(''); setUploadNotice(''); }} /></label>
    <label className="freebeat-confirm"><input type="checkbox" checked={publicConfirmed} disabled={busy || uploadBusy || Boolean(uploaded)} onChange={(event) => setPublicConfirmed(event.target.checked)} /> Saya memahami gambar akan disimpan secara publik di Supabase.</label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={busy || uploadBusy || !file || !publicConfirmed || !userId || Boolean(uploaded)} onClick={uploadImage}>{uploadBusy ? 'Memproses…' : 'Upload gambar ke Supabase'}</button>
      {uploaded && <button type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={removeImage}>Hapus gambar dari Supabase</button>}
    </div>
    {uploadError && <div className="freebeat-alert is-error" role="alert">{uploadError}</div>}
    {uploadNotice && <p role="status">{uploadNotice}</p>}
    <p>Untuk memeriksa quote, gunakan URL hasil upload atau masukkan URL HTTPS lain yang dapat diakses Freebeat. Menekan tombol quote mengirim prompt dan URL tersebut ke Freebeat; jangan gunakan gambar pribadi atau URL bertanda tangan yang tidak ingin Anda bagikan.</p>
    <p>Parameter quote: <strong>Wan 3.0 · gambar ke video · {FREEBEAT_VIDEO_TEST.duration} detik · {FREEBEAT_VIDEO_TEST.resolution}</strong>. Opsi lain memakai default Freebeat. Dukungan durasi dan resolusi ini belum terkonfirmasi; Freebeat dapat menolak atau tidak memberikan quote. Jangan menganggapnya pilihan termurah tanpa membandingkan quote.</p>
    <p>Angka quote bukan biaya akhir dan tidak menjamin generasi berhasil. Tidak ada generasi atau pengeluaran kredit pada pemeriksaan ini.</p>
    <label className="freebeat-field">Prompt video<input type="text" value={prompt} maxLength={2000} disabled={busy || uploadBusy} onChange={(event) => updatePrompt(event.target.value)} /></label>
    <label className="freebeat-field">URL HTTPS gambar<input type="url" value={imageUrl} maxLength={2048} disabled={busy || uploadBusy} autoComplete="off" onChange={(event) => updateImageUrl(event.target.value)} /></label>
    <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={!imageUrl || busy || uploadBusy} onClick={copyUrl}>Salin URL gambar</button><button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy || !prompt.trim() || !imageUrl.trim()} onClick={() => inspect('video-quote')}>Periksa quote Wan 3.0</button></div>
    {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
    {quote !== null && <FreebeatCopyResult title="Quote video yang disaring" value={{ ...FREEBEAT_VIDEO_TEST, quote }} description="Hasil ini tidak memuat prompt atau URL gambar. Quote bukan biaya akhir maupun persetujuan generasi." />}
    <div className="freebeat-result">
      <h3>Gemini Omni Flash V1.1 · ID 192 · baca saja</h3>
      <p>Periksa informasi model ini dan quote untuk gambar ke video, 5 detik, 480p menggunakan prompt dan URL gambar di atas. Dukungan pengaturan ini belum terkonfirmasi; hasil yang disaring bisa tidak lengkap. Quote bukan biaya akhir dan dapat ditolak atau tidak tersedia.</p>
      <p>Menekan quote mengirim prompt dan URL ke Freebeat, tanpa membuat video atau memakai kredit. Uji berbayar Gemini belum tersedia; tombol persetujuan di bawah tetap hanya untuk Wan 3.0.</p>
      <p>Isi kedua kolom di sini. Kolom ini berbagi input dengan Wan 3.0 di atas; jika Anda sudah mengunggah gambar, URL-nya akan terisi otomatis.</p>
      <label className="freebeat-field">Prompt video Gemini<input id="gemini-prompt" type="text" value={prompt} maxLength={2000} disabled={busy || uploadBusy} onChange={(event) => updatePrompt(event.target.value)} /></label>
      <label className="freebeat-field">URL HTTPS gambar Gemini<input id="gemini-image-url" type="url" value={imageUrl} maxLength={2048} disabled={busy || uploadBusy} autoComplete="off" onChange={(event) => updateImageUrl(event.target.value)} /></label>
      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy} onClick={() => inspectGemini('video-gemini-help')}>Periksa informasi Gemini Omni Flash V1.1</button>
        <button type="button" className="is-secondary" aria-describedby="gemini-quote-help" disabled={geminiBlockers.length > 0} onClick={() => inspectGemini('video-gemini-quote')}>Periksa quote Gemini Omni Flash V1.1</button>
      </div>
      <div id="gemini-quote-help" className="freebeat-prepare-help" role="status" aria-live="polite">{geminiBlockers.length ? <>Untuk memeriksa quote:<ul>{geminiBlockers.map((message) => <li key={message}>{message}</li>)}</ul></> : 'Siap memeriksa quote tanpa membuat video atau memakai kredit.'}</div>
      {geminiError && <div className="freebeat-alert is-error" role="alert">{geminiError}</div>}
      {geminiHelp !== null && <FreebeatCopyResult title="Informasi Gemini Omni Flash V1.1 yang disaring" value={{ model_id: FREEBEAT_GEMINI_DIAGNOSTIC.model_id, help: geminiHelp }} />}
      {geminiQuote !== null && <FreebeatCopyResult title="Quote Gemini Omni Flash V1.1 yang disaring" value={{ ...FREEBEAT_GEMINI_DIAGNOSTIC, quote: geminiQuote }} description="Hasil tidak memuat prompt atau URL gambar dan bukan persetujuan generasi." />}
    </div>
    <div className="freebeat-result">
      <h3>Model video lain · baca saja</h3>
      <p>ID awal 184 adalah Wan 3.0 Prime dari daftar sebelumnya; pilih ID lain dari daftar model video jika diinginkan. Pemeriksaan hanya meminta informasi atau quote gambar-ke-video 5 detik, 480p. Ketersediaan, dukungan opsi dan harga belum dipastikan.</p>
      <p>Quote mengirim prompt dan URL gambar ke Freebeat tanpa membuat video atau memakai kredit. Form ini tidak mengubah model uji berbayar: tombol persetujuan tetap untuk Wan 3.0 ID 182.</p>
      <label className="freebeat-field">ID model video<input id="other-video-model" type="number" min="0" step="1" value={otherModel} disabled={busy || uploadBusy} onChange={(event) => { setOtherModel(event.target.value); setOtherHelp(null); setOtherQuote(null); setOtherError(''); }} /></label>
      <label className="freebeat-field">Prompt video model lain<input id="other-video-prompt" type="text" value={prompt} maxLength={2000} disabled={busy || uploadBusy} onChange={(event) => updatePrompt(event.target.value)} /></label>
      <label className="freebeat-field">URL HTTPS gambar model lain<input id="other-video-url" type="url" value={imageUrl} maxLength={2048} disabled={busy || uploadBusy} autoComplete="off" onChange={(event) => updateImageUrl(event.target.value)} /></label>
      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy || !validOtherModel} onClick={() => inspectOther('video-model-help')}>Periksa informasi model video lain</button>
        <button type="button" className="is-secondary" aria-describedby="other-video-quote-help" disabled={otherBlockers.length > 0} onClick={() => inspectOther('video-model-quote')}>Periksa quote model video lain</button>
      </div>
      <div id="other-video-quote-help" className="freebeat-prepare-help" role="status" aria-live="polite">{otherBlockers.length ? <>Untuk memeriksa quote:<ul>{otherBlockers.map((message) => <li key={message}>{message}</li>)}</ul></> : 'Siap memeriksa quote tanpa membuat video atau memakai kredit.'}</div>
      {otherError && <div className="freebeat-alert is-error" role="alert">{otherError}</div>}
      {otherHelp !== null && <FreebeatCopyResult title="Informasi model video lain yang disaring" value={otherHelp} />}
      {otherQuote !== null && <FreebeatCopyResult title="Quote model video lain yang disaring" value={otherQuote} description="Hasil tidak memuat prompt atau URL gambar dan bukan persetujuan generasi." />}
    </div>
    <div className="freebeat-result">
      <h3>Uji generasi video khusus admin · Wan 3.0</h3>
      <p>Ini memakai kredit akun Freebeat admin, bukan kredit BLEA. Gunakan hanya sesuai ketentuan plan Freebeat. Biaya aktual dan refund tidak dijamin, termasuk jika tugas gagal. Jika hasil pengiriman tidak pasti, jangan ulangi sebelum memeriksa Freebeat dan catatan.</p>
      <p>Menyiapkan quote tidak membuat video. Pengiriman memerlukan konfirmasi terpisah, dengan batas maksimum sama dengan quote yang baru. URL gambar dan prompt dikirim ke Freebeat; isi di URL dapat berubah setelah persetujuan.</p>
      {!imageAccess && <p>Hubungkan Freebeat dan setujui izin generasi terlebih dahulu di atas.</p>}
      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || busy || uploadBusy || !prompt.trim() || !imageUrl.trim()} onClick={prepare}>Siapkan quote Wan 3.0 untuk persetujuan</button>
        <button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy} onClick={inspectTests}>Periksa catatan uji video</button>
      </div>
      {approval && <div className="freebeat-result">
        <h3>Periksa dan setujui satu video</h3>
        <p>Model {approval.settings.model_id} · gambar ke video · {approval.settings.duration} detik · {approval.settings.resolution} · quote dan batas maksimum <strong>{approval.credits} kredit Freebeat</strong>. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}; jika quote berubah, pengiriman ditolak.</p>
        <p>Prompt dan URL gambar yang akan dikirim:</p><pre>{approval.prompt}</pre><pre>{approval.image_url}</pre>
        <label className="freebeat-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !connected || !imageAccess} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui satu kali generasi video ini dengan batas maksimum {approval.credits} kredit Freebeat. Biaya aktual dan refund belum dipastikan.</label>
        <div className="freebeat-actions"><button type="button" disabled={!confirmed || busy || uploadBusy || !connected || !imageAccess} onClick={submit}>Setujui dan kirim satu video</button></div>
      </div>}
      {testNotice && <div className="freebeat-alert" role="status">{testNotice}</div>}
      {tests.length > 0 && <div className="freebeat-result"><h3>Catatan uji video admin</h3>{tests.map((test) => <div key={test.id} className="freebeat-test-row">
        <p>Model {test.model_id} · Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · {test.status}</p>
        {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil tidak pasti; pengiriman video baru diblokir. Jangan ulangi. Periksa aktivitas Freebeat dan minta operator meninjau catatan.</p>}
        {test.status === 'submitted' && !test.canPoll && <p>Status hanya dapat diperiksa dari sesi Freebeat yang digunakan saat pengiriman.</p>}
        {test.canPoll && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy} onClick={() => poll(test.id)}>Periksa status video</button></div>}
        {taskResults[test.id] && <div className="freebeat-task-result"><p>Status tugas: {taskResults[test.id].status}. Biaya/refund yang tidak dilaporkan tidak diketahui.</p><pre>{JSON.stringify(taskResults[test.id].billing, null, 2)}</pre>
          {['failed', 'partial_failed', 'action_required'].includes(taskResults[test.id].status) && <>
            <p>Rincian kegagalan di bawah disaring; nilai kosong berarti tidak diketahui atau tidak dilaporkan. Pesan bebas disembunyikan demi privasi. Nilai retryable bukan persetujuan membuat ulang video.</p>
            <FreebeatCopyResult title="Status video dan rincian kegagalan yang disaring" value={{ status: taskResults[test.id].status, billing: taskResults[test.id].billing, failure: taskResults[test.id].failure, item_failures: taskResults[test.id].item_failures }} />
            {test.canPoll && connected && <div className="freebeat-result">
              <h3>Pesan kegagalan pribadi</h3>
              <p>Pesan dari Freebeat mungkin berisi prompt, data pribadi atau kredensial. Beberapa pola sensitif disamarkan, tetapi penyaringan tidak dijamin lengkap. Jangan salin atau bagikan pesan mentah; jika perlu bantuan, jelaskan penyebabnya dengan kata-kata sendiri tanpa URL, token atau data pribadi.</p>
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
  </div>;
}
