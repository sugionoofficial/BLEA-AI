import { useCallback, useEffect, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  ClipboardCopy,
  ExternalLink,
  Loader2,
  MailSearch,
  RefreshCw,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';
import {
  chatGptSignupApi,
  newLoggingId,
  SIGNUP_STEP_META,
} from './chatgptSignupClient';

const STEP_ORDER = ['dibuka', 'email_dikirim', 'menunggu_verifikasi', 'terverifikasi'];

// Ditampilkan sebelum server menjawab, supaya batasan ini terlihat sejak awal
// (bukan hanya setelah /api/chatgpt-signup selesai dimuat).
const DEFAULT_LIMITS = [
  'BLEA tidak mem-POST pendaftaran ke chatgpt.com: Worker diblokir ke domain itu dan endpointnya butuh cookie sesi + Turnstile.',
  'Akun dibuat hanya bila formulir dikirim dari browser Anda dan email verifikasi diklik sendiri.',
  'Alamat +tag Gmail bisa ditolak formulir OpenAI; gunakan alias TempMail tanpa tanda + bila itu terjadi.',
];

function toneOf(step) {
  return (SIGNUP_STEP_META[step] || { tone: 'muted' }).tone;
}

/**
 * Panel "Daftar ChatGPT pakai email TempMail".
 *
 * Alurnya sengaja jujur: tombol pertama hanya MENYIAPKAN URL daftar resmi
 * (login_hint = email TempMail) lalu membukanya di tab baru. Pendaftaran
 * sendiri tidak diotomasi — server BLEA tidak mem-POST ke chatgpt.com dan
 * tidak bisa melewati Turnstile. Setelah formulir dikirim, panel memantau
 * inbox TempMail untuk email verifikasi.
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
    setActiveId(res.data?.attempt?.id || '');
    setNotice(res.data?.plus_address
      ? 'URL disiapkan, tetapi alamat ini memakai +tag. Sebagian formulir OpenAI menolak tanda +; siapkan alamat TempMail tanpa + bila pendaftaran ditolak.'
      : 'URL pendaftaran resmi disiapkan dengan email TempMail sebagai login_hint. Buka, isi formulir, lalu kembali ke sini.');
    if (url && pendingTab) {
      pendingTab.location.replace(url);
    } else if (url) {
      // Tab kosong tidak bisa dibuka (popup blocker keras): tetap beri jalan
      // lewat tautan di blok "URL yang dibuka", bukan gagal diam-diam.
      setError('Browser memblokir tab baru. Buka URL di blok "URL yang dibuka" di bawah secara manual.');
    }
    await load();
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

  async function copyUrl() {
    if (!lastUrl) return;
    try {
      await navigator.clipboard.writeText(lastUrl);
      setNotice('URL pendaftaran disalin.');
    } catch {
      setError('Clipboard tidak tersedia di browser ini.');
    }
  }

  return (
    <section className="oauth-panel cga-signup" id="cga-signup">
      <header className="oauth-head">
        <div>
          <span className="oauth-badge"><UserPlus size={12} /> Email TempMail</span>
          <h2>Daftar ChatGPT dengan email TempMail</h2>
          <p>
            Satu tombol menyiapkan halaman daftar resmi ChatGPT dengan email TempMail
            sebagai <code>login_hint</code>, lalu memantau inbox untuk email verifikasi.
            Pendaftaran sendiri tetap dikirim dari browser Anda — bukan dari server BLEA.
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
          <small>
            {tempEmail
              ? <>Alamat aktif di TempMail: <code>{tempEmail}</code>. Mengubah kolom ini tidak mengubah alias TempMail.</>
              : 'Belum ada alias TempMail aktif. Buat dulu di halaman TempMail supaya email verifikasi bisa dibaca.'}
          </small>
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
            <button type="button" onClick={copyUrl}>Salin URL</button>
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
              <div className="cga-item-actions">
                <button type="button" onClick={() => mark('email_dikirim')} disabled={busy === 'mark:email_dikirim'}>
                  {busy === 'mark:email_dikirim' ? <Loader2 size={12} className="agent-spin" /> : <CircleCheck size={12} />} Formulir sudah dikirim
                </button>
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
