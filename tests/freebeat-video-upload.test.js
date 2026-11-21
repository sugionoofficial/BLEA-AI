import test from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadFreebeatImage,
  uploadFreebeatAudio,
  uploadFreebeatVideo,
  probeMediaDurationMs,
  deleteFreebeatImage,
  deleteFreebeatMedia,
} from '../src/lib/freebeatVideoUpload.js';

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

test('uploadFreebeatAudio and uploadFreebeatVideo validate types/sizes and deleteFreebeatMedia removes paths', async () => {
  const calls = [];
  const removed = [];
  const storage = { from: (bucket) => {
    assert.equal(bucket, 'ai-studio-uploads');
    return {
      upload: async (...args) => { calls.push(args); return { data: { path: args[0] }, error: null }; },
      getPublicUrl: (path) => ({ data: { publicUrl: `https://example.supabase.co/storage/v1/object/public/ai-studio-uploads/${path}` } }),
      remove: async (paths) => { removed.push(...paths); return { data: paths.map((name) => ({ name })), error: null }; },
    };
  } };
  const uid = '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5';

  const audioFile = { name: 'song.mp3', type: 'audio/mpeg', size: 4096 };
  const audioItem = await uploadFreebeatAudio(storage, uid, audioFile);
  assert.match(audioItem.path, new RegExp(`^${uid}/freebeat-audio/[a-f0-9-]{36}\\.mp3$`));

  const videoFile = { name: 'source-clip.mov', type: 'video/quicktime', size: 1024 * 1024 };
  await assert.rejects(uploadFreebeatVideo(storage, uid, { ...videoFile, type: 'image/png' }), /MP4, MOV, WebM, atau M4V/);
  await assert.rejects(uploadFreebeatVideo(storage, uid, { ...videoFile, size: 100 * 1024 * 1024 + 1 }), /maksimal 100 MB/);
  await assert.rejects(uploadFreebeatVideo(storage, '../bad', videoFile), /Sesi login/);

  const videoItem = await uploadFreebeatVideo(storage, uid, videoFile);
  assert.match(videoItem.path, new RegExp(`^${uid}/freebeat-source-video/[a-f0-9-]{36}\\.mov$`));
  assert.deepEqual(calls[1][2], { contentType: 'video/quicktime', upsert: false });

  await deleteFreebeatMedia(storage, audioItem.path);
  await deleteFreebeatMedia(storage, videoItem.path);
  assert.deepEqual(removed, [audioItem.path, videoItem.path]);

  // probeMediaDurationMs safely returns null in non-browser / missing file cases
  assert.equal(await probeMediaDurationMs(null, 'video'), null);
  assert.equal(await probeMediaDurationMs({ type: 'video/mp4' }, 'video'), null);
});
