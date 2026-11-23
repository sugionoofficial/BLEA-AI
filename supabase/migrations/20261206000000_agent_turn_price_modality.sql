-- Harga per giliran untuk /agent (Agen). Modalitas dipisah dari 'text' supaya
-- admin bisa menagih agen (yang memakai beberapa panggilan model + pencarian
-- web per giliran) tanpa mengubah harga chat biasa.
--
-- Tanpa baris harga di credit_model_prices untuk (provider, model,
-- 'agent_turn'), agen tetap gratis seperti /api/chat. Bila ada baris aktif,
-- worker menagih via spend_credits SEBELUM panggilan model pertama dan
-- mengembalikan dana lewat refund_credits jika giliran gagal atau tidak
-- menghasilkan jawaban.

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
      'agent_turn',
      'speech',
      'embedding',
      'other'
    )
  );
