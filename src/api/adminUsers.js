import { edgeRequest } from './client';

// Aksi admin atas pengguna: saldo (credits), status akun (status), hapus akun (delete).
// Setiap panggilan wajib menyertakan password aksi admin yang di-hash di Supabase.
export async function adminUserAction(payload) {
  return edgeRequest('/admin/users/action', payload);
}
