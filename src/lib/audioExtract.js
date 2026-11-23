// Ekstraksi audio dari video/lagu di browser agar bisa ditranskripsi Worker.
//
// Kenapa di browser: Cloudflare Worker tidak bisa men-decode video. Memberi
// Whisper file video 100MB akan gagal dua kali — karena Worker tidak punya
// ffmpeg, dan karena batas ~25MB milik model. Jadi yang dikirim ke server adalah
// WAV mono 16kHz per potongan 5 menit (≈9,6MB), bukan video aslinya.
//
// 16kHz mono dipilih karena itu yang dipakai Whisper secara internal; menaikkan
// sample rate hanya menambah byte tanpa menambah akurasi.

export const CHUNK_SECONDS = 300;   // 5 menit per request
export const TARGET_SAMPLE_RATE = 16_000;
export const OVERLAP_SECONDS = 0.5; // agar tidak ada kata terpotong di batas

export function isAudioExtractionSupported() {
  if (typeof window === 'undefined') return false;
  return Boolean((window.AudioContext || window.webkitAudioContext) && typeof fetch === 'function');
}

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
}

/** WAV PCM16 mono — format paling sederhana yang diterima Whisper. */
export function encodeWavPcm16(samples, sampleRate = TARGET_SAMPLE_RATE) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiString(view, 8, 'WAVE');
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

/**
 * Downmix ke mono lalu resample ke 16kHz dengan rata-rata per bucket.
 * Resampling seadanya ini cukup untuk ASR: Whisper sendiri memakai mel-filterbank
 * 16kHz dan tidak sensitif terhadap preset low-pass yang lebih bagus.
 */
export function downmixToMono16k(channelData, sourceRate, targetRate = TARGET_SAMPLE_RATE) {
  const channels = channelData?.length || 0;
  const length = channels ? channelData[0].length : 0;
  if (!length) return new Float32Array(0);
  const mono = new Float32Array(length);
  for (let ch = 0; ch < channels; ch += 1) {
    const data = channelData[ch];
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / channels;
  }
  if (sourceRate === targetRate) return mono;
  const ratio = sourceRate / targetRate;
  const outLength = Math.floor(length / ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const from = Math.floor(i * ratio);
    const to = Math.min(length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = from; j < to; j += 1) sum += mono[j];
    out[i] = to > from ? sum / (to - from) : 0;
  }
  return out;
}

/**
 * Decode media apa pun yang didukung browser, lalu kembalikan potongan WAV.
 * @returns {Promise<{durationSec:number, chunks:Array<{index:number, offsetSec:number, bytes:Uint8Array}>}>}
 */
export async function extractAudioChunks(sourceUrl, {
  onProgress,
  chunkSeconds = CHUNK_SECONDS,
  overlapSeconds = OVERLAP_SECONDS,
  maxSeconds = 3600,
} = {}) {
  if (!isAudioExtractionSupported()) throw new Error('Ekstraksi audio hanya tersedia di browser.');
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error('Berkas sumber gagal diambil untuk diekstrak audionya.');
  const arrayBuffer = await response.arrayBuffer();

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  let decoded;
  try {
    // decodeAudioData men-decode track audio dari container video (mp4/webm)
    // selama codec-nya didukung browser — tidak perlu ekstraksi terpisah.
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('Audio berkas ini tidak bisa dibaca browser (codec tidak didukung atau tidak ada audio).');
  } finally {
    try { await ctx.close?.(); } catch { /* ignore */ }
  }

  const channelData = [];
  for (let ch = 0; ch < decoded.numberOfChannels; ch += 1) channelData.push(decoded.getChannelData(ch));
  const mono = downmixToMono16k(channelData, decoded.sampleRate);
  const rate = TARGET_SAMPLE_RATE;
  const totalSeconds = Math.min(mono.length / rate, maxSeconds);

  const chunks = [];
  const step = Math.max(30, chunkSeconds - overlapSeconds);
  for (let offset = 0, index = 0; offset < totalSeconds; offset += step, index += 1) {
    const end = Math.min(totalSeconds, offset + chunkSeconds);
    const from = Math.floor(offset * rate);
    const to = Math.floor(end * rate);
    if (to <= from) break;
    const slice = mono.subarray(from, to);
    chunks.push({ index, offsetSec: Math.round(offset * 100) / 100, bytes: encodeWavPcm16(slice, rate) });
    onProgress?.(Math.min(1, end / totalSeconds));
    if (end >= totalSeconds) break;
  }

  return { durationSec: Math.round(totalSeconds * 100) / 100, chunks };
}
