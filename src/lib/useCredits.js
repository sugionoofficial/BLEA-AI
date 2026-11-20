import { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase';

// Saldo kredit BLEA milik pengguna yang sedang login. Dipakai di pojok kanan
// atas (semua halaman) dan di halaman Generate agar angkanya konsisten.
export function useCredits(userId) {
  const [balance, setBalance] = useState(null);
  const refresh = useCallback(async () => {
    if (!userId) { setBalance(null); return; }
    try {
      const { data } = await supabase.from('credit_wallets').select('balance').eq('user_id', userId).maybeSingle();
      setBalance(Number(data?.balance ?? 0));
    } catch {
      // Saldo gagal dimuat: biarkan tampilan menampilkan placeholder, jangan melempar.
      setBalance(null);
    }
  }, [userId]);
  useEffect(() => { refresh(); }, [refresh]);
  return { balance, refresh };
}
