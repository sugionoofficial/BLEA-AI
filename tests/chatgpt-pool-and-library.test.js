import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  CHATGPT_CAPABILITIES,
  jakartaDate,
  sanitizeChatGptAccount,
  sealChatGptToken,
  unsealChatGptToken,
  validateChatGptAccountInput,
} from '../src/lib/chatgptPool.js';
import {
  agentToolsForStudioTool,
  capabilityForApiPath,
  toolCapabilityViolation,
} from '../src/lib/toolCapabilities.js';
import { STUDIO_TOOLS } from '../src/studio/toolCatalog.js';

const BASE = 'https://app.example';
const ENV = {
  SUPABASE_URL: 'https://supabase.example',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
  PROVIDER_CREDENTIAL_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
};

function request(path, { method = 'POST', body, token = 'user-jwt', headers = {} } = {}) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

test('kredensial pool disegel AES-GCM dan tidak bisa dibuka dengan kunci lain', async () => {
  const sealed = await sealChatGptToken(ENV, 'sk-uji-1234567890abcdef');
  assert.match(sealed, /^[^.]+\.[^.]+$/);
  assert.equal(await unsealChatGptToken(ENV, sealed), 'sk-uji-1234567890abcdef');
  const otherEnv = { ...ENV, PROVIDER_CREDENTIAL_ENCRYPTION_KEY: 'kunci-lain-yang-tidak-sama-0123456789abcdef0123456789abcdef' };
  assert.equal(await unsealChatGptToken(otherEnv, sealed), '');
  assert.equal(await unsealChatGptToken(ENV, 'bukan-segel'), '');
});

test('tanggal kuota memakai WIB, bukan UTC', () => {
  // 2026-11-23T18:30Z = 2026-11-24 01:30 WIB → kuota sudah berganti hari.
  assert.equal(jakartaDate(new Date('2026-11-23T18:30:00Z')), '2026-11-24');
  assert.equal(jakartaDate(new Date('2026-11-23T16:59:00Z')), '2026-11-23');
});

test('sanitizeChatGptAccount tidak pernah membocorkan kredensial dan menandai kuota habis', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    account_email: 'admin@example.com',
    account_label: 'Akun utama',
    credential_kind: 'api_key',
    sealed_token: 'rahasia.tersegel',
    token_hint: '••••abcd',
    enabled: true,
    priority: 10,
    daily_limit: 2,
    used_today: 2,
    quota_date: jakartaDate(),
    capabilities: ['chat'],
    consecutive_failures: 0,
  };
  const row = sanitizeChatGptAccount(base);
  assert.equal(row.state, 'kuota-habis');
  assert.equal(row.remaining, 0);
  assert.equal(row.usable, false);
  assert.equal(JSON.stringify(row).includes('tersegel'), false);
  assert.equal(JSON.stringify(row).includes('sealed_token'), false);

  const reset = sanitizeChatGptAccount({ ...base, quota_date: '2020-01-01' });
  assert.equal(reset.used_today, 0);
  assert.equal(reset.state, 'siap');

  const cooling = sanitizeChatGptAccount({
    ...base,
    used_today: 0,
    cooldown_until: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(cooling.state, 'cooldown');
  assert.equal(cooling.usable, false);

  // Token sesi ChatGPT bisa disimpan, tetapi tidak pernah dianggap bisa dipanggil.
  const session = sanitizeChatGptAccount({ ...base, used_today: 0, credential_kind: 'session' });
  assert.equal(session.state, 'tidak-bisa-dipanggil');
  assert.equal(session.usable, false);
});

test('validasi input menolak base URL tidak aman dan kapabilitas asing', () => {
  assert.throws(() => validateChatGptAccountInput({ api_base: 'http://api.openai.com' }), /HTTPS/);
  assert.throws(() => validateChatGptAccountInput({ api_base: 'https://user:pass@api.openai.com' }), /HTTPS/);
  assert.deepEqual(validateChatGptAccountInput({ api_base: 'https://api.openai.com/v1' }).api_base, 'https://api.openai.com');
  assert.deepEqual(validateChatGptAccountInput({ capabilities: ['chat', 'image'] }).capabilities, ['chat', 'image']);
  // Kapabilitas di luar daftar dibuang, bukan diteruskan diam-diam.
  assert.deepEqual(validateChatGptAccountInput({ capabilities: ['chat', 'video-ajaib'] }).capabilities, ['chat']);
});

test('setiap tool Studio mendeklarasikan kapabilitasnya sendiri', () => {
  for (const tool of STUDIO_TOOLS) {
    assert.ok(Array.isArray(tool.capabilities), `${tool.id}: capabilities wajib ada`);
    for (const capability of tool.capabilities) {
      assert.ok(CHATGPT_CAPABILITIES.includes(capability) || ['search', 'library'].includes(capability), `${tool.id}: kapabilitas ${capability} tidak dikenal`);
    }
  }
  const library = STUDIO_TOOLS.find((tool) => tool.id === 'library');
  assert.ok(library, 'entri library wajib ada');
  assert.equal(library.href, '/studio/library');
  assert.deepEqual(library.capabilities, ['library']);
});

test('isolasi tool: ruang gambar tidak boleh memanggil video, riset tidak boleh usul klip', () => {
  assert.equal(capabilityForApiPath('/api/video/generate'), 'video');
  assert.equal(capabilityForApiPath('/api/agent/transcribe'), 'audio');
  assert.equal(capabilityForApiPath('/api/agent'), 'agent');
  assert.equal(toolCapabilityViolation('image', '/api/video/generate').code, 'tool_capability_mismatch');
  assert.equal(toolCapabilityViolation('image', '/api/image/generate'), null);
  assert.equal(toolCapabilityViolation('research', '/api/image/generate').code, 'tool_capability_mismatch');
  assert.equal(toolCapabilityViolation('research', '/api/search'), null);
  assert.equal(toolCapabilityViolation('connect-ai', '/api/chat').code, 'tool_capability_mismatch');
  assert.deepEqual(agentToolsForStudioTool('research'), ['web_search', 'read_url', 'load_skill']);
  assert.equal(agentToolsForStudioTool('research').includes('propose_clips'), false);
  assert.equal(agentToolsForStudioTool('image'), null);
});

test('worker menolak permintaan lintas-tool lewat header ruang Studio', async () => {
  const res = await worker.fetch(
    request('/api/video/generate', { body: { prompt: 'x' }, headers: { 'x-blea-studio-tool': 'image' } }),
    ENV,
  );
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.code, 'tool_capability_mismatch');
  assert.match(data.error, /hanya menjalankan fungsinya sendiri/);
});

test('tanpa header ruang Studio jalur lama tetap jalan (bukan 403)', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'u1', app_metadata: { role: 'user' } });
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/chatgpt_accounts')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/')) return Response.json([]);
    return Response.json({});
  };
  try {
    const res = await worker.fetch(request('/api/models', { body: {} }), ENV);
    assert.notEqual(res.status, 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('rute pool akun ChatGPT hanya untuk admin dan tidak mengirim kredensial', async () => {
  const realFetch = globalThis.fetch;
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    account_email: 'admin@example.com',
    account_label: 'Utama',
    credential_kind: 'api_key',
    sealed_token: await sealChatGptToken(ENV, 'sk-rahasia-panjang-1234'),
    token_hint: '••••1234',
    enabled: true,
    priority: 10,
    daily_limit: 100,
    used_today: 3,
    quota_date: jakartaDate(),
    capabilities: ['chat'],
    consecutive_failures: 0,
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') {
      const bearer = (init?.headers?.authorization || '').replace('Bearer ', '');
      return Response.json({ id: `uid-${bearer}`, app_metadata: { role: bearer.startsWith('admin') ? 'admin' : 'user' } });
    }
    if (url.startsWith('https://supabase.example/rest/v1/chatgpt_accounts')) {
      const method = init.method || 'GET';
      if (method === 'POST') return Response.json([{ ...row, ...JSON.parse(init.body) }]);
      if (method === 'PATCH') return Response.json([{ ...row, ...JSON.parse(init.body), id: row.id }]);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json([row]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const denied = await worker.fetch(request('/api/chatgpt-accounts', { method: 'GET', token: 'user-jwt' }), ENV);
    assert.equal(denied.status, 403);

    const list = await worker.fetch(request('/api/chatgpt-accounts', { method: 'GET', token: 'admin-jwt' }), ENV);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].state, 'siap');
    assert.equal(JSON.stringify(body).includes('sk-rahasia'), false);
    assert.deepEqual(body.capabilities, CHATGPT_CAPABILITIES);

    const created = await worker.fetch(request('/api/chatgpt-accounts', {
      token: 'admin-jwt',
      body: { account_email: 'baru@example.com', token: 'sk-kunci-baru-1234', daily_limit: 50, capabilities: ['chat', 'agent'] },
    }), ENV);
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(JSON.stringify(createdBody).includes('sk-kunci-baru-1234'), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/library menggabungkan hasil beberapa tool milik pengguna', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'u1', app_metadata: { role: 'user' } });
    if (url.startsWith('https://supabase.example/rest/v1/profiles')) return Response.json([]);
    if (url.includes('/image_generations')) {
      return Response.json([{ id: 'img-1', user_id: 'u1', prompt: 'kucing oranye', status: 'completed', image_url: 'https://cdn.example/a.png', credits_charged: 5, created_at: '2026-11-20T10:00:00Z', metadata: {} }]);
    }
    if (url.includes('/video_generations')) {
      return Response.json([{ id: 'vid-1', user_id: 'u1', prompt: 'pantai', status: 'failed', error_message: 'kuota habis', created_at: '2026-11-21T10:00:00Z' }]);
    }
    if (url.includes('/music_generations')) return Response.json([]);
    if (url.includes('/metadata_jobs')) {
      return Response.json([{ id: 'met-1', user_id: 'u1', filename: 'foto.png', media_kind: 'image', status: 'completed', ai_detected: true, detected_tools: ['midjourney'], removed_count: 4, created_at: '2026-11-19T10:00:00Z' }]);
    }
    if (url.includes('/ai_messages')) {
      return Response.json([{ id: 'msg-1', role: 'assistant', content: 'Ringkasan riset pasar.', created_at: '2026-11-22T10:00:00Z' }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(request('/api/library', { body: { limit: 20 } }), ENV);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    const tools = data.items.map((item) => item.tool);
    // Hasil diurutkan dari yang terbaru: chat → video → gambar → metadata.
    assert.deepEqual(tools, ['chat', 'video', 'image', 'metadata']);
    const image = data.items.find((item) => item.tool === 'image');
    assert.equal(image.text, 'kucing oranye');
    assert.ok(image.download_url.startsWith('/api/image/content/'));
    const metadata = data.items.find((item) => item.tool === 'metadata');
    assert.match(metadata.text, /midjourney/);
    const video = data.items.find((item) => item.tool === 'video');
    assert.equal(video.download_url, '');
    assert.equal(video.error, 'kuota habis');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/library menolak permintaan tanpa login', async () => {
  const res = await worker.fetch(request('/api/library', { body: {}, token: '' }), ENV);
  assert.equal(res.status, 401);
});

// ---- Render halaman (regresi "halaman hitam") -----------------------------
// Halaman baru diuji dengan SSR karena build produksi bisa lolos walau ada
// identifier yang tidak pernah diimpor. Kalau halaman ini error saat render,
// pengguna hanya melihat layar kosong.
test('halaman Hasil & Unduhan serta Akun ChatGPT bisa dirender tanpa navigasi sendiri', async () => {
  const { createServer } = await import('vite');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [
        {
          find: /^react-router-dom$/,
          replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname,
        },
      ],
    },
  });
  try {
    const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
    const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
    const { LibraryPage } = await vite.ssrLoadModule('/src/studio/LibraryPage.jsx');
    const { ChatGptAccountsPage } = await vite.ssrLoadModule('/src/studio/ChatGptAccountsPage.jsx');

    const libraryHtml = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(AuthProvider, { initialSession: null }, React.createElement(LibraryPage))),
    );
    assert.ok(libraryHtml.includes('Satu halaman untuk semua hasil.'));
    assert.ok(libraryHtml.includes('Kenapa tool dipisah?'));
    assert.ok(libraryHtml.includes('Unduh'));

    const accountsHtml = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(AuthProvider, { initialSession: null }, React.createElement(ChatGptAccountsPage))),
    );
    // Sejak jalur OAuth resmi ("Continue with ChatGPT") ditambahkan, halaman ini
    // menonjolkan koneksi tanpa API key, bukan lagi "ditambahkan manual".
    assert.ok(accountsHtml.includes('ChatGPT disambungkan seperti freebeat.'));
    assert.ok(accountsHtml.includes('Continue with ChatGPT'));
    assert.ok(accountsHtml.includes('Tambah akun manual'));
    assert.ok(accountsHtml.includes('Bagaimana pemilihan akun bekerja'));
  } finally {
    await vite.close();
  }
});

// Regresi: halaman Koneksi pernah menulis "Tersambung" untuk ChatGPT padahal
// tidak ada satu pun akun OAuth di server — klaim tanpa bukti. Sekarang label
// itu hanya muncul bila server melaporkan tautan berstatus linked.
test('halaman Koneksi tidak mengklaim ChatGPT tersambung tanpa bukti', async () => {
  const { createServer } = await import('vite');
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });
  try {
    const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
    const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
    const { ConnectionPage } = await vite.ssrLoadModule('/src/studio/ConnectionPage.jsx');
    const html = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(AuthProvider, { initialSession: null }, React.createElement(ConnectionPage))),
    );
    // Sebelum diperiksa, status tidak boleh diklaim.
    assert.ok(!/ChatGPT[\s\S]{0,400}Tersambung/.test(html), 'tidak boleh ada klaim Tersambung untuk ChatGPT sebelum diukur');
    assert.ok(html.includes('Status dari server, bukan label di halaman ini.'));
    assert.ok(html.includes('Belum diperiksa'));
  } finally {
    await vite.close();
  }
});
