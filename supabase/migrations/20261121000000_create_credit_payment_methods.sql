-- Metode pembayaran yang tampil di halaman Kredit (BCA, DANA, SeaBank, kripto USD, dst.).
-- Admin mengelola lewat /credits (Admin · Metode pembayaran). Pembeli hanya
-- bisa membaca metode yang aktif; snapshot teks instruksi disisipkan ke
-- credit_orders.payment_instructions saat pesanan dibuat.
create table public.credit_payment_methods (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('bank', 'ewallet', 'crypto')),
  provider text not null check (char_length(btrim(provider)) between 1 and 60),
  label text not null default '' check (char_length(label) <= 80),
  account_name text not null default '' check (char_length(account_name) <= 120),
  account_number text not null default '' check (char_length(account_number) <= 200),
  network text not null default '' check (char_length(network) <= 40),
  note text not null default '' check (char_length(note) <= 300),
  sort_order integer not null default 0 check (sort_order between -10000 and 10000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index credit_payment_methods_active_sort on public.credit_payment_methods (active, sort_order, provider);

alter table public.credit_payment_methods enable row level security;
revoke all on public.credit_payment_methods from anon, authenticated;
grant select on public.credit_payment_methods to authenticated;
grant insert, update, delete on public.credit_payment_methods to authenticated;
create policy credit_payment_methods_read on public.credit_payment_methods for select to authenticated using (active or public.is_admin());
create policy credit_payment_methods_admin_insert on public.credit_payment_methods for insert to authenticated with check (public.is_admin());
create policy credit_payment_methods_admin_update on public.credit_payment_methods for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy credit_payment_methods_admin_delete on public.credit_payment_methods for delete to authenticated using (public.is_admin());

-- Snapshot instruksi pembayaran kini memuat daftar metode aktif, supaya yang
-- tampil di pesanan selalu sesuai kondisi saat pesanan dibuat.
create or replace function public.create_credit_order(p_package_id uuid)
returns public.credit_orders language plpgsql security definer set search_path = '' as $$
declare
  v_package public.credit_packages%rowtype;
  v_instructions text;
  v_methods text;
  v_order public.credit_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_package from public.credit_packages where id = p_package_id and active for share;
  if not found then raise exception 'Paket tidak tersedia'; end if;
  select instructions into v_instructions from public.credit_payment_settings where singleton = true and purchases_enabled = true;
  if v_instructions is null then raise exception 'Pembelian kredit belum diaktifkan'; end if;
  select string_agg(line, E'\n' order by ord, provider) into v_methods from (
    select
      sort_order as ord,
      provider,
      case
        when kind = 'crypto' then concat_ws(' · ', provider || coalesce(' (' || nullif(btrim(network), '') || ')', ''), nullif(btrim(account_number), ''), nullif(btrim(note), ''))
        else concat_ws(' · ', provider, nullif(btrim(account_number), ''), nullif('a.n. ' || nullif(btrim(account_name), ''), 'a.n. '), nullif(btrim(note), ''))
      end as line
    from public.credit_payment_methods
    where active
  ) lines;
  if v_methods is not null and char_length(btrim(v_methods)) > 0 then
    v_instructions := v_instructions || E'\n\n' || v_methods;
  end if;
  insert into public.credit_orders(user_id, package_id, package_name, credits, price_idr, payment_instructions)
    values (auth.uid(), v_package.id, v_package.name, v_package.credits, v_package.price_idr, v_instructions)
    returning * into v_order;
  return v_order;
exception when unique_violation then
  raise exception 'Anda masih memiliki pesanan aktif';
end;
$$;
revoke all on function public.create_credit_order(uuid) from public, anon, authenticated;
grant execute on function public.create_credit_order(uuid) to authenticated;
