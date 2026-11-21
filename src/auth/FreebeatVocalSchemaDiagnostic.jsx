import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

const TRACKED_TOOLS = ['generate_singing_video', 'generate_lip_sync_video', 'upload_video'];

export function FreebeatVocalSchemaDiagnostic({ connected, loading, request }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [schemas, setSchemas] = useState(null);
  const [detailConsent, setDetailConsent] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!connected) {
      requestVersion.current += 1;
      setBusy(false);
      setSchemas(null);
      setError('');
      setDetailConsent(false);
    }
    return () => { requestVersion.current += 1; };
  }, [connected]);

  async function inspectSchemas(acknowledge) {
    if (loading || !connected || busy) return;
    if (acknowledge && !detailConsent) return;
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setSchemas(null);
    try {
      const data = await request('vocal-video-schemas', 'POST', acknowledge ? { acknowledge: true } : {});
      if (version !== requestVersion.current) return;
      setSchemas({
        mode: data.mode || (acknowledge ? 'detailed' : 'safe'),
        tools: data.tools || {},
        available_tools: Array.isArray(data.available_tools) ? data.available_tools : [],
        missing_tools: Array.isArray(data.missing_tools) ? data.missing_tools : [],
        truncated: data.truncated === true,
      });
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memeriksa skema Singing & Lip-Sync Video.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  const foundTracked = schemas
    ? TRACKED_TOOLS.filter((name) => Boolean(schemas.tools?.[name]))
    : [];
  const missingTracked = schemas
    ? TRACKED_TOOLS.filter((name) => !schemas.tools?.[name])
    : [];

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">SINGING &amp; LIP-SYNC · KHUSUS ADMIN · BACA SAJA</span>
      <h2>Inspeksi skema Singing &amp; Lip-Sync Video</h2>
      <p>
        Langkah 1 sebelum integrasi penuh di admin dan <code>/generate</code>: tarik <code>inputSchema</code> resmi
        dari <code>https://freebeat.ai/api/mcp</code> untuk <code>generate_singing_video</code>,{' '}
        <code>generate_lip_sync_video</code>, dan tool pendukungnya (<code>upload_video</code>,{' '}
        <code>upload_audio</code>, <code>upload_image</code>, <code>quote_generation</code>,{' '}
        <code>get_task_status</code>, <code>get_task_result</code>, <code>get_video_session</code>,{' '}
        <code>send_video_agent_message</code>). Pemeriksaan ini hanya memanggil <code>tools/list</code> dan tidak memakai kredit.
      </p>

      <div className="freebeat-actions">
        <button type="button" disabled={loading || !connected || busy} onClick={() => inspectSchemas(false)}>
          {busy ? 'Memeriksa…' : 'Periksa skema Singing & Lip-Sync'}
        </button>
        <button
          type="button"
          className="is-secondary"
          disabled={loading || !connected || busy || !detailConsent}
          onClick={() => inspectSchemas(true)}
        >
          Tampilkan skema lengkap (privat)
        </button>
      </div>

      <label className="freebeat-confirm">
        <input
          type="checkbox"
          checked={detailConsent}
          disabled={loading || !connected || busy}
          onChange={(event) => setDetailConsent(event.target.checked)}
        />
        {' '}Saya memahami mode skema lengkap menampilkan deskripsi, nilai bawaan, batas angka, dan seluruh daftar enum dari penyedia (disamarkan sebisanya) serta tidak boleh dibagikan publik bila memuat teks sensitif.
      </label>

      {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}

      {schemas && (
        <>
          <div className="freebeat-status" role="status">
            Mode: <strong>{schemas.mode === 'detailed' ? 'Lengkap (privat)' : 'Struktur aman'}</strong> ·{' '}
            Ditemukan: <strong>{foundTracked.length ? foundTracked.join(', ') : 'belum ada'}</strong>
            {missingTracked.length > 0 && ` · Tidak ditemukan di tools/list: ${missingTracked.join(', ')}`}
            {schemas.available_tools.length > 0 && ` · Total tool MCP terbaca: ${schemas.available_tools.length}`}
          </div>
          <FreebeatCopyResult
            title="Struktur tool Singing & Lip-Sync Video"
            value={schemas}
            description={
              schemas.mode === 'detailed'
                ? 'Menampilkan parameter, tipe, batas, nilai bawaan, daftar enum, serta deskripsi yang disamarkan. Gunakan tombol Salin lalu tempelkan hasilnya untuk melanjutkan implementasi.'
                : `Hanya struktur parameter dan nilai enumerasi aman; deskripsi dan nilai bawaan disembunyikan.${schemas.truncated ? ' Daftar dibatasi hingga lima halaman; sebagian tool mungkin tidak ditampilkan.' : ''}`
            }
          />
        </>
      )}
    </section>
  );
}
