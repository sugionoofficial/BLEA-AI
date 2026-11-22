import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { FreebeatCopyResult } from './FreebeatCopyResult';

function normalizeMusicCatalogList(data) {
  const raw = Array.isArray(data?.data?.models)
    ? data.data.models
    : Array.isArray(data?.data)
      ? data.data
      : [];
  return raw
    .filter((item) => item && typeof item === 'object' && Number.isSafeInteger(item.model_id) && item.model_id > 0)
    .map((item) => ({
      model_id: item.model_id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Model #${item.model_id}`,
      available: item.available !== false,
      pricing_status: typeof item.pricing?.status === 'string' ? item.pricing.status : null,
      credits: typeof item.pricing?.credits === 'number' && Number.isFinite(item.pricing.credits)
        ? item.pricing.credits
        : (typeof item.credits === 'number' && Number.isFinite(item.credits) ? item.credits : null),
      supports_duration: item.supports_duration === true,
      supports_lyrics: typeof item.supports_lyrics === 'boolean' ? item.supports_lyrics : null,
      supports_instrumental: typeof item.supports_instrumental === 'boolean' ? item.supports_instrumental : null,
      requires_lyrics: item.requires_lyrics === true,
    }));
}

export function FreebeatMusicDiagnostic({ connected, imageAccess, loading, request }) {
  const [models, setModels] = useState([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [modelId, setModelId] = useState('129');
  const [prompt, setPrompt] = useState('Upbeat synthwave sunset anthem with warm analog synths and crisp drums');
  const [instrumental, setInstrumental] = useState(false);
  const [lyrics, setLyrics] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [quote, setQuote] = useState(null);
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [initialConsent, setInitialConsent] = useState(false);
  const [initialDiagnostics, setInitialDiagnostics] = useState(null);
  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const [privateResultConsent, setPrivateResultConsent] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    if (!connected) {
      requestVersion.current += 1;
      setModels([]);
      setModelsBusy(false);
      setBusy(false);
      setError('');
      setNotice('');
      setQuote(null);
      setApproval(null);
      setConfirmed(false);
      setInitialConsent(false);
      setInitialDiagnostics(null);
      setTests([]);
      setTaskResults({});
      setPrivateResultConsent(false);
    }
    return () => { requestVersion.current += 1; };
  }, [connected]);

  const parsedModelId = Number(String(modelId).trim());
  const activeModel = models.find((m) => m.model_id === parsedModelId) || null;
  const allBusy = busy || modelsBusy;

  function clearQuoteAndApproval() {
    setQuote(null);
    setApproval(null);
    setConfirmed(false);
    setInitialDiagnostics(null);
  }

  async function loadMusicModels() {
    if (loading || !connected || allBusy) return;
    const version = requestVersion.current;
    setModelsBusy(true);
    setError('');
    try {
      const data = await request('music-models', 'POST', {});
      if (version !== requestVersion.current) return;
      const list = normalizeMusicCatalogList(data);
      setModels(list);
      const usable = list.filter((m) => m.available && m.pricing_status !== 'unavailable');
      if (usable.length > 0 && !usable.some((m) => m.model_id === parsedModelId)) {
        setModelId(String(usable[0].model_id));
      }
      clearQuoteAndApproval();
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memuat katalog model musik.');
    } finally {
      if (version === requestVersion.current) setModelsBusy(false);
    }
  }

  function buildPayload() {
    const cleanId = Number(String(modelId).trim());
    if (!Number.isSafeInteger(cleanId) || cleanId < 1 || cleanId > 999999999) {
      return { error: 'Masukkan model_id musik bilangan bulat positif.' };
    }
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || cleanPrompt.length > 2000) {
      return { error: 'Prompt musik wajib diisi (1–2000 karakter).' };
    }
    const cleanLyrics = lyrics.trim();
    if (cleanLyrics.length > 12000) {
      return { error: 'Lyrics maksimal 12000 karakter.' };
    }
    if (instrumental && cleanLyrics) {
      return { error: 'Tidak dapat mengaktifkan instrumental=true sekaligus mengisi lyrics.' };
    }
    if (activeModel?.requires_lyrics && !cleanLyrics) {
      return { error: `Model "${activeModel.name}" mewajibkan lyrics.` };
    }
    let cleanDuration;
    if (String(durationSeconds).trim() !== '') {
      const n = Number(String(durationSeconds).trim());
      if (!Number.isFinite(n) || n < 10 || n > 300) {
        return { error: 'duration_seconds harus antara 10 dan 300 detik.' };
      }
      if (activeModel && !activeModel.supports_duration) {
        return { error: `Model "${activeModel.name}" tidak mendukung pengaturan duration_seconds.` };
      }
      cleanDuration = n;
    }
    return {
      payload: {
        model_id: cleanId,
        prompt: cleanPrompt,
        ...(instrumental ? { instrumental: true } : {}),
        ...(cleanLyrics ? { lyrics: cleanLyrics } : {}),
        ...(cleanDuration !== undefined ? { duration_seconds: cleanDuration } : {}),
      },
    };
  }

  async function inspectMusicQuote() {
    if (loading || !connected || allBusy) return;
    const built = buildPayload();
    if (built.error) {
      setError(built.error);
      return;
    }
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setNotice('');
    setQuote(null);
    setApproval(null);
    setConfirmed(false);
    try {
      const data = await request('music-quote', 'POST', built.payload);
      if (version !== requestVersion.current) return;
      setQuote(data);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memeriksa quote musik.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function prepareMusic() {
    if (loading || !connected || !imageAccess || allBusy) return;
    const built = buildPayload();
    if (built.error) {
      setError(built.error);
      return;
    }
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    setNotice('');
    setApproval(null);
    setConfirmed(false);
    try {
      const data = await request('music-prepare', 'POST', built.payload);
      if (version !== requestVersion.current) return;
      setApproval(data);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal menyiapkan persetujuan uji musik.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function inspectTests() {
    if (loading || !connected || allBusy) return;
    const version = requestVersion.current;
    setBusy(true);
    setError('');
    try {
      const data = await request('music-tests', 'GET');
      if (version !== requestVersion.current) return;
      setTests(Array.isArray(data.tests) ? data.tests : []);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memeriksa catatan uji musik.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function submitMusic() {
    if (!approval || !confirmed || loading || !connected || !imageAccess || allBusy) return;
    const version = requestVersion.current;
    const receipt = approval.approval;
    const capture = initialConsent;
    setBusy(true);
    setError('');
    setNotice('');
    setApproval(null);
    setConfirmed(false);
    setInitialDiagnostics(null);
    try {
      const data = await request('music-submit', 'POST', {
        approval: receipt,
        confirm: true,
        ...(capture ? { private_diagnostics: true } : {}),
      });
      if (version !== requestVersion.current) return;
      if (capture) {
        setInitialDiagnostics(data.initial_diagnostics || { received: false, messages: [] });
      }
      if (data.status === 'submitted') {
        setNotice('Pengiriman generate_music tercatat sebagai submitted. Klik Periksa status di bawah untuk memantau tugas dan memeriksa struktur get_task_result.');
      } else {
        setNotice('Hasil pengiriman generate_music tidak pasti; pengiriman berikutnya dikunci. Jangan ulangi sebelum memeriksa riwayat Freebeat.');
      }
      const list = await request('music-tests', 'GET');
      if (version !== requestVersion.current) return;
      setTests(Array.isArray(list.tests) ? list.tests : []);
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Pengiriman uji musik gagal.');
      try {
        const list = await request('music-tests', 'GET');
        if (version === requestVersion.current) setTests(Array.isArray(list.tests) ? list.tests : []);
      } catch { /* keep main error */ }
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  async function pollMusicTask(id, acknowledge = false) {
    if (loading || !connected || allBusy) return;
    const version = requestVersion.current;
    const includePrivate = privateResultConsent;
    setBusy(true);
    setError('');
    try {
      const data = await request('music-task', 'POST', {
        id,
        ...(acknowledge ? { acknowledge: true } : {}),
        ...(includePrivate ? { private_result: true } : {}),
      });
      if (version !== requestVersion.current) return;
      setTaskResults((old) => ({ ...old, [id]: data.task }));
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err?.message || 'Gagal memeriksa status uji musik.');
    } finally {
      if (version === requestVersion.current) setBusy(false);
    }
  }

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">MUSIK · KHUSUS ADMIN · KREDIT FREEBEAT</span>
      <h2>Uji Musik (generate_music)</h2>
      <p>
        Menguji alur resmi musik Freebeat via MCP (<code>list_music_models</code> →{' '}
        <code>quote_generation</code> → <code>generate_music</code> dengan batas tepat{' '}
        <code>max_credits</code> → <code>get_task_status</code> → <code>get_task_result</code>).
        Kredit berasal dari akun Freebeat admin, bukan saldo BLEA.
      </p>

      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || allBusy} onClick={loadMusicModels}>
          {modelsBusy ? 'Memuat katalog…' : 'Muat katalog model musik (0 kredit)'}
        </button>
      </div>

      <div className="freebeat-form">
        {models.length > 0 ? (
          <label className="freebeat-field">
            Model musik (dari list_music_models live)
            <select
              value={String(modelId)}
              disabled={loading || !connected || allBusy}
              onChange={(event) => {
                setModelId(event.target.value);
                clearQuoteAndApproval();
                setError('');
              }}
            >
              {models.map((m) => {
                const unusable = !m.available || m.pricing_status === 'unavailable';
                const priceText = m.credits !== null ? `${m.credits} kredit` : (m.pricing_status || 'unavailable');
                return (
                  <option key={m.model_id} value={String(m.model_id)} disabled={unusable}>
                    #{m.model_id} {m.name} — {priceText}{unusable ? ' (unavailable)' : ''}
                  </option>
                );
              })}
            </select>
          </label>
        ) : (
          <label className="freebeat-field">
            ID Model Musik (bawaan #129 Lyria 3 Pro, atau muat katalog di atas)
            <input
              type="number"
              min={1}
              max={999999999}
              step={1}
              value={modelId}
              disabled={loading || !connected || allBusy}
              onChange={(event) => {
                setModelId(event.target.value);
                clearQuoteAndApproval();
                setError('');
              }}
            />
          </label>
        )}

        <label className="freebeat-field">
          Prompt musik (1–2000 karakter)
          <textarea
            rows={2}
            maxLength={2000}
            value={prompt}
            disabled={loading || !connected || allBusy}
            onChange={(event) => {
              setPrompt(event.target.value);
              clearQuoteAndApproval();
              setError('');
            }}
          />
        </label>

        <label className="freebeat-confirm">
          <input
            type="checkbox"
            checked={instrumental}
            disabled={loading || !connected || allBusy}
            onChange={(event) => {
              const checked = event.target.checked;
              setInstrumental(checked);
              if (checked) setLyrics('');
              clearQuoteAndApproval();
              setError('');
            }}
          />
          {' '}Instrumental tanpa vokal (<code>instrumental: true</code>)
        </label>

        <label className="freebeat-field">
          Lyrics opsional (1–12000 karakter; nonaktif saat instrumental)
          <textarea
            rows={3}
            maxLength={12000}
            value={lyrics}
            disabled={loading || !connected || allBusy || instrumental}
            placeholder="[Verse] ... [Chorus] ..."
            onChange={(event) => {
              setLyrics(event.target.value);
              clearQuoteAndApproval();
              setError('');
            }}
          />
        </label>

        <label className="freebeat-field">
          Durasi target opsional (10–300 dtk; hanya aktif jika <code>supports_duration: true</code>)
          <input
            type="number"
            min={10}
            max={300}
            step={1}
            value={durationSeconds}
            disabled={loading || !connected || allBusy || (activeModel ? !activeModel.supports_duration : false)}
            placeholder={activeModel && !activeModel.supports_duration ? 'Model ini tidak mendukung duration_seconds' : 'Kosongkan untuk bawaan'}
            onChange={(event) => {
              setDurationSeconds(event.target.value);
              clearQuoteAndApproval();
              setError('');
            }}
          />
        </label>

        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy} onClick={inspectMusicQuote}>
            Periksa quote musik (0 kredit)
          </button>
          <button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || allBusy} onClick={prepareMusic}>
            Siapkan persetujuan musik
          </button>
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy} onClick={inspectTests}>
            Periksa catatan uji musik
          </button>
        </div>
        {!imageAccess && <p>Hubungkan Freebeat dengan izin generasi (<code>freebeat:generate</code>) di atas sebelum menyiapkan persetujuan.</p>}
      </div>

      {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}

      {quote && (
        <FreebeatCopyResult
          title="Quote generate_music yang disaring"
          value={{
            model: quote.model || null,
            parameters: quote.parameters,
            credits: quote.credits,
            quote: quote.quote,
          }}
          description={quote.credits !== null
            ? `Quote: ${quote.credits} kredit Freebeat (batas dikirim tepat max_credits: ${quote.credits}).`
            : 'Freebeat tidak mengembalikan quote numerik.'}
        />
      )}

      {approval && (
        <div className="freebeat-result">
          <h3>Periksa dan setujui satu generate_music</h3>
          <p>
            Model: <strong>#{approval.parameters?.model_id}{approval.model?.name ? ` (${approval.model.name})` : ''}</strong> ·
            Quote Freebeat: <strong>{approval.credits} kredit</strong> ·
            Batas <code>max_credits</code>: <strong>{approval.max_credits} kredit</strong> ·
            Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}.
          </p>
          <label className="freebeat-confirm">
            <input type="checkbox" checked={confirmed} disabled={allBusy} onChange={(event) => setConfirmed(event.target.checked)} />
            {' '}Saya menyetujui satu kali pengiriman <code>generate_music</code> dengan batas maksimum {approval.max_credits} kredit Freebeat.
          </label>
          <label className="freebeat-confirm">
            <input type="checkbox" checked={initialConsent} disabled={allBusy} onChange={(event) => setInitialConsent(event.target.checked)} />
            {' '}Opsional: tampilkan pesan respons awal secara privat setelah pengiriman (disamarkan; tidak disimpan).
          </label>
          <div className="freebeat-actions">
            <button type="button" disabled={!confirmed || allBusy || !connected || !imageAccess} onClick={submitMusic}>
              Setujui dan kirim musik
            </button>
          </div>
        </div>
      )}

      {notice && <div className="freebeat-alert" role="status">{notice}</div>}

      {initialDiagnostics && (
        <div className="freebeat-result" aria-label="Diagnostik respons awal privat musik">
          <h3>Pesan respons awal privat</h3>
          <p>Hanya tampil sementara dan tidak disimpan.</p>
          <div className="freebeat-actions">
            <button type="button" className="is-secondary" onClick={() => setInitialDiagnostics(null)}>
              Sembunyikan respons awal
            </button>
          </div>
          {initialDiagnostics.messages?.length
            ? initialDiagnostics.messages.map((msg, idx) => <pre key={idx}>{msg}</pre>)
            : <p>Tidak ada pesan teks tambahan pada respons awal.</p>}
        </div>
      )}

      {tests.length > 0 && (
        <div className="freebeat-result">
          <h3>Catatan uji musik admin</h3>
          <label className="freebeat-confirm">
            <input
              type="checkbox"
              checked={privateResultConsent}
              disabled={allBusy}
              onChange={(event) => setPrivateResultConsent(event.target.checked)}
            />
            {' '}Opsional: sertakan struktur mentah <code>get_task_result</code> secara privat (disamarkan) saat memeriksa status.
          </label>
          {tests.map((test) => (
            <div key={test.id} className="freebeat-test-row">
              <p>
                Model <strong>#{test.model_id}{test.model_name ? ` ${test.model_name}` : ''}</strong> ·{' '}
                {test.instrumental ? 'Instrumental' : (test.has_lyrics ? 'Dengan lyrics' : 'Prompt')} ·{' '}
                Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · <strong>{test.status}</strong>
              </p>
              {(test.status === 'unknown' || test.status === 'dispatching') && (
                <p>Hasil tidak pasti; pengiriman musik baru dikunci. Jangan ulangi sebelum memeriksa riwayat Freebeat.</p>
              )}
              {test.canPoll && (
                <div className="freebeat-actions">
                  <button type="button" className="is-secondary" disabled={allBusy} onClick={() => pollMusicTask(test.id, false)}>
                    Periksa status
                  </button>
                </div>
              )}
              {test.status === 'submitted' && !test.canPoll && (
                <div className="freebeat-actions">
                  <button type="button" className="is-secondary" disabled={allBusy} onClick={() => pollMusicTask(test.id, true)}>
                    Periksa status dari sesi sebelumnya
                  </button>
                </div>
              )}
              {taskResults[test.id] && (
                <div className="freebeat-result">
                  <p>
                    Status: <strong>{taskResults[test.id].status}</strong>
                    {taskResults[test.id].music_id !== null && taskResults[test.id].music_id !== undefined
                      ? <> · <code>music_id</code>: <strong>{String(taskResults[test.id].music_id)}</strong></>
                      : null}
                    {taskResults[test.id].title ? <> · Judul: <strong>{taskResults[test.id].title}</strong></> : null}
                    {typeof taskResults[test.id].duration_ms === 'number' && taskResults[test.id].duration_ms > 0
                      ? <> · Durasi: <strong>{Math.round(taskResults[test.id].duration_ms / 1000)} dtk</strong></>
                      : null}
                  </p>
                  {taskResults[test.id].billing_message && (
                    <p>Catatan billing: <span>{taskResults[test.id].billing_message}</span></p>
                  )}
                  <FreebeatCopyResult
                    title="Ringkasan hasil generate_music"
                    value={{
                      status: taskResults[test.id].status,
                      music_id: taskResults[test.id].music_id ?? null,
                      title: taskResults[test.id].title ?? null,
                      duration_ms: taskResults[test.id].duration_ms ?? null,
                      billing: taskResults[test.id].billing || null,
                      billing_message: taskResults[test.id].billing_message ?? null,
                      failure: taskResults[test.id].failure || null,
                      audio_count: taskResults[test.id].audios?.length || 0,
                      has_cover: Boolean(taskResults[test.id].cover_url),
                    }}
                  />
                  {taskResults[test.id].audios?.length > 0 && (
                    <div className="freebeat-result-links">
                      {taskResults[test.id].audios.map((url, idx) => (
                        <a className="freebeat-result-link" key={url} href={url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink size={16} aria-hidden="true" /> Buka audio {idx + 1}
                        </a>
                      ))}
                    </div>
                  )}
                  {taskResults[test.id].cover_url && (
                    <div className="freebeat-result-links">
                      <a className="freebeat-result-link" href={taskResults[test.id].cover_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={16} aria-hidden="true" /> Buka cover
                      </a>
                    </div>
                  )}
                  {taskResults[test.id].private_structure && (
                    <div className="freebeat-result" aria-label="Struktur mentah get_task_result musik (privat)">
                      <h4>Struktur mentah get_task_result (privat, disamarkan)</h4>
                      <pre>{JSON.stringify(taskResults[test.id].private_structure, null, 2)}</pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
