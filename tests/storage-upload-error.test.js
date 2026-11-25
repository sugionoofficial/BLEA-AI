import test from 'node:test';
import assert from 'node:assert/strict';
import { isStorageSizeError, storageUploadErrorMessage } from '../src/lib/storageUploadError.js';
import { uploadFreebeatVideo } from '../src/lib/freebeatVideoUpload.js';

test('recognizes Storage size rejection shapes without treating other failures as size errors', () => {
  for (const error of [
    { statusCode: '413' }, { status: 413 }, { code: 'EntityTooLarge' }, { code: 'PayloadTooLarge' },
    { message: 'The object exceeded the maximum allowed size' }, { message: 'Payload Too Large' },
  ]) {
    assert.equal(isStorageSizeError(error), true);
    const message = storageUploadErrorMessage(error, { kind: 'video', size: 60 * 1024 * 1024 });
    assert.match(message, /video \(60\.0 MB\)/);
    assert.match(message, /batas global Storage dan batas bucket/);
    assert.match(message, /URL HTTPS publik/);
    assert.doesNotMatch(message, /Freebeat|dikembalikan|50 MB/);
  }
  for (const error of [null, undefined, { statusCode: 403 }, { message: 'network unavailable' }]) {
    assert.equal(isStorageSizeError(error), false);
    assert.equal(storageUploadErrorMessage(error, { fallback: 'safe fallback' }), 'safe fallback');
  }
  const message = storageUploadErrorMessage({ status: 413, message: 'https://private.example/token secret' });
  assert.doesNotMatch(message, /private\.example|secret|NaN|undefined/);
});

test('Freebeat source video handles returned and thrown size errors without retries or public URLs', async () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const storage = { from: () => ({
      upload: async () => {
        calls += 1;
        const error = { statusCode: '413', message: 'The object exceeded the maximum allowed size' };
        if (throws) throw error;
        return { data: null, error };
      },
      getPublicUrl: () => assert.fail('must not construct URL for a rejected upload'),
    }) };
    await assert.rejects(uploadFreebeatVideo(storage, '0937495e-9c1e-4a8f-b0cd-d8c527dd3db5', {
      name: 'video.mp4', type: 'video/mp4', size: 60 * 1024 * 1024,
    }), /Ukuran video \(60\.0 MB\) ditolak/);
    assert.equal(calls, 1);
  }
});
