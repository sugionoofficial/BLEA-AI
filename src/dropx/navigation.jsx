import {
  Activity,
  Clapperboard,
  Coins,
  FileSearch2,
  FolderDown,
  KeyRound,
  LayoutDashboard,
  History,
  Mail,
  Plug,
  Settings,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

export const navigation = [
  {
    label: 'Workspace',
    items: [
      {
        title: 'Dashboard',
        href: '/app',
        icon: LayoutDashboard,
        description: 'Ringkasan aktivitas & statistik',
        keywords: ['dashboard', 'ringkasan', 'beranda', 'utama', 'statistik'],
      },
      {
        title: 'Studio',
        href: '/studio',
        icon: Sparkles,
        description: 'Semua alat BLEA: teks, gambar, video, audio, utilitas',
        keywords: ['studio', 'alat', 'tool', 'chat', 'gambar', 'image', 'video', 'musik', 'subtitle', 'riset', 'metadata'],
      },
      {
        title: 'Hasil',
        href: '/studio/library',
        icon: FolderDown,
        description: 'Hasil dari semua tool: salin atau unduh',
        keywords: ['hasil', 'library', 'unduh', 'download', 'arsip', 'gambar', 'video', 'musik'],
      },
      {
        title: 'Generate',
        href: '/generate',
        icon: Clapperboard,
        description: 'Generate gambar dan video AI',
        keywords: ['generate', 'gambar', 'image', 'video', 'animasi', 'klip', 'render', 'veo', 'sora'],
      },
      {
        title: 'Cek Metadata',
        href: '/studio/metadata',
        icon: FileSearch2,
        description: 'Pindai & bersihkan metadata buatan AI dari gambar/video',
        keywords: ['metadata', 'ai', 'exif', 'xmp', 'c2pa', 'clean', 'hapus', 'scan', 'gambar', 'video'],
      },
      {
        title: 'Proses Live',
        href: '/live',
        icon: Activity,
        description: 'Pantau proses generate aktif secara langsung',
        keywords: ['live', 'proses', 'antrean', 'queue', 'berjalan', 'runtime', 'cancel'],
      },
      {
        title: 'Kredit',
        href: '/credits',
        icon: Coins,
        description: 'Saldo dan pembelian kredit',
        keywords: ['kredit', 'saldo', 'pembelian'],
      },
      {
        title: 'History',
        href: '/history',
        icon: History,
        description: 'Riwayat hasil generasi',
        keywords: ['history', 'riwayat', 'hasil', 'video'],
      },
    ],
  },
  {
    label: 'Admin',
    items: [
      {
        title: 'Admin Panel',
        href: '/admin',
        icon: ShieldCheck,
        adminOnly: true,
        badge: 'Admin',
        description: 'Kelola pengguna, model & API key',
        keywords: ['admin', 'panel', 'pengguna', 'waitlist', 'api key', 'model'],
      },
      {
        title: 'Freebeat MCP',
        href: '/admin/freebeat',
        icon: Plug,
        adminOnly: true,
        badge: 'Admin',
        description: 'Uji koneksi Freebeat',
        keywords: ['freebeat', 'mcp', 'koneksi'],
      },
      {
        title: 'Akun ChatGPT',
        href: '/studio/chatgpt-accounts',
        icon: KeyRound,
        adminOnly: true,
        badge: 'Admin',
        description: 'Pool akun ChatGPT manual: prioritas, kuota harian, cooldown',
        keywords: ['chatgpt', 'openai', 'akun', 'pool', 'kuota', 'api key', 'manual'],
      },
      {
        title: 'TempMail',
        href: '/tempmail',
        icon: Mail,
        adminOnly: true,
        badge: 'Admin',
        description: 'Alamat email sementara dan inbox khusus admin',
        keywords: ['tempmail', 'temporary email', 'email sementara', 'inbox', 'mail.tm'],
      },
    ],
  },
  {
    label: 'Akun',
    items: [
      {
        title: 'Setting',
        href: '/settings',
        icon: Settings,
        description: 'Profil, email & kata sandi',
        keywords: ['setting', 'pengaturan', 'akun', 'profil', 'email', 'password'],
      },
    ],
  },
];

export function getNavigation({ isAdmin = false } = {}) {
  return navigation
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !item.adminOnly || isAdmin),
    }))
    .filter((group) => group.items.length > 0);
}

export function flattenNavigation({ isAdmin = false } = {}) {
  return getNavigation({ isAdmin }).flatMap((group) =>
    group.items.map((item) => ({ ...item, group: group.label })),
  );
}

export function resolveRoute(href) {
  return href || '/app';
}

export function activeNavHref(pathname, { isAdmin = false } = {}) {
  const items = getNavigation({ isAdmin }).flatMap((group) => group.items);
  // Cocok persis dulu: /generate harus menyorot Generate, bukan Studio.
  for (const item of items) {
    if (resolveRoute(item.href) === pathname) return item.href;
  }
  // Lalu sub-rute: /studio/chat, /studio/metadata, /studio/image semuanya
  // masih bagian dari Studio, jadi entri sidebar Studio tetap tersorot.
  for (const item of items) {
    if (pathname.startsWith(`${item.href}/`)) return item.href;
  }
  return null;
}
