import { useEffect, useRef, useState } from 'react';
import { FreebeatCopyResult } from './FreebeatCopyResult';
import { uploadFreebeatImage, deleteFreebeatImage } from '../lib/freebeatVideoUpload';
import { FREEBEAT_VIDEO_ASPECT_RATIOS, FREEBEAT_VIDEO_MAX_IMAGES } from '../lib/freebeatVideoTestSettings';

const DURATION_PRESETS = [5, 10, 15, 20, 30];
const RESOLUTION_OPTIONS = [
  { value: '', label: 'Otomatis (sesuai model, bawaan 480p)' },
  { value: '480p', label: '480 (480p)' },
  { value: '720p', label: '720 (720p)' },
  { value: '1080p', label: '1080 (1080p)' },
  { value: '768p', label: '768p' },
  { value: '2k', label: '2K' },
  { value: '4k', label: '4K' },
];

function generationTypeLabel(type) {
  if (type === 'image') return 'keyframe (First Frame · image)';
  if (type === 'transition') return 'keyframe (First + Last Frame · transition)';
  if (type === 'reference') return 'omni reference (reference)';
  if (type === 'text') return 'teks ke video (text)';
  return type || 'video';
}

export function FreebeatVideoDiagnostic({ connected, imageAccess, loading, request, userId, storage, videoModels, videoBusy }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(null);
  const [privateHelp, setPrivateHelp] = useState(null);
  const [privateHelpConsent, setPrivateHelpConsent] = useState(false);
  const [quote, setQuote] = useState(null);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [inputMode, setInputMode] = useState('keyframe');
  const [imageSlots, setImageSlots] = useState([{ url: '', uploadedPath: null }]);
  const [duration, setDuration] = useState('5');
  const [resolutionInput, setResolutionInput] = useState('');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [uploadTargetIndex, setUploadTargetIndex] = useState(0);
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [initialConsent, setInitialConsent] = useState(false);
  const [initialDiagnostics, setInitialDiagnostics] = useState(null);
  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const [privateFailure, setPrivateFailure] = useState({});
  const [privacyConsent, setPrivacyConsent] = useState({});
  const visibilityVersion = useRef(0);
  const catalogVersion = useRef(0);
  const uploadCheckVersion = useRef(0);
  const [uploadCheckConsent, setUploadCheckConsent] = useState(false);
  const [freebeatUploadConsent, setFreebeatUploadConsent] = useState(false);
  const [freebeatUploadCheck, setFreebeatUploadCheck] = useState(null);
  const [freebeatUploadResult, setFreebeatUploadResult] = useState(null);

  const activeImages = imageSlots.map((slot) => slot.url.trim()).filter(Boolean);
  const safeTargetIndex = uploadTargetIndex < activeImages.length ? uploadTargetIndex : 0;
  const uploadDiagnosticUrl = activeImages[safeTargetIndex] || '';

  useEffect(() => {
    uploadCheckVersion.current += 1;
    setUploadCheckConsent(false); setFreebeatUploadConsent(false); setFreebeatUploadCheck(null); setFreebeatUploadResult(null);
    return () => { uploadCheckVersion.current += 1; };
  }, [connected, uploadDiagnosticUrl]);

  useEffect(() => {
    if (!connected) {
      setPrivateFailure({}); setPrivacyConsent({}); setTaskResults({});
      setHelp(null); setPrivateHelp(null); setPrivateHelpConsent(false);
      setQuote(null); setModel(''); setApproval(null); setConfirmed(false);
      setInitialConsent(false); setInitialDiagnostics(null);
    }
    return () => { visibilityVersion.current += 1; };
  }, [connected]);

  useEffect(() => {
    catalogVersion.current += 1;
    setHelp(null); setPrivateHelp(null); setPrivateHelpConsent(false);
    setQuote(null); setApproval(null); setConfirmed(false); setInitialConsent(false);
  }, [videoModels, videoBusy]);

  const [testNotice, setTestNotice] = useState('');
  function clearApproval() { setApproval(null); setConfirmed(false); setInitialConsent(false); }
  function updatePrompt(value) { setPrompt(value); setQuote(null); clearApproval(); }
  function updateInputMode(value) { setInputMode(value); setQuote(null); clearApproval(); }
  function updateDuration(value) { setDuration(value); setQuote(null); clearApproval(); }
  function updateResolution(value) { setResolutionInput(value); setQuote(null); clearApproval(); }
  function updateAspectRatio(value) { setAspectRatio(value); setQuote(null); clearApproval(); }

  function parsedDurationValue() {
    const raw = duration.trim();
    if (!raw) return null;
    if (!/^\d+$/.test(raw)) return NaN;
    return Number.parseInt(raw, 10);
  }
  function durationPayload() {
    const parsed = parsedDurationValue();
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 600 ? { duration: parsed } : {};
  }
  function resolutionPayload() {
    const value = resolutionInput.trim().toLowerCase();
    return value ? { resolution: value } : {};
  }
  function updateImageSlotUrl(index, value) {
    setImageSlots((old) => old.map((slot, idx) => (idx === index ? { ...slot, url: value } : slot)));
    setQuote(null);
    clearApproval();
  }
  function addImageSlot() {
    const maxSlots = inputMode === 'omni_reference' ? FREEBEAT_VIDEO_MAX_IMAGES : 2;
    setImageSlots((old) => (old.length < maxSlots ? [...old, { url: '', uploadedPath: null }] : old));
  }

  const [selectedFiles, setSelectedFiles] = useState([]);
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadNotice, setUploadNotice] = useState('');
  const fileInput = useRef(null);

  const uploadedEntries = imageSlots
    .map((slot, index) => (slot.uploadedPath ? { index, path: slot.uploadedPath, url: slot.url } : null))
    .filter(Boolean);
  const remainingImageCapacity = Math.max(0, FREEBEAT_VIDEO_MAX_IMAGES - activeImages.length);

  async function uploadImage() {
    if (busy || uploadBusy || !selectedFiles.length || !publicConfirmed || !userId || !storage) return;
    if (selectedFiles.length > remainingImageCapacity) {
      setUploadError(`Maksimal ${FREEBEAT_VIDEO_MAX_IMAGES} gambar. Tersisa ${remainingImageCapacity} slot gambar.`);
      return;
    }
    setUploadBusy(true); setUploadError(''); setUploadNotice('');
    try {
      const uploadedItems = [];
      let firstError = null;
      for (const file of selectedFiles) {
        try {
          const item = await uploadFreebeatImage(storage, userId, file);
          uploadedItems.push(item);
        } catch (err) {
          firstError = err;
          break;
        }
      }
      if (uploadedItems.length > 0) {
        const missingUrl = uploadedItems.find((item) => !item.url);
        setImageSlots((old) => {
          const next = old.map((slot) => ({ ...slot }));
          for (const item of uploadedItems) {
            if (!item.url) continue;
            const emptyIdx = next.findIndex((slot) => !slot.url.trim());
            if (emptyIdx !== -1) {
              next[emptyIdx] = { url: item.url, uploadedPath: item.path };
            } else if (next.length < FREEBEAT_VIDEO_MAX_IMAGES) {
              next.push({ url: item.url, uploadedPath: item.path });
            }
          }
          return next;
        });
        setQuote(null);
        clearApproval();
        if (!firstError && !missingUrl) {
          setUploadNotice(
            uploadedItems.length === 1
              ? 'Gambar tersimpan dan URL publik terisi di bawah.'
              : `${uploadedItems.length} gambar tersimpan dan URL publik terisi di bawah.`
          );
        } else if (missingUrl && !firstError) {
          setUploadError('Sebagian gambar tersimpan, tetapi URL tidak tersedia. Anda dapat menghapusnya di bawah.');
        }
      }
      setSelectedFiles([]);
      if (fileInput.current) fileInput.current.value = '';
      if (firstError) {
        setUploadError(firstError.message || 'Upload tidak berhasil; periksa Supabase Storage.');
      }
    } finally { setUploadBusy(false); }
  }

  async function removeSlotOrImage(slotIndex, removeSlotBox = false) {
    const target = imageSlots[slotIndex];
    if (!target || busy || uploadBusy) return;
    setUploadError(''); setUploadNotice('');
    if (target.uploadedPath) {
      setUploadBusy(true);
      try {
        await deleteFreebeatImage(storage, target.uploadedPath);
        const remainingUploaded = uploadedEntries.filter((entry) => entry.index !== slotIndex).length;
        if (remainingUploaded === 0) setPublicConfirmed(false);
        setUploadNotice('Gambar dihapus dari Supabase. Salinan atau cache pihak lain mungkin masih ada.');
      } catch (err) {
        setUploadError(err.message || 'Penghapusan gagal; periksa Supabase Storage.');
        setUploadBusy(false);
        return;
      }
      setUploadBusy(false);
    }
    setImageSlots((old) => {
      if (removeSlotBox && old.length > 1) return old.filter((_, idx) => idx !== slotIndex);
      return old.map((slot, idx) => (idx === slotIndex ? { url: '', uploadedPath: null } : slot));
    });
    setQuote(null);
    clearApproval();
    if (fileInput.current) fileInput.current.value = '';
  }

  async function removeAllUploadedImages() {
    if (!uploadedEntries.length || busy || uploadBusy) return;
    setUploadBusy(true); setUploadError(''); setUploadNotice('');
    try {
      for (const entry of uploadedEntries) {
        await deleteFreebeatImage(storage, entry.path);
      }
      const deletedPaths = new Set(uploadedEntries.map((entry) => entry.path));
      setImageSlots((old) => {
        const cleaned = old.map((slot) => (slot.uploadedPath && deletedPaths.has(slot.uploadedPath) ? { url: '', uploadedPath: null } : slot));
        const nonEmpty = cleaned.filter((slot) => slot.url.trim());
        return nonEmpty.length ? nonEmpty : [{ url: '', uploadedPath: null }];
      });
      setSelectedFiles([]);
      setPublicConfirmed(false);
      if (fileInput.current) fileInput.current.value = '';
      setQuote(null);
      clearApproval();
      setUploadNotice('Gambar dihapus dari Supabase. Salinan atau cache pihak lain mungkin masih ada.');
    } catch (err) { setUploadError(err.message || 'Penghapusan gagal; periksa Supabase Storage.'); }
    finally { setUploadBusy(false); }
  }

  async function inspectFreebeatUpload(submit) {
    if (loading || !connected || !imageAccess || busy || uploadBusy || !uploadDiagnosticUrl || (submit ? (!freebeatUploadCheck?.eligible || !freebeatUploadConsent) : !uploadCheckConsent)) return;
    const version = uploadCheckVersion.current;
    setBusy(true); setError(''); setFreebeatUploadResult(null); setFreebeatUploadConsent(false);
    try {
      const result = await request(submit ? 'video-upload-image' : 'video-upload-check', 'POST', { image_url: uploadDiagnosticUrl, acknowledge: true });
      if (version !== uploadCheckVersion.current) return;
      setFreebeatUploadCheck({ eligible: result.eligible === true, reason: result.reason });
      if (submit && result.eligible === true) { setFreebeatUploadResult(result.outcome || 'unknown'); setUploadCheckConsent(false); setFreebeatUploadCheck(null); }
    } catch (err) {
      if (version === uploadCheckVersion.current) {
        setFreebeatUploadCheck(null); setUploadCheckConsent(false);
        if (submit) setFreebeatUploadResult('unknown');
        else setError(err.message || 'Pemeriksaan upload belum tersedia.');
      }
    } finally { setBusy(false); }
  }

  async function copyUrl(urlToCopy) {
    if (!urlToCopy) return;
    try { await navigator.clipboard.writeText(urlToCopy); setUploadNotice('URL disalin.'); }
    catch { setUploadNotice('Tidak dapat menyalin otomatis. Pilih dan salin URL secara manual.'); }
  }

  // Only numeric IDs can be used by Freebeat's video diagnostic API.
  const modelOptions = [];
  const seen = new Set();
  for (const item of videoModels?.models || []) {
    const id = item?.model_id;
    if (!(typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id)))) continue;
    const number = Number(id);
    if (!Number.isSafeInteger(number) || number < 0 || typeof item.name !== 'string' || seen.has(number)) continue;
    seen.add(number);
    modelOptions.push({ id: number, name: item.member_only === true ? `${item.name} · khusus member` : item.name, rawName: item.name, member_only: item.member_only === true });
  }
  const selectedModelItem = modelOptions.find((item) => String(item.id) === model) || null;
  const selected = Boolean(selectedModelItem);
  const isWan3Selected = Boolean(selectedModelItem && (/wan\s*3/i.test(selectedModelItem.rawName) || selectedModelItem.id === 182 || selectedModelItem.id === 184));

  const parsedDur = parsedDurationValue();
  const durationInvalid = parsedDur !== null && (!Number.isSafeInteger(parsedDur) || parsedDur < 1 || parsedDur > 600);
  const imageModeBlocker = inputMode === 'omni_reference'
    ? (activeImages.length < 1
      ? 'Mode Omni Reference membutuhkan minimal 1 gambar (maksimal 3).'
      : activeImages.length > FREEBEAT_VIDEO_MAX_IMAGES
        ? `Maksimal ${FREEBEAT_VIDEO_MAX_IMAGES} gambar untuk mode Omni Reference.`
        : '')
    : (activeImages.length > 2
      ? 'Mode Keyframe maksimal 2 gambar (First & Last Frame). Hapus 1 gambar atau ganti tipe input ke Omni Reference.'
      : '');

  const expectedMcpType = inputMode === 'omni_reference'
    ? 'reference'
    : (activeImages.length === 0 ? 'text' : activeImages.length === 1 ? 'image' : 'transition');

  function buildVideoPayload() {
    const payload = {
      model_id: Number(model),
      prompt,
      input_mode: inputMode,
      images: activeImages,
      ...durationPayload(),
      ...resolutionPayload(),
      aspect_ratio: aspectRatio,
    };
    return payload;
  }

  async function inspect(action) {
    if (loading || !connected || videoBusy || busy || uploadBusy || !selected) return;
    if (action === 'video-model-quote' && (!prompt.trim() || durationInvalid || Boolean(imageModeBlocker))) return;
    const version = catalogVersion.current, connectionVersion = visibilityVersion.current;
    setBusy(true); setError(''); clearApproval();
    if (action === 'video-model-help') setHelp(null); else setQuote(null);
    try {
      const input = action === 'video-model-help' ? { model_id: Number(model) } : buildVideoPayload();
      const result = await request(action, 'POST', input);
      if (version !== catalogVersion.current || connectionVersion !== visibilityVersion.current) return;
      if (action === 'video-model-help') setHelp({ model_id: result.model_id, help: result.help });
      else setQuote({ ...result.settings, ...(result.adjusted?.length ? { adjusted: result.adjusted } : {}), ...(result.supported ? { supported: result.supported } : {}), quote: result.quote });
    } catch (err) { setError(err.message || 'Pemeriksaan video gagal.'); }
    finally { setBusy(false); }
  }
  async function inspectPrivateHelp() {
    if (loading || !connected || videoBusy || busy || uploadBusy || !selected || !privateHelpConsent) return;
    const version = catalogVersion.current, connectionVersion = visibilityVersion.current;
    setBusy(true); setError(''); setPrivateHelp(null); clearApproval();
    try {
      const result = await request('video-model-private-help', 'POST', { model_id: Number(model), acknowledge: true });
      if (version === catalogVersion.current && connectionVersion === visibilityVersion.current && result.model_id === Number(model)) setPrivateHelp(result);
    } catch (err) { setError(err.message || 'Informasi model privat tidak tersedia.'); }
    finally { setBusy(false); }
  }
  async function refreshTests() {
    const result = await request('video-tests');
    setTests(result.tests);
  }
  async function prepare() {
    if (busy || uploadBusy || videoBusy || loading || !connected || !imageAccess || !selected || !prompt.trim() || durationInvalid || Boolean(imageModeBlocker)) return;
    const version = catalogVersion.current, connectionVersion = visibilityVersion.current;
    setBusy(true); setError(''); setTestNotice(''); setInitialDiagnostics(null); clearApproval();
    try {
      const result = await request('video-prepare', 'POST', buildVideoPayload());
      // Settings are now normalized per model by the Worker (resolution,
      // duration, generation type, aspect ratio follow get_model_help), so
      // validate internal consistency and exact prompt + images echo.
      const s = result.settings;
      const returnedImages = Array.isArray(result.images)
        ? result.images
        : (typeof result.image_url === 'string' && result.image_url ? [result.image_url] : []);
      const imagesMatch = returnedImages.length === activeImages.length
        && returnedImages.every((url, index) => url === activeImages[index]);
      if (
        !s
        || s.model_id !== Number(model)
        || typeof s.generation_type !== 'string'
        || !s.generation_type
        || !Number.isSafeInteger(s.duration)
        || s.duration <= 0
        || s.duration > 600
        || typeof s.resolution !== 'string'
        || !s.resolution
        || typeof s.aspect_ratio !== 'string'
        || !/^(?:auto|\d{1,2}:\d{1,2})$/i.test(s.aspect_ratio)
        || result.prompt !== prompt.trim()
        || !imagesMatch
        || typeof result.credits !== 'number'
        || !Number.isFinite(result.credits)
        || result.credits < 0
        || typeof result.approval !== 'string'
      ) throw new Error('Persetujuan tidak cocok dengan input yang dipilih. Tidak ada video dikirim; buat quote baru.');
      await refreshTests();
      if (version === catalogVersion.current && connectionVersion === visibilityVersion.current) setApproval(result);
    }
    catch (err) { setError(err.message || 'Persiapan uji video gagal.'); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!approval || !confirmed || busy || uploadBusy || videoBusy || !connected || !imageAccess || !selected || approval.settings?.model_id !== Number(model)) return;
    const receipt = approval.approval;
    const capture = initialConsent, version = visibilityVersion.current;
    clearApproval(); setBusy(true); setError(''); setTestNotice(''); setInitialDiagnostics(null);
    try {
      const result = await request('video-submit', 'POST', { approval: receipt, confirm: true, ...(capture ? { private_diagnostics: true } : {}) });
      if (capture && version === visibilityVersion.current) setInitialDiagnostics(result.initial_diagnostics || { received: false, messages: [] });
      if (result.status === 'submitted') setTestNotice('Permintaan diterima untuk dipantau, bukan konfirmasi video selesai atau biaya akhir.');
      else setError(`Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan ulangi; periksa Freebeat dan catatan uji.${result.recoveryTaskId ? ` ID tugas untuk pemulihan pribadi: ${result.recoveryTaskId}` : ''}`);
    } catch (err) {
      if (capture && version === visibilityVersion.current) setInitialDiagnostics({ received: false, messages: [] });
      setError(`${err.message || 'Permintaan gagal.'} Jika pengiriman sempat terjadi, hasil dan biaya mungkin tidak pasti. Jangan ulangi sebelum memeriksa catatan.`);
    }
    try { await refreshTests(); } catch { /* warning above still applies */ }
    setBusy(false);
  }
  async function inspectTests() {
    if (busy) return;
    setBusy(true); setError('');
    try { await refreshTests(); } catch (err) { setError(err.message || 'Catatan tidak tersedia.'); }
    finally { setBusy(false); }
  }
  async function poll(id, acknowledge = false) {
    if (busy) return;
    setBusy(true); setError('');
    setPrivateFailure((old) => { const next = { ...old }; delete next[id]; return next; });
    setPrivacyConsent((old) => ({ ...old, [id]: false }));
    try { const result = await request('video-task', 'POST', acknowledge ? { id, acknowledge: true } : { id }); setTaskResults((old) => ({ ...old, [id]: result.task })); }
    catch (err) { setError(err.message || 'Status belum tersedia.'); }
    finally { setBusy(false); }
  }
  async function viewPrivateFailure(id) {
    if (busy || !connected || !privacyConsent[id]) return;
    const version = visibilityVersion.current;
    setBusy(true); setError('');
    try {
      const result = await request('video-private-failure', 'POST', { id, acknowledge: true });
      if (version === visibilityVersion.current) setPrivateFailure((old) => ({ ...old, [id]: result.reasons }));
    } catch (err) { setError(err.message || 'Pesan kegagalan tidak tersedia.'); }
    finally { setBusy(false); }
  }
  function hidePrivateFailure(id) {
    setPrivateFailure((old) => { const next = { ...old }; delete next[id]; return next; });
    setPrivacyConsent((old) => ({ ...old, [id]: false }));
  }

  const blockers = [
    ...(loading ? ['Menunggu pemeriksaan koneksi Freebeat.'] : !connected ? ['Hubungkan Freebeat terlebih dahulu.'] : []),
    ...(videoBusy ? ['Menunggu daftar model video.'] : []),
    ...(busy || uploadBusy ? ['Tunggu pemeriksaan atau upload yang sedang berjalan.'] : []),
    ...(!selected ? ['Pilih model dari daftar Freebeat.'] : []),
    ...(!prompt.trim() ? ['Isi prompt video.'] : []),
    ...(durationInvalid ? ['Isi durasi antara 1 dan 600 detik.'] : []),
    ...(imageModeBlocker ? [imageModeBlocker] : []),
  ];

  const maxSlotsForMode = inputMode === 'omni_reference' ? FREEBEAT_VIDEO_MAX_IMAGES : 2;
  const approvalImages = approval
    ? (Array.isArray(approval.images) ? approval.images : (approval.image_url ? [approval.image_url] : []))
    : [];

  return <div className="freebeat-result">
    <h3>Pemeriksaan video · baca saja</h3>
    <p>Pilih model dari daftar Freebeat (termasuk Wan 3.0). Mendukung mode Keyframe (0–2 gambar: text, First Frame, atau First + Last Frame) dan Omni Reference (1–3 gambar referensi), resolusi 480p / 720p / 1080p, serta durasi s/d 30 detik. Pemeriksaan tidak membuat video atau memakai kredit.</p>
    <label className="freebeat-field">Model video
      <select id="freebeat-video-model" value={selected ? model : ''} disabled={loading || !connected || videoBusy || busy || uploadBusy || !modelOptions.length} onChange={(event) => { setModel(event.target.value); setHelp(null); setPrivateHelp(null); setPrivateHelpConsent(false); setInitialDiagnostics(null); setQuote(null); setError(''); clearApproval(); }}>
        <option value="">{videoBusy ? 'Memuat model…' : 'Pilih model video'}</option>
        {modelOptions.map((item) => <option key={item.id} value={String(item.id)}>{item.name} · ID {item.id}</option>)}
      </select>
    </label>
    {isWan3Selected && <p className="freebeat-note" role="status">Profil Wan 3.0 aktif: gunakan <strong>Keyframe</strong> (0–2 gambar: text / First Frame / First+Last Frame) atau <strong>Omni Reference</strong> (1–3 gambar referensi), resolusi 480p / 720p / 1080p, dan durasi hingga 30 detik.</p>}
    {connected && !videoBusy && !modelOptions.length && <p>Belum ada model ber-ID angka yang dapat dipilih. Muat ulang daftar model di atas.</p>}
    {videoModels?.truncated && <p>Daftar Freebeat dibatasi sampai 100 model; mungkin belum lengkap.</p>}
    {videoModels?.models?.length > modelOptions.length && <p>Hanya model dengan ID angka yang dapat diperiksa; ID lain atau duplikat tidak ditampilkan.</p>}

    <details className="freebeat-upload"><summary>Upload gambar ke Supabase (opsional, maks {FREEBEAT_VIDEO_MAX_IMAGES} gambar)</summary>
    <p>Gambar disimpan di bucket publik: gambar dan URL dapat ditemukan atau dibuka tanpa login. Jangan unggah gambar pribadi atau rahasia. Gambar tetap tersimpan sampai dihapus; link tidak kedaluwarsa otomatis. Penghapusan tidak menjamin salinan atau cache pihak lain ikut terhapus.</p>
    <p>JPG, PNG, atau WebP, maksimal 10 MB per gambar (maksimal {FREEBEAT_VIDEO_MAX_IMAGES} gambar untuk satu uji video). Setelah upload, URL terisi otomatis ke slot gambar. Tombol hapus tersedia selama halaman terbuka; setelah dimuat ulang, hapus melalui dashboard Supabase Storage pada folder akun Anda.</p>
    <label className="freebeat-field">Pilih gambar (1–{FREEBEAT_VIDEO_MAX_IMAGES} file)<input ref={fileInput} type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || uploadBusy || remainingImageCapacity === 0} onChange={(event) => {
      const picked = Array.from(event.target.files || []);
      if (remainingImageCapacity === 0) {
        setSelectedFiles([]);
        if (fileInput.current) fileInput.current.value = '';
        setUploadError(`Slot gambar sudah penuh (maksimal ${FREEBEAT_VIDEO_MAX_IMAGES} gambar).`);
        setUploadNotice('');
        return;
      }
      if (picked.length > remainingImageCapacity) {
        setSelectedFiles(picked.slice(0, remainingImageCapacity));
        setUploadError(`Maksimal ${FREEBEAT_VIDEO_MAX_IMAGES} gambar (${remainingImageCapacity} slot tersisa); hanya ${remainingImageCapacity} file pertama yang dipilih.`);
        setUploadNotice('');
        return;
      }
      setSelectedFiles(picked);
      setUploadError('');
      setUploadNotice('');
    }} /></label>
    {remainingImageCapacity === 0 && <p className="freebeat-note" role="status">Slot gambar sudah penuh ({FREEBEAT_VIDEO_MAX_IMAGES}/{FREEBEAT_VIDEO_MAX_IMAGES}). Hapus salah satu gambar untuk mengunggah lagi.</p>}
    {selectedFiles.length > 0 && <p className="freebeat-note">{selectedFiles.length} file dipilih: {selectedFiles.map((item) => item.name).join(', ')}</p>}
    <label className="freebeat-confirm"><input type="checkbox" checked={publicConfirmed} disabled={busy || uploadBusy || (remainingImageCapacity === 0 && uploadedEntries.length === 0)} onChange={(event) => setPublicConfirmed(event.target.checked)} /> Saya memahami gambar akan disimpan secara publik di Supabase.</label>
    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={busy || uploadBusy || !selectedFiles.length || !publicConfirmed || !userId || remainingImageCapacity === 0} onClick={uploadImage}>{uploadBusy ? 'Memproses…' : 'Upload gambar ke Supabase'}</button>
      {uploadedEntries.length === 1 && <button type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={() => removeSlotOrImage(uploadedEntries[0].index)}>Hapus gambar dari Supabase</button>}
      {uploadedEntries.length > 1 && uploadedEntries.map((entry, idx) => (
        <button key={entry.path} type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={() => removeSlotOrImage(entry.index)}>Hapus gambar #{idx + 1} dari Supabase</button>
      ))}
      {uploadedEntries.length > 1 && <button type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={removeAllUploadedImages}>Hapus semua gambar dari Supabase</button>}
    </div>
    {uploadError && <div className="freebeat-alert is-error" role="alert">{uploadError}</div>}
    {uploadNotice && <p role="status">{uploadNotice}</p>}
    </details>

    <p>Untuk memeriksa quote, gunakan URL hasil upload atau masukkan URL HTTPS lain yang dapat diakses Freebeat (maksimal {FREEBEAT_VIDEO_MAX_IMAGES} gambar). Menekan tombol quote mengirim prompt dan URL tersebut ke Freebeat; jangan gunakan gambar pribadi atau URL bertanda tangan yang tidak ingin Anda bagikan.</p>

    <label className="freebeat-field">Prompt video<input type="text" value={prompt} maxLength={2000} disabled={busy || uploadBusy} onChange={(event) => updatePrompt(event.target.value)} /></label>

    <div className="freebeat-inline">
      <label className="freebeat-field">Tipe input (Wan 3.0 / Studio)
        <select id="freebeat-video-input-mode" value={inputMode} disabled={busy || uploadBusy} onChange={(event) => updateInputMode(event.target.value)}>
          <option value="keyframe">Keyframe (0 = text · 1 = First Frame · 2 = First+Last Frame)</option>
          <option value="omni_reference">Omni Reference (1–3 gambar referensi)</option>
        </select>
      </label>
      <label className="freebeat-field">Resolusi
        <select id="freebeat-video-resolution" value={resolutionInput} disabled={busy || uploadBusy} onChange={(event) => updateResolution(event.target.value)}>
          {RESOLUTION_OPTIONS.map((opt) => <option key={opt.value || 'auto'} value={opt.value}>{opt.label}</option>)}
        </select>
      </label>
      <label className="freebeat-field">Rasio aspek
        <select id="freebeat-video-aspect-ratio" value={aspectRatio} disabled={busy || uploadBusy} onChange={(event) => updateAspectRatio(event.target.value)}>
          {FREEBEAT_VIDEO_ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
        </select>
      </label>
    </div>

    <div className="freebeat-field">
      <label htmlFor="freebeat-video-duration">Durasi detik (s/d 30 detik untuk Wan 3.0; bawaan 5)</label>
      <div className="freebeat-inline">
        <input id="freebeat-video-duration" type="number" min={1} max={600} step={1} value={duration} disabled={busy || uploadBusy} onChange={(event) => updateDuration(event.target.value)} />
        <div className="freebeat-actions" aria-label="Preset durasi cepat">
          {DURATION_PRESETS.map((secs) => (
            <button key={secs} type="button" className={String(secs) === duration.trim() ? 'is-active-preset' : 'is-secondary'} disabled={busy || uploadBusy} onClick={() => updateDuration(String(secs))}>{secs}s</button>
          ))}
        </div>
      </div>
    </div>

    <p className="freebeat-note" data-testid="mcp-generation-preview">
      Pemetaan ke MCP <code>generate_video</code>: <strong>{generationTypeLabel(expectedMcpType)}</strong> · {activeImages.length}/{inputMode === 'omni_reference' ? FREEBEAT_VIDEO_MAX_IMAGES : 2} gambar.
    </p>

    <div className="freebeat-list">
      {imageSlots.map((slot, index) => {
        const slotLabel = inputMode === 'omni_reference'
          ? `URL HTTPS gambar referensi #${index + 1}`
          : (index === 0 ? 'URL HTTPS gambar #1 (First Frame)' : index === 1 ? 'URL HTTPS gambar #2 (Last Frame)' : `URL HTTPS gambar #${index + 1}`);
        return (
          <div key={index} className="freebeat-test-row">
            <label className="freebeat-field">{slotLabel}
              <input
                type="url"
                value={slot.url}
                maxLength={2048}
                disabled={busy || uploadBusy}
                autoComplete="off"
                placeholder="https://..."
                aria-label={slotLabel}
                onChange={(event) => updateImageSlotUrl(index, event.target.value)}
              />
            </label>
            <div className="freebeat-actions">
              <button type="button" className="is-secondary" disabled={!slot.url.trim() || busy || uploadBusy} onClick={() => copyUrl(slot.url.trim())}>
                {imageSlots.length === 1 ? 'Salin URL gambar' : `Salin URL #${index + 1}`}
              </button>
              {(imageSlots.length > 1 || slot.url.trim() || slot.uploadedPath) && (
                <button type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={() => removeSlotOrImage(index, imageSlots.length > 1)}>
                  {slot.uploadedPath ? `Hapus upload #${index + 1}` : imageSlots.length > 1 ? `Hapus slot #${index + 1}` : 'Kosongkan URL'}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {imageSlots.length < maxSlotsForMode && (
        <div className="freebeat-actions">
          <button type="button" className="is-secondary" disabled={busy || uploadBusy} onClick={addImageSlot}>
            + Tambah gambar ({imageSlots.length}/{maxSlotsForMode})
          </button>
        </div>
      )}
    </div>

    <div className="freebeat-actions">
      <button type="button" className="is-secondary" disabled={loading || !connected || videoBusy || busy || uploadBusy || !selected} onClick={() => inspect('video-model-help')}>Periksa informasi model</button>
      <button type="button" className="is-secondary" aria-describedby="video-quote-help" disabled={blockers.length > 0} onClick={() => inspect('video-model-quote')}>Periksa quote</button>
    </div>
    <div id="video-quote-help" className="freebeat-prepare-help" role="status" aria-live="polite">{blockers.length ? <>Untuk memeriksa quote:<ul>{blockers.map((message) => <li key={message}>{message}</li>)}</ul></> : 'Siap memeriksa quote tanpa membuat video atau memakai kredit.'}</div>
    {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
    {help !== null && <FreebeatCopyResult title="Informasi model video yang disaring" value={help} />}
    <details className="freebeat-upload">
      <summary>Informasi model lebih lengkap (privat)</summary>
      <p>Data Freebeat mungkin mengandung informasi pribadi atau rahasia. Penyaringan dilakukan sebisa mungkin tetapi tidak dijamin lengkap. Jangan salin atau bagikan data mentah, URL, token atau kredensial. Pemeriksaan hanya membaca informasi model dan tidak memakai kredit.</p>
      {privateHelp === null ? <>
        <label className="freebeat-confirm"><input type="checkbox" checked={privateHelpConsent} disabled={busy || videoBusy || !connected || !selected} onChange={(event) => setPrivateHelpConsent(event.target.checked)} /> Saya memahami data mungkin sensitif dan hanya akan melihatnya secara pribadi.</label>
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || videoBusy || busy || uploadBusy || !selected || !privateHelpConsent} onClick={inspectPrivateHelp}>Tampilkan informasi model privat</button></div>
      </> : <>
        <div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => { setPrivateHelp(null); setPrivateHelpConsent(false); }}>Sembunyikan informasi privat</button></div>
        {privateHelp.truncated && <p>Hasil mungkin terpotong atau sebagian field disembunyikan demi privasi.</p>}
        <pre aria-label="Informasi model privat">{JSON.stringify(privateHelp.help, null, 2)}</pre>
      </>}
    </details>
    {quote !== null && <FreebeatCopyResult title="Quote video yang disaring" value={quote} description="Hasil tidak memuat prompt atau URL gambar; quote bukan biaya akhir atau persetujuan generasi." />}
    <div className="freebeat-result">
      <h3>Uji generasi video khusus admin</h3>
      <p>Ini memakai kredit akun Freebeat admin, bukan kredit BLEA. Gunakan hanya sesuai ketentuan plan Freebeat. Biaya aktual dan refund tidak dijamin, termasuk jika tugas gagal. Jika hasil pengiriman tidak pasti, jangan ulangi sebelum memeriksa Freebeat dan catatan.</p>
      <p>Menyiapkan quote tidak membuat video. Pengiriman memerlukan konfirmasi terpisah, dengan batas maksimum quote ditambah margin keamanan agar pembulatan harga penyedia tidak menolak item. URL gambar dan prompt dikirim ke Freebeat; isi di URL dapat berubah setelah persetujuan.</p>
      {!imageAccess && <p>Hubungkan Freebeat dan setujui izin generasi terlebih dahulu di atas.</p>}
      {!selected && <p>Pilih model video di atas untuk menyiapkan quote persetujuan.</p>}
      <div className="freebeat-actions">
        <button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || videoBusy || busy || uploadBusy || !selected || !prompt.trim() || durationInvalid || Boolean(imageModeBlocker)} onClick={prepare}>Siapkan quote untuk persetujuan video</button>
        <button type="button" className="is-secondary" disabled={loading || !connected || busy || uploadBusy} onClick={inspectTests}>Periksa catatan uji video</button>
      </div>
      {approval && <div className="freebeat-result">
        <h3>Periksa dan setujui satu video</h3>
        <p>Model {modelOptions.find((item) => item.id === approval.settings.model_id)?.name || 'video'} · ID {approval.settings.model_id} · {generationTypeLabel(approval.settings.generation_type)} · {approval.settings.duration} detik · {approval.settings.resolution} · {approval.settings.aspect_ratio} · quote <strong>{approval.credits} kredit</strong> · batas maksimum <strong>{approval.max_credits ?? approval.credits} kredit Freebeat</strong>. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}; jika quote berubah, pengiriman ditolak.</p>
        {Array.isArray(approval.adjusted) && approval.adjusted.length > 0 && <p className="freebeat-alert" role="status">Setting uji disesuaikan otomatis dengan kemampuan model menurut bantuan model: {approval.adjusted.join(', ')}.</p>}
        <p>Prompt dan {approvalImages.length} URL gambar yang akan dikirim:</p><pre>{approval.prompt}</pre>
        {approvalImages.length > 0
          ? approvalImages.map((url, idx) => <pre key={`${idx}:${url}`}>{url}</pre>)
          : <p>Tanpa gambar (mode teks ke video).</p>}
        <label className="freebeat-confirm"><input type="checkbox" checked={confirmed} disabled={busy || !connected || !imageAccess} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui satu kali generasi video ini dengan batas maksimum {approval.max_credits ?? approval.credits} kredit Freebeat. Biaya aktual dan refund belum dipastikan.</label>
        <label className="freebeat-confirm"><input type="checkbox" checked={initialConsent} disabled={busy || !connected || !imageAccess} onChange={(event) => setInitialConsent(event.target.checked)} /> Opsional: tampilkan pesan respons awal secara privat setelah pengiriman ini. Pesan mungkin mengandung data sensitif; penyamaran tidak dijamin lengkap. Jangan bagikan pesan mentah, URL atau kredensial.</label>
        <div className="freebeat-actions"><button type="button" disabled={!confirmed || busy || uploadBusy || videoBusy || !connected || !imageAccess || !selected || approval.settings?.model_id !== Number(model)} onClick={submit}>Setujui dan kirim satu video</button></div>
      </div>}
      {testNotice && <div className="freebeat-alert" role="status">{testNotice}</div>}
      {initialDiagnostics && <div className="freebeat-result" aria-label="Diagnostik respons awal privat">
        <h3>Pesan respons awal privat</h3>
        <p>Hanya untuk Anda. Jangan bagikan pesan mentah; jelaskan dengan kata sendiri tanpa URL, token atau data pribadi. Pesan ini tidak disimpan dan hilang saat halaman ditutup. Pesan bukan kepastian biaya atau hasil tugas.</p>
        <div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => setInitialDiagnostics(null)}>Sembunyikan respons awal</button></div>
        {!initialDiagnostics.received ? <p>Respons awal tidak tersedia. Hasil pengiriman mungkin tidak pasti; jangan ulangi sebelum memeriksa catatan.</p> : initialDiagnostics.messages?.length ? initialDiagnostics.messages.map((message, index) => <pre key={index}>{message}</pre>) : <p>Tidak ada pesan awal dalam field yang dapat ditampilkan.</p>}
      </div>}
      {tests.length > 0 && <div className="freebeat-result"><h3>Catatan uji video admin</h3>{tests.map((test) => <div key={test.id} className="freebeat-test-row">
        <p>Model {test.model_id} · Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · {test.status}</p>
        {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil tidak pasti; pengiriman video baru diblokir. Jangan ulangi. Periksa aktivitas Freebeat dan minta operator meninjau catatan.</p>}
        {test.status === 'submitted' && !test.canPoll && <p>Uji ini dikirim dari sesi Freebeat yang lebih lama.</p>}
        {test.status === 'submitted' && !test.canPoll && connected && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy} onClick={() => poll(test.id, true)}>Periksa status (sesi lama)</button></div>}
        {test.canPoll && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy} onClick={() => poll(test.id)}>Periksa status video</button></div>}
        {taskResults[test.id] && <div className="freebeat-task-result"><p>Status tugas: {taskResults[test.id].status}. Biaya/refund yang tidak dilaporkan tidak diketahui.</p><pre>{JSON.stringify(taskResults[test.id].billing, null, 2)}</pre>
          {['failed', 'partial_failed', 'action_required'].includes(taskResults[test.id].status) && <>
            <p>Rincian kegagalan di bawah disaring; nilai kosong berarti tidak diketahui atau tidak dilaporkan. Pesan bebas disembunyikan demi privasi. Nilai retryable bukan persetujuan membuat ulang video.</p>
            <FreebeatCopyResult title="Status video dan rincian kegagalan yang disaring" value={{ status: taskResults[test.id].status, billing: taskResults[test.id].billing, failure: taskResults[test.id].failure, item_failures: taskResults[test.id].item_failures }} />
            {(test.canPoll || Boolean(taskResults[test.id])) && connected && <div className="freebeat-result">
              <h3>Pesan kegagalan pribadi</h3>
              <p>Pesan status dan kesalahan batch/item dari Freebeat mungkin berisi prompt, data pribadi atau kredensial. Beberapa pola sensitif disamarkan, tetapi penyaringan tidak dijamin lengkap. Jangan salin atau bagikan pesan mentah; jika perlu bantuan, jelaskan penyebabnya dengan kata-kata sendiri tanpa URL, token atau data pribadi.</p>
              {!Object.hasOwn(privateFailure, test.id) && <>
                <label className="freebeat-confirm"><input type="checkbox" checked={Boolean(privacyConsent[test.id])} disabled={busy} onChange={(event) => setPrivacyConsent((old) => ({ ...old, [test.id]: event.target.checked }))} /> Saya memahami pesan mungkin mengandung informasi sensitif dan hanya akan melihatnya secara pribadi.</label>
                <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy || !privacyConsent[test.id]} onClick={() => viewPrivateFailure(test.id)}>Tampilkan pesan kegagalan pribadi</button></div>
              </>}
              {Object.hasOwn(privateFailure, test.id) && <><div className="freebeat-actions"><button type="button" className="is-secondary" onClick={() => hidePrivateFailure(test.id)}>Sembunyikan pesan pribadi</button></div>
                {privateFailure[test.id].length ? privateFailure[test.id].map((reason, index) => <pre key={index}>{reason}</pre>) : <p>Freebeat tidak memberikan pesan kegagalan berbentuk teks yang dapat ditampilkan.</p>}
              </>}
            </div>}
          </>}
          {taskResults[test.id].videos.length > 0 && <div className="freebeat-result-links">{taskResults[test.id].videos.map((url, index) => <a className="freebeat-result-link" href={url} key={url} target="_blank" rel="noopener noreferrer">Buka hasil video {index + 1}</a>)}</div>}
          {taskResults[test.id].status === 'completed' && taskResults[test.id].videos.length === 0 && <p>Video selesai tetapi tautan belum tersedia. Periksa lagi atau lihat Freebeat; jangan ulangi generasi.</p>}
          {taskResults[test.id].videos.length > 0 && <p>Membuka tautan menghubungkan browser ke host penyedia; jangan bagikan tautan pribadi.</p>}
        </div>}
      </div>)}</div>}
    </div>
    <details className="freebeat-upload"><summary>Periksa pengambilan gambar oleh Freebeat</summary>
      <p>Pemeriksaan mengirim URL gambar terpilih ke Freebeat untuk memeriksa skema dan quote, tanpa upload atau generasi. Gunakan hanya gambar yang boleh dibagikan; jangan gunakan URL bertanda tangan atau rahasia.</p>
      <p>Upload berikutnya hanya tersedia jika Freebeat mengembalikan quote tepat 0 dan skema menyediakan batas kredit; server memeriksa ulang sebelum mengirim batas 0. Quote dan batas bukan jaminan biaya aktual. Jika biaya atau batas tidak tersedia, upload diblokir.</p>
      {activeImages.length > 1 && (
        <label className="freebeat-field">Pilih gambar untuk diperiksa
          <select value={String(safeTargetIndex)} disabled={busy || uploadBusy} onChange={(event) => setUploadTargetIndex(Number(event.target.value))}>
            {activeImages.map((url, idx) => <option key={`${idx}:${url}`} value={String(idx)}>Gambar #{idx + 1}: {url.slice(0, 64)}{url.length > 64 ? '…' : ''}</option>)}
          </select>
        </label>
      )}
      <label className="freebeat-confirm"><input type="checkbox" checked={uploadCheckConsent} disabled={busy || uploadBusy || !connected} onChange={(event) => setUploadCheckConsent(event.target.checked)} /> Saya mengizinkan pengiriman URL ini ke Freebeat untuk pemeriksaan skema dan quote.</label>
      <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || !imageAccess || busy || uploadBusy || !uploadDiagnosticUrl || !uploadCheckConsent} onClick={() => inspectFreebeatUpload(false)}>Periksa biaya dan batas upload Freebeat</button></div>
      {freebeatUploadCheck && (freebeatUploadCheck.eligible ? <>
        <p>Freebeat mengutip 0 kredit dan menyediakan parameter batas. Upload akan meminta batas 0; biaya aktual tidak dijamin. Gambar dapat disalin dan disimpan di Freebeat, dengan retensi dan akses yang diatur Freebeat. Ini tidak membuat video.</p>
        <label className="freebeat-confirm"><input type="checkbox" checked={freebeatUploadConsent} disabled={busy || !connected} onChange={(event) => setFreebeatUploadConsent(event.target.checked)} /> Saya menyetujui satu upload gambar ini ke Freebeat dengan batas 0 kredit.</label>
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy || uploadBusy || !connected || !freebeatUploadConsent} onClick={() => inspectFreebeatUpload(true)}>Uji upload gambar ke Freebeat</button></div>
      </> : <p role="status">{freebeatUploadCheck.reason === 'cap_unavailable' ? 'Skema Freebeat tidak menyediakan batas kredit yang dapat digunakan. Upload diblokir.' : 'Quote nol tidak tersedia. Upload diblokir.'}</p>)}
      {freebeatUploadResult === 'uploaded' && <p role="status">Freebeat melaporkan upload berhasil dan mengembalikan URL gambar. Ini bukan jaminan generasi video akan berhasil; URL tidak disimpan atau dipakai otomatis.</p>}
      {freebeatUploadResult === 'unknown' && <p role="alert">Hasil upload tidak pasti; Freebeat mungkin sudah menyimpan salinan. Jangan ulangi sebelum memeriksa akun Freebeat.</p>}
    </details>
  </div>;
}
