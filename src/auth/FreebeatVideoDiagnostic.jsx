import { useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

export function FreebeatVideoDiagnostic({ connected, loading, request }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(null);
  const [quote, setQuote] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [imageUrl, setImageUrl] = useState('');

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
    <p>Untuk memeriksa quote, masukkan prompt dan satu URL HTTPS gambar yang dapat diakses Freebeat. Menekan tombol quote mengirim prompt dan URL tersebut ke Freebeat; jangan gunakan gambar pribadi atau URL bertanda tangan yang tidak ingin Anda bagikan. BLEA tidak mengunggah gambar di sini.</p>
    <p>Quote memakai mode gambar dan opsi default Freebeat, tanpa durasi atau resolusi yang dipilih. Angka quote bukan biaya akhir dan tidak menjamin generasi berhasil. Tidak ada generasi atau pengeluaran kredit pada pemeriksaan ini.</p>
    <label className="freebeat-field">Prompt video<input type="text" value={prompt} maxLength={2000} disabled={busy} onChange={(event) => { setPrompt(event.target.value); setQuote(null); }} /></label>
    <label className="freebeat-field">URL HTTPS gambar<input type="url" value={imageUrl} maxLength={2048} disabled={busy} autoComplete="off" onChange={(event) => { setImageUrl(event.target.value); setQuote(null); }} /></label>
    <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || busy || !prompt.trim() || !imageUrl.trim()} onClick={() => inspect('video-quote')}>Periksa quote Wan 3.0</button></div>
    {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
    {quote !== null && <FreebeatCopyResult title="Quote video yang disaring" value={{ model_id: 182, generation_type: 'image', quote }} description="Hasil ini tidak memuat prompt atau URL gambar. Quote bukan biaya akhir maupun persetujuan generasi." />}
  </div>;
}
