import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, ShoppingBag, Wallet } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import { Pager, PerPageSelect, usePagedList } from '../components/Pagination';
import './credits.css';

const number = (value) => Number(value).toLocaleString('id-ID');
const date = (value) => new Date(value).toLocaleString('id-ID');

// Semua baris ledger milik pengguna (diambil per 1.000 baris; total pembelian /
// pemakaian sendiri dihitung server-side oleh credit_wallet_totals() supaya
// tidak terpotong limit baris API).
async function fetchAllLedger(userId) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; from < 10000; from += pageSize) {
    const { data, error } = await supabase
      .from('credit_ledger')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

export function CreditHistoryPage() {
  const { user } = useAuth();
  const [ledger, setLedger] = useState([]);
  const [totals, setTotals] = useState({ total_purchased: 0, total_spent: 0, balance: 0 });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const { perPage, setPerPage, page, setPage, pageCount, slice, total } = usePagedList(ledger);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    setError('');
    try {
      const [rows, totalsRes] = await Promise.all([
        fetchAllLedger(user.id),
        supabase.rpc('credit_wallet_totals'),
      ]);
      setLedger(rows);
      const row = Array.isArray(totalsRes.data) ? totalsRes.data[0] : totalsRes.data;
      if (!totalsRes.error && row) {
        setTotals({
          total_purchased: Number(row.total_purchased) || 0,
          total_spent: Number(row.total_spent) || 0,
          balance: Number(row.balance) || 0,
        });
      } else {
        // Fallback: hitung dari baris yang termuat bila RPC belum aktif.
        const purchased = rows.filter((entry) => entry.delta > 0 && entry.order_id).reduce((sum, entry) => sum + Number(entry.delta), 0);
        const spent = rows.filter((entry) => entry.delta < 0).reduce((sum, entry) => sum + Number(-entry.delta), 0);
        setTotals((previous) => ({ total_purchased: purchased, total_spent: spent, balance: previous.balance }));
      }
      setLoaded(true);
    } catch (err) {
      setError(`Riwayat kredit belum dapat dimuat: ${err.message || 'coba lagi'}`);
    } finally { setLoading(false); }
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  return (
    <DropXLayout title="Riwayat Kredit" description="Total pembelian, pemakaian, dan transaksi kredit Anda.">
      <div className="credits-page">
        {error && <div role="alert" className="credits-error">{error}</div>}
        {loading ? <p role="status">Memuat riwayat kredit…</p> : !loaded && !error ? <button type="button" onClick={load}>Coba lagi</button> : (
          <>
            <section className="credits-stats" aria-label="Ringkasan kredit">
              <article className="credits-stat">
                <span className="credits-stat-icon is-in"><ShoppingBag size={20} /></span>
                <div><small>Total pembelian kredit</small><strong>{number(totals.total_purchased)}</strong><span>kredit masuk dari pesanan</span></div>
              </article>
              <article className="credits-stat">
                <span className="credits-stat-icon is-out"><ArrowDownRight size={20} /></span>
                <div><small>Total pemakaian kredit</small><strong>{number(totals.total_spent)}</strong><span>kredit terpakai generasi</span></div>
              </article>
              <article className="credits-stat">
                <span className="credits-stat-icon is-balance"><Wallet size={20} /></span>
                <div><small>Sisa kredit saat ini</small><strong>{number(totals.balance)}</strong><span>saldo yang bisa dipakai</span></div>
              </article>
            </section>

            <section className="credits-card">
              <div className="credits-card-head">
                <div>
                  <h2>Transaksi kredit</h2>
                  <p>Setiap pemakaian atau refund yang terhubung dengan hasil generasi bisa dibuka langsung di halaman History.</p>
                </div>
                <PerPageSelect id="ledger-per-page" value={perPage} onChange={setPerPage} />
              </div>
              {!ledger.length ? (
                <p>Belum ada transaksi kredit. Beli paket di halaman Kredit untuk mulai memakai kredit.</p>
              ) : (
                <>
                  {slice.map((entry) => (
                    <div className="credits-row credits-ledger credits-ledger-full" key={entry.id}>
                      <div>
                        <strong>{entry.description}</strong>
                        <small>{date(entry.created_at)}</small>
                      </div>
                      <div className="credits-row-side">
                        <strong className={entry.delta >= 0 ? 'credits-delta-in' : 'credits-delta-out'}>
                          {entry.delta > 0 ? '+' : ''}{number(entry.delta)}
                        </strong>
                        {entry.generation_id && (
                          <Link className="credits-result-link" to={`/history?highlight=${entry.generation_id}`}>
                            Lihat hasil di History <ArrowUpRight size={13} />
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
                  <Pager page={page} pageCount={pageCount} total={total} onPage={setPage} />
                </>
              )}
            </section>
            <p className="credits-method-note"><Link to="/credits">← Kembali ke halaman Kredit</Link></p>
          </>
        )}
      </div>
    </DropXLayout>
  );
}
