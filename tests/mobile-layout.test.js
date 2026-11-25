import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

async function rulesFor(path, selector) {
  const css = await readFile(new URL(path, import.meta.url), 'utf8');
  const dom = new JSDOM('<!doctype html><style></style>');
  dom.window.document.querySelector('style').textContent = css;
  const result = [];
  const visit = (rules, media = '') => {
    for (const rule of rules) {
      if (rule.selectorText?.split(',').some((s) => s.trim() === selector)) result.push({ media, style: rule.style });
      if (rule.cssRules?.length) visit(rule.cssRules, rule.conditionText || media);
    }
  };
  visit(dom.window.document.styleSheets[0].cssRules);
  return result;
}

test('header admin mobile tidak memakai flex basis 320px dan navigasi tetap terlihat', async () => {
  const title = await rulesFor('../src/auth/admin.css', '.admin-heading > div:first-child');
  const mobileTitle = title.find((r) => r.media === '(max-width: 640px)');
  assert.equal(mobileTitle.style.flex, '0 1 auto');
  const nav = await rulesFor('../src/auth/admin.css', '.admin-subnav');
  assert.equal(nav.find((r) => r.media === '(max-width: 640px)').style.gridTemplateColumns, 'repeat(2, minmax(0px, 1fr))');
  assert.ok(nav.every((r) => r.style.display !== 'none'));
});

test('form gambar dan musik mempunyai jarak yang konsisten tanpa margin ganda', async () => {
  for (const file of ['GenerateImagePanel.jsx', 'GenerateMusicPanel.jsx']) {
    const source = await readFile(new URL(`../src/auth/${file}`, import.meta.url), 'utf8');
    assert.match(source, /<form className="generate-form" onSubmit=\{submit\}>/);
    assert.doesNotMatch(source, /className="generate-(actions|toggle|field)" style=\{\{ marginTop:/);
  }
  const form = await rulesFor('../src/auth/generate.css', '.dropx-shell .generate-form');
  assert.equal(form[0].style.display, 'flex');
  assert.equal(form[0].style.gap, '12px');
});

test('tombol generate mobile ringkas, tetap dapat disentuh dan tidak memaksa lebar penuh', async () => {
  const tabs = await rulesFor('../src/auth/generate.css', '.dropx-shell .generate-mode-tabs button');
  assert.equal(tabs.filter((r) => r.media === '(max-width: 640px)').at(-1).style.minHeight, '44px');
  const actions = await rulesFor('../src/auth/generate.css', '.dropx-shell .generate-actions');
  assert.equal(actions.filter((r) => r.media === '(max-width: 640px)').at(-1).style.flexDirection, 'row');
  const buttons = await rulesFor('../src/auth/generate.css', '.dropx-shell .generate-actions button');
  assert.equal(buttons.find((r) => r.media === '(max-width: 640px)').style.minHeight, '44px');
});
