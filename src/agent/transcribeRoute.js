// POST /api/agent/transcribe
//
// Menerima audio (base64, sudah diekstrak+dipotong di browser) lalu
// mentranskripsinya lewat Whisper di Workers AI. Tidak menyimpan berkas dan
// tidak menulis ke DB: transkrip hanya dikembalikan ke klien.
//
// Kenapa browser yang mengekstrak audio: Worker tidak punya ffmpeg dan tidak
// bisa men-decode video. Kalau endpoint ini menerima video 100MB, ia hanya bisa
// meneruskannya utuh ke Whisper — yang menolak di atas ~25MB dan butuh audio.
// Kontraknya jadi: klien mengirim potongan WAV mono 16kHz 5 menit.

import { mergeTranscripts, transcribeChunk, isWhisperAvailable, MAX_AUDIO_BYTES } from '../lib/whisperTranscribe.js';

const MAX_BODY_BYTES = 12 * 1024 * 1024; // base64 dari 8MB
const MAX_CHUNKS = 4;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function base64ToBytes(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function handleTranscribe(request, env, { getUser } = {}) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origin tidak diizinkan' }, 403);

  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token) return json({ error: 'Login diperlukan' }, 401);
  const user = getUser ? await getUser(env, token) : null;
  if (!user) return json({ error: 'Token tidak sah' }, 401);

  if (!isWhisperAvailable(env)) {
    return json({ error: 'Transkripsi belum aktif: binding Workers AI (AI) tidak tersedia di deployment ini.' }, 503);
  }

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_BODY_BYTES) return json({ error: 'Body terlalu besar. Kirim potongan audio maksimal 8MB.' }, 413);

  const body = await request.json().catch(() => ({}));
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  if (!chunks.length) return json({ error: 'Tidak ada potongan audio.' }, 400);
  if (chunks.length > MAX_CHUNKS) return json({ error: `Maksimal ${MAX_CHUNKS} potongan per permintaan.` }, 400);

  const language = String(body.language || 'id').slice(0, 8);
  const results = [];
  const failures = [];

  for (const chunk of chunks) {
    const raw = typeof chunk?.audio === 'string' ? chunk.audio.replace(/^data:[^,]*,/, '') : '';
    if (!raw) {
      failures.push({ index: Number(chunk?.index) || results.length, error: 'Potongan tanpa audio.' });
      continue;
    }
    const estimatedBytes = Math.floor(raw.length * 0.75);
    if (estimatedBytes > MAX_AUDIO_BYTES) {
      failures.push({ index: Number(chunk?.index) || results.length, error: 'Potongan audio terlalu besar.' });
      continue;
    }
    try {
      const bytes = base64ToBytes(raw);
      // Diproses berurutan, bukan Promise.all: Workers AI punya batas konkurensi
      // per akun dan menabraknya hanya menghasilkan 429 yang tidak informatif.
      // eslint-disable-next-line no-await-in-loop
      const transcript = await transcribeChunk(env, bytes, {
        language,
        offsetSec: Number(chunk?.offsetSec) || 0,
      });
      results.push({ index: Number(chunk?.index) || results.length, transcript });
    } catch (err) {
      failures.push({
        index: Number(chunk?.index) || results.length,
        error: String(err?.message || err).slice(0, 200),
      });
    }
  }

  if (!results.length) {
    return json({ error: failures[0]?.error || 'Transkripsi gagal.', failures }, failures[0]?.error?.includes('tidak tersedia') ? 503 : 502);
  }

  const merged = mergeTranscripts(results.map((item) => item.transcript));
  return json({
    ok: true,
    segments: merged.segments,
    text: merged.text,
    failures,
    durationSec: Number(body.durationSec) || null,
  });
}
