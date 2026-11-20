import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const USER = '10000000-0000-4000-8000-0000000000u1'.replace('u', 'a');
const GEN_ID = '30000000-0000-4000-8000-000000000077';
const ORDER_ID = '30000000-0000-4000-8000-000000000078';

async function claims(db, sub, admin = false) {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub, app_metadata: { role: admin ? 'admin' : 'user' } })]);
  await db.exec('set role authenticated');
}

test('credit_ledger generation link + wallet totals', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create table auth.users(id uuid primary key);
      insert into auth.users values ('${USER}');
      create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
      grant usage on schema auth to authenticated;
      grant execute on function auth.jwt(), auth.uid() to authenticated;
      create function public.is_admin() returns boolean language sql stable as $$ select coalesce((auth.jwt()->'app_metadata'->>'role') = 'admin', false) $$;
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20261118000003_create_credit_wallets.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261122000000_review_credit_order_password.sql', import.meta.url), 'utf8'));
    await db.exec(await readFile(new URL('../supabase/migrations/20261123000000_credit_ledger_generation_link.sql', import.meta.url), 'utf8'));

    // Saldo awal 1.000 kredit (jalur privileged; di produksi lewat admin adjust).
    await db.exec('reset role');
    await db.query('insert into public.credit_wallets (user_id, balance) values ($1, 1000)', [USER]);

    // Simulasikan pembelian: baris ledger dengan order_id terisi.
    await db.exec('reset role');
    await db.query("insert into public.credit_orders (id, user_id, package_name, credits, price_idr, payment_instructions, status) values ($1, $2, 'PRO', 500, 500000, 'x', 'approved')", [ORDER_ID, USER]);
    await db.query("insert into public.credit_ledger (user_id, order_id, delta, description) values ($1, $2, 500, 'Pembelian: PRO')", [USER, ORDER_ID]);
    await db.query('update public.credit_wallets set balance = balance + 500 where user_id = $1', [USER]);

    // Service role: spend dengan generation_id.
    await db.exec('set role service_role');
    const spent = (await db.query("select public.spend_credits($1, 15, 'Generasi gambar Freebeat model 122', $2) as ok", [USER, GEN_ID])).rows[0];
    assert.equal(spent.ok, true);
    await db.exec('reset role');
    const spentRow = (await db.query("select delta, description, generation_id from public.credit_ledger where generation_id = $1 and delta < 0", [GEN_ID])).rows[0];
    assert.equal(spentRow.delta, -15);
    assert.equal(spentRow.generation_id, GEN_ID);
    await db.exec('set role service_role');

    // Refund mengembalikan saldo dan ikut tercatat dengan generation_id.
    const refunded = (await db.query("select public.refund_credits($1, 15, 'Refund: generasi gambar gagal', $2) as ok", [USER, GEN_ID])).rows[0];
    assert.equal(refunded.ok, true);

    // Pemakaian berlebih ditolak tanpa menulis ledger.
    const notSpent = (await db.query("select public.spend_credits($1, 999999, 'Terlalu mahal', null) as ok", [USER])).rows[0];
    assert.equal(notSpent.ok, false);

    // Authenticated tidak boleh memanggil fungsi privileged.
    await claims(db, USER);
    await assert.rejects(db.query("select public.spend_credits($1, 1, 'x', null)", [USER]), /permission denied|not allowed/i);

    // Totals
    const totals = (await db.query('select * from public.credit_wallet_totals()')).rows[0];
    assert.equal(Number(totals.total_purchased), 500);
    assert.equal(Number(totals.total_spent), 15);
    assert.equal(Number(totals.balance), 1500);
  } finally {
    await db.close();
  }
});
