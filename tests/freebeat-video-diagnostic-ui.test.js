import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const catalog = { models: [{ model_id: 182, name: 'Wan 3.0' }, { model_id: 184, name: 'Wan 3.0 Prime' }, { model_id: 186, name: 'Model 186' }, { model_id: 192, name: 'Gemini Omni Flash' }, { model_id: 'non-numeric', name: 'Unsupported ID' }], truncated: false };
async function selectModel(React, dom, value) { await React.act(async () => { const select = document.querySelector('#freebeat-video-model'); select.value = value; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); }); }

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
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, loading: false, request, videoModels: catalog, storage, userId: '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5' })));
    await selectModel(React, dom, '182');
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
    await React.act(async () => button('Periksa quote').click());
    assert.deepEqual(calls[0], ['video-model-quote', 'POST', { model_id: 182, prompt: 'Kucing berjalan', input_mode: 'keyframe', images: [url], duration: 5, aspect_ratio: '16:9' }]);
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
    if (args[0] === 'video-prepare') return { approval: 'encrypted-ticket', settings: { model_id: args[2].model_id, generation_type: 'image', duration: 5, resolution: '480p', aspect_ratio: '9:16' }, prompt: args[2].prompt, images: args[2].images, image_url: args[2].images?.[0] || '', credits: 135, expiresAt: Date.now() + 60000 };
    if (args[0] === 'video-tests') return { tests: [] };
    if (args[0] === 'video-submit') return { status: 'submitted' };
    throw new Error('unexpected action');
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  async function change(selector, value) { const input = document.querySelector(selector); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog })));
    await change('input[type=text]', 'Kucing berjalan'); await change('input[type=url]', 'https://images.example/cat.png');
    await selectModel(React, dom, '186');
    assert.equal(button('Siapkan quote untuk persetujuan video').disabled, false);
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    assert.deepEqual(calls.map((c) => c[0]), ['video-prepare', 'video-tests']);
    assert.deepEqual(calls[0][2], { model_id: 186, prompt: 'Kucing berjalan', input_mode: 'keyframe', images: ['https://images.example/cat.png'], duration: 5, aspect_ratio: '16:9' });
    assert.match(document.body.textContent, /Model 186 · ID 186/);
    assert.match(document.body.textContent, /135 kredit Freebeat/);
    assert.equal(button('Setujui dan kirim satu video').disabled, true);
    await React.act(async () => document.querySelectorAll('input[type=checkbox]')[2].click());
    assert.equal(button('Setujui dan kirim satu video').disabled, false);
    await selectModel(React, dom, '184');
    assert.equal(button('Setujui dan kirim satu video'), undefined);
    assert.equal(button('Siapkan quote untuk persetujuan video').disabled, false);
    await selectModel(React, dom, '186');
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    await React.act(async () => document.querySelectorAll('input[type=checkbox]')[2].click());
    await change('input[type=text]', 'Kucing tidur');
    assert.equal(button('Setujui dan kirim satu video'), undefined);
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    await React.act(async () => document.querySelectorAll('input[type=checkbox]')[2].click());
    await React.act(async () => button('Setujui dan kirim satu video').click());
    assert.equal(calls.filter((c) => c[0] === 'video-submit').length, 1);
    assert.deepEqual(calls.find((c) => c[0] === 'video-submit'), ['video-submit', 'POST', { approval: 'encrypted-ticket', confirm: true }]);
    assert.equal(button('Setujui dan kirim satu video'), undefined);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('failed video status presents shareable filtered details without retrying generation', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  const request = async (action, ...args) => {
    calls.push(action);
    if (action === 'video-tests') return { tests: [{ id: 'test-id', model_id: 182, max_credits: 50, status: 'submitted', created_at: new Date().toISOString(), canPoll: true }] };
    if (action === 'video-task') return { task: { status: 'failed', billing: { charged: 0, refunded: null, net: null, refund_state: null }, videos: [], failure: { stage: null, stage_hidden: false, reason: null, reason_hidden: true, retryable: false }, item_failures: [] } };
    if (action === 'video-private-failure') { assert.deepEqual(args, ['POST', { id: 'test-id', acknowledge: true }]); return { reasons: ['Example private message'] }; }
    throw new Error('Unexpected request');
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog })));
    await React.act(async () => button('Periksa catatan uji video').click());
    await React.act(async () => button('Periksa status video').click());
    const output = document.querySelector('[aria-label="Status video dan rincian kegagalan yang disaring"]');
    assert.equal(JSON.parse(output.value).failure.reason_hidden, true);
    assert.equal(JSON.parse(output.value).billing.charged, 0);
    assert.doesNotMatch(output.value, /test-id/);
    assert.deepEqual(calls, ['video-tests', 'video-task']);
    assert.equal(button('Tampilkan pesan kegagalan pribadi').disabled, true);
    await React.act(async () => document.querySelectorAll('input[type=checkbox]')[2].click());
    await React.act(async () => button('Tampilkan pesan kegagalan pribadi').click());
    assert.match(document.body.textContent, /Example private message/);
    assert.doesNotMatch(output.value, /Example private message/);
    assert.deepEqual(calls, ['video-tests', 'video-task', 'video-private-failure']);
    await React.act(async () => button('Sembunyikan pesan pribadi').click());
    assert.doesNotMatch(document.body.textContent, /Example private message/);
    assert.equal(button('Tampilkan pesan kegagalan pribadi').disabled, true);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('one dropdown uses the live model list for help and quote and invalidates old results', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  let failQuote = false;
  const request = async (...args) => { calls.push(args); if (failQuote) throw new Error('Freebeat tidak dapat dihubungi.'); return args[0] === 'video-model-help' ? { model_id: args[2].model_id, help: { available: true } } : { settings: { model_id: args[2].model_id, generation_type: 'image', duration: 5, resolution: '480p', aspect_ratio: '9:16' }, quote: { status: 'unavailable' } }; };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  async function change(selector, value) { const input = document.querySelector(selector); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  const render = async (props) => React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog, ...props })));
  try {
    await render({ videoModels: null, videoBusy: true });
    assert.equal(document.querySelector('#freebeat-video-model').disabled, true);
    assert.match(document.querySelector('#video-quote-help').textContent, /Menunggu daftar model/);
    await render({});
    assert.equal(document.querySelectorAll('#freebeat-video-model option').length, 5);
    assert.match(document.body.textContent, /ID lain atau duplikat tidak ditampilkan/);
    assert.equal(document.querySelectorAll('input[type=text]').length, 1);
    assert.ok(document.querySelector('#freebeat-video-input-mode'));
    assert.ok(document.querySelector('#freebeat-video-resolution'));
    assert.ok(document.querySelector('#freebeat-video-aspect-ratio'));
    assert.equal(document.querySelectorAll('input[type=url]').length, 1);
    assert.equal(button('Periksa quote').disabled, true);
    await selectModel(React, dom, '192');
    await React.act(async () => button('Periksa informasi model').click());
    assert.deepEqual(calls[0], ['video-model-help', 'POST', { model_id: 192 }]);
    assert.equal(JSON.parse(document.querySelector('[aria-label="Informasi model video yang disaring"]').value).model_id, 192);
    await change('input[type=text]', 'Kucing berjalan'); await change('input[type=url]', 'https://images.example/cat.png');
    await React.act(async () => button('Periksa quote').click());
    assert.deepEqual(calls[1], ['video-model-quote', 'POST', { model_id: 192, prompt: 'Kucing berjalan', input_mode: 'keyframe', images: ['https://images.example/cat.png'], duration: 5, aspect_ratio: '16:9' }]);
    const text = document.querySelector('[aria-label="Quote video yang disaring"]').value;
    assert.equal(JSON.parse(text).model_id, 192); assert.doesNotMatch(text, /Kucing|images.example/);
    assert.equal(button('Siapkan quote untuk persetujuan video').disabled, false);
    await selectModel(React, dom, '184');
    assert.equal(document.querySelector('[aria-label="Quote video yang disaring"]'), null);
    assert.equal(document.querySelector('[aria-label="Informasi model video yang disaring"]'), null);
    await React.act(async () => button('Periksa quote').click());
    assert.equal(calls[2][2].model_id, 184);
    await change('input[type=text]', 'Kucing tidur');
    assert.equal(document.querySelector('[aria-label="Quote video yang disaring"]'), null);
    failQuote = true;
    await React.act(async () => button('Periksa quote').click());
    assert.match(document.querySelector('[role=alert]').textContent, /Freebeat tidak dapat dihubungi/);
    assert.ok(calls.every(([action]) => ['video-model-help', 'video-model-quote'].includes(action)));
    await render({ videoModels: { models: [{ model_id: 182, name: 'Wan' }], truncated: true } });
    assert.equal(document.querySelector('#freebeat-video-model').value, '');
    assert.equal(button('Periksa quote').disabled, true);
    assert.match(document.body.textContent, /dibatasi sampai 100/);
    await render({ connected: false });
    assert.equal(document.querySelector('#freebeat-video-model').disabled, true);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('admin page automatically loads the model dropdown and can retry after a catalog error', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] } });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { FreebeatPage } = await vite.ssrLoadModule('/src/auth/FreebeatPage.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
  const session = { access_token: 'mock-session', user: { id: 'admin', email: 'admin@example.com', app_metadata: { role: 'admin' }, user_metadata: {} } };
  const oldGet = supabase.auth.getSession, oldOn = supabase.auth.onAuthStateChange, oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  const calls = []; let failure = true;
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method]);
    if (url === '/api/freebeat/status') return Response.json({ connected: true, imageAccess: true });
    if (url === '/api/freebeat/video-models') return failure ? Response.json({ error: 'Katalog gagal dimuat.' }, { status: 502 }) : Response.json(catalog);
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'admin' });
    if (url.includes('/rest/v1/credit_wallets')) return new Response(JSON.stringify({ code: 'PGRST116', message: '0 rows' }), { status: 406, headers: { 'content-type': 'application/json' } });
    throw new Error(`Unexpected call ${url}`);
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/admin/freebeat'] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(FreebeatPage)))));
    assert.ok(calls.some(([path]) => path === '/api/freebeat/status'));
    assert.ok(calls.some(([path]) => path === '/api/freebeat/video-models'));
    assert.match(document.body.textContent, /Katalog gagal dimuat/);
    assert.equal(document.querySelector('#freebeat-video-model').disabled, true);
    failure = false;
    await React.act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Muat ulang model video').click());
    const select = document.querySelector('#freebeat-video-model');
    assert.equal(select.disabled, false);
    assert.equal(select.options.length, 5);
    assert.match(select.textContent, /Wan 3.0 Prime/);
    assert.equal(calls.filter(([path]) => path === '/api/freebeat/video-models').length, 2);
    assert.equal(calls.some(([path]) => path.includes('submit')), false);
  } finally {
    await React.act(async () => root.unmount());
    supabase.auth.getSession = oldGet; supabase.auth.onAuthStateChange = oldOn; globalThis.fetch = oldFetch;
    await supabase.auth.dispose();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('catalog refresh while a model quote is in flight cannot restore stale results', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  let resolveQuote;
  const request = async () => new Promise((resolve) => { resolveQuote = resolve; });
  const root = createRoot(document.getElementById('root'));
  const props = { connected: true, imageAccess: true, loading: false, request, videoModels: catalog };
  async function change(selector, value) { const input = document.querySelector(selector); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, props)));
    await selectModel(React, dom, '192');
    await change('input[type=text]', 'A prompt'); await change('input[type=url]', 'https://example.com/image.png');
    await React.act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === 'Periksa quote').click(); });
    assert.equal(typeof resolveQuote, 'function');
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { ...props, videoModels: null, videoBusy: true })));
    await React.act(async () => resolveQuote({ settings: { model_id: 192 }, quote: { status: 'quoted', credits: 20 } }));
    assert.equal(document.querySelector('[aria-label="Quote video yang disaring"]'), null);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('a prepare response for a different model cannot show a consent button', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  const request = async (...args) => { calls.push(args); return { approval: 'ticket', settings: { model_id: 182, generation_type: 'image', duration: 5, resolution: '480p' }, prompt: 'A prompt', image_url: 'https://example.com/image.png', credits: 135 }; };
  const root = createRoot(document.getElementById('root'));
  async function change(selector, value) { const input = document.querySelector(selector); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog })));
    await selectModel(React, dom, '186');
    await change('input[type=text]', 'A prompt'); await change('input[type=url]', 'https://example.com/image.png');
    await React.act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Siapkan quote untuk persetujuan video').click());
    assert.match(document.querySelector('[role=alert]').textContent, /Persetujuan tidak cocok/);
    assert.equal([...document.querySelectorAll('button')].some((b) => b.textContent === 'Setujui dan kirim satu video'), false);
    assert.deepEqual(calls.map(([name]) => name), ['video-prepare']);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('private model help needs acknowledgement and is cleared on model change or disconnect', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  const request = async (...args) => { calls.push(args); return { model_id: 186, help: { options: ['image', '480p'], description: 'private model information' }, truncated: true }; };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const render = async (props = {}) => React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog, ...props })));
  try {
    await render();
    assert.equal(button('Tampilkan informasi model privat').disabled, true);
    await selectModel(React, dom, '186');
    assert.equal(button('Tampilkan informasi model privat').disabled, true);
    const consent = [...document.querySelectorAll('label')].find((label) => label.textContent.includes('hanya akan melihatnya secara pribadi')).querySelector('input');
    await React.act(async () => consent.click());
    assert.equal(button('Tampilkan informasi model privat').disabled, false);
    await React.act(async () => button('Tampilkan informasi model privat').click());
    assert.deepEqual(calls, [['video-model-private-help', 'POST', { model_id: 186, acknowledge: true }]]);
    assert.match(document.querySelector('[aria-label="Informasi model privat"]').textContent, /private model information/);
    assert.equal(document.querySelector('textarea[aria-label="Informasi model privat"]'), null);
    assert.match(document.body.textContent, /Hasil mungkin terpotong/);
    await selectModel(React, dom, '184');
    assert.equal(document.querySelector('[aria-label="Informasi model privat"]'), null);
    assert.equal(button('Tampilkan informasi model privat').disabled, true);
    await selectModel(React, dom, '186');
    await React.act(async () => [...document.querySelectorAll('label')].find((label) => label.textContent.includes('hanya akan melihatnya secara pribadi')).querySelector('input').click());
    await React.act(async () => button('Tampilkan informasi model privat').click());
    await render({ connected: false });
    assert.equal(document.querySelector('[aria-label="Informasi model privat"]'), null);
    assert.ok(calls.every(([action]) => action === 'video-model-private-help'));
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('initial response diagnostics are optional and do not bypass separate spending consent', async () => {
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
    if (args[0] === 'video-prepare') return { approval: 'encrypted', settings: { model_id: 186, generation_type: 'image', duration: 5, resolution: '480p', aspect_ratio: '9:16' }, prompt: args[2].prompt, images: args[2].images, image_url: args[2].images?.[0] || '', credits: 135, expiresAt: Date.now() + 60000 };
    if (args[0] === 'video-tests') return { tests: [] };
    if (args[0] === 'video-submit') return { status: 'unknown', initial_diagnostics: { received: true, messages: ['Private provider detail'] } };
    throw new Error('unexpected action');
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const checkbox = (label) => [...document.querySelectorAll('label')].find((item) => item.textContent.includes(label)).querySelector('input');
  async function change(selector, value) { const input = document.querySelector(selector); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  const render = async (props = {}) => React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog, ...props })));
  try {
    await render(); await selectModel(React, dom, '186');
    await change('input[type=text]', 'Kucing berjalan'); await change('input[type=url]', 'https://images.example/cat.png');
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    assert.equal(checkbox('Opsional: tampilkan pesan respons awal').checked, false);
    await React.act(async () => checkbox('Opsional: tampilkan pesan respons awal').click());
    assert.equal(button('Setujui dan kirim satu video').disabled, true);
    assert.equal(calls.filter(([action]) => action === 'video-submit').length, 0);
    await React.act(async () => checkbox('Saya menyetujui satu kali generasi video').click());
    await React.act(async () => button('Setujui dan kirim satu video').click());
    assert.deepEqual(calls.find(([action]) => action === 'video-submit'), ['video-submit', 'POST', { approval: 'encrypted', confirm: true, private_diagnostics: true }]);
    const output = document.querySelector('[aria-label="Diagnostik respons awal privat"]');
    assert.match(output.textContent, /Private provider detail/);
    assert.match(document.querySelector('[role=alert]').textContent, /tidak pasti/);
    assert.equal(output.querySelector('textarea'), null);
    assert.equal([...output.querySelectorAll('button')].some((item) => /salin/i.test(item.textContent)), false);
    await React.act(async () => button('Sembunyikan respons awal').click());
    assert.equal(document.querySelector('[aria-label="Diagnostik respons awal privat"]'), null);
    assert.equal(calls.filter(([action]) => action === 'video-submit').length, 1);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('Freebeat image upload is optional, requires separate check and upload consent, and is cleared on URL change', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  const calls = [];
  const request = async (...args) => { calls.push(args); return args[0] === 'video-upload-check' ? { eligible: true } : { eligible: true, outcome: 'uploaded' }; };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const checkbox = (label) => [...document.querySelectorAll('label')].find((item) => item.textContent.includes(label)).querySelector('input');
  async function change(value) { const input = document.querySelector('input[type=url]'); await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
  const render = (connected = true) => React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected, imageAccess: true, loading: false, request, videoModels: catalog })));
  try {
    await render(); await change('https://images.example/cat.jpg');
    assert.equal(calls.length, 0);
    assert.equal(button('Periksa biaya dan batas upload Freebeat').disabled, true);
    await React.act(async () => checkbox('Saya mengizinkan pengiriman URL').click());
    await React.act(async () => button('Periksa biaya dan batas upload Freebeat').click());
    assert.deepEqual(calls, [['video-upload-check', 'POST', { image_url: 'https://images.example/cat.jpg', acknowledge: true }]]);
    assert.equal(button('Uji upload gambar ke Freebeat').disabled, true);
    await change('https://images.example/another.jpg');
    assert.equal(button('Uji upload gambar ke Freebeat'), undefined);
    assert.equal(checkbox('Saya mengizinkan pengiriman URL').checked, false);
    await React.act(async () => checkbox('Saya mengizinkan pengiriman URL').click());
    await React.act(async () => button('Periksa biaya dan batas upload Freebeat').click());
    await React.act(async () => checkbox('Saya menyetujui satu upload gambar').click());
    await React.act(async () => button('Uji upload gambar ke Freebeat').click());
    assert.deepEqual(calls.at(-1), ['video-upload-image', 'POST', { image_url: 'https://images.example/another.jpg', acknowledge: true }]);
    assert.match(document.body.textContent, /Freebeat melaporkan upload berhasil/);
    assert.equal(calls.filter(([action]) => action === 'video-upload-image').length, 1);
    assert.equal(calls.some(([action]) => action === 'video-submit'), false);
    await render(false);
    assert.doesNotMatch(document.body.textContent, /Freebeat melaporkan upload berhasil/);
    assert.equal(checkbox('Saya mengizinkan pengiriman URL').checked, false);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('upload preflight blocks missing cost cap; network loss after submission is uncertain', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react'); const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  let allowed = false; const calls = [];
  const request = async (action) => { calls.push(action); if (action === 'video-upload-check') return allowed ? { eligible: true } : { eligible: false, reason: 'cap_unavailable' }; throw new Error('network'); };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const checkbox = (label) => [...document.querySelectorAll('label')].find((item) => item.textContent.includes(label)).querySelector('input');
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog })));
    const input = document.querySelector('input[type=url]');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'https://images.example/cat.jpg'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await React.act(async () => checkbox('Saya mengizinkan pengiriman URL').click());
    await React.act(async () => button('Periksa biaya dan batas upload Freebeat').click());
    assert.match(document.body.textContent, /Upload diblokir/);
    assert.equal(button('Uji upload gambar ke Freebeat'), undefined);
    allowed = true;
    await React.act(async () => button('Periksa biaya dan batas upload Freebeat').click());
    await React.act(async () => checkbox('Saya menyetujui satu upload gambar').click());
    await React.act(async () => button('Uji upload gambar ke Freebeat').click());
    assert.match(document.body.textContent, /Hasil upload tidak pasti/);
    assert.equal(calls.filter((action) => action === 'video-upload-image').length, 1);
    assert.equal(button('Uji upload gambar ke Freebeat'), undefined);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('Wan 3.0 keyframe and omni_reference modes support 0-3 uploaded images, 480p/720p/1080p, 30s preset, and mode validation', async () => {
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
    remove: async (paths) => { storageCalls.push(['remove', ...paths]); return { data: paths.map((name) => ({ name })), error: null }; },
  }) };
  const request = async (...args) => {
    calls.push(args);
    if (args[0] === 'video-model-quote') {
      return {
        settings: {
          model_id: args[2].model_id,
          generation_type: args[2].input_mode === 'omni_reference' ? 'reference' : (args[2].images?.length === 2 ? 'transition' : args[2].images?.length === 1 ? 'image' : 'text'),
          duration: args[2].duration,
          resolution: args[2].resolution || '720p',
          aspect_ratio: args[2].aspect_ratio || '16:9',
        },
        quote: { status: 'quoted', credits: 120 },
      };
    }
    if (args[0] === 'video-prepare') {
      return {
        approval: 'encrypted-wan3-ticket',
        settings: {
          model_id: args[2].model_id,
          generation_type: args[2].input_mode === 'omni_reference' ? 'reference' : 'transition',
          duration: args[2].duration,
          resolution: args[2].resolution,
          aspect_ratio: args[2].aspect_ratio,
        },
        prompt: args[2].prompt,
        images: args[2].images,
        credits: 120,
        expiresAt: Date.now() + 60000,
      };
    }
    if (args[0] === 'video-tests') return { tests: [] };
    if (args[0] === 'video-submit') return { status: 'submitted' };
    throw new Error(`unexpected ${args[0]}`);
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  async function setSelect(selector, value) {
    const el = document.querySelector(selector);
    await React.act(async () => {
      el.value = value;
      el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  }
  async function setInput(selector, value) {
    const el = document.querySelector(selector);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog, storage, userId: '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5' })));
    await selectModel(React, dom, '182');
    assert.match(document.querySelector('[data-testid="mcp-generation-preview"]').textContent, /teks ke video \(text\).*0\/2 gambar/);
    await setInput('input[type=text]', 'Adegan sinematik 30 detik');
    await setSelect('#freebeat-video-resolution', '1080p');
    await setSelect('#freebeat-video-aspect-ratio', '9:16');
    await React.act(async () => button('30s').click());

    // Text-to-video quote with 0 images under Keyframe mode
    assert.equal(button('Periksa quote').disabled, false);
    await React.act(async () => button('Periksa quote').click());
    assert.deepEqual(calls[0], ['video-model-quote', 'POST', {
      model_id: 182,
      prompt: 'Adegan sinematik 30 detik',
      input_mode: 'keyframe',
      images: [],
      duration: 30,
      resolution: '1080p',
      aspect_ratio: '9:16',
    }]);

    // Upload 3 images in one batch to Supabase Storage
    const files = [
      new dom.window.File(['a'], 'ref1.png', { type: 'image/png' }),
      new dom.window.File(['b'], 'ref2.png', { type: 'image/png' }),
      new dom.window.File(['c'], 'ref3.png', { type: 'image/png' }),
    ];
    const fileInput = document.querySelector('input[type=file]');
    Object.defineProperty(fileInput, 'files', { configurable: true, value: files });
    await React.act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    await React.act(async () => document.querySelector('input[type=checkbox]').click());
    await React.act(async () => button('Upload gambar ke Supabase').click());
    assert.equal(storageCalls.filter(([kind]) => kind === 'upload').length, 3);
    const urls = [...document.querySelectorAll('input[type=url]')].map((el) => el.value);
    assert.equal(urls.length, 3);
    assert.ok(urls.every((u) => u.startsWith('https://storage.example/')));

    // Attempting 4th file is blocked cleanly (file input disabled + capacity notice + upload guard)
    assert.equal(fileInput.disabled, true);
    assert.match(document.body.textContent, /Slot gambar sudah penuh/);
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new dom.window.File(['d'], 'extra.png', { type: 'image/png' })] });
    await React.act(async () => fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true })));
    assert.equal(button('Upload gambar ke Supabase').disabled, true);

    // 3 images in Keyframe mode blocks quote with clear guidance
    assert.equal(button('Periksa quote').disabled, true);
    assert.match(document.body.textContent, /Mode Keyframe maksimal 2 gambar/);

    // Switching to Omni Reference enables quote & prepare with all 3 images -> reference
    await setSelect('#freebeat-video-input-mode', 'omni_reference');
    assert.match(document.querySelector('[data-testid="mcp-generation-preview"]').textContent, /omni reference \(reference\).*3\/3 gambar/);
    assert.equal(button('Periksa quote').disabled, false);
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    const prepareCall = calls.find(([action]) => action === 'video-prepare');
    assert.deepEqual(prepareCall[2], {
      model_id: 182,
      prompt: 'Adegan sinematik 30 detik',
      input_mode: 'omni_reference',
      images: urls,
      duration: 30,
      resolution: '1080p',
      aspect_ratio: '9:16',
    });
    assert.match(document.body.textContent, /omni reference \(reference\)/);
    assert.match(document.body.textContent, /3 URL gambar/);

    // Submit 1 video with all 3 reference images
    const consentCheckbox = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Saya menyetujui satu kali generasi video')).querySelector('input');
    await React.act(async () => consentCheckbox.click());
    await React.act(async () => button('Setujui dan kirim satu video').click());
    assert.deepEqual(calls.find(([action]) => action === 'video-submit'), ['video-submit', 'POST', { approval: 'encrypted-wan3-ticket', confirm: true }]);

    // Remove 1 uploaded image (#3) and switch back to Keyframe -> transition (2/2 images)
    await React.act(async () => button('Hapus upload #3').click());
    assert.equal(document.querySelectorAll('input[type=url]').length, 2);
    await setSelect('#freebeat-video-input-mode', 'keyframe');
    assert.match(document.querySelector('[data-testid="mcp-generation-preview"]').textContent, /First \+ Last Frame · transition.*2\/2 gambar/);

    // Remove #2 -> First Frame (image, 1/2 images)
    await React.act(async () => button('Hapus upload #2').click());
    assert.match(document.querySelector('[data-testid="mcp-generation-preview"]').textContent, /First Frame · image.*1\/2 gambar/);

    // Remove remaining uploaded image (#1) via Supabase delete button
    await React.act(async () => button('Hapus gambar dari Supabase').click());
    assert.equal(document.querySelectorAll('input[type=url]').length, 1);
    assert.equal(document.querySelector('input[type=url]').value, '');
    assert.equal(storageCalls.filter(([kind]) => kind === 'remove').length, 3);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('member_only metadata displays non-blocking note and keeps quote/prepare enabled for Wan 3.0', async () => {
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
    if (args[0] === 'video-model-quote') return { member_only: true, settings: { model_id: 182, generation_type: 'text', duration: 5, resolution: '480p', aspect_ratio: '16:9' }, quote: { status: 'quoted', credits: 50 } };
    if (args[0] === 'video-prepare') return { approval: 'ticket', member_only: true, settings: { model_id: 182, generation_type: 'text', duration: 5, resolution: '480p', aspect_ratio: '16:9' }, prompt: args[2].prompt, images: [], credits: 50, expiresAt: Date.now() + 60000 };
    if (args[0] === 'video-tests') return { tests: [] };
    throw new Error(`unexpected ${args[0]}`);
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const memberCatalog = { models: [{ model_id: 182, name: 'Wan 3.0', member_only: true, available: true }], truncated: false };
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: memberCatalog })));
    await selectModel(React, dom, '182');
    assert.match(document.body.textContent, /Wan 3\.0 · khusus member · ID 182/);
    assert.match(document.body.textContent, /Catatan metadata MCP: Freebeat menandai model ini sebagai khusus member/);
    const prompt = document.querySelector('input[type=text]');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(prompt, 'Uji Wan 3.0'); prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(button('Periksa quote').disabled, false);
    assert.equal(button('Siapkan quote untuk persetujuan video').disabled, false);
    await React.act(async () => button('Periksa quote').click());
    assert.equal(JSON.parse(document.querySelector('[aria-label="Quote video yang disaring"]').value).member_only, true);
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    assert.equal(Boolean(button('Setujui dan kirim satu video')), true);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('UI highlights zero-accepted batch summary, filtered error_code, and private failure guide', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatVideoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatVideoDiagnostic.jsx');
  let submitted = false;
  const request = async (action) => {
    if (action === 'video-prepare') return { approval: 'ticket', settings: { model_id: 182, generation_type: 'text', duration: 5, resolution: '480p', aspect_ratio: '16:9' }, prompt: 'Uji Wan 3.0', images: [], credits: 50, expiresAt: Date.now() + 60000 };
    if (action === 'video-submit') { submitted = true; return { status: 'submitted', batch_summary: { accepted_count: 0, failed_count: 1, accepted_credits: 0 } }; }
    if (action === 'video-tests') return { tests: submitted ? [{ id: 'test-182', model_id: 182, max_credits: 60, status: 'submitted', created_at: new Date().toISOString(), canPoll: true }] : [] };
    if (action === 'video-task') return { task: { status: 'failed', billing: { charged: 0, refunded: null, net: null, refund_state: null }, videos: [], failure: { stage: null, stage_hidden: false, reason: null, reason_hidden: true, retryable: null }, item_failures: [{ stage: null, stage_hidden: false, reason: null, reason_hidden: true, retryable: null, error_code: '4031' }] } };
    throw new Error(`unexpected ${action}`);
  };
  const root = createRoot(document.getElementById('root'));
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  const checkbox = (label) => [...document.querySelectorAll('label')].find((item) => item.textContent.includes(label)).querySelector('input');
  try {
    await React.act(async () => root.render(React.createElement(FreebeatVideoDiagnostic, { connected: true, imageAccess: true, loading: false, request, videoModels: catalog })));
    await selectModel(React, dom, '182');
    const prompt = document.querySelector('input[type=text]');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(prompt, 'Uji Wan 3.0'); prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await React.act(async () => button('Siapkan quote untuk persetujuan video').click());
    await React.act(async () => checkbox('Saya menyetujui satu kali generasi video').click());
    await React.act(async () => button('Setujui dan kirim satu video').click());
    assert.match(document.body.textContent, /accepted_count=0, failed_count=1, accepted_credits=0/);
    await React.act(async () => button('Periksa status video').click());
    assert.match(document.body.textContent, /Ringkasan kode kegagalan tersaring: error_code=4031/);
    assert.match(document.body.textContent, /Tampilkan pesan kegagalan pribadi/);
    assert.match(document.body.textContent, /Penyebab rinci belum tercantum pada ringkasan tersaring/);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});



