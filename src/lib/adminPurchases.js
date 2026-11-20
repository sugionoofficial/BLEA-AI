// Aktif/nonaktifkan pembelian kredit (credit_payment_settings.purchases_enabled).
// Flag ini sengaja TIDAK bisa diubah dari browser (grant authenticated hanya
// mencakup kolom instructions/updated_at). Satu-satunya jalur adalah endpoint
// worker ini: khusus admin dan wajib password aksi admin (sama seperti aksi
// saldo/status/peran pengguna). Percobaan dicatat di admin_user_actions.
import { audit, fail, readJson, rpc, sbFetch, sbJson } from './adminUserControls.js';

const DEFAULT_NOTE = 'Transfer sesuai nominal paket. Setelah transfer, tekan "Saya sudah transfer" dan isi nama pengirim / referensi transfer, lalu tunggu pemeriksaan admin.';

export async function handlePurchaseToggle(env, request, user) {
  if (!user) throw fail('Login diperlukan.', 401);
  if (user.app_metadata?.role !== 'admin') throw fail('Hanya admin yang dapat mengubah status pembelian.', 403);
  const input = await readJson(request);
  if (Object.keys(input).some((key) => !['password', 'enabled'].includes(key))) throw fail('Permintaan memuat field yang tidak diizinkan.', 400);
  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 6 || password.length > 200) throw fail('Masukkan password aksi admin (minimal 6 karakter).', 400);
  if (typeof input.enabled !== 'boolean') throw fail('enabled harus true atau false.', 400);

  const verified = await rpc(env, 'verify_admin_action_password', { p_password: password });
  if (verified !== true) {
    await audit(env, user.id, null, 'purchase_toggle_ditolak_password', false, { enabled: input.enabled });
    throw fail('Password aksi admin salah. Percobaan ini dicatat.', 403);
  }

  const rows = await sbJson(env, '/rest/v1/credit_payment_settings?singleton=eq.true&select=instructions,purchases_enabled');
  const existing = Array.isArray(rows) ? rows[0] : null;
  const now = new Date().toISOString();

  if (existing) {
    const res = await sbFetch(env, '/rest/v1/credit_payment_settings?singleton=eq.true', {
      method: 'PATCH',
      body: { purchases_enabled: input.enabled, updated_at: now },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw fail(`Penyimpanan BLEA menolak perubahan (${res.status}). ${detail.slice(0, 160)}`, 502);
    }
  } else {
    if (!input.enabled) {
      // Tidak ada baris settings dan admin ingin mematikan: tidak ada yang diubah.
      return { purchases_enabled: false, unchanged: true };
    }
    const res = await sbFetch(env, '/rest/v1/credit_payment_settings', {
      method: 'POST',
      body: { singleton: true, instructions: DEFAULT_NOTE, purchases_enabled: true, updated_at: now },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw fail(`Penyimpanan BLEA menolak pembuatan pengaturan (${res.status}). ${detail.slice(0, 160)}`, 502);
    }
  }

  await audit(env, user.id, null, 'purchase_toggle', true, { enabled: input.enabled, previous: Boolean(existing?.purchases_enabled) });
  return { purchases_enabled: input.enabled };
}
