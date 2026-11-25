import { useEffect, useRef, useState } from 'react';
import { uploadFreebeatImage, deleteFreebeatImage } from '../lib/freebeatVideoUpload';

export function FreebeatHailuoImageUpload({ connected, imageAccess, loading, disabled, request, storage, userId, onImageUrl, onBusyChange }) {
  const [file, setFile] = useState(null);
  const [source, setSource] = useState(null);
  const [shareConsent, setShareConsent] = useState(false);
  const [cost, setCost] = useState(null);
  const [costConsent, setCostConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const version = useRef(0);
  const lock = useRef(false);
  useEffect(() => {
    version.current += 1;
    setCost(null); setCostConsent(false); setShareConsent(false);
    setOutcome((previous) => previous === 'uploaded' ? '' : previous);
    return () => { version.current += 1; };
  }, [connected, userId]);
  const blocked = loading || !connected || !imageAccess || disabled || busy;
  const quoted = Number.isSafeInteger(cost?.credits) && cost.credits >= 0 && cost.credits <= 100;
  function start() {
    if (lock.current) return false;
    lock.current = true; setBusy(true); onBusyChange(true); setError('');
    return true;
  }
  function finish() { lock.current = false; setBusy(false); onBusyChange(false); }
  async function stageAndQuote() {
    if (blocked || !shareConsent || (!file && !source) || attempted || !start()) return;
    const stamp = version.current;
    setCost(null); setCostConsent(false);
    try {
      const staged = source || await uploadFreebeatImage(storage, userId, file);
      if (stamp !== version.current) return;
      setSource(staged);
      if (!staged.url) throw new Error('Foto tersimpan di BLEA tetapi URL publik tidak tersedia. Bersihkan foto sebelum mencoba kembali.');
      const result = await request('image-upload-quote', 'POST', { image_url: staged.url });
      if (stamp === version.current) setCost(result);
    } catch (err) { if (stamp === version.current) setError(err.message || 'Pemeriksaan biaya upload gagal.'); }
    finally { finish(); }
  }
  async function host() {
    if (blocked || attempted || !source?.url || !quoted || !costConsent || !start()) return;
    const stamp = version.current;
    // No automatic retry, including on timeout: a remote copy/charge may exist.
    setAttempted(true); setCostConsent(false); setOutcome('');
    try {
      const result = await request('image-upload-host', 'POST', { image_url: source.url, expected_credits: cost.credits, acknowledge: true });
      if (stamp !== version.current) return;
      let url = '';
      try {
        const parsed = new URL(result.image_url);
        if (result.outcome === 'uploaded' && parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash && parsed.toString().length <= 2048 && /(^|\.)(freebeat\.ai|freebeatfit\.com)$/.test(parsed.hostname)) url = parsed.toString();
      } catch { /* no usable URL means no quote handoff */ }
      if (!url) { setOutcome('unknown'); return; }
      setOutcome('uploaded'); onImageUrl(url);
    } catch {
      if (stamp === version.current) setOutcome('unknown');
    } finally { finish(); }
  }
  async function clearSource() {
    if (busy || disabled || !source || !start()) return;
    try {
      await deleteFreebeatImage(storage, source.path);
      setSource(null); setFile(null); setCost(null); setCostConsent(false); setShareConsent(false); setInputKey((value) => value + 1);
      // Keep the attempt lock and the Freebeat URL: deleting BLEA is not deleting Freebeat.
    } catch (err) { setError(err.message); }
    finally { finish(); }
  }
  return <div className="freebeat-result" aria-label="Upload gambar Hailuo ke Freebeat">
    <h4>1. Unggah foto → dapatkan URL Freebeat</h4>
    <p>JPG/PNG maksimal 10 MB. Foto lebih dulu disimpan di bucket publik BLEA, lalu URL-nya dikirim untuk quote upload_image. Memilih file belum mengunggah apa pun. Jangan gunakan foto rahasia.</p>
    {!imageAccess && <p role="status">Izin generasi/upload belum tersedia. Hubungkan ulang Freebeat melalui halaman utama dan setujui izin.</p>}
    <label className="freebeat-field">Pilih foto untuk Hailuo
      <input key={inputKey} type="file" accept="image/jpeg,image/png" aria-label="Foto Hailuo" disabled={blocked || Boolean(source) || attempted || !storage || !userId} onChange={(event) => {
        const chosen = event.target.files?.[0] || null;
        setFile(null); setError(''); setCost(null); setCostConsent(false); setShareConsent(false); onImageUrl('');
        if (chosen && (!['image/jpeg', 'image/png'].includes(chosen.type) || chosen.size <= 0 || chosen.size > 10 * 1024 * 1024)) { setError('Pilih gambar JPG atau PNG berukuran maksimal 10 MB.'); return; }
        setFile(chosen);
      }} />
    </label>
    <label className="freebeat-confirm"><input type="checkbox" aria-label="Setujui penyimpanan foto Hailuo" checked={shareConsent} disabled={blocked || (!file && !source) || attempted} onChange={(event) => setShareConsent(event.target.checked)} /> Saya mengizinkan foto disimpan publik di BLEA dan URL dikirim ke Freebeat untuk pemeriksaan biaya upload.</label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={blocked || (!file && !source) || !shareConsent || attempted} onClick={stageAndQuote}>{source ? 'Periksa ulang biaya upload Freebeat' : 'Unggah foto & periksa biaya upload Freebeat'}</button>
      <button type="button" className="is-secondary" disabled={busy || disabled || !source} onClick={clearSource}>Hapus foto dari BLEA</button>
    </div>
    {source && <p className="freebeat-note">Foto sumber tersimpan di BLEA. Hapus dengan tombol di atas sebelum meninggalkan halaman; setelah pindah halaman, kelola objek tertinggal melalui Supabase Storage. Menghapus sumber tidak menghapus salinan Freebeat.</p>}
    {cost && <>
      <p role="status">Quote upload_image: {quoted ? `${cost.credits} kredit Freebeat` : 'tidak tersedia atau di luar batas uji 0–100 kredit; upload diblokir'}.</p>
      <p>Ini biaya upload foto, bukan quote video. Server memeriksa ulang quote sebelum mengirim. Tool upload_image tidak menyediakan batas kredit keras; quote bukan jaminan tagihan akhir atau refund. Salinan dapat disimpan oleh Freebeat.</p>
      <label className="freebeat-confirm"><input type="checkbox" aria-label="Setujui biaya upload foto Hailuo" checked={costConsent} disabled={blocked || !quoted || attempted} onChange={(event) => setCostConsent(event.target.checked)} /> Saya menyetujui satu upload_image dengan quote {quoted ? cost.credits : 'belum diketahui'} kredit Freebeat dan memahami ketidakpastian biaya aktual.</label>
      <div className="freebeat-actions"><button type="button" disabled={blocked || !quoted || !costConsent || attempted} onClick={host}>Kirim foto ke Freebeat</button></div>
    </>}
    {busy && <p role="status">Memproses foto Hailuo; tidak membuat video…</p>}
    {outcome === 'uploaded' && <p role="status">URL hasil upload Freebeat sudah diisi pada kolom quote di bawah. Periksa prompt/rasio, centang izin quote, lalu klik Periksa quote Hailuo #106. Tidak ada quote video otomatis.</p>}
    {outcome === 'unknown' && <p role="alert">Hasil upload tidak pasti atau URL Freebeat tidak tersedia. Salinan/biaya mungkin sudah tercatat. Upload ulang diblokir pada halaman ini; periksa akun Freebeat sebelum mencoba lagi. Jangan muat ulang untuk mengulang upload yang belum pasti.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
