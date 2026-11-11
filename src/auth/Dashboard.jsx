import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, AudioLines, Bell, Check, ChevronDown, CircleHelp, Command, Layers3, LogOut, MessageCircle, MoreHorizontal, Plus, Settings2, Sparkles, WandSparkles } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

const soonItems = [
  { label: 'AI Studio', icon: WandSparkles },
  { label: 'Asisten', icon: MessageCircle },
  { label: 'Proyek', icon: Layers3 },
];

export function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const firstName = fullName.trim().split(/\s+/)[0];
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  async function handleSignOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand"><Brand /></div>
        <div className="workspace-switcher"><span className="workspace-logo"><Sparkles size={15} /></span><span><b>Ruang pribadi</b><small>Workspace gratis</small></span><ChevronDown size={14} /></div>
        <div className="app-nav-label">WORKSPACE</div>
        <Link className="app-nav-item active" to="/app"><Command size={16} /> Ringkasan</Link>
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
      </aside>

      <main className="app-main">
        <header className="app-topbar"><div className="app-breadcrumb"><span>Ruang pribadi</span><span>/</span><b>Ringkasan</b></div><div className="app-top-actions"><span className="system-status"><i /> Semua sistem beroperasi</span><button className="icon-button" aria-label="Notifikasi"><Bell size={16} /><i /></button><a href="/" className="website-link">Lihat website <ArrowUpRight size={14} /></a></div></header>
        <div className="app-content">
          <div className="app-greeting-row"><div><span className="app-date">RUANG KERJA • BLEA AI</span><h1>Selamat datang, {firstName}<span className="greeting-star"> ✳</span></h1><p>Satu ruang untuk ide-ide yang ingin kamu wujudkan.</p></div><button className="app-new-button" disabled title="AI Studio segera hadir"><Plus size={16} /> Proyek baru <span>Segera</span></button></div>

          <section className="welcome-panel"><div className="welcome-copy"><div className="welcome-icon"><Sparkles size={18} /></div><span className="welcome-eyebrow">LANGKAH PERTAMA</span><h2>Ruang kreatifmu<br />sudah siap.</h2><p>Akunmu aktif. Kami sedang merapikan AI Studio agar kamu bisa mengembangkan ide, menulis, dan mengelola proyek di satu tempat.</p><div className="welcome-actions"><span className="account-ready"><Check size={13} /> Akun terhubung</span><a href="mailto:halo@blea.ai?subject=BLEA%20AI%20early%20access">Minta akses awal <ArrowRight size={14} /></a></div></div><div className="welcome-art"><div className="welcome-art-orbit orbit-a" /><div className="welcome-art-orbit orbit-b" /><div className="welcome-art-core"><Sparkles size={24} /></div><span className="welcome-art-dot dot-a" /><span className="welcome-art-dot dot-b" /><span className="welcome-art-label">IDE → NYATA</span></div></section>

          <div className="dashboard-section-heading"><div><span className="app-date">RUANG KERJAMU</span><h2>Mulai dengan tenang.</h2></div><button className="filter-button" disabled>Semua aktivitas <ChevronDown size={14} /></button></div>
          <section className="empty-projects"><div className="empty-illustration"><div className="empty-illustration-ring"><div><Layers3 size={20} /></div></div><span className="empty-star star-left">✦</span><span className="empty-star star-right">✳</span></div><span className="empty-kicker">BELUM ADA PROYEK</span><h3>Setiap karya hebat dimulai dari satu ide.</h3><p>Proyek, percakapan, dan kreasi AI-mu akan berkumpul di sini setelah AI Studio dibuka.</p><button className="empty-cta" disabled>AI Studio segera hadir <ArrowRight size={15} /></button></section>

          <section className="account-strip"><span className="account-strip-icon"><AudioLines size={16} /></span><div><b>Perlu bantuan atau ingin memberi masukan?</b><p>Kami senang mendengar apa yang ingin kamu ciptakan dengan BLEA.</p></div><a href="mailto:halo@blea.ai">Hubungi tim <ArrowUpRight size={14} /></a></section>
          <footer className="app-footer"><span>© 2026 BLEA AI</span><div><a href="#privasi">Privasi</a><a href="#ketentuan">Ketentuan</a><span className="footer-status"><i /> Terenkripsi dan aman</span></div></footer>
        </div>
      </main>
    </div>
  );
}
