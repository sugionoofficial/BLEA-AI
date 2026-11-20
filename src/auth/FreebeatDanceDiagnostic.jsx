import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { deleteFreebeatImage, uploadFreebeatAudio, uploadFreebeatImage } from '../lib/freebeatVideoUpload';

const DANCE_RATIOS = [
  { value: '9:16', label: '9:16 (Vertikal · TikTok / Reels / Shorts)' },
  { value: '16:9', label: '16:9 (Lanskap)' },
  { value: '1:1', label: '1:1 (Persegi)' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
];

export function FreebeatDanceDiagnostic({ connected, imageAccess, loading, request, userId, storage }) {
  const [schemas, setSchemas] = useState(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [uploadedAudio, setUploadedAudio] = useState(null);
  const [audioUploadBusy, setAudioUploadBusy] = useState(false);
  const [musicId, setMusicId] = useState('');
  const [audioStatusNotice, setAudioStatusNotice] = useState('');

  const [dancerImages, setDancerImages] = useState([]);
  const [dancerUrlInput, setDancerUrlInput] = useState('');
  const [imageUploadBusy, setImageUploadBusy] = useState(false);

  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [autoMode, setAutoMode] = useState(true);
  const [prompt, setPrompt] = useState('');
  const [startMs, setStartMs] = useState('');
  const [endMs, setEndMs] = useState('');
  const [removeWatermark, setRemoveWatermark] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [quote, setQuote] = useState(null);
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [unknownCostConfirmed, setUnknownCostConfirmed] = useState(false);
  const [notice, setNotice] = useState('');

  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const [sessions, setSessions] = useState({});
  const [messageDrafts, setMessageDrafts] = useState({});
  const [messageAutoModes, setMessageAutoModes] = useState({});
  const [sessionNotices, setSessionNotices] = useState({});

  function clearApproval() {
    setApproval(null);
    setConfirmed(false);
    setUnknownCostConfirmed(false);
  }

  function clearQuoteAndApproval() {
    setQuote(null);
    clearApproval();
    setNotice('');
  }

  function dancePayload() {
    const payload = {
      music_id: musicId.trim(),
      auto_mode: autoMode,
      aspect_ratio: aspectRatio,
      remove_watermark: removeWatermark,
    };
    if (prompt.trim()) payload.prompt = prompt.trim();
    if (dancerImages.length) payload.image_urls = dancerImages.map((item) => item.url);
    if (startMs !== '' || endMs !== '') {
      const startNum = Number(startMs);
      const endNum = Number(endMs);
      if (!Number.isSafeInteger(startNum) || !Number.isSafeInteger(endNum)) {
        throw new Error('Isi start_ms dan end_ms dengan bilangan bulat milidetik.');
      }
      payload.start_ms = startNum;
      payload.end_ms = endNum;
    }
    return payload;
  }

  async function inspectSchemas() {
    setBusy(true); setError('');
    try {
      const data = await request('dance-schemas', 'POST', {});
      setSchemas(data);
    } catch (err) {
      setError(err.message || 'Gagal memeriksa skema tool dance.');
    } finally {
      setBusy(false);
    }
  }

  async function handleAudioFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setAudioUploadBusy(true); setError(''); setAudioStatusNotice('');
    try {
      const next = await uploadFreebeatAudio(storage, userId, file);
      if (!next.url) throw new Error('Audio tersimpan, tetapi URL publik HTTPS tidak tersedia.');
      setUploadedAudio(next);
      setAudioUrl(next.url);
      setAudioStatusNotice('Audio diunggah ke Supabase Storage. Klik "Daftarkan audio ke Freebeat" untuk mendapatkan music_id.');
    } catch (err) {
      setError(err.message || 'Gagal mengunggah file audio ke Supabase.');
    } finally {
      setAudioUploadBusy(false);
    }
  }

  async function removeUploadedAudio() {
    if (!uploadedAudio?.path) return;
    setAudioUploadBusy(true); setError('');
    try {
      await deleteFreebeatImage(storage, uploadedAudio.path);
      if (audioUrl === uploadedAudio.url) setAudioUrl('');
      setUploadedAudio(null);
      setAudioStatusNotice('File audio dihapus dari Supabase Storage.');
    } catch (err) {
      setError(err.message || 'Gagal menghapus file audio dari Supabase.');
    } finally {
      setAudioUploadBusy(false);
    }
  }

  async function registerAudioWithFreebeat() {
    if (!audioUrl.trim()) return;
    setBusy(true); setError(''); setAudioStatusNotice(''); clearQuoteAndApproval();
    try {
      const data = await request('dance-upload-audio', 'POST', { audio_url: audioUrl.trim() });
      setMusicId(data.music_id);
      setAudioStatusNotice(
        data.status === 'preparing'
          ? `Freebeat mengembalikan music_id ${data.music_id} (sedang disiapkan${data.retry_after_seconds ? `, perkiraan ${data.retry_after_seconds} dtk` : ''}).`
          : `Audio terdaftar di Freebeat dengan music_id: ${data.music_id}.`
      );
    } catch (err) {
      setError(err.message || 'Gagal mendaftarkan audio lewat upload_audio Freebeat.');
    } finally {
      setBusy(false);
    }
  }

  async function handleDancerImageUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (dancerImages.length >= 5) {
      setError('Maksimal 5 foto penari.');
      return;
    }
    setImageUploadBusy(true); setError(''); clearQuoteAndApproval();
    try {
      const next = await uploadFreebeatImage(storage, userId, file);
      if (!next.url) throw new Error('Gambar tersimpan, tetapi URL publik HTTPS tidak tersedia.');
      setDancerImages((old) => [...old, { url: next.url, path: next.path }]);
    } catch (err) {
      setError(err.message || 'Gagal mengunggah foto penari ke Supabase.');
    } finally {
      setImageUploadBusy(false);
    }
  }

  function addDancerUrl() {
    const clean = dancerUrlInput.trim();
    if (!clean) return;
    if (dancerImages.length >= 5) {
      setError('Maksimal 5 foto penari.');
      return;
    }
    try {
      if (new URL(clean).protocol !== 'https:') throw new Error('URL foto penari harus HTTPS.');
    } catch {
      setError('Masukkan URL HTTPS publik yang valid untuk foto penari.');
      return;
    }
    if (dancerImages.some((item) => item.url === clean)) {
      setDancerUrlInput('');
      return;
    }
    setError('');
    clearQuoteAndApproval();
    setDancerImages((old) => [...old, { url: clean, path: null }]);
    setDancerUrlInput('');
  }

  async function removeDancerImage(index) {
    const item = dancerImages[index];
    if (!item) return;
    setError(''); clearQuoteAndApproval();
    if (item.path) {
      setImageUploadBusy(true);
      try {
        await deleteFreebeatImage(storage, item.path);
      } catch (err) {
        setError(err.message || 'Gagal menghapus foto penari dari Supabase.');
        setImageUploadBusy(false);
        return;
      }
      setImageUploadBusy(false);
    }
    setDancerImages((old) => old.filter((_, i) => i !== index));
  }

  async function inspectDanceQuote() {
    setBusy(true); setError(''); setQuote(null); clearApproval();
    try {
      const body = dancePayload();
      const data = await request('dance-quote', 'POST', body);
      setQuote(data);
    } catch (err) {
      setError(err.message || 'Gagal memeriksa quote dance video.');
    } finally {
      setBusy(false);
    }
  }

  async function prepareDance() {
    setBusy(true); setError(''); setNotice(''); clearApproval();
    try {
      const body = dancePayload();
      const data = await request('dance-prepare', 'POST', body);
      setApproval(data);
      await refreshTests().catch(() => {});
    } catch (err) {
      setError(err.message || 'Gagal menyiapkan persetujuan dance video.');
    } finally {
      setBusy(false);
    }
  }

  async function refreshTests() {
    const data = await request('dance-tests');
    setTests(data.tests || []);
  }

  async function inspectTests() {
    setBusy(true); setError('');
    try {
      await refreshTests();
    } catch (err) {
      setError(err.message || 'Gagal memuat catatan uji dance video.');
    } finally {
      setBusy(false);
    }
  }

  async function submitDance() {
    if (!approval?.approval || !confirmed) return;
    if (approval.accept_unknown_cost && !unknownCostConfirmed) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await request('dance-submit', 'POST', {
        approval: approval.approval,
        confirm: true,
        ...(approval.accept_unknown_cost ? { confirm_unknown_cost: true } : {}),
      });
      clearApproval();
      if (data.status === 'preparing') {
        if (data.music_id) setMusicId(data.music_id);
        setNotice(`Lagu sedang disiapkan oleh Freebeat (status: preparing). Tunggu sekitar ${data.retry_after_seconds || 10} detik, lalu siapkan persetujuan dan kirim ulang dengan music_id ${data.music_id} tanpa mengunggah audio lagi.`);
      } else if (data.status === 'submitted') {
        setNotice(`Dance video dikirim (720p). Proses sutradara umumnya memerlukan 15–60 menit.${data.session_url ? ' Tautan sesi tersedia di catatan uji.' : ''}`);
      } else {
        setNotice('Hasil pengiriman tidak pasti; pengiriman dance video baru diblokir hingga catatan ditinjau.');
      }
      await refreshTests();
    } catch (err) {
      setError(err.message || 'Gagal mengirim uji dance video.');
    } finally {
      setBusy(false);
    }
  }

  async function pollDance(id, acknowledge = false) {
    setBusy(true); setError('');
    try {
      const data = await request('dance-task', 'POST', acknowledge ? { id, acknowledge: true } : { id });
      setTaskResults((old) => ({ ...old, [id]: data.task }));
    } catch (err) {
      setError(err.message || 'Gagal memeriksa status dance video.');
    } finally {
      setBusy(false);
    }
  }

  async function inspectSession(id, acknowledge = false) {
    setBusy(true); setError('');
    try {
      const data = await request('dance-session', 'POST', acknowledge ? { id, acknowledge: true } : { id });
      setSessions((old) => ({ ...old, [id]: data.session }));
    } catch (err) {
      setError(err.message || 'Gagal memuat sesi sutradara dance.');
    } finally {
      setBusy(false);
    }
  }

  async function sendAgentMessage(id) {
    const msg = (messageDrafts[id] || '').trim();
    if (!msg) return;
    setBusy(true); setError('');
    try {
      const nextAuto = messageAutoModes[id];
      const payload = { id, message: msg };
      if (nextAuto === 'true') payload.auto_mode = true;
      if (nextAuto === 'false') payload.auto_mode = false;
      const data = await request('dance-message', 'POST', payload);
      setMessageDrafts((old) => ({ ...old, [id]: '' }));
      setSessionNotices((old) => ({ ...old, [id]: data.reply || 'Pesan diterima oleh sutradara dance.' }));
      if (data.session) setSessions((old) => ({ ...old, [id]: data.session }));
    } catch (err) {
      setError(err.message || 'Gagal mengirim pesan ke sutradara dance.');
    } finally {
      setBusy(false);
    }
  }

  const allBusy = busy || audioUploadBusy || imageUploadBusy;

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">DANCE VIDEO · KHUSUS ADMIN · MCP RESMI</span>
      <h2>Uji Dance Video (generate_dance_video)</h2>
      <p>Menjalankan sutradara dance resmi Freebeat via MCP (<code>upload_audio</code> + <code>generate_dance_video</code> + <code>get_video_session</code> + <code>send_video_agent_message</code> + <code>get_task_result</code>). Resolusi keluaran ditetapkan Freebeat pada <code>720p</code> dan umumnya memerlukan 15–60 menit.</p>

      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || allBusy} onClick={inspectSchemas}>Periksa skema tool dance</button>
      </div>
      {schemas && <FreebeatCopyResult title="Struktur tool dance video" value={{ tools: schemas.tools, truncated: schemas.truncated === true }} description="Mencakup upload_audio, upload_image, quote_generation, generate_dance_video, get_task_status, get_task_result, get_video_session, dan send_video_agent_message." />}

      <div className="freebeat-result">
        <h3>1. Lagu / Audio (wajib)</h3>
        <p>Unggah file audio (MP3/WAV/M4A/AAC/OGG/FLAC/WebM maks 25 MB) ke Supabase Storage atau tempel URL HTTPS audio / tautan platform musik publik (misal Suno, Udio, YouTube, SoundCloud, TikTok), lalu daftarkan ke Freebeat untuk memperoleh <code>music_id</code>.</p>
        <div className="freebeat-upload">
          <label className="freebeat-field">Unggah file audio ke Supabase Storage<input type="file" accept="audio/*" disabled={loading || !userId || allBusy} onChange={handleAudioFileUpload} /></label>
          {uploadedAudio && <button type="button" className="is-secondary" disabled={allBusy} onClick={removeUploadedAudio}>Hapus audio dari Supabase</button>}
        </div>
        <label className="freebeat-field">URL HTTPS audio atau tautan lagu<input type="url" value={audioUrl} maxLength={2048} disabled={allBusy} placeholder="https://..." autoComplete="off" onChange={(event) => { setAudioUrl(event.target.value); setAudioStatusNotice(''); }} /></label>
        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy || !audioUrl.trim()} onClick={registerAudioWithFreebeat}>Daftarkan audio ke Freebeat (upload_audio)</button>
        </div>
        {audioStatusNotice && <p className="freebeat-alert" role="status">{audioStatusNotice}</p>}
        <label className="freebeat-field">music_id Freebeat<input type="text" value={musicId} maxLength={256} disabled={allBusy} placeholder="Diisi otomatis dari upload_audio atau masukkan music_id / music:..." autoComplete="off" onChange={(event) => { setMusicId(event.target.value); clearQuoteAndApproval(); }} /></label>
      </div>

      <div className="freebeat-result">
        <h3>2. Foto penari (opsional, maks 5)</h3>
        <p>Tambahkan hingga 5 foto orang/karakter untuk dijadikan penari. Kosongkan untuk koreografi bebas oleh sutradara.</p>
        <div className="freebeat-upload">
          <label className="freebeat-field">Unggah foto penari (JPG, PNG, WebP maks 10 MB)<input type="file" accept="image/jpeg,image/png,image/webp" disabled={loading || !userId || allBusy || dancerImages.length >= 5} onChange={handleDancerImageUpload} /></label>
        </div>
        <div className="freebeat-inline">
          <label className="freebeat-field">Atau tambah URL HTTPS foto penari<input type="url" value={dancerUrlInput} maxLength={2048} disabled={allBusy || dancerImages.length >= 5} placeholder="https://..." autoComplete="off" onChange={(event) => setDancerUrlInput(event.target.value)} /></label>
          <button type="button" className="is-secondary" disabled={allBusy || !dancerUrlInput.trim() || dancerImages.length >= 5} onClick={addDancerUrl}>Tambah foto</button>
        </div>
        {dancerImages.length > 0 && <div className="freebeat-list">
          {dancerImages.map((item, index) => (
            <div key={item.url} className="freebeat-test-row">
              <p>Foto #{index + 1}: <code>{item.url}</code></p>
              <button type="button" className="is-secondary" disabled={allBusy} onClick={() => removeDancerImage(index)}>Hapus foto #{index + 1}</button>
            </div>
          ))}
        </div>}
      </div>

      <div className="freebeat-result">
        <h3>3. Arahan koreografi &amp; parameter</h3>
        <label className="freebeat-field">
          Rasio aspek
          <select value={aspectRatio} disabled={allBusy} onChange={(event) => { setAspectRatio(event.target.value); clearQuoteAndApproval(); }}>
            {DANCE_RATIOS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
          </select>
        </label>
        <label className="freebeat-confirm">
          <input type="checkbox" checked={autoMode} disabled={allBusy} onChange={(event) => { setAutoMode(event.target.checked); clearQuoteAndApproval(); }} />
          {' '}Mode otomatis sutradara (<code>auto_mode: true</code>). Matikan untuk mode ko-kreasi (sutradara berhenti pada <code>action_required</code> agar admin dapat membalas sesi).
        </label>
        <label className="freebeat-field">Arahan kreatif / prompt (opsional, maks 2000 karakter)<textarea rows={3} value={prompt} maxLength={2000} disabled={allBusy} placeholder="Contoh: K-pop synchronized choreography on a neon rooftop stage..." onChange={(event) => { setPrompt(event.target.value); clearQuoteAndApproval(); }} /></label>
        <div className="freebeat-inline">
          <label className="freebeat-field">start_ms (opsional, bawaan 0)<input type="number" min={0} max={600000} step={1} value={startMs} disabled={allBusy} placeholder="0" onChange={(event) => { setStartMs(event.target.value); clearQuoteAndApproval(); }} /></label>
          <label className="freebeat-field">end_ms (opsional, bawaan 15000)<input type="number" min={1} max={600000} step={1} value={endMs} disabled={allBusy} placeholder="15000" onChange={(event) => { setEndMs(event.target.value); clearQuoteAndApproval(); }} /></label>
        </div>
        <label className="freebeat-confirm">
          <input type="checkbox" checked={removeWatermark} disabled={allBusy} onChange={(event) => { setRemoveWatermark(event.target.checked); clearQuoteAndApproval(); }} />
          {' '}Hapus watermark (<code>remove_watermark: true</code>)
        </label>

        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy || !musicId.trim()} onClick={inspectDanceQuote}>Periksa quote dance (gratis)</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || allBusy || !musicId.trim()} onClick={prepareDance}>Siapkan persetujuan dance</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy} onClick={inspectTests}>Periksa catatan uji dance</button>
        </div>
        {!imageAccess && <p>Hubungkan Freebeat dengan izin generasi (<code>freebeat:generate</code>) di atas sebelum menyiapkan persetujuan.</p>}
      </div>

      {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
      {quote && <FreebeatCopyResult title="Quote dance video yang disaring" value={quote.quote} description={quote.credits !== null ? `Quote: ${quote.credits} kredit (mode otorisasi max_credits). Quote bukan biaya final sutradara.` : 'Quote di muka tidak tersedia oleh Freebeat; pengiriman memerlukan persetujuan eksplisit accept_unknown_cost.'} />}

      {approval && <div className="freebeat-result">
        <h3>Periksa dan setujui satu dance video</h3>
        <p>
          music_id: <strong>{String(approval.parameters.music_id)}</strong> · Rasio <strong>{approval.parameters.aspect_ratio}</strong> · {approval.parameters.auto_mode ? 'Otomatis (auto_mode: true)' : 'Ko-kreasi (auto_mode: false)'} · Resolusi <strong>720p</strong> ·
          {approval.accept_unknown_cost
            ? <> Total biaya di muka <strong>tidak tersedia</strong> (akan mengirim <code>accept_unknown_cost: true</code>).</>
            : <> Quote <strong>{approval.credits} kredit</strong> · batas dikirim <strong>{approval.max_credits} kredit Freebeat</strong>.</>}
          {' '}Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}.
        </p>
        <p>Sutradara menagih bertahap (perencanaan, pembuatan klip, dan penyuntingan); quote/batas tidak menjamin total biaya akhir seluruh sesi agen.</p>
        <label className="freebeat-confirm"><input type="checkbox" checked={confirmed} disabled={allBusy} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui pengiriman satu kali <code>generate_dance_video</code> menggunakan kredit akun Freebeat admin.</label>
        {approval.accept_unknown_cost && (
          <label className="freebeat-confirm"><input type="checkbox" checked={unknownCostConfirmed} disabled={allBusy} onChange={(event) => setUnknownCostConfirmed(event.target.checked)} /> Saya memahami total biaya di muka tidak tersedia dan menyetujui pengiriman dengan <code>accept_unknown_cost: true</code>.</label>
        )}
        <div className="freebeat-actions">
          <button type="button" disabled={!confirmed || (approval.accept_unknown_cost && !unknownCostConfirmed) || allBusy || !connected || !imageAccess} onClick={submitDance}>Setujui dan kirim dance video</button>
        </div>
      </div>}

      {notice && <div className="freebeat-alert" role="status">{notice}</div>}

      {tests.length > 0 && <div className="freebeat-result">
        <h3>Catatan uji dance video admin</h3>
        {tests.map((test) => (
          <div key={test.id} className="freebeat-test-row">
            <p>
              music_id: <code>{test.music_id}</code> · {test.aspect_ratio} · {test.auto_mode ? 'auto_mode' : 'ko-kreasi'} ·{' '}
              {test.accept_unknown_cost ? 'accept_unknown_cost' : `Batas ${test.max_credits} kredit`} ·{' '}
              {new Date(test.created_at).toLocaleString('id-ID')} · <strong>{test.status}</strong>
            </p>
            {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil pengiriman tidak pasti; pengiriman dance video baru diblokir. Jangan ulangi sebelum meninjau aktivitas di Freebeat.</p>}
            <div className="freebeat-actions">
              {test.canPoll && <button type="button" className="is-secondary" disabled={allBusy} onClick={() => pollDance(test.id)}>Periksa status &amp; hasil</button>}
              {test.status === 'submitted' && !test.canPoll && connected && <button type="button" className="is-secondary" disabled={allBusy} onClick={() => pollDance(test.id, true)}>Periksa status (sesi lama)</button>}
              {test.status === 'submitted' && connected && <button type="button" className="is-secondary" disabled={allBusy} onClick={() => inspectSession(test.id, !test.canPoll)}>Lihat sesi sutradara</button>}
              {test.session_url && <a className="freebeat-result-link" href={test.session_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka sesi Freebeat</a>}
            </div>

            {taskResults[test.id] && <div className="freebeat-task-result">
              <p>Status tugas: <strong>{taskResults[test.id].status}</strong>{taskResults[test.id].message ? ` — ${taskResults[test.id].message}` : ''}</p>
              <pre>{JSON.stringify(taskResults[test.id].billing, null, 2)}</pre>
              {taskResults[test.id].failure && <FreebeatCopyResult title="Rincian kegagalan dance yang disaring" value={taskResults[test.id].failure} />}
              {taskResults[test.id].cover_url && <div className="freebeat-result-links"><a className="freebeat-result-link" href={taskResults[test.id].cover_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka sampul video</a></div>}
              {taskResults[test.id].videos?.length > 0 && <div className="freebeat-result-links">{taskResults[test.id].videos.map((url, idx) => <a className="freebeat-result-link" key={url} href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka hasil dance video {idx + 1}</a>)}</div>}
              {taskResults[test.id].status === 'completed' && (!taskResults[test.id].videos || taskResults[test.id].videos.length === 0) && <p>Tugas selesai tetapi tautan video belum muncul dari get_task_result. Periksa kembali atau buka sesi Freebeat.</p>}
            </div>}

            {sessions[test.id] && <div className="freebeat-result">
              <h4>Sesi sutradara dance</h4>
              <p>Status sesi: <strong>{sessions[test.id].status || '-'}</strong>{sessions[test.id].stage ? ` · Tahap: ${sessions[test.id].stage}` : ''}{sessions[test.id].latest_message ? ` — ${sessions[test.id].latest_message}` : ''}</p>
              {sessions[test.id].messages?.length > 0 && <pre>{JSON.stringify(sessions[test.id].messages, null, 2)}</pre>}
              {sessions[test.id].media?.length > 0 && <div className="freebeat-result-links">{sessions[test.id].media.map((url, idx) => <a className="freebeat-result-link" key={url} href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Media sesi {idx + 1}</a>)}</div>}
            </div>}

            {test.canPoll && (
              <div className="freebeat-inline">
                <label className="freebeat-field">
                  Balas sutradara dance (hanya saat tidak <code>running</code> / saat <code>action_required</code>)
                  <input type="text" value={messageDrafts[test.id] || ''} maxLength={2000} disabled={allBusy} placeholder="Contoh: Lanjutkan dengan koreografi rooftop dan ubah pencahayaan jadi hangat" onChange={(event) => setMessageDrafts((old) => ({ ...old, [test.id]: event.target.value }))} />
                </label>
                <label className="freebeat-field">
                  Ubah auto_mode
                  <select value={messageAutoModes[test.id] || ''} disabled={allBusy} onChange={(event) => setMessageAutoModes((old) => ({ ...old, [test.id]: event.target.value }))}>
                    <option value="">Biarkan tetap</option>
                    <option value="true">Otomatis (true)</option>
                    <option value="false">Ko-kreasi (false)</option>
                  </select>
                </label>
                <button type="button" className="is-secondary" disabled={allBusy || !(messageDrafts[test.id] || '').trim()} onClick={() => sendAgentMessage(test.id)}>Kirim pesan ke sutradara</button>
              </div>
            )}
            {sessionNotices[test.id] && <p className="freebeat-alert" role="status">{sessionNotices[test.id]}</p>}
          </div>
        ))}
      </div>}
    </section>
  );
}
