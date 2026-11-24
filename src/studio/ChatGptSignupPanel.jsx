import { useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  ClipboardCopy,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  MailSearch,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  PlugZap,
  UserPlus,
} from 'lucide-react';
import {
  chatGptSignupApi,
  fetchAutofillUserscript,
  newLoggingId,
  SIGNUP_STEP_META,
} from './chatgptSignupClient';
import {
  APP_HANDOFF_GUIDE,
  buildAutofillBookmarklet,
  sessionCheckGuide,
} from '../lib/chatgptSignup';
import {
  PLATFORM_API_KEYS_URL,
  PLATFORM_BILLING_URL,
  PLATFORM_LOGIN_URL,
  PLATFORM_STEPS,
  SIGNUP_FORM_URL,
} from '../lib/chatgptSignup';

const STEP_ORDER = ['dibuka', 'email_dikirim', 'menunggu_verifikasi', 'terverifikasi'];

// Alasan singkat yang tampil sebelum server menjawab. Versi panjang dan
// riwayat percobaan ada di docs/chatgpt-signup.md, bukan di layar.
const DEFAULT_LIMITS = [
  'Pendaftaran dikirim dari browser Anda, bukan dari server BLEA (Worker diblokir ke domain OpenAI).',
  'Kode verifikasi Anda tempel sendiri di tab OpenAI — tidak ada verifikasi otomatis.',
  'Alamat Gmail ber-+tag bisa ditolak formulir OpenAI; pakai alias tanpa + bila itu terjadi.',
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
 * terkirim. Percobaan berikutnya menunjukkan `chatgpt.com/auth/login` juga
 * gagal (halaman error, lalu tab dilempar ke beranda setelah cookie dihapus),
 * jadi sekarang yang dibuka adalah `chatgpt.com/auth/login_with?callback_path=/&screen_hint=signup`,
 * yang berakhir di formulir "Create an account" milik OpenAI.
 * Langkah berikutnya diverifikasi lewat URL setelah pengguna menekan
 * "Continue" — bukan diklaim berhasil tanpa bukti.
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
  const [verificationCode, setVerificationCode] = useState('');
  const [sessionGuide, setSessionGuide] = useState(null);
  const [codeExpired, setCodeExpired] = useState(false);
  const [codeNote, setCodeNote] = useState('');
  const [codeUnverified, setCodeUnverified] = useState(false);
  // Jalur default: platform.openai.com (akun API). Jalur chatgpt.com tetap
  // tersedia untuk siapa pun yang memang punya paket ChatGPT Plus/Pro.
  const [route, setRoute] = useState('platform');

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

  // Kode terakhir dibaca ulang dari server saat panel dimuat; kegagalannya
  // diabaikan supaya tidak mengganggu.
  useEffect(() => {
    if (!activeId) { setVerificationCode(''); return; }
    let cancelled = false;
    (async () => {
      const res = await chatGptSignupApi.code(activeId);
      if (cancelled || !res.ok) return;
      setVerificationCode(String(res.data?.code || ''));
      setCodeExpired(Boolean(res.data?.code_expired));
      setCodeUnverified(Boolean(res.data?.code_unverified));
      setCodeNote(String(res.data?.hint || ''));
    })();
    return () => { cancelled = true; };
  }, [activeId]);

  // Dibangun dari email yang sedang diketik, bukan nilai lama server.
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

  // Panduan manual, bukan pemeriksaan otomatis: chatgpt.com tidak mengirim
  // header CORS, jadi fetch lintas-origin selalu berakhir "Failed to fetch".

  function toggleSessionGuide() {
    setSessionGuide((current) => (current ? null : sessionCheckGuide()));
  }

  async function prepare() {
    setBusy('prepare');
    setError('');
    setNotice('');
    setCandidates([]);
    // Tab dibuka sebelum await, lalu `opener` dinolkan (noopener membuat
    // window.open mengembalikan null sehingga referensinya hilang).
    const pendingTab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    if (pendingTab) pendingTab.opener = null;
    const closePendingTab = () => { try { pendingTab?.close(); } catch { /* sudah tertutup */ } };

    let res;
    try {
      res = await chatGptSignupApi.prepare(email, newLoggingId(), { route, next: '/api-keys' });
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
    const plusWarning = res.data?.plus_address
      ? ' Alamat ini memakai +tag; sebagian formulir OpenAI menolak tanda + — kalau ditolak, ganti alias tanpa + di TempMail.'
      : '';
    setNotice((res.data?.route === 'platform'
      ? 'Halaman login platform.openai.com dibuka. Tempel email TempMail, tekan Continue, lalu masukkan kode 6 digit dari inbox. Setelah masuk, buat API key di menu API keys.'
      : 'Formulir OpenAI dibuka. Tempel email TempMail di kolom "Email address", lalu tekan Continue. Kalau yang tampil "Welcome back", tekan tautan "Sign up" di bawah tombol Continue lebih dulu.') + plusWarning);
    if (url && pendingTab) {
      pendingTab.location.replace(url);
    } else if (url) {
      // Tab kosong tidak bisa dibuka (popup blocker keras): tetap beri jalan
      // lewat tautan di blok "URL yang dibuka", bukan gagal diam-diam.
      setError('Browser memblokir tab baru. Buka URL di blok "URL yang dibuka" di bawah secara manual.');
    }
    await load();
  }

  // Unduh userscript sebagai berkas, dan simpan isinya sebagai cadangan bila
  // unduhan diblokir.
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
    setVerificationCode(String(res.data?.code || ''));
    // Kode yang baru diekstrak belum kedaluwarsa; status lama harus direset
    // supaya peringatan basi tidak menempel pada kode baru.
    setCodeExpired(Boolean(res.data?.code_expired));
    setCodeUnverified(Boolean(res.data?.code_unverified));
    setCodeNote(String(res.data?.hint || ''));
    if (res.data?.matched) {
      // Email OpenAI berisi KODE, bukan tautan. Instruksi "klik tautan" dulu
      // salah dan membuat pengguna buntu.
      setNotice(res.data?.code
        ? `Email verifikasi ditemukan: “${res.data?.best?.subject || '(tanpa subjek)'}”. Kodenya sudah diambil — salin lalu tempel di tab ChatGPT.`
        : `Email verifikasi ditemukan: “${res.data?.best?.subject || '(tanpa subjek)'}”, tetapi kodenya tidak terbaca otomatis. Buka pesan di TempMail dan salin kodenya.`);
      onVerified?.();
    } else {
      setNotice(res.data?.hint || 'Belum ada pesan verifikasi yang cocok.');
    }
    await load();
  }

  // navigator.clipboard bisa ditolak (iframe/preview), jadi ada fallback
  // textarea + execCommand.
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

  const activeCode = verificationCode || active?.verification_code || '';
  // Halaman tujuan tombol. Jalur platform memakai login platform (default),
  // jalur ChatGPT memakai formulir daftar yang sudah terbukti.
  const signupPageUrl = lastUrl || (route === 'platform' ? PLATFORM_LOGIN_URL : SIGNUP_FORM_URL);

  return (
    <section className="oauth-panel cga-signup" id="cga-signup">
      <header className="oauth-head">
        <div>
          <span className="oauth-badge"><UserPlus size={12} /> Langkah 1 · Buat akun</span>
          <h2>Daftar lewat OpenAI Platform</h2>
          <p>
            Jalur utama: <b>platform.openai.com</b> — email TempMail, Continue, kode 6 digit, lalu masuk.
            Setelah itu buat <b>API key</b> di menu API keys dan tempel di “Tambah akun manual”.
            Tidak perlu paket ChatGPT dan tidak terkena masalah OAuth.
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

      {/* LANGKAH 1 — email + buka formulir. */}
      <div className="cga-step">
        <b className="cga-step-title"><span>1</span> Isi email, buka formulir</b>
        <div className="cga-route">
          <label>
            <input type="radio" name="cga-route" checked={route === 'platform'} onChange={() => setRoute('platform')} />
            <span>
              <b>OpenAI Platform</b> <small>platform.openai.com → API key. Tidak perlu paket ChatGPT.</small>
            </span>
          </label>
          <label>
            <input type="radio" name="cga-route" checked={route === 'chatgpt'} onChange={() => setRoute('chatgpt')} />
            <span>
              <b>ChatGPT (OAuth)</b> <small>chatgpt.com → sesi ChatGPT. Butuh Plus/Pro pribadi.</small>
            </span>
          </label>
        </div>
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
              <button type="button" className="cga-signup-copy" onClick={() => copyText(email, 'email')} disabled={!email.trim()}>
                <ClipboardCopy size={12} /> {copied === 'email' ? 'Email disalin' : 'Salin email'}
              </button>
              <small>
                {tempEmail
                  ? <>Alamat aktif di TempMail: <code>{tempEmail}</code>.</>
                  : 'Belum ada alias TempMail aktif. Buat dulu di halaman TempMail.'}
              </small>
            </div>
            <small className="cga-signup-hint">
              Kolom email di halaman OpenAI <b>tidak terisi otomatis</b>: halaman BLEA tidak boleh
              menyentuh DOM domain lain (same-origin policy), dan parameter{' '}
              <code>login_hint</code> tidak terbukti dipakai formulir OpenAI.{' '}
              <b>Cukup tempel manual</b> — isi email manual adalah jalur utama, bukan kekurangan.
            </small>
            <div className="cga-signup-copy-row">
              <a className="cga-signup-open" href="/tempmail" target="_blank" rel="noreferrer">
                Buka TempMail <ExternalLink size={12} />
              </a>
              <a className="cga-signup-open" href={signupPageUrl} target="_blank" rel="noreferrer">
                {route === 'platform' ? 'Buka login platform' : 'Buka formulir ChatGPT'} <ExternalLink size={12} />
              </a>
            </div>
          </label>
        </div>
      </div>

      {/* LANGKAH 2 — kode verifikasi. */}
      <div className="cga-step">
        <b className="cga-step-title"><span>2</span> Ambil kode verifikasi</b>
        <div className="cga-item-actions">
          <button type="button" className="cga-primary" onClick={verify} disabled={busy === 'verify' || !active}>
            {busy === 'verify' ? <Loader2 size={12} className="agent-spin" /> : <MailSearch size={12} />} Cari email verifikasi
          </button>
          <button type="button" onClick={() => mark('menunggu_verifikasi')} disabled={!active || busy === 'mark:menunggu_verifikasi'}>
            <RefreshCw size={12} /> Tunggu verifikasi
          </button>
          <button type="button" onClick={() => mark('dilewati')} disabled={!active || busy === 'mark:dilewati'}>
            Lewati alamat ini
          </button>
        </div>
        {activeCode ? (
          <div className={`cga-signup-code${codeExpired ? ' is-expired' : ''}${codeUnverified ? ' is-unverified' : ''}`}>
            <b>
              Kode verifikasi
              {codeExpired ? ' (kemungkinan kedaluwarsa)' : ''}
              {codeUnverified ? ' — pengirim belum dikenali' : ''}
            </b>
            <div className="cga-signup-code-row">
              <code className="cga-signup-code-value">{activeCode}</code>
              <button type="button" onClick={() => copyText(activeCode, 'code')}>
                <ClipboardCopy size={12} /> {copied === 'code' ? 'Kode disalin' : 'Salin kode'}
              </button>
            </div>
            <small>Tempel di kolom kode pada tab OpenAI, lalu lanjutkan di sana. Kode ini sekali pakai.</small>
            {codeUnverified && (
              <small className="is-bad">
                Kode ini diambil dari pesan yang tidak terbaca sebagai email OpenAI. Cocokkan dulu dengan inbox.
              </small>
            )}
            {codeNote && !codeUnverified && <small className={codeExpired ? 'is-bad' : ''}>{codeNote}</small>}
          </div>
        ) : (
          <small className="cga-signup-hint">
            Tekan <b>Cari email verifikasi</b> setelah formulir OpenAI meminta kode. Kodenya muncul di sini.
          </small>
        )}
        {route === 'platform' && (
          <ol className="cga-signup-session-steps">
            {PLATFORM_STEPS.map((line) => <li key={line}>{line}</li>)}
          </ol>
        )}
      </div>

      {/* LANGKAH 3 tidak diduplikasi di sini: panel "Continue with ChatGPT" di
          bawah adalah satu-satunya tombol penyimpan akses. Dua tombol dengan
          fungsi sama membuat bingung. */}
      <div className="cga-step">
        <b className="cga-step-title"><span>3</span> Simpan aksesnya ke pool</b>
        {route === 'platform' ? (
          <>
            <p className="cga-step-note">
              Di platform.openai.com buka <b>API keys</b> → <b>Create new secret key</b>, salin key-nya
              (diawali <code>sk-</code>), lalu tempel lewat tombol <b>Tambah akun manual</b> di atas.
              Pemakaian API ditagih dari saldo billing platform, bukan dari paket ChatGPT.
            </p>
            <div className="cga-item-actions">
              <a className="cga-primary cga-jump" href={PLATFORM_API_KEYS_URL} target="_blank" rel="noopener noreferrer">
                <PlugZap size={12} /> Buka API keys
              </a>
              <a className="cga-signup-open" href={PLATFORM_BILLING_URL} target="_blank" rel="noopener noreferrer">
                Cek saldo billing <ExternalLink size={12} />
              </a>
            </div>
          </>
        ) : (
          <>
            <p className="cga-step-note">
              Setelah masuk ke ChatGPT (halaman chat, bukan halaman verifikasi), lanjut ke panel
              <b> Continue with ChatGPT</b> di bawah dan tekan <b>Simpan aksesnya ke pool</b>.
              Yang disimpan access token ±1 jam + refresh token yang diperbarui otomatis, bukan cookie sesi.
            </p>
            <div className="cga-item-actions">
              <a className="cga-primary cga-jump" href="#cga-oauth">
                <PlugZap size={12} /> Ke langkah 3 di bawah
              </a>
            </div>
          </>
        )}
      </div>

      {error && <p className="oauth-error"><CircleAlert size={14} /> {error}</p>}
      {notice && <p className="oauth-ok"><CircleCheck size={14} /> {notice}</p>}

      {attempts.length > 0 && (
        <details className="cga-signup-advanced">
          <summary>Riwayat percobaan &amp; alat tambahan</summary>
          <div className="cga-signup-attempts">
            <label htmlFor="cga-signup-attempt">Permintaan pendaftaran</label>
            <select id="cga-signup-attempt" value={activeId} onChange={(event) => { setActiveId(event.target.value); setCandidates([]); }}>
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
                <div className="cga-signup-confirm">
                  <label htmlFor="cga-signup-return-url">
                    URL setelah menekan <b>Continue</b> di tab OpenAI
                    <small className="cga-signup-hint">
                      Opsional: hanya untuk mencatat bukti langkah. Halaman berikutnya biasanya{' '}
                      <code>auth.openai.com/u/…?state=…</code> — email tidak muncul di URL lanjutan, itu normal.
                    </small>
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
                {active.note && <small>{active.note}</small>}
                {candidates.length > 0 && (
                  <ul className="cga-signup-candidates">
                    {candidates.map((message) => (
                      <li key={message.id}>
                        <b>{message.subject || '(tanpa subjek)'}</b>
                        <small>{message.from || 'pengirim tidak diketahui'} · skor {message.match?.score ?? 0}</small>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {lastUrl && (
            <div className="oauth-manual">
              <b><ClipboardCopy size={13} /> URL formulir yang dibuka</b>
              <p><code>{lastUrl}</code></p>
              <div className="cga-signup-url-actions">
                <a className="cga-signup-open" href={lastUrl} target="_blank" rel="noopener noreferrer">
                  Buka di tab baru <ExternalLink size={12} />
                </a>
                <button type="button" onClick={copyUrl}>{copied === 'url' ? 'URL disalin' : 'Salin URL'}</button>
              </div>
            </div>
          )}

          <details className="cga-signup-optional">
            <summary>Opsional: isi otomatis (tidak wajib)</summary>
            <p>
              Tempel manual sudah cukup. Ini hanya untuk yang malas mengetik ulang: userscript
              Tampermonkey atau bookmarklet. Keduanya hanya mengisi kolom email — <b>Continue</b>{' '}
              tetap Anda yang tekan.
            </p>
            <div className="cga-signup-bookmarklet-row">
              <button type="button" className="cga-signup-userscript" onClick={downloadUserscript} disabled={userscriptBusy || !email.trim()}>
                {userscriptBusy ? <Loader2 size={12} className="agent-spin" /> : <Download size={12} />} Unduh userscript
              </button>
              <a
                className="cga-signup-drag"
                href={bookmarklet}
                title="Seret ke bilah bookmark, lalu klik di tab ChatGPT"
                onClick={(event) => {
                  event.preventDefault();
                  setError('Seret tombol ini ke bilah bookmark, lalu klik bookmark-nya di tab ChatGPT. Chrome membuang awalan javascript: kalau ditempel — seret, jangan tempel.');
                }}
              >
                <ClipboardCopy size={12} /> Seret: bookmarklet
              </a>
              <button type="button" onClick={() => copyText(bookmarklet, 'bookmarklet')}>
                {copied === 'bookmarklet' ? 'Skrip disalin' : 'Salin skrip bookmarklet'}
              </button>
            </div>
            {userscriptText && (
              <div className="cga-signup-userscript-fallback">
                <small>Cadangan: salin skrip ke Tampermonkey → Create a new script.</small>
                <textarea readOnly value={userscriptText} rows={8} spellCheck={false} />
                <button type="button" onClick={() => copyText(userscriptText, 'userscript')}>
                  {copied === 'userscript' ? 'Skrip userscript disalin' : 'Salin skrip userscript'}
                </button>
              </div>
            )}
          </details>
        </details>
      )}

      {/* Semua penjelasan panjang ada di sini, tertutup secara bawaan. */}
      <details className="cga-signup-problems">
        <summary>Kalau ada masalah (klik untuk membuka)</summary>

        <div className="cga-problem">
          <b>Tidak bisa memeriksa sesi ChatGPT dari BLEA</b>
          <p>
            chatgpt.com tidak mengizinkan halaman lain membacanya, jadi pemeriksaan otomatis selalu
            berakhir “Failed to fetch”. Ini panduan manual:
          </p>
          <button type="button" className="cga-signup-userscript" onClick={toggleSessionGuide}>
            <Stethoscope size={12} /> {sessionGuide ? 'Tutup panduan' : 'Tampilkan langkah manual'}
          </button>
          {sessionGuide && (
            <ol className="cga-signup-session-steps">
              {sessionGuide.steps.map((line) => <li key={line}>{line}</li>)}
            </ol>
          )}
        </div>

        <div className="cga-problem">
          <b>{APP_HANDOFF_GUIDE.summary}</b>
          <p>{APP_HANDOFF_GUIDE.why}</p>
          <ol className="cga-signup-session-steps">
            {APP_HANDOFF_GUIDE.steps.map((line) => <li key={line}>{line}</li>)}
          </ol>
        </div>

        <div className="cga-problem">
          <b>OpenAI bilang “Session ended”</b>
          <p>
            Tab login itu sudah mati — biasanya karena ditutup lalu dibuka dari riwayat, atau formulir
            dibuka dua kali. Satu percobaan = satu tab.
          </p>
          <ol className="cga-signup-session-steps">
            <li>Tutup semua tab <code>auth.openai.com</code> dan <code>chatgpt.com</code>.</li>
            <li>Kembali ke panel ini, lalu tekan <b>Siapkan &amp; buka daftar</b> SEKALI.</li>
            <li>Biarkan tab itu terbuka sampai kode verifikasi ditempel.</li>
          </ol>
        </div>

        <ul className="oauth-limits">
          {(config?.why_not_post?.length ? config.why_not_post : DEFAULT_LIMITS).map((line) => (
            <li key={line}><ShieldAlert size={13} /> {line}</li>
          ))}
        </ul>
      </details>

      {config?.verification_note && <p className="oauth-foot">{config.verification_note}</p>}
    </section>
  );
}

export default ChatGptSignupPanel;
