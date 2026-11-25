import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const quoteButton = 'Periksa quote LTX #97', prepareButton = 'Siapkan persetujuan video LTX', submitButton = 'Setujui dan kirim satu video LTX';
async function harness(run) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://app.example/admin/freebeat/ltx' });
  const keys = ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT'];
  const old = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { FreebeatLtxDiagnostic } = await vite.ssrLoadModule('/src/auth/FreebeatLtxDiagnostic.jsx');
  const root = createRoot(document.getElementById('root')), calls = [], storageCalls = [];
  const storage = { from: () => ({
    upload: async (path) => { storageCalls.push(['upload', path]); return { error: null }; },
    getPublicUrl: () => ({ data: { publicUrl: 'https://storage.example/source.png' } }),
    remove: async ([path]) => { storageCalls.push(['remove', path]); return { data: [{ name: path }], error: null }; },
  }) };
  let records = [], quotePatch = {}, preparedPatch = {}, unknown = false, slowAction, resolveSlow;
  const settings = { model_id: 97, generation_type: 'image', duration: 6, resolution: '1080p', aspect_ratio: '16:9' };
  const request = async (action, method, body) => {
    calls.push([action, method, body]);
    let result;
    if (action === 'image-upload-quote') result = { credits: 7 };
    else if (action === 'image-upload-host') result = { outcome: 'uploaded', image_url: 'https://static.freebeat.ai/ltx.png' };
    else if (action === 'video-model-help') result = { model_id: 97, help: { model: { model_id: 97, available: true }, durations: [6, 8], resolutions: ['1080p'], generation_types: ['image'] } };
    else if (action === 'video-model-quote') result = { settings: { ...settings, duration: body.duration, resolution: body.resolution, ...quotePatch }, quote: { status: 'quoted', credits: 37 }, adjusted: [], supported: { durations: [6, 8], resolutions: ['1080p'] } };
    else if (action === 'video-tests') result = { tests: records };
    else if (action === 'ltx-prepare') result = { approval: 'sealed-ltx', settings: { ...settings, duration: body.duration, resolution: body.resolution }, images: body.images, prompt: body.prompt, credits: 37, max_credits: 47, expiresAt: Date.now() + 60000, ...preparedPatch };
    else if (action === 'video-submit') {
      records = [{ id: 'existing-ltx', model_id: 97, max_credits: 47, status: unknown ? 'unknown' : 'submitted', canPoll: true, created_at: new Date().toISOString() }];
      result = { id: 'existing-ltx', status: records[0].status };
    } else if (action === 'video-task') result = { task: { status: 'failed', billing: { charged: 0, refunded: null, net: null }, failure: { reason_hidden: true }, item_failures: [{ reason_hidden: true }], videos: [] } };
    else if (action === 'video-private-failure') result = { reasons: ['LTX provider detail <img src=x>'] };
    else throw new Error(`Unexpected action ${action}`);
    if (action === slowAction) return new Promise((resolve) => { resolveSlow = () => resolve(result); });
    return result;
  };
  const props = { connected: true, imageAccess: true, loading: false, request, storage, userId: '11111111-1111-1111-1111-111111111111' };
  const render = (overrides = {}) => React.act(async () => root.render(React.createElement(FreebeatLtxDiagnostic, { ...props, ...overrides })));
  const field = (label) => document.querySelector(`[aria-label="${label}"]`);
  const button = (text) => [...document.querySelectorAll('button')].find((el) => el.textContent === text);
  const click = (text) => React.act(async () => button(text).click());
  const check = (label) => React.act(async () => field(label).click());
  const fill = (label, value) => React.act(async () => {
    const el = field(label);
    const prototype = el.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    el.dispatchEvent(new dom.window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
  const inputs = async () => {
    await fill('URL gambar LTX', 'https://images.example/photo.png'); await fill('Prompt LTX', 'A quiet scene');
    await fill('Durasi LTX', '6'); await fill('Resolusi LTX', '1080p'); await fill('Rasio LTX', '16:9');
  };
  const quote = async () => { await check('Setujui pemeriksaan quote LTX'); await click(quoteButton); };
  try {
    await render();
    const selectFile = () => React.act(async () => {
      Object.defineProperty(field('Foto LTX'), 'files', { configurable: true, value: [new dom.window.File(['photo'], 'photo.png', { type: 'image/png' })] });
      field('Foto LTX').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await run({ React, calls, storageCalls, selectFile, render, field, button, click, check, fill, inputs, quote, settings, setQuotePatch: (value) => { quotePatch = value; }, setPreparedPatch: (value) => { preparedPatch = value; }, setUnknown: () => { unknown = true; }, setRecords: (value) => { records = value; }, defer: (action) => { slowAction = action; }, resolve: () => resolveSlow() });
  } finally {
    await React.act(async () => root.unmount()); await vite.close(); dom.window.close();
    for (const key of keys) { if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; }
  }
}

test('LTX starts without assumed settings or calls and requires exact model97 quote, fresh preparation, cap review and single consented send', () => harness(async (h) => {
  assert.equal(h.calls.length, 0);
  for (const label of ['Durasi LTX', 'Resolusi LTX', 'Rasio LTX']) assert.equal(h.field(label).value, '');
  assert.equal(h.button(quoteButton).disabled, true); assert.equal(h.button(prepareButton).disabled, true);
  assert.ok(h.field('Foto LTX')); assert.equal(h.field('Foto Hailuo'), null);
  await h.click('Periksa informasi LTX #97'); assert.deepEqual(h.calls[0], ['video-model-help', 'POST', { model_id: 97 }]);
  await h.inputs();
  assert.ok(h.field('Informasi LTX MCP yang disaring'), 'help remains readable while choosing parameters');
  assert.equal(h.button(quoteButton).disabled, true);
  await h.quote();
  assert.deepEqual(h.calls[1], ['video-model-quote', 'POST', { model_id: 97, duration: 6, resolution: '1080p', aspect_ratio: '16:9', input_mode: 'keyframe', images: ['https://images.example/photo.png'], prompt: 'A quiet scene' }]);
  assert.equal(h.button(prepareButton).disabled, false);
  await h.click(prepareButton);
  assert.deepEqual(h.calls.find(([action]) => action === 'ltx-prepare')[2], { model_id: 97, generation_type: 'image', duration: 6, resolution: '1080p', aspect_ratio: '16:9', input_mode: 'keyframe', images: ['https://images.example/photo.png'], prompt: 'A quiet scene' });
  assert.match(document.body.textContent, /47 kredit Freebeat/); assert.match(document.body.textContent, /Model 97 · image-to-video · 6 detik · 1080p/);
  assert.equal(h.field('Setujui satu generasi LTX').checked, false); assert.equal(h.button(submitButton).disabled, true);
  await h.check('Setujui satu generasi LTX');
  await h.React.act(async () => { h.button(submitButton).click(); h.button(submitButton).click(); });
  assert.deepEqual(h.calls.filter(([action]) => action === 'video-submit'), [['video-submit', 'POST', { approval: 'sealed-ltx', confirm: true }]]);
  assert.equal(h.button(prepareButton).disabled, true);
  assert.equal(h.calls.some(([action]) => ['hailuo-prepare', 'video-prepare', 'video-task', 'video-private-failure'].includes(action)), false);
}));

test('LTX mismatched normalized quote cannot prepare; duration/resolution changes clear quote and approval', () => harness(async (h) => {
  await h.inputs(); h.setQuotePatch({ duration: 8 }); await h.quote();
  assert.equal(h.button(prepareButton).disabled, true);
  await h.fill('Durasi LTX', '8');
  assert.equal(h.field('Setujui pemeriksaan quote LTX').checked, false); assert.equal(h.field('Quote LTX MCP yang disaring'), null);
  h.setQuotePatch({}); await h.quote(); await h.click(prepareButton); await h.check('Setujui satu generasi LTX');
  await h.fill('Resolusi LTX', '720p');
  assert.equal(h.field('Setujui satu generasi LTX'), null); assert.equal(h.field('Quote LTX MCP yang disaring'), null);
  await h.quote(); await h.click(prepareButton); assert.equal(h.field('Setujui satu generasi LTX').checked, false);
  await h.fill('Durasi LTX', '6'); assert.equal(h.field('Setujui satu generasi LTX'), null);
  assert.equal(h.calls.some(([action]) => action === 'video-submit'), false);
}));

test('LTX rejects wrong model or wrong cap in prepared receipt', () => harness(async (h) => {
  await h.inputs(); await h.quote();
  for (const patch of [{ settings: { ...h.settings, model_id: 106 } }, { max_credits: 37 }, { expiresAt: Date.now() - 1 }]) {
    h.setPreparedPatch(patch); await h.click(prepareButton);
    assert.equal(h.field('Setujui satu generasi LTX'), null); assert.match(document.body.textContent, /tidak cocok atau kedaluwarsa/);
  }
  assert.equal(h.calls.some(([action]) => action === 'video-submit'), false);
}));

test('LTX reads existing failed task and consented private details directly without quote, upload or generation', () => harness(async (h) => {
  h.setRecords([{ id: 'existing-ltx', model_id: 97, status: 'submitted', canPoll: true, created_at: new Date().toISOString() }]);
  await h.click('Periksa catatan video LTX'); await h.click('Periksa status video LTX');
  assert.equal(h.button('Tampilkan pesan kegagalan pribadi').disabled, true);
  await h.check('Setujui pesan kegagalan pribadi existing-ltx'); await h.click('Tampilkan pesan kegagalan pribadi');
  assert.deepEqual(h.calls[2], ['video-private-failure', 'POST', { id: 'existing-ltx', acknowledge: true }]);
  assert.match(document.body.textContent, /LTX provider detail <img/); assert.equal(document.querySelector('img'), null);
  assert.ok([...document.querySelectorAll('textarea')].every((el) => !el.value.includes('LTX provider detail')));
  await h.click('Sembunyikan pesan pribadi'); assert.doesNotMatch(document.body.textContent, /LTX provider detail/);
  assert.ok(h.calls.every(([action]) => ['video-tests', 'video-task', 'video-private-failure'].includes(action)));
}));

test('LTX uncertain result blocks another attempt even after input changes', () => harness(async (h) => {
  await h.inputs(); await h.quote(); await h.click(prepareButton); await h.check('Setujui satu generasi LTX');
  h.setUnknown(); await h.click(submitButton);
  assert.match(document.body.textContent, /hasil belum pasti/); assert.equal(h.button(prepareButton).disabled, true);
  await h.fill('Durasi LTX', '8'); await h.quote(); assert.equal(h.button(prepareButton).disabled, true);
  assert.equal(h.calls.filter(([action]) => action === 'video-submit').length, 1);
}));

for (const action of ['video-model-quote', 'ltx-prepare']) test(`LTX ignores stale ${action} after disconnect`, () => harness(async (h) => {
  await h.inputs();
  if (action === 'ltx-prepare') await h.quote();
  h.defer(action);
  if (action === 'video-model-quote') await h.quote(); else await h.click(prepareButton);
  await h.render({ connected: false }); await h.React.act(async () => h.resolve());
  assert.equal(h.field('Quote LTX MCP yang disaring'), null); assert.equal(h.field('Setujui satu generasi LTX'), null);
  assert.equal(h.button(prepareButton).disabled, true);
  assert.equal(h.calls.some(([name]) => name === 'video-submit'), false);
}));

test('LTX invalid URL/duration and missing permission cannot enable paid action', () => harness(async (h) => {
  await h.inputs();
  for (const url of ['http://images.example/a.png', 'https://127.0.0.1/a.png', 'https://user:pass@images.example/a.png', 'https://images.example/a.png#private']) {
    await h.fill('URL gambar LTX', url); assert.equal(h.field('Setujui pemeriksaan quote LTX').disabled, true);
  }
  await h.fill('URL gambar LTX', 'https://images.example/a.png');
  for (const duration of ['0', '601', '1.5']) { await h.fill('Durasi LTX', duration); assert.equal(h.field('Setujui pemeriksaan quote LTX').disabled, true); }
  assert.equal(h.calls.length, 0);
  await h.fill('Durasi LTX', '6'); await h.quote();
  await h.render({ imageAccess: false }); assert.equal(h.button(prepareButton).disabled, true);
  assert.equal(h.calls.some(([action]) => ['video-submit', 'ltx-prepare'].includes(action)), false);
}));


test('LTX upload preserves separate public-storage, hosting and video-quote consents and cleanup', () => harness(async (h) => {
  await h.selectFile(); assert.equal(h.calls.length, 0); assert.equal(h.storageCalls.length, 0);
  assert.equal(h.button('Unggah foto & periksa biaya upload Freebeat').disabled, true);
  await h.check('Setujui penyimpanan foto LTX'); await h.click('Unggah foto & periksa biaya upload Freebeat');
  assert.deepEqual(h.calls, [['image-upload-quote', 'POST', { image_url: 'https://storage.example/source.png' }]]);
  assert.equal(h.storageCalls.length, 1); assert.equal(h.button('Kirim foto ke Freebeat').disabled, true);
  await h.check('Setujui biaya upload foto LTX'); await h.click('Kirim foto ke Freebeat');
  assert.deepEqual(h.calls[1], ['image-upload-host', 'POST', { image_url: 'https://storage.example/source.png', acknowledge: true, expected_credits: 7 }]);
  assert.equal(h.field('URL gambar LTX').value, 'https://static.freebeat.ai/ltx.png');
  assert.match(document.body.textContent, /Periksa quote LTX #97/);
  assert.equal(h.calls.length, 2); assert.equal(h.field('Setujui pemeriksaan quote LTX').checked, false);
  await h.click('Hapus foto dari BLEA'); assert.equal(h.storageCalls.length, 2);
  assert.equal(h.field('URL gambar LTX').value, 'https://static.freebeat.ai/ltx.png');
  await h.fill('Durasi LTX', '6'); await h.fill('Resolusi LTX', '1080p'); await h.fill('Rasio LTX', '16:9');
  await h.quote(); assert.deepEqual(h.calls[2][2].images, ['https://static.freebeat.ai/ltx.png']);
  assert.equal(h.calls.some(([action]) => ['ltx-prepare', 'video-submit'].includes(action)), false);
}));

test('LTX explains missing quote versus help-only and exact normalized differences beside the prepare button', () => harness(async (h) => {
  const help = () => h.field('Syarat persiapan LTX');
  const diagnosis = () => JSON.parse(h.field('Diagnosis persiapan LTX').value);
  assert.equal(h.button(prepareButton).getAttribute('aria-describedby'), help().id);
  assert.match(help().textContent, /Help\/informasi model saja belum cukup/);
  await h.click('Periksa informasi LTX #97'); await h.inputs();
  assert.equal(h.button(prepareButton).disabled, true);
  assert.ok(diagnosis().blockers.includes('quote_missing'));
  assert.match(help().textContent, /klik Periksa quote LTX #97/);
  h.setQuotePatch({ duration: 8, resolution: '720p', aspect_ratio: '9:16' }); await h.quote();
  assert.equal(h.button(prepareButton).disabled, true);
  assert.match(help().textContent, /Durasi quote \(8 detik\) berbeda dari pilihan \(6 detik\)/);
  assert.match(help().textContent, /Resolusi quote \(720p\) berbeda dari pilihan \(1080p\)/);
  assert.match(help().textContent, /Rasio quote \(9:16\) berbeda dari pilihan \(16:9\)/);
  assert.ok(diagnosis().blockers.includes('quote_duration_mismatch'));
  assert.ok(diagnosis().blockers.includes('quote_resolution_mismatch'));
  assert.ok(diagnosis().blockers.includes('quote_aspect_ratio_mismatch'));
  assert.deepEqual(diagnosis().quote.settings, { model_id: 97, generation_type: 'image', duration: 8, resolution: '720p', aspect_ratio: '9:16' });
  assert.doesNotMatch(h.field('Diagnosis persiapan LTX').value, /images\.example|A quiet scene|sealed-ltx/);
  const beforeCopy = h.calls.length;
  await h.React.act(async () => h.field('Salin Diagnosis persiapan LTX').click());
  assert.equal(h.calls.length, beforeCopy);
  await h.fill('Durasi LTX', '8'); await h.fill('Resolusi LTX', '720p'); await h.fill('Rasio LTX', '9:16');
  assert.ok(diagnosis().blockers.includes('quote_missing')); assert.equal(h.field('Setujui pemeriksaan quote LTX').checked, false);
  await h.quote();
  assert.equal(h.button(prepareButton).disabled, false);
  assert.match(help().textContent, /Siap meminta quote baru/);
  assert.equal(h.field('Diagnosis persiapan LTX'), null);
  assert.equal(h.calls.some(([action]) => ['ltx-prepare', 'video-submit'].includes(action)), false);
}));

test('LTX prepare diagnostic explains absent generation scope and persistent uncertain locks without unlocking them', () => harness(async (h) => {
  await h.inputs(); await h.quote();
  await h.render({ imageAccess: false });
  let diagnostic = JSON.parse(h.field('Diagnosis persiapan LTX').value);
  assert.ok(diagnostic.blockers.includes('generation_scope_missing')); assert.equal(h.button(prepareButton).disabled, true);
  await h.render();
  h.setRecords([{ id: 'PRIVATE-RECORD-ID', model_id: 97, status: 'unknown', created_at: new Date().toISOString() }]);
  await h.click('Periksa catatan video LTX');
  diagnostic = JSON.parse(h.field('Diagnosis persiapan LTX').value);
  assert.ok(diagnostic.blockers.includes('dispatch_uncertain'));
  assert.doesNotMatch(h.field('Diagnosis persiapan LTX').value, /PRIVATE-RECORD-ID/);
  assert.equal(h.button(prepareButton).disabled, true);
  assert.match(h.field('Syarat persiapan LTX').textContent, /jangan muat ulang/);
  await h.click(prepareButton);
  assert.equal(h.calls.some(([action]) => ['ltx-prepare', 'video-submit'].includes(action)), false);
}));
