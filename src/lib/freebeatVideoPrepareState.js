import { FREEBEAT_VIDEO_RESOLUTIONS, FREEBEAT_VIDEO_ASPECT_RATIOS } from './freebeatVideoTestSettings.js';

const validDuration = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 600;
const validCredits = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1000000;
const safeModel = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const safeSettings = (settings) => ({
  model_id: safeModel(settings?.model_id),
  generation_type: ['image', 'text', 'transition', 'reference'].includes(settings?.generation_type) ? settings.generation_type : null,
  duration: validDuration(settings?.duration) ? settings.duration : null,
  resolution: FREEBEAT_VIDEO_RESOLUTIONS.includes(settings?.resolution) ? settings.resolution : null,
  aspect_ratio: FREEBEAT_VIDEO_ASPECT_RATIOS.includes(settings?.aspect_ratio) ? settings.aspect_ratio : null,
});

// One source of truth for UI explanations and prepare-button/handler gating.
// Never copy arbitrary provider prose, prompts, URLs, approval tickets or IDs of tests.
export function videoPrepareState({ loading, connected, imageAccess, disabled, busy, imageUrl, prompt, modelId, modelLabel, duration, resolution, aspectRatio, quote, attempted, uncertain, unresolved }) {
  const blockers = [];
  const add = (code, message) => blockers.push({ code, message });
  if (loading) add('session_loading', 'Tunggu pemeriksaan sesi Freebeat selesai.');
  else if (!connected) add('session_missing', 'Hubungkan Freebeat melalui halaman utama, lalu buka kembali percobaan ini.');
  if (!imageAccess) add('generation_scope_missing', 'Izin generasi Freebeat belum tersedia. Hubungkan ulang melalui halaman utama dan setujui izin generasi.');
  if (disabled || busy) add('request_busy', 'Tunggu permintaan MCP atau upload yang sedang berjalan selesai.');
  if (!imageUrl) add('image_missing', 'Isi URL HTTPS gambar publik yang valid atau gunakan URL hasil upload Freebeat.');
  if (!prompt.trim()) add('prompt_missing', 'Isi prompt video.');
  const selected = safeSettings({ model_id: modelId, generation_type: 'image', duration, resolution, aspect_ratio: aspectRatio });
  if (!validDuration(duration)) add('duration_invalid', 'Isi durasi bulat 1–600 detik sesuai help live.');
  if (!selected.resolution) add('resolution_missing', 'Pilih resolusi sesuai help live.');
  if (!selected.aspect_ratio) add('aspect_ratio_missing', 'Pilih rasio sesuai help live.');
  const received = quote ? safeSettings(quote.settings) : null;
  if (!quote) {
    add('quote_missing', `Help/informasi model saja belum cukup. Selesaikan kolom langkah 2, centang izin quote, lalu klik Periksa quote ${modelLabel} #${modelId}. Jika input berubah, quote harus diperiksa lagi.`);
  } else {
    if (quote.quote?.status !== 'quoted') add('quote_not_quoted', 'Respons langkah 2 belum berstatus quoted. Periksa quote video lagi; harga tidak diketahui tidak dapat dipakai untuk generasi.');
    if (!validCredits(quote.quote?.credits)) add('quote_credits_invalid', 'Quote video belum memberi biaya numerik valid (0–1.000.000 kredit). Jangan anggap nilai kosong atau teks sebagai gratis.');
    if (!quote.settings || typeof quote.settings !== 'object' || Array.isArray(quote.settings)) add('quote_settings_missing', 'Quote tidak memuat parameter yang dapat diverifikasi. Periksa quote video lagi.');
    else {
      if (quote.settings.model_id !== modelId) add('quote_model_mismatch', `ID model pada quote tidak cocok dengan model ${modelId}. Periksa quote pada halaman model yang benar.`);
      if (quote.settings.generation_type !== 'image') add('quote_generation_mismatch', 'Mode quote bukan image. Halaman ini hanya menerima satu gambar keyframe/image.');
      if (quote.settings.duration !== duration) add('quote_duration_mismatch', `Durasi quote (${received.duration === null ? 'tidak valid' : `${received.duration} detik`}) berbeda dari pilihan (${selected.duration === null ? 'belum valid' : `${selected.duration} detik`}). Sesuaikan durasi lalu centang izin dan periksa quote lagi.`);
      if (quote.settings.resolution !== resolution) add('quote_resolution_mismatch', `Resolusi quote (${received.resolution ?? 'tidak valid'}) berbeda dari pilihan (${selected.resolution ?? 'belum dipilih'}). Sesuaikan resolusi lalu centang izin dan periksa quote lagi.`);
      if (quote.settings.aspect_ratio !== aspectRatio) add('quote_aspect_ratio_mismatch', `Rasio quote (${received.aspect_ratio ?? 'tidak valid'}) berbeda dari pilihan (${selected.aspect_ratio ?? 'belum dipilih'}). Sesuaikan rasio lalu centang izin dan periksa quote lagi.`);
    }
  }
  if (uncertain || unresolved) add('dispatch_uncertain', 'Ada hasil pengiriman yang belum pasti. Periksa catatan/aktivitas Freebeat dan minta tinjauan operator; jangan muat ulang untuk mencoba lagi.');
  if (attempted && !uncertain) add('dispatch_attempted', 'Satu pengiriman sudah dicoba pada halaman ini. Pantau catatannya, jangan kirim ulang.');
  return {
    blockers,
    diagnostic: {
      stage: 'video_prepare_ui', model_id: safeModel(modelId), blocked: blockers.length > 0,
      blockers: blockers.map(({ code }) => code),
      session: { loading: Boolean(loading), connected: Boolean(connected), generation_access: Boolean(imageAccess) },
      request_busy: Boolean(disabled || busy),
      input: { image_present: Boolean(imageUrl), prompt_present: Boolean(prompt.trim()), settings: selected },
      quote: { present: Boolean(quote), quoted: quote?.quote?.status === 'quoted', credits: validCredits(quote?.quote?.credits) ? quote.quote.credits : null, settings: received },
      dispatch: { attempted: Boolean(attempted), uncertain: Boolean(uncertain || unresolved) },
    },
  };
}
