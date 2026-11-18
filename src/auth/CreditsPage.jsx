import { useCallback, useEffect, useState } from 'react';
import { Coins } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import './credits.css';

const labels = { awaiting_payment: 'Menunggu transfer', pending_review: 'Menunggu verifikasi', approved: 'Disetujui', rejected: 'Ditolak', cancelled: 'Dibatalkan' };
const rupiah = (value) => `Rp${Number(value).toLocaleString('id-ID')}`;
const number = (value) => Number(value).toLocaleString('id-ID');
const date = (value) => new Date(value).toLocaleString('id-ID');
const blankPackage = { name: '', credits: '', price_idr: '', active: true };
const blankPrice = { provider: 'freebeat', model: '', modality: 'video', credits: '', active: true };

export function CreditsPage() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [data, setData] = useState({ packages: [], prices: [], orders: [], ledger: [], reviews: [], profiles: [], wallet: null, settings: null });
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [references, setReferences] = useState({});
  const [instructions, setInstructions] = useState('');
  const [packageForm, setPackageForm] = useState(blankPackage);
  const [editingId, setEditingId] = useState(null);
  const [priceForm, setPriceForm] = useState(blankPrice);
  const [editingPriceId, setEditingPriceId] = useState(null);

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const results = await Promise.all([
        supabase.from('credit_packages').select('*').order('created_at', { ascending: true }),
        supabase.from('credit_model_prices').select('*').order('provider').order('model'),
        supabase.from('credit_payment_settings').select('*').eq('singleton', true).maybeSingle(),
        supabase.from('credit_wallets').select('balance').eq('user_id', user.id).maybeSingle(),
        supabase.from('credit_orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(30),
        supabase.from('credit_ledger').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(50),
        ...(isAdmin ? [supabase.from('credit_orders').select('*').eq('status', 'pending_review').order('submitted_at', { ascending: true }).limit(100), supabase.from('profiles').select('id,email').limit(1000)] : []),
      ]);
      const failed = results.find((result) => result.error);
      if (failed) throw failed.error;
      const [packages, prices, settings, wallet, orders, ledger, reviews, profiles] = results;
      setData({ packages: packages.data || [], prices: prices.data || [], settings: settings.data, wallet: wallet.data, orders: orders.data || [], ledger: ledger.data || [], reviews: reviews?.data || [], profiles: profiles?.data || [] });
      setInstructions(settings.data?.instructions || '');
      setLoaded(true);
    } catch (err) {
      setError(`Data kredit belum dapat dimuat: ${err.message || 'coba lagi'}`);
    } finally { setLoading(false); }
  }, [user?.id, isAdmin]);

  useEffect(() => { load(); }, [load]);

  async function run(action, success) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: actionError } = await action();
      if (actionError) throw actionError;
      setNotice(success);
      await load();
    } catch (err) { setError(err.message || 'Operasi gagal, silakan coba lagi.'); }
    finally { setBusy(false); }
  }

  const openOrder = data.orders.find((order) => ['awaiting_payment', 'pending_review'].includes(order.status));
  const nameFor = (id) => data.profiles.find((profile) => profile.id === id)?.email || id;

  async function savePackage(event) {
    event.preventDefault();
    const values = { name: packageForm.name.trim(), credits: Number(packageForm.credits), price_idr: Number(packageForm.price_idr), active: packageForm.active };
    if (!values.name || !Number.isInteger(values.credits) || values.credits < 1 || values.credits > 1000000000 || !Number.isInteger(values.price_idr) || values.price_idr < 1 || values.price_idr > 2000000000) {
      setError('Masukkan nama paket, jumlah kredit, dan harga rupiah yang valid.'); return;
    }
    await run(async () => {
      const result = editingId ? await supabase.from('credit_packages').update(values).eq('id', editingId) : await supabase.from('credit_packages').insert(values);
      if (!result.error) { setPackageForm(blankPackage); setEditingId(null); }
      return result;
    }, 'Paket disimpan.');
  }

  async function savePrice(event) {
    event.preventDefault();
    const values = { provider: priceForm.provider.trim().toLowerCase(), model: priceForm.model.trim(), modality: priceForm.modality, credits: Number(priceForm.credits), active: priceForm.active };
    if (!values.provider || !values.model || !Number.isInteger(values.credits) || values.credits < 1 || values.credits > 1000000000) {
      setError('Masukkan provider, model, dan biaya kredit yang valid.'); return;
    }
    await run(async () => {
      const result = editingPriceId ? await supabase.from('credit_model_prices').update(values).eq('id', editingPriceId) : await supabase.from('credit_model_prices').insert(values);
      if (!result.error) { setPriceForm(blankPrice); setEditingPriceId(null); }
      return result;
    }, 'Harga model disimpan.');
  }

  return <DropXLayout title="Kredit" description="Saldo, paket, dan riwayat pembelian kredit Anda.">
    <div className="credits-page">
      {!data.settings?.purchases_enabled && <div className="credits-notice"><strong>Pembelian belum aktif.</strong> Kredit belum dapat digunakan untuk generasi; integrasi Freebeat dan pemotongan kredit belum tersedia. Jangan melakukan transfer sebelum fitur pembelian diaktifkan.</div>}
      {error && <div role="alert" className="credits-error">{error}</div>}
      {notice && <div role="status" className="credits-notice">{notice}</div>}
      {loading ? <p role="status">Memuat kredit…</p> : !loaded ? <button type="button" onClick={load}>Coba lagi</button> : <>
        <section className="credits-card credits-balance"><Coins size={24} /><div><span>Saldo kredit</span><strong>{number(data.wallet?.balance || 0)}</strong></div></section>
        <section className="credits-card"><h2>Paket kredit</h2><p>Pesanan diverifikasi admin setelah transfer; kredit tidak bertambah secara otomatis.</p>
          {!data.packages.filter((item) => item.active).length ? <p>Belum ada paket tersedia.</p> : <div className="credits-grid">{data.packages.filter((item) => item.active).map((item) => <article className="credits-package" key={item.id}><h3>{item.name}</h3><strong>{number(item.credits)} kredit</strong><p>{rupiah(item.price_idr)}</p><button type="button" disabled={busy || !data.settings?.purchases_enabled || !!openOrder} onClick={() => run(() => supabase.rpc('create_credit_order', { p_package_id: item.id }), 'Pesanan dibuat. Ikuti petunjuk transfer pada pesanan Anda.')}>Pilih paket</button></article>)}</div>}
          {openOrder && <p>Anda memiliki satu pesanan aktif. Selesaikan atau batalkan pesanan tersebut sebelum membuat yang baru.</p>}
        </section>
        <section className="credits-card"><h2>Pesanan saya</h2>{!data.orders.length ? <p>Belum ada pesanan.</p> : data.orders.map((order) => <article className="credits-order" key={order.id}><div className="credits-row"><strong>{order.package_name} · {number(order.credits)} kredit</strong><span>{labels[order.status]}</span></div><p>{rupiah(order.price_idr)} · {date(order.created_at)}</p><small>ID pesanan: {order.id}</small>
          {order.status === 'awaiting_payment' && <><p className="credits-instructions">{order.payment_instructions}</p><form className="credits-inline" onSubmit={(event) => { event.preventDefault(); run(() => supabase.rpc('submit_credit_payment', { p_order_id: order.id, p_reference: references[order.id] || '' }), 'Konfirmasi dikirim. Tunggu admin memeriksa transfer.'); }}><label>Nama pengirim / referensi transfer<input required maxLength={300} value={references[order.id] || ''} onChange={(event) => setReferences({ ...references, [order.id]: event.target.value })} /></label><button disabled={busy}>Saya sudah transfer</button><button type="button" className="credits-secondary" disabled={busy} onClick={() => run(() => supabase.rpc('cancel_credit_order', { p_order_id: order.id }), 'Pesanan dibatalkan.')}>Batalkan pesanan</button></form></>}
          {order.status === 'pending_review' && <p>Konfirmasi telah dikirim; admin perlu memeriksa transfer secara manual.</p>}
        </article>)}</section>
        <section className="credits-card"><h2>Riwayat kredit</h2>{!data.ledger.length ? <p>Belum ada transaksi kredit.</p> : data.ledger.map((entry) => <div className="credits-row credits-ledger" key={entry.id}><div>{entry.description}<small>{date(entry.created_at)}</small></div><strong>{entry.delta > 0 ? '+' : ''}{number(entry.delta)}</strong></div>)}</section>
        {isAdmin && <>
          <section className="credits-card"><h2>Admin · Instruksi transfer</h2><p>Masukkan bank, nomor rekening, nama penerima, dan instruksi konfirmasi. Jangan masukkan data rahasia.</p><form className="credits-form" onSubmit={(event) => { event.preventDefault(); run(() => data.settings ? supabase.from('credit_payment_settings').update({ instructions: instructions.trim(), updated_at: new Date().toISOString() }).eq('singleton', true) : supabase.from('credit_payment_settings').insert({ singleton: true, instructions: instructions.trim() }), 'Instruksi transfer disimpan.'); }}><label>Instruksi pembayaran<textarea maxLength={2000} required value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label><button disabled={busy}>Simpan instruksi</button></form></section>
          <section className="credits-card"><h2>Admin · Kelola paket</h2><form className="credits-form" onSubmit={savePackage}><label>Nama paket<input required maxLength={80} value={packageForm.name} onChange={(e) => setPackageForm({ ...packageForm, name: e.target.value })} /></label><label>Jumlah kredit<input required type="number" min="1" max="1000000000" step="1" value={packageForm.credits} onChange={(e) => setPackageForm({ ...packageForm, credits: e.target.value })} /></label><label>Harga (rupiah)<input required type="number" min="1" max="2000000000" step="1" value={packageForm.price_idr} onChange={(e) => setPackageForm({ ...packageForm, price_idr: e.target.value })} /></label><label className="credits-check"><input type="checkbox" checked={packageForm.active} onChange={(e) => setPackageForm({ ...packageForm, active: e.target.checked })} /> Paket aktif</label><div className="credits-actions"><button disabled={busy}>{editingId ? 'Simpan perubahan' : 'Tambah paket'}</button>{editingId && <button type="button" className="credits-secondary" onClick={() => { setEditingId(null); setPackageForm(blankPackage); }}>Batal edit</button>}</div></form><div>{data.packages.map((item) => <div className="credits-row credits-ledger" key={item.id}><span>{item.name} · {number(item.credits)} kredit · {rupiah(item.price_idr)} · {item.active ? 'Aktif' : 'Nonaktif'}</span><button className="credits-secondary" type="button" onClick={() => { setEditingId(item.id); setPackageForm({ name: item.name, credits: item.credits, price_idr: item.price_idr, active: item.active }); }}>Edit</button></div>)}</div></section>
          <section className="credits-card"><h2>Admin · Harga generasi</h2><p>Persiapan harga tetap per model. Harga belum diterapkan ke generasi yang ada dan model ini belum tentu tersedia di Freebeat.</p><form className="credits-form" onSubmit={savePrice}><label>Provider<input required maxLength={80} value={priceForm.provider} onChange={(e) => setPriceForm({ ...priceForm, provider: e.target.value })} /></label><label>ID model<input required maxLength={160} value={priceForm.model} onChange={(e) => setPriceForm({ ...priceForm, model: e.target.value })} /></label><label>Jenis<select value={priceForm.modality} onChange={(e) => setPriceForm({ ...priceForm, modality: e.target.value })}><option value="video">Video</option><option value="image">Gambar</option></select></label><label>Biaya kredit<input required type="number" min="1" max="1000000000" step="1" value={priceForm.credits} onChange={(e) => setPriceForm({ ...priceForm, credits: e.target.value })} /></label><label className="credits-check"><input type="checkbox" checked={priceForm.active} onChange={(e) => setPriceForm({ ...priceForm, active: e.target.checked })} /> Aktif</label><div className="credits-actions"><button disabled={busy}>{editingPriceId ? 'Simpan harga' : 'Tambah harga'}</button>{editingPriceId && <button type="button" className="credits-secondary" onClick={() => { setEditingPriceId(null); setPriceForm(blankPrice); }}>Batal edit</button>}</div></form>{data.prices.map((item) => <div className="credits-row credits-ledger" key={item.id}><span>{item.provider} / {item.model} · {item.modality === 'image' ? 'Gambar' : 'Video'} · {number(item.credits)} kredit · {item.active ? 'Aktif' : 'Nonaktif'}</span><button type="button" className="credits-secondary" onClick={() => { setEditingPriceId(item.id); setPriceForm({ provider: item.provider, model: item.model, modality: item.modality, credits: item.credits, active: item.active }); }}>Edit</button></div>)}</section>
          <section className="credits-card"><h2>Admin · Konfirmasi transfer</h2><p>Pastikan dana benar-benar diterima dan cocok dengan pesanan sebelum menyetujui. Konfirmasi pengguna bukan bukti pembayaran.</p>{!data.reviews.length ? <p>Tidak ada pesanan menunggu verifikasi.</p> : data.reviews.map((order) => <article className="credits-order" key={order.id}><strong>{nameFor(order.user_id)}</strong><p>{order.package_name} · {number(order.credits)} kredit · {rupiah(order.price_idr)}</p><p>Referensi: {order.payment_reference}</p><small>ID pesanan: {order.id} · {date(order.submitted_at)}</small><div className="credits-actions"><button disabled={busy} onClick={() => { if (window.confirm('Anda sudah memastikan transfer diterima? Kredit akan ditambahkan ke akun pengguna.')) run(() => supabase.rpc('review_credit_order', { p_order_id: order.id, p_approve: true }), 'Pesanan disetujui dan kredit ditambahkan.'); }}>Setujui</button><button className="credits-secondary" disabled={busy} onClick={() => { if (window.confirm('Tolak pesanan ini?')) run(() => supabase.rpc('review_credit_order', { p_order_id: order.id, p_approve: false }), 'Pesanan ditolak.'); }}>Tolak</button></div></article>)}</section>
        </>}
      </>}
    </div>
  </DropXLayout>;
}
