import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;

before(async () => {
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  }
  vite = await createServer({
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
});

after(async () => {
  await vite?.close();
});

test('GeneratePage renders all requested video generation inputs and button', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');

  const session = {
    access_token: 'test-token',
    user: { id: 'u1', email: 'creator@example.com', user_metadata: { full_name: 'Kreator' }, app_metadata: {} },
  };

  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/generate'] },
      React.createElement(AuthProvider, { initialSession: session }, React.createElement(GeneratePage)),
    ),
  );

  for (const required of [
    'Pilih Model',
    'Upload Image',
    'Upload Video',
    'Upload Audio',
    'Prompt',
    'Rasio',
    'Resolusi',
    'Durasi',
    '>Generate<',
    'Riwayat Generate',
  ]) {
    assert.ok(html.includes(required), `Expected GeneratePage markup to include "${required}"`);
  }
  assert.equal(html.includes('Proyek'), false, 'GeneratePage should not contain Proyek');
});

test('DropXDashboard and AdminPage render video generation metrics instead of Proyek', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { DropXDashboard } = await vite.ssrLoadModule('/src/dropx/DropXDashboard.jsx');
  const { AdminPage } = await vite.ssrLoadModule('/src/auth/AdminPage.jsx');

  const adminSession = {
    access_token: 'admin-token',
    user: {
      id: 'admin-1',
      email: 'admin@example.com',
      user_metadata: { full_name: 'Admin' },
      app_metadata: { role: 'admin' },
    },
  };

  const dashHtml = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/app'] },
      React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(DropXDashboard)),
    ),
  );
  assert.ok(dashHtml.includes('Generate Video'));
  assert.ok(dashHtml.includes('Video Dihasilkan'));
  assert.ok(dashHtml.includes('Generasi video terbaru'));
  assert.equal(/Proyek Aktif|Progres proyek|Proyek baru/.test(dashHtml), false);

  const adminHtml = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/admin'] },
      React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(AdminPage)),
    ),
  );
  assert.ok(adminHtml.includes('Generasi video'));
  assert.ok(adminHtml.includes('API Key'));
  assert.ok(adminHtml.includes('admin-subnav'));
  assert.ok(adminHtml.includes('Provider &amp; API Key'));
  assert.ok(adminHtml.includes('Katalog Model'));
  assert.equal(adminHtml.includes('Model Manual'), false, 'Model Manual tab must be removed from AdminPage');
  assert.ok(adminHtml.includes('Tambah Provider'));
  assert.equal(adminHtml.includes('Semua proyek'), false);
  assert.equal(adminHtml.includes('Belum terhubung'), false, 'AdminPage must not inject a hardcoded fallback UnoRouter provider row');
});

test('Admin CSS keeps readable contrast and avoids white-on-white legacy readability overrides', async () => {
  const fs = await import('node:fs');
  const readabilityCss = fs.readFileSync(new URL('../src/readability.css', import.meta.url), 'utf8');
  const adminCss = fs.readFileSync(new URL('../src/auth/admin.css', import.meta.url), 'utf8');
  const adminSource = fs.readFileSync(new URL('../src/auth/AdminPage.jsx', import.meta.url), 'utf8');

  assert.equal(/\.admin-/.test(readabilityCss), false, 'readability.css must not override .admin-* text to white');
  assert.equal(/\bth\s*\{|\btd\s*\{/.test(readabilityCss), false, 'readability.css must not override table th/td to white');
  assert.ok(adminCss.includes('.admin-workspace'), 'admin.css should define nested .admin-workspace grid');
  assert.ok(adminCss.includes('.admin-subnav-children'), 'admin.css should style nested sub-navigation');
  assert.ok(adminCss.includes('.admin-secret-input'), 'admin.css should mask API keys visually without type="password"');
  assert.equal(adminSource.includes('type="password"'), false, 'AdminPage must not use type="password" so browsers never autofill login email/password into provider fields');
  assert.equal(adminSource.includes("provider: 'unorouter', label: 'UnoRouter'"), false, 'AdminPage must not hardcode a fallback UnoRouter row');
});

test('AIStudio renders composer, chat history shell, and model status cleanly', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { AIStudio } = await vite.ssrLoadModule('/src/auth/AIStudio.jsx');

  const session = {
    access_token: 'user-token',
    user: { id: 'u1', email: 'creator@example.com', user_metadata: { full_name: 'Kreator' }, app_metadata: {} },
  };

  const studioHtml = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      { initialEntries: ['/ai'] },
      React.createElement(AuthProvider, { initialSession: session }, React.createElement(AIStudio)),
    ),
  );
  assert.ok(studioHtml.includes('BLEA AI STUDIO'));
  assert.ok(studioHtml.includes('Percakapan baru'));
  assert.ok(studioHtml.includes('Tulis pesan'));

  const fs = await import('node:fs');
  const studioCss = fs.readFileSync(new URL('../src/auth/studio.css', import.meta.url), 'utf8');
  const studioSource = fs.readFileSync(new URL('../src/auth/AIStudio.jsx', import.meta.url), 'utf8');
  assert.ok(studioCss.includes('.studio-thinking-panel'));
  assert.ok(studioCss.includes('.studio-temp-code'));
  assert.ok(studioCss.includes('.studio-typing-cursor'));
  assert.ok(studioSource.includes('chatCompletionStream'));
  assert.ok(studioSource.includes('studio-thinking-panel'));
  assert.ok(studioSource.includes('StudioTempCodePreview'));

  const composerMatch = studioSource.match(/<form className="studio-composer"[\s\S]*?<\/form>/);
  assert.ok(composerMatch, 'studio-composer form should exist');
  assert.equal(/Sedang berpikir|Mengetik balasan|Menghubungkan AI|Mencari di web/.test(composerMatch[0]), false, 'Thinking/typing status animations must stay inside the AI reply bubble, not inside the text input block');

  const { StudioTempCodePreview, StudioMessageBody } = await vite.ssrLoadModule('/src/auth/AIStudio.jsx');
  const earlyTemp = renderToStaticMarkup(React.createElement(StudioTempCodePreview, { charCount: 14 }));
  assert.ok(earlyTemp.includes('studio-temp-code'));
  assert.ok(earlyTemp.includes('studio-temp-cursor'));
  assert.equal(earlyTemp.includes('streamTokens'), false, 'Early animation tick should only reveal the beginning lines');

  const lateTemp = renderToStaticMarkup(React.createElement(StudioTempCodePreview, { charCount: 145 }));
  assert.ok(lateTemp.includes('analyzePrompt'));
  assert.ok(lateTemp.includes('reasonStep'));
  assert.ok(lateTemp.includes('streamTokens'));

  const streamingCode = renderToStaticMarkup(
    React.createElement(StudioMessageBody, {
      content: 'Berikut kode:\n\n```js\nconst x = 42;',
      isTyping: true,
      copiedCodeKey: '',
      onCopyCode: () => {},
    }),
  );
  assert.ok(streamingCode.includes('studio-code-block'));
  assert.ok(streamingCode.includes('const x = 42;'));
  assert.ok(streamingCode.includes('studio-typing-cursor'));
});

test('TempMail admin page renders privately and isolates untrusted email HTML', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { TempMailPage } = await vite.ssrLoadModule('/src/auth/TempMailPage.jsx');
  const adminSession = {
    access_token: 'admin-token',
    user: { id: 'admin-1', email: 'admin@example.com', user_metadata: { full_name: 'Admin' }, app_metadata: { role: 'admin' } },
  };
  const html = renderToStaticMarkup(React.createElement(
    MemoryRouter,
    { initialEntries: ['/tempmail'] },
    React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(TempMailPage)),
  ));
  assert.ok(html.includes('TempMail'));
  assert.ok(html.includes('ADMIN ONLY'));
  assert.ok(html.includes('Hubungkan Gmail Anda'));
  assert.ok(html.includes('Buat alamat email'));
  assert.ok(html.includes('PROVIDER_CREDENTIAL_ENCRYPTION_KEY'));
  const source = (await import('node:fs')).readFileSync(new URL('../src/auth/TempMailPage.jsx', import.meta.url), 'utf8');
  assert.ok(source.includes('sandbox=""'), 'Email HTML must be rendered in a sandboxed iframe without scripts or same-origin access');
  assert.ok(source.includes("default-src 'none'"), 'Email HTML iframe must apply a restrictive CSP');
});

test('History page is available to signed-in users and starts with a loading state', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { HistoryPage } = await vite.ssrLoadModule('/src/auth/HistoryPage.jsx');
  const session = { access_token: 'test-token', user: { id: 'u1', email: 'creator@example.com', user_metadata: {}, app_metadata: {} } };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/history'] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(HistoryPage))));
  assert.ok(html.includes('Riwayat generasi milik Anda.'));
  assert.ok(html.includes('History'));
  assert.ok(html.includes('Memuat riwayat'));
});

test('Credits page shows the pending rollout notice to signed-in users', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { CreditsPage } = await vite.ssrLoadModule('/src/auth/CreditsPage.jsx');
  const session = { access_token: 'test-token', user: { id: 'u1', email: 'creator@example.com', user_metadata: {}, app_metadata: {} } };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/credits'] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(CreditsPage))));
  assert.ok(html.includes('Pembelian kredit belum dibuka'));
  assert.ok(html.includes('Jangan melakukan transfer'));
  assert.equal(html.includes('Admin · Kelola paket'), false);
});

test('Freebeat MCP hub links to isolated experiment routes with back navigation', async () => {
  const { MemoryRouter, Routes, Route } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { FreebeatPage } = await vite.ssrLoadModule('/src/auth/FreebeatPage.jsx');
  const session = { access_token: 'admin-token', user: { id: 'admin', email: 'admin@example.com', user_metadata: {}, app_metadata: { role: 'admin' } } };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/admin/freebeat'] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(FreebeatPage))));
  assert.ok(html.includes('Hubungkan Freebeat'));
  assert.ok(html.includes('Periksa saldo'));
  assert.ok(html.includes('Pemeriksaan saldo tidak memakai kredit'));
  assert.equal(html.includes('Uji saldo situs dengan cookie'), false);
  const { FREEBEAT_EXPERIMENTS } = await vite.ssrLoadModule('/src/auth/freebeatExperiments.js');
  for (const item of FREEBEAT_EXPERIMENTS) {
    assert.ok(html.includes(`href="/admin/freebeat/${item.id}"`), item.id);
  }
  for (const title of ['Gambar', 'Video', 'Musik', 'Inspeksi MCP']) assert.ok(html.includes(title));
  assert.equal(html.includes('<form'), false, 'hub must not contain experiment forms');
  assert.equal(html.includes('Siapkan quote untuk persetujuan'), false);
  assert.equal(html.includes('Muat ulang model video'), false);

  const expected = {
    'image-models': 'Lihat model gambar', 'image-edit': 'Probe quote mode edit',
    'image-generation': 'Uji generasi gambar admin', 'image-job': 'Periksa job gambar',
    video: 'Uji generasi video khusus admin', hailuo: 'Hailuo', ltx: 'LTX 2.3', dance: 'generate_dance_video',
    singing: 'Uji Singing Video', 'lip-sync': 'Uji Lip-Sync Video',
    'vocal-schemas': 'Inspeksi skema Singing', 'remaining-schemas': 'Inspeksi skema 7 tool',
    catalog: 'Inspeksi katalog musik', 'remaining-quotes': 'Uji quote_generation', music: 'Uji Musik',
  };
  for (const item of FREEBEAT_EXPERIMENTS) {
    const page = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [`/admin/freebeat/${item.id}`] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(Routes, null, React.createElement(Route, { path: '/admin/freebeat/:experimentId', element: React.createElement(FreebeatPage) })))));
    assert.ok(page.includes(expected[item.id]), item.id);
    assert.ok(page.includes('href="/admin/freebeat"'), 'return navigation: ' + item.id);
    assert.equal(page.includes('Periksa saldo'), false, 'connection management stays on hub');
    if (item.id !== 'image-generation') assert.equal(page.includes('Siapkan quote untuk persetujuan</button>'), false);
    if (item.id !== 'video') assert.equal(page.includes('Uji generasi video khusus admin'), false);
    if (item.id === 'singing') assert.equal(page.includes('Unggah video sumber'), false);
    if (item.id === 'lip-sync') assert.equal(page.includes('Tambah foto'), false);
  }
  const unknown = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: ['/admin/freebeat/missing'] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(Routes, null, React.createElement(Route, { path: '/admin/freebeat/:experimentId', element: React.createElement(FreebeatPage) })))));
  assert.ok(unknown.includes('Percobaan Freebeat tidak ditemukan'));

});

test('Freebeat image preparation explains every blocking condition and enables only with valid inputs and permission', async () => {
  const { FreebeatImageForm, prepareBlockers } = await vite.ssrLoadModule('/src/auth/FreebeatImageForm.jsx');
  const ready = { loading: false, connected: true, imageAccess: true, busy: false, imageBusy: false, testBusy: false, model: '80', prompt: 'seekor kucing' };
  assert.deepEqual(prepareBlockers(ready), []);
  for (const [changes, expected] of [
    [{ loading: true }, /Menunggu pemeriksaan koneksi/],
    [{ connected: false }, /belum terhubung atau sudah berakhir/],
    [{ imageAccess: false }, /Izin gambar belum tersedia/],
    [{ busy: true }, /sedang berjalan/],
    [{ imageBusy: true }, /sedang berjalan/],
    [{ testBusy: true }, /sedang berjalan/],
    [{ model: '' }, /Isi ID model/],
    [{ model: '-1' }, /bilangan bulat nonnegatif/],
    [{ model: '1.5' }, /bilangan bulat nonnegatif/],
    [{ model: '9007199254740992' }, /bilangan bulat nonnegatif/],
    [{ prompt: '   ' }, /Isi prompt/],
    [{ prompt: 'x'.repeat(2001) }, /maksimal 2000/],
  ]) {
    const props = { ...ready, ...changes };
    assert.match(prepareBlockers(props).join(' '), expected);
    const markup = renderToStaticMarkup(React.createElement(FreebeatImageForm, { ...props, onModelChange() {}, onPromptChange() {}, onInspect() {}, onPrepare() {} }));
    assert.match(markup, /<button type="button" disabled="" aria-describedby="freebeat-prepare-help">Siapkan quote/);
    assert.match(markup, expected);
  }
  const html = renderToStaticMarkup(React.createElement(FreebeatImageForm, { ...ready, onModelChange() {}, onPromptChange() {}, onInspect() {}, onPrepare() {} }));
  assert.match(html, /<button type="button" aria-describedby="freebeat-prepare-help">Siapkan quote/);
  assert.match(html, /Langkah ini tidak membuat gambar atau memakai kredit/);
  assert.ok(html.indexOf('ID model gambar') < html.indexOf('Siapkan quote untuk persetujuan'));
  assert.ok(html.indexOf('Prompt percobaan') < html.indexOf('Siapkan quote untuk persetujuan'));
});

test('Freebeat completed image result is an obvious external link, not an automatic image load', async () => {
  const { FreebeatTaskResult } = await vite.ssrLoadModule('/src/auth/FreebeatTaskResult.jsx');
  const { JSDOM } = await import('jsdom');
  const fs = await import('node:fs/promises');
  const task = { status: 'completed', images: ['https://cdn.example/test.png?signature=private'], billing: { charged: 10, refunded: null, net: null, refund_state: null } };
  const html = renderToStaticMarkup(React.createElement(FreebeatTaskResult, { task }));
  const dom = new JSDOM(html);
  const anchor = dom.window.document.querySelector('a.freebeat-result-link');
  assert.ok(anchor, 'completed image must expose a recognizable link');
  assert.equal(anchor.href, task.images[0]);
  assert.match(anchor.textContent, /Buka hasil gambar 1/);
  assert.equal(anchor.target, '_blank');
  assert.equal(anchor.rel, 'noopener noreferrer');
  assert.equal(dom.window.document.querySelectorAll('img').length, 0);
  assert.match(dom.window.document.body.textContent, /Jangan bagikan tautan pribadi/);
  const css = await fs.readFile(new URL('../src/auth/freebeat.css', import.meta.url), 'utf8');
  assert.match(css, /\.dropx-shell \.freebeat-page a\.freebeat-result-link\{/);
  assert.match(css, /a\.freebeat-result-link\{[^}]*background:var\(--primary-600\);color:#fff/);
  assert.match(css, /a\.freebeat-result-link:focus-visible\{/);
  const missing = renderToStaticMarkup(React.createElement(FreebeatTaskResult, { task: { ...task, images: [] } }));
  assert.match(missing, /belum ada tautan gambar yang dapat ditampilkan/);
  assert.match(missing, /jangan mengirim generasi ulang/);
  assert.doesNotMatch(missing, /class="freebeat-result-link"/);
  const running = renderToStaticMarkup(React.createElement(FreebeatTaskResult, { task: { ...task, status: 'processing', images: [] } }));
  assert.doesNotMatch(running, /belum ada tautan gambar/);
  dom.window.close();
});

test('Generate page offers both modes without defaulting to UnoRouter', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
  const user = { access_token: 'user-token', user: { id: 'user', app_metadata: {}, user_metadata: {} } };
  const admin = { access_token: 'admin-token', user: { id: 'admin', app_metadata: { role: 'admin' }, user_metadata: {} } };
  const view = (entry, session) => renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [entry] }, React.createElement(AuthProvider, { initialSession: session }, React.createElement(GeneratePage))));
  const video = view('/generate', user);
  assert.match(video, /Generate gambar/);
  assert.match(video, /Generate video/);
  assert.match(video, /Tidak ada model video aktif/);
  assert.doesNotMatch(video, /UnoRouter/i);
  const imageUser = view('/generate?mode=image', user);
  assert.match(imageUser, /Prompt gambar/);
  assert.doesNotMatch(imageUser, /UnoRouter/i);
  assert.doesNotMatch(imageUser, /mode edit/i);
  // Panel gambar bersifat konsumen untuk semua peran; diagnostik admin
  // Freebeat berada di /admin/freebeat, bukan di halaman ini.
  const imageAdmin = view('/generate?mode=image', admin);
  assert.match(imageAdmin, /Prompt gambar/);
  assert.doesNotMatch(imageAdmin, /Siapkan quote/);
  assert.doesNotMatch(imageAdmin, /UnoRouter/i);
});

test('Mobile polish and animated loading stages are wired across Dashboard, Chat AI, and Generate', async () => {
  const fs = await import('node:fs');
  const dropxCss = fs.readFileSync(new URL('../src/dropx/dropx.css', import.meta.url), 'utf8');
  const mobileCss = fs.readFileSync(new URL('../src/mobile.css', import.meta.url), 'utf8');
  const showcaseCss = fs.readFileSync(new URL('../src/auth/showcase.css', import.meta.url), 'utf8');
  const studioCss = fs.readFileSync(new URL('../src/auth/studio.css', import.meta.url), 'utf8');
  const generateCss = fs.readFileSync(new URL('../src/auth/generate.css', import.meta.url), 'utf8');
  const studioSrc = fs.readFileSync(new URL('../src/auth/AIStudio.jsx', import.meta.url), 'utf8');
  const generateSrc = fs.readFileSync(new URL('../src/auth/GeneratePage.jsx', import.meta.url), 'utf8');
  const imageSrc = fs.readFileSync(new URL('../src/auth/GenerateImagePanel.jsx', import.meta.url), 'utf8');

  assert.match(dropxCss, /\.dx-grid-4\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(mobileCss, /\.dropx-quick-card\s*\{[^}]*flex-direction:\s*row/);
  assert.match(mobileCss, /\.showcase-prompt\s*\{[^}]*max-height:/);
  assert.match(showcaseCss, /\.showcase-card-actions/);
  assert.match(studioCss, /\.studio-shell\.is-history-open\s+\.studio-sidebar/);
  assert.match(studioCss, /\.studio-composer-note\s*\{\s*display:\s*none;/);
  assert.match(studioSrc, /studio-history-toggle/);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-params-grid\s*\{\s*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-loader-stage/);
  assert.match(generateCss, /\.dropx-shell\s+\.history-preview\.generate-img-loader/);
  assert.match(generateCss, /@keyframes gen-spin/);
  assert.match(generateSrc, /generate-loader-stage/);
  assert.match(generateSrc, /generate-btn-spinner/);
  assert.match(imageSrc, /generate-img-loader/);

  const dashSrc = fs.readFileSync(new URL('../src/dropx/DropXDashboard.jsx', import.meta.url), 'utf8');
  const userDashSrc = fs.readFileSync(new URL('../src/auth/UserDashboard.jsx', import.meta.url), 'utf8');
  assert.match(dashSrc, /dropx-recent-row/);
  assert.match(dashSrc, /dropx-metrics-col/);
  assert.match(dashSrc, /dropx-feed-body/);
  assert.equal(dashSrc.includes('className="flex items-center gap-3 py-1.5"'), false, 'DropXDashboard must not rely on missing Tailwind utility classes');
  assert.match(mobileCss, /\.dropx-metrics-col\s*\{\s*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(userDashSrc, /MAX_PROMPT_CHARS\s*=\s*10000/);
  assert.match(userDashSrc, /MAX_VIDEO_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024/);
  assert.match(userDashSrc, /Unggah thumbnail/);
  assert.match(userDashSrc, /uploadTusResumable/);

  const landingCss = fs.readFileSync(new URL('../src/landing.css', import.meta.url), 'utf8');
  const stylesCss = fs.readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const authCss = fs.readFileSync(new URL('../src/auth/auth.css', import.meta.url), 'utf8');

  // Pinned headers across all pages
  assert.match(dropxCss, /\.dropx-shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
  assert.match(dropxCss, /\.dropx-main\s*\{[^}]*min-height:\s*0;[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/s);
  assert.match(dropxCss, /\.dropx-header\s*\{[^}]*position:\s*sticky;\s*top:\s*0;[^}]*flex-shrink:\s*0;/s);
  assert.match(dropxCss, /@media\s*\(max-width:\s*1023px\)\s*\{[\s\S]*?\.dropx-header\s*\{[^}]*position:\s*fixed;\s*top:\s*0;/);
  assert.match(mobileCss, /\.dropx-main\s*\{[^}]*padding-top:\s*52px;/);
  assert.match(landingCss, /\.briv-shell\{[^}]*overflow-x:clip/);
  assert.match(landingCss, /\.briv-header\{[^}]*position:sticky;top:0/);
  assert.match(stylesCss, /\.site-shell\{[^}]*overflow-x:clip/);
  assert.match(stylesCss, /\.header\{[^}]*position:sticky;top:0/);
  assert.match(authCss, /\.auth-page\{[^}]*overflow-x:clip/);
  assert.match(authCss, /\.auth-header\{[^}]*position:sticky;top:0/);
  assert.match(mobileCss, /body\s*\{\s*overflow-x:\s*clip;/);

  // Zero right-edge horizontal overflow on Generate Video
  assert.match(generateCss, /\.dropx-shell\s+\.generate-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-media-grid\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-card\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*clip;/s);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-pill\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-model-desc\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(mobileCss, /\.dropx-shell\s+\.generate-card\s*\{[^}]*overflow-x:\s*clip;/s);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-model-popover/);
  assert.match(generateCss, /\.dropx-shell\s+\.generate-img-live-stage/);

  // Mobile loading spinners must NEVER be stopped globally by prefers-reduced-motion
  assert.equal(/\*\s*,\s*\*::before\s*,\s*\*::after\s*\{[^}]*animation-duration:\s*\.01ms/s.test(stylesCss), false);
  assert.equal(authCss.includes('.loader-orbit,.button-loader{animation-duration:.01ms'), false);
  assert.match(mobileCss, /\.loader-orbit,[\s\S]*?\.dropx-shell\s+\.live-refresh-icon\.is-spinning\s*\{[^}]*transform-origin:\s*center;/s);
  assert.match(mobileCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.dropx-shell\s+\.generate-orbit-ring\s*\{[^}]*animation:\s*gen-spin\s+1\.4s\s+linear\s+infinite\s*!important;/s);
});
