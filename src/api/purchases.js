import { edgeRequest } from './client';

// Aktif/nonaktifkan pembelian kredit. Khusus admin, wajib password aksi admin.
// Flag purchases_enabled tidak bisa diubah langsung dari browser.
export async function setPurchasesEnabled(enabled, password) {
  return edgeRequest('/admin/purchase-toggle', { enabled, password });
}
