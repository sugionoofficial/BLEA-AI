import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { STUDIO_TOOLS, findStudioTool, toolsByGroup } from '../src/studio/toolCatalog.js';

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

test('katalog tool: id unik, tujuan di /studio, status sah, skill disebut', () => {
  assert.equal(new Set(STUDIO_TOOLS.map((tool) => tool.id)).size, STUDIO_TOOLS.length);
  const allowed = new Set(['ready', 'degraded', 'soon']);
  for (const tool of STUDIO_TOOLS) {
    assert.ok(allowed.has(tool.status), `${tool.id}: status tidak sah`);
    assert.match(tool.href, /^\/studio/, `${tool.id}: harus di bawah /studio`);
    assert.ok(tool.label && tool.description && tool.cta, `${tool.id}: metadata kurang`);
    assert.ok(Array.isArray(tool.skills) && tool.skills.length > 0, `${tool.id}: harus menyebut skillnya`);
    if (tool.status !== 'ready') assert.ok(tool.note, `${tool.id}: tool tidak siap wajib punya alasan`);
  }
});

test('toolsByGroup menjaga urutan grup dan tidak menghilangkan tool', () => {
  const groups = toolsByGroup();
  assert.deepEqual(groups.map((group) => group.group), ['Teks', 'Visual', 'Audio', 'Video', 'Utilitas', 'Koneksi']);
  assert.equal(groups.reduce((sum, group) => sum + group.tools.length, 0), STUDIO_TOOLS.length);
  assert.equal(findStudioTool('image').label, 'Buat Gambar');
  assert.equal(findStudioTool('tidak-ada'), null);
});

test('beranda Studio merender setiap kartu tool', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { StudioPage } = await vite.ssrLoadModule('/src/studio/StudioPage.jsx');
  const html = renderToStaticMarkup(
    React.createElement(MemoryRouter, null,
      React.createElement(AuthProvider, { initialSession: null }, React.createElement(StudioPage))),
  );
  assert.ok(html.includes('Pilih alat, lalu mulai.'));
  for (const tool of STUDIO_TOOLS) {
    // React meng-escape '&' menjadi '&amp;' pada markup statis.
    const expected = tool.label.replace(/&/g, '&amp;');
    assert.ok(html.includes(expected), `kartu ${tool.label} tidak dirender`);
  }
  assert.ok(html.includes('studio-tool-card'));
  assert.ok(html.includes('Cari alat'));
});

test('halaman koneksi: satu tombol CONNECTION, tanpa janji pendaftaran akun otomatis', async () => {
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { ConnectionPage } = await vite.ssrLoadModule('/src/studio/ConnectionPage.jsx');
  const html = renderToStaticMarkup(
    React.createElement(MemoryRouter, null,
      React.createElement(AuthProvider, { initialSession: null }, React.createElement(ConnectionPage))),
  );
  // Saat SSR status masih "memeriksa", jadi tombol menampilkan label sibuk.
  assert.ok(html.includes('studio-connection-cta'), 'tombol koneksi harus ada');
  assert.ok(/CONNECTION|Memeriksa/.test(html));
  assert.ok(html.includes('studio-connection-item'), 'daftar status provider harus ada');
  assert.ok(html.includes('tidak saya bangun'));
  assert.ok(html.includes('melanggar ketentuan layanan'));
});

test('ruang kerja tool memakai komponen yang sudah ada, bukan salinan', async () => {
  const fs = await import('node:fs/promises');
  const room = await fs.readFile(new URL('../src/studio/StudioRoomPage.jsx', import.meta.url), 'utf8');
  for (const component of ['GenerateImagePanel', 'GenerateMusicPanel', 'MetadataCheckPage', 'AIStudio', 'AgentPage']) {
    assert.ok(room.includes(component), `ruang kerja harus memakai ${component}`);
  }
  assert.ok(room.includes('belum bisa dijalankan'), 'tool tanpa mesin harus menjelaskan, bukan memalsukan form');
});

test('tema Studio: kanvas hitam + blok abu-abu gelap, varian terang terpisah', async () => {
  const fs = await import('node:fs/promises');
  const css = await fs.readFile(new URL('../src/studio/studio-home.css', import.meta.url), 'utf8');
  assert.ok(css.includes('--studio-canvas: #060607'), 'mode gelap memakai kanvas hitam');
  assert.ok(/--studio-block: #(141416|1b1b1f)/.test(css), 'blok abu-abu');
  assert.ok(css.includes(':root:not(.dark) .studio-home'), 'harus ada varian mode terang');
});
