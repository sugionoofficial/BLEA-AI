import { DropXLayout } from '../dropx/DropXLayout';
import { DropXDashboard } from '../dropx/DropXDashboard';
import { UserDashboard } from './UserDashboard';
import { useAuth } from './AuthProvider';

// Pengguna biasa hanya melihat galeri contoh (lihat + salin prompt). Admin
// tetap melihat ringkasan analitik di atas, lalu galeri di bawahnya dengan
// tombol "Mode edit (admin)" untuk mengelola contoh gambar/video.
export function Dashboard() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  return (
    <DropXLayout>
      {isAdmin && <DropXDashboard />}
      <UserDashboard />
    </DropXLayout>
  );
}
