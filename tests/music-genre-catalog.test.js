// Regression for: "Katalog inspirasi genre kurang banyak, tambahkan yang banyak, buat type
// dropdown seperti pemilihan model" — the old "Inspirasi genre" UI was 4 static chip buttons.
// It is now a large multi-category genre catalog rendered through the same `ModelSelect`
// dropdown component used for model selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('GenerateMusicPanel: "Inspirasi genre" is a ModelSelect-style dropdown with a large multi-category catalog', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate' });
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevLocalStorage = globalThis.localStorage;
  const prevHTMLElement = globalThis.HTMLElement;
  const prevActEnv = globalThis.IS_REACT_ACT_ENVIRONMENT;
  const realFetch = globalThis.fetch;

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  if (!dom.window.HTMLElement.prototype.scrollIntoView) {
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  }

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

  let root = null;
  let supabaseRef = null;
  let oldGetSession = null;
  let oldOnAuth = null;
  try {
    const { MemoryRouter } = await vite.ssrLoadModule('react-router-dom');
    const { AuthProvider } = await vite.ssrLoadModule('/src/auth/AuthProvider.jsx');
    const { GeneratePage } = await vite.ssrLoadModule('/src/auth/GeneratePage.jsx');
    const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');
    supabaseRef = supabase;
    oldGetSession = supabase.auth.getSession;
    oldOnAuth = supabase.auth.onAuthStateChange;

    const USER_ID = '11111111-1111-4111-8111-111111111111';
    supabase.auth.getSession = async () => ({
      data: { session: { access_token: 'user-jwt', user: { id: USER_ID, email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} } } },
    });
    supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe: () => {} } } });
    supabase.rpc = async () => ({ data: 5000, error: null });
    supabase.from = () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: async () => ({ data: [], error: null }),
        then: (resolve) => resolve({ data: [], error: null }),
      };
      return chain;
    };

    globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/account')) return Response.json({ ok: true, status: 'active', blocked: false });
      if (url.includes('/api/video/models')) return Response.json({ ok: true, models: [] });
      if (url.includes('/api/video/history')) return Response.json({ ok: true, generations: [], hasMore: false });
      if (url.includes('/api/image/history')) return Response.json({ ok: true, generations: [] });
      if (url.includes('/api/metadata/history')) return Response.json({ ok: true, jobs: [] });
      if (url.includes('/api/music/config')) {
        return Response.json({
          ok: true,
          provider_ready: true,
          models: [{
            provider: 'freebeat',
            model: '129',
            name: 'Lyria 3 Pro',
            credits: 1000,
            ready: true,
            params: { supports_duration: true, supports_lyrics: true, supports_instrumental: true, requires_lyrics: false },
          }],
        });
      }
      if (url.includes('/api/music/history')) return Response.json({ ok: true, generations: [] });
      if (url.includes('/api/generations/live')) {
        return Response.json({ ok: true, is_admin: false, server_time: new Date().toISOString(), counts: {}, items: [] });
      }
      return Response.json({ ok: true });
    };

    const userSession = { access_token: 'user-jwt', user: { id: USER_ID, email: 'creator@example.com', app_metadata: { role: 'user' }, user_metadata: {} } };

    root = createRoot(document.getElementById('root'));
    await React.act(async () => {
      root.render(React.createElement(MemoryRouter, { initialEntries: ['/generate'] }, React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(GeneratePage))));
    });
    const musicTab = [...document.querySelectorAll('button[role="tab"]')].find((b) => b.textContent.trim() === 'Generate musik');
    assert.ok(musicTab, 'GeneratePage must show Generate musik tab');
    await React.act(async () => { musicTab.click(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 60)); });

    // The old static 4-chip UI ("Klik untuk mengisi prompt" + .generate-chip buttons) is gone.
    assert.equal(document.querySelectorAll('.generate-chip').length, 0, 'static genre chip buttons must be replaced');

    // The genre field is now a ModelSelect dropdown trigger, distinct from the model-select trigger.
    const genreTrigger = document.querySelector('button[aria-label="Inspirasi genre musik"]');
    assert.ok(genreTrigger, 'genre inspiration must render as a ModelSelect-style dropdown trigger');
    assert.equal(genreTrigger.getAttribute('aria-haspopup'), 'listbox');

    // Hint text reports a large catalog count, not a tiny fixed number.
    assert.match(document.body.textContent, /\d+ genre/);
    const hintMatch = document.body.textContent.match(/(\d+) genre/);
    const genreCount = Number(hintMatch[1]);
    assert.ok(genreCount >= 40, `expected a large genre catalog, got ${genreCount}`);

    // Open the dropdown and confirm many options across several categories are listed.
    await React.act(async () => { genreTrigger.click(); });
    const listbox = document.querySelector('[role="listbox"][aria-label="Inspirasi genre musik"]');
    assert.ok(listbox, 'dropdown must open a listbox, matching ModelSelect behavior');
    const options = [...listbox.querySelectorAll('[role="option"]')];
    assert.equal(options.length, genreCount);
    assert.ok(options.length >= 40);

    const categoryBadges = new Set(
      [...listbox.querySelectorAll('.generate-model-provider')].map((el) => el.textContent.trim()),
    );
    assert.ok(categoryBadges.size >= 8, `expected many genre categories, got ${[...categoryBadges].join(', ')}`);
    assert.ok(categoryBadges.has('Pop'));
    assert.ok(categoryBadges.has('Dunia'));

    // Selecting a genre fills the prompt textarea with its descriptive text and closes the popover.
    const popOption = options.find((opt) => opt.textContent.includes('Pop Modern'));
    assert.ok(popOption, 'expected a "Pop Modern" genre option');
    await React.act(async () => { popOption.click(); });

    const textarea = document.querySelector('textarea.generate-textarea');
    assert.ok(textarea, 'prompt textarea must exist');
    assert.match(textarea.value, /modern pop anthem/i);
    assert.equal(document.querySelector('[role="listbox"][aria-label="Inspirasi genre musik"]'), null, 'popover should close after selecting');

    // Picking a different genre afterwards overwrites the prompt with the new genre's text.
    await React.act(async () => { genreTrigger.click(); });
    const listbox2 = document.querySelector('[role="listbox"][aria-label="Inspirasi genre musik"]');
    const dangdutOption = [...listbox2.querySelectorAll('[role="option"]')].find((opt) => opt.textContent.includes('Dangdut Koplo'));
    assert.ok(dangdutOption, 'expected a "Dangdut Koplo" genre option');
    await React.act(async () => { dangdutOption.click(); });
    assert.match(textarea.value, /dangdut koplo/i);
  } finally {
    if (root) await React.act(async () => { root.unmount(); });
    if (supabaseRef) {
      supabaseRef.auth.getSession = oldGetSession;
      supabaseRef.auth.onAuthStateChange = oldOnAuth;
      await supabaseRef.auth.dispose();
    }
    await vite.close();
    dom.window.close();
    globalThis.fetch = realFetch;
    globalThis.window = prevWindow;
    globalThis.document = prevDocument;
    globalThis.localStorage = prevLocalStorage;
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.IS_REACT_ACT_ENVIRONMENT = prevActEnv;
  }
});
