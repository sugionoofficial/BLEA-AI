import { getAccessToken } from '../api/client';
import { extractAudioChunks } from '../lib/audioExtract';
import { mergeTranscripts } from '../lib/whisperTranscribe';

export const TRANSCRIBE_ENDPOINT = '/api/agent/transcribe';

/**
 * Kirim potongan audio ke Worker, satu request per potongan. Dipecah supaya
 * setiap request tetap di bawah batas body Cloudflare dan supaya kegagalan satu
 * potongan tidak membatalkan seluruh transkrip.
 */
async function postChunk({ token, audio, offsetSec, index, language, durationSec }) {
  const response = await fetch(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      language,
      durationSec,
      chunks: [{ index, offsetSec, audio }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Transkripsi gagal (HTTP ${response.status}).`);
  return data;
}

/**
 * Alur lengkap: ekstrak audio di browser → transkripsi per potongan → gabung.
 *
 * @returns {Promise<{segments:Array, text:string, failures:Array, durationSec:number}>}
 */
export async function transcribeMedia(sourceUrl, {
  language = 'id',
  onProgress,
  onStep,
} = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Sesi berakhir. Masuk ulang untuk membuat transkrip.');

  onStep?.('Mengekstrak audio di browser');
  const { durationSec, chunks } = await extractAudioChunks(sourceUrl, {
    onProgress: (value) => onProgress?.(value * 0.25),
  });
  if (!chunks.length) throw new Error('Tidak ada audio yang bisa diekstrak dari berkas ini.');

  onStep?.(`Mentranskripsi ${chunks.length} potongan audio`);
  const parts = [];
  const failures = [];
  for (const [position, chunk] of chunks.entries()) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const data = await postChunk({
        token,
        audio: bytesToBase64(chunk.bytes),
        offsetSec: chunk.offsetSec,
        index: chunk.index,
        language,
        durationSec,
      });
      parts.push(data);
    } catch (err) {
      failures.push({ index: chunk.index, offsetSec: chunk.offsetSec, error: String(err?.message || err) });
    }
    onProgress?.(0.25 + ((position + 1) / chunks.length) * 0.75);
  }

  if (!parts.length) throw new Error(failures[0]?.error || 'Transkripsi gagal pada semua potongan audio.');
  const merged = mergeTranscripts(parts.map((part) => ({ segments: part.segments })));
  return { ...merged, failures, durationSec };
}

function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
