// Analisis video di browser untuk perencanaan klip.
//
// Cloudflare Worker tidak punya ffmpeg dan tidak bisa men-decode video, jadi
// semua pengukuran dilakukan di browser lalu dikirim sebagai digest ringkas.
// Yang diukur sengaja hanya dua sinyal yang benar-benar andal tanpa ASR:
//   1. scene cut   — perbedaan piksel antar-frame (canvas, downscale 64x36)
//   2. energi audio — RMS per detik (Web Audio API, decode mono)
//
// Ini BUKAN transkrip. Model tidak bisa mendengar ucapan; ia hanya melihat
// "di detik 12 ada potongan gambar dan audio naik". Jangan menamai hasilnya
// "deteksi hook berbasis ucapan" di UI.

export const ANALYSIS_FPS = 2;          // sampel per detik untuk scene diff
export const MAX_ANALYSIS_SECONDS = 600; // 10 menit; lebih dari itu dipotong
const FRAME_W = 64;
const FRAME_H = 36;

export function isAnalysisSupported() {
  return typeof document !== 'undefined'
    && typeof document.createElement === 'function'
    && typeof window !== 'undefined';
}

/**
 * Ambil metadata video dari elemen <video>. Dipisah supaya bisa dipakai UI
 * tanpa menjalankan analisis penuh (murah: satu event loadedmetadata).
 */
export function probeVideoMetadata(sourceUrl, { timeoutMs = 20_000 } = {}) {
  if (!isAnalysisSupported()) return Promise.reject(new Error('Analisis video hanya tersedia di browser.'));
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.preload = 'metadata';
    video.muted = true;
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { video.src = ''; video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      try { video.remove(); } catch { /* ignore */ }
      fn(arg);
    };
    const timer = setTimeout(() => done(reject, new Error('Video terlalu lama dimuat untuk dibaca metadatanya.')), timeoutMs);
    video.onerror = () => done(reject, new Error('Video tidak bisa dibaca di browser ini. Format mungkin tidak didukung.'));
    video.onloadedmetadata = () => {
      const duration = Number(video.duration);
      done(resolve, {
        durationSec: Number.isFinite(duration) ? duration : null,
        width: video.videoWidth || null,
        height: video.videoHeight || null,
      });
    };
    document.body.appendChild(video);
    video.src = sourceUrl;
  });
}

/**
 * Bangun timeline sinyal. Mengembalikan `null` bila browser tidak bisa
 * men-decode (mis. codec tidak didukung) — pemanggil harus menangani null,
 * bukan menganggap analisis selalu berhasil.
 */
export async function analyzeVideo(sourceUrl, { onProgress, maxSeconds = MAX_ANALYSIS_SECONDS } = {}) {
  if (!isAnalysisSupported()) throw new Error('Analisis video hanya tersedia di browser.');
  const meta = await probeVideoMetadata(sourceUrl);
  if (!meta.durationSec || !Number.isFinite(meta.durationSec)) {
    throw new Error('Durasi video tidak terbaca; klip tidak bisa direncanakan.');
  }

  const duration = Math.min(meta.durationSec, maxSeconds);
  const truncated = meta.durationSec > duration;

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D tidak tersedia untuk menganalisis video.');

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
  document.body.appendChild(video);

  try {
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error('Video gagal dimuat untuk dianalisis.'));
      video.src = sourceUrl;
    });

    const step = 1 / ANALYSIS_FPS;
    const scenes = [];       // detik: potongan gambar
    const frameTimes = [];
    const thumbs = [];       // dataURL untuk model (maks 6)
    let prev = null;

    for (let t = 0; t < duration; t += step) {
      // Seek sinkron: menunggu 'seeked' per frame lambat tapi deterministik.
      // eslint-disable-next-line no-await-in-loop
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
      const data = ctx.getImageData(0, 0, FRAME_W, FRAME_H).data;
      const gray = new Uint8Array(FRAME_W * FRAME_H);
      for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
        gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      }
      if (prev) {
        const diff = meanAbsDiff(prev, gray);
        if (diff > 26) scenes.push(round2(t));
      }
      prev = gray;
      frameTimes.push(round2(t));
      onProgress?.(Math.min(0.99, t / duration));
    }

    const audio = await analyzeAudio(sourceUrl, duration).catch(() => null);

    // Thumbnail untuk model: 6 titik merata, JPEG kecil (bukan PNG) supaya
    // payload tetap jauh di bawah batas attachment.
    const thumbTimes = [0.08, 0.24, 0.4, 0.56, 0.72, 0.88].map((ratio) => round2(duration * ratio));
    for (const t of thumbTimes) {
      // eslint-disable-next-line no-await-in-loop
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, FRAME_W, FRAME_H);
      thumbs.push({ atSec: t, dataUrl: canvas.toDataURL('image/jpeg', 0.6) });
    }

    onProgress?.(1);
    return {
      durationSec: round2(meta.durationSec),
      analyzedSec: round2(duration),
      truncated,
      width: meta.width,
      height: meta.height,
      sceneCuts: dedupeCuts(scenes),
      audio: audio ? { peaks: audio.peaks, silence: audio.silence } : null,
      thumbs,
    };
  } finally {
    try { video.src = ''; video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    try { video.remove(); } catch { /* ignore */ }
  }
}

// RMS per detik pada audio mono 8 kHz. Dipakai untuk menandai lonjakan
// (kandidat hook) dan bagian hening (batas klip yang wajar).
export async function analyzeAudio(sourceUrl, durationSec) {
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('Audio sumber gagal diambil.');
  const buffer = await response.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio API tidak tersedia.');
  const ctx = new AudioCtx();
  try {
    // decodeAudioData butuh salinan: beberapa browser "menghabiskan" buffer.
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const data = decoded.getChannelData(0);
    const rate = decoded.sampleRate;
    const peaks = [];
    const silence = [];
    const perSecond = Math.max(1, Math.min(Math.ceil(durationSec), Math.ceil(decoded.duration)));
    let prevRms = null;
    for (let s = 0; s < perSecond; s += 1) {
      const from = s * rate;
      const to = Math.min(data.length, (s + 1) * rate);
      if (to <= from) break;
      let sum = 0;
      for (let i = from; i < to; i += 1) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (to - from));
      if (rms < 0.01) silence.push(s);
      if (prevRms !== null && rms > 0.05 && rms > prevRms * 1.9) peaks.push(s);
      prevRms = rms;
    }
    return { peaks: dedupeCuts(peaks, 2), silence: dedupeCuts(silence, 1) };
  } finally {
    try { await ctx.close(); } catch { /* ignore */ }
  }
}

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      reject(new Error('Gagal melakukan seek pada video.'));
    };
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('error', onError);
    video.currentTime = Math.max(0, Math.min(time, (video.duration || time)));
  });
}

function meanAbsDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function dedupeCuts(list, minGap = 1.2) {
  const out = [];
  for (const value of list) {
    if (!out.length || value - out[out.length - 1] >= minGap) out.push(value);
  }
  return out;
}

/**
 * Digest teks ringkas untuk dikirim ke model. Ukurannya dijaga < ~1,5 KB:
 * free-tier context mahal, dan daftar 200 scene cut tidak menambah keputusan.
 */
export function buildVideoDigest(analysis) {
  if (!analysis) return '';
  const { durationSec, analyzedSec, truncated, width, height, sceneCuts = [], audio } = analysis;
  const fmt = (list, limit) => (list.length ? list.slice(0, limit).join(', ') : 'tidak ada');
  const lines = [
    `Durasi: ${durationSec}s${truncated ? ` (hanya ${analyzedSec}s pertama yang dianalisis)` : ''}`,
    width && height ? `Resolusi: ${width}x${height} (${width >= height ? 'landscape' : 'portrait'})` : '',
    `Scene cut (detik): ${fmt(sceneCuts, 24)}`,
    audio ? `Lonjakan audio (detik): ${fmt(audio.peaks, 16)}` : 'Audio: tidak terbaca',
    audio ? `Bagian hening (detik): ${fmt(audio.silence, 12)}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}
