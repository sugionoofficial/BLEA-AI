// Transkripsi audio via Cloudflare Workers AI (Whisper).
//
// Dipisah dari src/worker.js supaya bisa diuji dengan binding `env.AI` tiruan.
// Tidak ada state, tidak ada akses DB: modul ini hanya menerjemahkan
// (Uint8Array audio) -> (segmen + kata bertimestamp), dan membuang hal-hal yang
// bisa merusak subtitle:
//
//   1. Halusinasi Whisper di bagian hening/musik. Model ini terkenal mengarang
//      "Terima kasih telah menonton" atau teks dari video latihannya. Segmen
//      dengan `no_speech_prob` tinggi dan `avg_logprob` rendah dibuang.
//   2. Timestamp yang tumpang tindih. Subtitle tumpang tindih tidak bisa
//      dirender; setiap segmen dipaksa mulai setelah segmen sebelumnya selesai.
//
// Batas: satu request Whisper menampung ~25MB audio (batas ini datang dari
// model aslinya, bukan dari Cloudflare). Pemanggil mengirim potongan 5 menit.

export const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
// Batas konservatif: base64 menambah 33%, dan Cloudflare membatasi ukuran body
// request. 8MB biner ~ 10,7MB base64, masih di bawah plafon 25MB model.
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const MAX_CHUNK_SECONDS = 300;

const MIN_LOGPROB = -1.2;
const MAX_NO_SPEECH = 0.6;

export function isWhisperAvailable(env) {
  return Boolean(env?.AI && typeof env.AI.run === 'function');
}

/**
 * Ubah Uint8Array menjadi base64 tanpa `btoa(String.fromCharCode(...arr))`,
 * yang meledak stack-nya pada audio beberapa MB.
 */
export function bytesToBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

/**
 * Rapikan output mentah Whisper menjadi segmen yang aman dirender sebagai
 * subtitle. Fungsi murni: tidak memanggil jaringan, sehingga bisa diuji.
 *
 * @param {{segments?:Array, words?:Array, text?:string}} raw
 * @param {{offsetSec?:number, maxChars?:number}} options offset untuk audio
 *   yang dipecah menjadi beberapa potongan (timestamp Whisper selalu relatif
 *   terhadap potongan, bukan terhadap video).
 */
export function normalizeTranscript(raw, { offsetSec = 0, maxChars = 42 } = {}) {
  const offset = Number(offsetSec) || 0;
  const rawSegments = Array.isArray(raw?.segments) ? raw.segments : [];
  const segments = [];
  let cursor = offset;

  for (const segment of rawSegments) {
    const text = String(segment?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const noSpeech = Number(segment?.no_speech_prob);
    if (Number.isFinite(noSpeech) && noSpeech > MAX_NO_SPEECH) continue;
    const logprob = Number(segment?.avg_logprob);
    if (Number.isFinite(logprob) && logprob < MIN_LOGPROB) continue;

    let start = Number(segment?.start);
    let end = Number(segment?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Rentang terbalik dibuang, bukan "diperbaiki" jadi 0,2 detik: subtitle
    // 0,2 detik tidak terbaca dan hanya menyembunyikan data yang rusak.
    if (end <= start) continue;
    start = Math.max(offset, start + offset);
    end = Math.max(start + 0.2, end + offset);
    // Timestamp tumpang tindih dipaksa urut supaya renderer tidak bingung.
    if (start < cursor) start = cursor;
    if (end <= start) continue;

    const words = (Array.isArray(segment?.words) ? segment.words : [])
      .map((word) => ({
        word: String(word?.word || '').trim(),
        start: round2(Math.max(start, Number(word?.start) + offset || start)),
        end: round2(Math.max(start, Number(word?.end) + offset || start)),
      }))
      .filter((word) => word.word && Number.isFinite(word.start) && Number.isFinite(word.end));

    segments.push({ startSec: round2(start), endSec: round2(end), text: text.slice(0, maxChars * 4), words });
    cursor = end;
  }

  return {
    segments,
    text: segments.map((segment) => segment.text).join(' ').slice(0, 20_000),
    wordCount: segments.reduce((sum, segment) => sum + segment.words.length, 0),
  };
}

/**
 * Panggil Whisper pada satu potongan audio.
 * @param {object} env Worker env (butuh binding `AI`).
 * @param {Uint8Array} audio WAV/MP3/WebM biner.
 * @param {{language?:string, offsetSec?:number, autoLanguage?:boolean}} options
 */
export async function transcribeChunk(env, audio, { language = 'id', offsetSec = 0, autoLanguage = false } = {}) {
  if (!isWhisperAvailable(env)) {
    const err = new Error('Transkripsi tidak tersedia: binding Workers AI (env.AI) belum aktif.');
    err.status = 503;
    throw err;
  }
  const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio || []);
  if (!bytes.length) {
    const err = new Error('Audio kosong.');
    err.status = 400;
    throw err;
  }
  if (bytes.length > MAX_AUDIO_BYTES) {
    const err = new Error(`Potongan audio ${(bytes.length / 1048576).toFixed(1)}MB melebihi batas ${MAX_AUDIO_BYTES / 1048576}MB.`);
    err.status = 413;
    throw err;
  }

  const input = {
    audio: bytesToBase64(bytes),
    task: 'transcribe',
    vad_filter: true,
  };
  // `language` dikosongkan = deteksi otomatis. Dipakai saat pengguna memilih
  // "deteksi otomatis"; memaksa 'id' pada video berbahasa Inggris menghasilkan
  // transkrip ngawur yang tidak bisa dideteksi dari outputnya.
  if (!autoLanguage) input.language = String(language || 'id').slice(0, 8);

  const raw = await env.AI.run(WHISPER_MODEL, input);

  // Bentuk output berbeda antar versi model; terima keduanya.
  const payload = raw?.result && !raw.segments ? raw.result : raw;
  const result = normalizeTranscript(payload, { offsetSec });
  result.language = String(payload?.transcription_info?.language || '');
  return result;
}

/**
 * Gabungkan beberapa transkrip potongan. Overlap dibuang berdasarkan teks:
 * potongan dibuat bertumpuk 0,5 detik supaya tidak ada kata yang terpotong tepat
 * di batas, dan duplikat hasil overlap itu dibuang di sini.
 */
export function mergeTranscripts(parts) {
  const segments = [];
  let language = '';
  for (const part of parts || []) {
    for (const segment of part?.segments || []) {
      const last = segments[segments.length - 1];
      if (last && segment.startSec < last.endSec - 0.05 && segment.text === last.text) continue;
      segments.push(segment);
    }
  }
  for (const part of parts || []) {
    if (!language && part?.language) language = String(part.language);
  }
  return {
    segments,
    text: segments.map((segment) => segment.text).join(' ').slice(0, 40_000),
    language,
  };
}
