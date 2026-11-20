import { edgeRequest } from './client';

// Aksi admin atas pengguna: saldo (credits), status akun (status),
// peran akun (role), hapus akun (delete).
// Setiap panggilan wajib menyertakan password aksi admin yang di-hash di Supabase.
export async function adminUserAction(payload) {
  return edgeRequest('/admin/users/action', payload);
}

// Daftar ID akun yang menyandang role admin (untuk kolom PEROAN di /admin).
// Baca-saja, khusus admin, tanpa password.
export async function adminUserRoles() {
  return edgeRequest('/admin/users/roles', {});
}
