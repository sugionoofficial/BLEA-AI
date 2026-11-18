import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Generate image admin test prepares read-only quote and requires separate consent to submit', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', resolve: { alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }] } });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { GenerateImagePanel } = await vite.ssrLoadModule('/src/auth/GenerateImagePanel.jsx');
  const calls = [];
  const request = async (action, method, body) => {
    calls.push({ action, method, body });
    if (action === 'status') return { connected: true, imageAccess: true };
    if (action === 'image-models') return { models: [{ model_id: 80, name: 'Image Example' }] };
    if (action === 'image-tests') return { tests: [] };
    if (action === 'image-prepare') return { model_id: 80, prompt: body.prompt.trim(), credits: 23, approval: 'encrypted-receipt', expiresAt: Date.now() + 300000 };
    if (action === 'image-submit') return { id: 'test', status: 'submitted' };
    throw new Error('Unexpected action');
  };
  const root = createRoot(document.getElementById('root'));
  const button = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  const setText = async (element, value) => React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  try {
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(GenerateImagePanel, { isAdmin: true, request }))));
    assert.ok(document.body.textContent.includes('Image Example'));
    assert.equal(button('Siapkan quote').disabled, true);
    await setText(document.querySelector('textarea'), 'Test gambar');
    assert.equal(button('Siapkan quote').disabled, false);
    await React.act(async () => button('Siapkan quote').click());
    assert.equal(calls.filter((c) => c.action === 'image-prepare').length, 1);
    assert.equal(calls.filter((c) => c.action === 'image-submit').length, 0);
    assert.match(document.body.textContent, /23 kredit/);
    assert.match(document.body.textContent, /Test gambar/);
    assert.equal(button('Setujui dan buat gambar').disabled, true);
    // Changing the prompt invalidates the visible approval.
    await setText(document.querySelector('textarea'), 'Prompt baru');
    assert.equal(button('Setujui dan buat gambar'), undefined);
    await React.act(async () => button('Siapkan quote').click());
    const checkbox = document.querySelector('input[type=checkbox]');
    await React.act(async () => checkbox.click());
    assert.equal(button('Setujui dan buat gambar').disabled, false);
    await React.act(async () => button('Setujui dan buat gambar').click());
    const submissions = calls.filter((c) => c.action === 'image-submit');
    assert.deepEqual(submissions.map((c) => c.body), [{ approval: 'encrypted-receipt', confirm: true }]);
    assert.match(document.body.textContent, /Permintaan diterima/);
    // Non-admin users see no provider and make no admin API calls.
    calls.length = 0;
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(GenerateImagePanel, { isAdmin: false, request }))));
    assert.match(document.body.textContent, /Generasi gambar untuk pengguna belum tersedia/);
    assert.equal(calls.length, 0);
  } finally {
    await React.act(async () => root.unmount());
    await vite.close(); dom.window.close(); delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
