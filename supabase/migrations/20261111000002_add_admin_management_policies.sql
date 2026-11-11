create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

grant execute on function public.is_admin() to authenticated;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (full_name) on table public.profiles to authenticated;

create policy profiles_select_self
  on public.profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_update_self
  on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_select
  on public.profiles for select to authenticated
  using (public.is_admin());
create policy profiles_admin_update
  on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

create or replace function public.sync_auth_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, created_at, updated_at)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name,
        updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_auth_user_sync_profile on auth.users;
create trigger on_auth_user_sync_profile
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.sync_auth_profile();

insert into public.profiles (id, email, full_name, created_at)
select id, email, coalesce(raw_user_meta_data ->> 'full_name', ''), created_at
from auth.users
on conflict (id) do update
  set email = excluded.email,
      full_name = excluded.full_name;

create policy projects_admin_all
  on public.projects for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

revoke all on table public.waitlist_signups from anon, authenticated;
grant insert on table public.waitlist_signups to anon;
grant select, delete on table public.waitlist_signups to authenticated;

create policy waitlist_admin_select
  on public.waitlist_signups for select to authenticated
  using (public.is_admin());
create policy waitlist_admin_delete
  on public.waitlist_signups for delete to authenticated
  using (public.is_admin());
