import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  SUBTITLE_POSITIONS,
  SUBTITLE_STYLES,
  activeWord,
  cueAt,
  drawCue,
  wrapCueText,
} from '../src/lib/subtitleBurnIn.js';
import { sliceTranscript } from '../src/lib/subtitles.js';

// Context 2D tiruan: mencatat setiap panggilan gambar supaya perilaku render
// bisa diuji tanpa canvas sungguhan (node tidak punya canvas).
function fakeCtx({ charWidth = 10 } = {}) {
  const calls = [];
  const ctx = {
    calls,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    textAlign: '',
    textBaseline: '',
    lineJoin: '',
    miterLimit: 0,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    measureText: (text) => ({ width: String(text).length * charWidth }),
    fillText: (text, x, y) => calls.push(['fillText', text, Math.round(x), Math.round(y)]),
    strokeText: (text, x, y) => calls.push(['strokeText', text, Math.round(x), Math.round(y)]),
    fillRect: (...args) => calls.push(['fillRect', ...args.map((n) => Math.round(n))]),
    beginPath: () => calls.push(['beginPath']),
    roundRect: (...args) => calls.push(['roundRect', ...args.map((n) => Math.round(n))]),
    fill: () => calls.push(['fill']),
    drawImage: (...args) => calls.push(['drawImage', ...args]),
  };
  return ctx;
}

test('wrapCueText membungkus per kata dan membatasi jumlah baris', () => {
  assert.deepEqual(wrapCueText('halo dunia', 32), ['halo dunia']);
  const lines = wrapCueText('ini kalimat yang cukup panjang untuk dibungkus jadi beberapa baris di layar', 20, 3);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(line.length <= 25, `baris terlalu panjang: ${line}`);
  assert.deepEqual(wrapCueText('   ', 20), []);
  assert.deepEqual(wrapCueText('', 20), []);
});

test('wrapCueText tidak memutus kata di tengah', () => {
  const lines = wrapCueText('bertanggungjawab sepenuhnya terhadap kesalahan ini', 18, 3);
  for (const line of lines) {
    for (const word of line.split(' ')) {
      assert.ok('bertanggungjawab sepenuhnya terhadap kesalahan ini'.includes(word), `kata rusak: ${word}`);
    }
  }
});

test('cueAt memilih cue yang aktif dan mengabaikan yang sudah lewat', () => {
  const cues = [
    { startSec: 0, endSec: 1.5, text: 'satu' },
    { startSec: 1.5, endSec: 3, text: 'dua' },
  ];
  assert.equal(cueAt(cues, 0.4).text, 'satu');
  assert.equal(cueAt(cues, 1.5).text, 'dua', 'batas bawah inklusif');
  assert.equal(cueAt(cues, 3), null, 'batas atas eksklusif');
  assert.equal(cueAt(cues, Number.NaN), null);
  assert.equal(cueAt([], 1), null);
});

test('activeWord mengembalikan kata pada detik tertentu', () => {
  const words = [
    { word: 'halo', start: 0, end: 0.4 },
    { word: 'dunia', start: 0.4, end: 0.9 },
  ];
  assert.equal(activeWord(words, 0.1), 'halo');
  assert.equal(activeWord(words, 0.5), 'dunia');
  assert.equal(activeWord(words, 2), '');
  assert.equal(activeWord(null, 1), '');
});

test('drawCue template boxed menggambar kotak dan teks', () => {
  const ctx = fakeCtx();
  const result = drawCue(ctx, { text: 'halo dunia' }, { width: 720, height: 1280, template: 'boxed' });
  assert.ok(result.fontSize >= 14);
  assert.ok(ctx.calls.some(([name]) => name === 'fillRect' || name === 'roundRect'));
  assert.deepEqual(ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text), ['halo dunia']);
  assert.equal(ctx.calls[0][0], 'save');
  assert.equal(ctx.calls.at(-1)[0], 'restore', 'state canvas harus dikembalikan');
});

test('drawCue template outline memakai stroke, clean juga', () => {
  for (const template of ['outline', 'clean']) {
    const ctx = fakeCtx();
    drawCue(ctx, { text: 'teks' }, { width: 720, height: 1280, template });
    assert.ok(ctx.calls.some(([name]) => name === 'strokeText'), `${template} harus punya outline`);
  }
  const karaoke = fakeCtx();
  drawCue(karaoke, { text: 'teks' }, { width: 720, height: 1280, template: 'karaoke' });
  assert.ok(karaoke.calls.some(([name]) => name === 'strokeText'));
});

test('drawCue karaoke menyorot kata aktif dengan warna berbeda', () => {
  const ctx = fakeCtx();
  const fills = [];
  const originalFillText = ctx.fillText;
  ctx.fillText = (text, x, y) => {
    fills.push({ text, color: ctx.fillStyle });
    originalFillText(text, x, y);
  };
  drawCue(ctx, { text: 'halo dunia' }, {
    width: 720, height: 1280, template: 'karaoke', highlightWord: 'dunia',
  });
  // Kata yang disorot harus digambar dengan warna highlight.
  const highlighted = fills.find((item) => item.text === 'dunia');
  assert.ok(highlighted, 'kata aktif harus digambar');
  assert.notEqual(highlighted.color, '#ffffff');
});

test('drawCue menghormati posisi atas, tengah, bawah', () => {
  const yFor = (position) => {
    const ctx = fakeCtx();
    drawCue(ctx, { text: 'satu' }, { width: 720, height: 1280, template: 'clean', position });
    return ctx.calls.find(([name]) => name === 'fillText')[3];
  };
  const top = yFor('top');
  const middle = yFor('middle');
  const bottom = yFor('bottom');
  assert.ok(top < middle && middle < bottom, `urutan y salah: ${top}/${middle}/${bottom}`);
  assert.ok(SUBTITLE_POSITIONS.includes('top') && SUBTITLE_POSITIONS.includes('bottom'));
});

test('drawCue aman pada input kosong dan ctx tanpa roundRect', () => {
  assert.deepEqual(drawCue(null, { text: 'x' }, { width: 100, height: 100 }), { lines: [], fontSize: 0 });
  assert.deepEqual(drawCue(fakeCtx(), null, { width: 100, height: 100 }).lines, []);
  const legacy = fakeCtx();
  delete legacy.roundRect;
  delete legacy.beginPath;
  drawCue(legacy, { text: 'halo' }, { width: 720, height: 1280, template: 'boxed' });
  assert.ok(legacy.calls.some(([name]) => name === 'fillRect'), 'fallback ke fillRect');
});

test('setiap template punya gaya yang terdefinisi', () => {
  for (const [id, style] of Object.entries(SUBTITLE_STYLES)) {
    assert.ok(style.fill, `${id} butuh fill`);
    assert.ok(style.box || style.stroke, `${id} butuh box atau stroke agar terbaca`);
  }
});

test('sliceTranscript + drawCue: subtitle klip memakai waktu relatif', () => {
  const cues = sliceTranscript([
    { startSec: 10, endSec: 12, text: 'awal klip' },
    { startSec: 20, endSec: 22, text: 'akhir klip' },
  ], 10, 25);
  assert.equal(cues[0].startSec, 0);
  const ctx = fakeCtx();
  // Detik 1 dari klip = detik 11 dari video asli.
  assert.ok(cueAt(cues, 1));
  drawCue(ctx, cueAt(cues, 1), { width: 720, height: 1280 });
  assert.equal(ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text).join(' '), 'awal klip');
});

// ---------------------------------------------------------------- bahasa otomatis

test('transcribeChunk mendukung deteksi bahasa otomatis', async () => {
  const { transcribeChunk } = await import('../src/lib/whisperTranscribe.js');
  const calls = [];
  const env = {
    AI: {
      run: async (model, input) => {
        calls.push(input);
        return {
          segments: [{ start: 0, end: 1, text: 'hello', avg_logprob: -0.2, no_speech_prob: 0 }],
          transcription_info: { language: 'en' },
        };
      },
    },
  };
  const auto = await transcribeChunk(env, new Uint8Array([1, 2]), { autoLanguage: true });
  assert.equal(calls[0].language, undefined, 'auto = tanpa parameter language');
  assert.equal(auto.language, 'en');

  await transcribeChunk(env, new Uint8Array([1, 2]), { language: 'id' });
  assert.equal(calls[1].language, 'id', 'bahasa eksplisit tetap dikirim');
});

test('POST /api/agent/transcribe meneruskan mode auto dan mengembalikan bahasa', async () => {
  const restore = withFetch();
  const inputs = [];
  const env = baseEnv({
    AI: {
      run: async (model, input) => {
        inputs.push(input);
        return {
          segments: [{ start: 0, end: 1, text: 'hello world', avg_logprob: -0.1, no_speech_prob: 0 }],
          transcription_info: { language: 'en' },
        };
      },
    },
  });
  try {
    const res = await worker.fetch(request({
      language: 'auto',
      chunks: [{ index: 0, offsetSec: 0, audio: Buffer.from('abc').toString('base64') }],
    }), env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.language, 'en');
    assert.equal(inputs[0].language, undefined);
  } finally {
    restore();
  }
});

function baseEnv(extra = {}) {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
    ...extra,
  };
}

function request(body) {
  return new Request('https://app.example/api/agent/transcribe', {
    method: 'POST',
    headers: { origin: 'https://app.example', authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function withFetch() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1' });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return () => { globalThis.fetch = realFetch; };
}

test('panel klip memakai burn-in hanya saat dicentang', async () => {
  const fs = await import('node:fs/promises');
  const panel = await fs.readFile(new URL('../src/agent/ClipPlanPanel.jsx', import.meta.url), 'utf8');
  assert.match(panel, /burnInSubtitles/, 'harus memanggil burnInSubtitles');
  assert.match(panel, /const withSubtitles = burnIn && transcript\.length > 0/);
  assert.match(panel, /trimVideoToWebm/, 'jalur tanpa subtitle tetap ada');
  assert.match(panel, /Bakar subtitle ke video/);
});
