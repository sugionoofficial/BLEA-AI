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
  ShieldCheck,
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
import { buildAutofillBookmarklet, sessionCheckGuide } from '../lib/chatgptSignup';
import { beginChatGptSignIn } from './chatgptOAuthClient';

const STEP_ORDER = ['dibuka', 'email_dikirim', 'menunggu_verifikasi', 'terverifikasi'];

// Ditampilkan sebelum server menjawab, supaya batasan ini terlihat sejak awal
// (bukan hanya setelah /api/chatgpt-signup selesai dimuat).
const DEFAULT_LIMITS = [
  'Yang dibuka adalah HALAMAN chatgpt.com/auth/login_with?callback_path=/&screen_hint=signup (berakhir di formulir "Create an account" OpenAI), bukan endpoint POST /api/auth/signin/openai — endpoint itu wajib csrfToken, kalau tidak hasilnya halaman "tidak dapat memproses upaya masuk".',
  'BLEA tidak mem-POST pendaftaran dari server: Worker diblokir ke domain OpenAI dan Turnstile tidak bisa dilewati.',
  'Akun dibuat hanya bila formulir dikirim dari browser Anda dan kode verifikasi ditempel sendiri di tab OpenAI.',
  'Dua URL sebelumnya sudah gagal dan tidak dipakai lagi: chatgpt.com/auth/login (error "tidak dapat menyiapkan pemuatan ini", lalu tab dilempar ke beranda setelah cookie dihapus) dan auth.openai.com/log-in tanpa cookie ("Sesi Anda telah berakhir", bukan formulir).',
  'URL tanpa parameter terbukti merusak halaman ini: callback_path yang di-encode (%2F) dan prompt=... sama-sama menghasilkan HTTP 500. Jangan menambah parameter tanpa menguji ulang.',
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
  const [linking, setLinking] = useState(false);
  const [codeExpired, setCodeExpired] = useState(false);
  const [codeNote, setCodeNote] = useState('');
  const [codeUnverified, setCodeUnverified] = useState(false);

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

  // Kode yang tersimpan hanya diketahui setelah tombol verify ditekan, jadi
  // saat panel dibuka/dimuat ulang kodenya dibaca ulang dari server. Kalau
  // gagal, panel tetap jalan tanpa kode — tidak perlu mengganggu pengguna
  // dengan error hanya karena ini.
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

  /**
   * Panduan manual — BUKAN pemeriksaan otomatis.
   *
   * Versi sebelumnya memanggil chatgpt.com/backend-api/me dari browser dan
   * hasilnya "Failed to fetch": endpoint itu tidak mengirim header CORS, jadi
   * halaman BLEA memang tidak boleh membacanya. Itu kesalahan rancang saya.
   */
  function toggleSessionGuide() {
    setSessionGuide((current) => (current ? null : sessionCheckGuide()));
  }

  /**
   * Simpan akses akun yang BARU SAJA berhasil diverifikasi.
   *
   * Login manual di ChatGPT menghasilkan cookie sesi di browser Anda — dan
   * justru cookie itulah yang tidak boleh dan tidak bisa dipakai BLEA: server
   * tidak bisa membacanya, dan menyimpannya berarti menyimpan kredensial
   * ChatGPT mentah. Yang dipakai adalah OAuth resmi yang sudah ada
   * (`Continue with ChatGPT`): access token 1 jam + refresh token bergulir,
   * diperbarui otomatis oleh pool, dan bisa dicabut terpisah.
   *
   * `login_hint` hanya dikirim pada login ulang akun yang sudah punya
   * client_id terbitan — bukan pada pendaftaran pertama.
   */
  async function linkToPool() {
    setLinking(true);
    setError('');
    setNotice('');
    const res = await beginChatGptSignIn({ loginHint: email.trim().toLowerCase() });
    if (!res.ok) {
      setLinking(false);
      setError(res.error || 'Tidak bisa memulai OAuth ChatGPT.');
      return;
    }
    // Berhasil = halaman dialihkan ke OpenAI, jadi tidak ada state yang bisa
    // diperbarui lagi dari sini.
  }

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
      ? 'Formulir OpenAI dibuka. Alamat ini memakai +tag, dan sebagian formulir OpenAI menolak tanda + — kalau ditolak, ganti alias tanpa + di TempMail. Tempel emailnya di kolom "Email address", lalu tekan Continue.'
      : 'Formulir OpenAI dibuka. Tempel email TempMail di kolom "Email address", lalu tekan Continue. Kalau yang tampil "Welcome back", tekan tautan "Sign up" di bawah tombol Continue lebih dulu.');
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
            Jalur utamanya sederhana: <b>isi email manual</b>. Satu tombol membuka halaman
            formulir "Create an account" OpenAI, Anda salin-tempel email TempMail, tekan <b>Continue</b>, lalu
            tempel URL hasilnya di sini supaya langkahnya terbukti — panel memantau inbox untuk
            email verifikasi. Bingkai otomatis (userscript/bookmarklet) hanya opsi tambahan,
            tidak wajib. Pendaftaran dikirim dari browser Anda, bukan dari server BLEA.
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
          {/* Fakta yang sudah terbukti dari percobaan: kolom email tetap kosong
              dan parameter login_hint tidak terbukti dipakai formulir OpenAI.
              Jangan menjanjikan isian otomatis, dan jangan mengarang sebabnya. */}
          <small className="cga-signup-hint">
            Kolom email di halaman OpenAI <b>tidak terisi otomatis</b>: halaman BLEA tidak boleh
            menyentuh DOM domain lain (same-origin policy), dan parameter{' '}
            <code>login_hint</code> tidak terbukti dipakai formulir OpenAI.{' '}
            <b>Cukup tempel manual</b> — itu sudah benar dan paling cepat.
          </small>
          <div className="cga-signup-session">
            <button type="button" className="cga-signup-userscript" onClick={toggleSessionGuide}>
              <Stethoscope size={12} /> {sessionGuide ? 'Tutup panduan sesi' : 'Sesi masih ada? Cek manual (30 detik)'}
            </button>
            <small>
              BLEA <b>tidak bisa</b> memeriksa sesi ChatGPT dari sini: chatgpt.com tidak
              mengizinkan halaman lain membacanya, jadi pemeriksaan otomatis selalu
              berakhir &quot;Failed to fetch&quot;. Ini panduan manual, bukan tombol ajaib.
            </small>
            {sessionGuide && (
              <ol className="cga-signup-session-steps">
                {sessionGuide.steps.map((line) => <li key={line}>{line}</li>)}
              </ol>
            )}
          </div>
          <details className="cga-signup-optional">
            <summary>Opsional: isi otomatis (tidak wajib)</summary>
            <p>
              Tempel manual sudah cukup. Bagian ini hanya untuk yang malas mengetik ulang:
              <b> Jalur A</b> userscript Tampermonkey (mengisi sendiri tiap halaman dibuka),
              <b> Jalur B</b> bookmarklet (tanpa ekstensi, diklik tiap kali). Keduanya hanya
              mengisi kolom email — <b>Continue</b> tetap Anda yang tekan.
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
                  setError('Seret tombol ini ke bilah bookmark (jangan diklik di halaman BLEA), lalu klik bookmark-nya di tab ChatGPT. Chrome membuang awalan javascript: kalau ditempel — seret, jangan tempel.');
                }}
              >
                <ClipboardCopy size={12} /> Seret: bookmarklet
              </a>
              <button type="button" onClick={() => copyText(bookmarklet, 'bookmarklet')}>
                {copied === 'bookmarklet' ? 'Skrip disalin' : 'Salin skrip bookmarklet'}
              </button>
            </div>
            <ol className="cga-signup-userscript-steps">
              <li>Untuk Jalur A: pasang <b>Tampermonkey</b>, tekan <b>Unduh userscript</b>, buka berkasnya → <b>Install</b>.</li>
              <li>Untuk Jalur B: seret tombol bookmarklet ke bilah bookmark, lalu klik di tab ChatGPT.</li>
            </ol>
            {userscriptText && (
              <div className="cga-signup-userscript-fallback">
                <small>Cadangan: salin skrip userscript ke Tampermonkey → Create a new script.</small>
                <textarea readOnly value={userscriptText} rows={8} spellCheck={false} />
                <button type="button" onClick={() => copyText(userscriptText, 'userscript')}>
                  {copied === 'userscript' ? 'Skrip userscript disalin' : 'Salin skrip userscript'}
                </button>
              </div>
            )}
          </details>
        </label>
        <div className="cga-signup-links">
          <a href="/tempmail" target="_blank" rel="noreferrer">Buka halaman TempMail <ExternalLink size={12} /></a>
          <a href="https://chatgpt.com/auth/login_with?callback_path=/&screen_hint=signup" target="_blank" rel="noreferrer">Formulir daftar OpenAI <ExternalLink size={12} /></a>
        </div>
      </div>

      {/* Langkah wajib saat permintaan kode verifikasi: tab OpenAI harus
          TETAP terbuka. Kalau ditutup, tautan verifikasi/kode tidak bisa
          ditempelkan dan tab yang dipulihkan dari riwayat berakhir di
          "Session ended" (error_code: invalid_state). */}
      <div className="oauth-manual">
        <b><ShieldCheck size={13} /> Kalau OpenAI bilang “Session ended”</b>
        <p>
          Halaman OpenAI berjudul <b>Session ended</b> dengan{' '}
          <code>error_code: invalid_state</code> berarti tab login itu sudah mati —
          biasanya karena tab ditutup lalu dibuka lagi dari riwayat, atau formulirnya
          dibuka dua kali (dua tab = dua sesi, hanya satu yang sah).
        </p>
        <ol className="cga-signup-session-steps">
          <li>Tutup SEMUA tab <code>auth.openai.com</code> dan <code>chatgpt.com</code>.</li>
          <li>Kembali ke panel ini, pastikan email TempMail masih terlihat.</li>
          <li>Tekan <b>Siapkan &amp; buka daftar</b> SEKALI, lalu isi formulir di tab yang baru terbuka.</li>
          <li>Biarkan tab itu terbuka sampai kode verifikasi ditempel — jangan ditutup atau dimuat ulang.</li>
        </ol>
        <small>URL halaman <code>email-verification?auth_page=…</code> tidak bisa dipakai ulang: penanda itu terikat ke sesi tab yang sudah hilang.</small>
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
                  URL setelah menekan <b>Continue</b> di tab OpenAI
                  <small className="cga-signup-hint">
                    Yang diharapkan: halaman berikutnya, biasanya{' '}
                    <code>auth.openai.com/u/…?state=…</code>. Kalau URL masih{' '}
                    <code>auth.openai.com/create-account</code> atau{' '}
                    <code>chatgpt.com/auth/login_with</code>, artinya Continue belum ditekan. Email{' '}
                    <b>tidak</b> muncul di URL lanjutan — itu normal.
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
              {(verificationCode || active.verification_code) && (
                <div className={`cga-signup-code${codeExpired ? ' is-expired' : ''}${codeUnverified ? ' is-unverified' : ''}`}>
                  <b>
                    Kode verifikasi
                    {codeExpired ? ' (kemungkinan kedaluwarsa)' : ''}
                    {codeUnverified ? ' — pengirim belum dikenali' : ''}
                  </b>
                  <div className="cga-signup-code-row">
                    <code className="cga-signup-code-value">{verificationCode || active.verification_code}</code>
                    <button type="button" onClick={() => copyText(verificationCode || active.verification_code, 'code')}>
                      <ClipboardCopy size={12} /> {copied === 'code' ? 'Kode disalin' : 'Salin kode'}
                    </button>
                  </div>
                  <small>
                    Tempelkan di kolom kode pada tab ChatGPT, lalu tekan tombol lanjut di sana.
                    Kode ini sekali pakai dan berumur pendek — jangan disimpan lama.
                  </small>
                  {codeUnverified && (
                    <small className="is-bad">
                      Kode ini diambil dari pesan yang tidak terbaca sebagai email OpenAI.
                      Cocokkan dulu dengan email di inbox; jangan tempel kalau bukan dari OpenAI.
                    </small>
                  )}
                  {codeNote && !codeUnverified && <small className={codeExpired ? 'is-bad' : ''}>{codeNote}</small>}
                </div>
              )}
              {/* Setelah kode berhasil ditempel di ChatGPT, aksesnya disimpan
                  lewat OAuth resmi — bukan dengan menyalin cookie sesi. */}
              {active.step === 'terverifikasi' && (
                <div className="cga-signup-link">
                  <button type="button" className="cga-primary" onClick={linkToPool} disabled={linking}>
                    {linking ? <Loader2 size={12} className="agent-spin" /> : <PlugZap size={12} />} Akun sudah masuk? Simpan aksesnya ke pool
                  </button>
                  <small>
                    Memakai OAuth resmi OpenAI (<b>Continue with ChatGPT</b>), bukan cookie sesi
                    browser. Access token berlaku 1 jam dan diperbarui otomatis lewat refresh
                    token; BLEA tidak pernah menyimpan cookie <code>chatgpt.com</code>.
                  </small>
                </div>
              )}
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
