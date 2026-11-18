// The Generate page displays only explicitly enabled and configured provider
// models. Historical records are still available separately in History.
export function availableVideoModels(models) {
  if (!Array.isArray(models)) return [];
  return models.filter((model) => {
    const provider = typeof model?.provider === 'string' ? model.provider.trim().toLowerCase() : '';
    return provider && provider !== 'unorouter' && typeof model.id === 'string' && model.id.trim() && model.activeInAdmin === true && model.providerConfigured === true;
  });
}
export function generationModelKey(model) {
  return `${model?.provider || ''}::${model?.id || ''}`;
}
