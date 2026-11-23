// Burn-in subtitle ke video, di browser.
//
// Kenapa di browser: Worker tidak punya ffmpeg dan tidak bisa men-decode video.
// Jadi satu-satunya jalur tanpa server adalah menggambar frame video ke
// <canvas>, menulis teks di atasnya, lalu merekam canvas + track audio asli
// dengan MediaRecorder. Konsekuensi yang harus diterima:
//
//   * REALTIME. Klip 40 detik butuh ~40 detik rekam. Tidak ada jalan pintas
//     tanpa encoder di server.
//   * RE-ENCODE. Hasilnya bukan video asli lagi; bitrate dan resolusi mengikuti
//     pengaturan perekam, jadi kualitas bisa turun sedikit.
//   * AUDIO DIPISAH. captureStream() dari canvas TIDAK membawa audio; track
//     audio harus diambil dari elemen <video> lewat Web Audio dan digabung
//     manual. Kalau bagian ini gagal, hasilnya video bisu — karena itu kegagalan
//     audio diperlakukan sebagai error fatal, bukan diabaikan.
//
// Fungsi gambar (wrapCueText, cueAt, drawCue) sengaja dipisah dari perekaman
// supaya bisa diuji dengan ctx tiruan tanpa browser.

export const SUBTITLE_SAFE_MARGIN = 0.06; // 6% tinggi frame dari tepi bawah
export const SUBTITLE_MAX_LINES = 3;

/**
 * Bungkus teks subtitle menjadi beberapa baris. Canvas tidak punya pembungkusan
 * otomatis multi-baris, jadi ini harus dihitung sendiri. Pemotongan dilakukan
 * per kata — memotong per karakter akan memutus kata di tengah.
 */
export function wrapCueText(text, maxChars = 32, maxLines = SUBTITLE_MAX_LINES) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);
  return lines;
}

/**
 * Cue yang aktif pada detik `time` (relatif terhadap awal video/klip).
 * Dipisah supaya renderer dan test memakai aturan yang sama: cue terakhir yang
 * sudah mulai dipilih, dan cue yang sudah lewat diabaikan.
 */
export function cueAt(cues, time) {
  const t = Number(time);
  if (!Number.isFinite(t)) return null;
  for (const cue of cues || []) {
    if (t >= cue.startSec && t < cue.endSec) return cue;
  }
  return null;
}

export const SUBTITLE_STYLES = {
  clean: {
    fill: '#ffffff',
    stroke: 'rgba(0,0,0,0.85)',
    lineWidth: 0.09,     // relatif terhadap ukuran font
    box: null,
    fontScale: 1,
  },
  boxed: {
    fill: '#ffffff',
    stroke: null,
    box: 'rgba(0,0,0,0.72)',
    padding: 0.55,       // relatif terhadap ukuran font
    fontScale: 1,
  },
  outline: {
    fill: '#ffe600',
    stroke: '#000000',
    lineWidth: 0.16,
    box: null,
    fontScale: 1.15,
    bold: true,
  },
  karaoke: {
    fill: '#ffffff',
    stroke: 'rgba(0,0,0,0.85)',
    lineWidth: 0.09,
    box: null,
    highlight: '#22d3ee',
    fontScale: 1.05,
    bold: true,
  },
};

export const SUBTITLE_POSITIONS = ['bottom', 'middle', 'top'];

/**
 * Gambar satu cue ke context 2D.
 *
 * @param {object} ctx context 2D (atau tiruan dengan method yang sama saat test)
 * @param {{text:string}} cue
 * @param {object} options
 */
export function drawCue(ctx, cue, {
  width,
  height,
  template = 'boxed',
  position = 'bottom',
  maxChars = 32,
  highlightWord = '',
} = {}) {
  if (!ctx || !cue?.text) return { lines: [], fontSize: 0 };
  const style = SUBTITLE_STYLES[template] || SUBTITLE_STYLES.boxed;
  const fontSize = Math.max(14, Math.round(Math.min(width, height) * 0.055 * (style.fontScale || 1)));
  const lineHeight = Math.round(fontSize * 1.22);
  const lines = wrapCueText(cue.text, maxChars);
  if (!lines.length) return { lines, fontSize };

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${style.bold ? '800' : '700'} ${fontSize}px "DM Sans", "Manrope", system-ui, sans-serif`;

  const blockHeight = lines.length * lineHeight;
  const bottomY = height - height * SUBTITLE_SAFE_MARGIN;
  const blockTop = position === 'top'
    ? height * SUBTITLE_SAFE_MARGIN
    : position === 'middle'
      ? (height - blockHeight) / 2
      : bottomY - blockHeight;

  if (style.box) {
    const pad = fontSize * (style.padding || 0.5);
    const widest = lines.reduce((max, line) => Math.max(max, ctx.measureText ? ctx.measureText(line).width : line.length * fontSize * 0.55), 0);
    ctx.fillStyle = style.box;
    if (typeof ctx.roundRect === 'function' && ctx.beginPath) {
      ctx.beginPath();
      const radius = fontSize * 0.3;
      ctx.roundRect(
        (width - widest) / 2 - pad,
        blockTop - pad * 0.5,
        widest + pad * 2,
        blockHeight + pad,
        radius,
      );
      ctx.fill();
    } else if (ctx.fillRect) {
      ctx.fillRect((width - widest) / 2 - pad, blockTop - pad * 0.5, widest + pad * 2, blockHeight + pad);
    }
  }

  lines.forEach((line, index) => {
    const y = blockTop + lineHeight * index + lineHeight / 2;
    if (style.stroke) {
      ctx.lineWidth = Math.max(2, fontSize * (style.lineWidth || 0.1));
      ctx.strokeStyle = style.stroke;
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      if (ctx.strokeText) ctx.strokeText(line, width / 2, y);
    }
    // Karaoke: sorot kata yang sedang diucapkan bila timestamp per kata ada.
    if (style.highlight && highlightWord && line.includes(highlightWord) && ctx.measureText) {
      const before = line.slice(0, line.indexOf(highlightWord));
      const beforeWidth = ctx.measureText(before).width;
      const wordWidth = ctx.measureText(highlightWord).width;
      ctx.fillStyle = style.highlight;
      const startX = width / 2 - ctx.measureText(line).width / 2;
      ctx.fillText?.(highlightWord, startX + beforeWidth + wordWidth / 2, y);
      // Sisa baris digambar ulang agar kata yang disorot tidak dobel.
      ctx.fillStyle = style.fill;
      if (before) ctx.fillText?.(before, width / 2 - ctx.measureText(line).width / 2 + beforeWidth / 2, y);
      const after = line.slice(line.indexOf(highlightWord) + highlightWord.length);
      if (after) {
        ctx.fillText?.(after, startX + beforeWidth + wordWidth + ctx.measureText(after).width / 2, y);
      }
    } else {
      ctx.fillStyle = style.fill;
      if (ctx.fillText) ctx.fillText(line, width / 2, y);
    }
  });

  ctx.restore();
  return { lines, fontSize };
}

/** Kata yang sedang diucapkan pada detik `time` dari daftar kata bertimestamp. */
export function activeWord(words, time) {
  const t = Number(time);
  if (!Number.isFinite(t)) return '';
  for (const word of words || []) {
    if (t >= word.start && t < word.end) return word.word;
  }
  return '';
}

function pickRecorderMime() {
  if (typeof window === 'undefined' || !window.MediaRecorder) return '';
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // paling kompatibel dengan TikTok/IG
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const supported = candidates.find((type) => window.MediaRecorder.isTypeSupported?.(type));
  return supported || '';
}

/**
 * Rekam ulang [startSec, endSec] dengan subtitle terbakar di atas gambar.
 *
 * @returns {Promise<{blob:Blob, mimeType:string}>}
 */
export async function burnInSubtitles({
  sourceUrl,
  startSec,
  endSec,
  cues,
  words = [],
  template = 'boxed',
  position = 'bottom',
  maxChars = 32,
  onProgress,
} = {}) {
  if (typeof window === 'undefined' || !window.MediaRecorder) {
    throw new Error('Browser ini tidak mendukung perekaman video (MediaRecorder).');
  }
  const from = Math.max(0, Number(startSec) || 0);
  const to = Math.max(from + 0.2, Number(endSec) || from + 0.2);

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.preload = 'auto';
  video.muted = false;
  video.volume = 1;
  video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;';

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;
  let recorder = null;
  let rafId = 0;

  const cleanup = () => {
    if (rafId) cancelAnimationFrame(rafId);
    try { recorder?.state === 'recording' && recorder.stop(); } catch { /* ignore */ }
    try { video.pause(); } catch { /* ignore */ }
    try { video.src = ''; video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    try { video.remove(); } catch { /* ignore */ }
    try { audioCtx?.close(); } catch { /* ignore */ }
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const succeed = (blob, mimeType) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ blob, mimeType });
    };

    video.onerror = () => fail(new Error('Video sumber gagal dimuat untuk dibakar subutnya.'));

    video.onloadedmetadata = () => {
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      if (!width || !height) return fail(new Error('Resolusi video tidak terbaca.'));

      const canvas = document.createElement('canvas');
      // Lebar maksimum 1280: canvas 4K membuat perekaman tersendat dan hasilnya
      // tidak lebih baik setelah di-encode ulang di browser.
      const scale = width > 1280 ? 1280 / width : 1;
      canvas.width = Math.round(width * scale) - (Math.round(width * scale) % 2);
      canvas.height = Math.round(height * scale) - (Math.round(height * scale) % 2);
      const ctx = canvas.getContext('2d');
      if (!ctx) return fail(new Error('Canvas 2D tidak tersedia di browser ini.'));

      let stream;
      try {
        stream = canvas.captureStream(30);
      } catch {
        return fail(new Error('Browser ini tidak mendukung captureStream() pada canvas.'));
      }

      // Audio: canvas tidak punya audio. Track diambil dari elemen video lewat
      // Web Audio; kalau gagal, hasil rekaman akan bisu, jadi ini fatal.
      if (!AudioCtx) return fail(new Error('Web Audio API tidak tersedia; subtitle tidak bisa direkam bersama audio.'));
      try {
        audioCtx = new AudioCtx();
        const source = audioCtx.createMediaElementSource(video);
        const destination = audioCtx.createMediaStreamDestination();
        source.connect(destination);
        // Tetap disambungkan ke speaker supaya pengguna mendengar prosesnya.
        source.connect(audioCtx.destination);
        for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
      } catch (error) {
        return fail(new Error(`Gagal menyiapkan audio untuk rekaman: ${error?.message || error}`));
      }

      const mimeType = pickRecorderMime();
      try {
        recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined);
      } catch (error) {
        return fail(new Error(`Gagal menyiapkan perekam: ${error?.message || error}`));
      }

      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.onerror = () => fail(new Error('Perekaman gagal di tengah proses.'));
      recorder.onstop = () => {
        if (!chunks.length) return fail(new Error('Hasil rekaman kosong.'));
        succeed(new Blob(chunks, { type: mimeType || 'video/webm' }), mimeType || 'video/webm');
      };

      const draw = () => {
        if (settled) return;
        const time = video.currentTime;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const cue = cueAt(cues, time);
        if (cue) {
          const word = activeWord(words, time);
          drawCue(ctx, cue, { width: canvas.width, height: canvas.height, template, position, maxChars, highlightWord: word });
        }
        if (onProgress) onProgress(Math.min(1, Math.max(0, (time - from) / (to - from))));
        if (time >= to || video.ended) {
          if (recorder.state !== 'inactive') recorder.stop();
          return;
        }
        rafId = requestAnimationFrame(draw);
      };

      // Batas aman: kalau event `ended` tidak pernah datang (mis. video macet),
      // rekaman tetap dihentikan agar promise tidak menggantung selamanya.
      const safety = setTimeout(() => {
        if (!settled && recorder.state !== 'inactive') recorder.stop();
      }, (to - from) * 1000 + 15_000);

      video.addEventListener('seeked', () => {
        recorder.start(250);
        video.play().then(() => { rafId = requestAnimationFrame(draw); }).catch((error) => {
          clearTimeout(safety);
          fail(new Error(`Gagal memutar video untuk direkam: ${error?.message || error}`));
        });
      }, { once: true });

      video.currentTime = from;
    };

    document.body.appendChild(video);
    video.src = sourceUrl;
  });
}
