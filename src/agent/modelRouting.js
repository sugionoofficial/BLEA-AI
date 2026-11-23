// Resolve a model/provider pair to a usable upstream before asking the Worker.
//
// The page lets the user pick any enabled chat model, but `/api/agent` must
// never run tools on a model it cannot reach: if no model is given we pick the
// highest-ranked one from the same ordering the rest of the app uses
// (`/api/enabled-models`), and if that whole list is unusable we refuse rather
// than silently calling a different provider.
export function resolveAgentModel(enabledModels, requestedModel = '') {
  const list = Array.isArray(enabledModels) ? enabledModels.filter((item) => item?.id) : [];
  const requested = String(requestedModel || '').trim();
  if (requested) {
    const found = list.find((item) => item.id === requested);
    if (found) return { model: found.id, provider: found.provider || 'unorouter', resolved: true };
    // An explicit request that is no longer enabled is a real error state, not
    // a reason to fall back silently.
    return { model: requested, provider: '', resolved: false };
  }
  const first = list[0];
  if (!first) return { model: '', provider: '', resolved: false };
  return { model: first.id, provider: first.provider || 'unorouter', resolved: true };
}

/**
 * Ruang Studio memakai model ChatGPT saja. Dipakai UI sebelum mengirim giliran
 * agen: model dari katalog provider lain tidak boleh lolos ke ruang Studio,
 * meski pengguna memaksa lewat state/URL.
 */
export function assertStudioModel(item, { studioMode = false } = {}) {
  const model = String(item?.model || '').trim();
  const provider = String(item?.provider || '').trim().toLowerCase();
  if (!studioMode) return null;
  if (!model) return { code: 'model_missing', message: 'Pilih model ChatGPT terlebih dulu.' };
  if (provider && provider !== 'openai') {
    return {
      code: 'studio_provider_mismatch',
      message: `Studio hanya memakai model ChatGPT (openai), bukan "${provider}".`,
    };
  }
  return null;
}

export function modelLabel(item) {
  if (!item?.id) return '';
  return item.provider && item.provider !== 'unorouter' ? `${item.id} · ${item.provider}` : item.id;
}
