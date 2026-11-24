import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import {
  OPENAI_CAPABILITIES,
  jakartaDate,
  sanitizeOpenAiAccount,
  classifyOpenAiFailure,
  openAiFailureMessage,
  openAiPoolBlockedMessage,
  openAiPoolDiagnostic,
  recordOpenAiUsage,
  readOpenAiSealedField,
  sealOpenAiToken,
  unsealOpenAiToken,
  validateOpenAiAccountInput,
} from '../src/lib/openaiPool.js';
import {
  agentToolsForStudioTool,
  capabilityForApiPath,
  toolCapabilityViolation,
} from '../src/lib/toolCapabilities.js';
import { handleAgentTurn } from '../src/agent/agentRoute.js';
import { STUDIO_TOOLS } from '../src/studio/toolCatalog.js';
import {
  OPENAI_CAPABILITY_MATRIX,
  capabilitiesForTool,
  unpipedCapabilities,
  wiredCapabilities,
} from '../src/lib/openaiCapabilities.js';

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
  const sealed = await sealOpenAiToken(ENV, 'sk-uji-1234567890abcdef');
  assert.match(sealed, /^[^.]+\.[^.]+$/);
  assert.equal(await unsealOpenAiToken(ENV, sealed), 'sk-uji-1234567890abcdef');
  const otherEnv = { ...ENV, PROVIDER_CREDENTIAL_ENCRYPTION_KEY: 'kunci-lain-yang-tidak-sama-0123456789abcdef0123456789abcdef' };
  assert.equal(await unsealOpenAiToken(otherEnv, sealed), '');
  assert.equal(await unsealOpenAiToken(ENV, 'bukan-segel'), '');
});

// Regresi nyata 2026-11-24: akun tersimpan 04:25 UTC, lalu rename produk
// (#208) mengganti string derivation kunci enkripsi. Token lama tidak bisa
// dibuka lagi, `pickOpenAiAccount` melewati akun itu, pool tampak kosong, dan
// pengguna melihat "API key untuk provider openai belum dikonfigurasi" padahal
// kuncinya ada. Penyegel HARUS tetap bisa membaca segel format lama dan
// menaik-formatkannya, bukan menghapus kredensial pengguna.
test('segel lama tetap terbuka dan dinaikkan ke format sekarang', async () => {
  const enc = new TextEncoder();
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
  // Format lama: derivation + AAD sebelum rename produk.
  const legacyInfo = atob('YmxlYS1jaGF0Z3B0LXBvb2wtdjE=');
  const legacyAad = atob('Y2hhdGdwdC1jcmVkZW50aWFs');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${legacyInfo}:${ENV.PROVIDER_CREDENTIAL_ENCRYPTION_KEY}`));
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(legacyAad) }, key, enc.encode('sk-lama-rahasia-1234'));
  const legacySealed = `${b64url(iv)}.${b64url(ciphertext)}`;

  assert.equal(await unsealOpenAiToken(ENV, legacySealed), 'sk-lama-rahasia-1234', 'segel lama harus terbaca');

  // Naik-format: token terbaca, lalu kolomnya ditulis ulang ke format sekarang.
  let patched = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.match(String(url), /\/rest\/v1\/openai_accounts\?id=eq\./);
    patched = JSON.parse(String(init.body));
    return new Response(null, { status: 204 });
  };
  try {
    const token = await readOpenAiSealedField(ENV, legacySealed, {
      table: '/openai_accounts',
      id: '11111111-1111-4111-8111-111111111111',
      column: 'sealed_token',
    });
    assert.equal(token, 'sk-lama-rahasia-1234');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(patched?.sealed_token, 'segel harus ditulis ulang');
  assert.notEqual(patched.sealed_token, legacySealed);
  // Segel hasil naik-format tetap terbaca sebagai token yang sama.
  assert.equal(await unsealOpenAiToken(ENV, patched.sealed_token), 'sk-lama-rahasia-1234');

  // Segel yang tidak bisa dibuka tidak boleh menyentuh database.
  let touched = false;
  globalThis.fetch = async () => { touched = true; return new Response(null, { status: 204 }); };
  try {
    assert.equal(await readOpenAiSealedField(ENV, 'rusak.bukan-segel', {
      table: '/openai_accounts', id: '11111111-1111-4111-8111-111111111111', column: 'sealed_token',
    }), '');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(touched, false, 'segel rusak tidak boleh memicu penulisan');
});

test('tanggal kuota memakai WIB, bukan UTC', () => {
  // 2026-11-23T18:30Z = 2026-11-24 01:30 WIB → kuota sudah berganti hari.
  assert.equal(jakartaDate(new Date('2026-11-23T18:30:00Z')), '2026-11-24');
  assert.equal(jakartaDate(new Date('2026-11-23T16:59:00Z')), '2026-11-23');
});

test('sanitizeOpenAiAccount tidak pernah membocorkan kredensial dan menandai kuota habis', () => {
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
  const row = sanitizeOpenAiAccount(base);
  assert.equal(row.state, 'kuota-habis');
  assert.equal(row.remaining, 0);
  assert.equal(row.usable, false);
  assert.equal(JSON.stringify(row).includes('tersegel'), false);
  assert.equal(JSON.stringify(row).includes('sealed_token'), false);

  const reset = sanitizeOpenAiAccount({ ...base, quota_date: '2020-01-01' });
  assert.equal(reset.used_today, 0);
  assert.equal(reset.state, 'siap');

  const cooling = sanitizeOpenAiAccount({
    ...base,
    used_today: 0,
    cooldown_until: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(cooling.state, 'cooldown');
  assert.equal(cooling.usable, false);

  // Token sesi OpenAI bisa disimpan, tetapi tidak pernah dianggap bisa dipanggil.
  const session = sanitizeOpenAiAccount({ ...base, used_today: 0, credential_kind: 'session' });
  assert.equal(session.state, 'tidak-bisa-dipanggil');
  assert.equal(session.usable, false);
});

test('validasi input menolak base URL tidak aman dan kapabilitas asing', () => {
  assert.throws(() => validateOpenAiAccountInput({ api_base: 'http://api.openai.com' }), /HTTPS/);
  assert.throws(() => validateOpenAiAccountInput({ api_base: 'https://user:pass@api.openai.com' }), /HTTPS/);
  assert.deepEqual(validateOpenAiAccountInput({ api_base: 'https://api.openai.com/v1' }).api_base, 'https://api.openai.com');
  assert.deepEqual(validateOpenAiAccountInput({ capabilities: ['chat', 'image'] }).capabilities, ['chat', 'image']);
  // Kapabilitas di luar daftar dibuang, bukan diteruskan diam-diam.
  assert.deepEqual(validateOpenAiAccountInput({ capabilities: ['chat', 'video-ajaib'] }).capabilities, ['chat']);
});

test('setiap tool Studio mendeklarasikan kapabilitasnya sendiri', () => {
  for (const tool of STUDIO_TOOLS) {
    assert.ok(Array.isArray(tool.capabilities), `${tool.id}: capabilities wajib ada`);
    for (const capability of tool.capabilities) {
      assert.ok(OPENAI_CAPABILITIES.includes(capability) || ['search', 'library'].includes(capability), `${tool.id}: kapabilitas ${capability} tidak dikenal`);
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
  // Jalur agen: ruang yang mendeklarasikan `agent` boleh memakai /api/agent,
  // walau rute API itu memetakan ke kapabilitas `agent` (dulu ditolak).
  assert.equal(toolCapabilityViolation('research', '/api/search'), null);
  assert.equal(toolCapabilityViolation('research', '/api/agent'), null);
  assert.equal(toolCapabilityViolation('chat', '/api/agent').code, 'tool_capability_mismatch');
  assert.equal(toolCapabilityViolation('connect-ai', '/api/chat').code, 'tool_capability_mismatch');
  assert.deepEqual(agentToolsForStudioTool('research'), ['web_search', 'read_url', 'load_skill']);
  assert.equal(agentToolsForStudioTool('research').includes('propose_clips'), false);
  assert.equal(agentToolsForStudioTool('image'), null);
});

test('matriks kemampuan OpenAI ↔ tool Studio konsisten dengan katalog tool', () => {
  assert.ok(OPENAI_CAPABILITY_MATRIX.length >= 12, 'semua baris tab Kemampuan API harus terwakili');
  const toolIds = new Set(STUDIO_TOOLS.map((tool) => tool.id));
  for (const row of OPENAI_CAPABILITY_MATRIX) {
    if (!row.capability) {
      // Baris yang belum dipakai tidak boleh menunjuk tool.
      assert.equal(row.tool, '', `${row.key}: baris belum dipakai tidak boleh punya tool`);
      continue;
    }
    assert.ok(OPENAI_CAPABILITIES.includes(row.capability), `${row.key}: kapabilitas pool tidak dikenal`);
    assert.ok(toolIds.has(row.tool), `${row.key}: tool "${row.tool}" tidak ada di katalog`);
    assert.ok(['dipakai', 'belum-dipakai'].includes(row.status), `${row.key}: status tidak dikenal`);
    assert.ok(row.api, `${row.key}: rute API harus disebut`);
  }
  // Kemampuan yang benar-benar dipanggil BLEA harus ditandai "dipakai".
  const byKey = Object.fromEntries(OPENAI_CAPABILITY_MATRIX.map((row) => [row.key, row]));
  assert.equal(byKey.responses.status, 'dipakai');
  assert.equal(byKey.images.status, 'dipakai');
  assert.equal(byKey['web-search'].status, 'dipakai');
  // Yang belum punya rute ditulis apa adanya, bukan disembunyikan.
  assert.equal(byKey.embeddings.status, 'belum-dipakai');
  assert.equal(byKey.moderations ? byKey.moderations.status : byKey.moderation.status, 'belum-dipakai');
  assert.ok(unpipedCapabilities().length >= 5);
  assert.ok(wiredCapabilities().every((row) => row.capability));
  assert.deepEqual(capabilitiesForTool('image').map((row) => row.capability), ['image']);
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
    if (url.startsWith('https://supabase.example/rest/v1/openai_accounts')) return Response.json([]);
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

test('rute pool akun OpenAI hanya untuk admin dan tidak mengirim kredensial', async () => {
  const realFetch = globalThis.fetch;
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    account_email: 'admin@example.com',
    account_label: 'Utama',
    credential_kind: 'api_key',
    sealed_token: await sealOpenAiToken(ENV, 'sk-rahasia-panjang-1234'),
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
    if (url.startsWith('https://supabase.example/rest/v1/openai_accounts')) {
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
    const denied = await worker.fetch(request('/api/openai-accounts', { method: 'GET', token: 'user-jwt' }), ENV);
    assert.equal(denied.status, 403);

    const list = await worker.fetch(request('/api/openai-accounts', { method: 'GET', token: 'admin-jwt' }), ENV);
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0].state, 'siap');
    assert.equal(JSON.stringify(body).includes('sk-rahasia'), false);
    assert.deepEqual(body.capabilities, OPENAI_CAPABILITIES);

    const created = await worker.fetch(request('/api/openai-accounts', {
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
test('halaman Hasil & Unduhan serta Akun OpenAI bisa dirender tanpa navigasi sendiri', async () => {
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
    const { OpenAiAccountsPage } = await vite.ssrLoadModule('/src/studio/OpenAiAccountsPage.jsx');

    const libraryHtml = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(AuthProvider, { initialSession: null }, React.createElement(LibraryPage))),
    );
    assert.ok(libraryHtml.includes('Satu halaman untuk semua hasil.'));
    assert.ok(libraryHtml.includes('Kenapa tool dipisah?'));
    assert.ok(libraryHtml.includes('Unduh'));

    const accountsHtml = renderToStaticMarkup(
      React.createElement(MemoryRouter, null,
        React.createElement(AuthProvider, { initialSession: null }, React.createElement(OpenAiAccountsPage))),
    );
    // Sejak jalur OAuth resmi ("Continue with OpenAI") ditambahkan, halaman ini
    // menonjolkan koneksi tanpa API key, bukan lagi "ditambahkan manual".
    assert.ok(accountsHtml.includes('Akun OpenAI tersambung seperti freebeat.'));
    assert.ok(accountsHtml.includes('Connect OpenAI'));
    assert.ok(accountsHtml.includes('Tambah akun manual'));
    assert.ok(accountsHtml.includes('Bagaimana pemilihan akun bekerja'));
    // Batas harian harus bisa diubah SETELAH akun tersimpan, bukan hanya saat
    // menambah akun. Tombolnya dirender per akun, jadi SSR tanpa akun belum
    // membuktikannya — yang diuji di sini adalah sumber komponennya.
    const fs = await import('node:fs');
    const accountsSource = fs.readFileSync(new URL('../src/studio/OpenAiAccountsPage.jsx', import.meta.url), 'utf8');
    assert.ok(accountsSource.includes('beginEdit'), 'harus ada edit per akun');
    assert.ok(accountsSource.includes('daily_limit: limit'), 'edit batas harian harus dikirim ke server');
    assert.ok(accountsSource.includes('cga-inline-edit'), 'form edit harus punya penanda kelas');
    assert.match(accountsSource, /Ubah batas/, 'tombol edit harus terlihat di kartu akun');
  } finally {
    await vite.close();
  }
});

test('batas harian akun bisa diubah lewat PATCH tanpa mengirim ulang kunci', async () => {
  const realFetch = globalThis.fetch;
  const account = {
    id: '11111111-1111-4111-8111-111111111111',
    account_email: 'akun@example.com',
    credential_kind: 'api_key',
    enabled: true,
    priority: 10,
    capabilities: ['chat'],
    daily_limit: 200,
    used_today: 12,
    quota_date: jakartaDate(),
    cooldown_until: null,
    consecutive_failures: 0,
    api_base: 'https://api.openai.com',
    sealed_token: await sealOpenAiToken(ENV, 'sk-uji-batas'),
    model_default: 'gpt-4o-mini',
  };
  let patched = null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/auth/v1/user')) {
      return Response.json({ id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' } });
    }
    if (url.includes('/openai_accounts')) {
      if ((init.method || 'GET') === 'PATCH') {
        patched = JSON.parse(init.body);
        return Response.json([{ ...account, ...patched }]);
      }
      return Response.json([account]);
    }
    if (url.includes('/rest/v1/')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(
      new Request('https://app.example/api/openai-accounts', {
        method: 'PATCH',
        headers: { origin: 'https://app.example', authorization: 'Bearer admin-jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ id: account.id, daily_limit: 40 }),
      }),
      ENV,
    );
    assert.equal(res.status, 200);
    assert.equal(patched.daily_limit, 40);
    assert.equal('sealed_token' in patched, false, 'mengubah batas tidak boleh menyentuh kredensial');
    assert.equal('token' in patched, false);
    const body = await res.json();
    assert.equal(body.account.daily_limit, 40);
    assert.equal(body.account.used_today, 12, 'pemakaian hari ini tidak boleh ikut ter-reset');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Regresi: halaman Koneksi pernah menulis "Tersambung" untuk OpenAI padahal
// tidak ada satu pun akun OAuth di server — klaim tanpa bukti. Sekarang label
// itu hanya muncul bila server melaporkan tautan berstatus linked.
test('halaman Koneksi tidak mengklaim OpenAI tersambung tanpa bukti', async () => {
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
    assert.ok(!/OpenAI[\s\S]{0,400}Tersambung/.test(html), 'tidak boleh ada klaim Tersambung untuk OpenAI sebelum diukur');
    assert.ok(html.includes('Status dari server, bukan label di halaman ini.'));
    assert.ok(html.includes('Belum diperiksa'));
  } finally {
    await vite.close();
  }
});

// Regresi yang sama seperti di atas, tetapi dari sudut pandang pesan error:
// akun yang tersegel dengan format lama TIDAK boleh dilaporkan sebagai
// "belum dikonfigurasi". Diagnosa menghitung penghalang yang sebenarnya.
test('diagnosa pool membedakan segel lama, cooldown, dan kuota habis', async () => {
  const enc = new TextEncoder();
  const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
  const legacyInfo = atob('YmxlYS1jaGF0Z3B0LXBvb2wtdjE=');
  const legacyAad = atob('Y2hhdGdwdC1jcmVkZW50aWFs');
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${legacyInfo}:${ENV.PROVIDER_CREDENTIAL_ENCRYPTION_KEY}`));
  const legacyKey = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(legacyAad) },
    legacyKey,
    enc.encode('sk-lama-rahasia-1234'),
  );
  const legacySealed = `${b64url(iv)}.${b64url(ciphertext)}`;
  const today = jakartaDate();
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    credential_kind: 'api_key',
    enabled: true,
    priority: 10,
    daily_limit: 200,
    used_today: 0,
    quota_date: today,
    capabilities: ['chat', 'agent'],
    cooldown_until: null,
  };
  const rows = [
    // Sehat, tapi tersegel dengan kunci format lama.
    { ...base, sealed_token: legacySealed },
    // Sehat, format segel sekarang, kapabilitas hanya chat.
    { ...base, id: '22222222-2222-4222-8222-222222222222', sealed_token: await sealOpenAiToken(ENV, 'sk-baru'), capabilities: ['chat'] },
    // Cooldown.
    { ...base, id: '33333333-3333-4333-8333-333333333333', sealed_token: await sealOpenAiToken(ENV, 'sk-c'), capabilities: ['chat'], cooldown_until: new Date(Date.now() + 300_000).toISOString() },
    // Kuota habis.
    { ...base, id: '44444444-4444-4444-8444-444444444444', sealed_token: await sealOpenAiToken(ENV, 'sk-d'), capabilities: ['chat'], used_today: 200 },
    // Segel ada tetapi kuncinya lain (secret Worker berganti).
    { ...base, id: '55555555-5555-4555-8555-555555555555', sealed_token: await sealOpenAiToken({ ...ENV, PROVIDER_CREDENTIAL_ENCRYPTION_KEY: 'kunci-lama-yang-berbeda-0123456789abcdef0123456789abcdef0123456789abcdef' }, 'sk-e'), capabilities: ['chat'] },
    // Nonaktif.
    { ...base, id: '66666666-6666-4666-8666-666666666666', sealed_token: await sealOpenAiToken(ENV, 'sk-f'), capabilities: ['chat'], enabled: false },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/rest\/v1\/openai_accounts\?select=\*/);
    return Response.json(rows);
  };
  try {
    const chat = await openAiPoolDiagnostic(ENV, 'chat');
    assert.equal(chat.readable, true);
    assert.equal(chat.total, 6);
    assert.equal(chat.match_capability, 6);
    assert.equal(chat.enabled, 5);
    assert.equal(chat.cooling, 1);
    assert.equal(chat.quota_exhausted, 1);
    // Dua segel tak terbuka: satu di atas kunci format lama? tidak — itu
    // justru harus TERBACA. Yang gagal hanya baris ber-kunci-berbeda.
    assert.equal(chat.sealed_missing, 1);
    assert.equal(chat.usable, 2, 'akun bersegel lama dan bersegel baru sama-sama siap');

    const agent = await openAiPoolDiagnostic(ENV, 'agent');
    assert.equal(agent.match_capability, 1);
    assert.equal(agent.usable, 1);

    const none = await openAiPoolDiagnostic(ENV, 'music');
    assert.equal(none.match_capability, 0);
    assert.equal(none.usable, 0);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Bila tabelnya tidak terbaca, diagnosa melaporkan `readable: false` alih-alih
  // mengarang angka; pemanggil lalu memakai pesan generik.
  globalThis.fetch = async () => new Response('boom', { status: 500 });
  try {
    const broken = await openAiPoolDiagnostic(ENV, 'chat');
    assert.equal(broken.readable, false);
    assert.equal(broken.total, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function agentDeps(overrides = {}) {
  return {
    getUser: async () => ({ id: 'user-1', email: 'creator@example.com' }),
    servicePostgrest: async () => Response.json([{ provider: 'unorouter', api_key: '', base_url: null }]),
    normalizeAgentAttachments: () => [],
    normalizeVideoAnalysis: () => ({}),
    normalizeVideoTranscript: () => ({ text: '', segmentCount: 0 }),
    hasWorkersAiBinding: () => false,
    ...overrides,
  };
}

function agentRequest(headers = {}) {
  return new Request(`${BASE}/api/agent`, {
    method: 'POST',
    headers: { origin: BASE, authorization: 'Bearer user-jwt', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'halo' }] }),
  });
}

test('ruang agen: pool kosong → 400 openai_pool_empty, akun tidak terpakai → 503 dengan sebab', async () => {
  const empty = await handleAgentTurn(agentRequest(), new URL(`${BASE}/api/agent`), ENV, agentDeps({
    pickPoolAccounts: async () => [],
    poolBlockedMessage: async () => null,
  }));
  assert.equal(empty.status, 400);
  const emptyBody = await empty.json();
  assert.equal(emptyBody.code, 'openai_pool_empty');
  assert.match(emptyBody.error, /Akun OpenAI/);

  // Akun ADA tetapi tidak bisa dipakai: 503 dan sebabnya disebut satu per satu,
  // bukan pesan "belum dikonfigurasi".
  const notUsable = await handleAgentTurn(agentRequest({ 'x-blea-studio-tool': 'agent' }), new URL(`${BASE}/api/agent`), ENV, agentDeps({
    studioToolUsesAgentTools: (id) => id === 'agent',
    pickPoolAccounts: async () => [],
    poolBlockedMessage: async () => ({ status: 503, code: 'openai_pool_not_usable', error: 'Akun OpenAI ada 3 di pool, 0 siap dipakai: 1 akun sedang cooldown.', pool: { total: 3 } }),
  }));
  assert.equal(notUsable.status, 503);
  const body = await notUsable.json();
  assert.equal(body.code, 'openai_pool_not_usable');
  assert.match(body.error, /cooldown/);
  assert.doesNotMatch(body.error, /belum dikonfigurasi/);

  // Kapabilitas yang diminta mengikuti ruang: ruang teks minta `chat`, ruang
  // ber-alat-agen minta `agent`.
  const seen = [];
  await handleAgentTurn(agentRequest(), new URL(`${BASE}/api/agent`), ENV, agentDeps({
    pickPoolAccounts: async (capability) => { seen.push(capability); return []; },
    poolBlockedMessage: async () => null,
  }));
  await handleAgentTurn(agentRequest({ 'x-blea-studio-tool': 'research' }), new URL(`${BASE}/api/agent`), ENV, agentDeps({
    studioToolUsesAgentTools: (id) => id === 'research',
    pickPoolAccounts: async (capability) => { seen.push(capability); return []; },
    poolBlockedMessage: async () => null,
  }));
  assert.deepEqual(seen, ['chat', 'agent']);

  // Provider selain openai tetap memakai pesan lama.
  const other = await handleAgentTurn(
    new Request(`${BASE}/api/agent`, {
      method: 'POST',
      headers: { origin: BASE, authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'deepseek', model: 'deepseek-chat', messages: [{ role: 'user', content: 'halo' }] }),
    }),
    new URL(`${BASE}/api/agent`),
    ENV,
    agentDeps({ pickPoolAccounts: async () => [] }),
  );
  assert.equal(other.status, 400);
  assert.match((await other.json()).error, /belum dikonfigurasi/);
});

test('pesan penolakan pool menyebut penghalang nyata dan null bila pool kosong', async () => {
  const today = jakartaDate();
  const rows = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      credential_kind: 'api_key',
      enabled: true,
      priority: 10,
      daily_limit: 200,
      used_today: 200,
      quota_date: today,
      capabilities: ['chat'],
      sealed_token: await sealOpenAiToken(ENV, 'sk-a'),
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      credential_kind: 'api_key',
      enabled: true,
      priority: 10,
      daily_limit: 200,
      used_today: 0,
      quota_date: today,
      capabilities: ['agent'],
      cooldown_until: new Date(Date.now() + 300_000).toISOString(),
      sealed_token: await sealOpenAiToken(ENV, 'sk-b'),
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      credential_kind: 'session',
      enabled: true,
      priority: 10,
      daily_limit: 0,
      capabilities: ['video'],
      sealed_token: await sealOpenAiToken(ENV, 'sk-c'),
    },
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json(rows);
  try {
    const chat = await openAiPoolBlockedMessage(ENV, 'chat');
    assert.equal(chat.status, 503);
    assert.equal(chat.code, 'openai_pool_not_usable');
    assert.match(chat.error, /kuota harian/);
    assert.equal(chat.error.includes('belum dikonfigurasi'), false);

    const agent = await openAiPoolBlockedMessage(ENV, 'agent');
    assert.match(agent.error, /cooldown/);

    const video = await openAiPoolBlockedMessage(ENV, 'video');
    assert.match(video.error, /jenis kredensial/);
  } finally {
    globalThis.fetch = realFetch;
  }

  // Pool benar-benar kosong → null, supaya pemanggil memakai pesan
  // "belum ada akun" (400) yang lebih tepat daripada 503.
  globalThis.fetch = async () => Response.json([]);
  try {
    assert.equal(await openAiPoolBlockedMessage(ENV, 'chat'), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- 429 OpenAI: batas laju vs billing vs kunci ditolak --------------------

test('429 murni (batas laju) dipisahkan dari kuota/billing habis', () => {
  // Bentuk galat nyata dari OpenAI: yang di atas rate limit sementara, yang di
  // bawah billing habis. Keduanya HTTP 429, obatnya berbeda.
  assert.equal(classifyOpenAiFailure(429, 'Rate limit reached for gpt-4o-mini on requests per min (RPM)'), 'rate_limit');
  assert.equal(classifyOpenAiFailure(429, 'rate_limit_exceeded'), 'rate_limit');
  assert.equal(
    classifyOpenAiFailure(429, 'You exceeded your current quota, please check your plan and billing details. code: insufficient_quota'),
    'billing',
  );
  assert.equal(classifyOpenAiFailure(402, 'payment required'), 'billing');
  assert.equal(classifyOpenAiFailure(401, 'Incorrect API key provided'), 'auth');
  assert.equal(classifyOpenAiFailure(500, 'internal error'), 'other');

  const rate = openAiFailureMessage([{ status: 429, detail: 'rate_limit_exceeded' }], { model: 'gpt-4o-mini' });
  assert.equal(rate.status, 429);
  assert.equal(rate.code, 'openai_rate_limited');
  assert.match(rate.error, /batas laju/);
  // Jangan pernah menyalahkan kuota/billing untuk batas laju, dan jangan
  // menyarankan "pilih model lain" — semua model OpenAI satu pool akun.
  assert.doesNotMatch(rate.error, /tambah saldo|isi saldo|kuota harian yang habis|pilih model lain/i);

  const billing = openAiFailureMessage([{ status: 429, detail: 'insufficient_quota' }]);
  assert.equal(billing.status, 402);
  assert.equal(billing.code, 'openai_pool_billing');
  assert.match(billing.error, /Billing/);

  const auth = openAiFailureMessage([{ status: 401, detail: 'Incorrect API key provided' }]);
  assert.equal(auth.code, 'openai_pool_unauthorized');
  assert.match(auth.error, /ditolak/);
});

test('batas laju tidak mengunci akun pool selama cooldown panjang', async () => {
  // Cooldown untuk 429 harus pendek (1 menit), bukan 10–60 menit seperti
  // kegagalan auth. Kalau salah, satu permintaan cepat mematikan pool.
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (init.method === 'PATCH') {
      captured.push({ url: target, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    return Response.json([{
      id: '11111111-1111-4111-8111-111111111111',
      used_today: 5,
      quota_date: jakartaDate(),
      daily_limit: 200,
      consecutive_failures: 0,
    }]);
  };
  try {
    await recordOpenAiUsage(ENV, '11111111-1111-4111-8111-111111111111', {
      ok: false,
      status: 429,
      error: 'Rate limit reached for requests per min',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(captured.length, 1);
  const until = Date.parse(captured[0].body.cooldown_until);
  const minutes = (until - Date.now()) / 60_000;
  assert.ok(minutes > 0 && minutes <= 2, `cooldown 429 harus ±1 menit, dapat ${minutes.toFixed(1)}`);
  assert.match(captured[0].body.last_error, /Rate limit/);
});

test('/api/chat OpenAI: 429 dilaporkan sebagai batas laju akun, bukan "pilih model lain"', async () => {
  const realFetch = globalThis.fetch;
  const account = {
    id: '11111111-1111-4111-8111-111111111111',
    account_label: 'Akun uji',
    credential_kind: 'api_key',
    enabled: true,
    priority: 1,
    capabilities: ['chat', 'agent'],
    daily_limit: 200,
    used_today: 0,
    quota_date: jakartaDate(),
    cooldown_until: null,
    consecutive_failures: 0,
    api_base: 'https://api.openai.com',
    sealed_token: await sealOpenAiToken(ENV, 'sk-uji-ratelimit'),
    model_default: 'gpt-4o-mini',
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', email: 'creator@example.com' });
    if (url.startsWith('https://supabase.example/rest/v1/openai_accounts')) return Response.json([account]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) return Response.json([]);
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) return Response.json([]);
    if (url.includes('/v1/chat/completions')) {
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached for gpt-4o-mini on requests per min (RPM)', code: 'rate_limit_exceeded' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    }
    if ((init.method || 'GET') === 'PATCH' || (init.method || 'GET') === 'POST') return new Response(null, { status: 204 });
    return Response.json([]);
  };
  try {
    const res = await worker.fetch(
      new Request('https://app.example/api/chat', {
        method: 'POST',
        headers: { origin: 'https://app.example', authorization: 'Bearer user-jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hai' }], stream: true }),
      }),
      ENV,
    );
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, 'openai_rate_limited');
    assert.match(body.error, /batas laju/);
    assert.doesNotMatch(body.error, /pilih model lain|Batas permintaan paket gratis|tambah saldo/i);
    assert.ok(Array.isArray(body.poolFailures) && body.poolFailures.length === 1);
    assert.equal(body.poolFailures[0].kind, 'rate_limit');
    assert.equal(body.retryAfterSec, 60);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- Katalog Admin harus bisa melihat provider openai ---------------------

test('/api/admin-models mendaftarkan provider openai dari pool akun', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' } });
    if (url.includes('/rest/v1/openai_accounts')) return Response.json([{ id: 'acc-1', enabled: true }]);
    if (url.includes('/rest/v1/')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(
      new Request('https://app.example/api/admin-models', { headers: { origin: 'https://app.example', authorization: 'Bearer admin-jwt' } }),
      ENV,
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const openai = body.providers.find((item) => item.provider === 'openai');
    assert.ok(openai, 'provider openai tidak boleh hilang dari katalog hanya karena kuncinya ada di pool');
    assert.ok(openai.sources.includes('pool'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/catalog openai memakai kunci dari pool akun, bukan baris kosong', async () => {
  const realFetch = globalThis.fetch;
  const account = {
    id: '11111111-1111-4111-8111-111111111111',
    account_label: 'Akun katalog',
    credential_kind: 'api_key',
    enabled: true,
    priority: 1,
    capabilities: ['chat'],
    daily_limit: 200,
    used_today: 0,
    quota_date: jakartaDate(),
    cooldown_until: null,
    consecutive_failures: 0,
    api_base: 'https://api.openai.com',
    sealed_token: await sealOpenAiToken(ENV, 'sk-uji-katalog'),
    model_default: 'gpt-4o-mini',
  };
  let authHeader = '';
  let modelsUrl = '';
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: 'user-1', email: 'creator@example.com', app_metadata: { role: 'admin' } });
    if (url.includes('/rest/v1/openai_accounts')) return Response.json([account]);
    if (url.includes('/rest/v1/provider_api_keys')) return Response.json([]);
    if (url.includes('/rest/v1/provider_key_pool')) return Response.json([]);
    if (url.endsWith('/v1/models')) {
      modelsUrl = url;
      // Supabase service-role key TIDAK boleh ikut ke upstream; yang dikirim
      // harus token pool akun yang tersegel itu.
      authHeader = (init.headers || {}).authorization || '';
      return Response.json({ data: [{ id: 'gpt-4o-mini', owned_by: 'openai' }, { id: 'sora-2' }] });
    }
    if (url.includes('/rest/v1/')) return Response.json([]);
    throw new Error(`Unexpected fetch: ${url}`);
  };
  try {
    const res = await worker.fetch(
      new Request('https://app.example/api/catalog', {
        method: 'POST',
        headers: { origin: 'https://app.example', authorization: 'Bearer admin-jwt', 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      }),
      ENV,
    );
    assert.equal(res.status, 200);
    assert.equal(modelsUrl, 'https://api.openai.com/v1/models');
    assert.equal(authHeader, 'Bearer sk-uji-katalog', 'kunci pool harus dipakai untuk memuat katalog');
    const body = await res.json();
    const ids = body.models.map((model) => model.id);
    assert.ok(ids.includes('gpt-4o-mini'));
    assert.ok(ids.includes('sora-2'));
  } finally {
    globalThis.fetch = realFetch;
  }
});
