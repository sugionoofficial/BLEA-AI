import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const BASE = 'https://blea.example';
const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon' };
function request(path, body) {
  return new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer admin', origin: BASE, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test('OFF disimpan dan menutup katalog serta permintaan gambar dan video meskipun tarif masih aktif', async () => {
  const ids = ['122', 'generate_dance_video', 'generate_singing_video', 'generate_lip_sync_video'];
  const active = new Set(ids);
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
    if (url.pathname === '/rest/v1/profiles') return Response.json([{ status: 'active' }]);
    if (url.pathname === '/rest/v1/provider_models') {
      if (method === 'PATCH') { active.clear(); return Response.json([]); }
      if (method === 'POST') { for (const row of JSON.parse(init.body)) { if (row.active) active.add(row.model); } return Response.json([]); }
      const filter = url.searchParams.get('model')?.replace(/^eq\./, '');
      return Response.json([...active].filter((id) => !filter || id === filter).map((model) => ({ provider: 'freebeat', model, active: true })));
    }
    if (url.pathname === '/rest/v1/credit_model_prices') return Response.json([{ credits: 3000 }]);
    if (url.pathname.startsWith('/rest/v1/')) return Response.json([]);
    throw new Error(`Unexpected request ${url}`);
  };
  try {
    let result = await worker.fetch(request('/api/video/models'), env);
    assert.equal((await result.json()).models.filter((m) => m.provider === 'freebeat').length, 3);
    result = await worker.fetch(request('/api/image/config'), env);
    assert.ok((await result.json()).models.some((m) => m.provider === 'freebeat'));
    result = await worker.fetch(request('/api/save-models', { provider: 'freebeat', models: [] }), env);
    assert.equal(result.status, 200);
    assert.equal(active.size, 0);
    result = await worker.fetch(request('/api/admin-models'), env);
    assert.ok(!(await result.json()).models.some((m) => m.provider === 'freebeat' && m.active));
    result = await worker.fetch(request('/api/video/models'), env);
    assert.ok(!(await result.json()).models.some((m) => m.provider === 'freebeat'));
    result = await worker.fetch(request('/api/image/config'), env);
    assert.ok(!(await result.json()).models.some((m) => m.provider === 'freebeat'));
    const inputs = [
      ['/api/image/generate', { provider: 'freebeat', prompt: 'test' }],
      ['/api/video/generate', { provider: 'freebeat', model: 'generate_dance_video', audio_url: 'https://cdn.example/song.mp3' }],
      ['/api/video/generate', { provider: 'freebeat', model: 'generate_singing_video', audio_url: 'https://cdn.example/song.mp3', reference_images: ['https://cdn.example/singer.jpg'], duration: 15 }],
      ['/api/video/generate', { provider: 'freebeat', model: 'generate_lip_sync_video', audio_url: 'https://cdn.example/song.mp3', video_url: 'https://cdn.example/face.mp4', video_duration_ms: 14000 }],
    ];
    for (const [path, body] of inputs) {
      result = await worker.fetch(request(path, body), env);
      assert.equal(result.status, 409, `${body.model || '122'}: ${await result.clone().text()}`);
      assert.match((await result.json()).error, /belum diaktifkan admin/);
    }
    assert.ok(!calls.some((call) => call.includes('spend_credits')));
    result = await worker.fetch(request('/api/save-models', { provider: 'freebeat', models: ['122', 'generate_dance_video'] }), env);
    assert.equal(result.status, 200);
    result = await worker.fetch(request('/api/image/config'), env);
    assert.ok((await result.json()).models.some((m) => m.model === '122'));
    result = await worker.fetch(request('/api/video/models'), env);
    assert.deepEqual((await result.json()).models.filter((m) => m.provider === 'freebeat').map((m) => m.id), ['generate_dance_video']);
  } finally { globalThis.fetch = realFetch; }
});

test('gagal membaca atau menonaktifkan model tidak dilaporkan berhasil', async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const failure of ['read', 'patch']) {
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.pathname === '/auth/v1/user') return Response.json({ id: 'admin', app_metadata: { role: 'admin' } });
        if (url.pathname === '/rest/v1/provider_models' && !init.method) return failure === 'read' ? new Response('error', { status: 500 }) : Response.json([{ model: '122' }]);
        if (url.pathname === '/rest/v1/provider_models' && init.method === 'PATCH') return new Response('error', { status: 500 });
        throw new Error(`Unexpected request ${url}`);
      };
      const result = await worker.fetch(request('/api/save-models', { provider: 'freebeat', models: [] }), env);
      assert.equal(result.status, 500, failure);
      assert.ok(!(await result.json()).ok);
    }
  } finally { globalThis.fetch = realFetch; }
});
