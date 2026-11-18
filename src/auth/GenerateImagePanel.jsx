import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FreebeatTaskResult } from './FreebeatTaskResult';
import './freebeat.css';

// Freebeat is an admin's own scoped test, not the shared end-user provider.
// The backend performs the quote recheck, consent binding and durable dedupe.
function FreebeatAdminImagePanel({ isAdmin, initialPrompt = '', request }) {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [approval, setApproval] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tests, setTests] = useState([]);
  const [results, setResults] = useState({});
  const load = useCallback(async () => {
    if (!isAdmin) return;
    setBusy(true); setError(''); setApproval(null); setConfirmed(false);
    try {
      const current = await request('status'); setStatus(current);
      if (current.connected) {
        const [catalog, records] = await Promise.all([request('image-models', 'POST'), request('image-tests')]);
        const valid = (Array.isArray(catalog.models) ? catalog.models : []).filter((item) => Number.isSafeInteger(item.model_id) && item.model_id >= 0 && typeof item.name === 'string');
        setModels(valid); setModel((previous) => valid.some((item) => String(item.model_id) === previous) ? previous : (valid[0] ? String(valid[0].model_id) : ''));
        setTests(Array.isArray(records.tests) ? records.tests : []);
      } else { setModels([]); setModel(''); setTests([]); }
    } catch (err) { setStatus(null); setModels([]); setModel(''); setError(err.message || 'Tidak dapat memuat uji gambar.'); }
    finally { setBusy(false); }
  }, [isAdmin, request]);
  useEffect(() => { load(); }, [load]);
  async function prepare(event) {
    event.preventDefault();
    if (busy || !status?.connected || !status?.imageAccess || !model || !prompt.trim()) return;
    setBusy(true); setError(''); setNotice(''); setApproval(null); setConfirmed(false);
    try {
      const result = await request('image-prepare', 'POST', { model_id: Number(model), prompt });
      setApproval(result);
    } catch (err) { setError(err.message || 'Tidak dapat menyiapkan quote.'); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (busy || !approval || !confirmed) return;
    const receipt = approval.approval;
    setApproval(null); setConfirmed(false); setBusy(true); setError(''); setNotice('');
    try {
      const result = await request('image-submit', 'POST', { approval: receipt, confirm: true });
      if (result.status === 'submitted') setNotice('Permintaan diterima. Periksa status untuk melihat hasil dan biaya yang dilaporkan.');
      else setError(`Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan ulangi; periksa Freebeat dan catatan uji.${result.recoveryTaskId ? ` ID tugas untuk pemulihan pribadi: ${result.recoveryTaskId}` : ''}`);
    } catch (err) { setError(`${err.message || 'Pengiriman gagal.'} Jika pengiriman sempat terjadi, hasil dan biaya mungkin tidak pasti. Jangan ulangi sebelum memeriksa catatan.`); }
    try { const records = await request('image-tests'); setTests(Array.isArray(records.tests) ? records.tests : []); } catch { /* preserve warning; never retry generation */ }
    setBusy(false);
  }
  async function poll(id) {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await request('image-task', 'POST', { id }); setResults((previous) => ({ ...previous, [id]: result.task })); }
    catch (err) { setError(err.message || 'Status belum tersedia.'); }
    finally { setBusy(false); }
  }
  if (!isAdmin) return <div className="generate-card"><h2 className="generate-card-title">Generate gambar</h2><p className="generate-hint">Generasi gambar untuk pengguna belum tersedia. Provider dan kredit akan diaktifkan setelah integrasi serta izin penggunaan siap.</p></div>;
  return <div className="generate-card freebeat-page generate-image-panel">
    <div className="generate-card-head"><div><h2 className="generate-card-title">Generate gambar</h2><p className="generate-card-sub">Uji Freebeat menggunakan akun admin sendiri; belum dibagikan ke pengguna lain.</p></div></div>
    <p className="generate-hint">Quote bukan biaya akhir. Pengiriman berbayar memerlukan persetujuan terpisah dengan batas kredit; refund tidak dijamin. Pastikan penggunaan sesuai plan dan ketentuan Freebeat.</p>
    {status && (!status.connected || !status.imageAccess) && <div className="generate-banner" role="status"><span>Hubungkan izin gambar untuk akun admin di halaman Freebeat, lalu kembali ke sini. Sesi bersifat sementara.</span><Link className="generate-banner-link" to="/admin/freebeat">Hubungkan Freebeat</Link></div>}
    {error && <div className="generate-banner is-error" role="alert">{error}</div>}
    {notice && <div className="generate-banner is-success" role="status">{notice}</div>}
    <form onSubmit={prepare}>
      <label className="freebeat-field">Model gambar
        <select className="generate-select" value={model} onChange={(event) => { setModel(event.target.value); setApproval(null); setConfirmed(false); }} disabled={busy || !models.length}>
          {!models.length && <option value="">Tidak ada model tersedia</option>}
          {models.map((item) => <option key={item.model_id} value={item.model_id}>{item.name}</option>)}
        </select>
      </label>
      <label className="freebeat-field">Prompt gambar
        <textarea className="generate-textarea" value={prompt} maxLength={2000} onChange={(event) => { setPrompt(event.target.value); setApproval(null); setConfirmed(false); }} />
      </label>
      <div className="generate-actions"><button className="generate-submit-btn" type="submit" disabled={busy || !status?.connected || !status?.imageAccess || !model || !prompt.trim()}>Siapkan quote</button><button className="generate-secondary-btn" type="button" disabled={busy} onClick={load}>Perbarui koneksi &amp; catatan</button></div>
    </form>
    {approval && <div className="freebeat-result"><h3>Periksa dan setujui satu kali</h3><p>Model {approval.model_id} · Quote {approval.credits} kredit · Batas maksimum {approval.credits} kredit. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}. Quote akan diperiksa kembali sebelum dikirim.</p><pre>{approval.prompt}</pre><label className="freebeat-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Saya menyetujui satu generasi dengan batas maksimum {approval.credits} kredit Freebeat. Biaya aktual dan refund belum dipastikan.</label><div className="freebeat-actions"><button type="button" disabled={!confirmed || busy} onClick={submit}>Setujui dan buat gambar</button></div></div>}
    {tests.length > 0 && <div className="freebeat-result"><h3>Uji gambar admin</h3>{tests.map((test) => <div key={test.id} className="freebeat-test-row"><p>Model {test.model_id} · Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · {test.status}</p>{(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil tidak pasti; jangan ulangi. Hubungi operator untuk merekonsiliasi catatan.</p>}{test.status === 'submitted' && !test.canPoll && <p>Status hanya dapat diperiksa dari sesi Freebeat asal.</p>}{test.canPoll && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={busy} onClick={() => poll(test.id)}>Periksa status</button></div>}{results[test.id] && <FreebeatTaskResult task={results[test.id]} />}</div>)}</div>}
  </div>;
}

// Providers can be added here only when their own secure adapter is implemented;
// this registry does not imply that a provider or a paid model is ready to use.
const IMAGE_PROVIDER_ADAPTERS = [
  { id: 'freebeat', label: 'Freebeat · uji admin', adminOnly: true, component: FreebeatAdminImagePanel },
];
export function GenerateImagePanel(props) {
  const available = IMAGE_PROVIDER_ADAPTERS.filter((provider) => !provider.adminOnly || props.isAdmin);
  const [selected, setSelected] = useState('freebeat');
  if (!available.length) return <div className="generate-card"><h2 className="generate-card-title">Generate gambar</h2><p className="generate-hint">Generasi gambar untuk pengguna belum tersedia. Provider dan kredit akan diaktifkan setelah integrasi serta izin penggunaan siap.</p></div>;
  const active = available.find((provider) => provider.id === selected) || available[0];
  const ProviderPanel = active.component;
  return <div className="generate-stage-col"><div className="generate-card"><label className="generate-field"><span className="generate-label">Provider gambar</span><select className="generate-select" value={active.id} onChange={(event) => setSelected(event.target.value)}>{available.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label></div><ProviderPanel key={active.id} {...props} /></div>;
}
