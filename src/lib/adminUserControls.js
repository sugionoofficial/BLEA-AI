// Kontrol admin atas pengguna: tambah/kurangi saldo, suspend, banned, hapus
// akun, dan ubah peran (user <-> admin). Setiap aksi wajib password yang
// hash-nya disimpan admin di Supabase (admin_action_settings). Hash tidak
// pernah dikirim ke browser; verifikasi dilakukan fungsi SECURITY DEFINER yang
// hanya bisa dipanggil service_role. Semua percobaan — berhasil maupun gagal —
// dicatat di admin_user_actions.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['credits', 'status', 'delete', 'role']);
const STATUSES = new Set(['active', 'suspended', 'banned']);

function fail(message, status = 400) { return Object.assign(new Error(message), { status }); }

function supabaseBase(env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_ROLE_KEY) throw fail('Penyimpanan BLEA belum dikonfigurasi; aksi admin tidak diaktifkan.', 503);
  const base = new URL(env.SUPABASE_URL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw fail('Konfigurasi penyimpanan BLEA tidak valid.', 503);
  return base.toString().replace(/\/$/, '');
}

async function sbFetch(env, path, options = {}) {
  let res;
  try {
    res = await fetch(`${supabaseBase(env)}${path}`, {
      method: options.method || 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
        ...(options.prefer ? { prefer: options.prefer } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch { throw fail('Penyimpanan BLEA tidak dapat dihubungi.', 503); }
  return res;
}

async function sbJson(env, path, options = {}) {
  const res = await sbFetch(env, path, options);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw fail(`Penyimpanan BLEA menolak permintaan (${res.status}). ${detail.slice(0, 160)}`, 503);
  }
  return await res.json().catch(() => null);
}

async function rpc(env, fn, body) {
  const res = await sbFetch(env, `/rest/v1/rpc/${fn}`, { method: 'POST', body });
  if (!res.ok) throw fail(`Fungsi database ${fn} menolak permintaan (${res.status}).`, 503);
  return await res.json().catch(() => null);
}

async function audit(env, adminId, targetUserId, action, success, detail) {
  try {
    await sbFetch(env, '/rest/v1/admin_user_actions', {
      method: 'POST',
      prefer: 'return=minimal',
      body: { admin_id: adminId, target_user_id: targetUserId || null, action, success: success === true, detail: detail || {} },
    });
  } catch { /* audit tidak boleh membatalkan aksi yang sudah terjadi */ }
}

async function readJson(request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) throw fail('Permintaan harus berasal dari halaman BLEA ini.', 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw fail('Format permintaan tidak valid.', 400);
  let input;
  try { input = await request.json(); } catch { throw fail('Permintaan tidak valid.', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Permintaan tidak valid.', 400);
  return input;
}

// Daftar seluruh akun auth (dipakai untuk kolom PEROAN dan untuk mencegah
// pencabutan admin terakhir). Di-cache per pemanggilan request, bukan global.
async function listAuthUsers(env) {
  const users = [];
  const perPage = 200;
  for (let page = 1; page <= 25; page += 1) {
    const data = await sbJson(env, `/auth/v1/admin/users?page=${page}&per_page=${perPage}`);
    const chunk = Array.isArray(data?.users) ? data.users : [];
    users.push(...chunk);
    const total = Number(data?.total ?? NaN);
    if (chunk.length < perPage) break;
    if (Number.isFinite(total) && users.length >= total) break;
  }
  return users;
}

async function targetProfile(env, userId) {
  const rows = await sbJson(env, `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,status&limit=1`);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw fail('Akun pengguna tidak ditemukan.', 404);
  return row;
}

export async function handleAdminUserAction(env, request, user) {
  if (!user) throw fail('Login diperlukan.', 401);
  if (user.app_metadata?.role !== 'admin') throw fail('Hanya admin yang dapat melakukan aksi ini.', 403);
  const input = await readJson(request);
  const action = String(input.action || '');
  if (!ACTIONS.has(action)) throw fail('Aksi tidak dikenal.', 400);
  if (Object.keys(input).some((key) => !['action', 'user_id', 'password', 'delta', 'description', 'status', 'reason', 'confirm_email', 'role'].includes(key))) throw fail('Permintaan memuat field yang tidak diizinkan.', 400);

  const targetId = String(input.user_id || '');
  if (!UUID_RE.test(targetId)) throw fail('ID pengguna tidak valid.', 400);
  // Admin boleh menyesuaikan saldo akunnya SENDIRI (tetap wajib password),
  // tetapi tidak boleh mengubah status, peran, atau menghapus akun sendiri —
  // perubahan itu wajib dilakukan admin lain supaya tidak terjadi penguncian
  // tidak sengaja.
  if (targetId === user.id && action !== 'credits') throw fail('Anda tidak dapat mengubah peran/status/penghapusan akun Anda sendiri dari sini; hanya saldo kredit yang boleh Anda sesuaikan sendiri. Minta admin lain untuk perubahan lainnya.', 409);

  const password = typeof input.password === 'string' ? input.password : '';
  if (password.length < 6 || password.length > 200) throw fail('Masukkan password aksi admin (minimal 6 karakter).', 400);

  const verified = await rpc(env, 'verify_admin_action_password', { p_password: password });
  if (verified !== true) {
    await audit(env, user.id, targetId, `${action}_ditolak_password`, false, {});
    throw fail('Password aksi admin salah. Percobaan ini dicatat.', 403);
  }

  const profile = await targetProfile(env, targetId);

  if (action === 'credits') {
    const delta = Number(input.delta);
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1000000) throw fail('Jumlah kredit harus angka bulat bukan nol, maksimal 1.000.000.', 400);
    const description = typeof input.description === 'string' ? input.description.slice(0, 200) : '';
    const balance = await rpc(env, 'admin_adjust_credits', { p_user_id: targetId, p_delta: delta, p_description: description, p_admin_id: user.id });
    if (balance === null) {
      await audit(env, user.id, targetId, 'credits', false, { delta });
      throw fail(delta < 0 ? 'Pengurangan ditolak: saldo pengguna tidak cukup (saldo tidak boleh minus).' : 'Penyesuaian saldo gagal.', 409);
    }
    await audit(env, user.id, targetId, 'credits', true, { delta, balance: Number(balance), description });
    return { action, user_id: targetId, delta, balance: Number(balance) };
  }

  if (action === 'status') {
    const status = String(input.status || '');
    if (!STATUSES.has(status)) throw fail('Status harus active, suspended, atau banned.', 400);
    const reason = typeof input.reason === 'string' ? input.reason.slice(0, 300) : null;
    await sbJson(env, `/rest/v1/profiles?id=eq.${encodeURIComponent(targetId)}`, {
      method: 'PATCH',
      prefer: 'return=representation',
      body: { status, status_reason: reason, status_updated_at: new Date().toISOString(), status_updated_by: user.id, updated_at: new Date().toISOString() },
    });
    await audit(env, user.id, targetId, 'status', true, { status, reason, previous: profile.status || null });
    return { action, user_id: targetId, status, reason };
  }

  if (action === 'role') {
    const role = String(input.role || '');
    if (role !== 'admin' && role !== 'user') throw fail('Peran harus admin atau user.', 400);
    const authUsers = await listAuthUsers(env);
    const target = authUsers.find((item) => item?.id === targetId);
    if (!target) throw fail('Akun pengguna tidak ditemukan.', 404);
    const previousRole = target?.app_metadata?.role === 'admin' ? 'admin' : 'user';
    if (role === 'user' && previousRole === 'admin') {
      const adminCount = authUsers.filter((item) => item?.app_metadata?.role === 'admin').length;
      if (adminCount <= 1) {
        await audit(env, user.id, targetId, 'role_ditolak_admin_terakhir', false, {});
        throw fail('Tidak dapat mencabut peran admin terakhir. Promosikan admin lain terlebih dahulu.', 409);
      }
    }
    if (role === previousRole) {
      return { action, user_id: targetId, role, previous: previousRole, unchanged: true };
    }
    const existingMeta = target.app_metadata && typeof target.app_metadata === 'object' ? target.app_metadata : {};
    const res = await sbFetch(env, `/auth/v1/admin/users/${encodeURIComponent(targetId)}`, {
      method: 'PUT',
      body: { app_metadata: { ...existingMeta, role } },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      await audit(env, user.id, targetId, 'role', false, { status: res.status });
      throw fail(`Supabase menolak perubahan peran (${res.status}). ${detail.slice(0, 160)}`, 502);
    }
    await audit(env, user.id, targetId, 'role', true, { role, previous: previousRole });
    return { action, user_id: targetId, role, previous: previousRole };
  }

  // action === 'delete'
  const confirmEmail = String(input.confirm_email || '').trim().toLowerCase();
  if (!confirmEmail || confirmEmail !== String(profile.email || '').trim().toLowerCase()) {
    await audit(env, user.id, targetId, 'delete_ditolak_konfirmasi', false, {});
    throw fail('Konfirmasi email tidak cocok dengan akun target. Penghapusan dibatalkan.', 409);
  }
  const res = await sbFetch(env, `/auth/v1/admin/users/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    await audit(env, user.id, targetId, 'delete', false, { status: res.status });
    throw fail(`Supabase menolak penghapusan akun (${res.status}). ${detail.slice(0, 160)}`, 502);
  }
  await audit(env, user.id, targetId, 'delete', res.ok, { email: profile.email || null });
  return { action, user_id: targetId, deleted: res.ok, already_absent: res.status === 404 };
}

// Daftar ID akun yang menyandang role admin (untuk kolom PEROAN di /admin).
// Hanya baca, khusus admin; tidak membocorkan metadata lain.
export async function handleAdminUserRoles(env, request, user) {
  if (!user) throw fail('Login diperlukan.', 401);
  if (user.app_metadata?.role !== 'admin') throw fail('Hanya admin yang dapat melihat peran ini.', 403);
  const users = await listAuthUsers(env);
  return { admin_ids: users.filter((item) => item?.app_metadata?.role === 'admin').map((item) => item.id) };
}
