import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { FreebeatHailuoImageUpload } from './FreebeatHailuoImageUpload';
import { FreebeatSingleImageVideoGeneration } from './FreebeatSingleImageVideoGeneration';
import { FREEBEAT_VIDEO_RESOLUTIONS, FREEBEAT_VIDEO_ASPECT_RATIOS } from '../lib/freebeatVideoTestSettings';

// User-provided web identity is a candidate, never consumer model metadata.
const CANDIDATE = Object.freeze({ model_id: 97 });

export function FreebeatLtxDiagnostic({ connected, loading, request, imageAccess = false, storage, userId }) {
  const [imageUrl, setImageUrl] = useState('');
  const [prompt, setPrompt] = useState('Gerakan kamera perlahan, subjek dan penampilan tetap konsisten dengan gambar referensi.');
  const [aspectRatio, setAspectRatio] = useState('');
  const [duration, setDuration] = useState('');
  const [resolution, setResolution] = useState('');
  const lock = useRef(false);
  const [consent, setConsent] = useState(false);
  const [requestBusy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [generationBusy, setGenerationBusy] = useState(false);
  const busy = requestBusy || uploadBusy || generationBusy;
  const [help, setHelp] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => {
    version.current += 1;
    setHelp(null); setQuote(null); setError(''); setConsent(false); setImageUrl('');
    return () => { version.current += 1; };
  }, [connected, userId]);
  function change(setter, value) {
    version.current += 1;
    setter(value); setQuote(null); setError(''); setConsent(false);
  }
  let safeUrl = '';
  try {
    const parsed = new URL(imageUrl.trim());
    if (imageUrl.trim().length <= 2048 && parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash && parsed.hostname.includes('.') && !parsed.hostname.endsWith('.local') && !/^[\d.]+$/.test(parsed.hostname) && !parsed.hostname.startsWith('[')) safeUrl = parsed.toString();
  } catch { /* keep quote disabled for invalid URLs */ }
  const seconds = /^\d+$/.test(duration) ? Number(duration) : NaN;
  const validParameters = Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 600 && FREEBEAT_VIDEO_RESOLUTIONS.includes(resolution) && FREEBEAT_VIDEO_ASPECT_RATIOS.includes(aspectRatio);
  const quoteBlockers = [];
  if (loading) quoteBlockers.push('Menunggu pemeriksaan sesi Freebeat selesai.');
  else if (!connected) quoteBlockers.push('Sesi Freebeat belum tersedia. Hubungkan akun melalui halaman utama Freebeat MCP, lalu buka kembali halaman ini.');
  if (busy) quoteBlockers.push('Tunggu pemeriksaan MCP yang sedang berjalan selesai.');
  if (!imageUrl.trim()) quoteBlockers.push('Unggah foto melalui langkah 1 untuk mendapatkan URL Freebeat, atau isi URL HTTPS gambar yang sudah tersedia.');
  else if (!safeUrl) quoteBlockers.push('Perbaiki URL gambar: gunakan HTTPS dengan domain publik, maksimal 2048 karakter, tanpa username/password atau fragment (#).');
  if (!prompt.trim()) quoteBlockers.push('Isi prompt pemeriksaan LTX.');
  if (!validParameters) quoteBlockers.push('Isi durasi bulat 1–600 detik, resolusi dan rasio setelah meninjau help live. Batas form bukan bukti dukungan model.');
  if (!consent) quoteBlockers.push('Setelah URL, prompt, durasi, resolusi dan rasio selesai diisi, centang izin pengiriman untuk quote saja.');
  async function inspect(action) {
    if (!connected || loading || busy || lock.current) return;
    const isQuote = action === 'video-model-quote';
    if (isQuote && quoteBlockers.length) return;
    const stamp = version.current;
    lock.current = true; setBusy(true); setError('');
    if (isQuote) setQuote(null); else setHelp(null);
    try {
      const payload = isQuote ? {
        ...CANDIDATE, duration: seconds, resolution, aspect_ratio: aspectRatio, input_mode: 'keyframe',
        images: [safeUrl], prompt: prompt.trim(),
      } : { model_id: CANDIDATE.model_id };
      // These existing admin-only endpoints call get_model_help/quote_generation
      // only. Photo hosting above is a separate consented action; no video is generated.
      const result = await request(action, 'POST', payload);
      if (stamp !== version.current) return;
      if (isQuote) setQuote(result); else setHelp(result);
    } catch (err) {
      if (stamp === version.current) setError(err.message || 'Pemeriksaan LTX melalui MCP gagal.');
    } finally { lock.current = false; setBusy(false); }
  }
  return <section className="freebeat-result" aria-label="Pemeriksaan LTX 2.3">
    <h3>LTX 2.3 · ID 97 · uji video admin</h3>
    <p>Kandidat dari pengguna: model ltx-2.3, modelId 97. Identitas web bukan bukti dukungan MCP atau render berhasil. Halaman ini menguji satu gambar (image/keyframe), bukan text/transition/reference. Periksa informasi model live dahulu. Durasi, resolusi dan rasio sengaja kosong; tidak memakai preset Hailuo.</p>
    <p>Halaman ini tidak menambahkan ID ke katalog. Persiapan generasi memerlukan konfirmasi help live model 97 tersedia dan quote numerik; tidak mengaktifkan model konsumen.</p>
    <FreebeatHailuoImageUpload modelLabel="LTX" modelId={97} connected={connected} imageAccess={imageAccess} loading={loading} disabled={requestBusy || generationBusy} request={request} storage={storage} userId={userId} onBusyChange={setUploadBusy} onImageUrl={(url) => change(setImageUrl, url)} />
    <h4>2. URL hasil → periksa quote video LTX</h4>
    <label className="freebeat-field">URL HTTPS gambar untuk quote LTX
      <input type="url" aria-label="URL gambar LTX" value={imageUrl} maxLength={2048} placeholder="https://domain-publik.example/foto.jpg" aria-invalid={Boolean(imageUrl.trim() && !safeUrl)} aria-describedby="freebeat-ltx-quote-help" disabled={loading || busy || !connected} onChange={(e) => change(setImageUrl, e.target.value)} />
    </label>
    <label className="freebeat-field">Prompt pemeriksaan LTX
      <textarea aria-label="Prompt LTX" value={prompt} maxLength={1000} disabled={loading || busy || !connected} onChange={(e) => change(setPrompt, e.target.value)} />
    </label>
    <label className="freebeat-field">Durasi LTX (detik)
      <input type="number" aria-label="Durasi LTX" value={duration} min="1" max="600" step="1" disabled={loading || busy || !connected} onChange={(e) => change(setDuration, e.target.value)} />
    </label>
    <label className="freebeat-field">Resolusi parameter LTX
      <select aria-label="Resolusi LTX" value={resolution} disabled={loading || busy || !connected} onChange={(e) => change(setResolution, e.target.value)}>
        <option value="">Pilih setelah meninjau help live</option>{FREEBEAT_VIDEO_RESOLUTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    <label className="freebeat-field">Rasio parameter LTX
      <select aria-label="Rasio LTX" value={aspectRatio} disabled={loading || busy || !connected} onChange={(e) => change(setAspectRatio, e.target.value)}>
        <option value="">Pilih setelah meninjau help live</option>{FREEBEAT_VIDEO_ASPECT_RATIOS.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </label>
    <p>Pilihan form mengikuti batas kontrak MCP lokal, bukan daftar kemampuan LTX yang telah diverifikasi. Gunakan help live di bawah; daftar opsi kosong berarti belum dirinci, bukan semua opsi didukung. Generasi LTX diblokir kecuali help live merinci image, durasi atau rentangnya, resolusi dan rasio yang dipilih. Jika settings pada quote berbeda, sesuaikan kolom lalu periksa quote lagi sebelum persetujuan generasi.</p>
    <p>Quote mengirim prompt dan URL gambar ke Freebeat, tetapi tidak membuat video. Gunakan gambar yang boleh dibagikan. Biaya quote bukan tagihan final; opsi dapat disesuaikan oleh informasi model live (lihat settings/adjusted pada hasil).</p>
    <p className="freebeat-note">Isi URL gambar dan prompt, pilih durasi/resolusi/rasio, lalu centang izin di bawah sebagai langkah terakhir. Mengubah URL, prompt, durasi, resolusi atau rasio akan menghapus izin sebelumnya; centang kembali setelah perubahan selesai.</p>
    <label className="freebeat-confirm"><input type="checkbox" aria-label="Setujui pemeriksaan quote LTX" checked={consent} aria-describedby="freebeat-ltx-quote-help" disabled={loading || busy || !connected || !safeUrl || !prompt.trim() || !validParameters} onChange={(e) => setConsent(e.target.checked)} /> Saya mengizinkan prompt dan URL gambar ini dikirim untuk pemeriksaan quote saja.</label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={loading || !connected || busy} onClick={() => inspect('video-model-help')}>Periksa informasi LTX #97</button>
      <button type="button" className="is-secondary" disabled={quoteBlockers.length > 0} aria-describedby="freebeat-ltx-quote-help" onClick={() => inspect('video-model-quote')}>Periksa quote LTX #97</button>
    </div>
    <div id="freebeat-ltx-quote-help" className="freebeat-prepare-help" aria-live="polite">
      {quoteBlockers.length ? <><strong>Quote belum bisa diperiksa:</strong><ul>{quoteBlockers.map((reason) => <li key={reason}>{reason}</li>)}</ul></> : <span>Siap memeriksa quote LTX. Klik Periksa quote LTX #97; tidak ada video yang dibuat.</span>}
    </div>
    {(requestBusy || uploadBusy) && <p role="status">Memeriksa MCP tanpa membuat video…</p>}
    {error && <p role="alert">{error}</p>}
    {help && <FreebeatCopyResult title="Informasi LTX MCP yang disaring" value={help} />}
    {quote && <FreebeatCopyResult title="Quote LTX MCP yang disaring" value={quote} />}
    <FreebeatSingleImageVideoGeneration modelId={97} modelLabel="LTX" duration={seconds} resolution={resolution} prepareAction="ltx-prepare" connected={connected} imageAccess={imageAccess} loading={loading} disabled={requestBusy || uploadBusy} request={request} userId={userId} imageUrl={safeUrl} prompt={prompt} aspectRatio={aspectRatio} quote={quote} onBusyChange={setGenerationBusy} />
  </section>;
}
