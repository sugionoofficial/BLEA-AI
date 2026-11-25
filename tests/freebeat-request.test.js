import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Freebeat request exposes explicit local non-dispatch marker only on bounded submit errors', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const originalFetch = globalThis.fetch;
  let restore;
  try {
    const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
    const getSession = supabase.auth.getSession;
    supabase.auth.getSession = async () => ({ data: { session: { access_token: 'fake-admin-token' } } });
    restore = () => { supabase.auth.getSession = getSession; };
    const { freebeatRequest } = await vite.ssrLoadModule('/src/api/freebeat.js');
    for (const [action, status, marker, expected] of [
      ['video-submit', 409, 'not_sent', 'not_sent'], ['video-submit', 400, 'not_sent', 'not_sent'],
      ['video-submit', 409, undefined, undefined], ['video-submit', 503, 'not_sent', undefined],
      ['video-submit', 403, 'not_sent', undefined], ['video-submit', 409, 'unknown', undefined],
      ['image-submit', 409, 'not_sent', undefined],
    ]) {
      globalThis.fetch = async (url, options) => {
        assert.equal(url, `/api/freebeat/${action}`); assert.equal(options.cache, 'no-store');
        return Response.json({ error: 'Safe rejection', ...(marker ? { video_dispatch: marker } : {}) }, { status });
      };
      await assert.rejects(freebeatRequest(action, 'POST', { confirm: true }), (error) => {
        assert.equal(error.message, 'Safe rejection'); assert.equal(error.status, status); assert.equal(error.videoDispatch, expected); return true;
      });
    }
  } finally { globalThis.fetch = originalFetch; restore?.(); await vite.close(); }
});
