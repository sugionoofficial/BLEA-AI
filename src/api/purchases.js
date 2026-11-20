import { edgeRequest } from './client';

// Aktif/nonaktifkan pembelian kredit. Khusus admin, wajib password aksi admin.
// Flag purchases_enabled tidak bisa diubah langsung dari browser.
export async function setPurchasesEnabled(enabled, password) {
  return edgeRequest('/admin/purchase-toggle', { enabled, password });
}

// Setujui / Tolak pesanan kredit. Wajib password aksi admin; browser tidak
// bisa memanggil RPC review secara langsung (grant dicabut).
export async function reviewCreditOrder(orderId, approve, password) {
  return edgeRequest('/admin/review-order', { order_id: orderId, approve, password });
}
