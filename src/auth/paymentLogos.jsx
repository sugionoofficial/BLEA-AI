// Logo metode pembayaran sebagai badge SVG inline (tanpa aset eksternal).
// Provider dikenal: BCA, DANA, SeaBank, USDT, USDC — lainnya dapat badge generik
// berisi kapital provider. Warna mengikuti identitas merek (perkiraan).

const KNOWN = {
  bca: { bg: '#0057A8', fg: '#ffffff', text: 'BCA', weight: 800, size: 15, style: 'italic' },
  dana: { bg: '#108EE9', fg: '#ffffff', text: 'DANA', weight: 800, size: 13 },
  seabank: { bg: '#F5503A', fg: '#ffffff', text: 'SeaBank', weight: 800, size: 12.5 },
  superbank: { bg: '#FF5722', fg: '#ffffff', text: 'SUPERBANK', weight: 800, size: 9 },
  gopay: { bg: '#00AA13', fg: '#ffffff', text: 'gopay', weight: 800, size: 14 },
  ovo: { bg: '#4C2A86', fg: '#ffffff', text: 'OVO', weight: 800, size: 15 },
  shopeepay: { bg: '#EE4D2D', fg: '#ffffff', text: 'ShopeePay', weight: 700, size: 12 },
  linkaja: { bg: '#E31E24', fg: '#ffffff', text: 'LinkAja', weight: 800, size: 12.5 },
  usdt: { bg: '#26A17B', fg: '#ffffff', text: 'T', weight: 800, size: 22, circle: true },
  usdc: { bg: '#2775CA', fg: '#ffffff', text: '$', weight: 800, size: 22, circle: true },
  btc: { bg: '#F7931A', fg: '#ffffff', text: '₿', weight: 800, size: 22, circle: true },
  eth: { bg: '#627EEA', fg: '#ffffff', text: 'Ξ', weight: 800, size: 22, circle: true },
};

export function PaymentLogo({ provider = '', kind = 'bank', size = 46 }) {
  const key = String(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = KNOWN[key];
  const isCrypto = kind === 'crypto';
  if (known) {
    const rx = known.circle ? size / 2 : Math.round(size * 0.22);
    const fontSize = known.size * (size / 46);
    return (
      <svg width={size} height={size} viewBox="0 0 46 46" role="img" aria-label={provider} className="payment-logo">
        <rect width="46" height="46" rx={known.circle ? 23 : 10} fill={known.bg} />
        <text x="23" y="30" textAnchor="middle" fontFamily="'DM Sans','Manrope',system-ui,sans-serif" fontWeight={known.weight} fontStyle={known.style || 'normal'} fontSize={fontSize} fill={known.fg}>{known.text}</text>
      </svg>
    );
  }
  const initials = String(provider || '?').trim().split(/\s+/).slice(0, 2).map((part) => part[0] || '').join('').toUpperCase() || '?';
  return (
    <svg width={size} height={size} viewBox="0 0 46 46" role="img" aria-label={provider || 'Metode pembayaran'} className="payment-logo">
      <rect width="46" height="46" rx={isCrypto ? 23 : 10} fill={isCrypto ? '#334155' : '#475569'} />
      <text x="23" y="29" textAnchor="middle" fontFamily="'DM Sans','Manrope',system-ui,sans-serif" fontWeight={800} fontSize={isCrypto ? 17 : 15} fill="#ffffff">{initials}</text>
    </svg>
  );
}
