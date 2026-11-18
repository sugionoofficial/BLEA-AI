import { useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { uploadFreebeatImage, deleteFreebeatImage } from '../lib/freebeatVideoUpload';

export function FreebeatVideoDiagnostic({ connected, loading, request, userId, storage }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(null);
  const [quote, setQuote] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [imageUrl, setImageUrl] = useState('');
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
      if (item.url) { setImageUrl(item.url); setQuote(null); setUploadNotice('Gambar tersimpan dan URL publik terisi di bawah.'); }
      else setUploadError('Gambar tersimpan, tetapi URL tidak tersedia. Anda dapat menghapusnya di bawah.');
    } catch (err) { setUploadError(err.message || 'Upload tidak berhasil; periksa Supabase Storage.'); }
    finally { setUploadBusy(false); }
  }
  async function removeImage() {
    if (!uploaded || busy || uploadBusy) return;
    setUploadBusy(true); setUploadError(''); setUploadNotice('');
    try {
      await deleteFreebeatImage(storage, uploaded.path);
      if (imageUrl === uploaded.url) { setImageUrl(''); setQuote(null); }
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
    if (action === 'video-help') setHelp(null); else setQuote(null);
    try {
      const result = await request(action, 'POST', action === 'video-help' ? {} : { prompt, image_url: imageUrl });
      if (action === 'video-help') setHelp(result.help); else setQuote(result.quote);
    } catch (err) { setError(err.message || 'Pemeriksaan video gagal.'); }
    finally { setBusy(false); }
  }
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
    <p>Quote memakai mode gambar dan opsi default Freebeat, tanpa durasi atau resolusi yang dipilih. Angka quote bukan biaya akhir dan tidak menjamin generasi berhasil. Tidak ada generasi atau pengeluaran kredit pada pemeriksaan ini.</p>
    <label className="freebeat-field">Prompt video<input type="text" value={prompt} maxLength={2000} disabled={busy || uploadBusy} onChange={(event) => { setPrompt(event.target.value); setQuote(null); }} /></label>
    <label className="freebeat-field">URL HTTPS gambar<input type="url" value={imageUrl} maxLength={2048} disabled={busy || uploadBusy} autoComplete="off" onChange={(event) => { setImageUrl(event.target.value); setQuote(null); }} /></label>
    <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={!imageUrl || busy || uploadBusy} onClick={copyUrl}>Salin URL gambar</button><button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy || !prompt.trim() || !imageUrl.trim()} onClick={() => inspect('video-quote')}>Periksa quote Wan 3.0</button></div>
    {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
    {quote !== null && <FreebeatCopyResult title="Quote video yang disaring" value={{ model_id: 182, generation_type: 'image', quote }} description="Hasil ini tidak memuat prompt atau URL gambar. Quote bukan biaya akhir maupun persetujuan generasi." />}
  </div>;
}
