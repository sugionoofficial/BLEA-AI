import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

const TRACKED_TOOLS = [
  'list_music_models',
  'generate_music',
  'generate_music_video',
  'generate_lyric_video',
  'list_effects',
  'generate_effect',
  'generate_text',
];

function hasIncompleteEnum(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  if (node.enum_incomplete === true) return true;
  if (Array.isArray(node)) return node.some((item) => hasIncompleteEnum(item, depth + 1));
  return Object.values(node).some((child) => hasIncompleteEnum(child, depth + 1));
}

export function FreebeatRemainingSchemaDiagnostic({ connected, loading, request }) {
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
      const data = await request('remaining-schemas', 'POST', acknowledge ? { acknowledge: true } : {});
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
      setError(err?.message || 'Gagal memeriksa skema 7 tool Freebeat lainnya.');
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
  const safeHasHiddenDetails = Boolean(schemas && schemas.mode !== 'detailed' && hasIncompleteEnum(schemas.tools));

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">TOOL MCP LAINNYA · KHUSUS ADMIN · BACA SAJA</span>
      <h2>Inspeksi skema 7 tool Freebeat lainnya</h2>
      <p>
        Langkah 1 sebelum implementasi fitur berikutnya: tarik <code>inputSchema</code> resmi dari{' '}
        <code>https://freebeat.ai/api/mcp</code> untuk 7 tool yang belum terintegrasi (
        <code>list_music_models</code>, <code>generate_music</code>, <code>generate_music_video</code>,{' '}
        <code>generate_lyric_video</code>, <code>list_effects</code>, <code>generate_effect</code>,{' '}
        <code>generate_text</code>) beserta <code>quote_generation</code>. Pemeriksaan ini hanya memanggil{' '}
        <code>tools/list</code>, aman dipakai dengan izin baca, dan tidak memotong kredit.
      </p>

      <div className="freebeat-actions">
        <button type="button" disabled={loading || !connected || busy} onClick={() => inspectSchemas(false)}>
          {busy ? 'Memeriksa…' : 'Periksa skema 7 tool baru'}
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
          {safeHasHiddenDetails && (
            <p className="freebeat-note">
              Sebagian enum atau batas angka disembunyikan pada mode struktur aman (<code>enum_incomplete: true</code>).
              Centang persetujuan di atas lalu pilih <strong>Tampilkan skema lengkap (privat)</strong> sebelum menyalin hasil jika dibutuhkan untuk pemetaan payload tahap berikutnya.
            </p>
          )}
          <FreebeatCopyResult
            title="Struktur 7 tool Freebeat lainnya"
            value={schemas}
            description={
              schemas.mode === 'detailed'
                ? 'Menampilkan parameter, tipe, batas angka, nilai bawaan, daftar enum lengkap, serta deskripsi yang disamarkan. Gunakan tombol Salin lalu tempelkan hasilnya untuk merancang Phase 2.'
                : `Hanya struktur parameter dan nilai enumerasi aman; deskripsi, batas angka, dan nilai bawaan disembunyikan.${schemas.truncated ? ' Daftar dibatasi hingga lima halaman; sebagian tool mungkin tidak ditampilkan.' : ''}`
            }
          />
        </>
      )}
    </section>
  );
}
