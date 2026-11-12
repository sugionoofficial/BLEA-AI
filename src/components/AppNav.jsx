import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  ChevronDown, CircleHelp, Command, Layers3, LogOut, MoreHorizontal,
  Settings2, ShieldCheck, Sparkles, WandSparkles
} from 'lucide-react';
import { Brand } from './Brand';
import { AppDrawerPanel } from './AppDrawer';
import { useAuth } from '../auth/AuthProvider';
import { supabase } from '../lib/supabase';

const navItemClass = ({ isActive }) => `app-nav-item${isActive ? ' active' : ''}`;

export function GlobalNav({ context = null }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const isAdmin = user?.app_metadata?.role === 'admin';
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <>
      <div className="app-sidebar-brand"><Brand /></div>
      <div className="workspace-switcher">
        <span className="workspace-logo"><Sparkles size={15} /></span>
        <span><b>Ruang pribadi</b><small>{isAdmin ? 'Akses administrator' : 'Workspace gratis'}</small></span>
        <ChevronDown size={14} />
      </div>
      <div className="app-nav-label">WORKSPACE</div>
      <NavLink end className={navItemClass} to="/app"><Command size={16} /> Ringkasan</NavLink>
      <NavLink className={navItemClass} to="/projects"><Layers3 size={16} /> Proyek</NavLink>
      <NavLink className={navItemClass} to="/studio"><WandSparkles size={16} /> AI Studio</NavLink>
      {isAdmin && <NavLink className={navItemClass} to="/admin"><ShieldCheck size={16} /> Admin panel</NavLink>}
      {context}
      <div className="app-sidebar-divider" />
      <div className="app-nav-label">PREFERENSI</div>
      <NavLink className={navItemClass} to="/settings"><Settings2 size={16} /> Pengaturan akun</NavLink>
      <a className="app-nav-item" href="mailto:halo@blea.ai"><CircleHelp size={16} /> Bantuan</a>
      <div className="sidebar-spacer" />
      <button className={`sidebar-profile ${menuOpen ? 'is-open' : ''}`} onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>
        <span className="profile-avatar">{initials}</span>
        <span className="profile-details"><b>{fullName}</b><small>{user?.email}</small></span>
        <MoreHorizontal size={17} />
      </button>
      {menuOpen && <div className="profile-menu"><div className="profile-menu-email">{user?.email}</div><Link to="/settings" className="profile-menu-link"><Settings2 size={14} /> Pengaturan akun</Link><button onClick={signOut} disabled={signingOut}><LogOut size={14} />{signingOut ? 'Keluar...' : 'Keluar dari akun'}</button></div>}
    </>
  );
}

export function GlobalNavPanel({ context = null }) {
  return (
    <AppDrawerPanel>
      <GlobalNav context={context} />
    </AppDrawerPanel>
  );
}
