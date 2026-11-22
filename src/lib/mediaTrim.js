// Pemotongan media sisi klien (fitur "cut"): tidak ada ffmpeg di Cloudflare
// Workers, jadi pemotongan dilakukan di browser memakai Web API bawaan —
// Web Audio API (decode + slice + encode WAV) untuk audio, dan
// HTMLVideoElement.captureStream() + MediaRecorder (re-encode WebM) untuk
// video. Hasilnya lalu diunggah ke Supabase Storage oleh pemanggil.

function writeAsciiString(view, offset, str) {
  for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
}

function audioBufferToWavBlob(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  writeAsciiString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAsciiString(view, 8, 'WAVE');
  writeAsciiString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAsciiString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channelData = [];
  for (let ch = 0; ch < numChannels; ch += 1) channelData.push(buffer.getChannelData(ch));
  let offset = 44;
  for (let i = 0; i < numFrames; i += 1) {
    for (let ch = 0; ch < numChannels; ch += 1) {
      let sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, sample, true);
      offset += 2;
    }
  }
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

// Memotong audio dari `sourceUrl` ke rentang [startSec, endSec] dan
// mengembalikan Blob WAV PCM16 (lossless terhadap hasil decode).
export async function trimAudioToWav(sourceUrl, startSec, endSec) {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error('Gagal mengambil audio sumber untuk dipotong.');
  const arrayBuffer = await res.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Browser ini tidak mendukung Web Audio API.');
  const ctx = new AudioCtx();
  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('Gagal membaca format audio sumber (mungkin tidak didukung browser).');
  }
  const duration = audioBuffer.duration;
  const start = Math.max(0, Math.min(Number(startSec) || 0, duration));
  const end = Math.max(start + 0.05, Math.min(Number(endSec) || duration, duration));
  const sampleRate = audioBuffer.sampleRate;
  const startFrame = Math.floor(start * sampleRate);
  const endFrame = Math.floor(end * sampleRate);
  const frameCount = Math.max(1, endFrame - startFrame);
  const numChannels = audioBuffer.numberOfChannels;
  const trimmed = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let ch = 0; ch < numChannels; ch += 1) {
    const src = audioBuffer.getChannelData(ch).subarray(startFrame, endFrame);
    if (trimmed.copyToChannel) trimmed.copyToChannel(src, ch);
    else trimmed.getChannelData(ch).set(src);
  }
  try { await ctx.close?.(); } catch { /* ignore */ }
  return audioBufferToWavBlob(trimmed);
}

// Memotong video dari `sourceUrl` ke rentang [startSec, endSec] dengan
// memutar ulang lalu merekam via captureStream()+MediaRecorder. Hasilnya
// WebM (video+audio bila ada) — format berubah dari sumber asli, tapi ini
// satu-satunya jalur potong video tanpa ffmpeg yang tersedia di browser.
export async function trimVideoToWebm(sourceUrl, startSec, endSec, { onProgress } = {}) {
  if (typeof window === 'undefined' || !window.MediaRecorder) {
    throw new Error('Browser ini tidak mendukung perekaman video (MediaRecorder).');
  }
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = false;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;';
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { video.pause(); } catch { /* ignore */ }
      try { video.src = ''; video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
      try { video.remove(); } catch { /* ignore */ }
      fn(arg);
    };

    video.onerror = () => finish(reject, new Error('Gagal memuat video sumber untuk dipotong.'));
    video.onloadedmetadata = () => {
      const duration = video.duration;
      const start = Math.max(0, Math.min(Number(startSec) || 0, duration));
      const end = Math.max(start + 0.2, Math.min(Number(endSec) || duration, duration));
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        let stream;
        try {
          stream = typeof video.captureStream === 'function' ? video.captureStream() : video.mozCaptureStream();
        } catch {
          return finish(reject, new Error('Browser ini tidak mendukung captureStream() untuk memotong video.'));
        }
        if (!stream) return finish(reject, new Error('Browser ini tidak mendukung captureStream() untuk memotong video.'));

        const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
        const mimeType = candidates.find((t) => window.MediaRecorder.isTypeSupported?.(t)) || 'video/webm';
        let recorder;
        try {
          recorder = new MediaRecorder(stream, { mimeType });
        } catch {
          return finish(reject, new Error('Gagal menyiapkan perekam video di browser ini.'));
        }
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onerror = () => finish(reject, new Error('Perekaman video gagal di tengah proses.'));
        recorder.onstop = () => {
          if (!chunks.length) return finish(reject, new Error('Hasil potongan video kosong.'));
          finish(resolve, new Blob(chunks, { type: mimeType }));
        };

        let rafId = null;
        const safetyTimer = setTimeout(() => {
          if (recorder.state !== 'inactive') recorder.stop();
        }, (end - start) * 1000 + 10_000);

        const tick = () => {
          if (settled) return;
          if (video.currentTime >= end || video.ended) {
            clearTimeout(safetyTimer);
            if (recorder.state !== 'inactive') recorder.stop();
            return;
          }
          if (onProgress) onProgress(Math.min(1, (video.currentTime - start) / (end - start)));
          rafId = requestAnimationFrame(tick);
        };

        recorder.start();
        video.play().then(() => { rafId = requestAnimationFrame(tick); }).catch((err) => {
          clearTimeout(safetyTimer);
          if (recorder.state !== 'inactive') recorder.stop();
          finish(reject, new Error(`Gagal memutar video untuk direkam: ${err?.message || err}`));
        });
        void rafId;
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = start;
    };

    document.body.appendChild(video);
    video.src = sourceUrl;
  });
}
