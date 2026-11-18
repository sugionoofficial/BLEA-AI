import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  computeVideoSize,
  getVideoModelProfile,
  isVideoCatalogModel,
  isVideoModelId,
  normalizeVideoStatus,
  resolveProviderApiBase,
} from '../src/lib/videoCatalog.js';

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

test('videoCatalog helpers detect video models, resolve bases, compute sizes, and normalize statuses', () => {
  assert.equal(isVideoModelId('gemini-omni-1.2-flash:free'), true);
  assert.equal(isVideoModelId('veo3.1'), true);
  assert.equal(isVideoModelId('doubao-seedance-1-5-pro-251215'), true);
  assert.equal(isVideoModelId('grok-video-3'), true);
  assert.equal(isVideoModelId('gpt-oss-120b:free'), false);

  assert.equal(
    isVideoCatalogModel({ model_name: 'custom-clip-v1', type: 'video', tags: 'Video' }, { mode: 'chat', outputModalities: ['video'] }),
    true,
  );
  assert.equal(
    isVideoCatalogModel({ model_name: 'gpt-oss-120b:free', type: 'text', tags: 'Text' }, { mode: 'chat', outputModalities: ['text'] }),
    false,
  );

  assert.equal(computeVideoSize('16:9', '720p'), '1280x720');
  assert.equal(computeVideoSize('9:16', '1080p'), '1080x1920');
  assert.equal(computeVideoSize('1:1', '4k'), '2160x2160');

  assert.equal(resolveProviderApiBase('unorouter'), 'https://api.unorouter.com/v1');
  assert.equal(resolveProviderApiBase('openrouter'), 'https://openrouter.ai/api/v1');
  assert.equal(resolveProviderApiBase('custom', 'https://my-gateway.example/api'), 'https://my-gateway.example/api/v1');
  assert.equal(resolveProviderApiBase('custom', 'https://my-gateway.example/v1/'), 'https://my-gateway.example/v1');

  assert.equal(normalizeVideoStatus('pending'), 'queued');
  assert.equal(normalizeVideoStatus('IN_PROGRESS'), 'in_progress');
  assert.equal(normalizeVideoStatus('succeeded'), 'completed');
  assert.equal(normalizeVideoStatus('error'), 'failed');

  const veo = getVideoModelProfile('veo3.1', 'unorouter');
  assert.equal(veo.isFree, false);
  assert.equal(veo.supportsAudio, true);
  assert.ok(veo.aspectRatios.includes('16:9'));
});

test('/api/catalog includes both free and paid UnoRouter video models under Video category', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.unorouter.com/api/pricing') {
      return Response.json({
        data: [
          { model_name: 'gpt-oss-120b:free', is_free: true, online: true, tags: 'Text', metadata: '{"mode":"chat","outputModalities":["text"]}' },
          { model_name: 'paid-chat-only', is_free: false, online: true, tags: 'Text', metadata: '{"mode":"chat","outputModalities":["text"]}' },
          { model_name: 'veo3.1', is_free: false, online: true, tags: 'Google,Video', model_price: 0.4, metadata: '{"mode":"video","outputModalities":["video"]}' },
          { model_name: 'gemini-omni-1.2-flash:free', is_free: true, online: false, tags: 'Google,Video', metadata: '{"mode":"chat","outputModalities":["video"]}' },
        ],
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(apiRequest('/api/catalog', { body: { provider: 'unorouter' } }), createEnv());
    assert.equal(res.status, 200);
    const data = await res.json();
    const ids = data.models.map((m) => m.id);
    assert.ok(ids.includes('gpt-oss-120b:free'));
    assert.ok(ids.includes('veo3.1'));
    assert.ok(ids.includes('gemini-omni-1.2-flash:free'));
    assert.equal(ids.includes('paid-chat-only'), false);
    const veo = data.models.find((m) => m.id === 'veo3.1');
    assert.equal(veo.category, 'Video');
    assert.equal(veo.isFree, false);
    assert.equal(veo.priceLabel, '$0.4/s');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/verify validates custom baseUrl provider key via GET /models', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://openrouter.ai/api/v1/models') {
      assert.equal(init.headers.authorization, 'Bearer sk-or-test');
      return Response.json({ data: [{ id: 'google/veo-3.1' }, { id: 'openai/sora-2' }] });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([]);
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(
      apiRequest('/api/verify', { body: { provider: 'openrouter', apiKey: 'sk-or-test' } }),
      createEnv(),
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.valid, true);
    assert.equal(data.verifiedVia, 'models');
    assert.equal(data.modelsCount, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/video/generate, /api/video/status, and signed /api/video/content/:id flow end-to-end', async () => {
  const realFetch = globalThis.fetch;
  let storedRow = null;
  let upstreamGenerateBody = null;

  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      return Response.json({ id: 'user-123', email: 'creator@example.com' });
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      if (url.includes('provider=eq.unorouter')) {
        return Response.json([{ provider: 'unorouter', api_key: 'uno-secret-key', base_url: 'https://api.unorouter.com', label: 'UnoRouter' }]);
      }
      if (url.includes('provider=eq.openrouter')) {
        return Response.json([{ provider: 'openrouter', api_key: 'or-secret-key', base_url: 'https://openrouter.ai/api/v1', label: 'OpenRouter' }]);
      }
      return Response.json([]);
    }
    if (url === 'https://cdn.example/frame.png') {
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    if (url === 'https://api.unorouter.com/v1/videos' && init.method === 'POST') {
      upstreamGenerateBody = JSON.parse(init.body);
      return Response.json({ id: 'job-uno-999', status: 'queued', progress: 10 });
    }
    if (url === 'https://openrouter.ai/api/v1/videos' && init.method === 'POST') {
      upstreamGenerateBody = JSON.parse(init.body);
      return Response.json({ id: 'job-or-777', status: 'in_progress', polling_url: 'https://openrouter.ai/api/v1/videos/job-or-777' });
    }
    if (url === 'https://supabase.example/rest/v1/video_generations' && init.method === 'POST') {
      const payload = JSON.parse(init.body);
      storedRow = { id: 'gen-uuid-1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', ...payload };
      return Response.json([storedRow]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?select=') && (!init?.method || init.method === 'GET')) {
      return Response.json(storedRow ? [storedRow] : []);
    }
    if (url === 'https://api.unorouter.com/v1/videos/job-uno-999' && (!init?.method || init.method === 'GET')) {
      return Response.json({
        id: 'job-uno-999',
        status: 'completed',
        progress: 100,
        url: 'https://api.unorouter.com/v1/videos/job-uno-999/content',
      });
    }
    if (url.startsWith('https://supabase.example/rest/v1/video_generations?id=eq.gen-uuid-1') && init?.method === 'PATCH') {
      storedRow = { ...storedRow, ...JSON.parse(init.body) };
      return Response.json([storedRow]);
    }
    if (url === 'https://api.unorouter.com/v1/videos/job-uno-999/content') {
      assert.equal(init.headers.authorization, 'Bearer uno-secret-key');
      assert.equal(init.headers.range, 'bytes=0-3');
      return new Response(new Uint8Array([0, 0, 0, 24]), {
        status: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-3/4',
          'content-length': '4',
        },
      });
    }
    throw new Error(`Unexpected fetch: ${init?.method || 'GET'} ${url}`);
  };

  try {
    const env = createEnv();

    // 1. Unauthenticated request blocked
    const unauth = await worker.fetch(apiRequest('/api/video/generate', { token: '', body: { model: 'veo3.1', prompt: 'test' } }), env);
    assert.equal(unauth.status, 401);

    // 2. Empty prompt & no media rejected
    const emptyRes = await worker.fetch(apiRequest('/api/video/generate', { body: { model: 'veo3.1', prompt: '   ' } }), env);
    assert.equal(emptyRes.status, 400);

    // 3. UnoRouter Veo generation inlines HTTPS image URL to data URL
    const genRes = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: {
          provider: 'unorouter',
          model: 'veo3.1',
          prompt: 'Sunset drone shot',
          aspect_ratio: '16:9',
          resolution: '720p',
          duration: 8,
          image_url: 'https://cdn.example/frame.png',
          audio_url: 'https://cdn.example/music.mp3',
        },
      }),
      env,
    );
    assert.equal(genRes.status, 200);
    const genData = await genRes.json();
    assert.equal(genData.ok, true);
    assert.equal(genData.generation.status, 'queued');
    assert.ok(upstreamGenerateBody.input_reference.startsWith('data:image/png;base64,'));
    assert.equal(upstreamGenerateBody.size, '1280x720');
    assert.equal(upstreamGenerateBody.duration, 8);

    // 4. OpenRouter job maps frame_images + input_references cleanly
    const orRes = await worker.fetch(
      apiRequest('/api/video/generate', {
        body: {
          provider: 'openrouter',
          model: 'google/veo-3.1',
          prompt: 'Cyberpunk motorcycle chase',
          aspect_ratio: '9:16',
          resolution: '1080p',
          duration: 5,
          image_url: 'https://cdn.example/frame.png',
          video_url: 'https://cdn.example/ref.mp4',
          audio_url: 'https://cdn.example/beat.mp3',
        },
      }),
      env,
    );
    assert.equal(orRes.status, 200);
    assert.equal(upstreamGenerateBody.frame_images[0].image_url.url, 'https://cdn.example/frame.png');
    assert.equal(upstreamGenerateBody.input_references.length, 2);

    // 5. Status polling updates row and returns signed /api/video/content/:id URL
    storedRow.provider = 'unorouter';
    storedRow.external_job_id = 'job-uno-999';
    storedRow.polling_url = 'https://api.unorouter.com/v1/videos/job-uno-999';
    storedRow.status = 'queued';
    const pollRes = await worker.fetch(apiRequest('/api/video/status', { body: { id: 'gen-uuid-1' } }), env);
    assert.equal(pollRes.status, 200);
    const pollData = await pollRes.json();
    assert.equal(pollData.generation.status, 'completed');
    assert.ok(pollData.generation.result_url.startsWith('/api/video/content/gen-uuid-1?exp='));

    // 6. Signed content proxy streams with Range passthrough; tampered sig is rejected
    const contentRes = await worker.fetch(
      apiRequest(pollData.generation.result_url, { method: 'GET', token: '', headers: { range: 'bytes=0-3' } }),
      env,
    );
    assert.equal(contentRes.status, 206);
    assert.equal(contentRes.headers.get('content-type'), 'video/mp4');
    const bytes = new Uint8Array(await contentRes.arrayBuffer());
    assert.deepEqual(Array.from(bytes), [0, 0, 0, 24]);

    const tamperedRes = await worker.fetch(
      apiRequest('/api/video/content/gen-uuid-1?exp=9999999999999&sig=bad-signature', { method: 'GET', token: '' }),
      env,
    );
    assert.equal(tamperedRes.status, 401);
  } finally {
    globalThis.fetch = realFetch;
  }
});
