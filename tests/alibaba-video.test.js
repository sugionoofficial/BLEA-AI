import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { resolveProviderApiBase } from '../src/lib/videoCatalog.js';

// Alur Wan 3.0 Video (Model Studio, ap-southeast-1): submit async task
// (X-DashScope-Async), poll GET {base}/api/v1/tasks/{task_id}, lalu ambil
// output.video_url. Semua jaringan di-mock — tidak ada biaya sungguhan.
const BASE = 'https://ws-test.ap-southeast-1.maas.aliyuncs.com';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path, { method = 'POST', body, token = 'user-jwt', headers = {} } = {}) {
  return new Request(`https://app.example${path}`, {
    method,
    headers: {
      origin: 'https://app.example',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function installMock({ keyRow, capture = [] } = {}) {
  const realFetch = globalThis.fetch;
  let storedRow = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init?.method || 'GET').toUpperCase();
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com', app_metadata: { role: 'admin' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json(keyRow ? [keyRow] : []);
    }
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) {
      return Response.json([{ id: 'user-123', status: 'active' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) {
      return Response.json([{ provider: 'alibaba', model: 'wan3.0-video', modality: 'video', credits: 60, active: true }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) {
      return Response.json(true);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) {
      return Response.json(true);
    }
    if (url === `${BASE}/api/v1/services/aigc/video-generation/video-synthesis` && method === 'POST') {
      capture.push({ url, headers: init.headers || {}, body: JSON.parse(init.body || '{}') });
      return Response.json({ request_id: 'req-1', output: { task_id: 'task-wan-1', task_status: 'PENDING' } });
    }
    if (url === `${BASE}/api/v1/tasks/task-wan-1` && method === 'GET') {
      return Response.json({ request_id: 'req-1', output: { task_id: 'task-wan-1', task_status: 'SUCCEEDED', video_url: 'https://cdn-example.oss-ap-southeast-1.aliyuncs.com/wan.mp4' } });
    }
    if (url === 'https://supabase.example/rest/v1/video_generations' && method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      storedRow = { ...payload, id: 'gen-wan-1', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z' };
      return Response.json([storedRow]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?select=')) {
      return Response.json(storedRow ? [storedRow] : []);
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?id=eq.gen-wan-1') && method === 'PATCH') {
      storedRow = { ...storedRow, ...JSON.parse(init.body || '{}') };
      return Response.json([storedRow]);
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  return { restore() { globalThis.fetch = realFetch; } };
}

test('resolveProviderApiBase keeps Alibaba workspace base and strips /api/v1', () => {
  assert.equal(resolveProviderApiBase('alibaba', 'https://ws-test.ap-southeast-1.maas.aliyuncs.com'), 'https://ws-test.ap-southeast-1.maas.aliyuncs.com');
  assert.equal(resolveProviderApiBase('alibaba', 'https://ws-test.ap-southeast-1.maas.aliyuncs.com/api/v1'), 'https://ws-test.ap-southeast-1.maas.aliyuncs.com');
  assert.equal(resolveProviderApiBase('alibaba', ''), '');
});

test('Wan 3.0: submit memakai async task + poll SUCCEEDED memetakan ke completed', async () => {
  const capture = [];
  const mock = installMock({
    keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan 3.0' },
    capture,
  });
  try {
    const env = createEnv();
    const genRes = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: {
          provider: 'alibaba',
          model: 'wan3.0-video',
          prompt: 'Seekor kelinci keluar dari labu saat fajar',
          aspect_ratio: '16:9',
          resolution: '720p',
          duration: 5,
          image_url: 'https://cdn.example/frame.png',
          image_last_url: 'https://cdn.example/frame-end.png',
        },
      }),
      env,
    );
    assert.equal(genRes.status, 200);
    assert.equal(capture.length, 1);
    const submitted = capture[0];
    assert.equal(submitted.headers['X-DashScope-Async'], 'enable');
    assert.equal(submitted.headers.authorization, 'Bearer sk-wan-test');
    assert.equal(submitted.body.model, 'wan3.0-video');
    assert.equal(submitted.body.input.prompt, 'Seekor kelinci keluar dari labu saat fajar');
    assert.deepEqual(submitted.body.input.media, [
      { type: 'first_frame', url: 'https://cdn.example/frame.png' },
      { type: 'last_frame', url: 'https://cdn.example/frame-end.png' },
    ]);
    assert.equal(submitted.body.parameters.resolution, '720P');
    assert.equal(submitted.body.parameters.ratio, '16:9');
    assert.equal(submitted.body.parameters.duration, 5);

    const created = await genRes.json();
    assert.equal(created.ok, true);
    assert.equal(created.generation.status, 'queued');
    assert.equal(created.generation.external_job_id, 'task-wan-1');

    const pollRes = await worker.fetch(apiRequest('/api/video/status', { body: { id: 'gen-wan-1' } }), env);
    assert.equal(pollRes.status, 200);
    const pollData = await pollRes.json();
    assert.equal(pollData.generation.status, 'completed');
    assert.equal(pollData.generation.progress, 100);
    assert.ok(pollData.generation.result_url.startsWith('/api/video/content/gen-wan-1?exp='));
  } finally {
    mock.restore();
  }
});

test('Wan 3.0: mode referensi mengirim multi reference_image/video/audio', async () => {
  const capture = [];
  const mock = installMock({
    keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan 3.0' },
    capture,
  });
  try {
    const env = createEnv();
    const genRes = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: {
          provider: 'alibaba',
          model: 'wan3.0-video',
          prompt: 'Peragakan gaya berpakaian dari foto referensi, transisi halus',
          aspect_ratio: 'adaptive',
          resolution: '1080p',
          duration: 10,
          reference_images: ['https://cdn.example/a.png', 'https://cdn.example/b.png'],
          video_url: 'https://cdn.example/motion.mp4',
          reference_videos: ['https://cdn.example/extra.mp4'],
          reference_audios: ['https://cdn.example/music.mp3'],
        },
      }),
      env,
    );
    assert.equal(genRes.status, 200);
    assert.equal(capture.length, 1);
    const submitted = capture[0];
    assert.deepEqual(submitted.body.input.media, [
      { type: 'reference_image', url: 'https://cdn.example/a.png' },
      { type: 'reference_image', url: 'https://cdn.example/b.png' },
      { type: 'reference_video', url: 'https://cdn.example/motion.mp4' },
      { type: 'reference_video', url: 'https://cdn.example/extra.mp4' },
      { type: 'reference_audio', url: 'https://cdn.example/music.mp3' },
    ]);
    assert.equal(submitted.body.parameters.ratio, 'adaptive');
    assert.equal(submitted.body.parameters.resolution, '1080P');
    assert.equal(submitted.body.parameters.duration, 10);
  } finally {
    mock.restore();
  }
});

test('Wan 3.0: mode frame tidak boleh digabung dengan media referensi (ditolak 400)', async () => {
  const capture = [];
  const mock = installMock({
    keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan 3.0' },
    capture,
  });
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: {
          provider: 'alibaba',
          model: 'wan3.0-video',
          prompt: 'Campuran tidak valid',
          image_url: 'https://cdn.example/frame.png',
          reference_audios: ['https://cdn.example/music.mp3'],
        },
      }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(capture.length, 0, 'permintaan tidak valid tidak boleh memanggil upstream');
    const data = await res.json();
    assert.match(data.error, /tidak bisa digabung/i);
  } finally {
    mock.restore();
  }
});

test('Wan 3.0: batas resmi — >10 foto / >5 video / >5 audio / >20 total ditolak', async () => {
  const capture = [];
  const mock = installMock({
    keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan 3.0' },
    capture,
  });
  const url = (n, ext) => Array.from({ length: n }, (_, i) => `https://cdn.example/r${i}.${ext}`);
  const cases = [
    { reference_images: url(11, 'png') },
    { reference_videos: url(6, 'mp4') },
    { reference_audios: url(6, 'mp3') },
    { reference_images: url(10, 'png'), reference_videos: url(5, 'mp4'), reference_audios: url(6, 'mp3') },
  ];
  try {
    for (const body of cases) {
      const res = await worker.fetch(
        apiRequest('/api/video/generate', { body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'uji batas', ...body } }),
        createEnv(),
      );
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    assert.equal(capture.length, 0);
  } finally {
    mock.restore();
  }
});

test('Wan 3.0: last_frame tanpa first_frame ditolak', async () => {
  const capture = [];
  const mock = installMock({
    keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan 3.0' },
    capture,
  });
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'uji', image_last_url: 'https://cdn.example/end.png' },
      }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    assert.equal(capture.length, 0);
  } finally {
    mock.restore();
  }
});

test('Wan 3.0: base URL kosong ditolak sebelum memanggil provider', async () => {
  const mock = installMock({ keyRow: { provider: 'alibaba', api_key: 'sk-wan-test', base_url: '', label: 'Wan' } });
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', { body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'test' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /base url/i);
  } finally {
    mock.restore();
  }
});

test('Wan 3.0: API key hilang ditolak dengan pesan yang jelas', async () => {
  const mock = installMock({ keyRow: null });
  try {
    const res = await worker.fetch(
      apiRequest('/api/video/generate', { body: { provider: 'alibaba', model: 'wan3.0-video', prompt: 'test' } }),
      createEnv(),
    );
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /API key/i);
  } finally {
    mock.restore();
  }
});

test('/api/catalog provider alibaba menyajikan Wan bawaan tanpa memanggil upstream', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('upstream tidak boleh dipanggil untuk alibaba'); };
  try {
    const res = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'alibaba' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    const wan = (data.models || []).find((m) => m.id === 'wan3.0-video');
    assert.ok(wan, 'wan3.0-video harus ada di katalog alibaba');
    assert.equal(wan.category, 'Video');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/verify alibaba: 401/403 = key ditolak; status lain = key diterima (body kosong)', async () => {
  const realFetch = globalThis.fetch;
  const mockVerify = (status) => {
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = (init?.method || 'GET').toUpperCase();
      if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
        return Response.json([{ provider: 'alibaba', api_key: 'sk-wan-test', base_url: BASE, label: 'Wan' }]);
      }
      if (url === `${BASE}/api/v1/services/aigc/video-generation/video-synthesis` && method === 'POST') {
        return new Response(JSON.stringify({ code: 'InvalidParameter', message: 'model is required' }), { status, headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    };
  };
  try {
    mockVerify(400);
    let res = await worker.fetch(apiRequest('/api/verify', { body: { provider: 'alibaba' } }), createEnv());
    assert.equal(res.status, 200);
    assert.equal((await res.json()).valid, true);

    mockVerify(403);
    res = await worker.fetch(apiRequest('/api/verify', { body: { provider: 'alibaba' } }), createEnv());
    assert.equal((await res.json()).valid, false);

    mockVerify(401);
    res = await worker.fetch(apiRequest('/api/verify', { body: { provider: 'alibaba' } }), createEnv());
    assert.equal((await res.json()).valid, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
