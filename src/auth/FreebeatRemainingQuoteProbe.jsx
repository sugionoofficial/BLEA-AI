import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

const PROBE_GROUPS = [
  { value: 'all', label: 'Semua 5 tool (ringkas, 10 kombinasi)' },
  { value: 'music', label: 'generate_music (uji lyrics vs instrumental)' },
  { value: 'music_video', label: 'generate_music_video (uji 720p/1080p, 15s/30s, agent)' },
  { value: 'lyric_video', label: 'generate_lyric_video (uji 768P/2K, 15s/30s, agent)' },
  { value: 'effect', label: 'generate_effect (uji watermark false vs true)' },
  { value: 'text', label: 'generate_text (uji model & max_tokens)' },
];

export function FreebeatRemainingQuoteProbe({ connected, loading, request }) {
  const [group, setGroup] = useState('all');
  const [musicModelId, setMusicModelId] = useState('129');
  const [musicId, setMusicId] = useState('1076592');
  const [effectId, setEffectId] = useState('459');
  const [effectImageUrl, setEffectImageUrl] = useState('https://static.freebeatfit.com/effects_display/baby_arrived/1/459.png');
  const [textModel, setTextModel] = useState('gemini-3.5-flash');
  const [prompt, setPrompt] = useState('Upbeat synthwave sunset anthem with clean beat');
  const [privateDiagnostics, setPrivateDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [probeResult, setProbeResult] = useState(null);
  const [privateDetails, setPrivateDetails] = useState(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!connected) {
      requestVersion.current += 1;
      setBusy(false);
      setError('');
      setProbeResult(null);
      setPrivateDetails(null);
    }
    return () => { requestVersion.current += 1; };
  }, [connected]);

  async function runProbe(event) {
    event.preventDefault();
    if (loading || !connected || busy) return;

    const payload = { group };
    if (musicModelId.trim()) {
      const n = Number(musicModelId.trim());
      if (!Number.isSafeInteger(n) || n < 1 || n > 999999999) {
        setError('music_model_id harus bilangan bulat positif.');
        return;
      }
      payload.music_model_id = n;
    }
    if (musicId.trim()) {
      const n = Number(musicId.trim());
      if (!Number.isSafeInteger(n) || n < 1 || n > 9999999999) {
        setError('music_id harus bilangan bulat positif.');
        return;
      }
      payload.music_id = n;
    }
    if (effectId.trim()) {
      const n = Number(effectId.trim());
      if (!Number.isSafeInteger(n) || n < 1 || n > 9999999999) {
        setError('effect_id harus bilangan bulat positif.');
        return;
      }
      payload.effect_id = n;
    }
    if (effectImageUrl.trim()) {
      if (!/^https:\/\//i.test(effectImageUrl.trim())) {
        setError('effect_image_url harus berupa URL HTTPS yang valid.');
        return;
      }
      payload.effect_image_url = effectImageUrl.trim();
    }
    if (textModel.trim()) {
      payload.text_model = textModel.trim();
    }
    if (prompt.trim()) {
      if (prompt.trim().length > 500) {
        setError('Prompt uji maksimal 500 karakter.');
        return;
      }
      payload.prompt = prompt.trim();
    }
    if (privateDiagnostics) {
      payload.private_diagnostics = true;
    }

    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setProbeResult(null);
    setPrivateDetails(null);
    try {
      const data = await request('remaining-quote-probe', 'POST', payload);
      if (version !== requestVersion.current) return;
      setProbeResult(data);
      if (privateDiagnostics && Array.isArray(data?.private_diagnostics)) {
        setPrivateDetails(data.private_diagnostics);
      }
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal menjalankan probe quote 5 tool baru.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">PROBE QUOTE 5 TOOL BARU · KHUSUS ADMIN · 0 KREDIT</span>
      <h2>Uji quote_generation untuk 5 tool baru (gratis)</h2>
      <p>
        Hanya memanggil <code>quote_generation</code> (<strong>0 kredit, tidak mengirim generasi</strong>)
        untuk memetakan tarif kredit Freebeat serta kontrak parameter bagi{' '}
        <code>generate_music</code>, <code>generate_music_video</code>,{' '}
        <code>generate_lyric_video</code>, <code>generate_effect</code>, dan{' '}
        <code>generate_text</code> sebelum alur kirim berbayar dibangun.
      </p>

      <form onSubmit={runProbe} className="freebeat-form">
        <label className="freebeat-field">
          Cakupan uji quote
          <select value={group} disabled={loading || !connected || busy} onChange={(event) => setGroup(event.target.value)}>
            {PROBE_GROUPS.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>

        <div className="freebeat-inline">
          <label className="freebeat-field">
            <code>music_model_id</code> (musik)
            <input type="number" min={1} max={999999999} step={1} value={musicModelId} disabled={loading || !connected || busy} onChange={(event) => setMusicModelId(event.target.value)} />
          </label>
          <label className="freebeat-field">
            <code>music_id</code> (MV/Lirik/Efek)
            <input type="number" min={1} max={9999999999} step={1} value={musicId} disabled={loading || !connected || busy} onChange={(event) => setMusicId(event.target.value)} />
          </label>
          <label className="freebeat-field">
            <code>effect_id</code> (Efek)
            <input type="number" min={1} max={9999999999} step={1} value={effectId} disabled={loading || !connected || busy} onChange={(event) => setEffectId(event.target.value)} />
          </label>
        </div>

        <div className="freebeat-inline">
          <label className="freebeat-field">
            <code>text_model</code> (Teks)
            <input type="text" maxLength={120} value={textModel} disabled={loading || !connected || busy} onChange={(event) => setTextModel(event.target.value)} />
          </label>
          <label className="freebeat-field">
            <code>effect_image_url</code> (HTTPS)
            <input type="url" maxLength={2048} value={effectImageUrl} disabled={loading || !connected || busy} onChange={(event) => setEffectImageUrl(event.target.value)} />
          </label>
        </div>

        <label className="freebeat-field">
          Prompt percobaan (0 kredit)
          <input type="text" maxLength={500} value={prompt} disabled={loading || !connected || busy} onChange={(event) => setPrompt(event.target.value)} />
        </label>

        <label className="freebeat-confirm">
          <input
            type="checkbox"
            checked={privateDiagnostics}
            disabled={loading || !connected || busy}
            onChange={(event) => setPrivateDiagnostics(event.target.checked)}
          />
          {' '}Opsional: tampilkan <code>source</code>, <code>message</code> &amp; detail quote secara privat (disamarkan; tidak disimpan dan tidak ikut blok salin). Jangan bagikan teks mentah bila masih ada data pribadi/URL.
        </label>

        <div className="freebeat-actions">
          <button type="submit" disabled={loading || !connected || busy}>
            {busy ? 'Memeriksa quote…' : 'Jalankan probe quote (0 kredit)'}
          </button>
        </div>
      </form>

      {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}

      {probeResult && (
        <FreebeatCopyResult
          title="Hasil quote_generation 5 tool baru"
          value={{
            group: probeResult.group,
            total_probed: probeResult.total_probed,
            usable: probeResult.usable || [],
            results: probeResult.results || [],
          }}
          description={`Berhasil memeriksa ${probeResult.total_probed || 0} variasi parameter (0 kredit terpakai); ${(probeResult.usable || []).length} variasi menghasilkan quote numerik.`}
        />
      )}

      {privateDetails && (
        <div className="freebeat-result" aria-label="Detail pesan quote privat">
          <h3>Detail pesan quote privat (hanya tampil sementara)</h3>
          <p>Hanya untuk Anda; tidak disimpan di database dan hilang saat halaman ditutup atau sesi diputus. Jangan bagikan teks mentah jika berisi rahasia; sampaikan intinya saja.</p>
          <div className="freebeat-actions">
            <button type="button" className="is-secondary" onClick={() => setPrivateDetails(null)}>
              Sembunyikan detail privat
            </button>
          </div>
          <pre>{JSON.stringify(privateDetails, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}
