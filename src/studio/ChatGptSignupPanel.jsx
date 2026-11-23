import { useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  ClipboardCopy,
  Download,
  ExternalLink,
  Loader2,
  MailSearch,
  RefreshCw,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';
import {
  chatGptSignupApi,
  fetchAutofillUserscript,
  newLoggingId,
  SIGNUP_STEP_META,
} from './chatgptSignupClient';
import { buildAutofillBookmarklet } from '../lib/chatgptSignup';

const STEP_ORDER = ['dibuka', 'email_dikirim', 'menunggu_verifikasi', 'terverifikasi'];

// Ditampilkan sebelum server menjawab, supaya batasan ini terlihat sejak awal
// (bukan hanya setelah /api/chatgpt-signup selesai dimuat).
const DEFAULT_LIMITS = [
  'Yang dibuka adalah halaman /auth/login milik ChatGPT, bukan endpoint POST /api/auth/signin/openai — endpoint itu wajib csrfToken, kalau tidak hasilnya halaman "tidak dapat memproses upaya masuk".',
  'BLEA tidak mem-POST pendaftaran dari server: Worker diblokir ke domain OpenAI dan Turnstile tidak bisa dilewati.',
  'Akun dibuat hanya bila formulir dikirim dari browser Anda dan email verifikasi diklik sendiri.',
  'Alamat +tag Gmail bisa ditolak formulir OpenAI; gunakan alias TempMail tanpa tanda + bila itu terjadi.',
];

function toneOf(step) {
  return (SIGNUP_STEP_META[step] || { tone: 'muted' }).tone;
}

/**
 * Panel "Daftar ChatGPT pakai email TempMail".
 *
 * Perbaikan penting: dulu tombol utama membuka
 * `chatgpt.com/api/auth/signin/openai?...` dengan GET. Itu endpoint POST
 * NextAuth, jadi tanpa csrfToken halaman selalu berakhir di
 * "Kami tidak dapat memproses upaya masuk Anda" dan email tidak pernah
 * terkirim. Sekarang yang dibuka adalah HALAMAN `/auth/login` (bisa GET),
 * lalu langkah berikutnya diverifikasi lewat URL setelah pengguna menekan
 * "Lanjutkan" — bukan diklaim berhasil tanpa bukti.
 */
export function ChatGptSignupPanel({ onVerified }) {
  const [config, setConfig] = useState(null);
  const [tempEmail, setTempEmail] = useState('');
  const [attempts, setAttempts] = useState([]);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeId, setActiveId] = useState('');
  const [lastUrl, setLastUrl] = useState('');
  const [candidates, setCandidates] = useState([]);
  const [signin, setSignin] = useState(null);
  const [returnUrl, setReturnUrl] = useState('');
  const [returnAnalysis, setReturnAnalysis] = useState(null);
  const [copied, setCopied] = useState('');
  const [bookmarklet, setBookmarklet] = useState('');
  const [userscriptBusy, setUserscriptBusy] = useState(false);
  const [userscriptText, setUserscriptText] = useState('');

  const load = useCallback(async () => {
    const res = await chatGptSignupApi.status();
    if (!res.ok) {
      setError(res.data?.error || 'Status pendaftaran tidak bisa dimuat.');
      return;
    }
    setConfig(res.data?.config || null);
    const alias = String(res.data?.temp_email?.email || '');
    setTempEmail(alias);
    setEmail((current) => current || alias);
    const list = Array.isArray(res.data?.attempts) ? res.data.attempts : [];
    setAttempts(list);
    setActiveId((current) => current || list[0]?.id || '');
  }, []);

  useEffect(() => { load(); }, [load]);

  // Bookmarklet dibangun di klien supaya selalu memakai email yang sedang
  // tertulis di kolom — bukan nilai lama dari server.
  useEffect(() => {
    if (!email.trim()) { setBookmarklet(''); return; }
    try {
      setBookmarklet(buildAutofillBookmarklet(email));
    } catch {
      // Email belum valid: jangan tampilkan bookmarklet yang salah alamat.
      setBookmarklet('');
    }
  }, [email]);

  const active = attempts.find((item) => item.id === activeId) || null;
  const stepIndex = active ? STEP_ORDER.indexOf(active.step) : -1;

  async function prepare() {
    setBusy('prepare');
    setError('');
    setNotice('');
    setCandidates([]);
    // Tab harus dibuka SEBELUM `await`: window.open setelah await dianggap
    // bukan bagian dari klik pengguna dan diblokir popup blocker (Chrome,
    // Safari, Firefox). `noopener` membuat window.open mengembalikan null,
    // jadi referensinya diambil tanpa `noopener` lalu opener-nya dinolkan.
    const pendingTab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (pendingTab) pendingTab.opener = null;
    const closePendingTab = () => { try { pendingTab?.close(); } catch { /* sudah tertutup */ } };

    let res;
    try {
      res = await chatGptSignupApi.prepare(email, newLoggingId());
    } catch (requestError) {
      closePendingTab();
      setBusy('');
      setError(String(requestError?.message || 'URL pendaftaran tidak bisa disiapkan.'));
      return;
    }
    setBusy('');
    if (!res.ok) {
      closePendingTab();
      setError(res.data?.error || 'URL pendaftaran tidak bisa disiapkan.');
      return;
    }
    const url = res.data?.url || res.data?.attempt?.signup_url || '';
    setLastUrl(url);
    setSignin(res.data?.signin || null);
    setActiveId(res.data?.attempt?.id || '');
    setReturnUrl('');
    setReturnAnalysis(null);
    setNotice(res.data?.plus_address
      ? 'Halaman login ChatGPT dibuka, tetapi alamat ini memakai +tag dan sebagian formulir OpenAI menolak tanda +. Tempel emailnya di kolom "Alamat email" (login_hint diabaikan OpenAI), lalu tekan Lanjutkan.'
      : 'Halaman login ChatGPT dibuka. Tempel email TempMail di kolom "Alamat email" (OpenAI mengabaikan login_hint, jadi kolom itu kosong), tekan Lanjutkan, lalu tempel URL hasilnya di bawah.');
    if (url && pendingTab) {
      pendingTab.location.replace(url);
    } else if (url) {
      // Tab kosong tidak bisa dibuka (popup blocker keras): tetap beri jalan
      // lewat tautan di blok "URL yang dibuka", bukan gagal diam-diam.
      setError('Browser memblokir tab baru. Buka URL di blok "URL yang dibuka" di bawah secara manual.');
    }
    await load();
  }

  /**
   * Ambil userscript dari server, lalu:
   *   • unduh sebagai file `blea-chatgpt-autofill.user.js` (Tampermonkey
   *     menawarkan "Install" saat file itu dibuka), dan
   *   • tampilkan isinya di kotak teks sebagai cadangan bila unduhan diblokir.
   */
  async function downloadUserscript() {
    setUserscriptBusy(true);
    setError('');
    setNotice('');
    const res = await fetchAutofillUserscript(email);
    setUserscriptBusy(false);
    if (!res.ok) {
      setError(res.error || 'Userscript tidak bisa diunduh.');
      return;
    }
    setUserscriptText(res.text);
    try {
      const blob = new Blob([res.text], { type: 'text/javascript' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = 'blea-chatgpt-autofill.user.js';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
      setNotice('Berkas userscript diunduh. Buka berkas itu → Tampermonkey menawarkan Install → setelah itu kolom email terisi otomatis setiap halaman login ChatGPT dibuka.');
    } catch {
      setError('Unduhan diblokir browser. Salin isi skrip dari kotak di bawah ke userscript baru di Tampermonkey.');
    }
  }

  async function confirmReturnUrl() {
    if (!active) return;
    setBusy('confirm');
    setError('');
    setReturnAnalysis(null);
    const res = await chatGptSignupApi.confirm(active.id, returnUrl);
    setBusy('');
    if (!res.ok) {
      setError(res.data?.error || 'URL hasil tidak bisa diperiksa.');
      return;
    }
    setReturnAnalysis(res.data?.analysis || null);
    if (res.data?.ok) {
      setNotice(res.data?.hint || 'Langkah terkonfirmasi.');
      await load();
    } else {
      setError(res.data?.hint || 'URL itu belum membuktikan bahwa formulir menerima email TempMail.');
    }
  }

  async function mark(step) {
    if (!active) return;
    setBusy(`mark:${step}`);
    setError('');
    const res = await chatGptSignupApi.mark(active.id, step, '');
    setBusy('');
    if (!res.ok) {
      setError(res.data?.error || 'Langkah gagal disimpan.');
      return;
    }
    setNotice(`Langkah dicatat: ${(SIGNUP_STEP_META[step] || {}).label || step}.`);
    await load();
  }

  async function verify() {
    if (!active) return;
    setBusy('verify');
    setError('');
    setCandidates([]);
    const res = await chatGptSignupApi.verify(active.id);
    setBusy('');
    if (!res.ok) {
      setError(res.data?.error || 'Inbox TempMail tidak bisa diperiksa.');
      return;
    }
    setCandidates(Array.isArray(res.data?.candidates) ? res.data.candidates : []);
    if (res.data?.matched) {
      setNotice(`Email verifikasi ditemukan: “${res.data?.best?.subject || '(tanpa subjek)'}”. Klik tautannya di halaman TempMail untuk menyelesaikan verifikasi.`);
      onVerified?.();
    } else {
      setNotice(res.data?.hint || 'Belum ada pesan verifikasi yang cocok.');
    }
    await load();
  }

  /**
   * Salin ke clipboard dengan fallback. navigator.clipboard bisa ditolak
   * (bukan https, iframe tanpa izin, atau kebijakan browser), jadi ada jalur
   * textarea + execCommand sebagai cadangan.
   */
  async function copyText(value, label) {
    const text = String(value || '');
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopied(label);
        setError('');
        return true;
      }
    } catch { /* lanjut ke fallback */ }
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      if (ok) { setCopied(label); setError(''); return true; }
    } catch { /* jatuh ke pesan error di bawah */ }
    setError('Clipboard tidak tersedia di browser ini. Salin manual dari kotak URL/email di atas.');
    return false;
  }

  const copyUrl = () => copyText(lastUrl, 'url');

  return (
    <section className="oauth-panel cga-signup" id="cga-signup">
      <header className="oauth-head">
        <div>
          <span className="oauth-badge"><UserPlus size={12} /> Email TempMail</span>
          <h2>Daftar ChatGPT dengan email TempMail</h2>
          <p>
            Satu tombol membuka halaman login/daftar resmi ChatGPT. Email TempMail disalin dengan
            satu klik karena kolom email di ChatGPT tidak terisi otomatis. Setelah menekan
            <b> Lanjutkan</b>, tempel URL hasilnya di sini supaya langkahnya terbukti — lalu panel
            memantau inbox untuk email verifikasi. Pendaftaran dikirim dari browser Anda, bukan
            dari server BLEA.
          </p>
        </div>
        <div className="oauth-head-actions">
          <button type="button" className="oauth-start" onClick={prepare} disabled={busy === 'prepare' || !email.trim()}>
            {busy === 'prepare' ? <Loader2 size={14} className="agent-spin" /> : <UserPlus size={14} />}
            {busy === 'prepare' ? 'Menyiapkan…' : 'Siapkan & buka daftar'}
          </button>
          <button type="button" className="oauth-refresh" onClick={load} disabled={busy === 'load'}>
            <RefreshCw size={13} /> Muat ulang
          </button>
        </div>
      </header>

      <div className="cga-signup-grid">
        <label>
          <span>Email dari halaman TempMail</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="nama+tag@gmail.com atau kotak@mail.tm"
            spellCheck={false}
            autoComplete="off"
            maxLength={320}
          />
          <div className="cga-signup-copy-row">
            <button
              type="button"
              className="cga-signup-copy"
              onClick={() => copyText(email, 'email')}
              disabled={!email.trim()}
            >
              <ClipboardCopy size={12} /> {copied === 'email' ? 'Email disalin' : 'Salin email'}
            </button>
            <small>
              {tempEmail
                ? <>Alamat aktif di TempMail: <code>{tempEmail}</code>.</>
                : 'Belum ada alias TempMail aktif. Buat dulu di halaman TempMail supaya email verifikasi bisa dibaca.'}
            </small>
          </div>
          {/* Fakta yang sudah terbukti dari percobaan: parameter login_hint
              diabaikan halaman /auth/login, kolom "Alamat email" tetap kosong.
              Jangan menjanjikan isian otomatis. */}
          <small className="cga-signup-hint">
            Kolom <b>Alamat email</b> di ChatGPT <b>tidak terisi otomatis</b>: halaman BLEA tidak
            boleh menyentuh DOM <code>chatgpt.com</code> (same-origin policy), dan OpenAI mengabaikan
            <code>login_hint</code>. Pilih salah satu: tempel manual, atau pakai tombol bookmarklet
            di bawah (Anda yang mengklik di tab ChatGPT).
          </small>
          <div className="cga-signup-bookmarklet">
            <b>Isi email otomatis</b>
            <p>
              Ada dua jalur. <b>Jalur A</b> dipasang sekali di Tampermonkey lalu berjalan sendiri
              setiap halaman login ChatGPT dibuka — tidak perlu seret atau tempel apa pun.
              <b> Jalur B</b> (bookmarklet) tidak perlu ekstensi, tetapi harus diklik tiap kali.
              Keduanya hanya mengisi kolom email: <b>Lanjutkan</b> tetap Anda yang tekan.
            </p>
            <div className="cga-signup-bookmarklet-row">
              <button type="button" className="cga-signup-userscript" onClick={downloadUserscript} disabled={userscriptBusy || !email.trim()}>
                {userscriptBusy ? <Loader2 size={12} className="agent-spin" /> : <Download size={12} />} Unduh userscript (disarankan)
              </button>
              <a
                className="cga-signup-drag"
                href={bookmarklet}
                title="Seret ke bilah bookmark, lalu klik di tab ChatGPT"
                onClick={(event) => {
                  event.preventDefault();
                  setError('Seret tombol ini ke bilah bookmark (jangan diklik di halaman BLEA), lalu klik bookmark-nya di tab ChatGPT. Chrome membuang awalan javascript: kalau ditempel — seret, jangan tempel.');
                }}
              >
                <ClipboardCopy size={12} /> Seret: Isi email otomatis
              </a>
              <button type="button" onClick={() => copyText(bookmarklet, 'bookmarklet')}>
                {copied === 'bookmarklet' ? 'Skrip disalin' : 'Salin skrip bookmarklet'}
              </button>
            </div>
            <ol className="cga-signup-userscript-steps">
              <li>Pasang ekstensi <b>Tampermonkey</b> (Chrome/Edge/Firefox).</li>
              <li>Tekan <b>Unduh userscript</b> di atas, lalu buka berkasnya → pilih <b>Install</b>.</li>
              <li>Buka lagi <i>Siapkan &amp; buka daftar</i>: kolom email terisi sendiri, muncul penanda kecil “Email diisi oleh BLEA AI”.</li>
            </ol>
            {userscriptText && (
              <div className="cga-signup-userscript-fallback">
                <small>Cadangan: isi skrip userscript (salin ke Tampermonkey → Create a new script).</small>
                <textarea readOnly value={userscriptText} rows={8} spellCheck={false} />
                <button type="button" onClick={() => copyText(userscriptText, 'userscript')}>
                  {copied === 'userscript' ? 'Skrip userscript disalin' : 'Salin skrip userscript'}
                </button>
              </div>
            )}
          </div>
        </label>
        <div className="cga-signup-links">
          <a href="/tempmail" target="_blank" rel="noreferrer">Buka halaman TempMail <ExternalLink size={12} /></a>
          <a href="https://chatgpt.com/auth/login" target="_blank" rel="noreferrer">Halaman login ChatGPT <ExternalLink size={12} /></a>
        </div>
      </div>

      {lastUrl && (
        <div className="oauth-manual">
          <b><ClipboardCopy size={13} /> URL yang dibuka</b>
          <p><code>{lastUrl}</code></p>
          <div className="cga-signup-url-actions">
            <a className="cga-signup-open" href={lastUrl} target="_blank" rel="noopener noreferrer">
              Buka di tab baru <ExternalLink size={12} />
            </a>
            <button type="button" onClick={copyUrl}>{copied === 'url' ? 'URL disalin' : 'Salin URL'}</button>
          </div>
        </div>
      )}

      <ul className="oauth-limits">
        {(config?.why_not_post?.length ? config.why_not_post : DEFAULT_LIMITS).map((line) => (
          <li key={line}><ShieldAlert size={13} /> {line}</li>
        ))}
      </ul>

      {error && <p className="oauth-error"><CircleAlert size={14} /> {error}</p>}
      {notice && <p className="oauth-ok"><CircleCheck size={14} /> {notice}</p>}

      {attempts.length > 0 && (
        <div className="cga-signup-attempts">
          <label htmlFor="cga-signup-attempt">Permintaan pendaftaran</label>
          <select
            id="cga-signup-attempt"
            value={activeId}
            onChange={(event) => { setActiveId(event.target.value); setCandidates([]); }}
          >
            {attempts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.email} · {new Date(item.updated_at || item.created_at).toLocaleString('id-ID')}
              </option>
            ))}
          </select>

          {active && (
            <>
              <ol className="cga-signup-steps">
                {STEP_ORDER.map((step, index) => (
                  <li key={step} className={`is-${toneOf(step)} ${index <= stepIndex ? 'is-done' : ''}`}>
                    <span>{index + 1}</span>
                    {(SIGNUP_STEP_META[step] || {}).label || step}
                  </li>
                ))}
              </ol>
              {/* Bukti sebelum klaim: langkah "email dikirim" hanya boleh
                  dicatat setelah URL hasil klik memuat email TempMail. Ini
                  yang mencegah kejadian sebelumnya — UI bilang "URL
                  disiapkan" padahal browser berhenti di halaman error. */}
              <div className="cga-signup-confirm">
                <label htmlFor="cga-signup-return-url">
                  URL setelah menekan <b>Lanjutkan</b> di tab ChatGPT
                </label>
                <div className="cga-signup-confirm-row">
                  <input
                    id="cga-signup-return-url"
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    value={returnUrl}
                    onChange={(event) => setReturnUrl(event.target.value)}
                    placeholder="https://auth.openai.com/… atau https://chatgpt.com/auth/…"
                  />
                  <button type="button" className="cga-primary" onClick={confirmReturnUrl} disabled={busy === 'confirm' || !returnUrl.trim()}>
                    {busy === 'confirm' ? <Loader2 size={13} className="agent-spin" /> : <CircleCheck size={13} />} Periksa URL
                  </button>
                </div>
                {returnAnalysis && (
                  <small className={returnAnalysis.ok ? 'is-ok' : 'is-bad'}>
                    {returnAnalysis.ok ? 'Cocok — ' : 'Belum cocok — '}{returnAnalysis.detail}
                  </small>
                )}
              </div>

              {signin?.steps?.length > 0 && (
                <details className="cga-signup-help">
                  <summary>Email tidak terbawa / halaman error? Ikuti langkah ini</summary>
                  <ol>
                    {signin.steps.map((line) => <li key={line}>{line}</li>)}
                  </ol>
                  <p>
                    Formulir aslinya <code>POST {signin.form.url}</code> dengan
                    {' '}<code>{signin.form.fields.join(' + ')}</code>. Token CSRF diambil browser dari
                    {' '}<code>{signin.csrf_url}</code> pada saat itu juga — BLEA tidak menyimpan atau
                    mengirimkannya.
                  </p>
                </details>
              )}

              <div className="cga-item-actions">
                <button type="button" onClick={() => mark('menunggu_verifikasi')} disabled={busy === 'mark:menunggu_verifikasi'}>
                  <RefreshCw size={12} /> Tunggu verifikasi
                </button>
                <button type="button" onClick={verify} disabled={busy === 'verify'}>
                  {busy === 'verify' ? <Loader2 size={12} className="agent-spin" /> : <MailSearch size={12} />} Cari email verifikasi
                </button>
                <button type="button" onClick={() => mark('dilewati')} disabled={busy === 'mark:dilewati'}>
                  Lewati alamat ini
                </button>
              </div>
              {active.note && <small>{active.note}</small>}
              {candidates.length > 0 && (
                <ul className="cga-signup-candidates">
                  {candidates.map((message) => (
                    <li key={message.id}>
                      <b>{message.subject || '(tanpa subjek)'}</b>
                      <small>{message.from || 'pengirim tidak diketahui'} · skor {message.match?.score ?? 0}</small>
                      {message.match?.reasons?.length ? <small>{message.match.reasons.join(' · ')}</small> : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {config?.verification_note && <p className="oauth-foot">{config.verification_note}</p>}
    </section>
  );
}

export default ChatGptSignupPanel;
