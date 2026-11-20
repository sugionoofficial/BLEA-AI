const CANONICAL_PROVIDER_BADGES = {
  alibaba: 'Alibaba',
  freebeat: 'Freebeat',
  openai: 'OpenAI',
  google: 'Google',
  xai: 'xAI',
  doubao: 'Doubao',
  kling: 'Kling',
  hailuo: 'Hailuo',
  pekpik: 'PEKPIK',
  cloudflare: 'Cloudflare',
};

export function formatCredits(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value ?? '');
  const sign = num < 0 ? '-' : '';
  const digits = String(Math.trunc(Math.abs(num)));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

export function formatProviderBadge(provider, providerLabel) {
  const key = String(provider || '').trim().toLowerCase();
  if (CANONICAL_PROVIDER_BADGES[key]) return CANONICAL_PROVIDER_BADGES[key];
  return String(providerLabel || provider || '').trim();
}

export function formatModelDisplayName(name, provider, providerLabel) {
  let out = String(name || '').trim();
  if (!out) return '';
  const prefixes = [
    providerLabel,
    provider,
    'Alibaba Model Studio',
    'Alibaba Wan 3.0',
    'Alibaba',
    'Freebeat Dance',
    'Freebeat',
    'Google',
    'ByteDance',
    'Doubao',
    'xAI',
    'OpenAI',
    'Kling',
    'MiniMax',
    'Hailuo',
    'PEKPIK',
    'Cloudflare',
  ]
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (prefixes.length) {
    const colonRe = new RegExp(`^(?:${prefixes.join('|')})\\s*[:\\-–—]\\s*`, 'i');
    out = out.replace(colonRe, '').trim();
  }
  if (/^freebeat\s+/i.test(out)) {
    out = out.replace(/^freebeat\s+/i, '').trim();
  }
  if (/^alibaba\s+/i.test(out) && String(provider || '').trim().toLowerCase() === 'alibaba') {
    out = out.replace(/^alibaba\s+/i, '').trim();
  }
  if (/^model\s+\d+/i.test(out)) {
    out = out.replace(/^model\s+/i, 'Model ');
  }
  return out || String(name || '').trim();
}
