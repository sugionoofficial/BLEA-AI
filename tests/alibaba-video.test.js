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
    if (url === `${BASE}/api/v1/services/aigc/video-generation/video-synthesis` && method === 'POST') {
      capture.push({ url, headers: init.headers || {}, body: JSON.parse(init.body || '{}') });
      return Response.json({ request_id: 'req-1', output: { task_id: 'task-wan-1', task_status: 'PENDING' } });
    }
    if (url === `${BASE}/api/v1/tasks/task-wan-1` && method === 'GET') {
      return Response.json({ request_id: 'req-1', output: { task_id: 'task-wan-1', task_status: 'SUCCEEDED', video_url: 'https://cdn-example.oss-ap-southeast-1.aliyuncs.com/wan.mp4' } });
    }
    if (url === 'https://supabase.example/rest/v1/video_generations' && method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      storedRow = { id: 'gen-wan-1', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', ...payload };
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
          video_url: 'https://cdn.example/ref.mp4',
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
      { type: 'reference_video', url: 'https://cdn.example/ref.mp4' },
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
