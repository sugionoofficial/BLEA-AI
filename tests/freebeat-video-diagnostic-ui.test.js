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
    assert.doesNotMatch(document.querySelector('[aria-label="Quote video yang disaring"]').value, /Kucing|images.example/);
    await setValue(document.querySelector('input[type=text]'), 'Kucing berlari');
    assert.equal(document.querySelector('[aria-label="Quote video yang disaring"]'), null);
    assert.equal(calls.length, 2);
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
