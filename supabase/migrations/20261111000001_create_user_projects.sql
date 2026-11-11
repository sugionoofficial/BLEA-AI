create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_updated_idx
  on public.projects (user_id, updated_at desc);

alter table public.projects enable row level security;
revoke all on table public.projects from anon, authenticated;
grant select, insert, update, delete on table public.projects to authenticated;

create policy projects_select_own
  on public.projects for select to authenticated
  using (auth.uid() = user_id);

create policy projects_insert_own
  on public.projects for insert to authenticated
  with check (auth.uid() = user_id);

create policy projects_update_own
  on public.projects for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy projects_delete_own
  on public.projects for delete to authenticated
  using (auth.uid() = user_id);

create or replace function public.set_projects_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_projects_updated_at();
