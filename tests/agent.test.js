import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { SKILLS, findSkill } from '../src/agent/skills/manifest.js';
import { availableSkills, loadSkillSection, matchSkills, readVerifiedSkillFile } from '../src/agent/skills/loadSkill.js';
import { buildAgentSystemPrompt } from '../src/agent/prompts.js';
import {
  findAgentTool,
  htmlToText,
  isHttpUrl,
  isPrivateHost,
  parseAgentToolCall,
  runLoadSkill,
  runReadUrl,
  runWebSearch,
  stripAgentToolCalls,
} from '../src/agent/tools.js';
import { resolveAgentModel } from '../src/agent/modelRouting.js';

function createEnv() {
  return {
    SUPABASE_URL: 'https://supabase.example',
    SUPABASE_ANON_KEY: 'anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-for-tests',
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
  };
}

function apiRequest(path, { method = 'POST', body, token = 'user-jwt', origin = 'https://app.example' } = {}) {
  return new Request(`https://app.example${path}`, {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function readSse(response) {
  const text = await response.text();
  return text.split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5).trim()));
}

// A fetch stub that routes Supabase auth/rest + one chat provider. `chatReplies`
// is consumed in order, so a test can script the model → tool → final answer
// sequence.
function stubUpstream({
  chatReplies = [],
  models = [{ provider: 'unorouter', model: 'gpt-oss-120b:free' }],
  chatStatus = 200,
  turnPrice = 0,
  spendOk = true,
} = {}) {
  const state = { chatBodies: [], fetchCalls: [], remaining: [...chatReplies], rpcCalls: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    state.fetchCalls.push(url);
    if (url === 'https://supabase.example/auth/v1/user') return Response.json({ id: 'user-1', email: 'creator@example.com' });
    if (url.startsWith('https://supabase.example/rest/v1/provider_api_keys')) {
      return Response.json([{ provider: 'unorouter', api_key: 'uno-test-key', base_url: null }]);
    }
    if (url.startsWith('https://supabase.example/rest/v1/provider_models')) {
      return Response.json(models);
    }
    if (url.startsWith('https://supabase.example/rest/v1/credit_model_prices')) {
      return Response.json(turnPrice > 0 ? [{ credits: turnPrice }] : []);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/spend_credits')) {
      state.rpcCalls.push({ fn: 'spend_credits', body: JSON.parse(init.body) });
      return Response.json(spendOk);
    }
    if (url.startsWith('https://supabase.example/rest/v1/rpc/refund_credits')) {
      state.rpcCalls.push({ fn: 'refund_credits', body: JSON.parse(init.body) });
      return Response.json(true);
    }
    if (url.includes('/chat/completions')) {
      const payload = JSON.parse(init.body);
      state.chatBodies.push(payload);
      if (chatStatus !== 200) return new Response(JSON.stringify({ error: { message: 'nope', code: 'boom' } }), { status: chatStatus });
      const content = state.remaining.shift() ?? 'Jawaban final.';
      return Response.json({ choices: [{ message: { content } }] });
    }
    if (url.startsWith('https://html.duckduckgo.com/')) {
      return new Response('<a rel="nofollow" class="result__a" href="https://example.com/a">Contoh A</a><a class="result__snippet" href="https://example.com/a">Ringkasan A</a>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.startsWith('https://api.duckduckgo.com/') || url.includes('wikipedia.org') || url.includes('stackexchange') || url.includes('api.github.com/search') || url.includes('hn.algolia.com')) {
      return Response.json({});
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  return { state, restore: () => { globalThis.fetch = realFetch; } };
}

test('skill registry: every vendored file matches its manifest checksum', async () => {
  const catalog = availableSkills();
  assert.deepEqual(catalog.map((skill) => skill.id).sort(), ['frontend-design', 'internal-comms', 'web-artifacts-builder']);
  for (const skill of SKILLS) {
    for (const file of skill.files) {
      assert.ok(file.sha256, `${skill.id}/${file.path} harus punya checksum di manifest`);
      const text = await readVerifiedSkillFile(skill.id, file.path, file.sha256);
      assert.ok(text.length > 0);
    }
  }
  // Apache-2.0 licence text must stay in the bundle for redistribution.
  const licence = await readVerifiedSkillFile('frontend-design', 'LICENSE.txt', findSkill('frontend-design').files[1].sha256);
  assert.match(licence, /Apache License/);
});

test('skill registry rejects a tampered checksum instead of silently loading', async () => {
  await assert.rejects(
    readVerifiedSkillFile('frontend-design', 'SKILL.md', 'deadbeef'.repeat(8)),
    /Checksum skill tidak cocok/,
  );
  await assert.rejects(readVerifiedSkillFile('frontend-design', 'missing.md', 'a'.repeat(64)), /tidak ditemukan/);
  await assert.rejects(loadSkillSection('tidak-ada'), /tidak dikenal/);
});

test('loadSkillSection carries provenance and the BLEA environment overlay', async () => {
  const section = await loadSkillSection('web-artifacts-builder');
  assert.match(section, /anthropics\/skills/);
  assert.match(section, /Apache-2\.0/);
  assert.match(section, /bukan fitur produk Anthropic/);
  assert.match(section, /Batasan lingkungan BLEA/);
  assert.match(section, /tidak ada shell/, 'harus menyatakan tidak ada shell/bundler');

  const withExample = await loadSkillSection('internal-comms', { resourceId: '3p' });
  assert.match(withExample, /Contoh format: 3p/);
  await assert.rejects(loadSkillSection('internal-comms', { resourceId: 'nope' }), /tidak ada untuk skill/);
});

test('matchSkills only suggests, and never returns more than the limit', () => {
  const hits = matchSkills('tolong buat desain landing page dengan tipografi berkarakter', { limit: 1 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'frontend-design');
  assert.deepEqual(matchSkills(''), []);
});

test('agent system prompt lists tools, skills, and hard limits', () => {
  const prompt = buildAgentSystemPrompt({ skillIds: ['frontend-design', 'internal-comms'], workspace: { blueprint: '1. Riset\n2. Tulis' } });
  assert.match(prompt, /web_search/);
  assert.match(prompt, /read_url/);
  assert.match(prompt, /load_skill/);
  assert.match(prompt, /frontend-design/);
  assert.match(prompt, /Rencana kerja yang sudah disetujui/);
  assert.match(prompt, /tidak bisa menjalankan kode/);
  // Tool syntax must be documented exactly once, in a `tool` fence.
  assert.equal((prompt.match(/```tool/g) || []).length, 1);
});

test('URL safety helpers block private networks and non-http schemes', () => {
  assert.equal(isHttpUrl('https://example.com/a'), true);
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.1.2.3'), true);
  assert.equal(isPrivateHost('192.168.0.1'), true);
  assert.equal(isPrivateHost('example.com'), false);
});

test('runReadUrl refuses private hosts and turns HTML into readable text', async () => {
  let called = false;
  const blocked = await runReadUrl({ url: 'http://localhost:8080/admin' }, { fetchImpl: async () => { called = true; return new Response('x'); } });
  assert.match(blocked, /jaringan privat/);
  assert.equal(called, false, 'fetch tidak boleh dipanggil untuk host privat');

  const ok = await runReadUrl({ url: 'https://example.com/artikel' }, {
    fetchImpl: async () => new Response('<html><style>.a{}</style><body><h1>Judul</h1><p>Isi &amp; rincian.</p></body></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  });
  assert.match(ok, /Judul/);
  assert.match(ok, /Isi & rincian\./);
  assert.equal(ok.includes('<h1>'), false);
});

test('htmlToText strips scripts, styles and decodes entities', () => {
  const text = htmlToText('<div><script>evil()</script><p>Satu &amp; dua</p><p>tiga&nbsp;empat</p></div>');
  assert.equal(text.includes('evil'), false);
  assert.match(text, /Satu & dua/);
  assert.match(text, /tiga empat/);
});

test('runWebSearch formats sources and reports empty results honestly', async () => {
  const withResults = await runWebSearch({ query: 'harga emas' }, {
    search: async () => [{ title: 'Harga emas hari ini', url: 'https://example.com/emas', snippet: 'Naik 1%' }],
  });
  assert.match(withResults, /1\. Harga emas hari ini/);
  assert.match(withResults, /https:\/\/example\.com\/emas/);

  const empty = await runWebSearch({ query: 'tidak ada' }, { search: async () => [] });
  assert.match(empty, /Tidak ada hasil/);

  const noQuery = await runWebSearch({ query: '   ' }, { search: async () => [] });
  assert.match(noQuery, /^Alat gagal/);
});

test('runLoadSkill rejects unknown skills and loads pinned ones', async () => {
  const unknown = await runLoadSkill({ skill: 'rm-rf' }, { loadSkillSection, availableSkillIds: ['frontend-design'] });
  assert.match(unknown, /tidak tersedia/);

  const loaded = await runLoadSkill({ skill: 'frontend-design' }, { loadSkillSection, availableSkillIds: ['frontend-design'] });
  assert.match(loaded, /Frontend Design/);
});

test('tool-call parsing accepts one fenced block and strips it from prose', () => {
  const call = parseAgentToolCall('Saya cek dulu.\n```tool\n{"name":"web_search","arguments":{"query":"cuaca jakarta"}}\n```');
  assert.equal(call.name, 'web_search');
  assert.equal(call.arguments.query, 'cuaca jakarta');
  assert.equal(stripAgentToolCalls('Saya cek dulu.\n```tool\n{"name":"x"}\n```'), 'Saya cek dulu.');

  assert.equal(parseAgentToolCall('tanpa alat'), null);
  assert.equal(parseAgentToolCall('```tool\n{bukan json}\n```').error, 'JSON tidak valid');
  assert.equal(parseAgentToolCall('```tool\n{"arguments":{}}\n```').error, 'tanpa field `name`');
  assert.ok(findAgentTool('read_url'));
  assert.equal(findAgentTool('shell_exec'), null);
});

test('resolveAgentModel never silently swaps an explicitly requested model', () => {
  const items = [{ id: 'gpt-oss-120b:free', provider: 'unorouter' }, { id: 'claude-sonnet', provider: 'pekpik' }];
  assert.deepEqual(resolveAgentModel(items), { model: 'gpt-oss-120b:free', provider: 'unorouter', resolved: true });
  assert.deepEqual(resolveAgentModel(items, 'claude-sonnet'), { model: 'claude-sonnet', provider: 'pekpik', resolved: true });
  assert.deepEqual(resolveAgentModel(items, 'gone-model'), { model: 'gone-model', provider: '', resolved: false });
  assert.deepEqual(resolveAgentModel([], ''), { model: '', provider: '', resolved: false });
});

test('/api/agent/skills exposes the catalogue without leaking skill bodies', async () => {
  const res = await worker.fetch(apiRequest('/api/agent/skills', { body: {} }), createEnv());
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.source.license, 'Apache-2.0');
  assert.deepEqual(data.skills.map((skill) => skill.id).sort(), ['frontend-design', 'internal-comms', 'web-artifacts-builder']);
  assert.deepEqual(data.tools, ['web_search', 'read_url', 'load_skill']);
  assert.equal(JSON.stringify(data).includes('Frontend Design'), false, 'katalog tidak boleh mengirim isi SKILL.md');
});

test('/api/agent rejects cross-origin requests and missing auth', async () => {
  const stub = stubUpstream({});
  try {
    const badOrigin = await worker.fetch(
      apiRequest('/api/agent', { body: { messages: [{ role: 'user', content: 'halo' }] }, origin: 'https://evil.example' }),
      createEnv(),
    );
    assert.equal(badOrigin.status, 403);

    const noAuth = await worker.fetch(
      apiRequest('/api/agent', { body: { messages: [{ role: 'user', content: 'halo' }] }, token: '' }),
      createEnv(),
    );
    assert.equal(noAuth.status, 401);

    const emptyBody = await worker.fetch(apiRequest('/api/agent', { body: { messages: [] } }), createEnv());
    assert.equal(emptyBody.status, 400);
  } finally {
    stub.restore();
  }
});

test('/api/agent runs a tool round, streams the final answer, and reports the action', async () => {
  const stub = stubUpstream({
    chatReplies: [
      '```tool\n{"name":"web_search","arguments":{"query":"blea ai"}}\n```',
      'BLEA AI adalah aplikasi agen. Sumber: https://example.com/a',
    ],
  });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: {
        messages: [{ role: 'user', content: 'Cari info BLEA AI' }],
        model: 'gpt-oss-120b:free',
        provider: 'unorouter',
      },
    }), createEnv());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const events = await readSse(res);
    const types = events.map((event) => event.type);
    assert.equal(types[0], 'meta');
    assert.ok(types.includes('step'));
    assert.equal(types.at(-1), 'done');

    const toolStep = events.find((event) => event.type === 'step' && event.label === 'Menjalankan web_search' && event.status === 'done');
    assert.ok(toolStep, 'harus ada langkah alat yang selesai');
    assert.match(toolStep.detail, /sumber|tanpa hasil/);

    const done = events.at(-1);
    assert.equal(done.ok, true);
    assert.match(done.reply, /BLEA AI adalah aplikasi agen/);
    assert.deepEqual(done.actions.map((action) => action.tool), ['web_search']);
    assert.equal(done.actions[0].ok, true);

    // Two model calls: the tool request and the final answer. The tool result
    // must be present in the second request's context.
    assert.equal(stub.state.chatBodies.length, 2);
    const secondContext = JSON.stringify(stub.state.chatBodies[1].messages);
    assert.match(secondContext, /Hasil alat web_search/);
    assert.match(secondContext, /example\.com\/a/);
    // The tool syntax is documented in the system prompt of both calls.
    assert.match(stub.state.chatBodies[0].messages[0].content, /BLOG|## ALAT/);
  } finally {
    stub.restore();
  }
});

test('/api/agent loads a pinned skill and emits its activation', async () => {
  const stub = stubUpstream({ chatReplies: ['Baik, saya pakai panduan desain itu.'] });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: {
        messages: [{ role: 'user', content: 'Buat arah desain' }],
        model: 'gpt-oss-120b:free',
        provider: 'unorouter',
        skill: 'frontend-design',
      },
    }), createEnv());
    const events = await readSse(res);
    const skillEvent = events.find((event) => event.type === 'skill');
    assert.ok(skillEvent, 'harus mengirim event skill');
    assert.equal(skillEvent.id, 'frontend-design');
    const prompt = stub.state.chatBodies[0].messages[0].content;
    assert.match(prompt, /PANDUAN YANG SUDAH DIMUAT/);
    assert.match(prompt, /Frontend Design/);
    assert.equal(events.at(-1).skills.includes('frontend-design'), true);
  } finally {
    stub.restore();
  }
});

test('/api/agent answers a no-tool turn in a single model call', async () => {
  const stub = stubUpstream({ chatReplies: ['Jawaban langsung.'] });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'Apa itu REST?' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    const events = await readSse(res);
    const done = events.at(-1);
    assert.equal(done.reply, 'Jawaban langsung.');
    assert.deepEqual(done.actions, []);
    assert.equal(stub.state.chatBodies.length, 1);
  } finally {
    stub.restore();
  }
});

test('/api/agent stops after the tool budget instead of looping forever', async () => {
  const looping = Array.from({ length: 6 }, () => '```tool\n{"name":"read_url","arguments":{"url":"http://127.0.0.1/secret"}}\n```');
  const stub = stubUpstream({ chatReplies: looping });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'ulangi terus' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    const events = await readSse(res);
    const done = events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.stopReason, 'tool_budget');
    assert.equal(stub.state.chatBodies.length, 4, 'maksimum 4 panggilan model (MAX_TOOL_ROUNDS + 1)');
    // The refusal must be visible to the model as a tool result, not swallowed.
    assert.match(JSON.stringify(stub.state.chatBodies[1].messages), /jaringan privat/);
  } finally {
    stub.restore();
  }
});

test('/api/agent surfaces an upstream failure as an error event, not a fake answer', async () => {
  const stub = stubUpstream({ chatStatus: 500 });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'halo' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    const events = await readSse(res);
    const error = events.find((event) => event.type === 'error');
    assert.ok(error, 'harus mengirim event error');
    assert.equal(events.some((event) => event.type === 'done'), false);
  } finally {
    stub.restore();
  }
});

test('AgentPage renders the single-page agent shell and links to its skill provenance', async () => {
  const React = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createServer } = await import('vite');

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
    const { AgentPage } = await vite.ssrLoadModule('/src/agent/AgentPage.jsx');
    const session = {
      access_token: 'test-token',
      user: { id: 'u1', email: 'creator@example.com', user_metadata: { full_name: 'Kreator' }, app_metadata: {} },
    };
    const html = renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/agent'] },
        React.createElement(AuthProvider, { initialSession: session }, React.createElement(AgentPage)),
      ),
    );

    assert.match(html, /Apa yang mau dikerjakan\?/);
    assert.match(html, /Tulis tugasnya/);
    assert.match(html, /anthropics\/skills/);
    assert.match(html, /Apache-2\.0/);
    assert.match(html, /Tidak ada eksekusi kode/);
    assert.match(html, /Batas alat|Bersihkan/);

    const source = (await import('node:fs')).readFileSync(new URL('../src/agent/AgentPage.jsx', import.meta.url), 'utf8');
    assert.ok(source.includes('runAgentTurn'), 'halaman harus memakai klien /api/agent');
    assert.equal(/fetch\(['"]\/api\/chat/.test(source), false, 'halaman agen tidak boleh memakai jalur chat lama');
    const css = (await import('node:fs')).readFileSync(new URL('../src/agent/agent.css', import.meta.url), 'utf8');
    assert.ok(css.includes('.agent-feed'));
    assert.ok(css.includes('prefers-reduced-motion'));
  } finally {
    await vite.close();
  }
});

test('priced agent turn is charged up front and reported on done', async () => {
  const stub = stubUpstream({ chatReplies: ['Jawaban berbayar.'], turnPrice: 5 });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'halo' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    const events = await readSse(res);
    assert.equal(stub.state.rpcCalls.length, 1);
    assert.equal(stub.state.rpcCalls[0].fn, 'spend_credits');
    assert.equal(stub.state.rpcCalls[0].body.p_amount, 5);
    assert.equal(stub.state.rpcCalls[0].body.p_user_id, 'user-1');
    assert.equal(events.find((event) => event.type === 'meta').credits, 5);
    assert.equal(events.at(-1).credits, 5);
    assert.equal(events.some((event) => event.type === 'delta' && event.text === 'Jawaban berbayar.'), true);
  } finally {
    stub.restore();
  }
});

test('priced agent turn refuses before calling the model when the wallet is empty', async () => {
  const stub = stubUpstream({ chatReplies: ['tidak boleh terpakai'], turnPrice: 5, spendOk: false });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'halo' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    assert.equal(res.status, 402);
    const data = await res.json();
    assert.equal(data.code, 'insufficient_credits');
    assert.match(data.error, /Saldo kredit tidak cukup/);
    assert.equal(stub.state.chatBodies.length, 0, 'model tidak boleh dipanggil tanpa saldo');
  } finally {
    stub.restore();
  }
});

test('failed priced turn is refunded instead of charging for nothing', async () => {
  const stub = stubUpstream({ chatStatus: 500, turnPrice: 5 });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'halo' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    const events = await readSse(res);
    assert.ok(events.some((event) => event.type === 'error'));
    const refund = stub.state.rpcCalls.find((call) => call.fn === 'refund_credits');
    assert.ok(refund, 'harus ada refund saat model gagal');
    assert.equal(refund.body.p_amount, 5);
  } finally {
    stub.restore();
  }
});

test('tool-budget placeholder is refunded and reported as zero credits', async () => {
  const looping = Array.from({ length: 6 }, () => '```tool\n{"name":"web_search","arguments":{"query":"x"}}\n```');
  const stub = stubUpstream({ chatReplies: looping, turnPrice: 5 });
  try {
    const res = await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'ulangi' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    const events = await readSse(res);
    const done = events.at(-1);
    assert.equal(done.stopReason, 'tool_budget');
    assert.equal(done.credits, 0);
    assert.ok(stub.state.rpcCalls.some((call) => call.fn === 'refund_credits'));
  } finally {
    stub.restore();
  }
});

test('free (unpriced) models never touch the wallet', async () => {
  const stub = stubUpstream({ chatReplies: ['gratis'] });
  try {
    await worker.fetch(apiRequest('/api/agent', {
      body: { messages: [{ role: 'user', content: 'halo' }], model: 'gpt-oss-120b:free', provider: 'unorouter' },
    }), createEnv());
    assert.deepEqual(stub.state.rpcCalls, []);
  } finally {
    stub.restore();
  }
});
