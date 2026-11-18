import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Wan diagnostics request only help and quote and invalidate quote on edits', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  const request = async (...args) => { calls.push(args); return args[0] === 'video-help' ? { help: { modes: ['image'] } } : { quote: { status: 'quoted', credits: 12 } }; };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  async function setValue(input, value) {
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  }
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, loading: false, request })));
    assert.equal(button('Periksa quote Wan 3.0').disabled, true);
    await React.act(async () => button('Periksa informasi Wan 3.0').click());
    assert.deepEqual(calls[0], ['video-help', 'POST', {}]);
    assert.ok(document.querySelector('[aria-label="Informasi Wan 3.0 yang disaring"]'));
    await setValue(document.querySelector('input[type=text]'), 'Kucing berjalan');
    await setValue(document.querySelector('input[type=url]'), 'https://images.example/cat.png');
    assert.equal(button('Periksa quote Wan 3.0').disabled, false);
    await React.act(async () => button('Periksa quote Wan 3.0').click());
    assert.deepEqual(calls[1], ['video-quote', 'POST', { prompt: 'Kucing berjalan', image_url: 'https://images.example/cat.png' }]);
    const quoteText = document.querySelector('[aria-label="Quote video yang disaring"]').value;
    assert.doesNotMatch(quoteText, /Kucing|images.example/);
    assert.equal(JSON.parse(quoteText).duration, 5);
    assert.equal(JSON.parse(quoteText).resolution, '480p');
    await setValue(document.querySelector('input[type=text]'), 'Kucing berlari');
    assert.equal(document.querySelector('[aria-label="Quote video yang disaring"]'), null);
    assert.equal(calls.length, 2);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('admin explicitly uploads a public image, uses its link for quote and deletes it', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [], storageCalls = [];
  const storage = { from: () => ({
    upload: async (path) => { storageCalls.push(['upload', path]); return { error: null }; },
    getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.example/${path}` } }),
    remove: async ([path]) => { storageCalls.push(['remove', path]); return { data: [{ name: path }], error: null }; },
  }) };
  const request = async (...args) => { calls.push(args); return { quote: { status: 'quoted', credits: 10 } }; };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, loading: false, request, storage, userId: '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5' })));
    const file = new dom.window.File(['png'], 'personal.png', { type: 'image/png' });
    const input = document.querySelector('input[type=file]');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await React.act(async () => input.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    assert.equal(button('Upload gambar ke Supabase').disabled, true);
    await React.act(async () => document.querySelector('input[type=checkbox]').click());
    assert.equal(button('Upload gambar ke Supabase').disabled, false);
    await React.act(async () => button('Upload gambar ke Supabase').click());
    assert.equal(storageCalls.length, 1);
    const url = document.querySelector('input[type=url]').value;
    assert.equal(url, `https://storage.example/${storageCalls[0][1]}`);
    assert.equal(calls.length, 0);
    const prompt = document.querySelector('input[type=text]');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(prompt, 'Kucing berjalan'); prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await React.act(async () => button('Periksa quote Wan 3.0').click());
    assert.deepEqual(calls[0], ['video-quote', 'POST', { prompt: 'Kucing berjalan', image_url: url }]);
    await React.act(async () => button('Hapus gambar dari Supabase').click());
    assert.deepEqual(storageCalls[1], ['remove', storageCalls[0][1]]);
    assert.equal(document.querySelector('input[type=url]').value, '');
    assert.equal(document.querySelector('[aria-label="Quote video yang disaring"]'), null);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('video generation requires fresh quote and explicit one-time consent', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  const request = async (...args) => {
    calls.push(args);
    if (args[0] === 'video-prepare') return { approval: 'encrypted-ticket', settings: { model_id: 182, generation_type: 'image', duration: 5, resolution: '480p' }, prompt: args[2].prompt, image_url: args[2].image_url, credits: 50, expiresAt: Date.now() + 60000 };
    if (args[0] === 'video-tests') return { tests: [] };
    if (args[0] === 'video-submit') return { status: 'submitted' };
    throw new Error('unexpected action');
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  async function change(selector, value) { const input = document.querySelector(selector); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request })));
    await change('input[type=text]', 'Kucing berjalan'); await change('input[type=url]', 'https://images.example/cat.png');
    await React.act(async () => button('Siapkan quote video untuk persetujuan').click());
    assert.deepEqual(calls.map((c) => c[0]), ['video-prepare', 'video-tests']);
    assert.equal(button('Setujui dan kirim satu video').disabled, true);
    await React.act(async () => document.querySelectorAll('input[type=checkbox]')[1].click());
    assert.equal(button('Setujui dan kirim satu video').disabled, false);
    await change('input[type=text]', 'Kucing tidur');
    assert.equal(button('Setujui dan kirim satu video'), undefined);
    await React.act(async () => button('Siapkan quote video untuk persetujuan').click());
    await React.act(async () => document.querySelectorAll('input[type=checkbox]')[1].click());
    await React.act(async () => button('Setujui dan kirim satu video').click());
    assert.equal(calls.filter((c) => c[0] === 'video-submit').length, 1);
    assert.deepEqual(calls.find((c) => c[0] === 'video-submit'), ['video-submit', 'POST', { approval: 'encrypted-ticket', confirm: true }]);
    assert.equal(button('Setujui dan kirim satu video'), undefined);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
