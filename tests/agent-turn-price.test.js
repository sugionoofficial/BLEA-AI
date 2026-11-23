import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Harga giliran agen memakai modalitas baru 'agent_turn'. Tes ini menjalankan
// migrasi sungguhan: kalau constraint-nya tidak menerima 'agent_turn', atau
// kalau modalitas lama hilang, build gagal di sini — bukan di produksi.
async function bootstrap() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function public.is_admin() returns boolean language sql stable as $$ select false $$;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20261118000003_create_credit_wallets.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261131000000_expand_credit_model_prices_modality.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261206000000_agent_turn_price_modality.sql', import.meta.url), 'utf8'));
  return db;
}

test('agent_turn modality is accepted and every previous modality still works', async () => {
  const db = await bootstrap();
  try {
    for (const modality of ['image', 'image_edit', 'image_edit_2k', 'video', 'text', 'speech', 'embedding', 'other']) {
      await db.query(
        "insert into credit_model_prices (provider, model, modality, credits) values ('unorouter', $1, $2, 3)",
        [`model-${modality}`, modality],
      );
    }
    await db.query(
      "insert into credit_model_prices (provider, model, modality, credits) values ('unorouter','gpt-oss-120b:free','agent_turn',5)",
    );
    const row = (await db.query(
      "select credits from credit_model_prices where provider='unorouter' and model='gpt-oss-120b:free' and modality='agent_turn'",
    )).rows[0];
    assert.equal(row.credits, 5);

    await assert.rejects(
      db.query("insert into credit_model_prices (provider, model, modality, credits) values ('x','y','bogus',1)"),
      /credit_model_prices_modality_check/,
    );
    // Unik per (provider, model, modality): satu harga per giliran per model.
    await assert.rejects(
      db.query("insert into credit_model_prices (provider, model, modality, credits) values ('unorouter','gpt-oss-120b:free','agent_turn',9)"),
      /duplicate key|unique/i,
    );
  } finally {
    await db.close();
  }
});
