create table if not exists public.tempmail_user_aliases (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  token text not null,
  provider text not null default 'mailtm',
  created_at timestamptz not null default now()
);

alter table public.tempmail_user_aliases enable row level security;
revoke all on public.tempmail_user_aliases from public, anon, authenticated;
grant all on public.tempmail_user_aliases to service_role;

select pg_notify('pgrst', 'reload schema');
