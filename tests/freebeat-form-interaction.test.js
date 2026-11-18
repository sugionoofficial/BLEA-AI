import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('preparation form becomes clickable after entering input and never submits the paid action', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://blea.example/admin/freebeat' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatImageForm } = await vite.ssrLoadModule('/src/auth/FreebeatImageForm.jsx');
  let prepared = 0, inspected = 0;
  function Harness({ imageAccess = true }) {
    const [model, setModel] = React.useState('');
    const [prompt, setPrompt] = React.useState('');
    return React.createElement(FreebeatImageForm, { loading: false, connected: true, imageAccess, busy: false, imageBusy: false, testBusy: false, model, prompt, onModelChange: setModel, onPromptChange: setPrompt, onInspect: (event) => { event.preventDefault(); inspected++; }, onPrepare: (event) => { event.preventDefault(); prepared++; } });
  }
  const root = createRoot(document.getElementById('root'));
  const button = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Siapkan quote untuk persetujuan');
  async function setInput(input, value) {
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
  }
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    assert.equal(button().disabled, true);
    assert.match(document.querySelector('#freebeat-prepare-help').textContent, /Isi ID model/);
    await setInput(document.querySelector('input[type=number]'), '80');
    assert.equal(button().disabled, true);
    assert.match(document.querySelector('#freebeat-prepare-help').textContent, /Isi prompt/);
    await setInput(document.querySelector('input[type=text]'), 'Kucing di taman');
    assert.equal(button().disabled, false);
    assert.match(document.querySelector('#freebeat-prepare-help').textContent, /tidak membuat gambar atau memakai kredit/);
    await React.act(async () => button().click());
    assert.equal(prepared, 1);
    assert.equal(inspected, 0);
    await React.act(async () => root.render(React.createElement(Harness, { imageAccess: false })));
    assert.equal(button().disabled, true);
    assert.match(document.querySelector('#freebeat-prepare-help').textContent, /Hubungkan Freebeat/);
    await React.act(async () => button().click());
    assert.equal(prepared, 1);
  } finally {
    await React.act(async () => root.unmount());
    await vite.close(); dom.window.close();
    delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
