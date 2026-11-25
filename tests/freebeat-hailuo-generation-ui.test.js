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
  let mode = 'success', records = [], preparedOverride = {}, resolvePrepare, taskResult, privateReasons = ['Provider detail <img src=x onerror=alert(1)>'], resolvePrivate;
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
      if (mode === 'rejected') throw Object.assign(new Error('Quote changed'), { status: 409, videoDispatch: 'not_sent' });
      if (mode === 'conflict') throw Object.assign(new Error('Duplicate or uncertain'), { status: 409 });
      records = [{ id: 'test-hailuo', model_id: 106, max_credits: 150, created_at: new Date().toISOString(), status: mode === 'unknown' ? 'unknown' : 'submitted', canPoll: true }];
      return { id: 'test-hailuo', status: records[0].status };
    }
    if (action === 'video-private-failure') {
      if (mode === 'private-lost') throw new Error('Status detail unavailable');
      if (mode === 'private-slow') return new Promise((resolve) => { resolvePrivate = () => resolve({ reasons: privateReasons }); });
      return { reasons: privateReasons };
    }
    assert.equal(action, 'video-task');
    if (taskResult) return { task: taskResult };
    return { task: { status: 'completed', billing: { charged: 130, refunded: null, net: null }, videos: ['https://static.freebeat.ai/result.mp4', 'javascript:alert(1)'] } };
  } };
  const render = (overrides = {}) => React.act(async () => root.render(React.createElement(FreebeatHailuoGeneration, { ...props, ...overrides })));
  const button = (name) => [...document.querySelectorAll('button')].find((el) => el.textContent === name);
  const click = async (name) => React.act(async () => button(name).click());
  const consent = () => document.querySelector('[aria-label="Setujui satu generasi Hailuo"]');
  const check = async () => React.act(async () => consent().click());
  try {
    await render();
    await run({ React, calls, props, render, button, click, check, consent, setMode: (value) => { mode = value; }, setRecords: (value) => { records = value; }, setPrepared: (value) => { preparedOverride = value; }, resolvePrepare: () => resolvePrepare(), setTask: (value) => { taskResult = value; }, setPrivateReasons: (value) => { privateReasons = value; }, resolvePrivate: () => resolvePrivate() });
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

for (const mode of ['lost', 'unknown', 'conflict']) test(`Hailuo ${mode} dispatch consumes approval and blocks another attempt across input changes`, () => harness(async (h) => {
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

// Only an explicit local preflight marker, not generic 409, permits a fresh approval.
test('definitive Hailuo preflight rejection discards the old ticket and requires fresh preparation and consent', () => harness(async (h) => {
  await h.click(prepare); await h.check(); h.setMode('rejected'); await h.click(submit);
  assert.equal(h.consent(), null);
  assert.equal(h.button(prepare).disabled, false);
  assert.match(document.body.textContent, /Permintaan ini tidak dikirim/);
  assert.doesNotMatch(document.body.textContent, /hasil belum pasti/);
  assert.equal(h.calls.filter(([action]) => action === 'video-submit').length, 1);
  h.setMode('success'); await h.click(prepare);
  assert.equal(h.consent().checked, false); assert.equal(h.button(submit).disabled, true);
  assert.equal(h.calls.filter(([action]) => action === 'hailuo-prepare').length, 2);
  await h.check(); await h.click(submit);
  assert.equal(h.calls.filter(([action]) => action === 'video-submit').length, 2);
}));


const privateButton = 'Tampilkan pesan kegagalan pribadi';
const privateConsent = (id = 'existing-hailuo') => document.querySelector(`[aria-label="Setujui pesan kegagalan pribadi ${id}"]`);
const failedTask = { status: 'failed', billing: { charged: 0, refunded: null, net: null, refund_state: null }, failure: { stage: null, reason: null, reason_hidden: true, retryable: null }, item_failures: [{ reason_hidden: true }], videos: [] };
async function existingFailure(h, { canPoll = true, id = 'existing-hailuo' } = {}) {
  h.setRecords([{ id, model_id: 106, max_credits: 150, created_at: new Date().toISOString(), status: 'submitted', canPoll }]);
  h.setTask(failedTask);
  await h.click('Periksa catatan video Hailuo');
  await h.click(canPoll ? 'Periksa status video Hailuo' : 'Periksa status video (sesi lama)');
}

test('Hailuo existing failure exposes a private-consent panel directly; reading details never prepares or submits', () => harness(async (h) => {
  await h.render({ quote: null, imageUrl: '', prompt: '' });
  await existingFailure(h);
  assert.match(document.body.textContent, /ID uji: existing-hailuo/);
  assert.match(document.body.textContent, /Pesan kegagalan pribadi/);
  assert.equal(privateConsent().checked, false); assert.equal(h.button(privateButton).disabled, true);
  await h.click(privateButton);
  assert.equal(h.calls.some(([action]) => action === 'video-private-failure'), false);
  await h.React.act(async () => privateConsent().click());
  await h.React.act(async () => { h.button(privateButton).click(); h.button(privateButton).click(); });
  assert.deepEqual(h.calls.filter(([action]) => action === 'video-private-failure'), [['video-private-failure', 'POST', { id: 'existing-hailuo', acknowledge: true }]]);
  assert.match(document.body.textContent, /Provider detail <img/);
  assert.equal(document.querySelector('img,script,iframe,video'), null);
  assert.ok([...document.querySelectorAll('textarea')].every((el) => !el.value.includes('Provider detail')));
  await h.click('Sembunyikan pesan pribadi');
  assert.doesNotMatch(document.body.textContent, /Provider detail/);
  assert.equal(privateConsent().checked, false);
  await h.React.act(async () => privateConsent().click()); await h.click(privateButton);
  await h.click('Periksa status video Hailuo');
  assert.doesNotMatch(document.body.textContent, /Provider detail/);
  assert.equal(privateConsent().checked, false);
  await h.React.act(async () => privateConsent().click()); await h.click(privateButton);
  await h.click('Periksa catatan video Hailuo');
  assert.doesNotMatch(document.body.textContent, /Provider detail/);
  assert.equal(privateConsent().checked, false);
  assert.ok(h.calls.every(([action]) => ['video-tests', 'video-task', 'video-private-failure'].includes(action)));
}));

test('Hailuo private messages handle old sessions, empty/provider-error replies, and preserve the one-send lock', () => harness(async (h) => {
  await h.click(prepare); await h.check(); await h.click(submit);
  h.setTask(failedTask); await h.click('Periksa status video Hailuo');
  await h.React.act(async () => privateConsent('test-hailuo').click());
  h.setMode('private-lost'); await h.click(privateButton);
  assert.match(document.body.textContent, /Status detail unavailable/);
  assert.equal(h.button(prepare).disabled, true);
  h.setMode('success'); h.setPrivateReasons([]); await h.click(privateButton);
  assert.match(document.body.textContent, /tidak memberikan pesan kegagalan/);
  await h.click('Sembunyikan pesan pribadi');
  assert.equal(privateConsent('test-hailuo').checked, false);
  h.setPrivateReasons(null); await h.React.act(async () => privateConsent('test-hailuo').click()); await h.click(privateButton);
  assert.match(document.body.textContent, /Pesan kegagalan pribadi tidak valid/);
  assert.equal(h.calls.filter(([action]) => action === 'video-submit').length, 1);
  await existingFailure(h, { canPoll: false });
  assert.match(document.body.textContent, /Konfirmasi di bawah juga mengizinkan/);
  assert.equal(privateConsent().checked, false);
  assert.equal(h.button(privateButton).disabled, true);
}));

for (const key of ['prompt', 'imageUrl', 'aspectRatio', 'quote', 'userId', 'connected', 'imageAccess']) test(`Hailuo ignores delayed private messages after ${key} changes`, () => harness(async (h) => {
  await existingFailure(h);
  h.setMode('private-slow'); await h.React.act(async () => privateConsent().click()); await h.click(privateButton);
  const changed = { prompt: 'new prompt', imageUrl: 'https://static.freebeat.ai/new.png', aspectRatio: '1:1', quote: null, userId: 'different-admin', connected: false, imageAccess: false };
  await h.render({ [key]: changed[key] });
  await h.React.act(async () => h.resolvePrivate());
  assert.doesNotMatch(document.body.textContent, /Provider detail/);
  assert.equal(privateConsent(), null);
  assert.equal(h.calls.filter(([action]) => action === 'video-private-failure').length, 1);
}));

test('Hailuo private consent belongs to one record and only failure statuses expose private controls', () => harness(async (h) => {
  h.setRecords(['first', 'second'].map((id) => ({ id, model_id: 106, status: 'submitted', canPoll: true, created_at: new Date().toISOString() })));
  await h.click('Periksa catatan video Hailuo');
  const statusButtons = () => [...document.querySelectorAll('button')].filter((el) => el.textContent === 'Periksa status video Hailuo');
  h.setTask(failedTask);
  await h.React.act(async () => statusButtons()[0].click()); await h.React.act(async () => statusButtons()[1].click());
  await h.React.act(async () => privateConsent('first').click());
  const detailButtons = [...document.querySelectorAll('button')].filter((el) => el.textContent === privateButton);
  assert.equal(detailButtons[0].disabled, false); assert.equal(detailButtons[1].disabled, true);
  await h.React.act(async () => detailButtons[0].click());
  assert.deepEqual(h.calls.find(([action]) => action === 'video-private-failure')[2], { id: 'first', acknowledge: true });
  for (const status of ['partial_failed', 'action_required', 'rejected', 'completed', 'processing']) {
    h.setTask({ ...failedTask, status }); await h.React.act(async () => statusButtons()[1].click());
    assert.equal(Boolean(privateConsent('second')), ['partial_failed', 'action_required', 'rejected'].includes(status));
  }
}));

test('shared Hailuo prepare diagnostic distinguishes nonnumeric price and mismatched settings without relaxing consent', () => harness(async (h) => {
  await h.render({ quote: { ...h.props.quote, quote: { status: 'quoted', credits: '130', message: 'PRIVATE-SECRET' } } });
  const diagnostic = () => JSON.parse(document.querySelector('[aria-label="Diagnosis persiapan Hailuo"]').value);
  assert.ok(diagnostic().blockers.includes('quote_credits_invalid')); assert.equal(h.button(prepare).disabled, true);
  assert.match(document.querySelector('[aria-label="Syarat persiapan Hailuo"]').textContent, /biaya numerik valid/);
  assert.doesNotMatch(JSON.stringify(diagnostic()), /PRIVATE-SECRET|quiet scene|static\.freebeat\.ai/);
  await h.render({ quote: { ...h.props.quote, settings: { ...h.props.quote.settings, generation_type: 'text', model_id: 97 } } });
  assert.ok(diagnostic().blockers.includes('quote_generation_mismatch')); assert.ok(diagnostic().blockers.includes('quote_model_mismatch'));
  await h.render(); assert.equal(h.button(prepare).disabled, false); assert.equal(h.calls.length, 0);
  await h.click(prepare); assert.equal(h.consent().checked, false); assert.equal(h.button(submit).disabled, true);
}));
