import {
  Clapperboard,
  LayoutDashboard,
  Mail,
  MessageSquare,
  Settings,
  ShieldCheck,
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
        title: 'Chat AI',
        href: '/studio',
        icon: MessageSquare,
        description: 'AI Studio, chat & riwayat percakapan',
        keywords: ['chat', 'ai', 'studio', 'riwayat', 'history', 'percakapan'],
      },
      {
        title: 'Generate',
        href: '/generate',
        icon: Clapperboard,
        description: 'Generate video AI dari teks, gambar, video & audio',
        keywords: ['generate', 'video', 'animasi', 'klip', 'render', 'veo', 'sora'],
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
  for (const group of getNavigation({ isAdmin })) {
    for (const item of group.items) {
      if (resolveRoute(item.href) === pathname) {
        return item.href;
      }
    }
  }
  return null;
}
