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

export function AppDrawerPanel({ children }) {
  const { open, setOpen } = useContext(AppDrawerContext);
  return (
    <div className={`app-drawer-root ${open ? 'is-open' : ''}`}>
      <button type="button" className="app-drawer-backdrop" onClick={() => setOpen(false)} aria-label="Tutup navigasi" />
      <aside className="app-sidebar" onClick={(event) => {
        if (event.target.closest('.sidebar-profile, .profile-menu, .studio-profile-button')) return;
        if (event.target.closest('a') || event.target.closest('.app-nav-item') || event.target.closest('.studio-history-item') || event.target.closest('.studio-new-chat')) {
          setOpen(false);
        }
      }}>
        <button type="button" className="app-drawer-close" onClick={() => setOpen(false)} aria-label="Tutup navigasi"><X size={14} /></button>
        {children}
      </aside>
    </div>
  );
}

export function AppDrawerToggle() {
  const { setOpen } = useContext(AppDrawerContext) || {};
  return <button type="button" className="app-nav-toggle" onClick={() => setOpen?.(true)} aria-label="Buka navigasi"><Menu size={16} /></button>;
}
