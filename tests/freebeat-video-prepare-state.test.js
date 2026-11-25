import test from 'node:test';
import assert from 'node:assert/strict';
import { videoPrepareState } from '../src/lib/freebeatVideoPrepareState.js';

const settings = { model_id: 97, generation_type: 'image', duration: 6, resolution: '1080p', aspect_ratio: '16:9' };
const valid = { loading: false, connected: true, imageAccess: true, disabled: false, busy: false, imageUrl: 'https://images.example/private?token=SECRET', prompt: 'SECRET private prompt', modelId: 97, modelLabel: 'LTX', duration: 6, resolution: '1080p', aspectRatio: '16:9', quote: { settings, quote: { status: 'quoted', credits: 37 } }, attempted: false, uncertain: false, unresolved: false };
const state = (patch = {}) => videoPrepareState({ ...valid, ...patch });
const codes = (patch) => state(patch).blockers.map(({ code }) => code);

test('video prepare gating reports ready only when exact numeric quote and all existing safety conditions pass', () => {
  assert.deepEqual(codes(), []); assert.equal(state().diagnostic.blocked, false);
  for (const credits of [0, 0.5, 1000000]) assert.deepEqual(codes({ quote: { settings, quote: { status: 'quoted', credits } } }), []);
  const conditions = [
    [{ loading: true }, 'session_loading'], [{ connected: false }, 'session_missing'], [{ imageAccess: false }, 'generation_scope_missing'],
    [{ disabled: true }, 'request_busy'], [{ busy: true }, 'request_busy'], [{ imageUrl: '' }, 'image_missing'], [{ prompt: '   ' }, 'prompt_missing'],
    [{ duration: NaN }, 'duration_invalid'], [{ duration: 601 }, 'duration_invalid'], [{ resolution: '' }, 'resolution_missing'], [{ aspectRatio: '' }, 'aspect_ratio_missing'],
    [{ quote: null }, 'quote_missing'], [{ attempted: true }, 'dispatch_attempted'], [{ uncertain: true }, 'dispatch_uncertain'], [{ unresolved: true }, 'dispatch_uncertain'],
  ];
  for (const [patch, expected] of conditions) { assert.ok(codes(patch).includes(expected), expected); assert.equal(state(patch).diagnostic.blocked, true); }
  assert.match(state({ quote: null }).blockers[0].message, /Help\/informasi model saja belum cukup/);
});

test('prepare quote errors distinguish unknown/nonnumeric cost, missing settings and each exact parameter mismatch', () => {
  for (const credits of [null, undefined, '37', -1, NaN, Infinity, 1000001]) assert.ok(codes({ quote: { settings, quote: { status: 'quoted', credits } } }).includes('quote_credits_invalid'));
  assert.ok(codes({ quote: { settings, quote: { status: 'unavailable', credits: null } } }).includes('quote_not_quoted'));
  for (const received of [undefined, null, [], 'SECRET']) assert.ok(codes({ quote: { settings: received, quote: { status: 'quoted', credits: 37 } } }).includes('quote_settings_missing'));
  const fields = { model_id: [106, 'quote_model_mismatch'], generation_type: ['text', 'quote_generation_mismatch'], duration: [8, 'quote_duration_mismatch'], resolution: ['720p', 'quote_resolution_mismatch'], aspect_ratio: ['9:16', 'quote_aspect_ratio_mismatch'] };
  for (const [key, [value, expected]] of Object.entries(fields)) assert.ok(codes({ quote: { ...valid.quote, settings: { ...settings, [key]: value } } }).includes(expected), key);
  const mismatch = state({ quote: { ...valid.quote, settings: { ...settings, duration: 8, resolution: '720p', aspect_ratio: '9:16' } } });
  assert.match(mismatch.blockers.map(({ message }) => message).join(' '), /8 detik.*6 detik/);
  assert.match(mismatch.blockers.map(({ message }) => message).join(' '), /720p.*1080p/);
  assert.match(mismatch.blockers.map(({ message }) => message).join(' '), /9:16.*16:9/);
});

test('prepare diagnosis is allowlisted and never copies URLs, prompt, approval or arbitrary provider strings', () => {
  const malformed = state({
    quote: { approval: 'SECRET-TICKET', images: [valid.imageUrl], prompt: valid.prompt, settings: { model_id: 'SECRET-ID', duration: Infinity, resolution: 'https://secret.example/SECRET', aspect_ratio: 'SECRET-EMAIL@example.com', generation_type: 'SECRET-MODE', token: 'SECRET' }, quote: { status: 'SECRET-STATUS', credits: 'SECRET-PRICE', message: 'SECRET-PROVIDER-TEXT', source: 'SECRET-SOURCE' }, error: 'SECRET' },
  });
  assert.doesNotMatch(JSON.stringify(malformed), /SECRET|secret\.example|images\.example|@example\.com/);
  assert.deepEqual(malformed.diagnostic.quote.settings, { model_id: null, duration: null, resolution: null, aspect_ratio: null, generation_type: null });
  assert.equal(malformed.diagnostic.quote.credits, null);
  assert.equal(malformed.diagnostic.stage, 'video_prepare_ui');
  assert.equal(malformed.diagnostic.input.image_present, true); assert.equal(malformed.diagnostic.input.prompt_present, true);
  const safe = state({ quote: null }).diagnostic;
  assert.doesNotMatch(JSON.stringify(safe), /SECRET|images\.example/);
  assert.deepEqual(safe.input.settings, settings);
});
