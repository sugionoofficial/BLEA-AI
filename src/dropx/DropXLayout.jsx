import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, ShieldCheck, Sun, X } from 'lucide-react';
import { activeNavHref, flattenNavigation, getNavigation, resolveRoute } from './navigation';
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

function NavLinkItem({ item, collapsed, activeHref, onNavigate }) {
  const Icon = item.icon;
  const isActive = item.href === activeHref;

  const itemClass = [
    'dropx-nav-item',
    isActive ? 'is-active' : '',
    collapsed ? 'is-collapsed' : '',
  ].join(' ').trim();

  return (
    <Link
      to={resolveRoute(item.href)}
      onClick={onNavigate}
      title={collapsed ? item.title : undefined}
      aria-label={collapsed ? item.title : undefined}
      aria-current={isActive ? 'page' : undefined}
      className={itemClass}
    >
      {Icon && <Icon className={`icon ${isActive ? 'is-active' : ''}`} />}
      {!collapsed && (
        <>
          <span className="label">{item.title}</span>
          {item.badge && <span className="dropx-nav-badge">{item.badge}</span>}
        </>
      )}
    </Link>
  );
}

export function DropXLayout({ children, title, description, actions, footer = true }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [sidebarMenuOpen, setSidebarMenuOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const searchRef = useRef(null);
  const searchInputRef = useRef(null);
  const sidebarMenuRef = useRef(null);
  const headerMenuRef = useRef(null);

  const pathname = location.pathname;
  const isAdmin = user?.app_metadata?.role === 'admin';
  const navGroups = useMemo(() => getNavigation({ isAdmin }), [isAdmin]);
  const searchableItems = useMemo(() => flattenNavigation({ isAdmin }), [isAdmin]);
  const activeHref = activeNavHref(pathname, { isAdmin });

  const filteredSearchItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return searchableItems;
    return searchableItems.filter((item) => {
      const haystack = [item.title, item.description, item.group, ...(item.keywords || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [searchQuery, searchableItems]);

  useEffect(() => {
    setMobileOpen(false);
    setSidebarMenuOpen(false);
    setHeaderMenuOpen(false);
    setSearchOpen(false);
    setSearchQuery('');
  }, [location.pathname]);

  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery, searchOpen]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 0);
      }
      if (e.key === 'Escape') {
        setSearchOpen(false);
        setSidebarMenuOpen(false);
        setHeaderMenuOpen(false);
      }
    };
    const onMouseDown = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setSearchOpen(false);
      }
      if (sidebarMenuRef.current && !sidebarMenuRef.current.contains(e.target)) {
        setSidebarMenuOpen(false);
      }
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target)) {
        setHeaderMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
  const initials = fullName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();

  function openSearch() {
    setSearchOpen(true);
    setTimeout(() => searchInputRef.current?.focus(), 0);
  }

  function selectSearchItem(item) {
    setSearchOpen(false);
    setSearchQuery('');
    navigate(resolveRoute(item.href));
  }

  function handleSearchKeyDown(e) {
    if (!filteredSearchItems.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchIndex((idx) => (idx + 1) % filteredSearchItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchIndex((idx) => (idx - 1 + filteredSearchItems.length) % filteredSearchItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filteredSearchItems[searchIndex] || filteredSearchItems[0];
      if (target) selectSearchItem(target);
    }
  }

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
          <Link to="/app" className="dropx-sidebar-brand-mark" title="BLEA AI">
            <span className="brand-mark">B</span>
            {!collapsed && <span>BLEA AI</span>}
          </Link>
          <button type="button" className="dropx-sidebar-close" onClick={() => setMobileOpen(false)} aria-label="Tutup sidebar">
            <X size={16} />
          </button>
        </div>

        <nav className="dropx-nav" aria-label="Navigasi utama">
          {navGroups.map((group) => (
            <div className="dropx-nav-group" key={group.label}>
              {!collapsed && <p className="dropx-nav-label">{group.label}</p>}
              <div className="dropx-nav-list">
                {group.items.map((item) => (
                  <NavLinkItem
                    key={item.href}
                    item={item}
                    collapsed={collapsed}
                    activeHref={activeHref}
                    onNavigate={() => setMobileOpen(false)}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="dropx-sidebar-footer" ref={sidebarMenuRef}>
          {!collapsed && (
            <button
              type="button"
              className={`dropx-sidebar-profile ${sidebarMenuOpen ? 'is-open' : ''}`}
              onClick={() => setSidebarMenuOpen((v) => !v)}
              aria-expanded={sidebarMenuOpen}
            >
              <span className="dropx-avatar">{initials}</span>
              <span className="dropx-profile-details">
                <b>{fullName}</b>
                <small>{user?.email}</small>
              </span>
              <ChevronDown size={14} className={`dropx-nav-chevron ${sidebarMenuOpen ? 'is-open' : ''}`} />
            </button>
          )}
          {collapsed && (
            <button
              type="button"
              className="dropx-sidebar-profile"
              onClick={() => setCollapsed(false)}
              title={fullName}
              aria-label="Perluas sidebar"
            >
              <span className="dropx-avatar">{initials}</span>
            </button>
          )}
          {sidebarMenuOpen && !collapsed && (
            <div className="dropx-profile-menu">
              <div className="dropx-profile-menu-email">{user?.email}</div>
              <Link to="/settings" onClick={() => setSidebarMenuOpen(false)}>
                <Settings size={14} /> Setting
              </Link>
              {isAdmin && (
                <Link to="/admin" onClick={() => setSidebarMenuOpen(false)}>
                  <ShieldCheck size={14} /> Admin Panel
                </Link>
              )}
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
          <button type="button" className="dropx-header-btn dropx-mobile-btn" onClick={() => setMobileOpen(true)} aria-label="Buka sidebar">
            <Menu size={18} />
          </button>
          <button
            type="button"
            className="dropx-header-btn dropx-collapse-btn"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Perluas sidebar' : 'Ciutkan sidebar'}
          >
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>

          <div className="dropx-search-wrap" ref={searchRef}>
            <div
              className={`dropx-search ${searchOpen ? 'is-open' : ''}`}
              onClick={openSearch}
              role="search"
            >
              <Search size={16} />
              {searchOpen ? (
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Cari menu (Dashboard, Chat AI, Generate...)"
                  aria-label="Cari menu navigasi"
                  autoFocus
                />
              ) : (
                <>
                  <span className="dropx-search-placeholder">
                    Cari menu (Dashboard, Chat AI, Generate...)
                  </span>
                  <kbd>Ctrl K</kbd>
                </>
              )}
            </div>
            {searchOpen && (
              <div className="dropx-search-results" role="listbox" aria-label="Menu navigasi">
                {filteredSearchItems.length ? (
                  filteredSearchItems.map((item, index) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.href}
                        type="button"
                        role="option"
                        aria-selected={index === searchIndex}
                        className={`dropx-search-item ${index === searchIndex ? 'is-highlighted' : ''}`}
                        onMouseEnter={() => setSearchIndex(index)}
                        onClick={() => selectSearchItem(item)}
                      >
                        {Icon && <Icon size={15} className="icon" />}
                        <span className="dropx-search-item-text">
                          <b>{item.title}</b>
                          {item.description && <small>{item.description}</small>}
                        </span>
                        <span className="dropx-search-item-group">{item.group}</span>
                      </button>
                    );
                  })
                ) : (
                  <div className="dropx-search-empty">Tidak ada menu yang cocok.</div>
                )}
              </div>
            )}
          </div>

          <div className="dropx-header-actions">
            <button type="button" className="dropx-header-btn" onClick={toggle} aria-label="Ubah tema" title={theme === 'dark' ? 'Mode terang' : 'Mode gelap'}>
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <div className="dropx-header-user-wrap" ref={headerMenuRef}>
              <button
                type="button"
                className={`dropx-user ${headerMenuOpen ? 'is-open' : ''}`}
                onClick={() => setHeaderMenuOpen((v) => !v)}
                aria-expanded={headerMenuOpen}
                aria-label="Menu akun"
              >
                <span className="dropx-avatar">{initials}</span>
                <b>{fullName.split(' ')[0]}</b>
                <ChevronDown size={13} className={`dropx-nav-chevron ${headerMenuOpen ? 'is-open' : ''}`} />
              </button>
              {headerMenuOpen && (
                <div className="dropx-header-menu">
                  <div className="dropx-profile-menu-email">{user?.email}</div>
                  <Link to="/settings" onClick={() => setHeaderMenuOpen(false)}>
                    <Settings size={14} /> Setting
                  </Link>
                  {isAdmin && (
                    <Link to="/admin" onClick={() => setHeaderMenuOpen(false)}>
                      <ShieldCheck size={14} /> Admin Panel
                    </Link>
                  )}
                  <button type="button" onClick={signOut} disabled={signingOut}>
                    <LogOut size={14} />
                    {signingOut ? 'Keluar...' : 'Keluar dari akun'}
                  </button>
                </div>
              )}
            </div>
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
          {footer && (
            <footer className="dropx-footer">
              <span>© {new Date().getFullYear()} BLEA AI v1.0</span>
              <span>
                Designed &amp; developed by{' '}
                <a href="https://themewagon.com/" target="_blank" rel="noopener noreferrer">
                  DropX Admin
                </a>
              </span>
            </footer>
          )}
        </main>
      </div>
    </div>
  );
}
