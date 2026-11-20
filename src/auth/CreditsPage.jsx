import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Coins, History, Pencil, Trash2 } from 'lucide-react';
import { PaymentLogo } from './paymentLogos';
import { reviewCreditOrder, setPurchasesEnabled } from '../api/purchases';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { ALIBABA_FREE_QUOTA_MODELS } from '../lib/alibabaFreeQuota';
import {
  ALIBABA_VIDEO_MODEL_SPECS,
  BUILTIN_VIDEO_MODELS,
  PROVIDER_PRESETS,
  isAlibabaVideoModelSupported,
  isVideoModelId,
} from '../lib/videoCatalog';
import { useAuth } from './AuthProvider';
import { Pager, PerPageSelect, usePagedList } from '../components/Pagination';
import './credits.css';

const ALIBABA_IMAGE_SUGGESTIONS = ALIBABA_FREE_QUOTA_MODELS.filter((m) => m.blea === 'image');
const VIDEO_PROVIDER_MODEL_SUGGESTIONS = {
  freebeat: [{ id: 'generate_dance_video', name: 'Freebeat AI Dance Video (720p)' }],
  openai: [{ id: 'sora-2', name: 'OpenAI Sora 2' }, { id: 'sora-2-pro', name: 'OpenAI Sora 2 Pro' }],
  google: [
    { id: 'veo3.1', name: 'Google Veo 3.1' },
    { id: 'veo3.1-fast', name: 'Google Veo 3.1 Fast' },
    { id: 'gemini-omni-1.2-flash:free', name: 'Google Gemini Omni 1.2 Flash' },
    { id: 'gemini-omni-1.1-flash:free', name: 'Google Gemini Omni 1.1 Flash' },
  ],
  xai: [{ id: 'grok-video-3', name: 'xAI Grok Video 3' }, { id: 'grok-imagine-video', name: 'xAI Grok Imagine Video' }],
  doubao: [{ id: 'doubao-seedance-1-5-pro-251215', name: 'ByteDance Seedance 1.5 Pro' }],
  kling: [{ id: 'kling-v2.6', name: 'Kling v2.6' }, { id: 'kling-v3', name: 'Kling v3' }],
  hailuo: [{ id: 'minimax-hailuo-2.3', name: 'MiniMax Hailuo 2.3' }],
};
const labels = { awaiting_payment: 'Menunggu transfer', pending_review: 'Menunggu verifikasi', approved: 'Disetujui', rejected: 'Ditolak', cancelled: 'Dibatalkan' };
const rupiah = (value) => `Rp${Number(value).toLocaleString('id-ID')}`;
const number = (value) => Number(value).toLocaleString('id-ID');
const date = (value) => new Date(value).toLocaleString('id-ID');
const blankPackage = { name: '', credits: '', price_idr: '', active: true };
const blankPrice = { provider: 'alibaba', model: '', modality: 'video', credits: '', active: true };
const blankMethod = { kind: 'bank', provider: '', label: '', account_name: '', account_number: '', network: '', note: '', sort_order: 0, active: true };
const kindLabel = { bank: 'Transfer bank', ewallet: 'E-wallet', crypto: 'Cripto (USD)' };
const PROVIDER_SUGGESTIONS = ['BCA', 'DANA', 'SeaBank', 'Gopay', 'OVO', 'ShopeePay', 'LinkAja', 'USDT', 'USDC'];
const NON_VIDEO_CHAT_RE = /(gpt-oss|deepseek|embed|whisper|rerank|coder|instruct|llama|gemma|qwen|glm|mistral|granite)/i;

export function CreditsPage() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [data, setData] = useState({ packages: [], prices: [], orders: [], reviews: [], profiles: [], wallet: null, settings: null });
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
  const [manualProvider, setManualProvider] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [priceFilter, setPriceFilter] = useState('all');
  const [activeProviderModels, setActiveProviderModels] = useState([]);
  const [bulkAlibabaCredits, setBulkAlibabaCredits] = useState('15');
  const [bulkVideoCredits, setBulkVideoCredits] = useState('50');
  const [methods, setMethods] = useState([]);
  const [methodForm, setMethodForm] = useState(blankMethod);
  const [editingMethodId, setEditingMethodId] = useState(null);
  const [purchasePassword, setPurchasePassword] = useState('');
  const [reviewPassword, setReviewPassword] = useState('');

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const results = await Promise.all([
        supabase.from('credit_packages').select('*').order('created_at', { ascending: true }),
        supabase.from('credit_model_prices').select('*').order('provider').order('model'),
        supabase.from('credit_payment_settings').select('*').eq('singleton', true).maybeSingle(),
        supabase.from('credit_wallets').select('balance').eq('user_id', user.id).maybeSingle(),
        supabase.from('credit_orders').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(1000),
        ...(isAdmin ? [supabase.from('credit_orders').select('*').eq('status', 'pending_review').order('submitted_at', { ascending: true }).limit(1000), supabase.from('profiles').select('id,email').limit(1000)] : []),
      ]);
      const methodResult = await supabase.from('credit_payment_methods').select('*').order('sort_order', { ascending: true }).order('provider', { ascending: true });
      setMethods(methodResult.error ? [] : methodResult.data || []);
      if (isAdmin) {
        const activeRes = await supabase.from('provider_models').select('provider,model').eq('active', true).limit(500);
        setActiveProviderModels(!activeRes?.error && Array.isArray(activeRes?.data) ? activeRes.data : []);
      } else {
        setActiveProviderModels([]);
      }
      const failed = results.find((result) => result.error);
      if (failed) throw failed.error;
      const [packages, prices, settings, wallet, orders, reviews, profiles] = results;
      setData({ packages: packages.data || [], prices: prices.data || [], settings: settings.data, wallet: wallet.data, orders: orders.data || [], reviews: reviews?.data || [], profiles: profiles?.data || [] });
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
  const ordersPaged = usePagedList(data.orders);
  const reviewsPaged = usePagedList(data.reviews);
  const pageActions = (
    <Link className="credits-history-btn" to="/credits/history"><History size={15} /> Riwayat kredit</Link>
  );

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
      const result = editingPriceId
        ? await supabase.from('credit_model_prices').update(values).eq('id', editingPriceId)
        : await supabase.from('credit_model_prices').upsert(values, { onConflict: 'provider,model,modality' });
      if (!result.error) {
        setPriceForm({ ...blankPrice, provider: values.provider, modality: values.modality });
        setEditingPriceId(null);
        setManualModel(false);
      }
      return result;
    }, 'Harga model disimpan.');
  }

  async function removePrice(item) {
    if (busy) return;
    if (!window.confirm(`Hapus tarif kredit untuk ${item.provider} / ${item.model} (${item.modality})?`)) return;
    await run(() => supabase.from('credit_model_prices').delete().eq('id', item.id), 'Tarif model dihapus.');
  }

  const providerOptions = useMemo(() => {
    const map = new Map([
      ['alibaba', 'Alibaba Model Studio (alibaba)'],
      ['freebeat', 'Freebeat (freebeat)'],
    ]);
    for (const preset of Object.values(PROVIDER_PRESETS)) {
      if (preset.id === 'unorouter' || preset.id === 'custom' || preset.id === 'cloudflare') continue;
      if (!map.has(preset.id)) map.set(preset.id, `${preset.label} (${preset.id})`);
    }
    for (const row of activeProviderModels) {
      const p = String(row?.provider || '').trim().toLowerCase();
      if (!p || p === 'unorouter' || p === 'cloudflare' || map.has(p)) continue;
      map.set(p, p);
    }
    for (const row of data.prices) {
      const p = String(row?.provider || '').trim().toLowerCase();
      if (!p || map.has(p)) continue;
      map.set(p, p);
    }
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  }, [activeProviderModels, data.prices]);

  const modelSuggestionsFor = useCallback((providerRaw, modality) => {
    const prov = String(providerRaw || '').trim().toLowerCase();
    const out = new Map();
    const push = (id, name = id) => {
      const clean = String(id || '').trim();
      if (clean && !out.has(clean)) out.set(clean, { id: clean, name: String(name || clean) });
    };
    if (modality === 'video') {
      if (prov === 'alibaba') {
        for (const [id, spec] of Object.entries(ALIBABA_VIDEO_MODEL_SPECS)) push(id, spec.name || id);
      } else {
        for (const item of VIDEO_PROVIDER_MODEL_SUGGESTIONS[prov] || []) push(item.id, item.name);
        for (const item of BUILTIN_VIDEO_MODELS) {
          if (item.provider === prov) push(item.id, item.name);
        }
      }
      for (const row of activeProviderModels) {
        if (String(row?.provider || '').trim().toLowerCase() !== prov) continue;
        if (prov === 'alibaba' && !isAlibabaVideoModelSupported(row.model)) continue;
        if (prov !== 'alibaba' && NON_VIDEO_CHAT_RE.test(row.model) && !isVideoModelId(row.model)) continue;
        push(row.model, row.model);
      }
    } else if (prov === 'freebeat') {
      for (const id of ['122', '80', '202']) push(id, `Freebeat model ${id}`);
    } else if (prov === 'alibaba') {
      for (const m of ALIBABA_IMAGE_SUGGESTIONS) push(m.id, m.name);
    } else {
      for (const row of activeProviderModels) {
        if (String(row?.provider || '').trim().toLowerCase() === prov) push(row.model, row.model);
      }
    }
    for (const p of data.prices) {
      if (String(p?.provider || '').trim().toLowerCase() === prov && p?.modality === modality) {
        push(p.model, p.model);
      }
    }
    return Array.from(out.values());
  }, [activeProviderModels, data.prices]);

  const currentModelSuggestions = useMemo(
    () => modelSuggestionsFor(priceForm.provider, priceForm.modality),
    [modelSuggestionsFor, priceForm.provider, priceForm.modality],
  );

  const activeAlibabaModels = useMemo(
    () => activeProviderModels.filter((r) => r.provider === 'alibaba').map((r) => r.model),
    [activeProviderModels],
  );
  const activeAlibabaImageIds = ALIBABA_IMAGE_SUGGESTIONS
    .filter((m) => activeAlibabaModels.includes(m.id))
    .map((m) => m.id);
  const pricedActiveAlibabaIds = new Set(
    data.prices
      .filter((p) => p.provider === 'alibaba' && p.modality === 'image' && p.active && Number(p.credits) > 0)
      .map((p) => p.model),
  );
  const missingAlibabaImageIds = activeAlibabaImageIds.filter((id) => !pricedActiveAlibabaIds.has(id));

  const activeVideoModels = useMemo(() => {
    const out = [];
    const seen = new Set();
    for (const row of activeProviderModels) {
      const prov = String(row?.provider || '').trim().toLowerCase();
      const model = String(row?.model || '').trim();
      if (!prov || !model || prov === 'unorouter' || prov === 'freebeat') continue;
      if (prov === 'cloudflare' && !isVideoModelId(model)) continue;
      if (prov === 'alibaba' && !isAlibabaVideoModelSupported(model)) continue;
      if (NON_VIDEO_CHAT_RE.test(model) && !isVideoModelId(model)) continue;
      const key = `${prov}:${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider: prov, model });
    }
    return out;
  }, [activeProviderModels]);

  const pricedVideoKeys = new Set(
    data.prices
      .filter((p) => p.modality === 'video' && p.active && Number(p.credits) > 0)
      .map((p) => `${String(p.provider || '').trim().toLowerCase()}:${String(p.model || '').trim()}`),
  );
  const missingVideoModels = activeVideoModels.filter((m) => !pricedVideoKeys.has(`${m.provider}:${m.model}`));

  async function applyBulkAlibabaPrices() {
    const credits = Number(bulkAlibabaCredits);
    if (!Number.isInteger(credits) || credits < 1 || credits > 1000000000) {
      setError('Masukkan biaya kredit bilangan bulat minimal 1.'); return;
    }
    if (!missingAlibabaImageIds.length) return;
    await run(
      () => supabase.from('credit_model_prices').upsert(
        missingAlibabaImageIds.map((model) => ({ provider: 'alibaba', model, modality: 'image', credits, active: true })),
        { onConflict: 'provider,model,modality' },
      ),
      `Harga ${credits} kredit diterapkan untuk ${missingAlibabaImageIds.length} model gambar Alibaba aktif.`,
    );
  }

  async function applyBulkVideoPrices() {
    const credits = Number(bulkVideoCredits);
    if (!Number.isInteger(credits) || credits < 1 || credits > 1000000000) {
      setError('Masukkan biaya kredit bilangan bulat minimal 1.'); return;
    }
    if (!missingVideoModels.length) return;
    await run(
      () => supabase.from('credit_model_prices').upsert(
        missingVideoModels.map((m) => ({ provider: m.provider, model: m.model, modality: 'video', credits, active: true })),
        { onConflict: 'provider,model,modality' },
      ),
      `Harga ${credits} kredit diterapkan untuk ${missingVideoModels.length} model video aktif.`,
    );
  }

  function startEditPrice(item) {
    const prov = String(item.provider || '').trim().toLowerCase();
    const isKnownProvider = providerOptions.some((opt) => opt.id === prov);
    const suggestions = modelSuggestionsFor(prov, item.modality);
    setEditingPriceId(item.id);
    setManualProvider(!isKnownProvider);
    setManualModel(!suggestions.some((s) => s.id === item.model));
    setPriceForm({ provider: prov, model: item.model, modality: item.modality, credits: item.credits, active: item.active });
    setError('');
  }

  function prefillVideoModelPrice(m) {
    setEditingPriceId(null);
    setManualProvider(!providerOptions.some((opt) => opt.id === m.provider));
    const suggestions = modelSuggestionsFor(m.provider, 'video');
    setManualModel(!suggestions.some((s) => s.id === m.model));
    setPriceForm({ provider: m.provider, model: m.model, modality: 'video', credits: '', active: true });
    setError('');
  }

  function methodValues() {
    const v = {
      kind: methodForm.kind,
      provider: methodForm.provider.trim(),
      label: methodForm.label.trim(),
      account_name: methodForm.account_name.trim(),
      account_number: methodForm.account_number.trim(),
      network: methodForm.network.trim(),
      note: methodForm.note.trim().slice(0, 300),
      sort_order: Math.trunc(Number(methodForm.sort_order) || 0),
      active: methodForm.active === true,
    };
    if (v.kind !== 'crypto') v.network = '';
    return v;
  }

  function validateMethod(v) {
    if (!v.provider) return 'Provider wajib diisi (mis. BCA, DANA, SeaBank, USDT).';
    if (v.kind === 'crypto') {
      if (!v.network) return 'Jaringan kripto wajib diisi (mis. TRC20, ERC20, BEP20).';
      if (v.account_number.length < 20) return 'Alamat wallet terlihat terlalu pendek (minimal 20 karakter).';
    } else {
      if (v.account_number.length < 4) return 'Nomor rekening / nomor telepon wajib diisi.';
      if (!v.account_name) return 'Nama pemilik wajib diisi.';
    }
    if (!Number.isFinite(v.sort_order) || Math.abs(v.sort_order) > 10000) return 'Urutan harus berupa angka.';
    return null;
  }

  async function saveMethod(event) {
    event.preventDefault();
    const values = methodValues();
    const invalid = validateMethod(values);
    if (invalid) { setError(invalid); return; }
    await run(async () => {
      const result = editingMethodId ? await supabase.from('credit_payment_methods').update(values).eq('id', editingMethodId) : await supabase.from('credit_payment_methods').insert(values);
      if (!result.error) { setMethodForm(blankMethod); setEditingMethodId(null); }
      return result;
    }, 'Metode pembayaran disimpan.');
  }

  async function removeMethod(id) {
    if (busy) return;
    if (!window.confirm('Hapus metode pembayaran ini?')) return;
    await run(() => supabase.from('credit_payment_methods').delete().eq('id', id), 'Metode pembayaran dihapus.');
  }

  function startEditMethod(method) {
    setMethodForm({ kind: method.kind, provider: method.provider, label: method.label || '', account_name: method.account_name || '', account_number: method.account_number || '', network: method.network || '', note: method.note || '', sort_order: method.sort_order ?? 0, active: method.active === true });
    setEditingMethodId(method.id);
    setError('');
  }

  async function togglePurchases(next) {
    if (busy) return;
    if (purchasePassword.length < 6) { setError('Masukkan password aksi admin (minimal 6 karakter).'); return; }
    const proceed = next
      ? window.confirm('Aktifkan pembelian? Pengguna bisa membuat pesanan dan mentransfer uang sungguhan. Pastikan metode pembayaran & instruksi sudah benar.')
      : window.confirm('Nonaktifkan pembelian? Tombol Pilih paket mati dan banner peringatan tampil.');
    if (!proceed) return;
    setBusy(true); setError(''); setNotice('');
    const res = await setPurchasesEnabled(next, purchasePassword);
    setBusy(false);
    if (!res?.ok) { setError(res?.data?.error || 'Gagal mengubah status pembelian.'); return; }
    setNotice(next ? 'Pembelian kredit DIAKTIFKAN.' : 'Pembelian kredit DINONAKTIFKAN.');
    setPurchasePassword('');
    await load();
  }

  async function reviewOrder(orderId, approve) {
    if (busy) return;
    if (reviewPassword.length < 6) { setError('Isi dulu password aksi admin di kolom di atas (minimal 6 karakter), lalu tekan Setujui lagi.'); return; }
    const proceed = approve
      ? window.confirm('Anda sudah memastikan transfer diterima? Kredit akan ditambahkan ke akun pengguna.')
      : window.confirm('Tolak pesanan ini? Keputusan tidak bisa dikembalikan.');
    if (!proceed) return;
    setBusy(true); setError(''); setNotice('');
    const res = await reviewCreditOrder(orderId, approve, reviewPassword);
    setBusy(false);
    if (!res?.ok) { setError(res?.data?.error || 'Verifikasi pesanan gagal.'); return; }
    setNotice(approve ? 'Pesanan disetujui dan kredit ditambahkan.' : 'Pesanan ditolak.');
    setReviewPassword('');
    await load();
  }

  const methodList = methods.filter((method) => method.active);

  return <DropXLayout title="Kredit" description="Saldo, paket, dan pembelian kredit Anda." actions={pageActions}>
    <div className="credits-page">
      {!data.settings?.purchases_enabled && <div className="credits-notice"><strong>Pembelian kredit belum dibuka.</strong> Jangan melakukan transfer dulu. Kredit BLEA sudah bisa dipakai untuk generasi di halaman Generate; pembelian kredit akan diumumkan setelah diaktifkan.</div>}
      {error && <div role="alert" className="credits-error">{error}</div>}
      {notice && <div role="status" className="credits-notice">{notice}</div>}
      {loading ? <p role="status">Memuat kredit…</p> : !loaded ? <button type="button" onClick={load}>Coba lagi</button> : <>
        <section className="credits-card credits-balance"><Coins size={24} /><div><span>Saldo kredit</span><strong>{number(data.wallet?.balance || 0)}</strong></div><Link className="credits-history-btn credits-history-btn-inline" to="/credits/history">Riwayat kredit <ArrowRight size={14} /></Link></section>
        <section className="credits-card"><h2>Paket kredit</h2><p>Pesanan diverifikasi admin setelah transfer; kredit tidak bertambah secara otomatis.</p>
          {!data.packages.filter((item) => item.active).length ? <p>Belum ada paket tersedia.</p> : <div className="credits-grid">{data.packages.filter((item) => item.active).map((item) => <article className="credits-package" key={item.id}><h3>{item.name}</h3><strong>{number(item.credits)} kredit</strong><p>{rupiah(item.price_idr)}</p><button type="button" disabled={busy || !data.settings?.purchases_enabled || !!openOrder} onClick={() => run(() => supabase.rpc('create_credit_order', { p_package_id: item.id }), 'Pesanan dibuat. Ikuti petunjuk transfer pada pesanan Anda.')}>Pilih paket</button></article>)}</div>}
          {openOrder && <p>Anda memiliki satu pesanan aktif. Selesaikan atau batalkan pesanan tersebut sebelum membuat yang baru.</p>}
        </section>
        <section className="credits-card"><h2>Metode pembayaran</h2>
          {methodList.length === 0
            ? <p>Belum ada metode pembayaran yang ditampilkan.{isAdmin ? ' Tambahkan di bagian Admin · Metode pembayaran di bawah.' : ''}</p>
            : <div className="credits-methods">{methodList.map((method) => (
              <article className="credits-method" key={method.id}>
                <div className="credits-method-head"><PaymentLogo provider={method.provider} kind={method.kind} size={46} /><div><strong>{method.provider}</strong>{method.label && <small>{method.label}</small>}<span className="credits-kind-pill">{kindLabel[method.kind] || method.kind}</span></div></div>
                <div className="credits-method-lines">
                  {method.kind === 'crypto'
                    ? <><code className="credits-mono credits-break">{method.account_number}</code>{method.network && <span className="credits-network">Jaringan: {method.network}</span>}</>
                    : <><code className="credits-mono">{method.account_number}</code>{method.account_name && <span>a.n. {method.account_name}</span>}</>}
                  {method.note && <small className="credits-method-note">{method.note}</small>}
                </div>
              </article>
            ))}</div>}
        </section>
        <section className="credits-card"><div className="credits-card-head"><h2>Pesanan saya</h2>{data.orders.length > 0 && <PerPageSelect id="orders-per-page" value={ordersPaged.perPage} onChange={ordersPaged.setPerPage} />}</div>{!data.orders.length ? <p>Belum ada pesanan.</p> : ordersPaged.slice.map((order) => <article className="credits-order" key={order.id}><div className="credits-row"><strong>{order.package_name} · {number(order.credits)} kredit</strong><span>{labels[order.status]}</span></div><p>{rupiah(order.price_idr)} · {date(order.created_at)}</p><small>ID pesanan: {order.id}</small>
          {order.status === 'awaiting_payment' && <><p className="credits-instructions">{order.payment_instructions}</p><form className="credits-inline" onSubmit={(event) => { event.preventDefault(); run(() => supabase.rpc('submit_credit_payment', { p_order_id: order.id, p_reference: references[order.id] || '' }), 'Konfirmasi dikirim. Tunggu admin memeriksa transfer.'); }}><label>Nama pengirim / referensi transfer<input required maxLength={300} value={references[order.id] || ''} onChange={(event) => setReferences({ ...references, [order.id]: event.target.value })} /></label><button disabled={busy}>Saya sudah transfer</button><button type="button" className="credits-secondary" disabled={busy} onClick={() => run(() => supabase.rpc('cancel_credit_order', { p_order_id: order.id }), 'Pesanan dibatalkan.')}>Batalkan pesanan</button></form></>}
          {order.status === 'pending_review' && <p>Konfirmasi telah dikirim; admin perlu memeriksa transfer secara manual.</p>}
        </article>)}<Pager page={ordersPaged.page} pageCount={ordersPaged.pageCount} total={ordersPaged.total} onPage={ordersPaged.setPage} /></section>
        <section className="credits-card credits-history-card"><div><h2>Riwayat kredit</h2><p>Total pembelian, total pemakaian, sisa saldo, dan setiap transaksi — termasuk tautan langsung ke hasil generasi di History.</p></div><Link className="credits-history-btn" to="/credits/history"><History size={15} /> Buka riwayat kredit <ArrowRight size={14} /></Link></section>
        {isAdmin && <>
          <section className="credits-card"><h2>Admin · Status pembelian</h2>
            <p>Mode pembelian saat ini: <strong className={data.settings?.purchases_enabled ? 'credits-state-on' : 'credits-state-off'}>{data.settings?.purchases_enabled ? 'AKTIF' : 'NONAKTIF'}</strong></p>
            <div className="credits-form">
              <label>Password aksi admin<input type="password" autoComplete="new-password" value={purchasePassword} onChange={(event) => setPurchasePassword(event.target.value)} placeholder="Password yang Anda setel di Supabase" /></label>
            </div>
            <div className="credits-actions">
              <button type="button" onClick={() => togglePurchases(true)} disabled={busy || data.settings?.purchases_enabled === true}>Aktifkan pembelian</button>
              <button type="button" className="credits-secondary" onClick={() => togglePurchases(false)} disabled={busy || !data.settings?.purchases_enabled}>Nonaktifkan</button>
            </div>
            <p className="credits-hint">Perubahan memakai password aksi admin dan tercatat di jejak audit. Teks umum yang tampil di pesanan diatur di bagian Instruksi transfer; detail BCA / DANA / SeaBank / kripto diisi di Metode pembayaran.</p>
          </section>

          <section className="credits-card"><h2>Admin · Metode pembayaran</h2><p>Tampil ke pembeli di bagian Metode pembayaran, lengkap dengan logo.</p>
            <form className="credits-form" onSubmit={saveMethod}>
              <label>Jenis<select value={methodForm.kind} onChange={(event) => setMethodForm({ ...methodForm, kind: event.target.value })}><option value="bank">Transfer bank</option><option value="ewallet">E-wallet</option><option value="crypto">Cripto (USD)</option></select></label>
              <label>Provider<input list="credit-provider-suggestions" required maxLength={60} value={methodForm.provider} onChange={(event) => setMethodForm({ ...methodForm, provider: event.target.value })} placeholder="BCA, DANA, SeaBank, USDT..." /></label>
              <datalist id="credit-provider-suggestions">{PROVIDER_SUGGESTIONS.map((item) => <option key={item} value={item} />)}</datalist>
              {methodForm.kind === 'crypto'
                ? <>
                    <label>Jaringan<input required maxLength={40} value={methodForm.network} onChange={(event) => setMethodForm({ ...methodForm, network: event.target.value })} placeholder="TRC20 / ERC20 / BEP20" /></label>
                    <label>Alamat wallet (USD)<input required maxLength={200} value={methodForm.account_number} onChange={(event) => setMethodForm({ ...methodForm, account_number: event.target.value })} placeholder="T... / 0x..." /></label>
                  </>
                : <>
                    <label>{methodForm.kind === 'ewallet' ? 'Nomor telepon / ID' : 'Nomor rekening'}<input required maxLength={200} value={methodForm.account_number} onChange={(event) => setMethodForm({ ...methodForm, account_number: event.target.value })} placeholder={methodForm.kind === 'ewallet' ? '08xxxxxxxxxx' : '1234567890'} /></label>
                    <label>Atas nama<input required maxLength={120} value={methodForm.account_name} onChange={(event) => setMethodForm({ ...methodForm, account_name: event.target.value })} placeholder="Nama pemilik rekening" /></label>
                  </>}
              <label>Label (opsional)<input maxLength={80} value={methodForm.label} onChange={(event) => setMethodForm({ ...methodForm, label: event.target.value })} placeholder="mis. BCA · harian" /></label>
              <label>Catatan (opsional)<input maxLength={300} value={methodForm.note} onChange={(event) => setMethodForm({ ...methodForm, note: event.target.value })} placeholder="mis. Transfer sebelum 1 jam" /></label>
              <label>Urutan<input type="number" step={1} value={methodForm.sort_order} onChange={(event) => setMethodForm({ ...methodForm, sort_order: event.target.value })} /></label>
              <label className="credits-check"><input type="checkbox" checked={methodForm.active} onChange={(event) => setMethodForm({ ...methodForm, active: event.target.checked })} /> Aktif</label>
              <div className="credits-actions" style={{ width: '100%' }}>
                <button disabled={busy}>{editingMethodId ? 'Simpan perubahan' : 'Tambah metode'}</button>
                {editingMethodId && <button type="button" className="credits-secondary" onClick={() => { setEditingMethodId(null); setMethodForm(blankMethod); }}>Batal edit</button>}
              </div>
            </form>
            <div>{methods.map((method) => (
              <div className="credits-row credits-method-row" key={method.id}>
                <span className="credits-method-row-main"><PaymentLogo provider={method.provider} kind={method.kind} size={34} /><span><b>{method.provider}</b>{method.label ? ` · ${method.label}` : ''}<br /><small>{kindLabel[method.kind] || method.kind}{method.network ? ` · ${method.network}` : ''} · {method.active ? 'Aktif' : 'Nonaktif'}</small><code className="credits-mono credits-break">{method.account_number}</code></span></span>
                <span className="credits-method-row-actions">
                  <button type="button" className="credits-secondary" onClick={() => startEditMethod(method)}><Pencil size={13} /> Edit</button>
                  <button type="button" className="credits-secondary" onClick={() => removeMethod(method.id)}><Trash2 size={13} /> Hapus</button>
                </span>
              </div>
            ))}{!methods.length && <p>Belum ada metode pembayaran. Tambahkan BCA / DANA / SeaBank / kripto USD di atas.</p>}</div>
          </section>

          <section className="credits-card"><h2>Admin · Instruksi transfer</h2><p>Masukkan bank, nomor rekening, nama penerima, dan instruksi konfirmasi. Jangan masukkan data rahasia.</p><form className="credits-form" onSubmit={(event) => { event.preventDefault(); run(() => data.settings ? supabase.from('credit_payment_settings').update({ instructions: instructions.trim(), updated_at: new Date().toISOString() }).eq('singleton', true) : supabase.from('credit_payment_settings').insert({ singleton: true, instructions: instructions.trim() }), 'Instruksi transfer disimpan.'); }}><label>Instruksi pembayaran<textarea maxLength={2000} required value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label><button disabled={busy}>Simpan instruksi</button></form></section>
          <section className="credits-card"><h2>Admin · Kelola paket</h2><form className="credits-form" onSubmit={savePackage}><label>Nama paket<input required maxLength={80} value={packageForm.name} onChange={(e) => setPackageForm({ ...packageForm, name: e.target.value })} /></label><label>Jumlah kredit<input required type="number" min="1" max="1000000000" step="1" value={packageForm.credits} onChange={(e) => setPackageForm({ ...packageForm, credits: e.target.value })} /></label><label>Harga (rupiah)<input required type="number" min="1" max="2000000000" step="1" value={packageForm.price_idr} onChange={(e) => setPackageForm({ ...packageForm, price_idr: e.target.value })} /></label><label className="credits-check"><input type="checkbox" checked={packageForm.active} onChange={(e) => setPackageForm({ ...packageForm, active: e.target.checked })} /> Paket aktif</label><div className="credits-actions"><button disabled={busy}>{editingId ? 'Simpan perubahan' : 'Tambah paket'}</button>{editingId && <button type="button" className="credits-secondary" onClick={() => { setEditingId(null); setPackageForm(blankPackage); }}>Batal edit</button>}</div></form><div>{data.packages.map((item) => <div className="credits-row credits-ledger" key={item.id}><span>{item.name} · {number(item.credits)} kredit · {rupiah(item.price_idr)} · {item.active ? 'Aktif' : 'Nonaktif'}</span><button className="credits-secondary" type="button" onClick={() => { setEditingId(item.id); setPackageForm({ name: item.name, credits: item.credits, price_idr: item.price_idr, active: item.active }); }}>Edit</button></div>)}</div></section>
          <section className="credits-card"><h2>Admin · Harga generasi</h2><p>Harga kredit tetap per model untuk halaman Generate Gambar maupun Generate Video. Semua model aktif wajib memiliki tarif aktif di sini agar dapat digunakan dan memotong kredit pengguna.</p>
            {missingVideoModels.length > 0 && <div className="credits-notice">
              <p><strong>{missingVideoModels.length} model video aktif belum punya tarif kredit</strong> sehingga belum dapat dipakai di Generate Video. Klik salah satu model di bawah untuk mengisi tarif manualnya, atau isi tarif default sekaligus:</p>
              <div className="credits-chip-list">
                {missingVideoModels.slice(0, 12).map((m) => (
                  <button
                    key={`${m.provider}:${m.model}`}
                    type="button"
                    className="credits-secondary credits-chip-btn"
                    onClick={() => prefillVideoModelPrice(m)}
                  >
                    {m.provider} / {m.model}
                  </button>
                ))}
                {missingVideoModels.length > 12 && <span className="credits-hint">+{missingVideoModels.length - 12} lainnya di dropdown model</span>}
              </div>
              <div className="credits-inline" style={{ marginTop: 10 }}>
                <label>Tarif video default (opsional) <input type="number" min="1" max="1000000000" step="1" value={bulkVideoCredits} onChange={(e) => setBulkVideoCredits(e.target.value)} /></label>
                <button type="button" disabled={busy} onClick={applyBulkVideoPrices}>Isi harga {missingVideoModels.length} model video aktif</button>
              </div>
            </div>}
            {missingAlibabaImageIds.length > 0 && <div className="credits-notice">
              <p><strong>{missingAlibabaImageIds.length} model gambar Alibaba aktif belum punya harga kredit</strong> sehingga belum tampil di Generate Gambar ({missingAlibabaImageIds.slice(0, 4).join(', ')}{missingAlibabaImageIds.length > 4 ? ', …' : ''}).</p>
              <div className="credits-inline">
                <label>Kredit default <input type="number" min="1" max="1000000000" step="1" value={bulkAlibabaCredits} onChange={(e) => setBulkAlibabaCredits(e.target.value)} /></label>
                <button type="button" disabled={busy} onClick={applyBulkAlibabaPrices}>Isi harga {missingAlibabaImageIds.length} model Alibaba aktif</button>
              </div>
            </div>}
            <form className="credits-form" onSubmit={savePrice}>
              <label>Jenis
                <select
                  aria-label="Jenis"
                  value={priceForm.modality}
                  onChange={(e) => {
                    const nextModality = e.target.value;
                    const nextSuggestions = modelSuggestionsFor(priceForm.provider, nextModality);
                    const keepModel = nextSuggestions.some((s) => s.id === priceForm.model);
                    setManualModel(nextSuggestions.length === 0);
                    setPriceForm({ ...priceForm, modality: nextModality, model: keepModel ? priceForm.model : '' });
                  }}
                >
                  <option value="video">Video</option>
                  <option value="image">Gambar</option>
                  {priceForm.modality === 'image_edit' && <option value="image_edit">Edit gambar</option>}
                  {priceForm.modality === 'image_edit_2k' && <option value="image_edit_2k">Edit gambar 2K</option>}
                </select>
              </label>
              <label>Provider
                {!manualProvider ? (
                  <select
                    aria-label="Provider"
                    value={providerOptions.some((p) => p.id === priceForm.provider) ? priceForm.provider : '__custom__'}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '__custom__') {
                        setManualProvider(true);
                        setManualModel(true);
                        setPriceForm({ ...priceForm, provider: '', model: '' });
                        return;
                      }
                      const nextSuggestions = modelSuggestionsFor(val, priceForm.modality);
                      setManualModel(nextSuggestions.length === 0);
                      setPriceForm({ ...priceForm, provider: val, model: '' });
                    }}
                  >
                    {providerOptions.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    <option value="__custom__">Provider lain (isi manual)…</option>
                  </select>
                ) : (
                  <span className="credits-input-stack">
                    <input
                      aria-label="Provider manual"
                      required
                      maxLength={80}
                      placeholder="mis. runway, luma, pika"
                      value={priceForm.provider}
                      onChange={(e) => setPriceForm({ ...priceForm, provider: e.target.value })}
                    />
                    <button
                      type="button"
                      className="credits-link-btn"
                      onClick={() => {
                        const fallback = providerOptions[0]?.id || 'alibaba';
                        setManualProvider(false);
                        setManualModel(false);
                        setPriceForm({ ...priceForm, provider: fallback, model: '' });
                      }}
                    >
                      Pilih dari daftar provider
                    </button>
                  </span>
                )}
              </label>
              <label>ID model
                {!manualModel && currentModelSuggestions.length > 0 ? (
                  <select
                    aria-label="ID model"
                    required
                    value={currentModelSuggestions.some((s) => s.id === priceForm.model) ? priceForm.model : (priceForm.model ? '__custom__' : '')}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '__custom__') {
                        setManualModel(true);
                        setPriceForm({ ...priceForm, model: '' });
                        return;
                      }
                      setPriceForm({ ...priceForm, model: val });
                    }}
                  >
                    <option value="">— Pilih model —</option>
                    {currentModelSuggestions.map((m) => (
                      <option key={m.id} value={m.id}>{m.name && m.name !== m.id ? `${m.id} — ${m.name}` : m.id}</option>
                    ))}
                    <option value="__custom__">Isi ID model manual…</option>
                  </select>
                ) : (
                  <span className="credits-input-stack">
                    <input
                      aria-label="ID model"
                      required
                      maxLength={160}
                      placeholder={priceForm.modality === 'video' ? 'mis. wan2.2-i2v-plus atau sora-2' : 'mis. wan2.7-image'}
                      value={priceForm.model}
                      onChange={(e) => setPriceForm({ ...priceForm, model: e.target.value })}
                    />
                    {currentModelSuggestions.length > 0 && (
                      <button
                        type="button"
                        className="credits-link-btn"
                        onClick={() => { setManualModel(false); setPriceForm({ ...priceForm, model: '' }); }}
                      >
                        Pilih dari daftar model
                      </button>
                    )}
                  </span>
                )}
              </label>
              <label>Biaya kredit<input required type="number" min="1" max="1000000000" step="1" placeholder="mis. 50" value={priceForm.credits} onChange={(e) => setPriceForm({ ...priceForm, credits: e.target.value })} /></label>
              <label className="credits-check"><input type="checkbox" checked={priceForm.active} onChange={(e) => setPriceForm({ ...priceForm, active: e.target.checked })} /> Aktif</label>
              <div className="credits-actions">
                <button disabled={busy}>{editingPriceId ? 'Simpan harga' : 'Tambah / perbarui harga'}</button>
                {editingPriceId && <button type="button" className="credits-secondary" onClick={() => { setEditingPriceId(null); setManualProvider(false); setManualModel(false); setPriceForm(blankPrice); }}>Batal edit</button>}
              </div>
            </form>
            <div className="credits-filter-row" role="group" aria-label="Filter daftar tarif">
              {[
                ['all', `Semua (${data.prices.length})`],
                ['video', `Video (${data.prices.filter((p) => p.modality === 'video').length})`],
                ['image', `Gambar (${data.prices.filter((p) => p.modality !== 'video').length})`],
              ].map(([key, label]) => (
                <button key={key} type="button" className={priceFilter === key ? '' : 'credits-secondary'} onClick={() => setPriceFilter(key)}>{label}</button>
              ))}
            </div>
            {data.prices
              .filter((item) => priceFilter === 'all' ? true : priceFilter === 'video' ? item.modality === 'video' : item.modality !== 'video')
              .map((item) => (
                <div className="credits-row credits-ledger" key={item.id}>
                  <span>{item.provider} / {item.model} · {item.modality === 'video' ? 'Video' : item.modality === 'image' ? 'Gambar' : item.modality} · {number(item.credits)} kredit · {item.active ? 'Aktif' : 'Nonaktif'}</span>
                  <span className="credits-method-row-actions">
                    <button type="button" className="credits-secondary" onClick={() => startEditPrice(item)}><Pencil size={13} /> Edit</button>
                    <button type="button" className="credits-secondary" disabled={busy} onClick={() => removePrice(item)}><Trash2 size={13} /> Hapus</button>
                  </span>
                </div>
              ))}
          </section>
          <section className="credits-card"><h2>Admin · Konfirmasi transfer</h2><p>Pastikan dana benar-benar diterima dan cocok dengan pesanan sebelum menyetujui. Konfirmasi pengguna bukan bukti pembayaran. Menyetujui atau menolak WAJIB password aksi admin.</p>
            <div className="credits-form">
              <label>Password aksi admin<input type="password" autoComplete="new-password" value={reviewPassword} onChange={(event) => setReviewPassword(event.target.value)} placeholder="Password yang Anda setel di Supabase" /></label>
              <p className="credits-hint">Kolom ini wajib diisi minimal 6 karakter sebelum Setujui/Tolak bisa diproses.</p>
            </div>
            {data.reviews.length > 1 && <PerPageSelect id="reviews-per-page" value={reviewsPaged.perPage} onChange={reviewsPaged.setPerPage} />}
            {!data.reviews.length ? <p>Tidak ada pesanan menunggu verifikasi.</p> : reviewsPaged.slice.map((order) => <article className="credits-order" key={order.id}><strong>{nameFor(order.user_id)}</strong><p>{order.package_name} · {number(order.credits)} kredit · {rupiah(order.price_idr)}</p><p>Referensi: {order.payment_reference}</p><small>ID pesanan: {order.id} · {date(order.submitted_at)}</small><div className="credits-actions"><button disabled={busy} onClick={() => reviewOrder(order.id, true)}>Setujui</button><button className="credits-secondary" disabled={busy} onClick={() => reviewOrder(order.id, false)}>Tolak</button></div></article>)}<Pager page={reviewsPaged.page} pageCount={reviewsPaged.pageCount} total={reviewsPaged.total} onPage={reviewsPaged.setPage} /></section>
        </>}
      </>}
    </div>
  </DropXLayout>;
}
