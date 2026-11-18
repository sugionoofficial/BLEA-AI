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
  assert.equal(adminHtml.includes('Semua proyek'), false);
});
