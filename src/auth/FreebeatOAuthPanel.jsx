import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Coins,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  Mail,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  checkFreebeatAccountsBalance,
  deleteFreebeatAccount,
  fetchFreebeatAccounts,
  reorderFreebeatAccounts,
  startFreebeatOAuth,
  updateFreebeatAccount,
} from '../api/freebeat';
import './admin.css';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const OAUTH_RETURN_PATH = '/admin?tab=freebeat-oauth';

const CALLBACK_MESSAGES = {
  connected: { type: 'success', text: 'Akun Freebeat OAuth berhasil terhubung dan disimpan ke pool failover.' },
  'connected-limited': { type: 'warn', text: 'Akun Freebeat terhubung, namun izin generasi (freebeat:generate) tidak diberikan saat persetujuan OAuth.' },
  denied: { type: 'error', text: 'Izin OAuth Freebeat ditolak oleh pengguna.' },
  invalid: { type: 'error', text: 'Parameter callback OAuth Freebeat tidak valid atau sesi PKCE kedaluwarsa.' },
  failed: { type: 'error', text: 'Koneksi OAuth Freebeat gagal diselesaikan. Silakan coba lagi.' },
};

function describeCallbackParam(code) {
  if (!code) return null;
  if (CALLBACK_MESSAGES[code]) return CALLBACK_MESSAGES[code];
  if (code.startsWith('failed-')) return CALLBACK_MESSAGES.failed;
  return { type: 'info', text: `Status koneksi Freebeat: ${code}` };
}

function relTime(iso) {
  if (!iso) return 'belum pernah';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'baru saja';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} menit lalu`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} jam lalu`;
  return new Date(iso).toLocaleDateString('id-ID');
}

function formatCredits(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'Belum dicek';
  return `${Number(value).toLocaleString('id-ID')} kredit`;
}

export function FreebeatOAuthPanel({ subTab = 'accounts', onCountChange }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState('info');
  const [busyId, setBusyId] = useState('');
  const [checkingAll, setCheckingAll] = useState(false);
  const [startingOAuth, setStartingOAuth] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [drafts, setDrafts] = useState({});
  const [newForm, setNewForm] = useState({ account_email: '', account_label: '' });
  const [policy, setPolicy] = useState({ maxCycles: 3, gatewayExhaustedMessage: 'SALDO GATEWAY HABIS, SILAHKAN HUBUNGI ADMIN.' });

  const setBanner = useCallback((msg, type = 'info') => {
    setNotice(msg);
    setNoticeType(type);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchFreebeatAccounts();
      const rows = Array.isArray(res?.accounts) ? res.accounts : [];
      setAccounts(rows);
      if (res?.policy) setPolicy(res.policy);
      else if (res?.maxCycles) setPolicy((p) => ({ ...p, maxCycles: res.maxCycles }));
      if (typeof onCountChange === 'function') onCountChange(rows.length);
    } catch (err) {
      setError(err?.message || 'Gagal memuat daftar akun Freebeat OAuth.');
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const fb = url.searchParams.get('freebeat');
    if (!fb) return;
    const info = describeCallbackParam(fb);
    if (info) setBanner(info.text, info.type);
    url.searchParams.delete('freebeat');
    const cleanSearch = url.searchParams.toString();
    window.history.replaceState({}, '', `${url.pathname}${cleanSearch ? `?${cleanSearch}` : ''}${url.hash}`);
  }, [setBanner]);

  const metrics = useMemo(() => {
    const total = accounts.length;
    const ready = accounts.filter((a) => a.enabled && a.image_access && !a.expired).length;
    const knownBalances = accounts.filter((a) => a.last_balance_credits != null && Number.isFinite(Number(a.last_balance_credits)));
    const totalCredits = knownBalances.reduce((sum, a) => sum + Number(a.last_balance_credits || 0), 0);
    const depleted = knownBalances.filter((a) => Number(a.last_balance_credits) <= 0).length;
    return { total, ready, knownCount: knownBalances.length, totalCredits, depleted };
  }, [accounts]);

  const dirtyDraft = useCallback((row) => {
    const draft = drafts[row.id];
    if (!draft) return false;
    return (draft.account_email ?? row.account_email ?? '') !== (row.account_email ?? '')
      || (draft.account_label ?? row.account_label ?? '') !== (row.account_label ?? '');
  }, [drafts]);

  async function handleConnectNew(e) {
    if (e?.preventDefault) e.preventDefault();
    const email = newForm.account_email.trim().toLowerCase();
    const label = newForm.account_label.trim();
    setError('');
    if (!EMAIL_RE.test(email)) {
      setBanner('Masukkan alamat email akun Freebeat yang valid sebelum memulai OAuth.', 'error');
      return;
    }
    setStartingOAuth(true);
    try {
      const res = await startFreebeatOAuth({
        email,
        label: label || email,
        returnTo: OAUTH_RETURN_PATH,
      });
      if (!res?.url) throw new Error('URL otorisasi Freebeat tidak diterima.');
      window.location.assign(res.url);
    } catch (err) {
      setStartingOAuth(false);
      setBanner(err?.message || 'Gagal memulai koneksi OAuth Freebeat.', 'error');
    }
  }

  async function handleReauthorize(row) {
    setBusyId(row.id);
    setError('');
    try {
      const res = await startFreebeatOAuth({
        accountId: row.id,
        email: (drafts[row.id]?.account_email ?? row.account_email) || '',
        label: (drafts[row.id]?.account_label ?? row.account_label) || '',
        returnTo: OAUTH_RETURN_PATH,
      });
      if (!res?.url) throw new Error('URL otorisasi Freebeat tidak diterima.');
      window.location.assign(res.url);
    } catch (err) {
      setBusyId('');
      setBanner(err?.message || 'Gagal memulai OAuth ulang untuk akun ini.', 'error');
    }
  }

  async function saveDraft(row) {
    const draft = drafts[row.id];
    if (!draft) return;
    const email = String(draft.account_email ?? row.account_email ?? '').trim().toLowerCase();
    const label = String(draft.account_label ?? row.account_label ?? '').trim();
    if (!EMAIL_RE.test(email)) {
      setBanner('Format email akun Freebeat tidak valid.', 'error');
      return;
    }
    setBusyId(row.id);
    try {
      await updateFreebeatAccount({ id: row.id, account_email: email, account_label: label || email });
      setDrafts((cur) => {
        const next = { ...cur };
        delete next[row.id];
        return next;
      });
      setBanner(`Data akun ${email} tersimpan.`, 'success');
      await load();
    } catch (err) {
      setBanner(err?.message || 'Gagal menyimpan perubahan akun.', 'error');
    } finally {
      setBusyId('');
    }
  }

  async function toggleEnabled(row) {
    setBusyId(row.id);
    try {
      await updateFreebeatAccount({ id: row.id, enabled: !row.enabled });
      setBanner(row.enabled ? `Akun ${row.account_email || row.account_label} dinonaktifkan dari rotasi.` : `Akun ${row.account_email || row.account_label} diaktifkan kembali.`, 'info');
      await load();
    } catch (err) {
      setBanner(err?.message || 'Gagal mengubah status aktif akun.', 'error');
    } finally {
      setBusyId('');
    }
  }

  async function movePriority(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= accounts.length) return;
    const reordered = accounts.slice();
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved);
    setBusyId(moved.id);
    try {
      const res = await reorderFreebeatAccounts(reordered.map((a) => a.id));
      if (Array.isArray(res?.accounts)) setAccounts(res.accounts);
      else await load();
      setBanner('Urutan prioritas round-robin diperbarui.', 'success');
    } catch (err) {
      setBanner(err?.message || 'Gagal mengubah urutan prioritas.', 'error');
    } finally {
      setBusyId('');
    }
  }

  async function handleCheckBalance(id = null) {
    if (id) setBusyId(id);
    else setCheckingAll(true);
    try {
      const res = await checkFreebeatAccountsBalance(id);
      if (Array.isArray(res?.accounts)) {
        setAccounts(res.accounts);
      } else {
        await load();
      }
      setBanner(id ? 'Saldo kredit akun Freebeat diperbarui.' : 'Saldo seluruh akun di pool Freebeat selesai diperiksa.', 'success');
    } catch (err) {
      setBanner(err?.message || 'Gagal memeriksa saldo Freebeat.', 'error');
    } finally {
      setBusyId('');
      setCheckingAll(false);
    }
  }

  async function handleDelete(row) {
    if (confirmDeleteId !== row.id) {
      setConfirmDeleteId(row.id);
      return;
    }
    setConfirmDeleteId('');
    setBusyId(row.id);
    try {
      await deleteFreebeatAccount(row.id);
      setBanner(`Akun ${row.account_email || row.account_label} dihapus dari pool.`, 'info');
      await load();
    } catch (err) {
      setBanner(err?.message || 'Gagal menghapus akun dari pool.', 'error');
    } finally {
      setBusyId('');
    }
  }

  if (subTab === 'failover') {
    return (
      <section className="admin-section">
        <div className="admin-table-card">
          <div className="admin-table-toolbar">
            <div>
              <strong>Alur Failover Multi-Akun Freebeat (Round-Robin {policy.maxCycles || 3}x Putaran)</strong>
              <p className="admin-hint">
                Ketika akun utama kehabisan kredit Freebeat, sesi MCP habis, atau gagal memproses, BLEA otomatis berpindah ke akun berikutnya sampai {policy.maxCycles || 3} putaran penuh.
              </p>
            </div>
            <div className="alibaba-account-actions">
              <button type="button" className="admin-btn-secondary" onClick={() => handleCheckBalance(null)} disabled={checkingAll || loading}>
                {checkingAll ? <LoaderCircle size={14} className="spin" /> : <Coins size={14} />} Cek Semua Saldo
              </button>
              <Link className="admin-btn-secondary" to="/admin/freebeat">
                Diagnostik MCP <ExternalLink size={13} />
              </Link>
            </div>
          </div>

          <div className="freebeat-oauth-flow-box">
            <div className="freebeat-oauth-step">
              <span className="alibaba-priority">Putaran 1 → 3</span>
              <div>
                <strong>Rotasi Berurutan (#1 → #2 → … → Kembali ke #1)</strong>
                <p>Setiap permintaan gambar atau dance video mencoba akun aktif sesuai urutan prioritas. Saldo akun yang terbaca ≤ 0 dilewati terlebih dahulu bila masih ada akun bersaldo positif, dan akun lain dicoba ulang hingga {policy.maxCycles || 3} siklus.</p>
              </div>
            </div>
            <div className="freebeat-oauth-step">
              <span className="alibaba-priority">OAuth Auto-Renew</span>
              <div>
                <strong>Token Diperbarui Otomatis Per Akun</strong>
                <p>Masing-masing akun menyimpan refresh token terenkripsi (AES-256-GCM) di database server-only agar perpindahan akun tidak bergantung pada cookie satu browser.</p>
              </div>
            </div>
            <div className="freebeat-oauth-step is-alert">
              <span className="alibaba-priority">Jika Semua Habis</span>
              <div>
                <strong>Refund Kredit BLEA Otomatis &amp; Notifikasi Pengguna (HTTP 503)</strong>
                <p>Setelah {policy.maxCycles || 3} putaran penuh seluruh akun gagal atau saldo habis, kredit BLEA pengguna dikembalikan otomatis dan halaman generate menampilkan: <code>{policy.gatewayExhaustedMessage}</code></p>
              </div>
            </div>
          </div>

          {accounts.length > 0 && (
            <div className="freebeat-oauth-summary-table">
              <table>
                <thead>
                  <tr>
                    <th>Urutan</th>
                    <th>Email Akun</th>
                    <th>Label</th>
                    <th>Saldo Freebeat</th>
                    <th>Status Pool</th>
                    <th>Error Terakhir</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((acc, idx) => (
                    <tr key={acc.id}>
                      <td><strong>#{idx + 1}</strong></td>
                      <td>{acc.account_email || <em style={{ opacity: 0.65 }}>Belum diisi</em>}</td>
                      <td>{acc.account_label || '—'}</td>
                      <td>{formatCredits(acc.last_balance_credits)}</td>
                      <td>
                        <span className={`alibaba-blea-badge ${acc.enabled && acc.image_access && !acc.expired ? 'is-video' : ''}`}>
                          {!acc.enabled ? 'Nonaktif' : acc.expired ? 'Sesi Kedaluwarsa' : acc.image_access ? 'Siap' : 'Terbatas'}
                        </span>
                      </td>
                      <td>{acc.last_error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="admin-section">
      <div className="admin-metrics freebeat-oauth-metrics">
        <article>
          <span>Total Akun Pool</span>
          <b>{metrics.total}</b>
          <small>Akun Freebeat OAuth terdaftar</small>
        </article>
        <article>
          <span>Siap Generate</span>
          <b>{metrics.ready}</b>
          <small>Aktif · izin generate · token valid</small>
        </article>
        <article>
          <span>Total Kredit Freebeat</span>
          <b>{metrics.knownCount > 0 ? metrics.totalCredits.toLocaleString('id-ID') : '—'}</b>
          <small>{metrics.knownCount}/{metrics.total} akun sudah dicek saldonya</small>
        </article>
        <article>
          <span>Kebijakan Rotasi</span>
          <b>{policy.maxCycles || 3}x Putaran</b>
          <small>{metrics.depleted > 0 ? `${metrics.depleted} akun saldo 0` : 'Round-robin #1 → #N → #1'}</small>
        </article>
      </div>

      <div className="admin-table-card">
        <div className="admin-table-toolbar">
          <div>
            <strong>Pool Akun Freebeat OAuth ({accounts.length})</strong>
            <p className="admin-hint">
              Hubungkan beberapa akun Gmail/Freebeat melalui OAuth. Setiap akun dilabeli emailnya dan diputar otomatis (round-robin maksimal {policy.maxCycles || 3} putaran) saat saldo habis atau gagal.
            </p>
          </div>
          <div className="alibaba-account-actions">
            <button type="button" className="admin-btn-secondary" onClick={() => handleCheckBalance(null)} disabled={checkingAll || loading || accounts.length === 0}>
              {checkingAll ? <LoaderCircle size={14} className="spin" /> : <Coins size={14} />} Cek Semua Saldo
            </button>
            <button type="button" className="admin-btn-secondary" onClick={load} disabled={loading}>
              <RefreshCw size={14} /> Muat Ulang
            </button>
            <Link className="admin-btn-secondary" to="/admin/freebeat">
              Diagnostik MCP <ArrowRight size={13} />
            </Link>
          </div>
        </div>

        <form className="freebeat-oauth-add-form" onSubmit={handleConnectNew}>
          <input
            type="email"
            required
            placeholder="Email akun Freebeat (mis. akun2@gmail.com)"
            aria-label="Email akun Freebeat baru"
            value={newForm.account_email}
            onChange={(e) => setNewForm((f) => ({ ...f, account_email: e.target.value }))}
          />
          <input
            type="text"
            placeholder="Label akun (opsional, mis. Freebeat #2)"
            aria-label="Label akun Freebeat baru"
            value={newForm.account_label}
            onChange={(e) => setNewForm((f) => ({ ...f, account_label: e.target.value }))}
          />
          <button type="submit" className="admin-btn-primary" disabled={startingOAuth}>
            {startingOAuth ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />} Hubungkan Akun Freebeat (OAuth)
          </button>
        </form>

        <div className="freebeat-oauth-tip">
          <KeyRound size={14} />
          <span>
            <strong>Tips Multi-Akun:</strong> Sebelum menghubungkan akun ke-2 atau ke-3, pastikan browser Anda sudah <em>logout</em> dari akun sebelumnya di <code>freebeat.ai</code> (atau gunakan profil browser terpisah) agar Freebeat menampilkan layar pilih akun Gmail yang benar.
          </span>
        </div>

        {notice && (
          <div className={`admin-notice freebeat-oauth-notice is-${noticeType}`} role="status">
            {notice}
          </div>
        )}
        {error && (
          <div className="admin-notice freebeat-oauth-notice is-error" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <p className="admin-hint">Memuat pool akun Freebeat OAuth…</p>
        ) : accounts.length === 0 ? (
          <div className="admin-notice">
            Belum ada akun Freebeat OAuth di pool. Isi email Freebeat di form atas lalu klik <strong>Hubungkan Akun Freebeat (OAuth)</strong>.
          </div>
        ) : (
          accounts.map((row, idx) => {
            const busy = busyId === row.id || checkingAll;
            const draft = drafts[row.id] || {};
            const emailVal = draft.account_email ?? row.account_email ?? '';
            const labelVal = draft.account_label ?? row.account_label ?? '';
            const hasBalance = row.last_balance_credits != null && Number.isFinite(Number(row.last_balance_credits));
            const isZeroBalance = hasBalance && Number(row.last_balance_credits) <= 0;

            return (
              <div key={row.id} className={`alibaba-account-card freebeat-oauth-card ${row.enabled ? '' : 'is-disabled'}`}>
                <div className="alibaba-account-top">
                  <div className="freebeat-oauth-card-head">
                    <span className="alibaba-priority">#{idx + 1}</span>
                    <div className="freebeat-oauth-inputs">
                      <label className="freebeat-oauth-inline-field">
                        <span><Mail size={11} /> Email Akun</span>
                        <input
                          type="email"
                          className="freebeat-oauth-email-input"
                          placeholder="email@gmail.com"
                          aria-label={`Email akun prioritas ${idx + 1}`}
                          value={emailVal}
                          onChange={(e) => setDrafts((cur) => ({ ...cur, [row.id]: { ...cur[row.id], account_email: e.target.value } }))}
                        />
                      </label>
                      <label className="freebeat-oauth-inline-field">
                        <span>Label</span>
                        <input
                          type="text"
                          className="alibaba-label-input"
                          placeholder="Label akun"
                          aria-label={`Label akun prioritas ${idx + 1}`}
                          value={labelVal}
                          onChange={(e) => setDrafts((cur) => ({ ...cur, [row.id]: { ...cur[row.id], account_label: e.target.value } }))}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="alibaba-account-actions">
                    <button
                      type="button"
                      className="alibaba-icon-btn"
                      title="Naikkan prioritas"
                      disabled={busy || idx === 0}
                      onClick={() => movePriority(idx, -1)}
                    >
                      <ChevronUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="alibaba-icon-btn"
                      title="Turunkan prioritas"
                      disabled={busy || idx === accounts.length - 1}
                      onClick={() => movePriority(idx, 1)}
                    >
                      <ChevronDown size={14} />
                    </button>
                    <button
                      type="button"
                      className={`alibaba-toggle ${row.enabled ? 'is-on' : ''}`}
                      disabled={busy}
                      onClick={() => toggleEnabled(row)}
                    >
                      {row.enabled ? 'Aktif' : 'Nonaktif'}
                    </button>
                  </div>
                </div>

                <div className="freebeat-oauth-badges">
                  <span className={`freebeat-oauth-pill ${isZeroBalance ? 'is-danger' : hasBalance ? 'is-ok' : ''}`}>
                    <Coins size={12} /> {isZeroBalance ? 'Saldo Habis (0)' : formatCredits(row.last_balance_credits)}
                    {row.last_balance_checked_at && <small> · dicek {relTime(row.last_balance_checked_at)}</small>}
                  </span>
                  <span className={`freebeat-oauth-pill ${row.image_access ? 'is-ok' : 'is-warn'}`}>
                    <ShieldCheck size={12} /> {row.image_access ? 'Izin Generate OK' : 'Izin Terbatas'}
                  </span>
                  <span className={`freebeat-oauth-pill ${row.auto_renew ? 'is-ok' : 'is-warn'}`}>
                    <RotateCw size={12} /> {row.auto_renew ? 'Auto-Renew Aktif' : 'Perlu OAuth Ulang Saat Habis'}
                  </span>
                  {row.expired && (
                    <span className="freebeat-oauth-pill is-danger">
                      <AlertTriangle size={12} /> Sesi kedaluwarsa — klik OAuth Ulang
                    </span>
                  )}
                </div>

                <div className="alibaba-account-foot">
                  <span>Dipakai: {relTime(row.last_used_at)}</span>
                  <span>Sukses: {relTime(row.last_success_at)}</span>
                  {row.session_expires_at && (
                    <span>Sesi berlaku s/d {new Date(row.session_expires_at).toLocaleDateString('id-ID')}</span>
                  )}
                  {row.consecutive_failures > 0 && (
                    <span className="freebeat-oauth-fail-count">Gagal beruntun: {row.consecutive_failures}x</span>
                  )}
                  {row.last_error && (
                    <span className="alibaba-account-error" title={row.last_error}>
                      <AlertTriangle size={12} /> {row.last_error}
                    </span>
                  )}

                  <div className="alibaba-account-foot-actions">
                    {dirtyDraft(row) && (
                      <button type="button" className="admin-btn-secondary" disabled={busy} onClick={() => saveDraft(row)}>
                        <CheckCircle2 size={13} /> Simpan
                      </button>
                    )}
                    <button type="button" className="admin-btn-secondary" disabled={busy} onClick={() => handleCheckBalance(row.id)}>
                      {busyId === row.id ? <LoaderCircle size={13} className="spin" /> : <Coins size={13} />} Cek Saldo
                    </button>
                    <button type="button" className="admin-btn-secondary" disabled={busy} onClick={() => handleReauthorize(row)}>
                      <Link2 size={13} /> OAuth Ulang
                    </button>
                    {confirmDeleteId === row.id ? (
                      <>
                        <span className="alibaba-confirm-text">Hapus akun ini?</span>
                        <button type="button" className="admin-btn-secondary" disabled={busy} onClick={() => handleDelete(row)}>
                          Ya, Hapus
                        </button>
                        <button type="button" className="admin-btn-secondary" disabled={busy} onClick={() => setConfirmDeleteId('')}>
                          Batal
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="alibaba-icon-btn"
                        title="Hapus akun dari pool"
                        disabled={busy}
                        onClick={() => handleDelete(row)}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
