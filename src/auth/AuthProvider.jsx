import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ACCOUNT_BLOCKED_EVENT, edgeRequest } from '../api/client';

const AuthContext = createContext(null);

export function AuthProvider({ children, initialSession = null }) {
  const [session, setSession] = useState(initialSession);
  const [loading, setLoading] = useState(!initialSession);
  // null = belum tahu; { status, blocked, message } = hasil /api/account (fix39).
  const [account, setAccount] = useState(null);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) console.error('Unable to read auth session:', error);
      setSession(data?.session ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  // Akun yang ditangguhkan tetap bisa membaca /api/account (satu-satunya jalur
  // yang dikecualikan gerbang), jadi pesannya bisa ditampilkan di pintu masuk.
  // Kegagalan membaca (worker belum aktif di pratinjau lokal, jaringan) TIDAK
  // boleh mengunci user.
  const loadAccount = useCallback(async (target) => {
    if (!target) { setAccount(null); return; }
    try {
      const res = await edgeRequest('/account', {});
      if (!res?.ok || res.workerUnavailable || res.data?.ok !== true) return;
      setAccount({
        status: res.data.status || 'active',
        blocked: res.data.blocked === true,
        message: res.data.message || null,
      });
    } catch { /* gagal baca status = tidak memblokir */ }
  }, []);

  useEffect(() => { loadAccount(session); }, [session, loadAccount]);

  // Status bisa berubah di tengah sesi: setiap 403 ber-kode account_* dari
  // jalur API mana pun langsung menutup pintu.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onBlocked = (event) => {
      const detail = event?.detail || {};
      setAccount({
        status: detail.account_status || 'suspended',
        blocked: true,
        message: detail.error || 'Akun Anda tidak dapat mengakses BLEA saat ini. Hubungi admin BLEA.',
      });
    };
    window.addEventListener(ACCOUNT_BLOCKED_EVENT, onBlocked);
    return () => window.removeEventListener(ACCOUNT_BLOCKED_EVENT, onBlocked);
  }, []);

  const signOut = useCallback(async () => {
    try { await supabase.auth.signOut(); } catch { /* sesi lokal tetap dibersihkan */ }
    setSession(null);
    setAccount(null);
  }, []);

  const value = useMemo(() => ({
    session,
    user: session?.user ?? null,
    loading,
    account,
    accountBlocked: account?.blocked === true,
    accountMessage: account?.message || null,
    accountStatus: account?.status || null,
    refreshAccount: loadAccount,
    signOut,
  }), [session, loading, account, loadAccount, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
