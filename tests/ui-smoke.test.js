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
  assert.ok(adminHtml.includes('Model Manual'));
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
});
