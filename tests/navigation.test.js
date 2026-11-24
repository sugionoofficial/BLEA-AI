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
      { title: 'Studio', href: '/studio' },
      { title: 'Hasil', href: '/studio/library' },
      { title: 'Generate', href: '/generate' },
      { title: 'Cek Metadata', href: '/studio/metadata' },
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
      { title: 'Studio', href: '/studio' },
      { title: 'Hasil', href: '/studio/library' },
      { title: 'Generate', href: '/generate' },
      { title: 'Cek Metadata', href: '/studio/metadata' },
      { title: 'Proses Live', href: '/live' },
      { title: 'Kredit', href: '/credits' },
      { title: 'History', href: '/history' },
      { title: 'Admin Panel', href: '/admin' },
      { title: 'Freebeat MCP', href: '/admin/freebeat' },
      { title: 'Akun OpenAI', href: '/studio/openai-accounts' },
      { title: 'TempMail', href: '/tempmail' },
      { title: 'Setting', href: '/settings' },
    ],
  );

  // Every route in navigation must exist in src/main.jsx
  for (const item of adminItems) {
    assert.ok(
      // Rute dinamis seperti /studio/:toolId juga dianggap ada.
      mainSource.includes(`path="${item.href}"`) || mainSource.includes('path="/studio/:toolId"'),
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
  assert.equal(nav.activeNavHref('/studio/metadata'), '/studio/metadata');
  // Sub-rute Studio tetap menyorot entri Studio di sidebar.
  assert.equal(nav.activeNavHref('/studio/chat'), '/studio');
  assert.equal(nav.activeNavHref('/studio/image'), '/studio');
  assert.equal(nav.activeNavHref('/agent'), null, '/agent hanya redirect');
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

test('setiap komponen yang dipakai di <Route> dideklarasikan di main.jsx', () => {
  // Regresi: commit Studio memakai <StudioPage/> di rute tanpa mendeklarasikan
  // komponennya. Build tetap "sukses", tetapi bundle memuat identifier mentah
  // sehingga SELURUH app melempar ReferenceError dan halaman jadi kosong/hitam.
  const declared = new Set();
  for (const match of mainSource.matchAll(/^const\s+(\w+)\s*=\s*lazy\(/gm)) declared.add(match[1]);
  for (const match of mainSource.matchAll(/^import\s+\{([^}]+)\}\s+from/gm)) {
    for (const name of match[1].split(',')) declared.add(name.trim());
  }

  const elementTags = new Set();
  for (const match of mainSource.matchAll(/<([A-Z]\w+)\s*\/>/g)) elementTags.add(match[1]);

  // `App` dideklarasikan sebagai function di file yang sama, bukan import/lazy.
  declared.add('App');
  const missing = [...elementTags].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `komponen dipakai di rute tapi tidak dideklarasikan: ${missing.join(', ')}`);
});
