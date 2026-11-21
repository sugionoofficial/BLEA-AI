-- Allow admins to configure per-model credit prices for every category in
-- Katalog Model (Text, Image, Video, Speech, Embedding, Other) in addition to
-- existing image edit variants.

alter table public.credit_model_prices
  drop constraint if exists credit_model_prices_modality_check;

alter table public.credit_model_prices
  add constraint credit_model_prices_modality_check
  check (
    modality in (
      'image',
      'image_edit',
      'image_edit_2k',
      'video',
      'text',
      'speech',
      'embedding',
      'other'
    )
  );
