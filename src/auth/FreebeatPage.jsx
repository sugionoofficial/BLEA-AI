import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, RefreshCw, Unplug } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { FreebeatImageForm } from './FreebeatImageForm';
import { supabase } from '../lib/supabase';
import './freebeat.css';

async function request(action, method = 'GET', body) {
  const { data } = await supabase.auth.getSession();
  let session = data?.session;
  if (session?.expires_at && session.expires_at * 1000 < Date.now() + 60000) session = (await supabase.auth.refreshSession()).data?.session;
  if (!session?.access_token) throw new Error('Sesi login berakhir. Silakan login kembali.');
  const res = await fetch(`/api/freebeat/${action}`, { method, headers: { authorization: `Bearer ${session.access_token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin', cache: 'no-store' });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || 'Freebeat tidak dapat dihubungi.');
  return payload;
}

const resultMessage = {
  connected: 'Otorisasi Freebeat berhasil. Tekan Periksa saldo untuk menguji MCP.',
  'connected-limited': 'Freebeat hanya memberikan izin baca. Izin generasi belum diberikan; saldo dan pemeriksaan model tetap dapat dicoba.',
  denied: 'Otorisasi dibatalkan atau ditolak oleh Freebeat.',
  invalid: 'Sesi otorisasi tidak cocok atau kedaluwarsa. Coba hubungkan kembali.',
  failed: 'Otorisasi Freebeat tidak berhasil. Coba lagi atau periksa akses akun Anda.',
  'failed-network': 'Worker tidak dapat terhubung ke Freebeat saat penukaran token. [FB-TOKEN-NETWORK]',
  'failed-timeout': 'Freebeat tidak merespons saat penukaran token. [FB-TOKEN-TIMEOUT]',
  'failed-redirect': 'Freebeat mengirim pengalihan token yang tidak didukung atau tidak aman. [FB-TOKEN-REDIRECT]',
  'failed-http': 'Freebeat menolak penukaran token. [FB-TOKEN-HTTP]',
  'failed-response': 'Respons token Freebeat tidak valid. [FB-TOKEN-RESPONSE]',
};

export function FreebeatPage() {
  const [connected, setConnected] = useState(false);
  const [imageAccess, setImageAccess] = useState(false);
  const [expiresAt, setExpiresAt] = useState(null);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const cookieInput = useRef(null);
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteError, setSiteError] = useState('');
  const [siteBalance, setSiteBalance] = useState(null);
  const [siteAcknowledged, setSiteAcknowledged] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageModels, setImageModels] = useState(null);
  const [imageSchemas, setImageSchemas] = useState(null);
  const [quoteModel, setQuoteModel] = useState('');
  const [quotePrompt, setQuotePrompt] = useState('');
  const [imageQuote, setImageQuote] = useState(null);
  const [quoteError, setQuoteError] = useState('');
  const [approval, setApproval] = useState(null);
  const [spendConfirmed, setSpendConfirmed] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState('');
  const [testNotice, setTestNotice] = useState('');
  const [tests, setTests] = useState([]);
  const [taskResults, setTaskResults] = useState({});
  const load = useCallback(async () => {
    try { const result = await request('status'); setConnected(result.connected); setImageAccess(result.imageAccess === true); setExpiresAt(result.expiresAt); }
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
      if (action === 'start' || action === 'start-image') {
        const result = await request(action, 'POST');
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
        setConnected(false); setImageAccess(false); setExpiresAt(null); setBalance(null); setImageModels(null); setImageSchemas(null); setImageQuote(null); setApproval(null); setSpendConfirmed(false); setTests([]); setTaskResults({});
        setNotice(result.revoked ? 'Koneksi lokal dihapus dan token dicabut di Freebeat.' : 'Koneksi lokal dihapus. Pencabutan token di Freebeat belum dapat dikonfirmasi; periksa pengaturan akses di akun Freebeat.');
      }
    } catch (err) { setError(err.message || 'Koneksi gagal.'); }
    finally { setBusy(false); }
  }
  async function inspectImages(action) {
    if (imageBusy) return;
    setImageBusy(true); setImageError('');
    if (action === 'image-models') setImageModels(null); else setImageSchemas(null);
    try {
      const result = await request(action, 'POST');
      if (action === 'image-models') setImageModels(result); else setImageSchemas(result);
    } catch (err) { setImageError(err.message || 'Pemeriksaan gambar gagal.'); }
    finally { setImageBusy(false); }
  }
  async function inspectQuote(event) {
    event.preventDefault();
    if (imageBusy) return;
    setImageBusy(true); setQuoteError(''); setImageQuote(null);
    try {
      const result = await request('image-quote', 'POST', { model_id: Number(quoteModel), prompt: quotePrompt });
      setImageQuote(result.quote);
    } catch (err) { setQuoteError(err.message || 'Pemeriksaan quote gagal.'); }
    finally { setImageBusy(false); }
  }
  async function refreshTests() {
    const result = await request('image-tests');
    setTests(result.tests);
  }
  async function prepareTest(event) {
    event.preventDefault();
    if (testBusy) return;
    setTestBusy(true); setTestError(''); setTestNotice(''); setApproval(null); setSpendConfirmed(false);
    try {
      const result = await request('image-prepare', 'POST', { model_id: Number(quoteModel), prompt: quotePrompt });
      setApproval(result);
      await refreshTests();
    } catch (err) { setApproval(null); setTestError(err.message || 'Persiapan uji gagal.'); }
    finally { setTestBusy(false); }
  }
  async function submitTest() {
    if (!approval || !spendConfirmed || testBusy) return;
    const receipt = approval.approval;
    setApproval(null); setSpendConfirmed(false); setTestBusy(true); setTestError(''); setTestNotice('');
    try {
      const result = await request('image-submit', 'POST', { approval: receipt, confirm: true });
      if (result.status === 'submitted') setTestNotice('Permintaan diterima untuk dipantau. Ini bukan konfirmasi gambar selesai atau biaya akhir.');
      else setTestError(`Hasil pengiriman tidak pasti dan mungkin sudah memakai kredit. Jangan ulangi; periksa Freebeat dan catatan uji.${result.recoveryTaskId ? ` ID tugas untuk pemulihan pribadi: ${result.recoveryTaskId}` : ''}`);
    } catch (err) { setTestError(`${err.message || 'Permintaan gagal.'} Jika pengiriman sempat terjadi, hasil dan biaya mungkin tidak pasti. Jangan ulangi sebelum memeriksa catatan.`); }
    try { await refreshTests(); } catch { /* the warning above still applies */ }
    setTestBusy(false);
  }
  async function inspectTests() {
    if (testBusy) return;
    setTestBusy(true); setTestError('');
    try { await refreshTests(); } catch (err) { setTestError(err.message || 'Catatan tidak tersedia.'); }
    finally { setTestBusy(false); }
  }
  async function pollTest(id) {
    if (testBusy) return;
    setTestBusy(true); setTestError('');
    try { const result = await request('image-task', 'POST', { id }); setTaskResults((old) => ({ ...old, [id]: result.task })); }
    catch (err) { setTestError(err.message || 'Status belum tersedia.'); }
    finally { setTestBusy(false); }
  }
  async function checkSiteBalance(event) {
    event.preventDefault();
    if (siteBusy || !siteAcknowledged) return;
    const cookie = cookieInput.current?.value || '';
    if (cookieInput.current) cookieInput.current.value = '';
    setSiteBusy(true); setSiteError(''); setSiteBalance(null);
    try {
      const result = await request('site-balance', 'POST', { cookie });
      setSiteBalance(result.balance);
    } catch (err) { setSiteError(err.message || 'Uji saldo situs gagal.'); }
    finally { setSiteBusy(false); }
  }
  return <DropXLayout title="Freebeat MCP" description="Uji koneksi Freebeat khusus admin.">
    <div className="freebeat-page">
      <section className="freebeat-card">
        <span className="freebeat-kicker">MCP · OAUTH · READ ONLY</span><h2>Hubungkan Freebeat</h2>
        <p>Uji koneksi resmi MCP dan baca saldo akun Freebeat Anda. Pemeriksaan saldo tidak memakai kredit; uji gambar terpisah di bawah hanya dikirim setelah persetujuan eksplisit.</p>
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
      <section className="freebeat-card freebeat-site-test">
        <span className="freebeat-kicker">GAMBAR · KHUSUS ADMIN · BACA SAJA</span>
        <h2>Persiapan uji gambar</h2>
        <p>Periksa daftar model, struktur tool MCP dan respons quote tanpa membuat gambar atau memakai kredit. Pembelian BLEA belum diaktifkan; uji generasi admin memerlukan persetujuan terpisah di bawah.</p>
        <p>Untuk memeriksa izin gambar, tombol berikut meminta izin <code>freebeat:read</code> dan <code>freebeat:generate</code> melalui Freebeat. Izin ini lebih luas dari baca saldo; Anda harus menyetujuinya di Freebeat.</p>
        <div className="freebeat-status">Izin gambar: {imageAccess ? 'diminta dan terindikasi diberikan; penggunaan belum diuji' : 'belum diberikan atau belum terverifikasi'}</div>
        <div className="freebeat-actions">
          <button type="button" disabled={loading || busy || imageBusy} onClick={() => run('start-image')}>Hubungkan izin gambar</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy} onClick={() => inspectImages('image-models')}>Lihat model gambar</button>
          <button type="button" className="is-secondary" disabled={loading || !connected || imageBusy} onClick={() => inspectImages('image-schemas')}>Periksa skema tool gambar</button>
        </div>
        {imageModels && <div className="freebeat-result"><h3>Model gambar dari Freebeat</h3><pre>{JSON.stringify(imageModels.models, null, 2)}</pre>{imageModels.truncated && <p>Daftar dibatasi hingga 100 model.</p>}</div>}
        {imageSchemas && <div className="freebeat-result"><h3>Struktur tool gambar</h3><p>Hanya nama parameter dan tipe dasar; deskripsi dan data sesi tidak ditampilkan. Bagikan hasil ini untuk memeriksa format biaya.</p><pre>{JSON.stringify(imageSchemas.tools, null, 2)}</pre>{imageSchemas.truncated && <p>Daftar dibatasi hingga lima halaman; sebagian tool mungkin tidak ditampilkan.</p>}</div>}
        {imageError && <div className="freebeat-alert is-error" role="alert">{imageError}</div>}
      </section>
      <section className="freebeat-card freebeat-site-test">
        <span className="freebeat-kicker">UJI GAMBAR · KHUSUS ADMIN · KREDIT FREEBEAT</span>
        <h2>Uji generasi gambar admin</h2>
        <p>Hanya akun Freebeat di browser admin ini yang digunakan. Ini bukan pembelian atau pemakaian kredit BLEA. Isi ID model dan prompt di bawah, lalu siapkan quote baru. Pastikan penggunaan sesuai ketentuan dan plan Freebeat; manfaat plan yang hanya untuk aplikasi web tidak otomatis berlaku untuk MCP.</p>
        <p>Freebeat melaporkan quote, bukan biaya akhir; saldo dapat terpakai meskipun tugas gagal, dan refund tidak dijamin. Jika hasil pengiriman tidak pasti, jangan mengulang sebelum memeriksa Freebeat. Uji dengan hasil tidak pasti akan mengunci pengiriman berikutnya hingga ditinjau operator.</p>
        <FreebeatImageForm loading={loading} connected={connected} imageAccess={imageAccess} busy={busy} imageBusy={imageBusy} testBusy={testBusy} model={quoteModel} prompt={quotePrompt}
          onModelChange={(value) => { setQuoteModel(value); setImageQuote(null); setQuoteError(''); setApproval(null); setSpendConfirmed(false); }}
          onPromptChange={(value) => { setQuotePrompt(value); setImageQuote(null); setQuoteError(''); setApproval(null); setSpendConfirmed(false); }}
          onInspect={inspectQuote} onPrepare={prepareTest} />
        {quoteError && <div className="freebeat-alert is-error" role="alert">{quoteError}</div>}
        {imageQuote !== null && <div className="freebeat-result"><h3>Respons quote yang disaring</h3><p>Hanya status dalam daftar aman yang ditampilkan; status lain tetap disembunyikan. Nilai ini belum diverifikasi sebagai biaya final atau izin generasi. Tidak ada kredit yang dipakai.</p><pre>{JSON.stringify(imageQuote, null, 2)}</pre></div>}
        <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={loading || !connected || testBusy} onClick={inspectTests}>Periksa catatan uji</button></div>
        {approval && <div className="freebeat-result">
          <h3>Periksa dan setujui satu kali</h3>
          <p>Model: <strong>{approval.model_id}</strong> · Quote Freebeat: <strong>{approval.credits} kredit</strong> · Batas maksimum yang dikirim: <strong>{approval.credits} kredit</strong>. Berlaku hingga {new Date(approval.expiresAt).toLocaleTimeString('id-ID')}. Jika quote berubah, pengiriman ditolak.</p>
          <p>Prompt yang akan dikirim:</p><pre>{approval.prompt}</pre>
          <label className="freebeat-confirm"><input type="checkbox" checked={spendConfirmed} onChange={(event) => setSpendConfirmed(event.target.checked)} /> Saya menyetujui satu kali generasi ini dengan batas maksimum {approval.credits} kredit Freebeat. Saya memahami biaya aktual dan refund belum dipastikan.</label>
          <div className="freebeat-actions"><button type="button" disabled={!spendConfirmed || testBusy} onClick={submitTest}>Setujui dan kirim satu gambar</button></div>
        </div>}
        {testError && <div className="freebeat-alert is-error" role="alert">{testError}</div>}
        {testNotice && <div className="freebeat-alert" role="status">{testNotice}</div>}
        {tests.length > 0 && <div className="freebeat-result"><h3>Catatan uji admin</h3>{tests.map((test) => <div key={test.id} className="freebeat-test-row">
          <p>Model {test.model_id} · Batas {test.max_credits} kredit · {new Date(test.created_at).toLocaleString('id-ID')} · {test.status}</p>
          {(test.status === 'unknown' || test.status === 'dispatching') && <p>Hasil tidak pasti; pengiriman baru diblokir. Jangan mencoba ulang. Periksa aktivitas Freebeat dan minta operator meninjau catatan.</p>}
          {test.status === 'submitted' && !test.canPoll && <p>Status hanya dapat diperiksa dari sesi Freebeat yang digunakan saat pengiriman.</p>}
          {test.canPoll && <div className="freebeat-actions"><button type="button" className="is-secondary" disabled={testBusy} onClick={() => pollTest(test.id)}>Periksa status</button></div>}
          {taskResults[test.id] && <div><p>Status tugas: {taskResults[test.id].status}. Biaya/refund yang tidak dilaporkan adalah tidak diketahui.</p><pre>{JSON.stringify(taskResults[test.id].billing, null, 2)}</pre>{taskResults[test.id].images.map((image, index) => <p key={image}><a href={image} target="_blank" rel="noopener noreferrer">Buka hasil gambar {index + 1} di tautan Freebeat</a></p>)}{taskResults[test.id].images.length > 0 && <p>Membuka tautan menghubungkan browser Anda ke host gambar penyedia.</p>}</div>}
        </div>)}</div>}
      </section>
      <section className="freebeat-card freebeat-site-test">
        <span className="freebeat-kicker">EKSPERIMEN SITUS · KHUSUS ADMIN · BACA SALDO</span>
        <h2>Uji saldo situs dengan cookie</h2>
        <p>Terpisah dari MCP: pengujian sekali pakai ini mengirim cookie sesi situs Anda melalui BLEA ke endpoint saldo Freebeat yang tidak didokumentasikan sebagai API publik. Tidak ada generasi atau pembelian. Keberhasilan dan izin penggunaan belum terjamin.</p>
        <p><strong>Cookie dapat memberikan akses penuh ke akun.</strong> Gunakan hanya akun Anda sendiri dan pastikan plan serta ketentuan Freebeat mengizinkan pengujian ini. Jangan bagikan cookie melalui chat. Cookie dikirim lewat infrastruktur BLEA dan Freebeat, tetapi fitur ini tidak menyimpannya; input dikosongkan saat dikirim.</p>
        <p>Di situs Freebeat yang sudah login, buka Network pada Developer Tools, pilih permintaan <code>findCredits</code>, lalu salin hanya nilai <code>Cookie</code> pada Request Headers. Jangan salin header lain atau seluruh perintah cURL. Bersihkan clipboard setelahnya. Cookie yang kedaluwarsa atau membutuhkan autentikasi lain mungkin tidak berhasil.</p>
        <form onSubmit={checkSiteBalance} autoComplete="off">
          <label className="freebeat-field">Nilai header Cookie dari permintaan saldo situs Freebeat
            <input ref={cookieInput} type="password" autoComplete="off" spellCheck={false} maxLength={8192} required placeholder="nama=nilai; nama_lain=nilai" />
          </label>
          <label className="freebeat-confirm"><input type="checkbox" checked={siteAcknowledged} onChange={(event) => setSiteAcknowledged(event.target.checked)} /> Saya memahami risikonya dan memastikan saya berhak menggunakan sesi serta menguji akses ini.</label>
          <div className="freebeat-actions"><button type="submit" disabled={siteBusy || !siteAcknowledged}>{siteBusy ? 'Memeriksa…' : 'Uji saldo situs sekali'}</button></div>
        </form>
        {siteError && <div className="freebeat-alert is-error" role="alert">{siteError}</div>}
        {siteBalance && <div className="freebeat-result"><h3>Saldo situs Freebeat</h3><pre>{JSON.stringify(siteBalance, null, 2)}</pre><p>Ini bukan koneksi MCP dan tidak mengaktifkan akun bersama.</p></div>}
      </section>
    </div>
  </DropXLayout>;
}
