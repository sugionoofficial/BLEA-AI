import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('ModelSelect opens compact popover and GenerateImagePanel shows live animated loader', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://blea.example/generate?mode=image' });
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
  const { GenerateImagePanel } = await vite.ssrLoadModule('/src/auth/GenerateImagePanel.jsx');
  const { supabase } = await vite.ssrLoadModule('/src/lib/supabase.js');

  const userSession = {
    access_token: 'user-jwt',
    user: { id: 'u1', email: 'u@example.com', app_metadata: { role: 'user' }, user_metadata: {} },
  };
  const oldGet = supabase.auth.getSession;
  const oldOn = supabase.auth.onAuthStateChange;
  const oldFetch = globalThis.fetch;
  supabase.auth.getSession = async () => ({ data: { session: userSession } });
  supabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });

  let resolveGenerate;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input?.url || String(input));
    if (url === '/api/account') return Response.json({ ok: true, status: 'active', blocked: false, role: 'user' });
    if (url === '/api/image/config') {
      return Response.json({
        ok: true,
        models: [
          { provider: 'freebeat', model: '122', name: 'Freebeat: model 122', credits: 15, ready: true, params: null },
          { provider: 'alibaba', model: 'wan2.7-image', name: 'Alibaba: Wan 2.7 Image', credits: 80, ready: true, params: { sizes: ['1K', '2K'], defaultSize: '2K', maxN: 1 } },
        ],
      });
    }
    if (url === '/api/image/history') return Response.json({ ok: true, generations: [] });
    if (url.includes('/rest/v1/credit_wallets')) return Response.json({ balance: 500 });
    if (url === '/api/image/generate') {
      return new Promise((resolve) => { resolveGenerate = resolve; });
    }
    throw new Error(`Unexpected ${url}`);
  };

  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(
      React.createElement(MemoryRouter, { initialEntries: ['/generate?mode=image'] },
        React.createElement(AuthProvider, { initialSession: userSession }, React.createElement(GenerateImagePanel))),
    ));
    await React.act(async () => new Promise((r) => setTimeout(r, 25)));

    const trigger = document.querySelector('.generate-model-trigger');
    assert.ok(trigger);
    await React.act(async () => trigger.click());
    const popover = document.querySelector('.generate-model-popover[role="listbox"]');
    assert.ok(popover, 'Compact model popover should open on trigger click');
    const alibabaOption = [...popover.querySelectorAll('.generate-model-option')].find((opt) => opt.textContent.includes('Alibaba: Wan 2.7 Image'));
    assert.ok(alibabaOption);
    await React.act(async () => alibabaOption.click());
    assert.equal(document.querySelector('.generate-model-popover'), null, 'Popover should close after selection');
    assert.match(document.querySelector('.generate-model-trigger').textContent, /Alibaba: Wan 2\.7 Image/);

    const textarea = document.querySelector('textarea');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Lentera malam neon');
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const submitBtn = document.querySelector('button.generate-submit-btn');
    assert.equal(submitBtn.disabled, false);
    await React.act(async () => submitBtn.click());

    const liveStage = document.querySelector('.generate-img-live-stage');
    assert.ok(liveStage, 'Live animated stage must render immediately when generating an image');
    assert.ok(liveStage.querySelector('.generate-aurora'));
    assert.ok(liveStage.querySelector('.generate-scanbeam'));
    assert.ok(liveStage.querySelector('.generate-orbit'));

    await React.act(async () => {
      resolveGenerate(Response.json({
        ok: true,
        status: 'submitted',
        credits: 80,
        generation: { id: 'g-live-1', provider: 'alibaba', model: 'wan2.7-image', status: 'processing', prompt: 'Lentera malam neon', credits_charged: 80, canPoll: true },
      }));
    });
    assert.ok(document.querySelector('.generate-img-live-stage'));
    assert.ok(document.querySelector('.history-preview.generate-img-loader'));
  } finally {
    await React.act(async () => root.unmount());
    supabase.auth.getSession = oldGet;
    supabase.auth.onAuthStateChange = oldOn;
    globalThis.fetch = oldFetch;
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
