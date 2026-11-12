import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, AudioLines, Bell, Check, ChevronDown, CircleHelp, Command, Layers3, LogOut, MessageCircle, MoreHorizontal, Plus, Settings2, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react';
import { Brand } from '../components/Brand';
import { AppDrawer, AppDrawerPanel, AppDrawerToggle } from '../components/AppDrawer';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

const soonItems = [
  { label: 'Asisten', icon: MessageCircle },
];

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const firstName = fullName.trim().split(/\s+/)[0];
  const isAdmin = user?.app_metadata?.role === 'admin';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const [recentProjects, setRecentProjects] = useState([]);

  useEffect(() => {
    if (!user?.id) return;
    supabase.from('projects')
      .select('id, name, description, created_at, updated_at')
      .eq('user_id', user.id)
      .order('updated_at', { ascending: false })
      .limit(3)
      .then(({ data, error }) => {
        if (error) console.error('Loading recent projects failed:', error);
        else setRecentProjects(data ?? []);
      });
  }, [user?.id]);

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <AppDrawer>
        <AppDrawerPanel>
        <div className="app-sidebar-brand"><Brand /></div>
        <div className="workspace-switcher"><span className="workspace-logo"><Sparkles size={15} /></span><span><b>Ruang pribadi</b><small>Workspace gratis</small></span><ChevronDown size={14} /></div>
        <div className="app-nav-label">WORKSPACE</div>
        <Link className="app-nav-item active" to="/app"><Command size={16} /> Ringkasan</Link>
        <Link className="app-nav-item" to="/projects"><Layers3 size={16} /> Proyek</Link>
        <Link className="app-nav-item" to="/studio"><WandSparkles size={16} /> AI Studio</Link>
        {isAdmin && <Link className="app-nav-item admin-nav-shortcut" to="/admin"><ShieldCheck size={16} /> Admin panel</Link>}
        {soonItems.map(({ label, icon: Icon }) => <div className="app-nav-item disabled" key={label}><Icon size={16} /><span>{label}</span><small>Segera</small></div>)}
        <div className="app-sidebar-divider" />
        <div className="app-nav-label">PREFERENSI</div>
        <Link className="app-nav-item" to="/settings"><Settings2 size={16} /> Pengaturan akun</Link>
        <a className="app-nav-item" href="mailto:halo@blea.ai"><CircleHelp size={16} /> Bantuan</a>
        <div className="sidebar-spacer" />
        <button className={`sidebar-profile ${menuOpen ? 'is-open' : ''}`} onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>
          <span className="profile-avatar">{initials}</span><span className="profile-details"><b>{fullName}</b><small>{user?.email}</small></span><MoreHorizontal size={17} />
        </button>
        {menuOpen && <div className="profile-menu"><div className="profile-menu-email">{user?.email}</div><Link to="/settings" className="profile-menu-link"><Settings2 size={14} /> Pengaturan akun</Link><button onClick={handleSignOut} disabled={signingOut}><LogOut size={14} />{signingOut ? 'Keluar...' : 'Keluar dari akun'}</button></div>}
        </AppDrawerPanel>

      <main className="app-main">
        <header className="app-topbar"><AppDrawerToggle /><div className="app-breadcrumb"><span>Ruang pribadi</span><span>/</span><b>Ringkasan</b></div><div className="app-top-actions"><span className="system-status"><i /> Semua sistem beroperasi</span><button className="icon-button" aria-label="Notifikasi"><Bell size={16} /><i /></button><a href="/" className="website-link">Lihat website <ArrowUpRight size={14} /></a></div></header>
        <div className="app-content">
          <div className="app-greeting-row"><div><span className="app-date">RUANG KERJA • BLEA AI</span><h1>Selamat datang, {firstName}<span className="greeting-star"> ✳</span></h1><p>Satu ruang untuk ide-ide yang ingin kamu wujudkan.</p></div><Link className="app-new-button" to="/projects?new=1"><Plus size={16} /> Proyek baru</Link></div>

          <section className="welcome-panel"><div className="welcome-copy"><div className="welcome-icon"><Sparkles size={18} /></div><span className="welcome-eyebrow">LANGKAH PERTAMA</span><h2>Ruang kreatifmu<br />sudah siap.</h2><p>Akunmu aktif. AI Studio sudah bisa dipakai untuk menyimpan ide dan prompt; jawaban AI akan aktif setelah provider model terhubung.</p><div className="welcome-actions"><span className="account-ready"><Check size={13} /> Akun terhubung</span><Link to="/studio">Coba AI Studio <ArrowRight size={14} /></Link></div></div><div className="welcome-art"><div className="welcome-art-orbit orbit-a" /><div className="welcome-art-orbit orbit-b" /><div className="welcome-art-core"><Sparkles size={24} /></div><span className="welcome-art-dot dot-a" /><span className="welcome-art-dot dot-b" /><span className="welcome-art-label">IDE → NYATA</span></div></section>

          <div className="dashboard-section-heading"><div><span className="app-date">RUANG KERJAMU</span><h2>Proyek terbaru.</h2></div><Link className="dashboard-view-all" to="/projects">Lihat semua <ArrowRight size={13} /></Link></div>
          {recentProjects.length ? <div className="dashboard-project-list">{recentProjects.map((project) => <Link className="dashboard-project-row" to="/projects" key={project.id}><span className="dashboard-project-icon"><Layers3 size={15} /></span><span className="dashboard-project-info"><b>{project.name}</b><small>{project.description || 'Proyek kreatif'}</small></span><span className="dashboard-project-date">{new Date(project.updated_at || project.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</span><ArrowUpRight size={14} /></Link>)}<Link to="/projects" className="dashboard-projects-link">Lihat semua proyek <ArrowRight size={13} /></Link></div> : <section className="empty-projects"><div className="empty-illustration"><div className="empty-illustration-ring"><div><Layers3 size={20} /></div></div><span className="empty-star star-left">✦</span><span className="empty-star star-right">✳</span></div><span className="empty-kicker">MULAI DENGAN SATU IDE</span><h3>Setiap karya hebat dimulai dari satu ide.</h3><p>Buat proyek pertama untuk menyimpan ide, catatan, dan rencana yang ingin kamu kembangkan.</p><Link className="empty-cta" to="/projects?new=1">Buat proyek pertamamu <ArrowRight size={15} /></Link></section>}

          <section className="account-strip"><span className="account-strip-icon"><AudioLines size={16} /></span><div><b>Perlu bantuan atau ingin memberi masukan?</b><p>Kami senang mendengar apa yang ingin kamu ciptakan dengan BLEA.</p></div><a href="mailto:halo@blea.ai">Hubungi tim <ArrowUpRight size={14} /></a></section>
          <footer className="app-footer"><span>© 2026 BLEA AI</span><div><a href="#privasi">Privasi</a><a href="#ketentuan">Ketentuan</a><span className="footer-status"><i /> Terenkripsi dan aman</span></div></footer>
        </div>
      </main>
      </AppDrawer>
    </div>
  );
}
