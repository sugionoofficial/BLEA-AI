import { useCallback, useEffect, useState } from 'react';
import { Link2, RefreshCw, Unplug } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import './freebeat.css';

async function request(action, method = 'GET') {
  const { data } = await supabase.auth.getSession();
  let session = data?.session;
  if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) session = (await supabase.auth.refreshSession()).data?.session;
  if (!session?.access_token) throw new Error('Sesi login berakhir. Silakan login kembali.');
  const res = await fetch(`/api/freebeat/${action}`, { method, headers: { authorization: `Bearer ${session.access_token}` }, credentials: 'same-origin', cache: 'no-store' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Freebeat tidak dapat dihubungi.');
  return payload;
}

const resultMessage = {
  connected: 'Otorisasi Freebeat berhasil. Tekan Periksa saldo untuk menguji MCP.',
  denied: 'Otorisasi dibatalkan atau ditolak oleh Freebeat.',
  invalid: 'Sesi otorisasi tidak cocok atau kedaluwarsa. Coba hubungkan kembali.',
  failed: 'Otorisasi Freebeat tidak berhasil. Coba lagi atau periksa akses akun Anda.',
};

export function FreebeatPage() {
  const [connected, setConnected] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    try { const result = await request('status'); setConnected(result.connected); setExpiresAt(result.expiresAt); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('freebeat');
    if (result && resultMessage[result]) {
      if (result === 'connected') setNotice(resultMessage[result]); else setError(resultMessage[result]);
      url.searchParams.delete('freebeat');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    load();
  }, [load]);
  async function run(action) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (action === 'start') {
        const result = await request('start', 'POST');
        const url = new URL(result.url);
        if (url.origin !== 'https://freebeat.ai' || url.pathname !== '/oauth/authorize') throw new Error('Alamat otorisasi Freebeat tidak valid.');
        window.location.assign(url.toString());
        return;
      }
      if (action === 'balance') {
        const result = await request('balance', 'POST');
        setBalance(result.balance);
        setNotice('Permintaan baca saldo selesai tanpa menjalankan generasi.');
      } else {
        const result = await request('disconnect', 'POST');
        setConnected(false); setExpiresAt(null); setBalance(null);
        setNotice(result.revoked ? 'Koneksi lokal dihapus dan token dicabut di Freebeat.' : 'Koneksi lokal dihapus. Pencabutan token di Freebeat belum dapat dikonfirmasi; periksa pengaturan akses di akun Freebeat.');
      }
    } catch (err) { setError(err.message || 'Koneksi gagal.'); }
    finally { setBusy(false); }
  }
  return <DropXLayout title="Freebeat MCP" description="Uji koneksi Freebeat khusus admin.">
    <div className="freebeat-page">
      <section className="freebeat-card">
        <span className="freebeat-kicker">MCP · OAUTH · READ ONLY</span><h2>Hubungkan Freebeat</h2>
        <p>Uji koneksi resmi MCP dan baca saldo akun Freebeat Anda. Fitur ini tidak membuat video atau gambar dan tidak menghabiskan kredit.</p>
        <p>Koneksi uji tersimpan terenkripsi dalam cookie HttpOnly pada browser admin ini, bukan dibagikan ke pengguna lain. Koneksi bersifat sementara dan perlu dihubungkan ulang setelah kedaluwarsa.</p>
        <p>Menurut ketentuan Freebeat, kredit gratis hanya untuk penggunaan nonkomersial. Pastikan penggunaan Anda sesuai ketentuan penyedia.</p>
        {error && <div className="freebeat-alert is-error" role="alert">{error}</div>}
        {notice && <div className="freebeat-alert" role="status">{notice}</div>}
        <div className="freebeat-status"><strong>Status:</strong> {loading ? 'Memeriksa…' : connected ? 'Terhubung di browser ini' : 'Belum terhubung'}{connected && expiresAt && <> · Berakhir {new Date(expiresAt).toLocaleString('id-ID')}</>}</div>
        <div className="freebeat-actions">
          <button type="button" disabled={busy || loading} onClick={() => run('start')}><Link2 size={15} /> {connected ? 'Hubungkan ulang' : 'Hubungkan Freebeat'}</button>
          <button type="button" className="is-secondary" disabled={busy || loading || !connected} onClick={() => run('balance')}><RefreshCw size={15} /> Periksa saldo</button>
          {connected && <button type="button" className="is-secondary" disabled={busy} onClick={() => run('disconnect')}><Unplug size={15} /> Putuskan</button>}
        </div>
        {balance !== null && <div className="freebeat-result"><h3>Respons saldo dari Freebeat</h3><pre>{typeof balance === 'string' ? balance : JSON.stringify(balance, null, 2)}</pre></div>}
      </section>
    </div>
  </DropXLayout>;
}
