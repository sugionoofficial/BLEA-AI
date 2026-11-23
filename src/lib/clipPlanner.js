// Perencana klip: mengubah digest analisis video menjadi rentang klip yang
// diusulkan. Fungsi murni supaya bisa diuji tanpa browser, dan supaya aturan
// pemotongan tidak tersembunyi di dalam komponen React.
//
// Penting: fungsi ini hanya MENGUSULKAN. Tidak ada pemotongan yang terjadi
// sampai pengguna menekan tombol, karena setiap potongan berarti re-encode di
// browser dan hasilnya berkas baru di storage.

export const CLIP_MIN_SEC = 3;
export const CLIP_MAX_SEC = 45;
export const CLIP_DEFAULT_SEC = 15;
export const MAX_CLIPS = 6;

/**
 * @param {{durationSec:number, sceneCuts?:number[], audio?:{peaks?:number[], silence?:number[]}}} analysis
 * @param {{targetSec?:number, maxClips?:number}} options
 * @returns {Array<{index:number, startSec:number, endSec:number, durationSec:number, reason:string}>}
 */
export function planClips(analysis, { targetSec = CLIP_DEFAULT_SEC, maxClips = MAX_CLIPS } = {}) {
  const duration = Number(analysis?.durationSec) || 0;
  if (duration <= 0) return [];

  const target = clamp(targetSec, CLIP_MIN_SEC, Math.min(CLIP_MAX_SEC, duration));
  const budget = Math.min(maxClips, MAX_CLIPS);

  // Titik mulai kandidat: scene cut dan lonjakan audio, karena keduanya adalah
  // momen "sesuatu terjadi". Tanpa sinyal, potong merata.
  const cuts = uniqueSorted([...(analysis.sceneCuts || []), ...((analysis.audio?.peaks) || [])])
    .filter((t) => t > 0.15 && t < duration - 1);

  const starts = [];
  for (const t of cuts) {
    if (starts.length >= budget) break;
    // Hindari klip yang tumpang tindih parah dengan yang sudah dipilih.
    if (starts.some((start) => Math.abs(start - t) < target * 0.6)) continue;
    starts.push(round2(Math.max(0, t - 0.4)));
  }
  if (!starts.length) starts.push(0);
  // Lengkapi sisa kuota dengan potongan merata dari titik 0.
  let cursor = 0;
  while (starts.length < Math.min(budget, Math.max(1, Math.floor(duration / Math.max(CLIP_MIN_SEC, target / 2))))) {
    cursor += target;
    if (cursor >= duration - CLIP_MIN_SEC) break;
    if (starts.some((start) => Math.abs(start - cursor) < target * 0.6)) continue;
    starts.push(round2(cursor));
  }

  const clips = [];
  for (const start of starts.sort((a, b) => a - b)) {
    const end = round2(Math.min(duration, start + target));
    const length = round2(end - start);
    // Buang ekor yang terlalu pendek untuk berarti.
    if (length < Math.min(CLIP_MIN_SEC, duration)) continue;
    if (clips.some((clip) => start < clip.endSec && end > clip.startSec)) continue;
    if (clips.some((clip) => Math.abs(clip.startSec - start) < 0.5)) continue;
    clips.push({
      index: clips.length + 1,
      startSec: start,
      endSec: end,
      durationSec: length,
      reason: reasonFor(start, analysis),
    });
    if (clips.length >= budget) break;
  }
  return clips;
}

function reasonFor(start, analysis) {
  const isScene = (analysis.sceneCuts || []).some((t) => Math.abs(t - start) < 1.5);
  const isPeak = (analysis.audio?.peaks || []).some((t) => Math.abs(t - start) < 1.5);
  if (isScene && isPeak) return 'pergantian gambar bertepatan dengan lonjakan audio';
  if (isScene) return 'pergantian gambar (kandidat pembuka)';
  if (isPeak) return 'lonjakan energi audio (kandidat hook)';
  return 'potongan merata (tidak ada sinyal kuat)';
}

/** Format daftar klip untuk prompt/UI, satu baris per klip. */
export function formatClipPlan(clips) {
  if (!clips?.length) return 'Tidak ada klip yang bisa diusulkan.';
  return clips
    .map((clip) => `${clip.index}. ${fmtRange(clip.startSec, clip.endSec)} (${clip.durationSec}s) — ${clip.reason}`)
    .join('\n');
}

export function fmtRange(start, end) {
  const fmt = (value) => {
    const total = Math.max(0, Math.round(Number(value) || 0));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };
  return `${fmt(start)}–${fmt(end)}`;
}

/**
 * Validasi rencana klip yang datang dari model/DB sebelum dipakai untuk memotong.
 * Rentang yang tidak masuk akal ditolak, bukan "diperbaiki" diam-diam.
 */
export function sanitizeClipPlan(raw, durationSec) {
  const duration = Number(durationSec) || 0;
  if (!Array.isArray(raw) || !duration) return [];
  const out = [];
  for (const item of raw) {
    const start = Number(item?.startSec);
    const end = Number(item?.endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start < 0 || end <= start) continue;
    if (start >= duration) continue;
    const safeEnd = Math.min(end, duration);
    const length = round2(safeEnd - start);
    if (length < CLIP_MIN_SEC || length > CLIP_MAX_SEC) continue;
    out.push({
      index: out.length + 1,
      startSec: round2(start),
      endSec: round2(safeEnd),
      durationSec: length,
      reason: String(item?.reason || '').slice(0, 160),
    });
    if (out.length >= MAX_CLIPS) break;
  }
  return out;
}

function uniqueSorted(list) {
  return [...new Set(list.map((value) => round2(value)).filter((value) => Number.isFinite(value)))]
    .sort((a, b) => a - b);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}
