import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

export function FreebeatCatalogInspector({ connected, loading, request }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [musicCatalog, setMusicCatalog] = useState(null);
  const [effectsCatalog, setEffectsCatalog] = useState(null);
  const [textCatalog, setTextCatalog] = useState(null);
  const [effectsPage, setEffectsPage] = useState('1');
  const [effectsPageSize, setEffectsPageSize] = useState('20');
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!connected) {
      requestVersion.current += 1;
      setBusy(false);
      setError('');
      setMusicCatalog(null);
      setEffectsCatalog(null);
      setTextCatalog(null);
    }
    return () => { requestVersion.current += 1; };
  }, [connected]);

  async function inspectMusic() {
    if (loading || !connected || busy) return;
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setMusicCatalog(null);
    try {
      const data = await request('music-models', 'POST', {});
      if (version !== requestVersion.current) return;
      setMusicCatalog(data);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memuat katalog model musik Freebeat.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function inspectEffects() {
    if (loading || !connected || busy) return;
    const page = Number(effectsPage);
    const page_size = Number(effectsPageSize);
    if (!Number.isSafeInteger(page) || page < 1 || page > 50) {
      setError('Halaman efek (page) harus bilangan bulat 1–50.');
      return;
    }
    if (!Number.isSafeInteger(page_size) || page_size < 1 || page_size > 100) {
      setError('Ukuran halaman efek (page_size) harus bilangan bulat 1–100.');
      return;
    }
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setEffectsCatalog(null);
    try {
      const data = await request('effects-list', 'POST', { page, page_size });
      if (version !== requestVersion.current) return;
      setEffectsCatalog(data);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memuat katalog efek Freebeat.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function inspectText() {
    if (loading || !connected || busy) return;
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setTextCatalog(null);
    try {
      const data = await request('text-models', 'POST', {});
      if (version !== requestVersion.current) return;
      setTextCatalog(data);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memuat katalog model teks Freebeat.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">KATALOG MUSIK, EFEK &amp; TEKS · KHUSUS ADMIN · BACA SAJA</span>
      <h2>Inspeksi katalog musik, efek &amp; teks</h2>
      <p>
        Memanggil tool baca-saja <code>list_music_models</code>, <code>list_effects</code>, dan{' '}
        <code>list_models(type=text)</code> dari Freebeat MCP tanpa menjalankan generasi dan tanpa
        memotong kredit. Hasil ini dipakai untuk memetakan <code>model_id</code>, flag{' '}
        <code>requires_lyrics</code>/<code>supports_duration</code>, <code>effect_id</code>,{' '}
        <code>default_music_id</code>, serta URL referensi efek sebelum integrasi berbayar dibuat.
      </p>

      <div className="freebeat-inline">
        <label className="freebeat-field">
          Halaman efek (<code>page</code>)
          <input
            type="number"
            min={1}
            max={50}
            step={1}
            value={effectsPage}
            disabled={loading || !connected || busy}
            onChange={(event) => setEffectsPage(event.target.value)}
          />
        </label>
        <label className="freebeat-field">
          Jumlah per halaman (<code>page_size</code>)
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={effectsPageSize}
            disabled={loading || !connected || busy}
            onChange={(event) => setEffectsPageSize(event.target.value)}
          />
        </label>
      </div>

      <div className="freebeat-actions">
        <button type="button" disabled={loading || !connected || busy} onClick={inspectMusic}>
          {busy ? 'Memeriksa…' : 'Periksa model musik'}
        </button>
        <button type="button" className="is-secondary" disabled={loading || !connected || busy} onClick={inspectEffects}>
          Periksa daftar efek
        </button>
        <button type="button" className="is-secondary" disabled={loading || !connected || busy} onClick={inspectText}>
          Periksa model teks
        </button>
      </div>

      {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}

      {musicCatalog && (
        <FreebeatCopyResult
          title="Katalog model musik (list_music_models)"
          value={{
            catalog: musicCatalog.catalog,
            count: musicCatalog.count ?? null,
            truncated: musicCatalog.truncated === true,
            data: musicCatalog.data ?? null,
          }}
          description={`Menampilkan daftar model musik yang disaring.${musicCatalog.truncated ? ' Daftar dipotong maksimal 100 item.' : ''}`}
        />
      )}

      {effectsCatalog && (
        <FreebeatCopyResult
          title="Katalog efek (list_effects)"
          value={{
            catalog: effectsCatalog.catalog,
            page: effectsCatalog.page,
            page_size: effectsCatalog.page_size,
            count: effectsCatalog.count ?? null,
            truncated: effectsCatalog.truncated === true,
            data: effectsCatalog.data ?? null,
          }}
          description={`Menampilkan efek halaman ${effectsCatalog.page} (ukuran ${effectsCatalog.page_size}) setelah penyamaran teks sensitif.`}
        />
      )}

      {textCatalog && (
        <FreebeatCopyResult
          title="Katalog model teks (list_models type=text)"
          value={{
            catalog: textCatalog.catalog,
            models: textCatalog.models || [],
            ...(textCatalog.data !== undefined ? { data: textCatalog.data } : {}),
            ...(textCatalog.schema !== undefined ? { list_models_schema: textCatalog.schema } : {}),
            truncated: textCatalog.truncated === true,
          }}
          description={`Menampilkan model teks dari list_models(type=text).${textCatalog.truncated ? ' Daftar dibatasi hingga 100 item.' : ''}`}
        />
      )}
    </section>
  );
}
