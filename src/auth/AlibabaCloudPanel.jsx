import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cloud,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { verifyKey } from '../api/unorouter';
import {
  ALIBABA_FREE_QUOTA_CATEGORIES,
  ALIBABA_FREE_QUOTA_DOCS,
  ALIBABA_FREE_QUOTA_MODELS,
} from '../lib/alibabaFreeQuota';
import './admin.css';

const FREE_QUOTA_CONSOLE = 'https://modelstudio.console.alibabacloud.com/ap-southeast-1/costing-balance/free-quota';

function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 12) return '•'.repeat(Math.max(8, s.length));
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
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

function cooldownInfo(row) {
  if (!row.cooldown_until) return null;
  const until = new Date(row.cooldown_until).getTime();
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return new Date(until);
}

const inputStyle = {
  width: '100%',
  background: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 10px',
  color: 'inherit',
  font: 'inherit',
  fontSize: 13,
};

export function AlibabaCloudPanel({ subTab = 'accounts' }) {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState('');
  const [drafts, setDrafts] = useState({});
  const [revealed, setRevealed] = useState({});
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [newAccount, setNewAccount] = useState({ label: '', api_key: '', base_url: '' });
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('Semua');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: dbError } = await supabase
      .from('provider_key_pool')
      .select('id,provider,label,api_key,base_url,enabled,priority,consecutive_failures,cooldown_until,last_error,last_used_at,last_success_at,min_verified_at,created_at')
      .eq('provider', 'alibaba')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true });
    if (dbError) setError(`Gagal memuat pool akun: ${dbError.message}`);
    setAccounts(Array.isArray(data) ? data : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirtyDraft = useCallback((row) => {
    const draft = drafts[row.id];
    if (!draft) return false;
    return (draft.label ?? row.label) !== row.label || (draft.base_url ?? row.base_url) !== row.base_url;
  }, [drafts]);

  async function addAccount() {
    const label = newAccount.label.trim();
    const apiKey = newAccount.api_key.trim();
    const baseUrl = newAccount.base_url.trim().replace(/\/+$/, '');
    setNotice('');
    if (!apiKey || apiKey.length < 8) { setNotice('API key minimal 8 karakter.'); return; }
    if (!/^https:\/\/.+/i.test(baseUrl)) { setNotice('Base URL wajib https://{WorkspaceId}.<region>.maas.aliyuncs.com'); return; }
    setAdding(true);
    const { error: insertError } = await supabase.from('provider_key_pool').insert({
      provider: 'alibaba',
      label: label || 'Akun Alibaba',
      api_key: apiKey,
      base_url: baseUrl,
      priority: (accounts.length + 1) * 10,
    });
    setAdding(false);
    if (insertError) { setNotice(`Gagal menambah akun: ${insertError.message}`); return; }
    setNewAccount({ label: '', api_key: '', base_url: '' });
    setNotice('Akun ditambahkan. Generasi Alibaba berikutnya otomatis memakainya sesuai prioritas.');
    await load();
  }

  async function saveDraft(row) {
    const draft = drafts[row.id];
    if (!draft) return;
    const label = String(draft.label ?? row.label).trim();
    const baseUrl = String(draft.base_url ?? row.base_url).trim().replace(/\/+$/, '');
    if (!/^https:\/\/.+/i.test(baseUrl)) { setNotice('Base URL wajib https://…'); return; }
    setBusyId(row.id);
    const { error: updateError } = await supabase.from('provider_key_pool').update({ label, base_url: baseUrl }).eq('id', row.id);
    setBusyId('');
    if (updateError) { setNotice(`Gagal menyimpan: ${updateError.message}`); return; }
    setDrafts((cur) => { const next = { ...cur }; delete next[row.id]; return next; });
    setNotice('Akun tersimpan.');
    await load();
  }

  async function toggleEnabled(row) {
    setBusyId(row.id);
    const { error: updateError } = await supabase.from('provider_key_pool').update({ enabled: !row.enabled }).eq('id', row.id);
    setBusyId('');
    if (updateError) setNotice(`Gagal mengubah: ${updateError.message}`);
    await load();
  }

  async function moveAccount(row, direction) {
    const sorted = [...accounts].sort((a, b) => a.priority - b.priority || String(a.created_at).localeCompare(String(b.created_at)));
    const index = sorted.findIndex((item) => item.id === row.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= sorted.length) return;
    const normalized = sorted.map((item, i) => ({ id: item.id, priority: (i + 1) * 10 }));
    const a = normalized[index];
    const b = normalized[target];
    normalized[index] = { ...a, priority: b.priority };
    normalized[target] = { ...b, priority: a.priority };
    setBusyId(row.id);
    for (const item of normalized) {
      await supabase.from('provider_key_pool').update({ priority: item.priority }).eq('id', item.id);
    }
    setBusyId('');
    await load();
  }

  async function verifyAccount(row) {
    setBusyId(row.id);
    setNotice('');
    const res = await verifyKey({ provider: 'alibaba', apiKey: row.api_key, baseUrl: row.base_url });
    const valid = res.ok && res.data?.valid === true;
    if (valid) {
      await supabase.from('provider_key_pool').update({ min_verified_at: new Date().toISOString(), last_error: null }).eq('id', row.id);
      setNotice(`Key ${row.label || 'akun'} valid.`);
    } else {
      setNotice(`Key ${row.label || 'akun'} ditolak: ${res.data?.error || res.data?.status || res.status}`);
    }
    setBusyId('');
    await load();
  }

  async function deleteAccount(row) {
    setBusyId(row.id);
    const { error: deleteError } = await supabase.from('provider_key_pool').delete().eq('id', row.id);
    setBusyId('');
    setConfirmDeleteId('');
    if (deleteError) { setNotice(`Gagal menghapus: ${deleteError.message}`); return; }
    setNotice('Akun dihapus dari pool.');
    await load();
  }

  const catalogFiltered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ALIBABA_FREE_QUOTA_MODELS.filter((m) => {
      if (category !== 'Semua' && m.category !== category) return false;
      if (!q) return true;
      return [m.id, m.name, m.freeQuota, m.note].filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [query, category]);

  const catalogCounts = useMemo(() => {
    const counts = { Semua: ALIBABA_FREE_QUOTA_MODELS.length };
    for (const m of ALIBABA_FREE_QUOTA_MODELS) counts[m.category] = (counts[m.category] || 0) + 1;
    return counts;
  }, []);

  if (subTab === 'catalog') {
    return (
      <section className="admin-api-card">
        <div className="admin-api-heading">
          <div><span className="admin-eyebrow">ALIBABA CLOUD · FREE QUOTA</span><h2>Katalog model free quota</h2></div>
          <span className="admin-api-badge"><Cloud size={13} /> Model Studio</span>
        </div>
        <p className="admin-api-note">
          Daftar model Alibaba Cloud Model Studio yang menerbitkan free quota (per dokumentasi resmi, diperiksa November 2026).
          Free quota berlaku <b>90 hari</b> sejak aktivasi Model Studio per model dan terbagi antara akun utama &amp; RAM users.
        </p>
        <div className="alibaba-catalog-warning" role="note">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            <b>Perhatikan region:</b> sebagian free quota hanya berlaku di China (Beijing); kampanye internasional (ap-southeast-1)
            menampilkan angka tersendiri. Wan 3.0-Video dilaporkan punya free quota di Singapore (marketing), tetapi halaman
            pricing resmi menyebut tidak ada free quota di China (Beijing). <b>Sisa free quota tidak dapat dibaca via API key</b> —
            cek langsung di{' '}
            <a href={FREE_QUOTA_CONSOLE} target="_blank" rel="noopener noreferrer">konsol Free Quota <ExternalLink size={11} /></a>
            {' '}atau di{' '}
            <a href={ALIBABA_FREE_QUOTA_DOCS} target="_blank" rel="noopener noreferrer">daftar harga resmi <ExternalLink size={11} /></a>.
          </span>
        </div>

        <div className="alibaba-catalog-filters">
          <label className="admin-search" style={{ flex: 1 }}>
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari model, mis. qwen3.8-max / wan / tts…" aria-label="Cari model free quota" />
          </label>
          <div className="alibaba-catalog-chips" role="tablist">
            {['Semua', ...ALIBABA_FREE_QUOTA_CATEGORIES.map((c) => c.id)].map((id) => (
              <button key={id} type="button" role="tab" aria-selected={category === id} className={`admin-model-chip ${category === id ? 'is-on' : ''}`} onClick={() => setCategory(id)}>
                {ALIBABA_FREE_QUOTA_CATEGORIES.find((c) => c.id === id)?.label || id} ({catalogCounts[id] || 0})
              </button>
            ))}
          </div>
        </div>

        <div className="alibaba-catalog-grid">
          {catalogFiltered.length === 0 && <p className="admin-table-message">Tidak ada model yang cocok.</p>}
          {catalogFiltered.map((m) => (
            <article key={`${m.category}:${m.id}`} className="alibaba-catalog-card">
              <header>
                <code className="alibaba-catalog-id">{m.id}</code>
                <span className={`alibaba-blea-badge ${m.blea ? `is-${m.blea}` : 'is-off'}`}>
                  {m.blea === 'video' ? 'Terhubung · Video' : m.blea === 'chat' ? 'Bisa diaktifkan · Chat' : m.blea === 'image' ? 'Bisa diaktifkan · Gambar' : 'Katalog saja'}
                </span>
              </header>
              <b className="alibaba-catalog-name">{m.name}</b>
              <span className="alibaba-catalog-quota">{m.freeQuota}</span>
              {m.note && <span className="alibaba-catalog-note">{m.note}</span>}
              <footer>
                <span className="alibaba-catalog-cat">{m.category}</span>
                {m.docs && (
                  <a href={m.docs} target="_blank" rel="noopener noreferrer" className="alibaba-catalog-doc">Docs <ExternalLink size={11} /></a>
                )}
              </footer>
            </article>
          ))}
        </div>
        <p className="admin-hint is-compact">
          Menampilkan {catalogFiltered.length} dari {ALIBABA_FREE_QUOTA_MODELS.length} model. Model kategori <b>Teks</b> bisa diaktifkan di
          tab <b>Katalog Model (Provider: Alibaba)</b> agar muncul di AI Studio; model gambar bertanda <b>Bisa diaktifkan · Gambar</b>
          (wan2.7-image, wan2.7-image-pro, qwen-image-3.0, qwen-image-3.0-pro) muncul di <b>Generate Image</b> setelah diaktifkan di katalog dan
          punya harga kredit aktif di <b>Admin → Kredit</b> — speech masih katalog saja.
        </p>
      </section>
    );
  }

  return (
    <section className="admin-api-card">
      <div className="admin-api-heading">
        <div><span className="admin-eyebrow">ALIBABA CLOUD · MULTI-AKUN</span><h2>Akun Alibaba Cloud</h2></div>
        <div className="admin-api-heading-actions">
          <button type="button" className="admin-refresh-button" onClick={load} disabled={loading}>
            <RefreshCw size={13} /> Muat ulang
          </button>
        </div>
      </div>
      <p className="admin-api-note">
        Tambahkan banyak akun Alibaba Cloud. Saat generasi memakai provider <b>alibaba</b> — Video Wan 3.0, Chat Qwen di AI Studio,
        Gambar di Generate Image — dan akun pertama terkena kuota/rate limit atau keynya ditolak (HTTP 401/402/403/429), worker <b>otomatis melanjutkan ke akun berikutnya</b>
        sesuai prioritas. Akun yang gagal masuk <b>cooldown 10–60 menit</b> (berlipat), lalu bisa dipakai lagi otomatis.
        Sisa free quota tetap hanya terlihat di{' '}
        <a href={FREE_QUOTA_CONSOLE} target="_blank" rel="noopener noreferrer">konsol</a>.
      </p>

      {error && <div className="admin-error" role="alert"><span>{error}</span></div>}
      {notice && <div className="admin-notice" role="status"><span>{notice}</span></div>}

      <div className="alibaba-add-form">
        <input value={newAccount.label} onChange={(event) => setNewAccount((cur) => ({ ...cur, label: event.target.value }))} placeholder="Label akun (mis. Alibaba #1 — workspace utami)" aria-label="Label akun" />
        <input type="password" value={newAccount.api_key} onChange={(event) => setNewAccount((cur) => ({ ...cur, api_key: event.target.value }))} placeholder="API key Model Studio (sk-…)" autoComplete="off" spellCheck={false} aria-label="API key Alibaba" />
        <input type="url" value={newAccount.base_url} onChange={(event) => setNewAccount((cur) => ({ ...cur, base_url: event.target.value }))} placeholder="https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com" aria-label="Base URL workspace" />
        <button type="button" className="admin-api-save" onClick={addAccount} disabled={adding || !newAccount.api_key.trim()}>
          {adding ? <LoaderCircle size={14} className="spinning" /> : <Plus size={14} />} Tambah akun
        </button>
      </div>

      {loading ? (
        <div className="admin-skeleton" />
      ) : accounts.length === 0 ? (
        <div className="admin-api-empty">
          <b>Belum ada akun Alibaba di pool.</b>
          <p>Tambahkan minimal satu akun. Jika pool kosong, BLEA memakai key tunggal dari tab <b>Provider &amp; API Key → Alibaba Wan 3.0</b> (perilaku lama, tanpa failover).</p>
        </div>
      ) : (
        accounts.map((row, index) => {
          const draft = drafts[row.id] || {};
          const label = draft.label ?? row.label;
          const baseUrl = draft.base_url ?? row.base_url;
          const cooldown = cooldownInfo(row);
          const failures = row.consecutive_failures || 0;
          return (
            <div className={`alibaba-account-card ${row.enabled ? '' : 'is-disabled'}`} key={row.id}>
              <div className="alibaba-account-top">
                <div className="alibaba-account-title">
                  <span className="alibaba-priority" title="Urutan pemakaian (lebih kecil dipakai lebih dulu)">#{index + 1}</span>
                  <div>
                    <input className="alibaba-label-input" value={label} onChange={(event) => setDrafts((cur) => ({ ...cur, [row.id]: { ...cur[row.id], label: event.target.value } }))} aria-label="Label akun" />
                    <small>{row.enabled ? (cooldown ? `Cooldown sampai ${cooldown.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })} · baca tulis ditunda` : failures > 0 ? `Gagal ${failures}× berturut-turut · cooldown otomatis` : 'Aktif · akan dipakai sesuai prioritas') : 'Nonaktif · dilewati saat generasi'}</small>
                  </div>
                </div>
                <div className="alibaba-account-actions">
                  <button type="button" className="alibaba-icon-btn" onClick={() => moveAccount(row, -1)} disabled={index === 0 || busyId === row.id} aria-label="Naikkan prioritas"><ChevronUp size={15} /></button>
                  <button type="button" className="alibaba-icon-btn" onClick={() => moveAccount(row, 1)} disabled={index === accounts.length - 1 || busyId === row.id} aria-label="Turunkan prioritas"><ChevronDown size={15} /></button>
                  <button type="button" className={`alibaba-toggle ${row.enabled ? 'is-on' : ''}`} onClick={() => toggleEnabled(row)} disabled={busyId === row.id} aria-pressed={row.enabled}>{row.enabled ? 'Aktif' : 'Nonaktif'}</button>
                </div>
              </div>

              <div className="admin-api-input-row">
                <KeyRound size={14} />
                <input type={revealed[row.id] ? 'text' : 'password'} value={row.api_key} readOnly aria-label="API key (read-only)" />
                <button type="button" className="alibaba-icon-btn" onClick={() => setRevealed((cur) => ({ ...cur, [row.id]: !cur[row.id] }))} aria-label={revealed[row.id] ? 'Sembunyikan key' : 'Tampilkan key'}>
                  {revealed[row.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <div className="admin-api-input-row">
                <Cloud size={14} />
                <input value={baseUrl} onChange={(event) => setDrafts((cur) => ({ ...cur, [row.id]: { ...cur[row.id], base_url: event.target.value } }))} placeholder="https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com" aria-label="Base URL workspace" />
                {dirtyDraft(row) && (
                  <button type="button" className="admin-api-save" onClick={() => saveDraft(row)} disabled={busyId === row.id}>
                    {busyId === row.id ? 'Menyimpan…' : 'Simpan'}
                  </button>
                )}
              </div>

              <div className="alibaba-account-foot">
                <span title={row.min_verified_at ? `Key diverifikasi ${new Date(row.min_verified_at).toLocaleString('id-ID')}` : 'Belum pernah diverifikasi'}>
                  <ShieldCheck size={12} aria-hidden="true" /> {row.min_verified_at ? `Terverifikasi ${relTime(row.min_verified_at)}` : 'Belum diverifikasi'}
                </span>
                <span>Dipakai {relTime(row.last_used_at)} · sukses {relTime(row.last_success_at)}</span>
                {row.last_error && <span className="alibaba-account-error" title={row.last_error}>Error terakhir: {row.last_error.slice(0, 80)}</span>}
                <span className="alibaba-account-foot-actions">
                  <button type="button" className="admin-api-verify" onClick={() => verifyAccount(row)} disabled={busyId === row.id}>
                    {busyId === row.id ? 'Memeriksa…' : 'Verifikasi key'}
                  </button>
                  {confirmDeleteId === row.id ? (
                    <>
                      <span className="alibaba-confirm-text">Hapus akun ini?</span>
                      <button type="button" className="admin-confirm-delete" onClick={() => deleteAccount(row)} disabled={busyId === row.id}><Trash2 size={12} /> Ya</button>
                      <button type="button" className="alibaba-icon-btn" onClick={() => setConfirmDeleteId('')} aria-label="Batal hapus"><X size={14} /></button>
                    </>
                  ) : (
                    <button type="button" className="admin-delete-icon" onClick={() => setConfirmDeleteId(row.id)} aria-label="Hapus akun"><Trash2 size={14} /></button>
                  )}
                </span>
              </div>
            </div>
          );
        })
      )}
      <p className="admin-hint is-compact">
        Pool diprioritaskan di atas key tunggal Provider &amp; API Key. Generasi video mencatat akun yang dipakai (provider_key_id) agar polling
        status kembali ke workspace yang sama. Perubahan berlaku langsung; gagal sementara tidak menghapus akun — hanya cooldown.
      </p>
    </section>
  );
}
