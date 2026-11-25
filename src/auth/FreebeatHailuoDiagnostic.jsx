import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

// Observed in a user-provided Freebeat WEB request, not verified MCP metadata.
// Never use this preset to authorize a paid call or populate consumer models.
const CANDIDATE = Object.freeze({ model_id: 106, duration: 10, resolution: '768p', aspect_ratio: '16:9' });

export function FreebeatHailuoDiagnostic({ connected, loading, request, videoModels }) {
  const [imageUrl, setImageUrl] = useState('');
  const [prompt, setPrompt] = useState('Gerakan kamera perlahan, subjek dan penampilan tetap konsisten dengan gambar referensi.');
  const [aspectRatio, setAspectRatio] = useState(CANDIDATE.aspect_ratio);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(null);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => {
    version.current += 1;
    setHelp(null); setQuote(null); setError(''); setConsent(false);
    return () => { version.current += 1; };
  }, [connected]);
  function change(setter, value) {
    version.current += 1;
    setter(value); setHelp(null); setQuote(null); setError(''); setConsent(false);
  }
  let safeUrl = '';
  try {
    const parsed = new URL(imageUrl.trim());
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash) safeUrl = parsed.toString();
  } catch { /* keep quote disabled for invalid URLs */ }
  const listed = videoModels?.models?.some((item) => Number(item.model_id) === CANDIDATE.model_id);
  async function inspect(action) {
    if (!connected || loading || busy) return;
    const isQuote = action === 'video-model-quote';
    if (isQuote && (!safeUrl || !prompt.trim() || !consent)) return;
    const stamp = version.current;
    setBusy(true); setError('');
    if (isQuote) setQuote(null); else setHelp(null);
    try {
      const payload = isQuote ? {
        ...CANDIDATE, aspect_ratio: aspectRatio, input_mode: 'keyframe',
        images: [safeUrl], prompt: prompt.trim(),
      } : { model_id: CANDIDATE.model_id };
      // These existing admin-only endpoints call get_model_help/quote_generation
      // only. There is intentionally no upload, prepare, submit or generate here.
      const result = await request(action, 'POST', payload);
      if (stamp !== version.current) return;
      if (isQuote) setQuote(result); else setHelp(result);
    } catch (err) {
      if (stamp === version.current) setError(err.message || 'Pemeriksaan Hailuo melalui MCP gagal.');
    } finally { setBusy(false); }
  }
  return <section className="freebeat-result" aria-label="Pemeriksaan Hailuo 2.3 Pro">
    <h3>Hailuo 2.3 Pro · ID 106 · pemeriksaan MCP tanpa generate</h3>
    <p>Preset berasal dari request web: hailuo-2.3-pro, 10 detik, 768p, rasio 16:9. Ini bukan MiniMax 3.0 dan belum membuktikan dukungan MCP. Angka generationType web tidak dikirim; satu gambar dipetakan ke mode image oleh Worker.</p>
    <p>{listed ? 'ID 106 terlihat pada katalog MCP yang dimuat; akses dan opsi tetap perlu diperiksa.' : 'ID 106 belum terlihat pada katalog yang dimuat (daftar dapat tidak lengkap). Pemeriksaan baca-saja tetap tersedia; model tidak otomatis diaktifkan di Generate.'}</p>
    <label className="freebeat-field">URL HTTPS gambar untuk quote Hailuo
      <input type="url" aria-label="URL gambar Hailuo" value={imageUrl} maxLength={2048} disabled={busy || !connected} onChange={(e) => change(setImageUrl, e.target.value)} />
    </label>
    <label className="freebeat-field">Prompt pemeriksaan Hailuo
      <textarea aria-label="Prompt Hailuo" value={prompt} maxLength={1000} disabled={busy || !connected} onChange={(e) => change(setPrompt, e.target.value)} />
    </label>
    <label className="freebeat-field">Rasio parameter Hailuo
      <select aria-label="Rasio Hailuo" value={aspectRatio} disabled={busy || !connected} onChange={(e) => change(setAspectRatio, e.target.value)}>
        <option value="16:9">16:9 (request web)</option><option value="9:16">9:16</option><option value="1:1">1:1</option>
      </select>
    </label>
    <p>Quote mengirim prompt dan URL gambar ke Freebeat, tetapi tidak membuat video. Gunakan gambar yang boleh dibagikan. Biaya quote bukan tagihan final; opsi dapat disesuaikan oleh informasi model live (lihat settings/adjusted pada hasil).</p>
    <label className="freebeat-confirm"><input type="checkbox" aria-label="Setujui pemeriksaan quote Hailuo" checked={consent} disabled={busy || !connected} onChange={(e) => setConsent(e.target.checked)} /> Saya mengizinkan prompt dan URL gambar ini dikirim untuk pemeriksaan quote saja.</label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={loading || !connected || busy} onClick={() => inspect('video-model-help')}>Periksa informasi Hailuo #106</button>
      <button type="button" className="is-secondary" disabled={loading || !connected || busy || !safeUrl || !prompt.trim() || !consent} onClick={() => inspect('video-model-quote')}>Periksa quote Hailuo #106</button>
    </div>
    {busy && <p role="status">Memeriksa MCP tanpa membuat video…</p>}
    {error && <p role="alert">{error}</p>}
    {help && <FreebeatCopyResult title="Informasi Hailuo MCP yang disaring" value={help} />}
    {quote && <FreebeatCopyResult title="Quote Hailuo MCP yang disaring" value={quote} />}
  </section>;
}
