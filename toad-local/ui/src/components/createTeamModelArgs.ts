interface ProviderLike {
  id: string;
  label: string;
  models: string[];
}

export function modelArgsForProvider(providerId: string, model: string): string[] {
  if (providerId !== 'opencode') return [];
  if (typeof model !== 'string' || model.length === 0 || model === 'Default') return [];
  return ['--model', model];
}

export function mergeDynamicProviderModels(
  providers: ProviderLike[],
  providerId: string,
  modelIds: string[],
): ProviderLike[] {
  const cleanIds = modelIds
    .filter((id) => typeof id === 'string' && id.length > 0)
    .filter((id, index, arr) => arr.indexOf(id) === index);
  if (cleanIds.length === 0) return providers;
  return providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    return { ...provider, models: ['Default', ...cleanIds] };
  });
}
