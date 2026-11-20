-- Track BLEA credit charges & refunds on video generations and allow admins to
-- delete entries from credit_model_prices when cleaning up custom models.

alter table public.video_generations
  add column if not exists credits_charged integer not null default 0 check (credits_charged >= 0),
  add column if not exists credits_refunded integer not null default 0 check (credits_refunded >= 0);

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'credit_model_prices' and policyname = 'credit_model_prices_admin_delete'
  ) then
    create policy credit_model_prices_admin_delete
      on public.credit_model_prices for delete
      to authenticated using (public.is_admin());
  end if;
end $$;
