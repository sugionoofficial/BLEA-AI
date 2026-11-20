import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const session = { access_token: 'mock-session', user: { id: 'user-1', email: 'user@example.com', app_metadata: { role: 'user' }, user_metadata: {} } };
const configOk = { ok: true, model_id: 122, credits: 15, provider_ready: true, ceiling: 50, min_margin: 1 };
const generation = { id: 'gen-1', status: 'completed', image_url: 'https://img.example/hasil.png', prompt: 'Kucing tidur', model: '122', credits_charged: 15, credits_refunded: 0, created_at: '2026-11-20T05:10:20Z' };

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

test('panel generate gambar memotong kredit BLEA dengan model 122 (teks saja)', async () => {
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
    calls.push([url, init?.method || 'GET']);
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/image/config') return Response.json(configOk);
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    if (url === '/api/image/generate') return Response.json({ ok: true, status: 'submitted', credits: 15, generation });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 100 });
    throw new Error(`Unexpected call ${url}`);
  };
  const handle = await mount(GenerateImagePanel, React, MemoryRouter, AuthProvider, root, supabase, fetchMock);
  const { calls } = handle;
  const button = (label) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(label));
  try {
    assert.match(document.body.textContent, /model 122/);
    assert.match(document.body.textContent, /15 kredit BLEA per gambar/);
    assert.equal(button('Buat gambar').disabled, true);
    const prompt = document.querySelector('textarea');
    await React.act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(prompt, 'Kucing tidur'); prompt.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(button('Buat gambar').disabled, false);
    await React.act(async () => button('Buat gambar').click());
    assert.equal(calls.filter(([path]) => path === '/api/image/generate').length, 1);
    const generateCall = calls.find(([path]) => path === '/api/image/generate');
    assert.equal(generateCall[1], 'POST');
    assert.match(document.body.textContent, /Permintaan diterima \(15 kredit BLEA\)/);
    assert.match(document.body.textContent, /Kucing tidur/);
    // Tidak ada mode unggah/edit foto di panel pengguna.
    assert.equal(document.querySelector('input[type=file]'), null);
    assert.doesNotMatch(document.body.textContent, /mode edit/i);
  } finally {
    await handle.unmount();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('panel nonaktif saat provider belum dihubungkan', async () => {
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
    calls.push([url, init?.method || 'GET']);
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/image/config') return Response.json({ ...configOk, provider_ready: false });
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    if (String(url).includes('/rest/v1/credit_wallets')) return Response.json({ balance: 100 });
    throw new Error(`Unexpected call ${url}`);
  };
  const handle = await mount(GenerateImagePanel, React, MemoryRouter, AuthProvider, root, supabase, fetchMock);
  try {
    assert.match(document.body.textContent, /Provider gambar belum dihubungkan/);
    assert.equal(document.querySelector('textarea') !== null, true);
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Buat gambar'));
    assert.equal(button.disabled, true);
  } finally {
    await handle.unmount();
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.localStorage; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
