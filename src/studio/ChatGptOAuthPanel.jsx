import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Link2, Loader2, LogIn, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import {
  beginChatGptSignIn,
  chatGptOAuthApi,
  clearPendingAttempt,
  finishChatGptSignIn,
  finishChatGptSignInFromUrl,
  isOAuthCallbackPage,
  oauthAutoCallbackSupported,
  readPendingAttempt,
} from './chatgptOAuthClient';
import { explainOAuthError, resolveOAuthRedirectUri } from '../lib/chatgptSignup';

const STATUS_META = {
  pending: { label: 'Menunggu persetujuan', tone: 'warn' },
  linked: { label: 'Tersambung (paket dipakai)', tone: 'ok' },
  linked_identity_only: { label: 'Tersambung (izin paket tidak dicentang)', tone: 'warn' },
  denied: { label: 'Ditolak', tone: 'muted' },
  failed: { label: 'Gagal', tone: 'bad' },
  expired: { label: 'Kedaluwarsa — ulangi login', tone: 'warn' },
};

const PLAN_LIMITS = [
  'Hanya untuk chat & agen (Responses API teks). Gambar, video, audio, dan unggah berkas tidak tersedia lewat jalur ini.',
  'Kuota diambil dari paket ChatGPT pemilik akun (Plus/Pro/Go), bukan saldo API. Batas 5 jam dibagi dengan pemakaian ChatGPT lain.',
  'Tidak ada API key dan tidak ada client secret: BLEA mendaftarkan client-nya sendiri saat login pertama.',
  'Token disimpan tersegel di server dan bisa diputus kapan saja dari sini atau dari ChatGPT → Settings → Apps.',
];

/**
 * Panel "Continue with ChatGPT".
 *
 * Tiga keadaan yang ditangani:
 *   1. Halaman callback (http://127.0.0.1:<port>/auth/callback) — OAuth hanya
 *      sah dengan redirect loopback, jadi penyelesaiannya terjadi di browser
 *      pengguna. Halaman ini mengirim kode ke Worker lalu menampilkan hasil.
 *   2. Halaman admin biasa — tombol untuk memulai login dan daftar tautan.
 *   3. Gagal/izin tidak lengkap — dijelaskan apa yang harus dicentang.
 */
export function ChatGptOAuthPanel({ onLinked }) {
  const callbackPage = isOAuthCallbackPage();
  const [callbackUrl, setCallbackUrl] = useState(() => (typeof window === 'undefined' ? '' : window.location.href));
  const [needsLogin, setNeedsLogin] = useState(false);
  const [retained, setRetained] = useState(null);
  const [links, setLinks] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(!callbackPage);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [callbackState, setCallbackState] = useState(callbackPage ? 'working' : 'idle');
  const autoCallback = oauthAutoCallbackSupported();
  const [pasteUrl, setPasteUrl] = useState('');
  const [pasteBusy, setPasteBusy] = useState(false);
  const [hasPending, setHasPending] = useState(() => Boolean(readPendingAttempt()));
  // Nilai redirect_uri yang BENAR-BENAR dipakai, ditampilkan supaya bisa
  // dicocokkan dengan URL di bilah alamat saat OAuth gagal (invalid_state).
  const redirectInfo = resolveOAuthRedirectUri({
    hostname: typeof window === 'undefined' ? '' : window.location.hostname,
    port: typeof window === 'undefined' ? '' : window.location.port,
  });
  const [diag, setDiag] = useState(null);
  const [errorCodeInput, setErrorCodeInput] = useState('');

  const load = useCallback(async () => {
    if (callbackPage) return;
    setLoading(true);
    const res = await chatGptOAuthApi.status();
    if (res.ok) {
      setLinks(Array.isArray(res.data?.links) ? res.data.links : []);
      setConfig(res.data?.config || null);
      setRetained(res.data?.retained_client || null);
    } else {
      setError(res.data?.error || 'Status tautan ChatGPT tidak bisa dimuat.');
    }
    setLoading(false);
  }, [callbackPage]);

  useEffect(() => { load(); }, [load]);

  // Callback: jalankan sekali saat halaman dimuat.
  useEffect(() => {
    if (!callbackPage) return;
    let cancelled = false;
    (async () => {
      const result = await finishChatGptSignIn();
      if (cancelled) return;
      clearPendingAttempt();
      if (result.ok) {
        setCallbackState('done');
        setNotice(result.hint || 'Akun ChatGPT tersambung tanpa API key.');
        onLinked?.();
      } else {
        setCallbackState('failed');
        setError(result.error || 'Login ChatGPT gagal.');
      }
    })();
    return () => { cancelled = true; };
  }, [callbackPage, onLinked]);

  async function start() {
    setBusy('start');
    setError('');
    setNotice('');
    // Login ulang memakai client_id terbitan yang dipertahankan (bukan
    // mendaftar ulang), sesuai panduan OpenAI untuk pemulihan invalid_grant.
    const res = await beginChatGptSignIn({
      issuedClientId: retained?.client_id || '',
      loginHint: retained?.email || '',
    });
    // Kalau berhasil, halaman langsung dialihkan ke OpenAI; tidak ada state lagi.
    if (!res.ok) {
      setBusy('');
      setError(res.error || 'Tidak bisa memulai login ChatGPT.');
    }
  }

  async function refreshLink(id) {
    setBusy(`refresh:${id}`);
    const res = await chatGptOAuthApi.refresh(id);
    setBusy('');
    if (!res.ok) { setError(res.data?.error || 'Refresh token gagal.'); return; }
    setNotice('Token OAuth diperbarui.');
    load();
  }

  async function disconnectLink(id) {
    setBusy(`disconnect:${id}`);
    const res = await chatGptOAuthApi.disconnect(id);
    setBusy('');
    if (!res.ok) { setError(res.data?.error || 'Gagal memutus tautan.'); return; }
    setNotice(res.data?.note || 'Tautan ChatGPT dihapus. Pool menyesuaikan otomatis.');
    load();
    onLinked?.();
  }

  // Setelah login berhasil, pool di server berubah. `load()` dipanggil ulang
  // supaya daftar akun di bawah tidak tertinggal menampilkan keadaan lama.
  async function refreshStatus() {
    setBusy('status');
    const res = await chatGptOAuthApi.status();
    setBusy('');
    if (res.ok && Array.isArray(res.data?.links)) {
      setLinks(res.data.links);
      setNotice('Status diperbarui dari server.');
    } else {
      setError(res.data?.error || 'Status tidak bisa dimuat ulang.');
    }
  }

  /**
   * Diagnosa kegagalan OAuth dari kode error OpenAI.
   *
   * `invalid_state` terjadi di auth.openai.com SEBELUM callback kita, jadi
   * tidak ada yang bisa diperiksa di server. Yang bisa dilakukan: jelaskan
   * sebabnya dan tampilkan `redirect_uri` yang dipakai, supaya bisa dicocokkan
   * dengan URL di bilah alamat.
   */
  function diagnose(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code) return;
    setDiag(explainOAuthError({
      error: code,
      detail: '',
      hasPendingAttempt: Boolean(readPendingAttempt()),
    }));
  }

  async function completeFromUrl(event) {
    event.preventDefault();
    setPasteBusy(true);
    setError('');
    setNotice('');
    const res = await finishChatGptSignInFromUrl(pasteUrl);
    setPasteBusy(false);
    if (!res.ok) {
      setError(res.error || 'URL callback tidak bisa diselesaikan.');
      // Tanpa sesi login di origin ini, Worker menolak dengan 401. Itu bukan
      // "belum menyetujui", jadi tawarkan jalan keluarnya alih-alih diam.
      if (/login diperlukan/i.test(String(res.error || ''))) setNeedsLogin(true);
      return;
    }
    setPasteUrl('');
    setHasPending(false);
    setNotice(res.hint || 'Akun ChatGPT tersambung tanpa API key.');
    load();
    onLinked?.();
  }

  if (callbackPage) {
    return (
      <section className="oauth-panel oauth-callback">
        <header>
          <span className="oauth-badge"><LogIn size={12} /> Continue with ChatGPT</span>
          <h2>
            {callbackState === 'working' && 'Menyelesaikan login…'}
            {callbackState === 'done' && 'Akun ChatGPT tersambung.'}
            {callbackState === 'failed' && 'Login belum berhasil.'}
          </h2>
        </header>
        {callbackState === 'working' && (
          <p className="oauth-note"><Loader2 size={14} className="agent-spin" /> Menukar kode otorisasi dengan token, lalu menyegelnya di server.</p>
        )}
        {notice && <p className="oauth-ok"><CircleCheck size={14} /> {notice}</p>}
      {error && <p className="oauth-error"><CircleAlert size={14} /> {error}</p>}
        {callbackState !== 'working' && (
          <>
            <div className="oauth-copybox">
              <small>Alamat halaman ini (untuk diselesaikan di BLEA):</small>
              <code>{callbackUrl}</code>
              <button type="button" onClick={() => navigator.clipboard?.writeText(callbackUrl)}>Salin alamat</button>
            </div>
            <p className="oauth-note">
              Kembali ke <a href="/studio/chatgpt-accounts">Studio → Akun ChatGPT</a> untuk melihat kuota akun ini.
            </p>
          </>
        )}
        {needsLogin && (
          <p className="oauth-error">
            <CircleAlert size={14} /> Login BLEA di halaman ini belum aktif. Buka{' '}
            <a href="/studio/chatgpt-accounts">Studio → Akun ChatGPT</a> (sudah login), lalu tempel alamat di atas
            pada kolom “Sudah menyetujui di ChatGPT?”.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="oauth-panel">
      <header className="oauth-head">
        <div>
          <span className="oauth-badge"><LogIn size={12} /> Tanpa API key</span>
          <h2>Continue with ChatGPT</h2>
          <p>
            Sambungkan akun ChatGPT seperti OAuth freebeat: satu tombol, izin di browser,
            lalu Studio memakai paket ChatGPT itu. Tidak ada API key yang perlu ditempel.
          </p>
        </div>
        <div className="oauth-head-actions">
          <button type="button" className="oauth-start" onClick={start} disabled={busy === 'start'}>
            {busy === 'start' ? <Loader2 size={14} className="agent-spin" /> : <Link2 size={14} />}
            {busy === 'start' ? 'Membuka ChatGPT…' : 'Continue with ChatGPT'}
          </button>
          <button type="button" className="oauth-refresh" onClick={refreshStatus} disabled={busy === 'status'}>
            {busy === 'status' ? <Loader2 size={13} className="agent-spin" /> : <RefreshCw size={13} />} Perbarui status
          </button>
        </div>
      </header>

      {retained?.client_id && (
        <p className="oauth-note">
          Mendaftar ulang tidak diperlukan: client <code>{retained.client_id}</code> sudah terbit untuk akun ini dan akan dipakai lagi.
        </p>
      )}

      <ul className="oauth-limits">
        {PLAN_LIMITS.map((line) => (
          <li key={line}><ShieldCheck size={13} /> {line}</li>
        ))}
      </ul>

      {/* Kolom tempel URL callback. Dulu blok ini tidak sengaja tersisip di
          cabang `if (callbackPage)` — jadi ia hanya muncul di halaman
          127.0.0.1, dan justru TIDAK ADA di halaman Akun ChatGPT tempat
          pengguna mencarinya. Sekarang tempatnya benar: panel utama. */}
      <div className="oauth-manual">
        <b><Link2 size={13} /> Sudah menyetujui di ChatGPT?</b>
        <p>
          OpenAI mengirim hasil login ke <code>http://127.0.0.1:&lt;port&gt;/auth/callback</code>, dan
          alamat itu biasanya berakhir sebagai halaman “tidak bisa diakses”. Salin <b>seluruh</b> alamat
          dari bilah browser (yang memuat <code>?code=…&amp;state=…</code>) lalu tempel di sini — kalau
          tersalin sebagai <code>&amp;amp;</code>, tetap terbaca. Kode ditukar di server, tidak disimpan
          di browser.
        </p>
        <form onSubmit={completeFromUrl}>
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            value={pasteUrl}
            onChange={(event) => setPasteUrl(event.target.value)}
            placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
            aria-label="URL callback ChatGPT"
          />
          <button type="submit" disabled={pasteBusy || !pasteUrl.trim()}>
            {pasteBusy ? <Loader2 size={13} className="agent-spin" /> : <CircleCheck size={13} />} Selesaikan
          </button>
        </form>
        {hasPending && <small>Sesi login terbuka di tab ini — tempel URL-nya sebelum 30 menit.</small>}
      </div>

      {/* Diagnosa kegagalan OAuth. OpenAI mengembalikan halaman error dengan
          kode seperti invalid_state SEBELUM callback kita, jadi tidak ada
          baris server yang bisa diperiksa — penjelasan ini yang menggantikannya. */}
      <div className="oauth-manual">
        <b><ShieldCheck size={13} /> Gagal dengan kode error?</b>
        <p>
          Kalau halaman OpenAI menampilkan <code>error_code</code>, salin kodenya di sini untuk
          penjelasan sebab + langkah perbaikannya. Nilai <code>redirect_uri</code> yang dikirim:{' '}
          <code>{redirectInfo.redirect_uri}</code>
          {redirectInfo.auto_callback
            ? ' (callback otomatis: BLEA dibuka dari 127.0.0.1).'
            : ' (bukan 127.0.0.1, jadi callback diselesaikan dengan menempel URL).'}
        </p>
        <form onSubmit={(event) => { event.preventDefault(); diagnose(diag?.code || errorCodeInput); }}>
          <input
            type="text"
            spellCheck={false}
            value={errorCodeInput}
            onChange={(event) => { setErrorCodeInput(event.target.value); setDiag(null); }}
            placeholder="invalid_state, invalid_grant, access_denied…"
            aria-label="Kode error OAuth dari OpenAI"
          />
          <button type="submit" disabled={!errorCodeInput.trim()}>
            <CircleAlert size={13} /> Jelaskan
          </button>
          <button type="button" onClick={() => { setErrorCodeInput('invalid_state'); diagnose('invalid_state'); }}>
            <ShieldCheck size={13} /> invalid_state
          </button>
        </form>
        {diag && (
          <div className="oauth-diag" role="status">
            <b>{diag.code}</b>
            <small>Sebab: {diag.cause}</small>
            <small>Perbaikan: {diag.fix}</small>
          </div>
        )}
      </div>

      {error && <p className="oauth-error"><CircleAlert size={14} /> {error}</p>}
      {notice && (
        <div className="oauth-success" role="status">
          <CircleCheck size={16} />
          <div>
            <b>Tersambung.</b> {notice}
            <small>Akun ini sekarang ikut pool untuk chat &amp; agen. Muat ulang halaman ini bila daftar akun di bawah belum berubah.</small>
          </div>
        </div>
      )}

      {loading ? (
        <p className="oauth-note"><Loader2 size={14} className="agent-spin" /> Memuat tautan…</p>
      ) : links.length === 0 ? (
        <p className="oauth-note">
          Belum ada akun ChatGPT yang ditautkan. Menekan tombol di atas akan membuka halaman izin OpenAI;
          setelah disetujui, akun ini otomatis masuk pool untuk chat & agen.
        </p>
      ) : (
        <ul className="oauth-links">
          {links.map((link) => {
            const meta = STATUS_META[link.status] || { label: link.status, tone: 'muted' };
            return (
              <li key={link.id} className={`oauth-link is-${meta.tone}`}>
                <div className="oauth-link-main">
                  <b>{link.email || 'Akun ChatGPT'}</b>
                  <span className={`oauth-state is-${meta.tone}`}>{meta.label}</span>
                  {link.plan_usage && <span className="oauth-state is-ok">paket aktif</span>}
                </div>
                <small>
                  {link.client_id ? `client ${link.client_id.slice(0, 14)}…` : 'client belum terbit'}
                  {link.access_expires_at ? ` · akses s/d ${new Date(link.access_expires_at).toLocaleString('id-ID')}` : ''}
                </small>
                {link.error && <small className="oauth-link-error">{link.error}</small>}
                {link.status === 'expired' && (
                  <form className="oauth-inline-form" onSubmit={completeFromUrl}>
                    <input
                      type="url"
                      value={pasteUrl}
                      onChange={(event) => setPasteUrl(event.target.value)}
                      placeholder="Tempel URL callback (…?code=…&state=…)"
                      aria-label="URL callback ChatGPT"
                    />
                    <button type="submit" disabled={pasteBusy || !pasteUrl.trim()}>
                      {pasteBusy ? <Loader2 size={12} className="agent-spin" /> : <CircleCheck size={12} />} Selesaikan
                    </button>
                  </form>
                )}
                <div className="oauth-link-actions">
                  <button type="button" onClick={() => refreshLink(link.id)} disabled={busy === `refresh:${link.id}` || !link.plan_usage}>
                    {busy === `refresh:${link.id}` ? <Loader2 size={12} className="agent-spin" /> : <RefreshCw size={12} />} Refresh token
                  </button>
                  <button type="button" className="is-danger" onClick={() => disconnectLink(link.id)} disabled={busy === `disconnect:${link.id}`}>
                    {busy === `disconnect:${link.id}` ? <Loader2 size={12} className="agent-spin" /> : <Unlink size={12} />} Putuskan
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {config?.note && <p className="oauth-foot">{config.note}</p>}
    </section>
  );
}

export default ChatGptOAuthPanel;
