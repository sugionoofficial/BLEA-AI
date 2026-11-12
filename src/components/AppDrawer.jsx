import { createContext, useContext, useState } from 'react';
import { Menu, X } from 'lucide-react';

const AppDrawerContext = createContext(null);

export function AppDrawer({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <AppDrawerContext.Provider value={{ open, setOpen }}>
      {children}
    </AppDrawerContext.Provider>
  );
}

export function AppDrawerPanel({ children, variant = 'app' }) {
  const { open, setOpen } = useContext(AppDrawerContext);
  const cfg = variant === 'admin'
    ? { root: 'admin-drawer-root', sidebar: 'admin-sidebar', backdrop: 'admin-drawer-backdrop', close: 'admin-drawer-close' }
    : { root: 'app-drawer-root', sidebar: 'app-sidebar', backdrop: 'app-drawer-backdrop', close: 'app-drawer-close' };
  return (
    <div className={`${cfg.root} ${open ? 'is-open' : ''}`}>
      <button type="button" className={cfg.backdrop} onClick={() => setOpen(false)} aria-label="Tutup navigasi" />
      <aside className={cfg.sidebar} onClick={(event) => {
        if (event.target.closest('a') || event.target.closest('.admin-nav button') || event.target.closest('.app-nav-item')) {
          setOpen(false);
        }
      }}>
        <button type="button" className={cfg.close} onClick={() => setOpen(false)} aria-label="Tutup navigasi"><X size={14} /></button>
        {children}
      </aside>
    </div>
  );
}

export function AppDrawerToggle({ variant = 'app' }) {
  const { setOpen } = useContext(AppDrawerContext) || {};
  const className = variant === 'admin' ? 'admin-nav-toggle' : 'app-nav-toggle';
  return <button type="button" className={className} onClick={() => setOpen?.(true)} aria-label="Buka navigasi"><Menu size={16} /></button>;
}
