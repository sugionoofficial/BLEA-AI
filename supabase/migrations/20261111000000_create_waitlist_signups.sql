create table if not exists public.waitlist_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now(),
  constraint waitlist_signups_email_format check (
    email = lower(btrim(email))
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  )
);

create unique index if not exists waitlist_signups_email_lower_unique
  on public.waitlist_signups (lower(email));

alter table public.waitlist_signups enable row level security;
revoke all on table public.waitlist_signups from anon, authenticated;
grant insert on table public.waitlist_signups to anon;

create policy waitlist_signups_anon_insert
  on public.waitlist_signups
  for insert
  to anon
  with check (
    email = lower(btrim(email))
    and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  );
