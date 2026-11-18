import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadFreebeatImage, deleteFreebeatImage } from '../src/lib/freebeatVideoUpload.js';

test('public image upload validates and uses an unguessable owner path, then verifies deletion', async () => {
  const calls = [];
  const storage = { from: (bucket) => {
    assert.equal(bucket, 'ai-studio-uploads');
    return {
      upload: async (...args) => { calls.push(args); return { data: { path: 'untrusted' }, error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/ai-studio-uploads/${path}` } }),
      remove: async ([path]) => ({ data: [{ name: path }], error: null }),
    };
  } };
  const uid = '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5';
  const file = { name: 'personal name.png', type: 'image/png', size: 1024 };
  for (const invalid of [{ ...file, type: 'image/svg+xml' }, { ...file, size: 0 }, { ...file, size: 10485761 }]) await assert.rejects(uploadFreebeatImage(storage, uid, invalid), /JPG, PNG/);
  await assert.rejects(uploadFreebeatImage(storage, '../admin', file), /Sesi login/);
  assert.equal(calls.length, 0);
  const item = await uploadFreebeatImage(storage, uid, file);
  assert.match(item.path, new RegExp(`^${uid}/freebeat-video/[a-f0-9-]{36}\\.png$`));
  assert.doesNotMatch(item.path, /personal|untrusted/);
  assert.ok(item.url.endsWith(item.path));
  assert.deepEqual(calls[0][2], { contentType: 'image/png', upsert: false });
  await deleteFreebeatImage(storage, item.path);
  await assert.rejects(deleteFreebeatImage({ from: () => ({ remove: async () => ({ data: [], error: null }) }) }, item.path), /belum dapat dikonfirmasi/);
  await assert.rejects(uploadFreebeatImage({ from: () => ({ upload: async () => { throw new Error('network secret'); } }) }, uid, file), /tidak pasti/);
});
