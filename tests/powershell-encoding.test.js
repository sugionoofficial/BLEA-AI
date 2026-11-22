import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// PowerShell 5.1 (default di Windows 10/11) membaca berkas tanpa BOM memakai
// codepage sistem, bukan UTF-8. Akibatnya satu karakter non-ASCII -- misalnya
// tanda pisah panjang "--" atau tanda kutip 'pintar' -- berubah menjadi byte
// yang dianggap PowerShell sebagai pembuka/penutup string, dan seluruh skrip
// gagal di-parse dengan pesan yang menyesatkan ("Missing closing '}'").
//
// Ini pernah terjadi pada tools/ollama-tunnel-quick.ps1. Supaya tidak terulang,
// semua berkas .ps1 di repo wajib ASCII murni dan disimpan dengan BOM.

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function collectPowerShellFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectPowerShellFiles(full, out);
    } else if (entry.toLowerCase().endsWith('.ps1')) {
      out.push(full);
    }
  }
  return out;
}

const files = collectPowerShellFiles(repoRoot);

test('repo berisi minimal satu skrip PowerShell', () => {
  assert.ok(files.length > 0, 'tidak ada berkas .ps1 yang ditemukan');
});

for (const file of files) {
  const name = relative(repoRoot, file).replaceAll('\\', '/');

  test(`${name} hanya berisi ASCII`, () => {
    const bytes = readFileSync(file);
    const start = bytes.subarray(0, 3).equals(BOM) ? 3 : 0;
    const offenders = [];
    let line = 1;
    for (let i = start; i < bytes.length; i += 1) {
      const b = bytes[i];
      if (b === 0x0a) line += 1;
      if (b > 0x7f) offenders.push(`line ${line}: byte 0x${b.toString(16)}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `${name} memuat karakter non-ASCII; ganti dengan padanan ASCII (mis. "--" bukan em dash).`,
    );
  });

  test(`${name} disimpan dengan BOM UTF-8`, () => {
    const head = readFileSync(file).subarray(0, 3);
    assert.ok(
      head.equals(BOM),
      `${name} tidak diawali BOM; PowerShell 5.1 akan membacanya sebagai codepage Windows.`,
    );
  });
}
