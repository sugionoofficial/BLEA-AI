import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'vite';

const mainSource = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');

let vite;
let nav;

before(async () => {
  vite = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  nav = await vite.ssrLoadModule('/src/dropx/navigation.jsx');
});

after(async () => {
  await vite?.close();
});

test('navigation contains only working app routes and gates Admin Panel to admins', () => {
  const userItems = nav.flattenNavigation({ isAdmin: false });
  assert.deepEqual(
    userItems.map((item) => ({ title: item.title, href: item.href })),
    [
      { title: 'Dashboard', href: '/app' },
      { title: 'Chat AI', href: '/studio' },
      { title: 'Generate', href: '/generate' },
      { title: 'Cek Metadata', href: '/metadata' },
      { title: 'Proses Live', href: '/live' },
      { title: 'Kredit', href: '/credits' },
      { title: 'History', href: '/history' },
      { title: 'Setting', href: '/settings' },
    ],
  );

  const adminItems = nav.flattenNavigation({ isAdmin: true });
  assert.deepEqual(
    adminItems.map((item) => ({ title: item.title, href: item.href })),
    [
      { title: 'Dashboard', href: '/app' },
      { title: 'Chat AI', href: '/studio' },
      { title: 'Generate', href: '/generate' },
      { title: 'Cek Metadata', href: '/metadata' },
      { title: 'Proses Live', href: '/live' },
      { title: 'Kredit', href: '/credits' },
      { title: 'History', href: '/history' },
      { title: 'Admin Panel', href: '/admin' },
      { title: 'Freebeat MCP', href: '/admin/freebeat' },
      { title: 'TempMail', href: '/tempmail' },
      { title: 'Setting', href: '/settings' },
    ],
  );

  // Every route in navigation must exist in src/main.jsx
  for (const item of adminItems) {
    assert.ok(
      mainSource.includes(`path="${item.href}"`),
      `Expected route ${item.href} to exist in src/main.jsx`,
    );
    assert.equal(nav.resolveRoute(item.href), item.href);
  }

  // Legacy /projects URL must cleanly redirect to /generate
  assert.ok(
    mainSource.includes('<Route path="/projects" element={<Navigate to="/generate" replace />}'),
    'Expected /projects redirect to /generate in src/main.jsx',
  );

  // Admin group is omitted when user is not an admin
  const userGroups = nav.getNavigation({ isAdmin: false });
  assert.equal(userGroups.some((g) => g.label === 'Admin'), false);
  const adminGroups = nav.getNavigation({ isAdmin: true });
  assert.equal(adminGroups.some((g) => g.label === 'Admin'), true);
  assert.equal(userItems.some((item) => item.href === '/tempmail'), false, 'TempMail must not appear for non-admins');
  assert.equal(adminItems.find((item) => item.href === '/tempmail')?.adminOnly, true);
  assert.ok(mainSource.includes('<Route path="/tempmail" element={<TempMailPage />} />'));
  assert.ok(mainSource.indexOf('<Route element={<AdminRoute />}>') < mainSource.indexOf('<Route path="/tempmail" element={<TempMailPage />} />'));
});

test('activeNavHref highlights the exact matching route and respects admin role', () => {
  assert.equal(nav.activeNavHref('/app'), '/app');
  assert.equal(nav.activeNavHref('/studio'), '/studio');
  assert.equal(nav.activeNavHref('/generate'), '/generate');
  assert.equal(nav.activeNavHref('/metadata'), '/metadata');
  assert.equal(nav.activeNavHref('/live'), '/live');
  assert.equal(nav.activeNavHref('/history'), '/history');
  assert.equal(nav.activeNavHref('/credits'), '/credits');
  assert.equal(nav.activeNavHref('/projects'), null);
  assert.equal(nav.activeNavHref('/settings'), '/settings');
  assert.equal(nav.activeNavHref('/admin', { isAdmin: false }), null);
  assert.equal(nav.activeNavHref('/admin', { isAdmin: true }), '/admin');
  assert.equal(nav.activeNavHref('/admin/freebeat', { isAdmin: false }), null);
  assert.equal(nav.activeNavHref('/admin/freebeat', { isAdmin: true }), '/admin/freebeat');
  assert.equal(nav.activeNavHref('/unknown'), null);
});

test('no fake template items remain in navigation', () => {
  const titles = nav.navigation.flatMap((group) => group.items.map((item) => item.title.toLowerCase()));
  for (const forbidden of ['proyek', 'crm', 'e-commerce', 'kanban', 'calendar', 'accordion', 'utilities', 'components', 'layouts', 'documentation']) {
    assert.equal(titles.includes(forbidden), false, `Unexpected template or legacy item: ${forbidden}`);
  }
});
