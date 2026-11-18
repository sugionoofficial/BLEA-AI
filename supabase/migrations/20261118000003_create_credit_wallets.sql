-- Credit purchases are settled only after an administrator has checked the transfer.
-- All wallet changes happen inside database transactions; the browser cannot write balances.
create table public.credit_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  credits integer not null check (credits between 1 and 1000000000),
  price_idr integer not null check (price_idr between 1 and 2000000000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.credit_model_prices (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (char_length(btrim(provider)) between 1 and 80),
  model text not null check (char_length(btrim(model)) between 1 and 160),
  modality text not null check (modality in ('image', 'video')),
  credits integer not null check (credits between 1 and 1000000000),
  active boolean not null default true,
  unique (provider, model, modality)
);

create table public.credit_payment_settings (
  singleton boolean primary key default true check (singleton),
  instructions text not null check (char_length(btrim(instructions)) between 1 and 2000),
  purchases_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

create table public.credit_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.credit_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  package_id uuid references public.credit_packages(id) on delete set null,
  package_name text not null,
  credits integer not null check (credits > 0),
  price_idr integer not null check (price_idr > 0),
  payment_instructions text not null,
  payment_reference text check (payment_reference is null or char_length(payment_reference) <= 300),
  status text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'pending_review', 'approved', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null
);
create index credit_orders_user_created on public.credit_orders(user_id, created_at desc);
create index credit_orders_status_created on public.credit_orders(status, created_at desc);
-- Avoid ambiguous transfers and accidental repeat submissions for one user.
create unique index credit_orders_one_open_per_user on public.credit_orders(user_id)
  where status in ('awaiting_payment', 'pending_review');

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id uuid references public.credit_orders(id) on delete set null,
  delta bigint not null check (delta <> 0),
  description text not null,
  created_at timestamptz not null default now()
);
create unique index credit_ledger_order_unique on public.credit_ledger(order_id) where order_id is not null;
create index credit_ledger_user_created on public.credit_ledger(user_id, created_at desc);

alter table public.credit_packages enable row level security;
alter table public.credit_payment_settings enable row level security;
alter table public.credit_model_prices enable row level security;
alter table public.credit_wallets enable row level security;
alter table public.credit_orders enable row level security;
alter table public.credit_ledger enable row level security;
revoke all on public.credit_packages, public.credit_payment_settings, public.credit_model_prices, public.credit_wallets, public.credit_orders, public.credit_ledger from anon, authenticated;
grant select on public.credit_packages, public.credit_payment_settings, public.credit_model_prices, public.credit_wallets, public.credit_orders, public.credit_ledger to authenticated;
grant insert, update on public.credit_packages, public.credit_model_prices to authenticated;
-- Only a future server-side deployment may enable purchases.
grant insert (singleton, instructions, updated_at), update (instructions, updated_at) on public.credit_payment_settings to authenticated;

create policy credit_packages_read on public.credit_packages for select to authenticated using (active or public.is_admin());
create policy credit_packages_admin_insert on public.credit_packages for insert to authenticated with check (public.is_admin());
create policy credit_packages_admin_update on public.credit_packages for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy credit_model_prices_read on public.credit_model_prices for select to authenticated using (active or public.is_admin());
create policy credit_model_prices_admin_insert on public.credit_model_prices for insert to authenticated with check (public.is_admin());
create policy credit_model_prices_admin_update on public.credit_model_prices for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy credit_payment_read on public.credit_payment_settings for select to authenticated using (true);
create policy credit_payment_admin_insert on public.credit_payment_settings for insert to authenticated with check (public.is_admin());
create policy credit_payment_admin_update on public.credit_payment_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy credit_wallet_own on public.credit_wallets for select to authenticated using (user_id = auth.uid());
create policy credit_orders_read on public.credit_orders for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy credit_ledger_own on public.credit_ledger for select to authenticated using (user_id = auth.uid());

create function public.create_credit_order(p_package_id uuid)
returns public.credit_orders language plpgsql security definer set search_path = '' as $$
declare
  v_package public.credit_packages%rowtype;
  v_instructions text;
  v_order public.credit_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_package from public.credit_packages where id = p_package_id and active for share;
  if not found then raise exception 'Paket tidak tersedia'; end if;
  select instructions into v_instructions from public.credit_payment_settings where singleton = true and purchases_enabled = true;
  if v_instructions is null then raise exception 'Pembelian kredit belum diaktifkan'; end if;
  insert into public.credit_orders(user_id, package_id, package_name, credits, price_idr, payment_instructions)
    values (auth.uid(), v_package.id, v_package.name, v_package.credits, v_package.price_idr, v_instructions)
    returning * into v_order;
  return v_order;
exception when unique_violation then
  raise exception 'Anda masih memiliki pesanan aktif';
end;
$$;

create function public.submit_credit_payment(p_order_id uuid, p_reference text)
returns public.credit_orders language plpgsql security definer set search_path = '' as $$
declare v_order public.credit_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if char_length(btrim(coalesce(p_reference, ''))) not between 1 and 300 then
    raise exception 'Isi nama pengirim atau referensi transfer (maksimal 300 karakter)';
  end if;
  update public.credit_orders set status = 'pending_review', submitted_at = now(), payment_reference = btrim(p_reference)
    where id = p_order_id and user_id = auth.uid() and status = 'awaiting_payment'
    returning * into v_order;
  if not found then raise exception 'Pesanan tidak ditemukan atau tidak dapat dikonfirmasi'; end if;
  return v_order;
end;
$$;

create function public.cancel_credit_order(p_order_id uuid)
returns public.credit_orders language plpgsql security definer set search_path = '' as $$
declare v_order public.credit_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.credit_orders set status = 'cancelled'
    where id = p_order_id and user_id = auth.uid() and status = 'awaiting_payment'
    returning * into v_order;
  if not found then raise exception 'Pesanan tidak ditemukan atau tidak dapat dibatalkan'; end if;
  return v_order;
end;
$$;

create function public.review_credit_order(p_order_id uuid, p_approve boolean)
returns public.credit_orders language plpgsql security definer set search_path = '' as $$
declare v_order public.credit_orders%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'Administrator only'; end if;
  if p_approve is null then raise exception 'Keputusan tidak valid'; end if;
  select * into v_order from public.credit_orders where id = p_order_id for update;
  if not found then raise exception 'Pesanan tidak ditemukan'; end if;
  -- An identical retry is safe; a conflicting decision is rejected.
  if (p_approve and v_order.status = 'approved') or (not p_approve and v_order.status = 'rejected') then return v_order; end if;
  if v_order.status <> 'pending_review' then raise exception 'Pesanan tidak menunggu pemeriksaan'; end if;
  if p_approve then
    insert into public.credit_wallets (user_id, balance) values (v_order.user_id, v_order.credits)
      on conflict (user_id) do update set balance = public.credit_wallets.balance + excluded.balance, updated_at = now();
    insert into public.credit_ledger (user_id, order_id, delta, description)
      values (v_order.user_id, v_order.id, v_order.credits, 'Pembelian: ' || v_order.package_name);
  end if;
  update public.credit_orders set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_at = now(), reviewed_by = auth.uid() where id = v_order.id returning * into v_order;
  return v_order;
end;
$$;

revoke all on function public.create_credit_order(uuid), public.submit_credit_payment(uuid, text), public.cancel_credit_order(uuid), public.review_credit_order(uuid, boolean) from public, anon, authenticated;
grant execute on function public.create_credit_order(uuid), public.submit_credit_payment(uuid, text), public.cancel_credit_order(uuid), public.review_credit_order(uuid, boolean) to authenticated;
