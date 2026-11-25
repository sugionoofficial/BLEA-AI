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
  const { FreebeatHailuoGeneration } = await vite.ssrLoadModule('/src/auth/FreebeatHailuoGeneration.jsx');
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  let mode = 'success', records = [], preparedOverride = {}, resolvePrepare;
  const settings = { model_id: 106, generation_type: 'image', duration: 10, resolution: '768p', aspect_ratio: '9:16' };
  const props = { connected: true, imageAccess: true, loading: false, disabled: false, imageUrl: 'https://static.freebeat.ai/photo.png', prompt: 'A quiet scene', aspectRatio: '9:16', quote: { settings, quote: { status: 'quoted', credits: 130 } }, onBusyChange() {}, request: async (action, method, body) => {
    calls.push([action, method, body]);
    if (action === 'video-tests') return { tests: records };
    if (action === 'hailuo-prepare') {
      const ready = { approval: 'sealed-receipt', settings, images: [props.imageUrl], prompt: props.prompt, credits: 130, max_credits: 150, expiresAt: Date.now() + 60000, ...preparedOverride };
      if (mode === 'slow') return new Promise((resolve) => { resolvePrepare = () => resolve(ready); });
      return ready;
    }
    if (action === 'video-submit') {
      if (mode === 'lost') throw new Error('network lost');
      records = [{ id: 'test-hailuo', model_id: 106, max_credits: 150, created_at: new Date().toISOString(), status: mode === 'unknown' ? 'unknown' : 'submitted', canPoll: true }];
      return { id: 'test-hailuo', status: records[0].status };
    }
    assert.equal(action, 'video-task');
    return { task: { status: 'completed', billing: { charged: 130, refunded: null, net: null }, videos: ['https://static.freebeat.ai/result.mp4', 'javascript:alert(1)'] } };
  } };
  const render = (overrides = {}) => React.act(async () => root.render(React.createElement(FreebeatHailuoGeneration, { ...props, ...overrides })));
  const button = (name) => [...document.querySelectorAll('button')].find((el) => el.textContent === name);
  const click = async (name) => React.act(async () => button(name).click());
  const consent = () => document.querySelector('[aria-label="Setujui satu generasi Hailuo"]');
  const check = async () => React.act(async () => consent().click());
  try {
    await render();
    await run({ React, calls, props, render, button, click, check, consent, setMode: (value) => { mode = value; }, setRecords: (value) => { records = value; }, setPrepared: (value) => { preparedOverride = value; }, resolvePrepare: () => resolvePrepare() });
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const key of keys) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; }
  }
}

const prepare = 'Siapkan persetujuan video Hailuo', submit = 'Setujui dan kirim satu video Hailuo';
test('Hailuo generates only after a fresh prepared quote and separate consent, once; monitors results without loading media', () => harness(async (h) => {
  assert.equal(h.calls.length, 0);
  await h.click(prepare);
  assert.deepEqual(h.calls.map(([action]) => action), ['video-tests', 'hailuo-prepare']);
  assert.deepEqual(h.calls[1][2], { model_id: 106, generation_type: 'image', input_mode: 'keyframe', images: [h.props.imageUrl], prompt: h.props.prompt, duration: 10, resolution: '768p', aspect_ratio: '9:16' });
  assert.match(document.body.textContent, /150 kredit Freebeat/);
  assert.equal(h.consent().checked, false);
  assert.equal(h.button(submit).disabled, true);
  await h.check();
  await h.React.act(async () => { h.button(submit).click(); h.button(submit).click(); });
  assert.equal(h.calls.filter(([action]) => action === 'video-submit').length, 1);
  assert.deepEqual(h.calls.find(([action]) => action === 'video-submit')[2], { approval: 'sealed-receipt', confirm: true });
  assert.equal(h.button(prepare).disabled, true);
  assert.match(document.body.textContent, /bukan konfirmasi render berhasil/);
  await h.click('Periksa status video Hailuo');
  const result = document.querySelector('a.freebeat-result-link');
  assert.equal(result.href, 'https://static.freebeat.ai/result.mp4');
  assert.equal(result.rel, 'noopener noreferrer');
  assert.equal(document.querySelectorAll('a.freebeat-result-link').length, 1);
  assert.equal(document.querySelector('video,img,iframe'), null);
  assert.match(document.querySelector('[aria-label="Status video test-hailuo"]').value, /"refunded": null/);
}));

for (const mode of ['lost', 'unknown']) test(`Hailuo ${mode} dispatch consumes approval and blocks another attempt across input changes`, () => harness(async (h) => {
  await h.click(prepare); await h.check(); h.setMode(mode); await h.click(submit);
  assert.equal(h.consent(), null);
  assert.equal(h.button(prepare).disabled, true);
  assert.match(document.body.textContent, /hasil belum pasti/);
  await h.render({ prompt: 'Changed prompt' });
  assert.equal(h.button(prepare).disabled, true);
  assert.equal(h.calls.filter(([action]) => action === 'video-submit').length, 1);
}));

test('Hailuo clears approval on input/quote/session changes and ignores late preparation', () => harness(async (h) => {
  await h.click(prepare); await h.check();
  await h.render({ prompt: 'Changed prompt' });
  assert.equal(h.consent(), null);
  await h.render(); await h.click(prepare);
  await h.render({ quote: { ...h.props.quote } });
  assert.equal(h.consent(), null);
  await h.render(); h.setMode('slow'); await h.click(prepare);
  await h.render({ connected: false });
  await h.React.act(async () => h.resolvePrepare());
  assert.equal(h.consent(), null);
  assert.equal(h.button(prepare).disabled, true);
  assert.equal(h.calls.some(([action]) => action === 'video-submit'), false);
}));

test('Hailuo preparation rejects changed cap/URL/model and blocks known unresolved jobs', () => harness(async (h) => {
  for (const override of [{ max_credits: 130 }, { images: ['https://wrong.example/photo.png'] }, { settings: { ...h.props.quote.settings, model_id: 182 } }, { expiresAt: 'invalid' }]) {
    h.setPrepared(override); await h.click(prepare);
    assert.equal(h.consent(), null);
    assert.match(document.body.textContent, /tidak cocok atau kedaluwarsa/);
  }
  h.setPrepared({});
  h.setRecords([{ id: 'unresolved', model_id: 182, status: 'unknown', created_at: new Date().toISOString() }]);
  const count = h.calls.filter(([action]) => action === 'hailuo-prepare').length;
  await h.click(prepare);
  assert.equal(h.calls.filter(([action]) => action === 'hailuo-prepare').length, count);
  assert.equal(h.button(prepare).disabled, true);
  assert.match(document.body.textContent, /hasil belum pasti/);
}));

test('Hailuo cannot prepare from missing quote/permission; expiration blocks a checked approval', () => harness(async (h) => {
  await h.render({ quote: null }); assert.equal(h.button(prepare).disabled, true);
  await h.render({ imageAccess: false }); assert.equal(h.button(prepare).disabled, true);
  assert.equal(h.calls.length, 0);
  await h.render(); await h.click(prepare); await h.check();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 120000;
    await h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    assert.equal(h.button(submit).disabled, true);
    await h.click(submit);
    assert.equal(h.calls.some(([action]) => action === 'video-submit'), false);
  } finally { Date.now = realNow; }
}));
