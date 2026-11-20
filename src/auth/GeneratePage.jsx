import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_ASPECT_RATIOS,
  DEFAULT_DURATIONS,
  DEFAULT_RESOLUTIONS,
} from '../lib/videoCatalog';
import {
  fetchVideoHistory,
  fetchVideoModels,
  fetchVideoStatus,
  generateVideo,
} from '../api/generation';
import { availableVideoModels, generationModelKey } from '../lib/generationCatalog';
import { GenerateImagePanel } from './GenerateImagePanel';
import './generate.css';

const PROMPT_CHIPS = [
  {
    label: 'Sinematik Neon',
    text: 'Kamera dolly pelan menyusuri jalanan malam Tokyo saat hujan rintik, pantulan neon merah dan biru di aspal basah, pencahayaan sinematik 35mm.',
  },
  {
    label: 'Produk 3D',
    text: 'Showcase produk headphone nirkabel melayang dengan rotasi halus di studio gelap beraksen cahaya merah lembut, tekstur matte realistis.',
  },
  {
    label: 'Alam Drone',
    text: 'Tangkapan drone udara melintasi pegunungan berkabut saat matahari terbit keemasan, air terjun mengalir di lembah hijau tropis.',
  },
  {
    label: 'Animasi Karakter',
    text: 'Robot kecil ramah berjalan di taman kota futuristik dengan animasi halus bergaya Pixar, ekspresi ceria dan cahaya sore hangat.',
  },
];

const STATUS_LABELS = {
  queued: 'Dalam Antrean',
  in_progress: 'Sedang Diproses',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  expired: 'Kedaluwarsa',
};

const MAX_BYTES = {
  // Batas resmi Wan 3.0 (Alibaba Model Studio): gambar ≤20MB, video ≤100MB,
  // audio ≤15MB. Dipakai sebagai batas atas untuk semua provider video.
  image: 20 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 15 * 1024 * 1024,
};

const MAX_REFERENCES = { image: 10, video: 5, audio: 5 };
const MAX_TOTAL_REFERENCES = 20;

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const modelKey = generationModelKey;

export function GeneratePage() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [searchParams] = useSearchParams();

  const [mode, setMode] = useState(() => searchParams.get('mode') === 'image' ? 'image' : 'video');
  const [models, setModels] = useState([]);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [workerMode, setWorkerMode] = useState('checking'); // 'ready' | 'unavailable' | 'checking'

  const [prompt, setPrompt] = useState(() => searchParams.get('prompt') || '');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('720p');
  const [duration, setDuration] = useState(5);
  const [generateAudio, setGenerateAudio] = useState(true);

  const [imageMedia, setImageMedia] = useState(null); // { url, name, size, localPreview } — first frame
  const [imageLastMedia, setImageLastMedia] = useState(null); // last frame (Wan 3.0)
  const [videoMedia, setVideoMedia] = useState(null);
  const [audioMedia, setAudioMedia] = useState(null);
  // Wan 3.0 multi-referensi (mode referensi): maks 10 foto, 5 video, 5 audio.
  const [refImages, setRefImages] = useState([]);
  const [refVideos, setRefVideos] = useState([]);
  const [refAudios, setRefAudios] = useState([]);
  const [mediaMode, setMediaMode] = useState('frame'); // 'frame' | 'reference' (khusus provider alibaba)
  const [uploadingSlot, setUploadingSlot] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState(null); // { type: 'error' | 'warn' | 'success', text }

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [activeId, setActiveId] = useState(() => searchParams.get('id') || '');
  const [historyFilter, setHistoryFilter] = useState('all');

  const imageInputRef = useRef(null);
  const imageLastInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const audioInputRef = useRef(null);
  const refImageInputRef = useRef(null);
  const refVideoInputRef = useRef(null);
  const refAudioInputRef = useRef(null);

  const selectedModel = useMemo(() => {
    return models.find((m) => modelKey(m) === selectedModelKey) || models[0] || null;
  }, [models, selectedModelKey]);
  const isAlibaba = selectedModel?.provider === 'alibaba';
  const referenceTotal = refImages.length + refVideos.length + refAudios.length;

  const ratioOptions = useMemo(
    () => (selectedModel?.aspectRatios?.length ? selectedModel.aspectRatios : DEFAULT_ASPECT_RATIOS),
    [selectedModel],
  );
  const resolutionOptions = useMemo(
    () => (selectedModel?.resolutions?.length ? selectedModel.resolutions : DEFAULT_RESOLUTIONS),
    [selectedModel],
  );
  const durationOptions = useMemo(
    () => (selectedModel?.durations?.length ? selectedModel.durations : DEFAULT_DURATIONS),
    [selectedModel],
  );

  // Snap parameters when switching to a model with narrower constraints
  useEffect(() => {
    if (!selectedModel) return;
    if (!ratioOptions.includes(aspectRatio)) setAspectRatio(ratioOptions[0]);
    if (!resolutionOptions.includes(resolution)) setResolution(resolutionOptions.includes('720p') ? '720p' : resolutionOptions[0]);
    if (!durationOptions.includes(Number(duration))) setDuration(durationOptions.includes(5) ? 5 : durationOptions[0]);
    if (!selectedModel.supportsAudio && generateAudio) setGenerateAudio(false);
  }, [selectedModel, ratioOptions, resolutionOptions, durationOptions]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadModelsAndHistory = useCallback(async () => {
    if (!user?.id) return;
    setLoadingHistory(true);
    try {
      const [modelsRes, historyRes] = await Promise.all([
        fetchVideoModels(),
        fetchVideoHistory(),
      ]);

      if (modelsRes.ok && Array.isArray(modelsRes.data?.models)) {
        const available = availableVideoModels(modelsRes.data.models);
        setWorkerMode('ready');
        setModels(available);
        setSelectedModelKey((prev) => available.some((m) => modelKey(m) === prev) ? prev : (available[0] ? modelKey(available[0]) : ''));
      } else {
        setWorkerMode('unavailable');
        setModels([]);
        setSelectedModelKey('');
      }

      if (historyRes.ok && Array.isArray(historyRes.data?.generations)) {
        const list = historyRes.data.generations;
        setHistory(list);
        setActiveId((prev) => prev || list[0]?.id || '');
      } else {
        // Direct Supabase fallback for local dev preview
        const { data: rows } = await supabase
          .from('video_generations')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(40);
        const list = rows || [];
        setHistory(list);
        setActiveId((prev) => prev || list[0]?.id || '');
      }
    } finally {
      setLoadingHistory(false);
    }
  }, [user?.id]);

  useEffect(() => {
    loadModelsAndHistory();
  }, [loadModelsAndHistory]);

  // Auto-poll any active queued / in_progress video generations
  useEffect(() => {
    if (workerMode !== 'ready') return undefined;
    const pending = history.filter((g) => g.status === 'queued' || g.status === 'in_progress');
    if (!pending.length) return undefined;

    const timer = setInterval(async () => {
      const updates = await Promise.all(
        pending.slice(0, 4).map(async (item) => {
          const res = await fetchVideoStatus(item.id);
          return res.ok && res.data?.generation ? res.data.generation : null;
        }),
      );
      const byId = new Map(updates.filter(Boolean).map((u) => [u.id, u]));
      if (byId.size) {
        setHistory((prev) => prev.map((row) => byId.get(row.id) || row));
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [history, workerMode]);

  const handleUploadMedia = async (slot, file) => {
    if (!file || !user?.id) return;
    const byteLimit = slot === 'image_last' ? MAX_BYTES.image : MAX_BYTES[slot];
    if (file.size > byteLimit) {
      setBanner({
        type: 'error',
        text: `Ukuran file ${slot === 'image_last' ? 'gambar' : slot} melebihi batas maksimum (${formatBytes(byteLimit)}).`,
      });
      return;
    }

    setBanner(null);
    setUploadingSlot(slot);
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${user.id}/video-inputs/${slot}-${Date.now()}-${safeName}`;
      const { data, error } = await supabase.storage
        .from('ai-studio-uploads')
        .upload(path, file, {
          contentType: file.type || undefined,
          upsert: false,
        });
      if (error) {
        setBanner({ type: 'error', text: `Gagal mengunggah ${slot}: ${error.message}` });
        return;
      }
      const { data: pub } = supabase.storage.from('ai-studio-uploads').getPublicUrl(data.path);
      const localPreview = URL.createObjectURL(file);
      const mediaObj = {
        url: pub.publicUrl,
        name: file.name,
        size: file.size,
        localPreview,
      };
      if (slot === 'image') setImageMedia(mediaObj);
      if (slot === 'image_last') setImageLastMedia(mediaObj);
      if (slot === 'video') setVideoMedia(mediaObj);
      if (slot === 'audio') setAudioMedia(mediaObj);
    } finally {
      setUploadingSlot('');
    }
  };

  const handleUploadReference = async (kind, files) => {
    const list = Array.from(files || []);
    if (!list.length || !user?.id) return;
    const max = MAX_REFERENCES[kind];
    const current = kind === 'image' ? refImages : kind === 'video' ? refVideos : refAudios;
    const setList = kind === 'image' ? setRefImages : kind === 'video' ? setRefVideos : setRefAudios;
    if (current.length + list.length > max) {
      setBanner({ type: 'error', text: `Wan 3.0: maksimal ${max} ${kind === 'image' ? 'foto' : kind === 'video' ? 'video' : 'audio'} referensi per permintaan.` });
      return;
    }
    if (referenceTotal + list.length > MAX_TOTAL_REFERENCES) {
      setBanner({ type: 'error', text: `Wan 3.0: maksimal ${MAX_TOTAL_REFERENCES} materi referensi (foto+video+audio) per permintaan.` });
      return;
    }
    for (const file of list) {
      if (file.size > MAX_BYTES[kind]) {
        setBanner({ type: 'error', text: `Ukuran file "${file.name}" melebihi batas maksimum (${formatBytes(MAX_BYTES[kind])}).` });
        return;
      }
    }

    setBanner(null);
    setUploadingSlot(`ref-${kind}`);
    try {
      for (const file of list) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const path = `${user.id}/video-refs/${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
        const { data, error } = await supabase.storage
          .from('ai-studio-uploads')
          .upload(path, file, { contentType: file.type || undefined, upsert: false });
        if (error) {
          setBanner({ type: 'error', text: `Gagal mengunggah ${kind}: ${error.message}` });
          break;
        }
        const { data: pub } = supabase.storage.from('ai-studio-uploads').getPublicUrl(data.path);
        setList((prev) => [...prev, { url: pub.publicUrl, name: file.name, size: file.size, localPreview: URL.createObjectURL(file) }]);
      }
    } finally {
      setUploadingSlot('');
    }
  };

  const clearReference = (kind, index) => {
    const setList = kind === 'image' ? setRefImages : kind === 'video' ? setRefVideos : setRefAudios;
    setList((prev) => {
      const target = prev[index];
      if (target?.localPreview?.startsWith('blob:')) URL.revokeObjectURL(target.localPreview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearMedia = (slot) => {
    if (slot === 'image') {
      if (imageMedia?.localPreview?.startsWith('blob:')) URL.revokeObjectURL(imageMedia.localPreview);
      setImageMedia(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
    }
    if (slot === 'image_last') {
      if (imageLastMedia?.localPreview?.startsWith('blob:')) URL.revokeObjectURL(imageLastMedia.localPreview);
      setImageLastMedia(null);
      if (imageLastInputRef.current) imageLastInputRef.current.value = '';
    }
    if (slot === 'video') {
      if (videoMedia?.localPreview?.startsWith('blob:')) URL.revokeObjectURL(videoMedia.localPreview);
      setVideoMedia(null);
      if (videoInputRef.current) videoInputRef.current.value = '';
    }
    if (slot === 'audio') {
      if (audioMedia?.localPreview?.startsWith('blob:')) URL.revokeObjectURL(audioMedia.localPreview);
      setAudioMedia(null);
      if (audioInputRef.current) audioInputRef.current.value = '';
    }
  };

  const handleGenerate = async (e) => {
    e.preventDefault();
    if (submitting || uploadingSlot) return;
    if (!selectedModel || !availableVideoModels([selectedModel]).length) {
      setBanner({ type: 'error', text: 'Belum ada model video aktif dari provider yang dikonfigurasi.' });
      return;
    }

    const cleanPrompt = prompt.trim();
    const alibabaFrame = isAlibaba && mediaMode === 'frame';
    const alibabaReference = isAlibaba && mediaMode === 'reference';
    const frameEmpty = !imageMedia?.url && !imageLastMedia?.url;
    const referenceEmpty = referenceTotal === 0;
    if (isAlibaba && mediaMode === 'frame' && imageLastMedia?.url && !imageMedia?.url) {
      setBanner({ type: 'error', text: 'Last Frame membutuhkan First Frame. Unggah gambar pertama dulu.' });
      return;
    }
    const hasMedia = alibabaFrame ? !frameEmpty : alibabaReference ? !referenceEmpty : Boolean(imageMedia?.url || videoMedia?.url || audioMedia?.url);
    if (!cleanPrompt && !hasMedia) {
      setBanner({
        type: 'error',
        text: 'Masukkan prompt atau unggah minimal satu referensi media (gambar, video, atau audio).',
      });
      return;
    }

    if (workerMode === 'unavailable') {
      setBanner({
        type: 'warn',
        text: 'Endpoint /api/video/generate hanya berjalan saat aplikasi di-deploy ke Cloudflare Worker. Konfigurasi tampilan & Supabase tetap aktif di pratinjau lokal ini.',
      });
      return;
    }

    setBanner(null);
    setSubmitting(true);
    try {
      const referencePayload = alibabaReference
        ? {
            image_url: '',
            video_url: '',
            audio_url: '',
            reference_images: refImages.map((m) => m.url),
            reference_videos: refVideos.map((m) => m.url),
            reference_audios: refAudios.map((m) => m.url),
          }
        : alibabaFrame
          ? {
              image_url: imageMedia?.url || '',
              image_last_url: imageLastMedia?.url || '',
              video_url: '',
              audio_url: '',
            }
          : {
              image_url: imageMedia?.url || '',
              video_url: videoMedia?.url || '',
              audio_url: audioMedia?.url || '',
            };
      const res = await generateVideo({
        provider: selectedModel.provider,
        model: selectedModel.id,
        prompt: cleanPrompt,
        aspect_ratio: aspectRatio,
        resolution,
        duration: Number(duration),
        generate_audio: generateAudio,
        ...referencePayload,
      });

      if (!res.ok || !res.data?.generation) {
        setBanner({
          type: 'error',
          text: res.data?.error || 'Gagal memulai generasi video. Periksa konfigurasi API key dan model di Admin Panel.',
        });
        return;
      }

      const created = res.data.generation;
      setHistory((prev) => [created, ...prev.filter((g) => g.id !== created.id)]);
      setActiveId(created.id);
      setBanner({
        type: 'success',
        text: created.status === 'completed'
          ? 'Video berhasil dibuat dan siap diputar.'
          : `Generasi dimulai menggunakan ${selectedModel.name}. Status akan diperbarui otomatis.`,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleReuseSettings = (item) => {
    if (!item) return;
    const match = models.find((m) => m.id === item.model && (!item.provider || m.provider === item.provider))
      || models.find((m) => m.id === item.model);
    if (match) setSelectedModelKey(modelKey(match));
    if (item.prompt) setPrompt(item.prompt);
    if (item.aspect_ratio) setAspectRatio(item.aspect_ratio);
    if (item.resolution) {
      const targetRes = (match?.resolutions || resolutionOptions).find(
        (r) => r.toLowerCase() === String(item.resolution).toLowerCase(),
      ) || item.resolution;
      setResolution(targetRes);
    }
    if (item.duration) setDuration(Number(item.duration));
    setGenerateAudio(item.generate_audio !== false);
    if (item.image_url) setImageMedia({ url: item.image_url, name: 'First Frame', size: 0, localPreview: item.image_url });
    if (item.image_last_url || item.metadata?.image_last_url) setImageLastMedia({ url: item.image_last_url || item.metadata.image_last_url, name: 'Last Frame', size: 0, localPreview: item.image_last_url || item.metadata.image_last_url });
    if (item.video_url) setVideoMedia({ url: item.video_url, name: 'Referensi Video', size: 0, localPreview: item.video_url });
    if (item.audio_url) setAudioMedia({ url: item.audio_url, name: 'Referensi Audio', size: 0, localPreview: item.audio_url });
    const meta = item.metadata || {};
    if (Array.isArray(meta.reference_images) && meta.reference_images.length) {
      setMediaMode('reference');
      setRefImages(meta.reference_images.map((url, i) => ({ url, name: `Referensi Gambar ${i + 1}`, size: 0, localPreview: url })));
    }
    if (Array.isArray(meta.reference_videos) && meta.reference_videos.length) {
      setMediaMode('reference');
      setRefVideos((prev) => [...prev, ...meta.reference_videos.map((url, i) => ({ url, name: `Referensi Video ${i + 1}`, size: 0, localPreview: url }))]);
    }
    if (Array.isArray(meta.reference_audios) && meta.reference_audios.length) {
      setMediaMode('reference');
      setRefAudios((prev) => [...prev, ...meta.reference_audios.map((url, i) => ({ url, name: `Referensi Audio ${i + 1}`, size: 0, localPreview: url }))]);
    }
  };

  const handleDeleteHistory = async (id, e) => {
    e.stopPropagation();
    const { error } = await supabase.from('video_generations').delete().eq('id', id);
    if (error) {
      setBanner({ type: 'error', text: `Gagal menghapus riwayat video: ${error.message}` });
      return;
    }
    setHistory((prev) => {
      const next = prev.filter((item) => item.id !== id);
      if (activeId === id) setActiveId(next[0]?.id || '');
      return next;
    });
  };

  const activeGeneration = useMemo(
    () => history.find((item) => item.id === activeId) || history[0] || null,
    [history, activeId],
  );

  const filteredHistory = useMemo(() => {
    if (historyFilter === 'all') return history;
    if (historyFilter === 'processing') return history.filter((g) => g.status === 'queued' || g.status === 'in_progress');
    return history.filter((g) => g.status === historyFilter);
  }, [history, historyFilter]);

  return (
    <DropXLayout
      title="Generate"
      description="Studio gambar dan video AI dengan provider yang dapat dikonfigurasi."
    >
      <div className="generate-page">
        <div className="generate-mode-tabs" role="tablist" aria-label="Jenis generasi">
          <button type="button" role="tab" aria-selected={mode === 'image'} onClick={() => setMode('image')}>Generate gambar</button>
          <button type="button" role="tab" aria-selected={mode === 'video'} onClick={() => setMode('video')}>Generate video</button>
        </div>
        {mode === 'image' ? <GenerateImagePanel initialPrompt={searchParams.get('prompt') || ''} /> : <>
        {workerMode === 'unavailable' && (
          <div className="generate-banner" role="status">
            <span>
              Katalog provider video belum dapat dimuat. Coba lagi saat API tersedia; riwayat yang sudah ada tetap dapat dilihat.
            </span>
          </div>
        )}

        {workerMode === 'ready' && models.length === 0 && (
          <div className="generate-banner" role="status">
            <span>Belum ada model video aktif dari provider yang dikonfigurasi. Freebeat video masih dalam tahap uji dan belum tersedia di sini.</span>
            {isAdmin && <Link className="generate-banner-link" to="/admin">Atur provider &amp; model</Link>}
          </div>
        )}

        {selectedModel && <div className="generate-banner" role="status"><span>Generasi video melalui provider yang dikonfigurasi dapat memakai saldo provider. Alur video lama belum memotong kredit BLEA atau memverifikasi biaya aktual.</span></div>}

        {banner && (
          <div
            className={`generate-banner ${banner.type === 'error' ? 'is-error' : banner.type === 'success' ? 'is-success' : ''}`}
            role="status"
          >
            <span>{banner.text}</span>
            <button type="button" className="generate-banner-link" onClick={() => setBanner(null)}>
              Tutup
            </button>
          </div>
        )}

        <div className="generate-grid">
          {/* LEFT: Video Generator Form */}
          <form className="generate-card" onSubmit={handleGenerate}>
            <div className="generate-card-head">
              <div>
                <h2 className="generate-card-title">Komposer Generate Video</h2>
                <p className="generate-card-sub">
                  Pilih model, unggah referensi media opsional, atur rasio, resolusi, dan durasi.
                </p>
              </div>
              {selectedModel && <span className="generate-pill">Biaya sesuai provider</span>}
            </div>

            {/* 1. Pilih Model */}
            <div className="generate-field">
              <div className="generate-label-row">
                <label className="generate-label" htmlFor="gen-model">Pilih Model</label>
                <span className="generate-hint">{models.length} model tersedia</span>
              </div>
              <select
                id="gen-model"
                aria-label="Pilih Model"
                className="generate-select"
                value={selectedModelKey}
                disabled={!models.length}
                onChange={(e) => setSelectedModelKey(e.target.value)}
              >
                {!models.length && <option value="">Tidak ada model video aktif</option>}
                {models.map((m) => (
                  <option key={modelKey(m)} value={modelKey(m)}>
                    {`[${m.providerLabel || m.provider}] ${m.name}${m.online === false ? ' • Sibuk' : ''}`}
                  </option>
                ))}
              </select>

              {selectedModel && (
                <div className="generate-model-meta">
                  <span className="generate-pill is-accent">{selectedModel.providerLabel || selectedModel.provider}</span>
                  {selectedModel.supportsImage && <span className="generate-pill">Image-to-Video</span>}
                  {selectedModel.supportsVideo && <span className="generate-pill">Video-to-Video</span>}
                  {selectedModel.supportsAudio && <span className="generate-pill">Audio Native / Ref</span>}
                  {selectedModel.online === false && <span className="generate-pill is-warn">Antrean Sedang Penuh</span>}
                  {selectedModel.description && <span className="generate-hint">{selectedModel.description}</span>}
                </div>
              )}
            </div>

            {/* 2. Media referensi */}
            <div className="generate-field">
              <div className="generate-label-row">
                <span className="generate-label">Media Referensi (Opsional)</span>
                <span className="generate-hint">Gambar ≤20MB · Video ≤100MB · Audio ≤15MB</span>
              </div>
              <p className="generate-hint">File referensi diunggah ke penyimpanan publik dan dapat diakses melalui tautan; unggah hanya materi yang boleh dibagikan dengan provider.</p>

              {isAlibaba && (
                <div className="generate-mode-tabs" role="tablist" aria-label="Mode Wan 3.0" style={{ marginBottom: 12 }}>
                  <button type="button" role="tab" aria-selected={mediaMode === 'frame'} onClick={() => setMediaMode('frame')}>
                    Mode Frame (First / Last Frame)
                  </button>
                  <button type="button" role="tab" aria-selected={mediaMode === 'reference'} onClick={() => setMediaMode('reference')}>
                    Mode Referensi (maks 10 foto · 5 video · 5 audio)
                  </button>
                </div>
              )}

              {(!isAlibaba || mediaMode === 'frame') && (
                <p className="generate-hint" style={{ marginTop: 0 }}>
                  {isAlibaba
                    ? 'Wan 3.0 mode frame: 1 gambar First Frame (wajib bila diisi Last Frame) + 1 Last Frame. Mode frame tidak bisa digabung dengan foto/video/audio referensi.'
                    : 'Unggah First Frame (dan Last Frame untuk Wan 3.0) sebagai acuan visual video.'}
                </p>
              )}

              <div className="generate-media-grid">
                {/* First Frame / Upload Image */}
                {(!isAlibaba || mediaMode === 'frame') && (
                <div className={`generate-upload-box ${imageMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">{isAlibaba ? 'First Frame' : 'Upload Image'}</span>
                    {imageMedia && (
                      <button type="button" className="generate-clear-btn" onClick={() => clearMedia('image')}>
                        Hapus
                      </button>
                    )}
                  </div>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/bmp"
                    aria-label="First Frame"
                    className="generate-upload-input"
                    onChange={(e) => handleUploadMedia('image', e.target.files?.[0])}
                  />
                  {imageMedia ? (
                    <img
                      src={imageMedia.localPreview || imageMedia.url}
                      alt={imageMedia.name}
                      className="generate-preview-thumb"
                    />
                  ) : (
                    <button
                      type="button"
                      className="generate-upload-trigger"
                      disabled={!selectedModel || Boolean(uploadingSlot)}
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'image' ? 'Mengunggah...' : '+ Pilih Gambar'}</strong>
                      <span>JPG, PNG, WEBP · maks 20MB</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={imageMedia?.name}>
                      {imageMedia ? imageMedia.name : 'Frame awal / subjek'}
                    </span>
                    {imageMedia?.size ? <span>{formatBytes(imageMedia.size)}</span> : null}
                  </div>
                </div>
                )}

                {/* Last Frame (khusus Wan 3.0 mode frame) */}
                {isAlibaba && mediaMode === 'frame' && (
                <div className={`generate-upload-box ${imageLastMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">Last Frame (Opsional)</span>
                    {imageLastMedia && (
                      <button type="button" className="generate-clear-btn" onClick={() => clearMedia('image_last')}>
                        Hapus
                      </button>
                    )}
                  </div>
                  <input
                    ref={imageLastInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/bmp"
                    aria-label="Last Frame"
                    className="generate-upload-input"
                    onChange={(e) => handleUploadMedia('image_last', e.target.files?.[0])}
                  />
                  {imageLastMedia ? (
                    <img
                      src={imageLastMedia.localPreview || imageLastMedia.url}
                      alt={imageLastMedia.name}
                      className="generate-preview-thumb"
                    />
                  ) : (
                    <button
                      type="button"
                      className="generate-upload-trigger"
                      disabled={!selectedModel || Boolean(uploadingSlot) || !imageMedia}
                      onClick={() => imageLastInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'image_last' ? 'Mengunggah...' : '+ Pilih Last Frame'}</strong>
                      <span>Butuh First Frame · maks 20MB</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={imageLastMedia?.name}>
                      {imageLastMedia ? imageLastMedia.name : 'Frame akhir video'}
                    </span>
                    {imageLastMedia?.size ? <span>{formatBytes(imageLastMedia.size)}</span> : null}
                  </div>
                </div>
                )}

                {/* Upload Video — mode referensi alibaba / mode standar non-alibaba */}
                {!isAlibaba && (
                <div className={`generate-upload-box ${videoMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">Upload Video</span>
                    {videoMedia && (
                      <button type="button" className="generate-clear-btn" onClick={() => clearMedia('video')}>
                        Hapus
                      </button>
                    )}
                  </div>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    aria-label="Upload Video"
                    className="generate-upload-input"
                    onChange={(e) => handleUploadMedia('video', e.target.files?.[0])}
                  />
                  {videoMedia ? (
                    <video
                      src={videoMedia.localPreview || videoMedia.url}
                      className="generate-preview-thumb"
                      controls
                      muted
                      playsInline
                    />
                  ) : (
                    <button
                      type="button"
                      className="generate-upload-trigger"
                      disabled={!selectedModel || Boolean(uploadingSlot)}
                      onClick={() => videoInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'video' ? 'Mengunggah...' : '+ Pilih Video'}</strong>
                      <span>MP4, WEBM, MOV · maks 100MB</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={videoMedia?.name}>
                      {videoMedia ? videoMedia.name : 'Referensi gerak / edit'}
                    </span>
                    {videoMedia?.size ? <span>{formatBytes(videoMedia.size)}</span> : null}
                  </div>
                </div>
                )}

                {/* Upload Audio — mode standar non-alibaba */}
                {!isAlibaba && (
                <div className={`generate-upload-box ${audioMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">Upload Audio</span>
                    {audioMedia && (
                      <button type="button" className="generate-clear-btn" onClick={() => clearMedia('audio')}>
                        Hapus
                      </button>
                    )}
                  </div>
                  <input
                    ref={audioInputRef}
                    type="file"
                    accept="audio/mpeg,audio/wav,audio/ogg,audio/mp4,audio/aac"
                    aria-label="Upload Audio"
                    className="generate-upload-input"
                    onChange={(e) => handleUploadMedia('audio', e.target.files?.[0])}
                  />
                  {audioMedia ? (
                    <audio
                      controls
                      src={audioMedia.localPreview || audioMedia.url}
                      className="generate-preview-audio"
                    />
                  ) : (
                    <button
                      type="button"
                      className="generate-upload-trigger"
                      disabled={!selectedModel || Boolean(uploadingSlot)}
                      onClick={() => audioInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'audio' ? 'Mengunggah...' : '+ Pilih Audio'}</strong>
                      <span>MP3, WAV, M4A · maks 15MB</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={audioMedia?.name}>
                      {audioMedia ? audioMedia.name : 'Musik / suara / lip-sync'}
                    </span>
                    {audioMedia?.size ? <span>{formatBytes(audioMedia.size)}</span> : null}
                  </div>
                </div>
                )}
              </div>

              {/* Mode referensi Wan 3.0: multi-upload */}
              {isAlibaba && mediaMode === 'reference' && (
                <div className="generate-ref-sections">
                  <p className="generate-hint" style={{ marginTop: 4 }}>
                    Mode referensi: {referenceTotal}/{MAX_TOTAL_REFERENCES} materi · {refImages.length}/{MAX_REFERENCES.image} foto · {refVideos.length}/{MAX_REFERENCES.video} video · {refAudios.length}/{MAX_REFERENCES.audio} audio. Video & audio maks 15 detik total.
                  </p>

                  <div className="generate-ref-row">
                    <div className="generate-ref-row-head">
                      <span className="generate-upload-title">Foto Referensi ({refImages.length}/{MAX_REFERENCES.image})</span>
                      <input ref={refImageInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp" aria-label="Foto Referensi" className="generate-upload-input" onChange={(e) => { handleUploadReference('image', e.target.files); e.target.value = ''; }} />
                      <button type="button" className="generate-clear-btn" disabled={!selectedModel || Boolean(uploadingSlot) || refImages.length >= MAX_REFERENCES.image} onClick={() => refImageInputRef.current?.click()}>
                        {uploadingSlot === 'ref-image' ? 'Mengunggah...' : '+ Tambah'}
                      </button>
                    </div>
                    {refImages.length > 0 && (
                      <div className="generate-ref-chips">
                        {refImages.map((item, index) => (
                          <span key={index} className="generate-ref-chip" title={item.name}>
                            <img src={item.localPreview} alt={item.name} className="generate-ref-chip-img" />
                            <span className="generate-ref-chip-name">{item.name}</span>
                            <button type="button" aria-label={`Hapus ${item.name}`} onClick={() => clearReference('image', index)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="generate-ref-row">
                    <div className="generate-ref-row-head">
                      <span className="generate-upload-title">Video Referensi ({refVideos.length}/{MAX_REFERENCES.video})</span>
                      <input ref={refVideoInputRef} type="file" multiple accept="video/mp4,video/quicktime,video/webm" aria-label="Video Referensi" className="generate-upload-input" onChange={(e) => { handleUploadReference('video', e.target.files); e.target.value = ''; }} />
                      <button type="button" className="generate-clear-btn" disabled={!selectedModel || Boolean(uploadingSlot) || refVideos.length >= MAX_REFERENCES.video} onClick={() => refVideoInputRef.current?.click()}>
                        {uploadingSlot === 'ref-video' ? 'Mengunggah...' : '+ Tambah'}
                      </button>
                    </div>
                    {refVideos.length > 0 && (
                      <div className="generate-ref-chips">
                        {refVideos.map((item, index) => (
                          <span key={index} className="generate-ref-chip" title={item.name}>
                            <span className="generate-ref-chip-name">{item.name}</span>
                            <button type="button" aria-label={`Hapus ${item.name}`} onClick={() => clearReference('video', index)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="generate-ref-row">
                    <div className="generate-ref-row-head">
                      <span className="generate-upload-title">Audio Referensi ({refAudios.length}/{MAX_REFERENCES.audio})</span>
                      <input ref={refAudioInputRef} type="file" multiple accept="audio/wav,audio/mpeg,audio/mp3" aria-label="Audio Referensi" className="generate-upload-input" onChange={(e) => { handleUploadReference('audio', e.target.files); e.target.value = ''; }} />
                      <button type="button" className="generate-clear-btn" disabled={!selectedModel || Boolean(uploadingSlot) || refAudios.length >= MAX_REFERENCES.audio} onClick={() => refAudioInputRef.current?.click()}>
                        {uploadingSlot === 'ref-audio' ? 'Mengunggah...' : '+ Tambah'}
                      </button>
                    </div>
                    {refAudios.length > 0 && (
                      <div className="generate-ref-chips">
                        {refAudios.map((item, index) => (
                          <span key={index} className="generate-ref-chip" title={item.name}>
                            <span className="generate-ref-chip-name">{item.name}</span>
                            <button type="button" aria-label={`Hapus ${item.name}`} onClick={() => clearReference('audio', index)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>


            {/* 3. Prompt */}
            <div className="generate-field">
              <div className="generate-label-row">
                <label className="generate-label" htmlFor="gen-prompt">Prompt</label>
                <span className="generate-hint">{prompt.length} karakter</span>
              </div>
              <textarea
                id="gen-prompt"
                aria-label="Prompt"
                className="generate-textarea"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Deskripsikan adegan video secara detail: subjek, gerakan kamera, pencahayaan, atmosfer, dan efek suara yang diinginkan..."
              />
              <div className="generate-chips">
                {PROMPT_CHIPS.map((chip) => (
                  <button
                    key={chip.label}
                    type="button"
                    className="generate-chip"
                    onClick={() => setPrompt(chip.text)}
                  >
                    + {chip.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 4. Rasio, Resolusi, Durasi */}
            <div className="generate-params-grid">
              <div className="generate-field">
                <label className="generate-label" htmlFor="gen-ratio">Rasio</label>
                <select
                  id="gen-ratio"
                  aria-label="Rasio"
                  className="generate-select"
                  value={aspectRatio}
                  onChange={(e) => setAspectRatio(e.target.value)}
                >
                  {ratioOptions.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>

              <div className="generate-field">
                <label className="generate-label" htmlFor="gen-resolution">Resolusi</label>
                <select
                  id="gen-resolution"
                  aria-label="Resolusi"
                  className="generate-select"
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                >
                  {resolutionOptions.map((resOpt) => (
                    <option key={resOpt} value={resOpt}>{resOpt.toUpperCase()}</option>
                  ))}
                </select>
              </div>

              <div className="generate-field">
                <label className="generate-label" htmlFor="gen-duration">Durasi</label>
                <select
                  id="gen-duration"
                  aria-label="Durasi"
                  className="generate-select"
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                >
                  {durationOptions.map((dur) => (
                    <option key={dur} value={dur}>{dur} detik</option>
                  ))}
                </select>
              </div>
            </div>

            {/* 5. Audio Bawaan + Tombol Generate */}
            <div className="generate-actions">
              <label className="generate-audio-toggle">
                <input
                  type="checkbox"
                  checked={generateAudio}
                  disabled={!selectedModel?.supportsAudio}
                  onChange={(e) => setGenerateAudio(e.target.checked)}
                />
                <span>
                  {selectedModel?.supportsAudio
                    ? 'Sertakan Audio Bawaan (Native Audio)'
                    : 'Model ini tidak menghasilkan audio otomatis'}
                </span>
              </label>

              <button
                type="submit"
                className="generate-submit-btn"
                disabled={!selectedModel || workerMode !== 'ready' || submitting || Boolean(uploadingSlot)}
              >
                {submitting ? 'Memproses Generate...' : uploadingSlot ? 'Mengunggah Media...' : 'Generate'}
              </button>
            </div>
          </form>

          {/* RIGHT: Pratinjau Video & Riwayat */}
          <div className="generate-stage-col">
            <div className="generate-card">
              <div className="generate-card-head">
                <div>
                  <h2 className="generate-card-title">Pratinjau Hasil</h2>
                  <p className="generate-card-sub">
                    {activeGeneration
                      ? `${activeGeneration.model} · ${activeGeneration.aspect_ratio} · ${activeGeneration.resolution} · ${activeGeneration.duration}s`
                      : 'Hasil generasi video akan muncul langsung di sini'}
                  </p>
                </div>
                {activeGeneration && (
                  <span
                    className={`generate-pill ${
                      activeGeneration.status === 'completed'
                        ? 'is-free'
                        : activeGeneration.status === 'failed'
                          ? 'is-warn'
                          : 'is-accent'
                    }`}
                  >
                    {STATUS_LABELS[activeGeneration.status] || activeGeneration.status}
                  </span>
                )}
              </div>

              <div className="generate-player-frame">
                {!activeGeneration && (
                  <div className="generate-empty-stage">
                    <strong>{selectedModel ? 'Siap Membuat Video' : 'Belum ada model video aktif'}</strong>
                    <span>{selectedModel ? 'Pilih model, atur parameter, lalu mulai generasi.' : 'Video yang sudah dibuat tetap tersedia di History.'}</span>
                  </div>
                )}

                {activeGeneration && (activeGeneration.status === 'queued' || activeGeneration.status === 'in_progress') && (
                  <div className="generate-empty-stage">
                    <strong>{STATUS_LABELS[activeGeneration.status]}</strong>
                    <div className="generate-progress-wrap">
                      <div className="generate-progress-bar">
                        <div
                          className="generate-progress-fill"
                          style={{ width: `${Math.max(8, activeGeneration.progress || 15)}%` }}
                        />
                      </div>
                      <span>{activeGeneration.progress || 15}% · Memantau progres otomatis...</span>
                    </div>
                  </div>
                )}

                {activeGeneration && activeGeneration.status === 'failed' && (
                  <div className="generate-empty-stage">
                    <strong style={{ color: '#fca5a5' }}>Generasi Gagal</strong>
                    <span>{activeGeneration.error_message || 'Provider tidak dapat memproses permintaan ini.'}</span>
                    <button
                      type="button"
                      className="generate-secondary-btn"
                      onClick={() => handleReuseSettings(activeGeneration)}
                    >
                      Muat Ulang Pengaturan
                    </button>
                  </div>
                )}

                {activeGeneration && activeGeneration.status === 'completed' && activeGeneration.result_url && (
                  <video
                    key={activeGeneration.id}
                    src={activeGeneration.result_url}
                    poster={activeGeneration.image_url || undefined}
                    controls
                    playsInline
                    preload="metadata"
                    className="generate-video-el"
                  />
                )}
              </div>

              {activeGeneration && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {activeGeneration.prompt && (
                    <p className="generate-history-prompt" style={{ WebkitLineClamp: 4 }}>
                      {activeGeneration.prompt}
                    </p>
                  )}
                  <div className="generate-history-actions">
                    {activeGeneration.status === 'completed' && activeGeneration.result_url && (
                      <a
                        className="generate-secondary-btn"
                        href={activeGeneration.result_url}
                        download={`blea-video-${activeGeneration.id.slice(0, 8)}.mp4`}
                      >
                        Unduh Video
                      </a>
                    )}
                    <button
                      type="button"
                      className="generate-secondary-btn"
                      onClick={() => handleReuseSettings(activeGeneration)}
                    >
                      Gunakan Ulang Pengaturan
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Riwayat Video */}
            <div className="generate-card">
              <div className="generate-card-head">
                <div>
                  <h2 className="generate-card-title">Riwayat Generate</h2>
                  <p className="generate-card-sub">{history.length} generasi tersimpan</p>
                </div>
                <div className="generate-filter-tabs">
                  {[
                    { id: 'all', label: 'Semua' },
                    { id: 'completed', label: 'Selesai' },
                    { id: 'processing', label: 'Proses' },
                    { id: 'failed', label: 'Gagal' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      className={`generate-filter-tab ${historyFilter === tab.id ? 'active' : ''}`}
                      onClick={() => setHistoryFilter(tab.id)}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="generate-history-list">
                {loadingHistory ? (
                  <p className="generate-hint">Memuat riwayat generasi...</p>
                ) : filteredHistory.length === 0 ? (
                  <p className="generate-hint">Belum ada riwayat video pada filter ini.</p>
                ) : (
                  filteredHistory.map((item) => (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      className={`generate-history-item ${activeGeneration?.id === item.id ? 'active' : ''}`}
                      onClick={() => setActiveId(item.id)}
                      onKeyDown={(e) => e.key === 'Enter' && setActiveId(item.id)}
                    >
                      <div className="generate-history-top">
                        <span className="generate-pill">{item.model}</span>
                        <span
                          className={`generate-pill ${
                            item.status === 'completed'
                              ? 'is-free'
                              : item.status === 'failed'
                                ? 'is-warn'
                                : 'is-accent'
                          }`}
                        >
                          {STATUS_LABELS[item.status] || item.status}
                        </span>
                      </div>
                      <p className="generate-history-prompt">
                        {item.prompt || '(Generasi berbasis media tanpa prompt teks)'}
                      </p>
                      <div className="generate-history-meta">
                        <span>
                          {item.aspect_ratio} · {item.resolution} · {item.duration}s · {formatDateTime(item.created_at)}
                        </span>
                        <div className="generate-history-actions">
                          <button
                            type="button"
                            className="generate-clear-btn"
                            style={{ color: '#e4e4ec', borderColor: 'rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.06)' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReuseSettings(item);
                            }}
                          >
                            Pakai
                          </button>
                          <button
                            type="button"
                            className="generate-clear-btn"
                            onClick={(e) => handleDeleteHistory(item.id, e)}
                          >
                            Hapus
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
        </>}
      </div>
    </DropXLayout>
  );
}

export default GeneratePage;
