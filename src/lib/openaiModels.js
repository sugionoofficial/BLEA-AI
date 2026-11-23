// Model ChatGPT/OpenAI yang dipakai Studio.
//
// Studio sengaja TIDAK memakai katalog model provider yang terdaftar di Admin
// (unorouter/alibaba/cloudflare). Studio adalah ruang kerja ChatGPT: modelnya
// datang dari akun yang admin tambahkan di /studio/chatgpt-accounts, dan
// permintaannya lewat pool akun itu (prioritas, kuota harian, cooldown).
//
// Kenapa daftar ini statis: `/v1/models` milik OpenAI hanya mengembalikan model
// yang memang tersedia untuk kunci itu, dan daftarnya berbeda antar akun. Jadi
// daftar di bawah adalah pilihan yang wajar + setiap akun punya `model_default`
// sendiri. Admin bisa menimpanya lewat env `CHATGPT_STUDIO_MODELS`
// (dipisah koma), dan model yang tidak ada di daftar tetap bisa dipilih bila
// ditulis manual di form akun.
//
// Field `capabilities` mencocokkan kapabilitas tool Studio: model chat hanya
// untuk chat/agen, gpt-image-1 untuk gambar, sora-2 untuk video. Isolasi tool
// tetap berlaku di Worker, jadi model gambar tidak pernah dipanggil dari ruang
// chat.

export const STUDIO_CHATGPT_MODELS = [
  // ---- Chat & agen (teks) ----
  { id: 'gpt-5.1', label: 'GPT-5.1', capabilities: ['chat', 'agent'], note: 'Flagship untuk penalaran panjang & agen.' },
  { id: 'gpt-5', label: 'GPT-5', capabilities: ['chat', 'agent'], note: 'Penalaran kuat, lebih murah dari 5.1.' },
  { id: 'gpt-5-mini', label: 'GPT-5 mini', capabilities: ['chat', 'agent'], note: 'Cepat & hemat untuk tugas harian.' },
  { id: 'gpt-5-nano', label: 'GPT-5 nano', capabilities: ['chat'], note: 'Paling murah untuk klasifikasi/ringkasan pendek.' },
  { id: 'gpt-4.1', label: 'GPT-4.1', capabilities: ['chat', 'agent'], note: 'Konteks besar, bagus untuk analisis berkas panjang.' },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', capabilities: ['chat', 'agent'], note: 'Seimbang untuk menulis & menjawab.' },
  { id: 'gpt-4o', label: 'GPT-4o', capabilities: ['chat', 'agent'], note: 'Multimodal (teks + gambar).' },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', capabilities: ['chat', 'agent'], note: 'Default hemat; cocok untuk agen bertahap.' },
  { id: 'o4-mini', label: 'o4-mini', capabilities: ['chat'], note: 'Penalaran bertahap murah.' },
  { id: 'o3', label: 'o3', capabilities: ['chat'], note: 'Penalaran mendalam untuk soal sulit.' },
  // ---- Gambar ----
  { id: 'gpt-image-1', label: 'GPT Image 1', capabilities: ['image'], note: 'Text-to-image & edit gambar.' },
  // ---- Video ----
  { id: 'sora-2', label: 'Sora 2', capabilities: ['video'], note: 'Text/image-to-video.' },
  { id: 'sora-2-pro', label: 'Sora 2 Pro', capabilities: ['video'], note: 'Video lebih lama & stabil.' },
  // ---- Audio ----
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe', capabilities: ['audio'], note: 'Speech-to-text.' },
  { id: 'tts-1', label: 'TTS-1', capabilities: ['audio'], note: 'Text-to-speech cepat.' },
];

/** Daftar model untuk satu kapabilitas tool Studio (chat/agent/image/...). */
export function studioModelsForCapability(capability, env) {
  const override = String(env?.CHATGPT_STUDIO_MODELS || '').trim();
  const list = override
    ? override.split(',').map((id) => id.trim()).filter(Boolean).map((id) => ({ id, label: id, capabilities: ['chat', 'agent'], note: '' }))
    : STUDIO_CHATGPT_MODELS;
  return list.filter((model) => model.capabilities.includes(String(capability || 'chat')));
}

/** Bentuk yang dipakai UI: { id, provider, label, capability }. */
export function studioModelItems(capabilities, env) {
  const wanted = Array.isArray(capabilities) ? capabilities : ['chat'];
  const seen = new Set();
  const items = [];
  for (const capability of wanted) {
    for (const model of studioModelsForCapability(capability, env)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      items.push({ id: model.id, provider: 'openai', label: model.label || model.id, capability, note: model.note || '' });
    }
  }
  return items;
}

export function isStudioChatGptModel(id) {
  return STUDIO_CHATGPT_MODELS.some((model) => model.id === String(id || '').trim());
}
