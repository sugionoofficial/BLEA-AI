import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Command, FolderPlus, Layers3, LogOut, MoreHorizontal, Pencil, Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2, WandSparkles, X } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

function formatDate(value) {
  return new Date(value).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ProjectsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [modalProject, setModalProject] = useState(undefined);
  const [deleteProject, setDeleteProject] = useState(null);
  const [profileMenu, setProfileMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionMessage, setActionMessage] = useState('');

  const loadProjects = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setLoadError('');
    const { data, error } = await supabase
      .from('projects')
      .select('id, name, description, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false });
    if (error) {
      console.error('Loading projects failed:', error);
      setLoadError('Proyek belum dapat dimuat. Coba muat ulang halaman.');
    } else {
      setProjects(data ?? []);
    }
    setLoading(false);
  }, [user?.id]);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setModalProject(null);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  function openCreate() {
    setFormError('');
    setModalProject(null);
  }

  function openEdit(project) {
    setFormError('');
    setModalProject(project);
  }

  async function saveProject(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();
    if (!name) {
      setFormError('Nama proyek wajib diisi.');
      return;
    }
    setSaving(true);
    setFormError('');
    setActionMessage('');
    try {
      const result = modalProject
        ? await supabase.from('projects').update({ name, description }).eq('id', modalProject.id).eq('user_id', user.id)
        : await supabase.from('projects').insert({ user_id: user.id, name, description });
      if (result.error) throw result.error;
      setModalProject(undefined);
      setActionMessage(modalProject ? 'Perubahan proyek tersimpan.' : 'Proyek baru berhasil dibuat.');
      await loadProjects();
    } catch (error) {
      console.error('Saving project failed:', error);
      setFormError('Belum berhasil menyimpan proyek. Periksa koneksi lalu coba lagi.');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteProject) return;
    setDeleting(true);
    setActionMessage('');
    const { error } = await supabase.from('projects').delete().eq('id', deleteProject.id).eq('user_id', user.id);
    if (error) {
      console.error('Deleting project failed:', error);
      setActionMessage('Proyek belum berhasil dihapus. Coba lagi.');
    } else {
      setActionMessage(`“${deleteProject.name}” berhasil dihapus.`);
      setDeleteProject(null);
      await loadProjects();
    }
    setDeleting(false);
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  const filteredProjects = projects.filter((project) => `${project.name} ${project.description}`.toLowerCase().includes(search.toLowerCase()));
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  return (
    <div className="app-shell projects-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand"><Brand /></div>
        <div className="workspace-switcher"><span className="workspace-logo"><Sparkles size={15} /></span><span><b>Ruang pribadi</b><small>Workspace gratis</small></span><ChevronDown size={14} /></div>
        <div className="app-nav-label">WORKSPACE</div>
        <Link className="app-nav-item" to="/app"><Command size={16} /> Ringkasan</Link>
        <div className="app-nav-item active"><Layers3 size={16} /> Proyek</div>
        {isAdmin && <Link className="app-nav-item admin-nav-shortcut" to="/admin"><ShieldCheck size={16} /> Admin panel</Link>}
        <Link className="app-nav-item" to="/studio"><WandSparkles size={16} /> AI Studio</Link>
        <div className="app-sidebar-divider" />
        <div className="app-nav-label">PREFERENSI</div>
        <Link className="app-nav-item" to="/settings"><Settings2 size={16} /> Pengaturan akun</Link>
        <a className="app-nav-item" href="mailto:halo@blea.ai"><CircleHelp size={16} /> Bantuan</a>
        <div className="sidebar-spacer" />
        <button className={`sidebar-profile ${profileMenu ? 'is-open' : ''}`} onClick={() => setProfileMenu(!profileMenu)} aria-expanded={profileMenu}><span className="profile-avatar">{initials}</span><span className="profile-details"><b>{fullName}</b><small>{user?.email}</small></span><MoreHorizontal size={17} /></button>
        {profileMenu && <div className="profile-menu"><div className="profile-menu-email">{user?.email}</div><Link to="/settings" className="profile-menu-link"><Settings2 size={14} /> Pengaturan akun</Link><button onClick={signOut}><LogOut size={14} /> Keluar dari akun</button></div>}
      </aside>

      <main className="app-main">
        <header className="app-topbar"><div className="app-breadcrumb"><span>Ruang pribadi</span><span>/</span><b>Proyek</b></div><div className="app-top-actions"><span className="system-status"><i /> Semua sistem beroperasi</span><a href="/" className="website-link">Lihat website <ArrowUpRight size={14} /></a></div></header>
        <div className="app-content projects-content">
          <div className="projects-heading"><div><span className="app-date">RUANG KERJA</span><h1>Proyekmu.</h1><p>Simpan ide dan kembangkan satu langkah demi satu.</p></div><button className="project-create-button" onClick={openCreate}><Plus size={16} /> Proyek baru</button></div>
          <div className="projects-toolbar"><div className="projects-count"><Layers3 size={15} /><span>{projects.length} {projects.length === 1 ? 'proyek' : 'proyek'}</span></div><label className="project-search"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Cari proyek..." aria-label="Cari proyek" /></label></div>
          {actionMessage && <div className="project-feedback" role="status"><Check size={14} />{actionMessage}</div>}
          {loadError && <div className="project-feedback project-feedback-error" role="alert">{loadError}<button onClick={loadProjects}>Coba lagi</button></div>}
          {loading ? <div className="project-loading"><span className="loader-orbit" />Memuat proyekmu...</div> : filteredProjects.length ? <div className="project-grid">{filteredProjects.map((project) => <article className="project-card" key={project.id}><div className="project-card-top"><span className="project-card-icon"><Layers3 size={17} /></span><div className="project-card-actions"><button onClick={() => openEdit(project)} aria-label={`Edit ${project.name}`}><Pencil size={14} /></button><button onClick={() => setDeleteProject(project)} aria-label={`Hapus ${project.name}`}><Trash2 size={14} /></button></div></div><button className="project-name-button" onClick={() => openEdit(project)}>{project.name}<ArrowUpRight size={13} /></button><p className="project-description">{project.description || 'Belum ada deskripsi untuk proyek ini.'}</p><div className="project-card-footer"><span>Diperbarui {formatDate(project.updated_at || project.created_at)}</span><span className="project-owner-dot"><i /> Milikmu</span></div></article>)}</div> : search ? <div className="projects-empty"><div className="project-empty-icon"><Search size={19} /></div><h2>Belum ada yang cocok.</h2><p>Coba kata pencarian lain untuk menemukan proyekmu.</p><button className="project-clear-search" onClick={() => setSearch('')}>Hapus pencarian</button></div> : <div className="projects-empty"><div className="project-empty-icon"><FolderPlus size={20} /></div><span className="empty-kicker">MULAI DENGAN SATU IDE</span><h2>Belum ada proyek.</h2><p>Buat ruang pertama untuk menyimpan ide, catatan, dan rencana yang ingin kamu kembangkan.</p><button className="project-create-button" onClick={openCreate}><Plus size={15} /> Buat proyek pertama</button></div>}
          <footer className="app-footer projects-footer"><span>© 2026 BLEA AI</span><div><span className="footer-status"><i /> Proyek tersimpan aman</span></div></footer>
        </div>
      </main>

      {modalProject !== undefined && <div className="project-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setModalProject(undefined); }}><section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title"><div className="project-modal-head"><span className="project-modal-icon"><Layers3 size={17} /></span><button className="modal-close" onClick={() => setModalProject(undefined)} aria-label="Tutup"><X size={17} /></button></div><span className="app-date">{modalProject ? 'EDIT PROYEK' : 'PROYEK BARU'}</span><h2 id="project-modal-title">{modalProject ? 'Rapikan idemu.' : 'Mulai dari satu ide.'}</h2><p className="project-modal-intro">{modalProject ? 'Perbarui detail proyek ini kapan saja.' : 'Beri nama pada ruang untuk ide yang ingin kamu wujudkan.'}</p><form onSubmit={saveProject} className="project-form"><label><span>Nama proyek</span><input name="name" defaultValue={modalProject?.name || ''} placeholder="Contoh: Brand baru, rencana konten..." maxLength={80} required autoFocus /></label><label><span>Deskripsi <small>OPSIONAL</small></span><textarea name="description" defaultValue={modalProject?.description || ''} placeholder="Apa yang ingin kamu capai dengan proyek ini?" maxLength={500} rows={4} /></label>{formError && <div className="auth-alert auth-alert-error" role="alert">{formError}</div>}<div className="project-form-footer"><span>Maks. 80 karakter untuk nama</span><div><button type="button" className="project-cancel" onClick={() => setModalProject(undefined)}>Batal</button><button type="submit" className="project-create-button" disabled={saving}>{saving ? 'Menyimpan...' : modalProject ? 'Simpan perubahan' : 'Buat proyek'} <ArrowRight size={14} /></button></div></div></form></section></div>}
      {deleteProject && <div className="project-modal-backdrop"><section className="project-modal delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-modal-title"><div className="delete-modal-icon"><Trash2 size={18} /></div><h2 id="delete-modal-title">Hapus proyek ini?</h2><p>“{deleteProject.name}” akan dihapus dari ruang kerjamu. Tindakan ini tidak bisa dibatalkan.</p><div className="delete-modal-actions"><button className="project-cancel" onClick={() => setDeleteProject(null)}>Batal</button><button className="delete-confirm-button" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Menghapus...' : 'Ya, hapus proyek'}</button></div></section></div>}
    </div>
  );
}
