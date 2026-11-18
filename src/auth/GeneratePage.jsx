import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import {
  BUILTIN_VIDEO_MODELS,
  DEFAULT_ASPECT_RATIOS,
  DEFAULT_DURATIONS,
  DEFAULT_RESOLUTIONS,
  getVideoModelProfile,
} from '../lib/videoCatalog';
import {
  fetchVideoHistory,
  fetchVideoModels,
  fetchVideoStatus,
  generateVideo,
} from '../api/unorouter';
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
  image: 15 * 1024 * 1024,
  video: 50 * 1024 * 1024,
  audio: 20 * 1024 * 1024,
};

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

function modelKey(m) {
  return `${m.provider || 'unorouter'}::${m.id}`;
}

export function GeneratePage() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [searchParams] = useSearchParams();

  const [models, setModels] = useState(BUILTIN_VIDEO_MODELS);
  const [selectedModelKey, setSelectedModelKey] = useState(modelKey(BUILTIN_VIDEO_MODELS[0]));
  const [workerMode, setWorkerMode] = useState('checking'); // 'ready' | 'unavailable' | 'checking'

  const [prompt, setPrompt] = useState(() => searchParams.get('prompt') || '');
  const [aspectRatio, setAspectRatio] = useState('16:9');
  const [resolution, setResolution] = useState('720p');
  const [duration, setDuration] = useState(5);
  const [generateAudio, setGenerateAudio] = useState(true);

  const [imageMedia, setImageMedia] = useState(null); // { url, name, size, localPreview }
  const [videoMedia, setVideoMedia] = useState(null);
  const [audioMedia, setAudioMedia] = useState(null);
  const [uploadingSlot, setUploadingSlot] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState(null); // { type: 'error' | 'warn' | 'success', text }

  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [activeId, setActiveId] = useState(() => searchParams.get('id') || '');
  const [historyFilter, setHistoryFilter] = useState('all');

  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const audioInputRef = useRef(null);

  const selectedModel = useMemo(() => {
    return models.find((m) => modelKey(m) === selectedModelKey) || models[0] || BUILTIN_VIDEO_MODELS[0];
  }, [models, selectedModelKey]);

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

      if (modelsRes.ok && Array.isArray(modelsRes.data?.models) && modelsRes.data.models.length) {
        setWorkerMode('ready');
        setModels(modelsRes.data.models);
        setSelectedModelKey((prev) => {
          const exists = modelsRes.data.models.some((m) => modelKey(m) === prev);
          return exists ? prev : modelKey(modelsRes.data.models[0]);
        });
      } else if (modelsRes.workerUnavailable) {
        setWorkerMode('unavailable');
        // Enrich fallback models from Supabase provider_models if accessible
        const { data: dbModels } = await supabase
          .from('provider_models')
          .select('provider, model, active')
          .eq('active', true)
          .limit(200);
        if (Array.isArray(dbModels) && dbModels.length) {
          const map = new Map();
          for (const item of BUILTIN_VIDEO_MODELS) {
            map.set(modelKey(item), item);
          }
          for (const row of dbModels) {
            const prof = getVideoModelProfile(row.model, row.provider);
            if (/veo|sora|kling|hailuo|vidu|wan|seedance|grok.*video|gemini-omni|luma|runway|pika|minimax|video/i.test(row.model)) {
              map.set(modelKey(prof), { ...prof, activeInAdmin: true, providerConfigured: true });
            }
          }
          setModels(Array.from(map.values()));
        }
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
    if (file.size > MAX_BYTES[slot]) {
      setBanner({
        type: 'error',
        text: `Ukuran file ${slot} melebihi batas maksimum (${formatBytes(MAX_BYTES[slot])}).`,
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
      if (slot === 'video') setVideoMedia(mediaObj);
      if (slot === 'audio') setAudioMedia(mediaObj);
    } finally {
      setUploadingSlot('');
    }
  };

  const clearMedia = (slot) => {
    if (slot === 'image') {
      if (imageMedia?.localPreview?.startsWith('blob:')) URL.revokeObjectURL(imageMedia.localPreview);
      setImageMedia(null);
      if (imageInputRef.current) imageInputRef.current.value = '';
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

    const cleanPrompt = prompt.trim();
    if (!cleanPrompt && !imageMedia?.url && !videoMedia?.url && !audioMedia?.url) {
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
      const res = await generateVideo({
        provider: selectedModel.provider || 'unorouter',
        model: selectedModel.id,
        prompt: cleanPrompt,
        aspect_ratio: aspectRatio,
        resolution,
        duration: Number(duration),
        generate_audio: generateAudio,
        image_url: imageMedia?.url || '',
        video_url: videoMedia?.url || '',
        audio_url: audioMedia?.url || '',
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
    if (item.image_url) setImageMedia({ url: item.image_url, name: 'Referensi Gambar', size: 0, localPreview: item.image_url });
    if (item.video_url) setVideoMedia({ url: item.video_url, name: 'Referensi Video', size: 0, localPreview: item.video_url });
    if (item.audio_url) setAudioMedia({ url: item.audio_url, name: 'Referensi Audio', size: 0, localPreview: item.audio_url });
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
      description="Studio generasi video AI multi-provider dengan input teks, gambar, video, dan audio."
    >
      <div className="generate-page">
        {workerMode === 'unavailable' && (
          <div className="generate-banner" role="status">
            <span>
              Mode pratinjau lokal aktif: daftar model bawaan &amp; riwayat Supabase tetap tersedia, sedangkan pemanggilan endpoint <code>/api/video/*</code> berjalan penuh di Cloudflare Worker produksi.
            </span>
          </div>
        )}

        {selectedModel && !selectedModel.providerConfigured && workerMode === 'ready' && (
          <div className="generate-banner" role="alert">
            <span>
              API Key untuk provider <strong>{selectedModel.providerLabel || selectedModel.provider}</strong> belum dikonfigurasi.
            </span>
            {isAdmin && (
              <Link className="generate-banner-link" to="/admin">
                Atur API Key di Admin
              </Link>
            )}
          </div>
        )}

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
              <span className={`generate-pill ${selectedModel?.isFree ? 'is-free' : 'is-paid'}`}>
                {selectedModel?.priceLabel || (selectedModel?.isFree ? 'Gratis' : 'Berbayar')}
              </span>
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
                onChange={(e) => setSelectedModelKey(e.target.value)}
              >
                {models.map((m) => (
                  <option key={modelKey(m)} value={modelKey(m)}>
                    {`[${m.providerLabel || m.provider}] ${m.name} (${m.priceLabel || (m.isFree ? 'Gratis' : 'Berbayar')})${m.online === false ? ' • Sibuk' : ''}`}
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

            {/* 2. Upload Image, Video, Audio */}
            <div className="generate-field">
              <div className="generate-label-row">
                <span className="generate-label">Media Referensi (Opsional)</span>
                <span className="generate-hint">Gambar ≤15MB · Video ≤50MB · Audio ≤20MB</span>
              </div>
              <div className="generate-media-grid">
                {/* Upload Image */}
                <div className={`generate-upload-box ${imageMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">Upload Image</span>
                    {imageMedia && (
                      <button type="button" className="generate-clear-btn" onClick={() => clearMedia('image')}>
                        Hapus
                      </button>
                    )}
                  </div>
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="Upload Image"
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
                      disabled={uploadingSlot === 'image'}
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'image' ? 'Mengunggah...' : '+ Pilih Gambar'}</strong>
                      <span>JPG, PNG, WEBP</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={imageMedia?.name}>
                      {imageMedia ? imageMedia.name : 'Frame awal / subjek'}
                    </span>
                    {imageMedia?.size ? <span>{formatBytes(imageMedia.size)}</span> : null}
                  </div>
                </div>

                {/* Upload Video */}
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
                      disabled={uploadingSlot === 'video'}
                      onClick={() => videoInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'video' ? 'Mengunggah...' : '+ Pilih Video'}</strong>
                      <span>MP4, WEBM, MOV</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={videoMedia?.name}>
                      {videoMedia ? videoMedia.name : 'Referensi gerak / edit'}
                    </span>
                    {videoMedia?.size ? <span>{formatBytes(videoMedia.size)}</span> : null}
                  </div>
                </div>

                {/* Upload Audio */}
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
                      disabled={uploadingSlot === 'audio'}
                      onClick={() => audioInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'audio' ? 'Mengunggah...' : '+ Pilih Audio'}</strong>
                      <span>MP3, WAV, M4A</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={audioMedia?.name}>
                      {audioMedia ? audioMedia.name : 'Musik / suara / lip-sync'}
                    </span>
                    {audioMedia?.size ? <span>{formatBytes(audioMedia.size)}</span> : null}
                  </div>
                </div>
              </div>
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
                disabled={submitting || Boolean(uploadingSlot)}
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
                    <strong>Siap Membuat Video</strong>
                    <span>
                      Pilih model, atur parameter, lalu klik <strong>Generate</strong> untuk merender video AI Anda.
                    </span>
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
      </div>
    </DropXLayout>
  );
}

export default GeneratePage;
