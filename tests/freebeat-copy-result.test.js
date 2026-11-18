import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('video result copies exactly the displayed JSON and offers manual fallback', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatCopyResult } = await vite.ssrLoadModule('/src/auth/FreebeatCopyResult.jsx');
  const root = createRoot(document.getElementById('root'));
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => copied.push(text) } });
  const value = { tools: { generate_video: { type: 'object' } }, truncated: true };
  try {
    await React.act(async () => root.render(React.createElement(FreebeatCopyResult, { title: 'Struktur tool video', value })));
    const textarea = document.querySelector('textarea');
    const button = document.querySelector('button');
    assert.equal(button.getAttribute('aria-label'), 'Salin Struktur tool video');
    assert.equal(textarea.readOnly, true);
    await React.act(async () => button.click());
    assert.equal(copied[0], textarea.value);
    assert.deepEqual(JSON.parse(copied[0]), value);
    assert.match(document.querySelector('[role=status]').textContent, /Berhasil disalin/);
    navigator.clipboard.writeText = async () => { throw new Error('denied'); };
    await React.act(async () => button.click());
    assert.match(document.querySelector('[role=status]').textContent, /secara manual/);
    assert.equal(document.activeElement, textarea);
    assert.equal(textarea.selectionStart, 0);
    assert.equal(textarea.selectionEnd, textarea.value.length);
  } finally {
    await React.act(async () => root.unmount());
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
  }
});
