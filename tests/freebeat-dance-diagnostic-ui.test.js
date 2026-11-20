import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('FreebeatDanceDiagnostic uploads audio, supports dancer photos, accept_unknown_cost, preparing state, task result, and agent messages', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatDanceDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatDanceDiagnostic.jsx');

  const calls = [];
  const storageCalls = [];
  const storage = {
    from: () => ({
      upload: async (path) => { storageCalls.push(['upload', path]); return { error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.example/${path}` } }),
      remove: async ([path]) => { storageCalls.push(['remove', path]); return { data: [{ name: path }], error: null }; },
    }),
  };

  let submitStep = 0;
  const request = async (...args) => {
    calls.push(args);
    const action = args[0];
    if (action === 'dance-upload-audio') return { music_id: 'music:001', status: 'ready', retry_after_seconds: null };
    if (action === 'dance-quote') return { quote: { status: 'unavailable' }, credits: null, cost_mode: 'accept_unknown_cost' };
    if (action === 'dance-prepare') {
      return {
        approval: 'dance-ticket',
        parameters: args[2],
        credits: null,
        max_credits: null,
        accept_unknown_cost: true,
        cost_mode: 'accept_unknown_cost',
        expiresAt: Date.now() + 60000,
      };
    }
    if (action === 'dance-submit') {
      submitStep += 1;
      if (submitStep === 1) return { status: 'preparing', music_id: '555666', retry_after_seconds: 8 };
      return { id: 'dance-row-1', status: 'submitted', session_url: 'https://freebeat.ai/session/dance-1' };
    }
    if (action === 'dance-tests') {
      return {
        tests: submitStep >= 2 ? [{
          id: 'dance-row-1',
          music_id: '555666',
          aspect_ratio: '9:16',
          auto_mode: true,
          accept_unknown_cost: true,
          status: 'submitted',
          session_url: 'https://freebeat.ai/session/dance-1',
          created_at: new Date().toISOString(),
          canPoll: true,
        }] : [],
      };
    }
    if (action === 'dance-task') {
      return {
        task: {
          status: 'completed',
          message: 'Video selesai',
          billing: { charged: 920, refunded: null, net: 920, refund_state: null },
          videos: ['https://cdn.example/final-dance.mp4'],
          cover_url: 'https://cdn.example/final-cover.jpg',
          failure: null,
        },
      };
    }
    if (action === 'dance-session') {
      return {
        session: {
          status: 'waiting_user',
          stage: 'preview',
          latest_message: 'Apakah tempo cocok?',
          messages: [{ role: 'agent', text: 'Silakan tinjau klip uji.' }],
          media: ['https://cdn.example/clip1.mp4'],
        },
      };
    }
    if (action === 'dance-message') {
      return {
        reply: 'Lanjut render final.',
        session: { status: 'running', stage: 'render', latest_message: 'Rendering', messages: [], media: [] },
      };
    }
    throw new Error(`Unexpected action ${action}`);
  };

  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label);
  const setVal = async (el, val) => {
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, val);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  try {
    await React.act(async () => root.render(React.createElement(FreebeatDanceDiagnostic, {
      connected: true,
      imageAccess: true,
      loading: false,
      request,
      userId: '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5',
      storage,
    })));

    // 1. Upload audio file to Supabase Storage and register via upload_audio
    const fileInput = document.querySelector('input[type=file][accept="audio/*"]');
    const audioFile = new dom.window.File(['mp3data'], 'song.mp3', { type: 'audio/mpeg' });
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [audioFile] });
    await React.act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    assert.equal(storageCalls.length, 1);

    await React.act(async () => button('Daftarkan audio ke Freebeat (upload_audio)').click());
    const musicInput = document.querySelector('input[placeholder*="upload_audio"]');
    assert.equal(musicInput.value, 'music:001');

    // 2. Add a dancer photo URL
    const dancerUrlInput = document.querySelectorAll('input[type=url]')[1];
    await setVal(dancerUrlInput, 'https://cdn.example/dancer.jpg');
    await React.act(async () => button('Tambah foto').click());
    assert.match(document.body.textContent, /https:\/\/cdn\.example\/dancer\.jpg/);

    // 3. Prepare -> handles accept_unknown_cost + preparing response cleanly
    await React.act(async () => button('Siapkan persetujuan dance').click());
    assert.match(document.body.textContent, /accept_unknown_cost: true/);
    const checkboxes = [...document.querySelectorAll('input[type=checkbox]')];
    await React.act(async () => checkboxes[checkboxes.length - 2].click());
    assert.equal(button('Setujui dan kirim dance video').disabled, true);
    await React.act(async () => checkboxes[checkboxes.length - 1].click());
    assert.equal(button('Setujui dan kirim dance video').disabled, false);

    await React.act(async () => button('Setujui dan kirim dance video').click());
    assert.equal(musicInput.value, '555666');
    assert.match(document.body.textContent, /preparing/);

    // 4. Re-prepare with returned numeric music_id and submit
    await React.act(async () => button('Siapkan persetujuan dance').click());
    const checkboxes2 = [...document.querySelectorAll('input[type=checkbox]')];
    await React.act(async () => checkboxes2[checkboxes2.length - 2].click());
    await React.act(async () => checkboxes2[checkboxes2.length - 1].click());
    await React.act(async () => button('Setujui dan kirim dance video').click());

    // 5. Poll task result & inspect session + send message
    await React.act(async () => button('Periksa status & hasil').click());
    assert.ok([...document.querySelectorAll('a')].some((a) => a.href === 'https://cdn.example/final-dance.mp4'));
    assert.ok([...document.querySelectorAll('a')].some((a) => a.href === 'https://cdn.example/final-cover.jpg'));

    await React.act(async () => button('Lihat sesi sutradara').click());
    assert.match(document.body.textContent, /Silakan tinjau klip uji/);

    const msgInput = document.querySelector('input[placeholder*="koreografi rooftop"]');
    await setVal(msgInput, 'Ganti musik intro sedikit lebih cepat');
    await React.act(async () => button('Kirim pesan ke sutradara').click());
    assert.match(document.body.textContent, /Lanjut render final/);
  } finally {
    await React.act(async () => root.unmount());
    await vite.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.HTMLElement;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
