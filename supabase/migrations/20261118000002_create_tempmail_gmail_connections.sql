create table if not exists public.tempmail_gmail_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tempmail_gmail_connections enable row level security;
revoke all on public.tempmail_gmail_connections from public, anon, authenticated;
grant all on public.tempmail_gmail_connections to service_role;

comment on table public.tempmail_gmail_connections is
  'OAuth Gmail credentials for TempMail; service_role only, ciphertext AES-256-GCM.';

select pg_notify('pgrst', 'reload schema');
