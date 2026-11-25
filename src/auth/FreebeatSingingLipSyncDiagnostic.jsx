import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import {
  deleteFreebeatImage,
  probeMediaDurationMs,
  uploadFreebeatAudio,
  uploadFreebeatImage,
  uploadFreebeatVideo,
} from '../lib/freebeatVideoUpload';

const SINGING_RATIOS = [
  { value: '9:16', label: '9:16 (Vertikal · TikTok / Reels / Shorts)' },
  { value: '16:9', label: '16:9 (Lanskap)' },
  { value: '1:1', label: '1:1 (Persegi)' },
];

export function FreebeatSingingLipSyncDiagnostic({ connected, imageAccess, loading, request, userId, storage, onlyTool = null }) {
  const lockedTool = ['generate_singing_video', 'generate_lip_sync_video'].includes(onlyTool) ? onlyTool : null;
  const [tool, setTool] = useState(lockedTool || 'generate_singing_video');

  // Discovered live schema hints from tools/list
  const [schemaHints, setSchemaHints] = useState(null);
  const [discoveredModes, setDiscoveredModes] = useState([]);

  // Shared audio state
  const [audioUrl, setAudioUrl] = useState('');
  const [uploadedAudio, setUploadedAudio] = useState(null);
  const [audioUploadBusy, setAudioUploadBusy] = useState(false);
  const [musicId, setMusicId] = useState('');
  const [audioStatusNotice, setAudioStatusNotice] = useState('');

  // Singing-specific state
  const [singingMode, setSingingMode] = useState('auto');
  const [customMode, setCustomMode] = useState('');
  const [singerImages, setSingerImages] = useState([]);
  const [singerUrlInput, setSingerUrlInput] = useState('');
  const [imageUploadBusy, setImageUploadBusy] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState('15');
  const [audioStartSeconds, setAudioStartSeconds] = useState('');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [scenePrompt, setScenePrompt] = useState('');

  // Lip-Sync-specific state
  const [videoUrl, setVideoUrl] = useState('');
  const [uploadedVideo, setUploadedVideo] = useState(null);
  const [videoUploadBusy, setVideoUploadBusy] = useState(false);
  const [videoStatusNotice, setVideoStatusNotice] = useState('');
  const [videoDurationMs, setVideoDurationMs] = useState('10000');
  const [audioDurationMs, setAudioDurationMs] = useState('');
  const [clipName, setClipName] = useState('');

  const [removeWatermark, setRemoveWatermark] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [quote, setQuote] = useState(null);
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [unknownCostConfirmed, setUnknownCostConfirmed] = useState(false);
  const [initialConsent, setInitialConsent] = useState(false);
  const [initialDiagnostics, setInitialDiagnostics] = useState(null);
  const [notice, setNotice] = useState('');

  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const [sessions, setSessions] = useState({});
  const [messageDrafts, setMessageDrafts] = useState({});
  const [messageAutoModes, setMessageAutoModes] = useState({});
  const [sessionNotices, setSessionNotices] = useState({});

  const requestVersionRef = useRef(0);

  useEffect(() => {
    if (!connected) {
      requestVersionRef.current += 1;
      setBusy(false);
      setError('');
      setNotice('');
      setQuote(null);
      setApproval(null);
      setConfirmed(false);
      setUnknownCostConfirmed(false);
      setInitialConsent(false);
      setInitialDiagnostics(null);
    }
  }, [connected]);

  function clearApproval() {
    setApproval(null);
    setConfirmed(false);
    setUnknownCostConfirmed(false);
    setInitialConsent(false);
  }

  function clearQuoteAndApproval() {
    setQuote(null);
    clearApproval();
    setNotice('');
  }

  function syncSchemaHintsFromTools(tools) {
    if (!tools || typeof tools !== 'object') return;
    const singingProps = tools.generate_singing_video?.properties || {};
    const lipSyncProps = tools.generate_lip_sync_video?.properties || {};
    const modes = Array.isArray(singingProps.mode?.enum)
      ? singingProps.mode.enum.filter((m) => typeof m === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(m))
      : [];
    if (modes.length > 0) {
      setDiscoveredModes(modes);
      setSingingMode((prev) => (prev !== 'custom' && !modes.includes(prev) ? modes[0] : prev));
    }
    setSchemaHints({
      singingModes: modes,
      singingMinDuration: singingProps.duration_seconds?.minimum ?? null,
      singingMaxDuration: singingProps.duration_seconds?.maximum ?? null,
      singingMaxImages: singingProps.image_urls?.maxItems ?? 5,
      lipSyncMinDurationMs: lipSyncProps.video_duration_ms?.minimum ?? null,
      lipSyncMaxDurationMs: lipSyncProps.video_duration_ms?.maximum ?? null,
    });
  }

  async function syncLiveSchemas() {
    const version = ++requestVersionRef.current;
    setBusy(true); setError('');
    try {
      const data = await request('vocal-video-schemas', 'POST', { acknowledge: true });
      if (requestVersionRef.current !== version) return;
      syncSchemaHintsFromTools(data.tools);
      setNotice('Opsi mode & batas parameter vokal disinkronkan dari skema MCP Freebeat.');
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal memuat skema tool singing & lip-sync.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  function buildVocalPayload() {
    const rawMusic = musicId.trim();
    let parsedMusicId;
    if (rawMusic) {
      if (!/^\d{1,15}$/.test(rawMusic)) {
        throw new Error('music_id untuk singing/lip-sync harus berupa angka integer (atau kosongkan music_id dan isi audio_url HTTPS).');
      }
      parsedMusicId = Number(rawMusic);
    }
    const cleanAudioUrl = audioUrl.trim();
    if (parsedMusicId === undefined && !cleanAudioUrl) {
      throw new Error('Isi music_id dari upload_audio atau masukkan audio_url HTTPS.');
    }

    if (tool === 'generate_singing_video') {
      if (singerImages.length === 0) {
        throw new Error('Tambahkan minimal 1 foto karakter/penyanyi.');
      }
      const dur = Number(durationSeconds);
      if (!Number.isFinite(dur) || dur <= 0 || dur > 600) {
        throw new Error('Isi duration_seconds dengan angka > 0 dan <= 600 detik.');
      }
      const effectiveMode = singingMode === 'custom' ? customMode.trim() : singingMode;
      if (!effectiveMode) {
        throw new Error('Pilih atau masukkan mode bernyanyi.');
      }
      const payload = {
        tool: 'generate_singing_video',
        mode: effectiveMode,
        image_urls: singerImages.map((item) => item.url),
        duration_seconds: dur,
        aspect_ratio: aspectRatio,
        remove_watermark: removeWatermark,
      };
      if (parsedMusicId !== undefined) payload.music_id = parsedMusicId;
      else payload.audio_url = cleanAudioUrl;
      if (audioStartSeconds !== '') {
        const startSec = Number(audioStartSeconds);
        if (!Number.isFinite(startSec) || startSec < 0 || startSec > 600) {
          throw new Error('audio_start_seconds harus angka >= 0 detik.');
        }
        payload.audio_start_seconds = startSec;
      }
      if (scenePrompt.trim()) payload.scene_prompt = scenePrompt.trim();
      return payload;
    }

    // generate_lip_sync_video
    const cleanVideoUrl = videoUrl.trim();
    if (!cleanVideoUrl) {
      throw new Error('Unggah video sumber atau masukkan video_url HTTPS.');
    }
    const vidMs = Number(videoDurationMs);
    if (!Number.isSafeInteger(vidMs) || vidMs <= 0 || vidMs > 600000) {
      throw new Error('Isi video_duration_ms dengan bilangan bulat milidetik (> 0 dan <= 600000).');
    }
    const payload = {
      tool: 'generate_lip_sync_video',
      video_url: cleanVideoUrl,
      video_duration_ms: vidMs,
      remove_watermark: removeWatermark,
    };
    if (parsedMusicId !== undefined) payload.music_id = parsedMusicId;
    else payload.audio_url = cleanAudioUrl;
    if (audioDurationMs !== '') {
      const audMs = Number(audioDurationMs);
      if (!Number.isSafeInteger(audMs) || audMs <= 0 || audMs > 600000) {
        throw new Error('audio_duration_ms harus berupa bilangan bulat milidetik (> 0 dan <= 600000).');
      }
      payload.audio_duration_ms = audMs;
    }
    if (clipName.trim()) payload.name = clipName.trim();
    return payload;
  }

  async function handleAudioFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setAudioUploadBusy(true); setError(''); setAudioStatusNotice(''); clearQuoteAndApproval();
    try {
      const [next, probedMs] = await Promise.all([
        uploadFreebeatAudio(storage, userId, file),
        probeMediaDurationMs(file, 'audio'),
      ]);
      if (!next.url) throw new Error('Audio tersimpan, tetapi URL publik HTTPS tidak tersedia.');
      setUploadedAudio(next);
      setAudioUrl(next.url);
      if (probedMs && !audioDurationMs) setAudioDurationMs(String(probedMs));
      setAudioStatusNotice(
        `Audio diunggah ke Supabase Storage${probedMs ? ` (~${(probedMs / 1000).toFixed(1)} dtk)` : ''}. Anda dapat langsung memakai URL ini atau klik "Daftarkan audio ke Freebeat" untuk mengisi music_id.`
      );
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
    const version = ++requestVersionRef.current;
    setBusy(true); setError(''); setAudioStatusNotice(''); clearQuoteAndApproval();
    try {
      const data = await request('vocal-upload-audio', 'POST', { audio_url: audioUrl.trim() });
      if (requestVersionRef.current !== version) return;
      if (/^\d{1,15}$/.test(String(data.music_id || '').trim())) {
        setMusicId(String(data.music_id).trim());
        setAudioStatusNotice(
          data.status === 'preparing'
            ? `Freebeat mengembalikan music_id ${data.music_id} (sedang disiapkan${data.retry_after_seconds ? `, perkiraan ${data.retry_after_seconds} dtk` : ''}).`
            : `Audio terdaftar di Freebeat dengan music_id integer: ${data.music_id}.`
        );
      } else {
        setMusicId('');
        setAudioStatusNotice(`upload_audio mengembalikan ID non-integer (${data.music_id}); gunakan audio_url langsung karena singing/lip-sync membutuhkan integer music_id.`);
      }
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal mendaftarkan audio lewat upload_audio Freebeat.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function handleVideoFileUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setVideoUploadBusy(true); setError(''); setVideoStatusNotice(''); clearQuoteAndApproval();
    try {
      const [next, probedMs] = await Promise.all([
        uploadFreebeatVideo(storage, userId, file),
        probeMediaDurationMs(file, 'video'),
      ]);
      if (!next.url) throw new Error('Video tersimpan, tetapi URL publik HTTPS tidak tersedia.');
      setUploadedVideo(next);
      setVideoUrl(next.url);
      if (probedMs) setVideoDurationMs(String(probedMs));
      setVideoStatusNotice(
        `Video diunggah ke Supabase Storage${probedMs ? ` (durasi terdeteksi ${probedMs} ms)` : ''}. Anda dapat langsung mendaftarkannya lewat upload_video.`
      );
    } catch (err) {
      setError(err.message || 'Gagal mengunggah file video ke Supabase.');
    } finally {
      setVideoUploadBusy(false);
    }
  }

  async function removeUploadedVideo() {
    if (!uploadedVideo?.path) return;
    setVideoUploadBusy(true); setError('');
    try {
      await deleteFreebeatImage(storage, uploadedVideo.path);
      if (videoUrl === uploadedVideo.url) setVideoUrl('');
      setUploadedVideo(null);
      setVideoStatusNotice('File video dihapus dari Supabase Storage.');
    } catch (err) {
      setError(err.message || 'Gagal menghapus file video dari Supabase.');
    } finally {
      setVideoUploadBusy(false);
    }
  }

  async function registerVideoWithFreebeat() {
    if (!videoUrl.trim()) return;
    const version = ++requestVersionRef.current;
    setBusy(true); setError(''); setVideoStatusNotice(''); clearQuoteAndApproval();
    try {
      const data = await request('vocal-upload-video', 'POST', { video_url: videoUrl.trim() });
      if (requestVersionRef.current !== version) return;
      if (data.video_url) setVideoUrl(data.video_url);
      if (Number.isSafeInteger(data.duration_ms) && data.duration_ms > 0) {
        setVideoDurationMs(String(data.duration_ms));
      }
      setVideoStatusNotice(
        data.hosted
          ? `Video di-host di Freebeat (${data.video_url})${data.duration_ms ? ` · durasi ${data.duration_ms} ms` : ''}.`
          : `upload_video selesai (status: ${data.status}).`
      );
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal mendaftarkan video lewat upload_video Freebeat.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function handleSingerImageUpload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const maxImgs = schemaHints?.singingMaxImages || 5;
    if (singerImages.length >= maxImgs) {
      setError(`Maksimal ${maxImgs} foto penyanyi.`);
      return;
    }
    setImageUploadBusy(true); setError(''); clearQuoteAndApproval();
    try {
      const next = await uploadFreebeatImage(storage, userId, file);
      if (!next.url) throw new Error('Gambar tersimpan, tetapi URL publik HTTPS tidak tersedia.');
      setSingerImages((old) => [...old, { url: next.url, path: next.path }]);
    } catch (err) {
      setError(err.message || 'Gagal mengunggah foto penyanyi ke Supabase.');
    } finally {
      setImageUploadBusy(false);
    }
  }

  function addSingerUrl() {
    const clean = singerUrlInput.trim();
    if (!clean) return;
    const maxImgs = schemaHints?.singingMaxImages || 5;
    if (singerImages.length >= maxImgs) {
      setError(`Maksimal ${maxImgs} foto penyanyi.`);
      return;
    }
    try {
      if (new URL(clean).protocol !== 'https:') throw new Error('URL foto penyanyi harus HTTPS.');
    } catch {
      setError('Masukkan URL HTTPS publik yang valid untuk foto penyanyi.');
      return;
    }
    if (singerImages.some((item) => item.url === clean)) {
      setSingerUrlInput('');
      return;
    }
    setError('');
    clearQuoteAndApproval();
    setSingerImages((old) => [...old, { url: clean, path: null }]);
    setSingerUrlInput('');
  }

  async function removeSingerImage(index) {
    const item = singerImages[index];
    if (!item) return;
    setError(''); clearQuoteAndApproval();
    if (item.path) {
      setImageUploadBusy(true);
      try {
        await deleteFreebeatImage(storage, item.path);
      } catch (err) {
        setError(err.message || 'Gagal menghapus foto penyanyi dari Supabase.');
        setImageUploadBusy(false);
        return;
      }
      setImageUploadBusy(false);
    }
    setSingerImages((old) => old.filter((_, i) => i !== index));
  }

  async function inspectVocalQuote() {
    const version = ++requestVersionRef.current;
    setBusy(true); setError(''); setQuote(null); clearApproval();
    try {
      const body = buildVocalPayload();
      const data = await request('vocal-quote', 'POST', body);
      if (requestVersionRef.current !== version) return;
      if (data.schema_meta?.singingModes?.length) {
        setDiscoveredModes(data.schema_meta.singingModes);
        setSchemaHints(data.schema_meta);
      }
      setQuote(data);
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal memeriksa quote vokal/lip-sync.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function prepareVocal() {
    const version = ++requestVersionRef.current;
    setBusy(true); setError(''); setNotice(''); clearApproval();
    try {
      const body = buildVocalPayload();
      const data = await request('vocal-prepare', 'POST', body);
      if (requestVersionRef.current !== version) return;
      if (data.schema_meta?.singingModes?.length) {
        setDiscoveredModes(data.schema_meta.singingModes);
        setSchemaHints(data.schema_meta);
      }
      setApproval(data);
      await refreshTests().catch(() => {});
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal menyiapkan persetujuan uji vokal/lip-sync.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function refreshTests() {
    const data = await request('vocal-tests');
    setTests(data.tests || []);
  }

  async function inspectTests() {
    const version = ++requestVersionRef.current;
    setBusy(true); setError('');
    try {
      await refreshTests();
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal memuat catatan uji vokal/lip-sync.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function submitVocal() {
    if (!approval?.approval || !confirmed) return;
    if (approval.accept_unknown_cost && !unknownCostConfirmed) return;
    const capture = initialConsent;
    const version = ++requestVersionRef.current;
    setBusy(true); setError(''); setNotice(''); setInitialDiagnostics(null);
    try {
      const data = await request('vocal-submit', 'POST', {
        approval: approval.approval,
        confirm: true,
        ...(approval.accept_unknown_cost ? { confirm_unknown_cost: true } : {}),
        ...(capture ? { private_diagnostics: true } : {}),
      });
      if (requestVersionRef.current !== version) return;
      if (capture) setInitialDiagnostics(data.initial_diagnostics || { received: false, messages: [] });
      clearApproval();
      if (data.status === 'preparing') {
        if (data.music_id && /^\d{1,15}$/.test(String(data.music_id))) setMusicId(String(data.music_id));
        setNotice(`Audio sedang disiapkan oleh Freebeat (status: preparing). Tunggu sekitar ${data.retry_after_seconds || 10} detik, lalu siapkan persetujuan dan kirim ulang.`);
      } else if (data.status === 'submitted') {
        setNotice(`Tugas ${approval.tool} berhasil dikirim.${data.session_url ? ' Tautan sesi tersedia di catatan uji.' : ''}`);
      } else {
        setNotice('Hasil pengiriman tidak pasti; pengiriman vokal/lip-sync baru diblokir hingga catatan ditinjau.');
      }
      await refreshTests();
    } catch (err) {
      if (requestVersionRef.current === version) {
        if (capture) setInitialDiagnostics({ received: false, messages: err?.message ? [err.message] : [] });
        setError(err.message || 'Gagal mengirim uji vokal/lip-sync.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function pollVocal(id, acknowledge = false) {
    const version = ++requestVersionRef.current;
    setBusy(true); setError('');
    try {
      const data = await request('vocal-task', 'POST', acknowledge ? { id, acknowledge: true } : { id });
      if (requestVersionRef.current === version) {
        setTaskResults((old) => ({ ...old, [id]: data.task }));
      }
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal memeriksa status tugas.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function inspectSession(id, acknowledge = false) {
    const version = ++requestVersionRef.current;
    setBusy(true); setError('');
    try {
      const data = await request('vocal-session', 'POST', acknowledge ? { id, acknowledge: true } : { id });
      if (requestVersionRef.current === version) {
        setSessions((old) => ({ ...old, [id]: data.session }));
      }
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal memuat sesi video Freebeat.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  async function sendAgentMessage(id) {
    const msg = (messageDrafts[id] || '').trim();
    if (!msg) return;
    const version = ++requestVersionRef.current;
    setBusy(true); setError('');
    try {
      const nextAuto = messageAutoModes[id];
      const payload = { id, message: msg };
      if (nextAuto === 'true') payload.auto_mode = true;
      if (nextAuto === 'false') payload.auto_mode = false;
      const data = await request('vocal-message', 'POST', payload);
      if (requestVersionRef.current !== version) return;
      setMessageDrafts((old) => ({ ...old, [id]: '' }));
      setSessionNotices((old) => ({ ...old, [id]: data.reply || 'Pesan diterima oleh agen video.' }));
      if (data.session) setSessions((old) => ({ ...old, [id]: data.session }));
    } catch (err) {
      if (requestVersionRef.current === version) {
        setError(err.message || 'Gagal mengirim pesan ke agen video.');
      }
    } finally {
      if (requestVersionRef.current === version) setBusy(false);
    }
  }

  const allBusy = busy || audioUploadBusy || imageUploadBusy || videoUploadBusy;
  const maxSingerImages = schemaHints?.singingMaxImages || 5;
  const hasReadyAudio = Boolean(musicId.trim() || audioUrl.trim());
  const canQuoteOrPrepare = hasReadyAudio && (
    tool === 'generate_singing_video'
      ? singerImages.length > 0 && Number(durationSeconds) > 0
      : Boolean(videoUrl.trim()) && Number.isSafeInteger(Number(videoDurationMs)) && Number(videoDurationMs) > 0
  );

  return (
    <section className="freebeat-card freebeat-site-test">
      <span className="freebeat-kicker">SINGING &amp; LIP-SYNC · KHUSUS ADMIN · MCP RESMI</span>
      <h2>{lockedTool ? (tool === 'generate_lip_sync_video' ? 'Uji Lip-Sync Video' : 'Uji Singing Video') : 'Uji Singing & Lip-Sync Video'}</h2>
      <p>Menjalankan {lockedTool ? <code>{lockedTool}</code> : <><code>generate_singing_video</code> atau <code>generate_lip_sync_video</code></>} melalui akun Freebeat admin dengan pemeriksaan quote dan persetujuan eksplisit. Upload media juga memerlukan tindakan dan persetujuan terpisah.</p>

      <div className="freebeat-actions">
        {!lockedTool && <>
        <button
          type="button"
          className={tool === 'generate_singing_video' ? '' : 'is-secondary'}
          disabled={allBusy}
          onClick={() => { setTool('generate_singing_video'); clearQuoteAndApproval(); setError(''); }}
        >
          Singing Video (generate_singing_video)
        </button>
        <button
          type="button"
          className={tool === 'generate_lip_sync_video' ? '' : 'is-secondary'}
          disabled={allBusy}
          onClick={() => { setTool('generate_lip_sync_video'); clearQuoteAndApproval(); setError(''); }}
        >
          Lip-Sync Video (generate_lip_sync_video)
        </button>
        </>}
        <button
          type="button"
          className="is-secondary"
          disabled={loading || !connected || allBusy}
          onClick={syncLiveSchemas}
        >
          Muat opsi mode &amp; batas live
        </button>
      </div>

      {schemaHints && (
        <p className="freebeat-note">
          Skema tersinkron: mode bernyanyi = <code>{schemaHints.singingModes?.length ? schemaHints.singingModes.join(', ') : '(belum tercantum)'}</code>
          {schemaHints.singingMinDuration !== null || schemaHints.singingMaxDuration !== null
            ? <> · durasi singing: <code>{schemaHints.singingMinDuration ?? '?'}–{schemaHints.singingMaxDuration ?? '?'} dtk</code></>
            : null}
          {schemaHints.lipSyncMinDurationMs !== null || schemaHints.lipSyncMaxDurationMs !== null
            ? <> · durasi lip-sync: <code>{schemaHints.lipSyncMinDurationMs ?? '?'}–{schemaHints.lipSyncMaxDurationMs ?? '?'} ms</code></>
            : null}
        </p>
      )}

      {tool === 'generate_lip_sync_video' && (
        <div className="freebeat-result">
          <h3>1. Video Sumber (wajib untuk Lip-Sync)</h3>
          <p>Unggah file video (MP4/MOV/WebM/M4V maks 100 MB) ke Supabase Storage atau tempel URL HTTPS video, lalu opsional daftarkan ke Freebeat via <code>upload_video</code>.</p>
          <div className="freebeat-upload">
            <label className="freebeat-field">Unggah video sumber ke Supabase Storage<input type="file" accept="video/mp4,video/quicktime,video/webm,video/x-m4v" disabled={loading || !userId || allBusy} onChange={handleVideoFileUpload} /></label>
            {uploadedVideo && <button type="button" className="is-secondary" disabled={allBusy} onClick={removeUploadedVideo}>Hapus video dari Supabase</button>}
          </div>
          <label className="freebeat-field">URL HTTPS video sumber<input type="url" value={videoUrl} maxLength={2048} disabled={allBusy} placeholder="https://..." autoComplete="off" onChange={(event) => { setVideoUrl(event.target.value); setVideoStatusNotice(''); clearQuoteAndApproval(); }} /></label>
          <div className="freebeat-actions">
            <button type="button" className="is-secondary" disabled={loading || !connected || allBusy || !videoUrl.trim()} onClick={registerVideoWithFreebeat}>Daftarkan video ke Freebeat (upload_video)</button>
          </div>
          {videoStatusNotice && <p className="freebeat-alert" role="status">{videoStatusNotice}</p>}
          <label className="freebeat-field">
            video_duration_ms (wajib, integer milidetik)
            <input type="number" min={1} max={600000} step={1} value={videoDurationMs} disabled={allBusy} onChange={(event) => { setVideoDurationMs(event.target.value); clearQuoteAndApproval(); }} />
          </label>
        </div>
      )}

      <div className="freebeat-result">
        <h3>{tool === 'generate_lip_sync_video' ? '2. Audio / Lagu (wajib)' : '1. Audio / Lagu (music_id atau audio_url)'}</h3>
        <p>Unggah audio ke Supabase Storage atau masukkan URL HTTPS lagu, lalu daftarkan lewat <code>upload_audio</code> (mengisi integer <code>music_id</code>) atau pakai <code>audio_url</code> langsung.</p>
        <div className="freebeat-upload">
          <label className="freebeat-field">Unggah file audio ke Supabase Storage<input type="file" accept="audio/*" disabled={loading || !userId || allBusy} onChange={handleAudioFileUpload} /></label>
          {uploadedAudio && <button type="button" className="is-secondary" disabled={allBusy} onClick={removeUploadedAudio}>Hapus audio dari Supabase</button>}
        </div>
        <label className="freebeat-field">URL HTTPS audio / audio_url<input type="url" value={audioUrl} maxLength={2048} disabled={allBusy} placeholder="https://..." autoComplete="off" onChange={(event) => { setAudioUrl(event.target.value); setAudioStatusNotice(''); clearQuoteAndApproval(); }} /></label>
        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy || !audioUrl.trim()} onClick={registerAudioWithFreebeat}>Daftarkan audio ke Freebeat (upload_audio)</button>
        </div>
        {audioStatusNotice && <p className="freebeat-alert" role="status">{audioStatusNotice}</p>}
        <label className="freebeat-field">
          music_id integer (opsional — jika kosong, audio_url dikirim langsung)
          <input type="text" value={musicId} maxLength={20} disabled={allBusy} placeholder="Contoh: 2485485" autoComplete="off" onChange={(event) => { setMusicId(event.target.value); clearQuoteAndApproval(); }} />
        </label>
        {tool === 'generate_lip_sync_video' && (
          <label className="freebeat-field">
            audio_duration_ms (opsional, integer milidetik)
            <input type="number" min={1} max={600000} step={1} value={audioDurationMs} disabled={allBusy} placeholder="Otomatis dari file audio" onChange={(event) => { setAudioDurationMs(event.target.value); clearQuoteAndApproval(); }} />
          </label>
        )}
      </div>

      {tool === 'generate_singing_video' && (
        <div className="freebeat-result">
          <h3>2. Foto Karakter / Penyanyi (wajib 1–{maxSingerImages})</h3>
          <div className="freebeat-upload">
            <label className="freebeat-field">Unggah foto penyanyi (JPG, PNG, WebP maks 10 MB)<input type="file" accept="image/jpeg,image/png,image/webp" disabled={loading || !userId || allBusy || singerImages.length >= maxSingerImages} onChange={handleSingerImageUpload} /></label>
          </div>
          <div className="freebeat-inline">
            <label className="freebeat-field">Atau tambah URL HTTPS foto penyanyi<input type="url" value={singerUrlInput} maxLength={2048} disabled={allBusy || singerImages.length >= maxSingerImages} placeholder="https://..." autoComplete="off" onChange={(event) => setSingerUrlInput(event.target.value)} /></label>
            <button type="button" className="is-secondary" disabled={allBusy || !singerUrlInput.trim() || singerImages.length >= maxSingerImages} onClick={addSingerUrl}>Tambah foto</button>
          </div>
          {singerImages.length > 0 && (
            <div className="freebeat-list">
              {singerImages.map((item, index) => (
                <div key={item.url} className="freebeat-test-row">
                  <p>Foto #{index + 1}: <code>{item.url}</code></p>
                  <button type="button" className="is-secondary" disabled={allBusy} onClick={() => removeSingerImage(index)}>Hapus foto #{index + 1}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="freebeat-result">
        <h3>3. Parameter {tool === 'generate_singing_video' ? 'Singing Video' : 'Lip-Sync Video'}</h3>
        {tool === 'generate_singing_video' ? (
          <>
            <label className="freebeat-field">
              Mode bernyanyi (<code>mode</code>)
              <select value={singingMode} disabled={allBusy} onChange={(event) => { setSingingMode(event.target.value); clearQuoteAndApproval(); }}>
                {discoveredModes.length > 0 ? (
                  <>
                    {discoveredModes.map((m) => <option key={m} value={m}>{m}</option>)}
                    <option value="custom">Kustom manual…</option>
                  </>
                ) : (
                  <>
                    <option value="auto">auto (resolusi solo/non-duet dari tools/list)</option>
                    <option value="duet">duet</option>
                    <option value="custom">Kustom manual…</option>
                  </>
                )}
              </select>
            </label>
            {singingMode === 'custom' && (
              <label className="freebeat-field">
                Nilai mode kustom
                <input type="text" value={customMode} maxLength={64} disabled={allBusy} placeholder="Masukkan enum mode persis dari tools/list" onChange={(event) => { setCustomMode(event.target.value); clearQuoteAndApproval(); }} />
              </label>
            )}
            <div className="freebeat-inline">
              <label className="freebeat-field">
                duration_seconds (wajib)
                <input type="number" min={0.5} max={600} step="0.5" value={durationSeconds} disabled={allBusy} onChange={(event) => { setDurationSeconds(event.target.value); clearQuoteAndApproval(); }} />
              </label>
              <label className="freebeat-field">
                audio_start_seconds (opsional)
                <input type="number" min={0} max={600} step="0.5" value={audioStartSeconds} disabled={allBusy} placeholder="0" onChange={(event) => { setAudioStartSeconds(event.target.value); clearQuoteAndApproval(); }} />
              </label>
            </div>
            <label className="freebeat-field">
              Rasio aspek
              <select value={aspectRatio} disabled={allBusy} onChange={(event) => { setAspectRatio(event.target.value); clearQuoteAndApproval(); }}>
                {SINGING_RATIOS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </label>
            <label className="freebeat-field">
              Arahan adegan / scene_prompt (opsional)
              <textarea rows={3} value={scenePrompt} maxLength={2000} disabled={allBusy} placeholder="Contoh: Dramatic spotlight stage with warm volumetric haze..." onChange={(event) => { setScenePrompt(event.target.value); clearQuoteAndApproval(); }} />
            </label>
          </>
        ) : (
          <label className="freebeat-field">
            Nama klip / name (opsional, maks 200 karakter)
            <input type="text" value={clipName} maxLength={200} disabled={allBusy} placeholder="Contoh: Uji Lip-Sync Studio" onChange={(event) => { setClipName(event.target.value); clearQuoteAndApproval(); }} />
          </label>
        )}

        <label className="freebeat-confirm">
          <input type="checkbox" checked={removeWatermark} disabled={allBusy} onChange={(event) => { setRemoveWatermark(event.target.checked); clearQuoteAndApproval(); }} />
          {' '}Hapus watermark (<code>remove_watermark: true</code>)
        </label>

        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy || !canQuoteOrPrepare} onClick={inspectVocalQuote}>Periksa quote vokal (gratis)</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || allBusy || !canQuoteOrPrepare} onClick={prepareVocal}>Siapkan persetujuan vokal</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || allBusy} onClick={inspectTests}>Periksa catatan uji vokal</button>
        </div>
        {!imageAccess && <p>Hubungkan Freebeat dengan izin generasi (<code>freebeat:generate</code>) di atas sebelum menyiapkan persetujuan.</p>}
      </div>

      {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
      {quote && <FreebeatCopyResult title={`Quote ${quote.tool} yang disaring`} value={{ tool: quote.tool, parameters: quote.parameters, quote: quote.quote }} description={quote.credits !== null ? `Quote: ${quote.credits} kredit Freebeat (mode otorisasi max_credits).` : 'Quote di muka tidak tersedia; pengiriman memerlukan persetujuan eksplisit accept_unknown_cost.'} />}

      {approval && (
        <div className="freebeat-result">
          <h3>Periksa dan setujui satu {approval.tool}</h3>
          <p>
            Tool: <strong>{approval.tool}</strong>
            {approval.tool === 'generate_singing_video'
              ? <> · mode: <strong>{approval.parameters.mode}</strong> · rasio <strong>{approval.parameters.aspect_ratio}</strong> · durasi <strong>{approval.parameters.duration_seconds} dtk</strong></>
              : <> · durasi video: <strong>{approval.parameters.video_duration_ms} ms</strong></>}
            {' '}·{' '}
            {approval.accept_unknown_cost
              ? <>Total biaya di muka <strong>tidak tersedia</strong> (mengirim <code>accept_unknown_cost: true</code>).</>
              : <>Quote <strong>{approval.credits} kredit</strong> · batas dikirim <strong>{approval.max_credits} kredit Freebeat</strong>.</>}
            {' '}Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}.
          </p>
          <label className="freebeat-confirm"><input type="checkbox" checked={confirmed} disabled={allBusy} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui pengiriman satu kali <code>{approval.tool}</code> menggunakan kredit akun Freebeat admin.</label>
          {approval.accept_unknown_cost && (
            <label className="freebeat-confirm"><input type="checkbox" checked={unknownCostConfirmed} disabled={allBusy} onChange={(event) => setUnknownCostConfirmed(event.target.checked)} /> Saya memahami total biaya di muka tidak tersedia dan menyetujui pengiriman dengan <code>accept_unknown_cost: true</code>.</label>
          )}
          <label className="freebeat-confirm"><input type="checkbox" checked={initialConsent} disabled={allBusy} onChange={(event) => setInitialConsent(event.target.checked)} /> Opsional: tampilkan pesan respons awal secara privat setelah pengiriman ini. Pesan mungkin mengandung data sensitif; penyamaran tidak dijamin lengkap. Jangan bagikan pesan mentah, URL atau kredensial.</label>
          <div className="freebeat-actions">
            <button type="button" disabled={!confirmed || (approval.accept_unknown_cost && !unknownCostConfirmed) || allBusy || !connected || !imageAccess} onClick={submitVocal}>Setujui dan kirim video</button>
          </div>
        </div>
      )}

      {notice && <div className="freebeat-alert" role="status">{notice}</div>}

      {initialDiagnostics && (
        <div className="freebeat-result" aria-label="Diagnostik respons awal privat vokal">
          <h3>Pesan respons awal privat</h3>
          <p>Hanya untuk Anda. Jangan bagikan pesan mentah; jelaskan dengan kata sendiri tanpa URL, token atau data pribadi. Pesan ini tidak disimpan dan hilang saat halaman ditutup. Pesan bukan kepastian biaya atau hasil tugas.</p>
          <div className="freebeat-actions">
            <button type="button" className="is-secondary" onClick={() => setInitialDiagnostics(null)}>Sembunyikan respons awal</button>
          </div>
          {!initialDiagnostics.received ? (
            <>
              <p>Respons awal tidak tersedia atau ditolak oleh provider. Jangan ulangi sebelum memeriksa catatan dan aktivitas Freebeat.</p>
              {initialDiagnostics.messages?.map((message, index) => <pre key={index}>{message}</pre>)}
            </>
          ) : initialDiagnostics.messages?.length ? (
            initialDiagnostics.messages.map((message, index) => <pre key={index}>{message}</pre>)
          ) : (
            <p>Tidak ada pesan awal dalam field yang dapat ditampilkan.</p>
          )}
        </div>
      )}

      {tests.length > 0 && (
        <div className="freebeat-result">
          <h3>Catatan uji singing &amp; lip-sync admin</h3>
          {tests.map((test) => (
            <div key={test.id} className="freebeat-test-row">
              <p>
                <code>{test.tool_name}</code>
                {test.mode ? <> · mode: <strong>{test.mode}</strong></> : null}
                {test.aspect_ratio ? <> · {test.aspect_ratio}</> : null}
                {test.duration_seconds ? <> · {test.duration_seconds} dtk</> : null}
                {test.video_duration_ms ? <> · {test.video_duration_ms} ms</> : null}
                {' '}· {test.accept_unknown_cost ? 'accept_unknown_cost' : `Batas ${test.max_credits} kredit`} ·{' '}
                {new Date(test.created_at).toLocaleString('id-ID')} · <strong>{test.status}</strong>
              </p>
              {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil pengiriman tidak pasti; pengiriman vokal/lip-sync baru diblokir. Jangan ulangi sebelum meninjau aktivitas di Freebeat.</p>}
              <div className="freebeat-actions">
                {test.canPoll && <button type="button" className="is-secondary" disabled={allBusy} onClick={() => pollVocal(test.id)}>Periksa status &amp; hasil</button>}
                {test.status === 'submitted' && !test.canPoll && connected && <button type="button" className="is-secondary" disabled={allBusy} onClick={() => pollVocal(test.id, true)}>Periksa status (sesi lama)</button>}
                {test.status === 'submitted' && connected && <button type="button" className="is-secondary" disabled={allBusy} onClick={() => inspectSession(test.id, !test.canPoll)}>Lihat sesi agen</button>}
                {test.session_url && <a className="freebeat-result-link" href={test.session_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka sesi Freebeat</a>}
              </div>

              {taskResults[test.id] && (
                <div className="freebeat-task-result">
                  <p>Status tugas: <strong>{taskResults[test.id].status}</strong>{taskResults[test.id].message ? ` — ${taskResults[test.id].message}` : ''}</p>
                  <pre>{JSON.stringify(taskResults[test.id].billing, null, 2)}</pre>
                  {taskResults[test.id].failure && <FreebeatCopyResult title="Rincian kegagalan yang disaring" value={taskResults[test.id].failure} />}
                  {taskResults[test.id].cover_url && <div className="freebeat-result-links"><a className="freebeat-result-link" href={taskResults[test.id].cover_url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka sampul video</a></div>}
                  {taskResults[test.id].videos?.length > 0 && <div className="freebeat-result-links">{taskResults[test.id].videos.map((url, idx) => <a className="freebeat-result-link" key={url} href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Buka hasil video {idx + 1}</a>)}</div>}
                  {taskResults[test.id].status === 'completed' && (!taskResults[test.id].videos || taskResults[test.id].videos.length === 0) && <p>Tugas selesai tetapi tautan video belum muncul dari get_task_result. Periksa kembali atau buka sesi Freebeat.</p>}
                </div>
              )}

              {sessions[test.id] && (
                <div className="freebeat-result">
                  <h4>Sesi agen video Freebeat</h4>
                  <p>Status sesi: <strong>{sessions[test.id].status || '-'}</strong>{sessions[test.id].stage ? ` · Tahap: ${sessions[test.id].stage}` : ''}{sessions[test.id].latest_message ? ` — ${sessions[test.id].latest_message}` : ''}</p>
                  {sessions[test.id].messages?.length > 0 && <pre>{JSON.stringify(sessions[test.id].messages, null, 2)}</pre>}
                  {sessions[test.id].media?.length > 0 && <div className="freebeat-result-links">{sessions[test.id].media.map((url, idx) => <a className="freebeat-result-link" key={url} href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" /> Media sesi {idx + 1}</a>)}</div>}
                </div>
              )}

              {test.canPoll && (
                <div className="freebeat-inline">
                  <label className="freebeat-field">
                    Balas agen video (hanya saat tidak <code>running</code> / saat <code>action_required</code>)
                    <input type="text" value={messageDrafts[test.id] || ''} maxLength={2000} disabled={allBusy} placeholder="Contoh: Lanjutkan otomatis hingga selesai" onChange={(event) => setMessageDrafts((old) => ({ ...old, [test.id]: event.target.value }))} />
                  </label>
                  <label className="freebeat-field">
                    Ubah auto_mode
                    <select value={messageAutoModes[test.id] || ''} disabled={allBusy} onChange={(event) => setMessageAutoModes((old) => ({ ...old, [test.id]: event.target.value }))}>
                      <option value="">Biarkan tetap</option>
                      <option value="true">Otomatis (true)</option>
                      <option value="false">Ko-kreasi (false)</option>
                    </select>
                  </label>
                  <button type="button" className="is-secondary" disabled={allBusy || !(messageDrafts[test.id] || '').trim()} onClick={() => sendAgentMessage(test.id)}>Kirim pesan ke agen</button>
                </div>
              )}
              {sessionNotices[test.id] && <p className="freebeat-alert" role="status">{sessionNotices[test.id]}</p>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
