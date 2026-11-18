import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postcss from 'postcss';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dropx = postcss.parse(read('../src/dropx/dropx.css'));
const landing = postcss.parse(read('../src/styles.css'));
const tempmail = postcss.parse(read('../src/auth/tempmail.css'));

function declarations(css, selector) {
  const result = {};
  css.walkRules((rule) => {
    if (rule.selector === selector && rule.parent.type === 'root') {
      rule.walkDecls((decl) => { result[decl.prop] = decl.value; });
    }
  });
  return result;
}

function contrast(a, b) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((c) => parseInt(c, 16) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dark + 0.05);
}

test('landing styles do not override the shared DropX muted surface in either theme', () => {
  assert.equal(declarations(landing, ':root')['--muted'], undefined);
  assert.equal(declarations(dropx, ':root')['--muted'], '#f3f4f6');
  assert.equal(declarations(dropx, '.dark')['--muted'], '#1e293b');
});

test('TempMail code and badges use readable foreground and background theme tokens', () => {
  for (const selector of [
    '.tempmail-provider-pill,.tempmail-count',
    '.tempmail-gmail-copy code,.tempmail-gmail-setup code',
  ]) {
    const styles = declarations(tempmail, selector);
    assert.equal(styles.color, 'var(--foreground)');
    assert.equal(styles.background, 'var(--background)');
  }
  for (const theme of [':root', '.dark']) {
    const tokens = declarations(dropx, theme);
    assert.ok(contrast(tokens['--foreground'], tokens['--background']) >= 4.5, `${theme} text contrast`);
  }
});
