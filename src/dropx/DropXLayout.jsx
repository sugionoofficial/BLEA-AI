import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun, X, Bell } from 'lucide-react';
import { navigation, resolveRoute, activeNavHref } from './navigation';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('dropx-theme') || 'light');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('dropx-theme', theme);
  }, [theme]);
  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return { theme, toggle };
}

function NavLinkItem({ item, collapsed, activeHref, pathname, onNavigate }) {
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const childActive = children.some((child) => resolveRoute(child.href) === pathname);
  const [manualOpen, setManualOpen] = useState(null);
  const open = manualOpen ?? childActive;
  const Icon = item.icon;
  const isActive = !hasChildren && item.href === activeHref;

  const itemClass = [
    'dropx-nav-item',
    isActive ? 'is-active' : '',
    collapsed ? 'is-collapsed' : '',
  ].join(' ').trim();

  const content = (
    <>
      {Icon && <Icon className={`icon ${isActive ? 'is-active' : ''}`} />}
      {!collapsed && (
        <>
          <span className="label">{item.title}</span>
          {item.badge && <span className="dropx-nav-badge">{item.badge}</span>}
          {hasChildren && (
            <ChevronDown className={`dropx-nav-chevron ${open ? 'is-open' : ''}`} />
          )}
        </>
      )}
    </>
  );

  if (hasChildren && !collapsed) {
    return (
      <div>
        <button
          type="button"
          className={itemClass}
          onClick={() => setManualOpen(!open)}
          aria-expanded={open}
        >
          {content}
        </button>
        {open && (
          <div className="dropx-nav-sub">
            {children.map((child) => {
              const isChildActive = resolveRoute(child.href) === pathname;
              return (
                <Link
                  key={child.href}
                  to={resolveRoute(child.href)}
                  onClick={onNavigate}
                  className={`dropx-nav-sub-link ${isChildActive ? 'is-active' : ''}`}
                >
                  {child.title}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const target = hasChildren ? resolveRoute(children[0].href) : resolveRoute(item.href);
  return (
    <Link
      to={target}
      onClick={onNavigate}
      title={collapsed ? item.title : undefined}
      aria-label={collapsed ? item.title : undefined}
      className={itemClass}
    >
      {content}
    </Link>
  );
}

export function DropXLayout({ children, title, description, actions }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pathname = location.pathname;
  const activeHref = activeNavHref(pathname);
  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  const isAdmin = user?.app_metadata?.role === 'admin';

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className={`dropx-shell ${collapsed ? 'is-collapsed' : ''} ${mobileOpen ? 'is-mobile-open' : ''}`}>
      <div className="dropx-sidebar-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      <aside className="dropx-sidebar">
        <div className="dropx-sidebar-brand">
          <Link to="/app" className="dropx-sidebar-brand-mark">
            <span className="brand-mark">B</span>
            <span>BLEA AI</span>
          </Link>
          <button type="button" className="dropx-sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Close sidebar">
            <X size={16} />
          </button>
        </div>

        <nav className="dropx-nav" aria-label="Main navigation">
          {navigation.map((group) => (
            <div className="dropx-nav-group" key={group.label}>
              {!collapsed && <p className="dropx-nav-label">{group.label}</p>}
              <div className="dropx-nav-list">
                {group.items.map((item) => (
                  <NavLinkItem
                    key={item.href}
                    item={item}
                    collapsed={collapsed}
                    activeHref={activeHref}
                    pathname={pathname}
                    onNavigate={() => setMobileOpen(false)}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="dropx-sidebar-footer">
          {!collapsed && (
            <button
              type="button"
              className={`dropx-sidebar-profile ${menuOpen ? 'is-open' : ''}`}
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
            >
              <span className="dropx-avatar">{initials}</span>
              <span className="dropx-profile-details">
                <b>{fullName}</b>
                <small>{user?.email}</small>
              </span>
              <ChevronDown size={14} className={`dropx-nav-chevron ${menuOpen ? 'is-open' : ''}`} />
            </button>
          )}
          {collapsed && (
            <button
              type="button"
              className="dropx-sidebar-profile"
              onClick={() => setCollapsed(false)}
              title={fullName}
              aria-label="Expand sidebar"
            >
              <span className="dropx-avatar">{initials}</span>
            </button>
          )}
          {menuOpen && (
            <div className="dropx-profile-menu">
              <div className="dropx-profile-menu-email">{user?.email}</div>
              <Link to="/settings">Pengaturan akun</Link>
              {isAdmin && <Link to="/admin">Admin panel</Link>}
              <button type="button" onClick={signOut} disabled={signingOut}>
                <LogOut size={14} />
                {signingOut ? 'Keluar...' : 'Keluar dari akun'}
              </button>
            </div>
          )}
        </div>
      </aside>

      <div className="dropx-main">
        <header className="dropx-header">
          <button type="button" className="dropx-header-btn" onClick={() => setMobileOpen(true)} aria-label="Open sidebar">
            <Menu size={18} />
          </button>
          <button
            type="button"
            className="dropx-header-btn dropx-collapse-btn"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>

          <div className="dropx-search">
            {searchOpen ? (
              <>
                <Search size={16} />
                <input
                  type="text"
                  placeholder="Search dashboards, apps, components..."
                  autoFocus
                  onBlur={() => setSearchOpen(false)}
                />
              </>
            ) : (
              <>
                <Search size={16} />
                <span style={{ flex: 1, textAlign: 'left', fontSize: 13, color: 'var(--muted-foreground)' }}>
                  Search dashboards, apps, components...
                </span>
                <kbd>Ctrl K</kbd>
              </>
            )}
          </div>

          <div className="dropx-header-actions">
            <button type="button" className="dropx-header-btn" onClick={toggle} aria-label="Toggle theme">
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button type="button" className="dropx-header-btn dropx-bell" aria-label="Notifications">
              <Bell size={16} />
            </button>
            <button type="button" className="dropx-user" onClick={() => setMenuOpen((v) => !v)}>
              <span className="dropx-avatar">{initials}</span>
              <b>{fullName.split(' ')[0]}</b>
            </button>
          </div>
        </header>

        <main className="dropx-content">
          {(title || description) && (
            <div className="dropx-page-header">
              <div>
                <nav className="dropx-breadcrumb">
                  <span>App</span>
                  <span>/</span>
                  <b>{title || 'Dashboard'}</b>
                </nav>
                <div className="dropx-page-title">
                  <h1>{title || 'Dashboard'}</h1>
                  {description && <p>{description}</p>}
                </div>
              </div>
              {actions && <div className="dropx-page-actions">{actions}</div>}
            </div>
          )}
          {children}
          <footer className="dropx-footer">
            <span>© {new Date().getFullYear()} BLEA AI v1.0</span>
            <span>
              Designed &amp; developed by{' '}
              <a href="https://themewagon.com/" target="_blank" rel="noopener noreferrer">
                DropX Admin
              </a>
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
