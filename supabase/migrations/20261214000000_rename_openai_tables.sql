-- Rename objek "chatgpt_*" menjadi "openai_*".
--
-- Kode dan label produk sudah memakai nama OpenAI, jadi nama tabel/kolom ikut
-- diselaraskan supaya tidak ada satu istilah lama yang tertinggal. Datanya
-- TIDAK disalin: rename di tempat, jadi id, token tersegel, dan riwayat tetap.
--
-- Idempoten: aman dijalankan pada database yang sebagian sudah berganti nama.

do $$
begin
  if to_regclass('public.chatgpt_accounts') is not null
     and to_regclass('public.openai_accounts') is null then
    alter table public.chatgpt_accounts rename to openai_accounts;
  end if;
  if to_regclass('public.chatgpt_oauth_links') is not null
     and to_regclass('public.openai_oauth_links') is null then
    alter table public.chatgpt_oauth_links rename to openai_oauth_links;
  end if;
  if to_regclass('public.chatgpt_signup_attempts') is not null
     and to_regclass('public.openai_signup_attempts') is null then
    alter table public.chatgpt_signup_attempts rename to openai_signup_attempts;
  end if;
end $$;

do $$
begin
  if to_regclass('public.studio_generations') is not null then
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'studio_generations' and column_name = 'chatgpt_account_id'
    ) then
      alter table public.studio_generations rename column chatgpt_account_id to openai_account_id;
    end if;
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'studio_generations' and column_name = 'chatgpt_account_label'
    ) then
      alter table public.studio_generations rename column chatgpt_account_label to openai_account_label;
    end if;
  end if;
end $$;

-- Nama index/constraint ikut tabel, tetapi rename hanya kosmetik: dipakai
-- supaya pesan error database tidak lagi menyebut istilah lama.
alter index if exists public.chatgpt_accounts_lookup_idx rename to openai_accounts_lookup_idx;
alter index if exists public.chatgpt_accounts_email_idx rename to openai_accounts_email_idx;
alter index if exists public.chatgpt_oauth_links_user_idx rename to openai_oauth_links_user_idx;
alter index if exists public.chatgpt_oauth_links_state_idx rename to openai_oauth_links_state_idx;
alter index if exists public.chatgpt_signup_attempts_user_created_idx rename to openai_signup_attempts_user_created_idx;
