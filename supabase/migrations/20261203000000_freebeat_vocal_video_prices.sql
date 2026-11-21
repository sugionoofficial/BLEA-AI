-- Seed active BLEA credit prices for consumer Freebeat Singing & Lip-Sync Video (/generate).
insert into public.credit_model_prices (provider, model, modality, credits, active)
values
  ('freebeat', 'generate_singing_video', 'video', 3000, true),
  ('freebeat', 'generate_lip_sync_video', 'video', 3000, true)
on conflict (provider, model, modality) do update
  set credits = excluded.credits, active = true;
