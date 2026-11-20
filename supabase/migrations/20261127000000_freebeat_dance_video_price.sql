-- Seed active BLEA credit price for consumer Freebeat Dance Video (/generate).
insert into public.credit_model_prices (provider, model, modality, credits, active)
values ('freebeat', 'generate_dance_video', 'video', 3000, true)
on conflict (provider, model, modality) do update
  set credits = excluded.credits, active = true;
