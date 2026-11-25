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
  const render = (connected = true, loading = false) => React.act(async () => root.render(React.createElement(FreebeatHailuoDiagnostic, { connected, loading, request, videoModels: { models: [] } })));
  const button = (text) => [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  const fill = (label, value) => React.act(async () => {
    const el = document.querySelector(`[aria-label="${label}"]`);
    Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  try {
    const reasons = () => document.getElementById('freebeat-hailuo-quote-help').textContent;
    const quoteButton = () => button('Periksa quote Hailuo #106');
    const consentBox = () => document.querySelector('input[type=checkbox]');
    await render(true, true);
    assert.match(reasons(), /Menunggu pemeriksaan sesi/);
    assert.equal(quoteButton().disabled, true);
    assert.equal(consentBox().disabled, true);
    await render(false);
    assert.match(reasons(), /Hubungkan akun melalui halaman utama/);
    assert.equal(quoteButton().disabled, true);
    await render();
    assert.equal(calls.length, 0);
    assert.equal(quoteButton().getAttribute('aria-describedby'), 'freebeat-hailuo-quote-help');
    assert.match(reasons(), /Isi URL HTTPS gambar/);
    assert.match(reasons(), /centang izin pengiriman/);
    assert.equal(consentBox().disabled, true);
    assert.match(document.body.textContent, /ID 106 belum terlihat/);
    assert.match(document.body.textContent, /bukan MiniMax 3.0/);
    assert.equal(button('Periksa quote Hailuo #106').disabled, true);
    await React.act(async () => button('Periksa informasi Hailuo #106').click());
    assert.deepEqual(calls[0], ['video-model-help', 'POST', { model_id: 106 }]);
    for (const url of ['http://images.example/input.png', 'file:///tmp/photo.png', 'https://user:password@images.example/photo.png', 'https://images.example/photo.png#fragment', 'https://localhost/photo.png', 'https://images.local/photo.png', 'https://127.0.0.1/photo.png', 'https://[::1]/photo.png', 'https://images.example/' + 'a'.repeat(2048)]) {
      await fill('URL gambar Hailuo', url);
      assert.equal(quoteButton().disabled, true, url);
      assert.equal(consentBox().disabled, true);
      assert.equal(document.querySelector('[aria-label="URL gambar Hailuo"]').getAttribute('aria-invalid'), 'true');
      assert.match(reasons(), /Perbaiki URL gambar/);
      await React.act(async () => quoteButton().click());
      assert.equal(calls.length, 1, 'invalid inputs must not send a quote');
    }
    await fill('URL gambar Hailuo', 'https://images.example/input.png');
    assert.equal(button('Periksa quote Hailuo #106').disabled, true);
    assert.equal(consentBox().disabled, false);
    await fill('Prompt Hailuo', '   ');
    assert.match(reasons(), /Isi prompt pemeriksaan/);
    assert.equal(consentBox().disabled, true);
    assert.equal(quoteButton().disabled, true);
    await fill('Prompt Hailuo', 'Gerakan kamera perlahan, subjek dan penampilan tetap konsisten dengan gambar referensi.');
    await React.act(async () => consentBox().click());
    assert.equal(quoteButton().disabled, false);
    assert.match(reasons(), /Siap memeriksa quote Hailuo/);
    // A changed ratio needs fresh consent, just like changed URL/prompt.
    await React.act(async () => {
      const select = document.querySelector('[aria-label="Rasio Hailuo"]');
      select.value = '9:16'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(consentBox().checked, false);
    assert.equal(quoteButton().disabled, true);
    assert.match(reasons(), /centang izin pengiriman/);
    await React.act(async () => {
      const select = document.querySelector('[aria-label="Rasio Hailuo"]');
      select.value = '16:9'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await React.act(async () => consentBox().click());
    await React.act(async () => quoteButton().click());
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
    assert.equal(quoteButton().disabled, true);
    assert.match(reasons(), /Tunggu pemeriksaan MCP/);
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
