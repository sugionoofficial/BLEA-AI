import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const session = { access_token: 'mock-session', user: { id: 'user-1', email: 'user@example.com', app_metadata: { role: 'user' }, user_metadata: {} } };
const generation = { id: 'gen-ali-1', provider: 'alibaba', status: 'submitted', image_url: null, prompt: 'Rubah di kabut', model: 'wan2.7-image', credits_charged: 80, credits_refunded: 0, created_at: '2026-11-20T05:10:20Z', canPoll: true };
const configWithModels = {
  ok: true,
  model_id: 122,
  credits: 15,
  provider_ready: true,
  ceiling: 50,
  min_margin: 1,
  models: [
    { provider: 'freebeat', model: '122', name: 'Freebeat: model 122', credits: 15, ready: true, params: null },
    { provider: 'alibaba', model: 'wan2.7-image', name: 'Alibaba: Wan 2.7 Image', credits: 80, ready: true, params: { sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1 } },
  ],
};

async function mount(GenerateImagePanel, React, MemoryRouter, AuthProvider, root, supabase, mock) {
  const { act } = React;
  const calls = [];
  const oldGet = supabase.auth.getSession, oldOn = supabase.auth.onAuthStateChange, oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  globalThis.fetch = async (url, init) => mock(url, init, calls);
  await act(async () => root.render(
    React.createElement(MemoryRouter, { initialEntries: ['/generate'] },
      React.createElement(AuthProvider, { initialSession: session }, React.createElement(GenerateImagePanel))),
  ));
  return {
    calls,
    unmount: async () => {
      await act(async () => root.unmount());
      supabase.auth.getSession = oldGet; supabase.auth.onAuthStateChange = oldOn; globalThis.fetch = oldFetch;
      await supabase.auth.dispose();
    },
  };
}

test('panel generate gambar: memilih model Alibaba mengirim provider/model/size/n', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] } });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GenerateImagePanel } = await vite.ssrLoadModule('/src/auth/GenerateImagePanel.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
  const root = createRoot(document.getElementById('root'));
  const fetchMock = (url, init, calls) => {
    calls.push([url, init?.method || 'GET', init?.body ? String(init.body) : '']);
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/image/config') return Response.json(configWithModels);
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    if (url === '/api/image/generate') return Response.json({ ok: true, status: 'submitted', credits: 80, generation });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 500 });
    throw new Error(`Unexpected call ${url}`);
  };
  const handle = await mount(GenerateImagePanel, React, MemoryRouter, AuthProvider, root, supabase, fetchMock);
  const { calls } = handle;
  try {
    // Selector model menampilkan keduanya; default tetap freebeat (model pertama yang ready).
    const selects = [...document.querySelectorAll('select')];
    const modelSelect = selects[0];
    assert.ok(modelSelect, 'ada selector model');
    assert.match(modelSelect.textContent, /\[Alibaba\] Wan 2\.7 Image · 80 kredit/);
    assert.doesNotMatch(modelSelect.textContent, /Alibaba:\s*Wan 2\.7 Image/);
    assert.match(document.body.textContent, /Model 122/);

    // Pilih Alibaba.
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set.call(modelSelect, 'alibaba:wan2.7-image');
      modelSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.match(document.querySelector('.generate-model-trigger').textContent, /Alibaba.*Wan 2\.7 Image.*80 kredit/);
    assert.doesNotMatch(document.body.textContent, /80 kredit BLEA per gambar/);

    // Parameter khusus model tampil (ukuran 1K/2K).
    const sizeSelect = [...document.querySelectorAll('select')].find((el) => [...el.options].some((o) => o.value === '1K'));
    assert.ok(sizeSelect, 'selector ukuran 1K/2K tampil');

    const prompt = document.querySelector('textarea');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Rubah di kabut'); prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    const submit = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Buat gambar'));
    assert.equal(submit.disabled, false);
    await React.act(async () => submit.click());

    const generateCall = calls.find(([path]) => path === '/api/image/generate');
    assert.equal(generateCall[1], 'POST');
    const payload = JSON.parse(generateCall[2]);
    assert.equal(payload.provider, 'alibaba');
    assert.equal(payload.model, 'wan2.7-image');
    assert.equal(payload.size, '2K');
    assert.equal(payload.n, 1);
    assert.match(document.body.textContent, /Permintaan diterima \(80 kredit BLEA\)/);
  } finally {
    await handle.unmount();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
