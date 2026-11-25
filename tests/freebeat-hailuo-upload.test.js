import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

async function harness(run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://app.example/admin/freebeat/hailuo' });
  const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatHailuoDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatHailuoDiagnostic.jsx');
  const root = createRoot(document.getElementById('root'));
  const calls = [], storageCalls = [];
  let credits = 7, hostMode = 'success', pending, failDelete = false, storageSlow = false, pendingStorage;
  const hostedUrl = 'https://static.freebeat.ai/hailuo-photo.png';
  const request = async (action, method, body) => {
    calls.push([action, method, body]);
    if (action === 'image-upload-quote') return { credits };
    if (action === 'image-upload-host') {
      if (hostMode === 'lost') throw new Error('network lost');
      if (hostMode === 'slow') return new Promise((resolve) => { pending = resolve; });
      if (hostMode === 'invalid') return { outcome: 'uploaded', image_url: 'https://evil.example/img.png' };
      return { outcome: 'uploaded', image_url: hostedUrl };
    }
    assert.equal(action, 'video-model-quote');
    return { quote: { status: 'quoted', credits: 220 } };
  };
  const storage = { from: () => ({
    upload: async (path) => { storageCalls.push(['upload', path]); if (storageSlow) return new Promise((resolve) => { pendingStorage = resolve; }); return { error: null }; },
    getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example/source.png' } }),
    remove: async ([path]) => { storageCalls.push(['remove', path]); return { data: failDelete ? [] : [{ name: path }], error: null }; },
  }) };
  const render = (connected = true) => React.act(async () => root.render(React.createElement(FreebeatHailuoDiagnostic, { connected, imageAccess: true, loading: false, request, storage, userId: '11111111-1111-1111-1111-111111111111' })));
  const field = (label) => document.querySelector(`[aria-label="${label}"]`);
  const button = (text) => [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  const click = async (text) => React.act(async () => button(text).click());
  const check = async (label) => React.act(async () => field(label).click());
  const selectFile = async (file = new dom.window.File(['photo'], 'photo.png', { type: 'image/png' })) => React.act(async () => {
    Object.defineProperty(field('Foto Hailuo'), 'files', { configurable: true, value: [file] });
    field('Foto Hailuo').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  const stage = async () => { await selectFile(); await check('Setujui penyimpanan foto Hailuo'); await click('Unggah foto & periksa biaya upload Freebeat'); };
  try {
    await render();
    await run({ React, field, button, click, check, selectFile, stage, render, calls, storageCalls, hostedUrl, setCredits: (value) => { credits = value; }, setHostMode: (value) => { hostMode = value; }, resolveHost: (value) => pending(value), setDeleteFailure: (value) => { failDelete = value; }, setStorageSlow: () => { storageSlow = true; }, resolveStorage: () => pendingStorage({ error: null }) });
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const key of keys) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; }
  }
}

for (const credits of [0, 7]) test(`Hailuo explicitly stages photo, consents to ${credits}-credit hosting, then quotes using the returned Freebeat URL`, () => harness(async (h) => {
  h.setCredits(credits);
  assert.equal(h.calls.length, 0); assert.equal(h.storageCalls.length, 0);
  await h.selectFile();
  assert.equal(h.storageCalls.length, 0, 'selecting a file must not upload');
  assert.equal(h.button('Unggah foto & periksa biaya upload Freebeat').disabled, true);
  await h.check('Setujui penyimpanan foto Hailuo');
  await h.click('Unggah foto & periksa biaya upload Freebeat');
  assert.equal(h.storageCalls.length, 1);
  assert.deepEqual(h.calls, [['image-upload-quote', 'POST', { image_url: 'https://storage.example/source.png' }]]);
  assert.equal(h.button('Kirim foto ke Freebeat').disabled, true);
  await h.check('Setujui biaya upload foto Hailuo');
  await h.React.act(async () => { h.button('Kirim foto ke Freebeat').click(); h.button('Kirim foto ke Freebeat').click(); });
  assert.equal(h.calls.filter(([action]) => action === 'image-upload-host').length, 1);
  assert.deepEqual(h.calls[1], ['image-upload-host', 'POST', { image_url: 'https://storage.example/source.png', expected_credits: credits, acknowledge: true }]);
  assert.equal(h.field('URL gambar Hailuo').value, h.hostedUrl);
  assert.equal(h.button('Kirim foto ke Freebeat').disabled, true);
  assert.equal(h.button('Periksa quote Hailuo #106').disabled, true, 'quote needs separate consent');
  assert.equal(h.calls.length, 2, 'hosting must not automatically request video quote');
  await h.check('Setujui pemeriksaan quote Hailuo');
  await h.click('Periksa quote Hailuo #106');
  assert.equal(h.calls[2][0], 'video-model-quote');
  assert.deepEqual(h.calls[2][2].images, [h.hostedUrl]);
  h.setDeleteFailure(true);
  await h.click('Hapus foto dari BLEA');
  assert.match(document.body.textContent, /Penghapusan gambar belum dapat dikonfirmasi/);
  assert.equal(h.button('Hapus foto dari BLEA').disabled, false);
  h.setDeleteFailure(false);
  await h.click('Hapus foto dari BLEA');
  assert.equal(h.button('Hapus foto dari BLEA').disabled, true);
  assert.equal(h.field('URL gambar Hailuo').value, h.hostedUrl, 'deleting BLEA must not delete the hosted URL');
  assert.ok(h.calls.every(([action]) => ['image-upload-quote', 'image-upload-host', 'video-model-quote'].includes(action)));
}));

for (const mode of ['lost', 'invalid']) test(`Hailuo ${mode} hosting locks retry and never enables video quote`, () => harness(async (h) => {
  h.setHostMode(mode); await h.stage();
  await h.check('Setujui biaya upload foto Hailuo'); await h.click('Kirim foto ke Freebeat');
  assert.match(document.body.textContent, /Hasil upload tidak pasti/);
  assert.equal(h.field('URL gambar Hailuo').value, '');
  assert.equal(h.button('Kirim foto ke Freebeat').disabled, true);
  await h.click('Kirim foto ke Freebeat');
  assert.equal(h.calls.filter(([action]) => action === 'image-upload-host').length, 1);
  assert.equal(h.button('Periksa quote Hailuo #106').disabled, true);
}));

test('Hailuo blocks invalid file, unknown/excessive cost and stale hosting handoff after disconnect', () => harness(async (h) => {
  await h.selectFile({ type: 'image/webp', size: 12 });
  assert.match(document.body.textContent, /Pilih gambar JPG atau PNG/);
  assert.equal(h.button('Unggah foto & periksa biaya upload Freebeat').disabled, true);
  await h.selectFile({ type: 'image/png', size: 11 * 1024 * 1024 });
  assert.equal(h.storageCalls.length, 0);
  h.setCredits(null); await h.stage();
  assert.match(document.body.textContent, /upload diblokir/);
  assert.equal(h.field('Setujui biaya upload foto Hailuo').disabled, true);
  h.setCredits(101); await h.click('Periksa ulang biaya upload Freebeat');
  assert.equal(h.button('Kirim foto ke Freebeat').disabled, true);
  h.setCredits(4); await h.click('Periksa ulang biaya upload Freebeat');
  assert.equal(h.field('Setujui biaya upload foto Hailuo').checked, false);
  h.setHostMode('slow');
  await h.check('Setujui biaya upload foto Hailuo'); await h.click('Kirim foto ke Freebeat');
  assert.equal(h.field('URL gambar Hailuo').disabled, true);
  await h.render(false);
  await h.React.act(async () => h.resolveHost({ outcome: 'uploaded', image_url: h.hostedUrl }));
  assert.equal(h.field('URL gambar Hailuo').value, '');
  assert.match(document.body.textContent, /Hasil upload tidak pasti/);
  assert.equal(h.calls.filter(([action]) => action === 'image-upload-host').length, 1);
}));


test('Hailuo retains public Storage cleanup handle after OAuth disconnect during staging', () => harness(async (h) => {
  h.setStorageSlow();
  await h.stage();
  await h.render(false);
  await h.React.act(async () => h.resolveStorage());
  assert.equal(h.calls.length, 0, 'stale staging must not request a quote');
  assert.match(document.body.textContent, /Sesi berubah setelah foto tersimpan/);
  assert.equal(h.button('Hapus foto dari BLEA').disabled, false);
  await h.click('Hapus foto dari BLEA');
  assert.equal(h.storageCalls.filter(([action]) => action === 'remove').length, 1);
  assert.equal(h.button('Hapus foto dari BLEA').disabled, true);
}));
