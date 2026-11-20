import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const ADMIN = '10000000-0000-4000-8000-000000000001';
const USER = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
const PACKAGE = '20000000-0000-4000-8000-000000000001';

async function login(db, id, admin = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: id, app_metadata: { role: admin ? 'admin' : 'user' } })]);
  await db.exec('set role authenticated');
}

async function reviewPrivileged(db, adminId, orderId, approve) {
  await db.exec('reset role');
  const res = await db.query('select * from admin_review_credit_order($1, $2, $3)', [orderId, approve, adminId]);
  return res.rows[0];
}

test('credit purchase permissions, snapshots and exactly-once manual approval', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${ADMIN}'), ('${USER}'), ('${OTHER}');
      create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.jwt(), auth.uid() to authenticated;
      create function public.is_admin() returns boolean language sql stable as $$ select coalesce((auth.jwt()->'app_metadata'->>'role') = 'admin', false) $$;
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20261118000003_create_credit_wallets.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261122000000_review_credit_order_password.sql', import.meta.url), 'utf8'));
    await login(db, ADMIN, true);
    await db.query('insert into credit_packages(id, name, credits, price_idr) values ($1, $2, $3, $4)', [PACKAGE, 'Starter', 100, 25000]);
    await db.query('insert into credit_payment_settings(instructions) values ($1)', ['Bank Contoh 123']);
    await db.query("insert into credit_model_prices (provider, model, modality, credits) values ('freebeat','model-a','video',20)");
    await assert.rejects(db.query('update credit_payment_settings set purchases_enabled = true'), /permission denied/i);
    await login(db, USER);
    await assert.rejects(db.query('select create_credit_order($1)', [PACKAGE]), /Pembelian kredit belum diaktifkan/);
    await assert.rejects(db.query("insert into credit_model_prices (provider,model,modality,credits) values ('freebeat','fake','video',1)"), /row-level security/i);
    await assert.rejects(db.query('insert into credit_wallets(user_id,balance) values ($1,999999)', [USER]), /permission denied/i);
    await assert.rejects(db.query('insert into credit_orders(user_id, package_name, credits, price_idr, payment_instructions) values ($1,$2,1,1,$3)', [USER, 'fake', 'fake']), /permission denied/i);
    // Jalur RPC lama ditutup: authenticated (walau admin) tidak bisa lagi memanggilnya.
    await assert.rejects(db.query('select review_credit_order($1,true)', [PACKAGE]), /permission denied|not allowed/i);
    // Fungsi privileged juga tidak bisa dipanggil authenticated secara langsung.
    await assert.rejects(db.query('select admin_review_credit_order($1, true, $2)', [PACKAGE, ADMIN]), /permission denied|not allowed/i);

    // Simulate a future server-side release enabling sales after consumption is implemented.
    await db.exec('reset role; update credit_payment_settings set purchases_enabled=true');
    await login(db, USER);
    const order = (await db.query('select * from create_credit_order($1)', [PACKAGE])).rows[0];
    assert.equal(order.credits, 100);
    assert.equal(order.price_idr, 25000);
    await assert.rejects(db.query('select create_credit_order($1)', [PACKAGE]), /pesanan aktif/i);
    await login(db, OTHER);
    assert.equal((await db.query('select * from credit_orders')).rows.length, 0);
    await assert.rejects(db.query('select submit_credit_payment($1,$2)', [order.id, 'stolen']), /tidak ditemukan/i);
    await login(db, ADMIN, true);
    await db.query('update credit_packages set credits=500, price_idr=1 where id=$1', [PACKAGE]);
    await assert.rejects(reviewPrivileged(db, ADMIN, order.id, true), /tidak menunggu pemeriksaan/i);
    await login(db, USER);
    await assert.rejects(db.query('select submit_credit_payment($1,$2)', [order.id, '  ']), /Isi nama pengirim/i);
    await db.query('select submit_credit_payment($1,$2)', [order.id, 'Transfer Alice']);
    await assert.rejects(db.query('select cancel_credit_order($1)', [order.id]), /tidak dapat dibatalkan/i);
    await login(db, ADMIN, true);
    await reviewPrivileged(db, ADMIN, order.id, true);
    await reviewPrivileged(db, ADMIN, order.id, true);
    await assert.rejects(reviewPrivileged(db, ADMIN, order.id, false), /tidak menunggu pemeriksaan/i);
    await login(db, USER);
    const wallet = (await db.query('select balance from credit_wallets')).rows[0];
    const ledger = (await db.query('select * from credit_ledger')).rows;
    assert.equal(Number(wallet.balance), 100);
    assert.equal(ledger.length, 1);
    assert.equal(Number(ledger[0].delta), 100);
    await assert.rejects(db.query('update credit_wallets set balance=100000'), /permission denied/i);
    await assert.rejects(db.query('update credit_ledger set delta=100000'), /permission denied/i);
    await login(db, OTHER);
    assert.equal((await db.query('select * from credit_wallets')).rows.length, 0);
    assert.equal((await db.query('select * from credit_ledger')).rows.length, 0);
    const second = (await db.query('select * from create_credit_order($1)', [PACKAGE])).rows[0];
    assert.equal(second.credits, 500);
    await db.query('select cancel_credit_order($1)', [second.id]);
    const third = (await db.query('select * from create_credit_order($1)', [PACKAGE])).rows[0];
    await db.query('select submit_credit_payment($1,$2)', [third.id, 'Bob']);
    await login(db, ADMIN, true);
    await reviewPrivileged(db, ADMIN, third.id, false);
    await reviewPrivileged(db, ADMIN, third.id, false);
    await login(db, OTHER);
    assert.equal((await db.query('select * from credit_wallets')).rows.length, 0);
    assert.equal((await db.query('select * from credit_ledger')).rows.length, 0);
  } finally { await db.close(); }
});
