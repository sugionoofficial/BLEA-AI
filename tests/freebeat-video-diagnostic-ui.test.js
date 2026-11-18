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
    assert.deepEqual(calls[0], ['video-model-quote', 'POST', { model_id: 182, prompt: 'Kucing berjalan', image_url: url }]);
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
    if (args[0] === 'video-prepare') return { approval: 'encrypted-ticket', settings: { model_id: args[2].model_id, generation_type: 'image', duration: 5, resolution: '480p' }, prompt: args[2].prompt, image_url: args[2].image_url, credits: 135, expiresAt: Date.now() + 60000 };
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
    assert.deepEqual(calls[0][2], { model_id: 186, prompt: 'Kucing berjalan', image_url: 'https://images.example/cat.png' });
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
  const request = async (...args) => { calls.push(args); if (failQuote) throw new Error('Freebeat tidak dapat dihubungi.'); return args[0] === 'video-model-help' ? { model_id: args[2].model_id, help: { available: true } } : { settings: { model_id: args[2].model_id, generation_type: 'image', duration: 5, resolution: '480p' }, quote: { status: 'unavailable' } }; };
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
    assert.equal(document.querySelectorAll('input[type=url]').length, 1);
    assert.equal(button('Periksa quote').disabled, true);
    await selectModel(React, dom, '192');
    await React.act(async () => button('Periksa informasi model').click());
    assert.deepEqual(calls[0], ['video-model-help', 'POST', { model_id: 192 }]);
    assert.equal(JSON.parse(document.querySelector('[aria-label="Informasi model video yang disaring"]').value).model_id, 192);
    await change('input[type=text]', 'Kucing berjalan'); await change('input[type=url]', 'https://images.example/cat.png');
    await React.act(async () => button('Periksa quote').click());
    assert.deepEqual(calls[1], ['video-model-quote', 'POST', { model_id: 192, prompt: 'Kucing berjalan', image_url: 'https://images.example/cat.png' }]);
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
    throw new Error(`Unexpected call ${url}`);
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, { initialEntries: ['/admin/freebeat'] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(FreebeatPage)))));
    assert.deepEqual(calls.map(([path]) => path), ['/api/freebeat/status', '/api/freebeat/video-models']);
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
