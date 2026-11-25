import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseTaskCommands } from '../browser-agent-extension/commands.js';

test('Google search and safe URL commands parse', () => {
  assert.deepEqual(parseCommand('cari cuaca Depok di Google'), { type: 'search', query: 'cuaca Depok' });
  assert.deepEqual(parseCommand('buka https://example.com/a'), { type: 'open', url: 'https://example.com/a' });
  assert.ok(parseCommand('buka javascript:alert(1)').error);
});

test('read, click, and fill commands are explicit', () => {
  assert.deepEqual(parseCommand('baca halaman'), { type: 'read' });
  assert.deepEqual(parseCommand('salin teks "draft"'), { type: 'copy', value: 'draft' });
  assert.deepEqual(parseCommand('tempel ke kolom "Pesan"'), { type: 'paste', label: 'Pesan' });
  assert.deepEqual(parseCommand('klik tombol "Masuk"'), { type: 'click', label: 'Masuk' });
  assert.deepEqual(parseCommand('klik tombol "Kirim"'), { type: 'click', label: 'Kirim' });
  assert.deepEqual(parseCommand('isi kolom "Email" dengan "a@example.com"'), { type: 'fill', label: 'Email', value: 'a@example.com' });
});

test('task parser only enables automatic mode with the explicit first-line opt-in', () => {
  assert.deepEqual(parseTaskCommands('cari cuaca di Google\nbaca halaman'), {
    auto: false,
    actions: [{ type: 'search', query: 'cuaca' }, { type: 'read' }],
  });
  assert.deepEqual(parseTaskCommands('lakukan tanpa konfirmasi\ncari cuaca di Google'), {
    auto: true,
    actions: [{ type: 'search', query: 'cuaca' }],
  });
  assert.ok(parseTaskCommands('lakukan tanpa konfirmasi').error);
});

test('unrecognized and high-impact button actions are rejected', () => {
  assert.ok(parseCommand('lakukan semua yang perlu').error);
  assert.match(parseCommand('klik tombol "Checkout sekarang"').error, /diblokir/);
  assert.match(parseCommand('klik tombol "Hapus akun"').error, /diblokir/);
});
