-- Riwayat kredit menjadi bisa diklik balik ke hasil generasi di History,
-- dan total pembelian/pemakaian/sisa dihitung di server (tidak terpengaruh
-- limit baris PostgREST).
--
-- 1. Kolom generation_id (nullable) pada credit_ledger: terisi untuk transaksi
--    pemakaian/refund generasi gambar; null untuk pembelian & penyesuaian admin.
-- 2. spend_credits / refund_credits versi baru menerima p_generation_id opsional.
--    Versi lama (3 argumen) dihapus; pemanggil lama tetap valid karena argumen
--    baru memiliki default.
-- 3. Fungsi credit_wallet_totals(): membaca total milik PEMANGGIL saja
--    (auth.uid()) — aman diberikan ke authenticated.

alter table public.credit_ledger add column if not exists generation_id uuid;
create index if not exists credit_ledger_generation on public.credit_ledger(generation_id) where generation_id is not null;

drop function if exists public.spend_credits(uuid, integer, text);
create or replace function public.spend_credits(p_user_id uuid, p_amount integer, p_description text, p_generation_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_balance bigint;
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    return false;
  end if;

  insert into public.credit_wallets (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.credit_wallets
  where user_id = p_user_id
  for update;

  if v_balance is null or v_balance < p_amount then
    return false;
  end if;

  update public.credit_wallets
  set balance = balance - p_amount, updated_at = now()
  where user_id = p_user_id;

  insert into public.credit_ledger (user_id, delta, description, generation_id)
  values (p_user_id, -p_amount,
          coalesce(nullif(btrim(p_description), ''), 'Generasi gambar'),
          p_generation_id);

  return true;
end;
$$;
revoke all on function public.spend_credits(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.spend_credits(uuid, integer, text, uuid) to service_role;

drop function if exists public.refund_credits(uuid, integer, text);
create or replace function public.refund_credits(p_user_id uuid, p_amount integer, p_description text, p_generation_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    return false;
  end if;

  insert into public.credit_wallets (user_id, balance)
  values (p_user_id, 0)
  on conflict (user_id) do nothing;

  update public.credit_wallets
  set balance = balance + p_amount, updated_at = now()
  where user_id = p_user_id;

  insert into public.credit_ledger (user_id, delta, description, generation_id)
  values (p_user_id, p_amount,
          coalesce(nullif(btrim(p_description), ''), 'Refund generasi gambar'),
          p_generation_id);

  return true;
end;
$$;
revoke all on function public.refund_credits(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.refund_credits(uuid, integer, text, uuid) to service_role;

-- Total pembelian (baris ledger yang lahir dari pesanan), total pemakaian
-- (seluruh delta negatif), dan sisa saldo — khusus milik pemanggil.
create or replace function public.credit_wallet_totals()
returns table(total_purchased bigint, total_spent bigint, balance bigint)
language sql stable security definer set search_path = '' as $$
  select
    coalesce(sum(case when delta > 0 and order_id is not null then delta else 0 end), 0)::bigint as total_purchased,
    coalesce(sum(case when delta < 0 then -delta else 0 end), 0)::bigint as total_spent,
    coalesce((select w.balance from public.credit_wallets w where w.user_id = auth.uid()), 0)::bigint as balance
  from public.credit_ledger
  where user_id = auth.uid();
$$;
revoke all on function public.credit_wallet_totals() from public, anon;
grant execute on function public.credit_wallet_totals() to authenticated;
