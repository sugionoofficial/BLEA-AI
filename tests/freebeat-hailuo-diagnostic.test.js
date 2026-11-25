import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Hailuo #106 probe is explicit, read-only, independent of catalog, and clears stale/private results', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://app.example/admin/freebeat' });
  const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatHailuoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatHailuoDiagnostic.jsx');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  let pending = null, slow = false, failure = false;
  const request = async (...args) => {
    calls.push(args);
    if (slow) return new Promise((resolve) => { pending = resolve; });
    if (failure) throw new Error('Model 106 tidak tersedia.');
    return args[0] === 'video-model-help' ? { ok: true, model_id: 106, help: { available: true } } : {
      ok: true, settings: { model_id: 106, duration: 10, resolution: '768p', aspect_ratio: '16:9' }, quote: { status: 'quoted', credits: 220 },
    };
  };
  const render = (connected = true) => React.act(async () => root.render(React.createElement(FreebeatHailuoDiagnostic, { connected, loading: false, request, videoModels: { models: [] } })));
  const button = (text) => [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  const fill = (label, value) => React.act(async () => {
    const el = document.querySelector(`[aria-label="${label}"]`);
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  try {
    await render();
    assert.equal(calls.length, 0);
    assert.match(document.body.textContent, /ID 106 belum terlihat/);
    assert.match(document.body.textContent, /bukan MiniMax 3.0/);
    assert.equal(button('Periksa quote Hailuo #106').disabled, true);
    await React.act(async () => button('Periksa informasi Hailuo #106').click());
    assert.deepEqual(calls[0], ['video-model-help', 'POST', { model_id: 106 }]);
    await fill('URL gambar Hailuo', 'http://images.example/input.png');
    assert.equal(button('Periksa quote Hailuo #106').disabled, true);
    await fill('URL gambar Hailuo', 'https://images.example/input.png');
    assert.equal(button('Periksa quote Hailuo #106').disabled, true);
    await React.act(async () => document.querySelector('input[type=checkbox]').click());
    await React.act(async () => button('Periksa quote Hailuo #106').click());
    assert.deepEqual(calls[1], ['video-model-quote', 'POST', {
      model_id: 106, duration: 10, resolution: '768p', aspect_ratio: '16:9', input_mode: 'keyframe',
      images: ['https://images.example/input.png'], prompt: 'Gerakan kamera perlahan, subjek dan penampilan tetap konsisten dengan gambar referensi.',
    }]);
    assert.ok(document.querySelector('[aria-label="Quote Hailuo MCP yang disaring"]'));
    await fill('URL gambar Hailuo', 'https://images.example/new.png');
    assert.equal(document.querySelector('[aria-label="Quote Hailuo MCP yang disaring"]'), null);
    assert.equal(document.querySelector('input[type=checkbox]').checked, false);
    failure = true;
    await React.act(async () => button('Periksa informasi Hailuo #106').click());
    assert.match(document.querySelector('[role=alert]').textContent, /tidak tersedia/);
    failure = false; slow = true;
    await React.act(async () => button('Periksa informasi Hailuo #106').click());
    assert.ok(pending);
    await render(false);
    await React.act(async () => pending({ help: { message: 'STALE_PRIVATE_RESULT' } }));
    assert.ok(!document.body.textContent.includes('STALE_PRIVATE_RESULT'));
    assert.equal(button('Periksa informasi Hailuo #106').disabled, true);
    assert.ok(calls.every(([action]) => ['video-model-help', 'video-model-quote'].includes(action)));
  } finally {
    await React.act(async () => root.unmount());
    await vite.close(); dom.window.close();
    for (const key of keys) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; }
  }
});
