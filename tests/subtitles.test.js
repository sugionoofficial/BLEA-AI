import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  MAX_AUDIO_BYTES,
  bytesToBase64,
  isWhisperAvailable,
  mergeTranscripts,
  normalizeTranscript,
  transcribeChunk,
} from '../src/lib/whisperTranscribe.js';
import {
  SUBTITLE_TEMPLATES,
  buildCues,
  sliceTranscript,
  splitSegment,
  toPlainText,
  toSrt,
  toVtt,
} from '../src/lib/subtitles.js';
import { downmixToMono16k, encodeWavPcm16 } from '../src/lib/audioExtract.js';

const SEGMENTS = [
  { startSec: 0, endSec: 2.5, text: 'Halo semuanya' },
  { startSec: 2.5, endSec: 6.25, text: 'hari ini aku mau bahas satu kesalahan yang bikin aku rugi sepuluh juta rupiah' },
];

test('normalizeTranscript membuang segmen halusinasi dan merapikan timestamp', () => {
  const out = normalizeTranscript({
    segments: [
      { start: 0, end: 2, text: '  Halo   semuanya ', avg_logprob: -0.4, no_speech_prob: 0.05 },
      // no_speech_prob tinggi = kemungkinan besar bukan ucapan (Whisper sering
      // mengarang "Terima kasih telah menonton" di bagian musik).
      { start: 2, end: 4, text: 'Terima kasih telah menonton', avg_logprob: -0.2, no_speech_prob: 0.92 },
      { start: 4, end: 6, text: 'teks tidak yakin', avg_logprob: -2.1, no_speech_prob: 0.1 },
      // Timestamp mundur: dipaksa mulai setelah segmen sebelumnya.
      { start: 1, end: 3, text: 'mundur', avg_logprob: -0.5, no_speech_prob: 0.1 },
      { start: 8, end: 7, text: 'terbalik', avg_logprob: -0.5, no_speech_prob: 0.1 },
    ],
  });
  assert.deepEqual(out.segments.map((s) => s.text), ['Halo semuanya', 'mundur']);
  assert.equal(out.segments[0].text, 'Halo semuanya', 'spasi ganda dirapikan');
  assert.ok(out.segments[1].startSec >= out.segments[0].endSec, 'tidak boleh tumpang tindih');
});

test('normalizeTranscript menerapkan offset potongan audio', () => {
  const out = normalizeTranscript({ segments: [{ start: 1, end: 2, text: 'a', avg_logprob: -0.3, no_speech_prob: 0 }] }, { offsetSec: 300 });
  assert.equal(out.segments[0].startSec, 301);
  assert.equal(out.segments[0].endSec, 302);
});

test('normalizeTranscript tidak meledak pada output kosong atau rusak', () => {
  assert.deepEqual(normalizeTranscript(null).segments, []);
  assert.deepEqual(normalizeTranscript({}).segments, []);
  assert.deepEqual(normalizeTranscript({ segments: [{ text: 'x' }] }).segments, [], 'tanpa timestamp dibuang');
});

test('splitSegment membagi teks panjang secara proporsional, bukan merata', () => {
  const cues = splitSegment(SEGMENTS[1], 42);
  assert.ok(cues.length > 1);
  for (const cue of cues) assert.ok(cue.text.length <= 42 || cue.text.split(' ').length === 1);
  assert.equal(cues[0].startSec, 2.5);
  assert.equal(cues[cues.length - 1].endSec, 6.25);
  for (let i = 1; i < cues.length; i += 1) assert.ok(cues[i].startSec >= cues[i - 1].startSec);
});

test('buildCues mempertahankan teks pendek apa adanya', () => {
  const cues = buildCues([SEGMENTS[0]]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Halo semuanya');
});

test('toSrt memakai format koma dan penomoran dari 1', () => {
  const srt = toSrt([{ startSec: 0, endSec: 1.5, text: 'satu' }, { startSec: 61.25, endSec: 62, text: 'dua' }]);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nsatu/);
  assert.match(srt, /\n\n2\n00:01:01,250 --> 00:01:02,000\ndua/);
  assert.ok(srt.endsWith('\n'));
});

test('toVtt memakai header WEBVTT dan titik desimal', () => {
  const vtt = toVtt([{ startSec: 1, endSec: 2.25, text: 'hai' }]);
  assert.ok(vtt.startsWith('WEBVTT\n'));
  assert.match(vtt, /00:00:01\.000 --> 00:00:02\.250\nhai/);
});

test('pembulatan milidetik tidak menghasilkan 1000 ms', () => {
  const srt = toSrt([{ startSec: 0, endSec: 5.9999, text: 'x' }]);
  assert.doesNotMatch(srt, /,1000/);
  assert.match(srt, /00:00:0[56],\d{3}/);
});

test('sliceTranscript menggeser timestamp agar relatif terhadap klip', () => {
  const cues = sliceTranscript([
    { startSec: 0, endSec: 2, text: 'sebelum klip' },
    { startSec: 10, endSec: 12, text: 'di dalam klip' },
    { startSec: 30, endSec: 32, text: 'setelah klip' },
  ], 9, 15);
  assert.deepEqual(cues.map((c) => c.text), ['di dalam klip']);
  assert.equal(cues[0].startSec, 1);
  assert.equal(cues[0].endSec, 3);
});

test('sliceTranscript memotong segmen yang melewati batas klip', () => {
  const cues = sliceTranscript([{ startSec: 5, endSec: 25, text: 'panjang' }], 10, 20);
  assert.equal(cues[0].startSec, 0);
  assert.equal(cues[0].endSec, 10);
});

test('template subtitle punya id unik dan semuanya punya catatan', () => {
  const ids = SUBTITLE_TEMPLATES.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of SUBTITLE_TEMPLATES) assert.ok(item.label && item.note);
});

test('toPlainText mengembalikan satu baris per segmen', () => {
  assert.equal(toPlainText(SEGMENTS), `${SEGMENTS[0].text}\n${SEGMENTS[1].text}`);
});

test('mergeTranscripts membuang duplikat dari overlap antar potongan', () => {
  const merged = mergeTranscripts([
    { segments: [{ startSec: 0, endSec: 5, text: 'satu' }, { startSec: 5, endSec: 10, text: 'dua' }] },
    { segments: [{ startSec: 9.7, endSec: 10, text: 'dua' }, { startSec: 10, endSec: 15, text: 'tiga' }] },
  ]);
  assert.deepEqual(merged.segments.map((s) => s.text), ['satu', 'dua', 'tiga']);
});

test('bytesToBase64 aman untuk audio besar (tidak overflow stack)', () => {
  const bytes = new Uint8Array(200_000).fill(65);
  const encoded = bytesToBase64(bytes);
  assert.equal(encoded.length, Math.ceil(200_000 / 3) * 4);
  assert.equal(Buffer.from(encoded, 'base64')[199_999], 65);
});

test('encodeWavPcm16 menulis header RIFF/WAVE yang sah', () => {
  const wav = encodeWavPcm16(new Float32Array([0, 0.5, -0.5]), 16000);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const ascii = (from, length) => String.fromCharCode(...wav.subarray(from, from + length));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 6, '3 sampel x 2 byte');
  assert.equal(wav.length, 44 + 6);
});

test('downmixToMono16k merata-ratakan kanal dan menurunkan sample rate', () => {
  const left = new Float32Array([1, 1, 1, 1]).map((v) => v * 0.5);
  const right = new Float32Array([1, 1, 1, 1]).map((v) => v * -0.5);
  const mono = downmixToMono16k([left, right], 32000, 16000);
  assert.equal(mono.length, 2);
  for (const value of mono) assert.ok(Math.abs(value) < 1e-6, 'kanal saling meniadakan');
});

test('transcribeChunk menolak audio kosong, terlalu besar, dan binding yang tidak ada', async () => {
  await assert.rejects(() => transcribeChunk({}, new Uint8Array([1])), /belum aktif/);
  const env = { AI: { run: async () => ({ text: '' }) } };
  await assert.rejects(() => transcribeChunk(env, new Uint8Array(0)), /Audio kosong/);
  await assert.rejects(
    () => transcribeChunk(env, new Uint8Array(MAX_AUDIO_BYTES + 1)),
    /melebihi batas/,
  );
  assert.equal(isWhisperAvailable({}), false);
  assert.equal(isWhisperAvailable({ AI: { run() {} } }), true);
});

test('transcribeChunk memanggil Whisper dengan base64, bahasa, dan VAD', async () => {
  const calls = [];
  const env = {
    AI: {
      run: async (model, input) => {
        calls.push({ model, input });
        return {
          segments: [{ start: 0, end: 1, text: 'halo', avg_logprob: -0.2, no_speech_prob: 0.01 }],
          text: 'halo',
        };
      },
    },
  };
  const out = await transcribeChunk(env, new Uint8Array([104, 105]), { language: 'id', offsetSec: 0 });
  assert.equal(calls[0].model, '@cf/openai/whisper-large-v3-turbo');
  assert.equal(calls[0].input.task, 'transcribe');
  assert.equal(calls[0].input.language, 'id');
  assert.equal(calls[0].input.vad_filter, true);
  assert.equal(calls[0].input.audio, Buffer.from([104, 105]).toString('base64'));
  assert.deepEqual(out.segments.map((s) => s.text), ['halo']);
});

// ---------------------------------------------------------------- endpoint HTTP

function transcribeRequest(body, { token = 'user-jwt', origin = 'https://app.example' } = {}) {
  return new Request('https://app.example/api/agent/transcribe', {
    method: 'POST',
    headers: {
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function withFetchStub(handler) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = realFetch; };
}

const baseEnv = (extra = {}) => ({
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  ...extra,
});

test('POST /api/agent/transcribe menolak tanpa token dan dari origin lain', async () => {
  const noAuth = await worker.fetch(transcribeRequest({ chunks: [] }, { token: '' }), baseEnv());
  assert.equal(noAuth.status, 401);
  const badOrigin = await worker.fetch(transcribeRequest({ chunks: [] }, { origin: 'https://evil.example' }), baseEnv());
  assert.equal(badOrigin.status, 403);
});

test('POST /api/agent/transcribe memberi 503 saat binding Workers AI absen', async () => {
  const restore = withFetchStub(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  try {
    const res = await worker.fetch(transcribeRequest({ chunks: [{ index: 0, audio: 'AAAA' }] }), baseEnv());
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /belum aktif/);
  } finally {
    restore();
  }
});

test('POST /api/agent/transcribe mengembalikan segmen gabungan', async () => {
  const restore = withFetchStub(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const aiCalls = [];
  const env = baseEnv({
    AI: {
      run: async (model, input) => {
        aiCalls.push({ model, input });
        return { segments: [{ start: 0, end: 1, text: 'halo dunia', avg_logprob: -0.2, no_speech_prob: 0 }] };
      },
    },
  });
  try {
    const res = await worker.fetch(transcribeRequest({
      chunks: [{ index: 0, offsetSec: 0, audio: Buffer.from('abc').toString('base64') }],
      durationSec: 12,
    }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.segments.map((s) => s.text), ['halo dunia']);
    assert.equal(data.durationSec, 12);
    assert.equal(aiCalls.length, 1);
  } finally {
    restore();
  }
});

test('POST /api/agent/transcribe menolak body tanpa potongan dan potongan kebanyakan', async () => {
  const restore = withFetchStub(async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    throw new Error(`Unexpected fetch: ${url}`);
  });
  const env = baseEnv({ AI: { run: async () => ({ segments: [] }) } });
  try {
    const empty = await worker.fetch(transcribeRequest({ chunks: [] }), env);
    assert.equal(empty.status, 400);
    const many = await worker.fetch(transcribeRequest({ chunks: Array.from({ length: 5 }, () => ({ audio: 'AAAA' })) }), env);
    assert.equal(many.status, 400);
  } finally {
    restore();
  }
});

test('normalizeVideoTranscript membatasi jumlah baris dan panjang teks', async () => {
  const { normalizeVideoTranscript, MAX_TRANSCRIPT_CHARS } = await import('../src/agent/tools.js');
  const many = Array.from({ length: 400 }, (_, index) => ({ startSec: index, endSec: index + 1, text: `baris ${index}` }));
  const out = normalizeVideoTranscript({ segments: many });
  assert.ok(out.text.length <= MAX_TRANSCRIPT_CHARS);
  assert.ok(out.segmentCount <= 120);
  assert.match(out.text.split('\n')[0], /^\[0s\] baris 0$/);
  const dirty = normalizeVideoTranscript({ segments: [
    { startSec: 'x', text: 'tanpa waktu' },
    { startSec: 2, text: '   spasi    ganda   ' },
    { startSec: -5, text: 'negatif' },
    null,
  ] });
  assert.equal(dirty.text, '[2s] spasi ganda');
});

test('system prompt memuat transkrip dan melarang mengarang ucapan', async () => {
  const { buildAgentSystemPrompt } = await import('../src/agent/prompts.js');
  const withTranscript = buildAgentSystemPrompt({
    skillIds: [],
    workspace: { videoAnalysis: 'Durasi: 30s', videoTranscript: '[4s] ini bikin aku rugi' },
  });
  assert.match(withTranscript, /TRANSKRIP UCAPAN/);
  assert.match(withTranscript, /\[4s\] ini bikin aku rugi/);
  assert.match(withTranscript, /JANGAN mengarang/);

  const withoutTranscript = buildAgentSystemPrompt({ skillIds: [], workspace: { videoAnalysis: 'Durasi: 30s' } });
  assert.doesNotMatch(withoutTranscript, /TRANSKRIP UCAPAN/);
  assert.match(withoutTranscript, /TIDAK mendengar ucapan/);
});

test('panel subtitle dan klip: ekspor SRT tanpa burn-in, transkrip bisa diedit', async () => {
  const fs = await import('node:fs/promises');
  const panel = await fs.readFile(new URL('../src/agent/SubtitlePanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /toSrt/, 'harus mengekspor SRT');
  assert.match(panel, /toVtt/, 'harus mengekspor VTT');
  assert.match(panel, /Edit transkrip/);
  assert.doesNotMatch(panel, /MediaRecorder|captureStream/, 'burn-in canvas belum boleh ada');
  const clip = await fs.readFile(new URL('../src/agent/ClipPlanPanel.jsx', import.meta.url), 'utf8');
  assert.match(clip, /sliceTranscript/, 'SRT per klip harus relatif ke klip');
});
