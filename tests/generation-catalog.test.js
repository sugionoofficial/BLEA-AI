import test from 'node:test';
import assert from 'node:assert/strict';
import { availableVideoModels, generationModelKey } from '../src/lib/generationCatalog.js';

test('Generate video shows only configured and admin-enabled non-UnoRouter models', () => {
  const valid = { id: 'vid-1', provider: 'custom', activeInAdmin: true, providerConfigured: true };
  const input = [valid, { ...valid, provider: 'UnoRouter' }, { ...valid, provider: '' }, { ...valid, activeInAdmin: false }, { ...valid, providerConfigured: false }, { ...valid, id: '' }, null];
  assert.deepEqual(availableVideoModels(input), [valid]);
  assert.deepEqual(availableVideoModels(null), []);
  assert.equal(generationModelKey(valid), 'custom::vid-1');
});
