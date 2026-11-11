import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, FolderKanban, LayoutDashboard, LoaderCircle, LogOut, Mail, Search, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

const tabs = [
  { id: 'overview', label: 'Ringkasan', icon: LayoutDashboard },
  { id: 'users', label: 'Pengguna', icon: Users },
  { id: 'projects', label: 'Proyek', icon: FolderKanban },
  { id: 'waitlist', label: 'Waitlist', icon: Mail },
];

const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (value) => value ? dateFormat.format(new Date(value)) : '—';
const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [profiles, setProfiles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMessage('');
    const [profileResult, projectResult, waitlistResult] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,created_at').order('created_at', { ascending: false }).limit(500),
      supabase.from('projects').select('id,user_id,name,description,created_at,updated_at').order('updated_at', { ascending: false }).limit(500),
      supabase.from('waitlist_signups').select('id,email,created_at').order('created_at', { ascending: false }).limit(500),
    ]);
    const errors = [profileResult.error, projectResult.error, waitlistResult.error].filter(Boolean);
    if (errors.length) {
      console.error('Admin data load failed:', errors);
      setErrorMessage('Sebagian data belum bisa dimuat. Pastikan akunmu memiliki role admin lalu coba lagi.');
    } else {
      setProfiles(profileResult.data ?? []);
      setProjects(projectResult.data ?? []);
      setWaitlist(waitlistResult.data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const query = search.trim().toLowerCase();
  const filteredProfiles = profiles.filter((profile) => `${profile.email || ''} ${profile.full_name || ''}`.toLowerCase().includes(query));
  const filteredProjects = projects.filter((project) => `${project.name} ${project.description} ${profileById.get(project.user_id)?.email || ''}`.toLowerCase().includes(query));
  const filteredWaitlist = waitlist.filter((entry) => entry.email.toLowerCase().includes(query));

  async function deleteRecord() {
    if (!deleteTarget) return;
    setDeleting(true);
    const table = deleteTarget.kind === 'project' ? 'projects' : 'waitlist_signups';
    const { error } = await supabase.from(table).delete().eq('id', deleteTarget.id);
    if (error) {
      console.error('Admin delete failed:', error);
      setErrorMessage('Data belum berhasil dihapus. Coba lagi.');
    } else {
      setDeleteTarget(null);
      await loadData();
    }
    setDeleting(false);
  }

  async function exportWaitlist() {
    const csv = ['email,created_at', ...waitlist.map((item) => `${escapeCsv(item.email)},${escapeCsv(item.created_at)}`)].join('\n');
    const file = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const href = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = href;
    link.download = `blea-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  }

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  const activeRows = tab === 'users' ? filteredProfiles : tab === 'projects' ? filteredProjects : filteredWaitlist;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><Brand /></div>
        <div className="admin-console-mark"><span><ShieldCheck size={15} /></span><div><b>Admin console</b><small>BLEA AI management</small></div></div>
        <div className="admin-nav-label">PENGELOLAAN</div>
        <nav className="admin-nav" aria-label="Navigasi admin">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setSearch(''); }}><Icon size={16} /><span>{label}</span>{id === 'users' && <small>{profiles.length}</small>}{id === 'projects' && <small>{projects.length}</small>}{id === 'waitlist' && <small>{waitlist.length}</small>}</button>)}</nav>
        <div className="admin-sidebar-bottom"><span className="admin-live"><i /> ADMIN MODE</span><button onClick={signOut} disabled={signingOut}><LogOut size={14} />{signingOut ? 'Keluar...' : 'Keluar'}</button></div>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar"><div className="admin-breadcrumb"><span>BLEA AI</span><ChevronRight size={13} /><b>{tabs.find((item) => item.id === tab)?.label}</b></div><div className="admin-top-actions"><span className="admin-access"><ShieldCheck size={13} /> Akses administrator</span><Link to="/app" className="admin-back-link"><ArrowLeft size={14} /> Kembali ke aplikasi</Link></div></header>
        <div className="admin-content">
          <div className="admin-heading"><div><span className="admin-eyebrow"><i /> ADMINISTRATOR</span><h1>{tab === 'overview' ? 'Pusat kendali.' : tab === 'users' ? 'Pengguna.' : tab === 'projects' ? 'Semua proyek.' : 'Daftar tunggu.'}</h1><p>{tab === 'overview' ? 'Kelola pengguna dan konten BLEA AI dari satu tempat.' : tab === 'users' ? 'Akun yang sudah terdaftar di BLEA AI.' : tab === 'projects' ? 'Pantau dan kelola proyek di semua workspace.' : 'Email yang meminta akses awal BLEA AI.'}</p></div><div className="admin-heading-meta"><span><Clock3 size={13} /> {new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</span><span className="admin-user-chip"><i>{(user?.user_metadata?.full_name || user?.email || 'A').slice(0, 1).toUpperCase()}</i>{user?.email}</span></div></div>
          {errorMessage && <div className="admin-error" role="alert">{errorMessage}<button onClick={loadData}>Coba lagi</button></div>}
          {tab === 'overview' && <>
            <section className="admin-metrics"><article><span className="metric-icon metric-purple"><Users size={17} /></span><span className="metric-label">PENGGUNA</span><b>{loading ? '—' : profiles.length}</b><small>Akun terdaftar</small></article><article><span className="metric-icon metric-blue"><FolderKanban size={17} /></span><span className="metric-label">PROYEK</span><b>{loading ? '—' : projects.length}</b><small>Di semua workspace</small></article><article><span className="metric-icon metric-peach"><Mail size={17} /></span><span className="metric-label">WAITLIST</span><b>{loading ? '—' : waitlist.length}</b><small>Pendaftar akses awal</small></article><article><span className="metric-icon metric-green"><Activity size={17} /></span><span className="metric-label">SISTEM</span><b className="metric-status">Aktif</b><small>Auth & database tersedia</small></article></section>
            <section className="admin-overview-grid"><article className="admin-overview-card"><div className="admin-card-heading"><div><span className="admin-eyebrow">AKTIVITAS TERBARU</span><h2>Pengguna terbaru</h2></div><button onClick={() => setTab('users')}>Semua <ArrowUpRight size={13} /></button></div>{loading ? <div className="admin-skeleton" /> : profiles.slice(0, 5).map((profile) => <div className="admin-activity-row" key={profile.id}><span className="admin-avatar">{(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}</span><span className="admin-row-main"><b>{profile.full_name || 'Nama belum diatur'}</b><small>{profile.email || '—'}</small></span><small className="admin-row-date">{formatDate(profile.created_at)}</small></div>)}{!loading && profiles.length === 0 && <div className="admin-empty-inline">Belum ada pengguna terdaftar.</div>}</article><article className="admin-overview-card"><div className="admin-card-heading"><div><span className="admin-eyebrow">KONTEN TERBARU</span><h2>Proyek terbaru</h2></div><button onClick={() => setTab('projects')}>Semua <ArrowUpRight size={13} /></button></div>{loading ? <div className="admin-skeleton" /> : projects.slice(0, 5).map((project) => <div className="admin-activity-row" key={project.id}><span className="admin-project-icon"><FolderKanban size={14} /></span><span className="admin-row-main"><b>{project.name}</b><small>{profileById.get(project.user_id)?.email || 'Akun tidak ditemukan'}</small></span><small className="admin-row-date">{formatDate(project.updated_at)}</small></div>)}{!loading && projects.length === 0 && <div className="admin-empty-inline">Belum ada proyek.</div>}</article></section>
            <section className="admin-note"><ShieldCheck size={16} /><div><b>Akses admin terlindungi.</b><p>Panel ini dan operasi datanya diproteksi oleh role `app_metadata` serta Row Level Security di Supabase.</p></div><span>RLS ACTIVE</span></section>
          </>}

          {tab !== 'overview' && <section className="admin-table-card"><div className="admin-table-toolbar"><label className="admin-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'users' ? 'Cari nama atau email...' : tab === 'projects' ? 'Cari proyek atau pemilik...' : 'Cari email waitlist...'} /></label>{tab === 'waitlist' && <button className="admin-export-button" onClick={exportWaitlist} disabled={!waitlist.length}><ArrowDownToLine size={14} /> Ekspor CSV</button>}<button className="admin-refresh-button" onClick={loadData} disabled={loading}><LoaderCircle size={14} className={loading ? 'spinning' : ''} /> Muat ulang</button></div>
            <div className="admin-table-scroll"><table><thead><tr>{tab === 'users' ? <><th>PENGGUNA</th><th>ID AKUN</th><th>BERGABUNG</th><th>STATUS</th></> : tab === 'projects' ? <><th>NAMA PROYEK</th><th>PEMILIK</th><th>DIPERBARUI</th><th></th></> : <><th>EMAIL</th><th>MENDAFTAR</th><th></th></>}</tr></thead><tbody>
              {loading ? <tr><td colSpan={4} className="admin-table-message">Memuat data...</td></tr> : tab === 'users' ? filteredProfiles.map((profile) => <tr key={profile.id}><td><span className="admin-user-cell"><i className="admin-avatar">{(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}</i><span><b>{profile.full_name || 'Nama belum diatur'}</b><small>{profile.email || '—'}</small></span></span></td><td className="admin-id-cell">{profile.id.slice(0, 8)}…</td><td>{formatDate(profile.created_at)}</td><td><span className="admin-status-pill"><i /> Terdaftar</span></td></tr>) : tab === 'projects' ? filteredProjects.map((project) => <tr key={project.id}><td><span className="admin-project-cell"><b>{project.name}</b><small>{project.description || 'Tanpa deskripsi'}</small></span></td><td>{profileById.get(project.user_id)?.email || '—'}</td><td>{formatDate(project.updated_at)}</td><td><button className="admin-delete-icon" aria-label={`Hapus ${project.name}`} onClick={() => setDeleteTarget({ kind: 'project', id: project.id, label: project.name })}><Trash2 size={14} /></button></td></tr>) : filteredWaitlist.map((entry) => <tr key={entry.id}><td><b className="admin-email-cell">{entry.email}</b></td><td>{formatDate(entry.created_at)}</td><td><button className="admin-delete-icon" aria-label={`Hapus ${entry.email} dari waitlist`} onClick={() => setDeleteTarget({ kind: 'waitlist', id: entry.id, label: entry.email })}><Trash2 size={14} /></button></td></tr>)}
              {!loading && activeRows.length === 0 && <tr><td colSpan={4} className="admin-table-message">{query ? 'Tidak ada hasil yang cocok.' : 'Belum ada data.'}</td></tr>}
            </tbody></table></div><div className="admin-table-footer"><span>Menampilkan {activeRows.length} dari {tab === 'users' ? profiles.length : tab === 'projects' ? projects.length : waitlist.length} data (maks. 500)</span><span>Perubahan tersimpan langsung</span></div>
          </section>}
          <footer className="admin-footer"><span>BLEA AI · Admin console</span><span><i /> Hanya administrator terverifikasi</span></footer>
        </div>
      </main>
      {deleteTarget && <div className="admin-modal-backdrop"><section className="admin-delete-modal" role="dialog" aria-modal="true" aria-labelledby="admin-delete-title"><button className="admin-modal-close" onClick={() => setDeleteTarget(null)} aria-label="Tutup"><X size={16} /></button><span className="admin-delete-icon-large"><Trash2 size={19} /></span><h2 id="admin-delete-title">Hapus data ini?</h2><p><b>{deleteTarget.label}</b> akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.</p><div><button className="admin-cancel-button" onClick={() => setDeleteTarget(null)}>Batal</button><button className="admin-confirm-delete" onClick={deleteRecord} disabled={deleting}>{deleting ? 'Menghapus...' : 'Ya, hapus'}</button></div></section></div>}
    </div>
  );
}
