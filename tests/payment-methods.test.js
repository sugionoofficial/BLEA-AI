import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Metode pembayaran: RLS (pembeli hanya lihat yang aktif; hanya admin yang
// bisa menulis) dan snapshot instruksi di create_credit_order.
const ADMIN = '10000000-0000-4000-8000-000000000001';
const USER = '10000000-0000-4000-8000-000000000002';
const PACKAGE = '20000000-0000-4000-8000-000000000010';

async function login(db, id, admin = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: id, app_metadata: { role: admin ? 'admin' : 'user' } })]);
  await db.exec('set role authenticated');
}

test('metode pembayaran: RLS dan snapshot instruksi pesanan', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${ADMIN}'), ('${USER}');
      create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.jwt(), auth.uid() to authenticated;
      create function public.is_admin() returns boolean language sql stable as $$ select coalesce((auth.jwt()->'app_metadata'->>'role') = 'admin', false) $$;
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20261118000003_create_credit_wallets.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261121000000_create_credit_payment_methods.sql', import.meta.url), 'utf8'));
    await login(db, ADMIN, true);
    await db.query('insert into credit_packages(id, name, credits, price_idr) values ($1, $2, $3, $4)', [PACKAGE, 'HEMAT', 50000, 50000]);

    // Pembeli tidak bisa menulis metode pembayaran.
    await login(db, USER);
    await assert.rejects(db.query("insert into credit_payment_methods(kind, provider, account_number) values ('bank', 'BCA', '111')"), /policy|row-level|permission/i);

    // Admin menambahkan BCA, DANA, SeaBank dan USDT.
    await login(db, ADMIN, true);
    await db.query("insert into credit_payment_methods(kind, provider, account_name, account_number, sort_order) values ('bank', 'BCA', 'Budi Santoso', '1234567890', 1)");
    await db.query("insert into credit_payment_methods(kind, provider, account_name, account_number, sort_order) values ('ewallet', 'DANA', 'Budi Santoso', '081234567890', 2)");
    await db.query("insert into credit_payment_methods(kind, provider, account_name, account_number, sort_order) values ('bank', 'SeaBank', 'Budi Santoso', '9876543210', 3)");
    await db.query("insert into credit_payment_methods(kind, provider, account_number, network, sort_order) values ('crypto', 'USDT', 'TQmExampleAddressTRC20Fake1234567890', 'TRC20', 4)");
    // Metode nonaktif tidak boleh terlihat oleh pembeli.
    await db.query("insert into credit_payment_methods(kind, provider, account_number, active) values ('crypto', 'USDC', '0xhidden', false)");

    await login(db, USER);
    const visible = (await db.query('select provider from credit_payment_methods order by sort_order')).rows.map((r) => r.provider);
    assert.deepEqual(visible, ['BCA', 'DANA', 'SeaBank', 'USDT']);

    // Aktifkan pembelian (jalur privileged seperti operasi SQL admin).
    await db.exec("reset role; insert into credit_payment_settings(singleton, instructions, purchases_enabled) values (true, 'Transfer sesuai nominal lalu konfirmasi.', true)");

    await login(db, USER);
    const order = (await db.query('select * from create_credit_order($1)', [PACKAGE])).rows[0];
    const text = order.payment_instructions;
    assert.match(text, /Transfer sesuai nominal/);
    assert.match(text, /BCA · 1234567890 · a\.n\. Budi Santoso/);
    assert.match(text, /DANA · 081234567890 · a\.n\. Budi Santoso/);
    assert.match(text, /SeaBank · 9876543210 · a\.n\. Budi Santoso/);
    assert.match(text, /USDT \(TRC20\) · TQmExampleAddressTRC20Fake1234567890/);
    assert.doesNotMatch(text, /USDC/);
  } finally { await db.close(); }
});
