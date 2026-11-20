import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('UserDashboard opens only 1 new form when adding, not all existing example cards', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/app' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
    resolve: {
      alias: [{ find: /^react-router-dom$/, replacement: new URL('../node_modules/react-router-dom/dist/index.mjs', import.meta.url).pathname }],
    },
  });
  const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
  const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
  const { UserDashboard } = await vite.ssrLoadModule('/src/auth/UserDashboard.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

  const sampleItems = [
    { id: 'ex-1', kind: 'image', title: 'Contoh A', prompt: 'Prompt A', media_url: 'https://cdn.example/a.png', poster_url: '', sort_order: 1, published: true },
    { id: 'ex-2', kind: 'video', title: 'Contoh B', prompt: 'Prompt B', media_url: 'https://cdn.example/b.mp4', poster_url: '', sort_order: 2, published: true },
  ];
  const oldFrom = supabase.from;
  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  const adminSession = {
    access_token: 'admin-jwt',
    user: { id: 'admin-1', email: 'admin@example.com', app_metadata: { role: 'admin' }, user_metadata: {} },
  };
  supabase.auth.getSession = async () => ({ data: { session: adminSession } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
  supabase.from = () => ({
    select: () => ({
      order: () => ({
        order: async () => ({ data: sampleItems, error: null }),
      }),
    }),
  });

  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/app'] },
        React.createElement(AuthProvider, { initialSession: adminSession }, React.createElement(UserDashboard))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 25)));

    assert.equal(document.querySelectorAll('form.showcase-form').length, 0);

    const addBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Tambah contoh baru'));
    assert.ok(addBtn);
    await React.act(async () => addBtn.click());

    assert.equal(document.querySelectorAll('form.showcase-form').length, 1);
    assert.equal(document.querySelectorAll('.showcase-card.is-editing').length, 0);

    const editBtnA = document.querySelector('button[aria-label="Edit Contoh A"]');
    assert.ok(editBtnA);
    await React.act(async () => editBtnA.click());

    assert.equal(document.querySelectorAll('form.showcase-form').length, 1);
    assert.equal(document.querySelectorAll('.showcase-card.is-editing').length, 1);
  } finally {
    await React.act(async () => root.unmount());
    supabase.from = oldFrom;
    supabase.auth.getSession = oldGet;
    supabase.auth.onAuthStateChange = oldOn;
    await supabase.auth.dispose();
    await vite.close();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.localStorage;
    delete globalThis.HTMLElement;
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
