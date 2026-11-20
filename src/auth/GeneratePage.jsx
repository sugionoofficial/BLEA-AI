import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import {
  DEFAULT_ASPECT_RATIOS,
  DEFAULT_DURATIONS,
  DEFAULT_RESOLUTIONS,
  getAlibabaVideoModelSpec,
} from '../lib/videoCatalog';
import {
  buildDownloadFilename,
  fetchVideoHistory,
  fetchVideoModels,
  fetchVideoStatus,
  generateVideo,
  withDownloadParam,
} from '../api/generation';
import { availableVideoModels, generationModelKey } from '../lib/generationCatalog';
import { useCredits } from '../lib/useCredits';
import { formatCredits, formatModelDisplayName, formatProviderBadge } from '../lib/formatCredits';
import { GenerateImagePanel } from './GenerateImagePanel';
import { ModelSelect } from './ModelSelect';
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

const DANCE_PROMPT_CHIPS = [
  {
    label: 'Rooftop Neon',
    text: 'K-pop synchronized dance choreography on a glowing neon rooftop stage at night, dynamic camera tracking.',
  },
  {
    label: 'Studio Pop',
    text: 'Energetic pop dance performance in a clean minimalist LED studio with warm cinematic rim lights.',
  },
  {
    label: 'Street Urban',
    text: 'High-energy hip-hop street dance choreography under city bridge lights with smooth handheld camera motion.',
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
  // Batas resmi Wan 3.0 & Freebeat Dance: gambar ≤20MB, video ≤100MB,
  // audio ≤25MB (Freebeat MP3/WAV/M4A hingga 25MB).
  image: 20 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
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
  const { balance, refresh: refreshBalance } = useCredits(user?.id);
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
  const [audioUrlInput, setAudioUrlInput] = useState('');
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
  const isFreebeatDance = selectedModel?.provider === 'freebeat';
  const alibabaSpec = useMemo(
    () => (isAlibaba ? getAlibabaVideoModelSpec(selectedModel?.id) : null),
    [isAlibaba, selectedModel?.id],
  );
  const aliMediaMode = alibabaSpec?.mediaMode || (isAlibaba ? 'wan3' : null);
  const maxRefImages = isFreebeatDance ? 5 : (alibabaSpec?.maxRefImages ?? MAX_REFERENCES.image);
  const maxRefVideos = isFreebeatDance ? 0 : (alibabaSpec?.maxRefVideos ?? MAX_REFERENCES.video);
  const maxRefAudios = isFreebeatDance ? 0 : (alibabaSpec?.maxRefAudios ?? MAX_REFERENCES.audio);
  const maxRefTotal = isFreebeatDance ? 5 : (alibabaSpec?.maxRefTotal ?? MAX_TOTAL_REFERENCES);
  const referenceTotal = refImages.length + refVideos.length + refAudios.length;

  const ratioOptions = useMemo(
    () => (
      isAlibaba && alibabaSpec?.supportsRatio === false
        ? []
        : (selectedModel?.aspectRatios?.length ? selectedModel.aspectRatios : DEFAULT_ASPECT_RATIOS)
    ),
    [isAlibaba, alibabaSpec?.supportsRatio, selectedModel],
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
    if (ratioOptions.length && !ratioOptions.includes(aspectRatio)) setAspectRatio(ratioOptions[0]);
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
        if (updates.some((u) => u && Number(u.credits_refunded) > 0)) refreshBalance();
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [history, workerMode, refreshBalance]);

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
    const maxMap = { image: maxRefImages, video: maxRefVideos, audio: maxRefAudios };
    const max = maxMap[kind];
    const current = kind === 'image' ? refImages : kind === 'video' ? refVideos : refAudios;
    const setList = kind === 'image' ? setRefImages : kind === 'video' ? setRefVideos : setRefAudios;
    if (current.length + list.length > max) {
      setBanner({ type: 'error', text: `${selectedModel?.name || 'Model ini'}: maksimal ${max} ${kind === 'image' ? 'foto' : kind === 'video' ? 'video' : 'audio'} referensi per permintaan.` });
      return;
    }
    if (referenceTotal + list.length > maxRefTotal) {
      setBanner({ type: 'error', text: `${selectedModel?.name || 'Model ini'}: maksimal ${maxRefTotal} materi referensi per permintaan.` });
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
    const isWan3 = isAlibaba && aliMediaMode === 'wan3';
    const alibabaFrame = isWan3 && mediaMode === 'frame';
    const alibabaReference = isWan3 && mediaMode === 'reference';

    if (isAlibaba && alibabaSpec) {
      if (alibabaSpec.requiresPrompt && !cleanPrompt) {
        setBanner({ type: 'error', text: `${selectedModel.name} membutuhkan prompt teks.` });
        return;
      }
      if (alibabaSpec.maxPrompt && cleanPrompt.length > alibabaSpec.maxPrompt) {
        setBanner({ type: 'error', text: `${selectedModel.name}: panjang prompt maksimal ${alibabaSpec.maxPrompt} karakter.` });
        return;
      }
      if (alibabaSpec.requiresFirstFrame && !imageMedia?.url) {
        setBanner({ type: 'error', text: `${selectedModel.name} wajib menyertakan gambar First Frame / karakter.` });
        return;
      }
      if (alibabaSpec.requiresLastFrame && !imageLastMedia?.url) {
        setBanner({ type: 'error', text: `${selectedModel.name} wajib menyertakan Last Frame.` });
        return;
      }
      if (alibabaSpec.requiresVideo && !videoMedia?.url) {
        setBanner({ type: 'error', text: `${selectedModel.name} wajib menyertakan video sumber.` });
        return;
      }
      if (alibabaSpec.requiresReference && refImages.length + refVideos.length === 0) {
        setBanner({ type: 'error', text: `${selectedModel.name} wajib menyertakan minimal 1 media referensi.` });
        return;
      }
      if (aliMediaMode === 'vace' && !videoMedia?.url && refImages.length === 0) {
        setBanner({ type: 'error', text: `${selectedModel.name} membutuhkan minimal 1 gambar referensi atau 1 video sumber.` });
        return;
      }
    }

    const effectiveAudioUrl = audioMedia?.url || (isFreebeatDance ? audioUrlInput.trim() : '');
    if (isFreebeatDance && !effectiveAudioUrl) {
      setBanner({
        type: 'error',
        text: 'Freebeat Music-to-Dance Video wajib menyertakan file audio/lagu (MP3/WAV/M4A) atau tautan musik HTTPS publik.',
      });
      return;
    }

    const frameEmpty = !imageMedia?.url && !imageLastMedia?.url;
    const referenceEmpty = referenceTotal === 0;
    if (alibabaFrame && imageLastMedia?.url && !imageMedia?.url) {
      setBanner({ type: 'error', text: 'Last Frame membutuhkan First Frame. Unggah gambar pertama dulu.' });
      return;
    }
    const hasMedia = alibabaFrame ? !frameEmpty : alibabaReference ? !referenceEmpty : Boolean(imageMedia?.url || videoMedia?.url || effectiveAudioUrl || refImages.length || refVideos.length);
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
      let referencePayload;
      if (isFreebeatDance) {
        referencePayload = {
          image_url: '',
          video_url: '',
          audio_url: effectiveAudioUrl,
          reference_images: refImages.map((m) => m.url),
        };
      } else if (!isAlibaba) {
        referencePayload = {
          image_url: imageMedia?.url || '',
          video_url: videoMedia?.url || '',
          audio_url: audioMedia?.url || '',
        };
      } else if (aliMediaMode === 'wan3') {
        referencePayload = alibabaReference
          ? {
              image_url: '',
              video_url: '',
              audio_url: '',
              reference_images: refImages.map((m) => m.url),
              reference_videos: refVideos.map((m) => m.url),
              reference_audios: refAudios.map((m) => m.url),
            }
          : {
              image_url: imageMedia?.url || '',
              image_last_url: imageLastMedia?.url || '',
              video_url: '',
              audio_url: '',
            };
      } else if (aliMediaMode === 'none') {
        referencePayload = {
          image_url: '',
          video_url: '',
          audio_url: alibabaSpec?.supportsAudioInput ? (audioMedia?.url || '') : '',
        };
      } else if (aliMediaMode === 'first_frame') {
        referencePayload = {
          image_url: imageMedia?.url || '',
          video_url: '',
          audio_url: alibabaSpec?.supportsAudioInput ? (audioMedia?.url || '') : '',
        };
      } else if (aliMediaMode === 'keyframes') {
        referencePayload = {
          image_url: imageMedia?.url || '',
          image_last_url: imageLastMedia?.url || '',
          video_url: '',
          audio_url: '',
        };
      } else if (aliMediaMode === 'animate') {
        referencePayload = {
          image_url: imageMedia?.url || '',
          video_url: videoMedia?.url || '',
          audio_url: '',
        };
      } else if (aliMediaMode === 'reference_urls') {
        referencePayload = {
          image_url: '',
          video_url: '',
          audio_url: '',
          reference_images: refImages.map((m) => m.url),
          reference_videos: refVideos.map((m) => m.url),
        };
      } else if (aliMediaMode === 'reference_images') {
        referencePayload = {
          image_url: '',
          video_url: '',
          audio_url: '',
          reference_images: refImages.map((m) => m.url),
        };
      } else if (aliMediaMode === 'video_edit' || aliMediaMode === 'vace') {
        referencePayload = {
          image_url: '',
          video_url: videoMedia?.url || '',
          audio_url: '',
          reference_images: refImages.map((m) => m.url),
        };
      } else {
        referencePayload = {};
      }
      const res = await generateVideo({
        provider: selectedModel.provider,
        model: selectedModel.id,
        prompt: cleanPrompt,
        ...(ratioOptions.length ? { aspect_ratio: aspectRatio } : {}),
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
      refreshBalance();
      const chargedCredits = Number(res.data?.credits || created?.credits_charged || 0);
      const cleanModelName = formatModelDisplayName(selectedModel.name, selectedModel.provider, selectedModel.providerLabel);
      setBanner({
        type: 'success',
        text: created.status === 'completed'
          ? `Video berhasil dibuat dan siap diputar.${chargedCredits ? ` (${formatCredits(chargedCredits)} kredit BLEA)` : ''}`
          : `Generasi dimulai menggunakan ${cleanModelName}${chargedCredits ? ` (${formatCredits(chargedCredits)} kredit BLEA)` : ''}. Status akan diperbarui otomatis.`,
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
    if (item.image_url && item.provider !== 'freebeat') setImageMedia({ url: item.image_url, name: 'First Frame', size: 0, localPreview: item.image_url });
    if (item.image_last_url || item.metadata?.image_last_url) setImageLastMedia({ url: item.image_last_url || item.metadata.image_last_url, name: 'Last Frame', size: 0, localPreview: item.image_last_url || item.metadata.image_last_url });
    if (item.video_url) setVideoMedia({ url: item.video_url, name: 'Referensi Video', size: 0, localPreview: item.video_url });
    if (item.audio_url) setAudioMedia({ url: item.audio_url, name: 'Referensi Audio', size: 0, localPreview: item.audio_url });
    const meta = item.metadata || {};
    const reuseImages = Array.isArray(meta.reference_images) && meta.reference_images.length
      ? meta.reference_images
      : (Array.isArray(meta.image_urls) ? meta.image_urls : []);
    if (reuseImages.length) {
      setMediaMode('reference');
      setRefImages(reuseImages.map((url, i) => ({ url, name: `Referensi Gambar ${i + 1}`, size: 0, localPreview: url })));
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
      description="Studio gambar & video AI"
    >
      <div className="generate-page">
        <div className="generate-mode-tabs" role="tablist" aria-label="Jenis generasi">
          <button type="button" role="tab" aria-selected={mode === 'image'} onClick={() => setMode('image')}>Generate gambar</button>
          <button type="button" role="tab" aria-selected={mode === 'video'} onClick={() => setMode('video')}>Generate video</button>
        </div>
        {mode === 'image' ? <GenerateImagePanel initialPrompt={searchParams.get('prompt') || ''} /> : <>
        {workerMode === 'unavailable' && (
          <div className="generate-banner" role="status">
            <span>Katalog video sedang tidak dapat dimuat.</span>
          </div>
        )}

        {workerMode === 'ready' && models.length === 0 && (
          <div className="generate-banner" role="status">
            <span>Belum ada model video aktif.</span>
            {isAdmin && <Link className="generate-banner-link" to="/admin">Atur provider &amp; model</Link>}
          </div>
        )}

        {selectedModel && selectedModel.priced === false && (
          <div className="generate-banner is-error" role="status">
            <span>
              Tarif kredit untuk <strong>{formatModelDisplayName(selectedModel.name, selectedModel.provider, selectedModel.providerLabel)}</strong> belum diatur admin.
            </span>
            {isAdmin && <Link className="generate-banner-link" to="/credits">Atur harga kredit</Link>}
          </div>
        )}

        {selectedModel && Number.isSafeInteger(selectedModel.credits) && selectedModel.credits > 0 && balance !== null && balance < selectedModel.credits && (
          <div className="generate-banner is-error" role="status">
            <span>
              Saldo kredit Anda ({formatCredits(balance)} kredit) tidak cukup (butuh {formatCredits(selectedModel.credits)} kredit).
            </span>
            <Link className="generate-banner-link" to="/credits">Isi kredit</Link>
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
                <h2 className="generate-card-title">Generate Video</h2>
              </div>
            </div>

            {/* 1. Pilih Model */}
            <div className="generate-field">
              <div className="generate-label-row">
                <label className="generate-label" htmlFor="gen-model">Pilih Model</label>
                <span className="generate-hint">{models.length} model</span>
              </div>
              <ModelSelect
                id="gen-model"
                ariaLabel="Pilih Model"
                value={selectedModelKey}
                disabled={!models.length}
                placeholder="Tidak ada model video aktif"
                options={models.map((m) => {
                  const badge = formatProviderBadge(m.provider, m.providerLabel);
                  const displayName = formatModelDisplayName(m.name, m.provider, m.providerLabel);
                  const creditLabel = Number.isSafeInteger(m.credits) && m.credits > 0
                    ? `${formatCredits(m.credits)} kredit`
                    : (m.priced === false ? 'Belum bertarif' : '');
                  return {
                    value: modelKey(m),
                    badge,
                    label: displayName,
                    sub: m.online === false ? 'Antrean penuh' : '',
                    meta: creditLabel,
                    tone: m.online === false || m.priced === false ? 'warn' : 'accent',
                    nativeLabel: `[${badge}] ${displayName}${creditLabel ? ` · ${creditLabel}` : ''}${m.online === false ? ' • Sibuk' : ''}`,
                  };
                })}
                onChange={(nextKey) => setSelectedModelKey(nextKey)}
              />

              {selectedModel && (selectedModel.online === false || selectedModel.description) && (
                <div className="generate-model-meta">
                  {selectedModel.online === false && <span className="generate-pill is-warn">Antrean Penuh</span>}
                  {selectedModel.description && <span className="generate-hint generate-model-desc">{selectedModel.description}</span>}
                </div>
              )}
            </div>

            {/* 2. Media referensi */}
            {(() => {
              const showWan3Tabs = isAlibaba && aliMediaMode === 'wan3';
              const showSingleImage = (!isAlibaba && !isFreebeatDance)
                || (showWan3Tabs && mediaMode === 'frame')
                || ['first_frame', 'keyframes', 'animate'].includes(aliMediaMode);
              const showLastFrame = (showWan3Tabs && mediaMode === 'frame') || aliMediaMode === 'keyframes';
              const showSingleVideo = (!isAlibaba && !isFreebeatDance) || ['animate', 'video_edit', 'vace'].includes(aliMediaMode);
              const showSingleAudio = isFreebeatDance || !isAlibaba || (['none', 'first_frame'].includes(aliMediaMode) && Boolean(alibabaSpec?.supportsAudioInput));
              const showRefSection = isFreebeatDance
                || (showWan3Tabs && mediaMode === 'reference')
                || ['reference_urls', 'reference_images', 'video_edit', 'vace'].includes(aliMediaMode);
              const showRefVideos = !isFreebeatDance && (showWan3Tabs || aliMediaMode === 'reference_urls');
              const showRefAudios = !isFreebeatDance && showWan3Tabs;
              const isMediaRequired = isFreebeatDance || Boolean(alibabaSpec?.requiresFirstFrame || alibabaSpec?.requiresLastFrame || alibabaSpec?.requiresVideo || alibabaSpec?.requiresReference);
              const hasAnyMediaInput = showSingleImage || showLastFrame || showSingleVideo || showSingleAudio || showRefSection;
              if (!hasAnyMediaInput) return null;
              return (
            <div className="generate-field">
              <div className="generate-label-row">
                <span className="generate-label">{isFreebeatDance ? 'Music-to-Dance (Lagu & Foto Karakter)' : isMediaRequired ? 'Media Sumber' : 'Media Referensi (Opsional)'}</span>
                <span className="generate-hint">{isFreebeatDance ? 'Audio ≤25MB · Foto ≤10MB' : 'Gambar ≤20MB · Video ≤100MB'}</span>
              </div>

              {showWan3Tabs && (
                <div className="generate-mode-tabs is-compact" role="tablist" aria-label="Mode Wan 3.0">
                  <button type="button" role="tab" aria-selected={mediaMode === 'frame'} onClick={() => setMediaMode('frame')}>
                    Frame
                  </button>
                  <button type="button" role="tab" aria-selected={mediaMode === 'reference'} onClick={() => setMediaMode('reference')}>
                    Referensi ({referenceTotal}/{maxRefTotal})
                  </button>
                </div>
              )}

              {(showSingleImage || showLastFrame || showSingleVideo || showSingleAudio) && (
              <div className="generate-media-grid">
                {/* First Frame / Upload Image */}
                {showSingleImage && (
                <div className={`generate-upload-box ${imageMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">
                      {!isAlibaba ? 'Upload Image' : aliMediaMode === 'animate' ? 'Gambar Karakter (Wajib)' : alibabaSpec?.requiresFirstFrame ? 'First Frame (Wajib)' : 'First Frame'}
                    </span>
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
                      {imageMedia ? imageMedia.name : (aliMediaMode === 'animate' ? 'Subjek / karakter' : 'Frame awal / subjek')}
                    </span>
                    {imageMedia?.size ? <span>{formatBytes(imageMedia.size)}</span> : null}
                  </div>
                </div>
                )}

                {/* Last Frame (Wan 3.0 frame / KF2V) */}
                {showLastFrame && (
                <div className={`generate-upload-box ${imageLastMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">{alibabaSpec?.requiresLastFrame ? 'Last Frame (Wajib)' : 'Last Frame (Opsional)'}</span>
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
                      disabled={!selectedModel || Boolean(uploadingSlot) || (!alibabaSpec?.requiresLastFrame && !imageMedia)}
                      onClick={() => imageLastInputRef.current?.click()}
                    >
                      <strong>{uploadingSlot === 'image_last' ? 'Mengunggah...' : '+ Pilih Last Frame'}</strong>
                      <span>{alibabaSpec?.requiresLastFrame ? 'Wajib · maks 20MB' : 'Butuh First Frame · maks 20MB'}</span>
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

                {/* Upload Video */}
                {showSingleVideo && (
                <div className={`generate-upload-box ${videoMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">
                      {!isAlibaba ? 'Upload Video' : alibabaSpec?.requiresVideo ? (aliMediaMode === 'animate' ? 'Video Penggerak (Wajib)' : 'Video Sumber (Wajib)') : 'Video Sumber (Opsional)'}
                    </span>
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

                {/* Upload Audio */}
                {showSingleAudio && (
                <div className={`generate-upload-box ${audioMedia ? 'has-file' : ''}`}>
                  <div className="generate-upload-top">
                    <span className="generate-upload-title">{isFreebeatDance ? 'Lagu / Audio (Wajib)' : !isAlibaba ? 'Upload Audio' : 'Audio Referensi (Opsional)'}</span>
                    {audioMedia && (
                      <button type="button" className="generate-clear-btn" onClick={() => clearMedia('audio')}>
                        Hapus
                      </button>
                    )}
                  </div>
                  <input
                    ref={audioInputRef}
                    type="file"
                    accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/x-m4a,audio/aac,audio/flac,audio/webm"
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
                      <span>MP3, WAV, M4A · maks 25MB</span>
                    </button>
                  )}
                  <div className="generate-upload-footer">
                    <span className="generate-upload-name" title={audioMedia?.name}>
                      {audioMedia ? audioMedia.name : 'Musik / suara / lip-sync'}
                    </span>
                    {audioMedia?.size ? <span>{formatBytes(audioMedia.size)}</span> : null}
                  </div>
                  {isFreebeatDance && !audioMedia && (
                    <input
                      type="url"
                      aria-label="URL Lagu HTTPS"
                      className="generate-select"
                      style={{ marginTop: 8 }}
                      value={audioUrlInput}
                      onChange={(e) => setAudioUrlInput(e.target.value)}
                      placeholder="Atau tempel URL HTTPS lagu / Suno / YouTube..."
                    />
                  )}
                </div>
                )}
              </div>
              )}

              {/* Mode referensi multi-upload */}
              {showRefSection && (
                <div className="generate-ref-sections">
                  <p className="generate-hint" style={{ marginTop: 4 }}>
                    {isFreebeatDance
                      ? `Mode Music-to-Dance (bukan Motion Transfer video): koreografi AI otomatis dibuat dari lagu Anda + opsional 0–${maxRefImages} foto karakter/penari. Resolusi 720p (~15 detik awal, proses 15–60 menit).`
                      : aliMediaMode === 'reference_images'
                      ? `Wajib 1–${maxRefImages} foto referensi (rujuk di prompt: [Image 1], [Image 2], ...).`
                      : aliMediaMode === 'reference_urls'
                        ? `Wajib 1–${maxRefTotal} media referensi (maks ${maxRefImages} foto atau ${maxRefVideos} video; rujuk di prompt: character1, character2).`
                        : aliMediaMode === 'video_edit'
                          ? `Opsional 0–${maxRefImages} foto referensi tambahan untuk video edit.`
                          : aliMediaMode === 'vace'
                            ? `Isi Video Sumber di atas ATAU unggah 1–${maxRefImages} foto referensi (image_reference).`
                            : `Mode referensi: ${referenceTotal}/${maxRefTotal} materi · ${refImages.length}/${maxRefImages} foto · ${refVideos.length}/${maxRefVideos} video · ${refAudios.length}/${maxRefAudios} audio. Video & audio maks 15 detik total.`}
                  </p>

                  {maxRefImages > 0 && (
                  <div className="generate-ref-row">
                    <div className="generate-ref-row-head">
                      <span className="generate-upload-title">{isFreebeatDance ? `Foto Karakter / Penari (${refImages.length}/${maxRefImages})` : `Foto Referensi (${refImages.length}/${maxRefImages})`}</span>
                      <input ref={refImageInputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp" aria-label="Foto Referensi" className="generate-upload-input" onChange={(e) => { handleUploadReference('image', e.target.files); e.target.value = ''; }} />
                      <button type="button" className="generate-clear-btn" disabled={!selectedModel || Boolean(uploadingSlot) || refImages.length >= maxRefImages} onClick={() => refImageInputRef.current?.click()}>
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
                  )}

                  {showRefVideos && maxRefVideos > 0 && (
                  <div className="generate-ref-row">
                    <div className="generate-ref-row-head">
                      <span className="generate-upload-title">Video Referensi ({refVideos.length}/{maxRefVideos})</span>
                      <input ref={refVideoInputRef} type="file" multiple accept="video/mp4,video/quicktime,video/webm" aria-label="Video Referensi" className="generate-upload-input" onChange={(e) => { handleUploadReference('video', e.target.files); e.target.value = ''; }} />
                      <button type="button" className="generate-clear-btn" disabled={!selectedModel || Boolean(uploadingSlot) || refVideos.length >= maxRefVideos} onClick={() => refVideoInputRef.current?.click()}>
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
                  )}

                  {showRefAudios && maxRefAudios > 0 && (
                  <div className="generate-ref-row">
                    <div className="generate-ref-row-head">
                      <span className="generate-upload-title">Audio Referensi ({refAudios.length}/{maxRefAudios})</span>
                      <input ref={refAudioInputRef} type="file" multiple accept="audio/wav,audio/mpeg,audio/mp3" aria-label="Audio Referensi" className="generate-upload-input" onChange={(e) => { handleUploadReference('audio', e.target.files); e.target.value = ''; }} />
                      <button type="button" className="generate-clear-btn" disabled={!selectedModel || Boolean(uploadingSlot) || refAudios.length >= maxRefAudios} onClick={() => refAudioInputRef.current?.click()}>
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
                  )}
                </div>
              )}
            </div>
              );
            })()}


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
                placeholder={isFreebeatDance
                  ? 'Opsional: arahkan gaya koreografi, suasana panggung, kostum, atau gerakan kamera (kosongkan untuk mode otomatis penuh)...'
                  : 'Deskripsikan adegan video secara detail: subjek, gerakan kamera, pencahayaan, atmosfer, dan efek suara yang diinginkan...'}
              />
              <div className="generate-chips">
                {(isFreebeatDance ? DANCE_PROMPT_CHIPS : PROMPT_CHIPS).map((chip) => (
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
                  value={ratioOptions.length ? aspectRatio : 'mengikuti-gambar'}
                  disabled={!ratioOptions.length}
                  onChange={(e) => setAspectRatio(e.target.value)}
                >
                  {ratioOptions.length
                    ? ratioOptions.map((r) => <option key={r} value={r}>{r}</option>)
                    : <option value="mengikuti-gambar">Mengikuti media sumber</option>}
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
                    <option key={resOpt} value={resOpt}>
                      {aliMediaMode === 'animate' ? `${resOpt.toUpperCase()} (${resOpt === '1080p' ? 'wan-pro' : 'wan-std'})` : resOpt.toUpperCase()}
                    </option>
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
              {selectedModel?.supportsAudio && (
                <label className="generate-audio-toggle">
                  <input
                    type="checkbox"
                    checked={generateAudio}
                    onChange={(e) => setGenerateAudio(e.target.checked)}
                  />
                  <span>Audio bawaan</span>
                </label>
              )}

              <button
                type="submit"
                className="generate-submit-btn"
                disabled={
                  !selectedModel
                  || workerMode !== 'ready'
                  || submitting
                  || Boolean(uploadingSlot)
                  || selectedModel?.priced === false
                  || (Number.isSafeInteger(selectedModel?.credits) && selectedModel.credits > 0 && balance !== null && balance < selectedModel.credits)
                }
              >
                {(submitting || uploadingSlot) && <span className="generate-btn-spinner" aria-hidden="true" />}
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
                      : 'Video hasil generasi akan tampil di sini'}
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
                    <span>{selectedModel ? 'Atur parameter lalu tekan Generate.' : 'Riwayat tetap tersedia di bawah.'}</span>
                  </div>
                )}

                {activeGeneration && (activeGeneration.status === 'queued' || activeGeneration.status === 'in_progress') && (
                  <div className="generate-loader-stage" role="status" aria-live="polite">
                    <div className="generate-aurora" aria-hidden="true" />
                    <div className="generate-orbit" aria-hidden="true">
                      <span className="generate-orbit-ring" />
                      <span className="generate-orbit-ring is-inner" />
                      <span className="generate-eq">
                        <i /><i /><i /><i /><i />
                      </span>
                    </div>
                    <span className="generate-loader-badge">
                      <span className="generate-pulse-dot" aria-hidden="true" />
                      {STATUS_LABELS[activeGeneration.status]}
                    </span>
                    <div className="generate-progress-wrap">
                      <div className="generate-progress-bar">
                        <div
                          className="generate-progress-fill is-animated"
                          style={{ width: `${Math.max(12, activeGeneration.progress || 15)}%` }}
                        />
                      </div>
                      <span className="generate-loader-sub">
                        {activeGeneration.progress || 15}% · Merender frame &amp; memantau progres...
                      </span>
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
                        href={withDownloadParam(activeGeneration.result_url)}
                        download={buildDownloadFilename({ kind: 'video', id: activeGeneration.id })}
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
                          {item.status === 'completed' && item.result_url && (
                            <a
                              className="generate-history-download-btn"
                              href={withDownloadParam(item.result_url)}
                              download={buildDownloadFilename({ kind: 'video', id: item.id })}
                              onClick={(e) => e.stopPropagation()}
                            >
                              Unduh
                            </a>
                          )}
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
