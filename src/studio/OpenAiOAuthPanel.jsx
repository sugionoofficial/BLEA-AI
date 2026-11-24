import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, Link2, Loader2, LogIn, RefreshCw, ShieldCheck, Unlink } from 'lucide-react';
import {
  beginOpenAiSignIn,
  openAiOAuthApi,
  clearPendingAttempt,
  finishOpenAiSignIn,
  finishOpenAiSignInFromUrl,
  isOAuthCallbackPage,
  oauthAutoCallbackSupported,
  readPendingAttempt,
} from './openaiOAuthClient';
import { explainOAuthError, resolveOAuthRedirectUri } from '../lib/openaiSignup';

const STATUS_META = {
  pending: { label: 'Menunggu persetujuan', tone: 'warn' },
  linked: { label: 'Tersambung (paket dipakai)', tone: 'ok' },
  linked_identity_only: { label: 'Tersambung (izin paket tidak dicentang)', tone: 'warn' },
  denied: { label: 'Ditolak', tone: 'muted' },
  failed: { label: 'Gagal', tone: 'bad' },
  expired: { label: 'Kedaluwarsa — ulangi login', tone: 'warn' },
};

// Izin paket terbukti dari `scope` yang dikirim callback (disimpan server
// sebelum penukaran). Dipakai supaya saran "centang izin" tidak diulang saat
// buktinya sudah ada.
// Nama scope milik OpenAI; tidak bisa diganti sesuka hati, jadi ditulis apa
// adanya di satu tempat.
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';

function planGranted(link) {
  return Array.isArray(link?.scopes) && link.scopes.includes(PLAN_SCOPE);
}

const PLAN_LIMITS = [
  // Batasan ini yang paling menentukan berhasil/tidak, jadi disebut pertama.
  'Butuh paket Plus atau Pro pada akun PRIBADI. Akun Free/Go tidak bisa memakai jalur ini '
    + '(OpenAI menolak dengan subscription_sharing_user_not_eligible), dan workspace '
    + 'Business/Enterprise perlu izin admin. Mengulangi login tidak mengubah keputusan itu.',
  'Hanya untuk chat & agen (Responses API teks). Gambar, video, dan audio tidak tersedia lewat jalur ini.',
  'Kuota memakai paket akun OpenAI pemiliknya, bukan saldo API.',
  'Token disegel di server dan bisa diputus kapan saja dari sini atau pengaturan aplikasi akun OpenAI.',
];

// Tiga keadaan: halaman callback 127.0.0.1, halaman admin (mulai login + daftar
// akun), dan keadaan gagal (dijelaskan apa yang harus dicentang).

export function OpenAiOAuthPanel({ onLinked }) {
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
  const pendingHint = readPendingAttempt();
  const redirectInfo = resolveOAuthRedirectUri({
    hostname: typeof window === 'undefined' ? '' : window.location.hostname,
    port: typeof window === 'undefined' ? '' : window.location.port,
  });
  const [diag, setDiag] = useState(null);
  const [errorCodeInput, setErrorCodeInput] = useState('');
  const [errorUrlInput, setErrorUrlInput] = useState('');

  const load = useCallback(async () => {
    if (callbackPage) return;
    setLoading(true);
    const res = await openAiOAuthApi.status();
    if (res.ok) {
      setLinks(Array.isArray(res.data?.links) ? res.data.links : []);
      setConfig(res.data?.config || null);
      setRetained(res.data?.retained_client || null);
    } else {
      setError(res.data?.error || 'Status tautan OpenAI tidak bisa dimuat.');
    }
    setLoading(false);
  }, [callbackPage]);

  useEffect(() => { load(); }, [load]);

  // Callback: jalankan sekali saat halaman dimuat.
  useEffect(() => {
    if (!callbackPage) return;
    let cancelled = false;
    (async () => {
      const result = await finishOpenAiSignIn();
      if (cancelled) return;
      clearPendingAttempt();
      if (result.ok) {
        setCallbackState('done');
        setNotice(result.hint || 'Akun OpenAI tersambung tanpa API key.');
        onLinked?.();
      } else {
        setCallbackState('failed');
        setError(result.error || 'Login OpenAI gagal.');
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
    const res = await beginOpenAiSignIn({
      issuedClientId: retained?.client_id || '',
      loginHint: retained?.email || '',
    });
    // Kalau berhasil, halaman langsung dialihkan ke OpenAI; tidak ada state lagi.
    if (!res.ok) {
      setBusy('');
      setError(res.error || 'Tidak bisa memulai login OpenAI.');
    }
  }

  async function refreshLink(id) {
    setBusy(`refresh:${id}`);
    const res = await openAiOAuthApi.refresh(id);
    setBusy('');
    if (!res.ok) { setError(res.data?.error || 'Refresh token gagal.'); return; }
    setNotice('Token OAuth diperbarui.');
    load();
  }

  async function disconnectLink(id) {
    setBusy(`disconnect:${id}`);
    const res = await openAiOAuthApi.disconnect(id);
    setBusy('');
    if (!res.ok) { setError(res.data?.error || 'Gagal memutus tautan.'); return; }
    setNotice(res.data?.note || 'Tautan OpenAI dihapus. Pool menyesuaikan otomatis.');
    load();
    onLinked?.();
  }

  // Setelah login berhasil, pool di server berubah. `load()` dipanggil ulang
  // supaya daftar akun di bawah tidak tertinggal menampilkan keadaan lama.
  async function refreshStatus() {
    setBusy('status');
    const res = await openAiOAuthApi.status();
    setBusy('');
    if (res.ok && Array.isArray(res.data?.links)) {
      setLinks(res.data.links);
      setNotice('Status diperbarui dari server.');
    } else {
      setError(res.data?.error || 'Status tidak bisa dimuat ulang.');
    }
  }

  // `invalid_state` terjadi di auth.openai.com SEBELUM callback kita, jadi
  // tidak ada baris server yang bisa diperiksa — hanya penjelasan yang bisa
  // diberikan, plus redirect_uri yang dipakai untuk dicocokkan.

  function diagnose(rawCode, detail = '') {
    const code = String(rawCode || '').trim();
    if (!code) return;
    setDiag(explainOAuthError({
      error: code,
      // Detail dipakai untuk membedakan `invalid_state` milik alur daftar
      // (auth_page) dari milik OAuth BLEA (authorize).
      detail,
      hasPendingAttempt: Boolean(readPendingAttempt()),
    }));
  }

  async function completeFromUrl(event) {
    event.preventDefault();
    setPasteBusy(true);
    setError('');
    setNotice('');
    const res = await finishOpenAiSignInFromUrl(pasteUrl);
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
    setNotice(res.hint || 'Akun OpenAI tersambung tanpa API key.');
    load();
    onLinked?.();
  }

  if (callbackPage) {
    return (
      <section className="oauth-panel oauth-callback">
        <header>
          <span className="oauth-badge"><LogIn size={12} /> Connect OpenAI</span>
          <h2>
            {callbackState === 'working' && 'Menyelesaikan login…'}
            {callbackState === 'done' && 'Akun OpenAI tersambung.'}
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
              Kembali ke <a href="/studio/openai-accounts">Studio → Akun OpenAI</a> untuk melihat kuota akun ini.
            </p>
          </>
        )}
        {needsLogin && (
          <p className="oauth-error">
            <CircleAlert size={14} /> Login BLEA di halaman ini belum aktif. Buka{' '}
            <a href="/studio/openai-accounts">Studio → Akun OpenAI</a> (sudah login), lalu tempel alamat di atas
            pada kolom “Sudah menyetujui di OpenAI?”.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="oauth-panel" id="cga-oauth">
      <header className="oauth-head">
        <div>
          <span className="oauth-badge"><LogIn size={12} /> Langkah 3 · Tanpa API key</span>
          <h2>Connect OpenAI (OAuth)</h2>
          <p>
            Simpan akses akun OpenAI yang sudah dibuat ke pool. Satu tombol, izin di browser,
            lalu tempel alamat callback-nya kembali di sini.
          </p>
        </div>
        <div className="oauth-head-actions">
          <button type="button" className="oauth-start" onClick={start} disabled={busy === 'start'}>
            {busy === 'start' ? <Loader2 size={14} className="agent-spin" /> : <Link2 size={14} />}
            {busy === 'start' ? 'Membuka OpenAI…' : 'Simpan aksesnya ke pool'}
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

      <details className="cga-signup-problems">
        <summary>Batasan &amp; catatan (klik untuk membuka)</summary>
        <ul className="oauth-limits">
          {PLAN_LIMITS.map((line) => (
            <li key={line}><ShieldCheck size={13} /> {line}</li>
          ))}
        </ul>
      </details>

      {/* Kolom tempel URL callback — harus ada di halaman admin, bukan di
          cabang halaman callback. */}
      <div className="oauth-manual">
        <b><Link2 size={13} /> Sudah menyetujui di OpenAI?</b>
        <p>
          Tempel <b>seluruh</b> alamat halaman <code>127.0.0.1:&lt;port&gt;/auth/callback?code=…&amp;state=…</code>{' '}
          di sini. Halaman itu memang tampil “tidak bisa diakses” — itu normal.
        </p>
        <form onSubmit={completeFromUrl}>
          <input
            type="text"
            inputMode="url"
            spellCheck={false}
            value={pasteUrl}
            onChange={(event) => setPasteUrl(event.target.value)}
            placeholder="http://127.0.0.1:1455/auth/callback?code=…&state=…"
            aria-label="URL callback OpenAI"
          />
          <button type="submit" disabled={pasteBusy || !pasteUrl.trim()}>
            {pasteBusy ? <Loader2 size={13} className="agent-spin" /> : <CircleCheck size={13} />} Selesaikan
          </button>
        </form>
        {hasPending && (
          <small>
            Sesi login terbuka di tab ini — tempel URL-nya sebelum 30 menit.
            {pendingHint?.redirect_uri ? ` Yang dicari: alamat yang dimulai dengan ${pendingHint.redirect_uri}` : ''}
          </small>
        )}
      </div>

      {/* Diagnosa kode error dari halaman OpenAI. */}
      <div className="oauth-manual">
        <b><ShieldCheck size={13} /> Ada kode error di halaman OpenAI?</b>
        <p>
          Salin kodenya (<code>invalid_state</code>, <code>invalid_grant</code>, …) untuk penjelasan
          singkat. Alamat callback yang dipakai: <code>{redirectInfo.redirect_uri}</code>
        </p>
        <form onSubmit={(event) => { event.preventDefault(); diagnose(diag?.code || errorCodeInput, errorUrlInput); }}>
          <input
            type="text"
            spellCheck={false}
            value={errorCodeInput}
            onChange={(event) => { setErrorCodeInput(event.target.value); setDiag(null); }}
            placeholder="invalid_state, invalid_grant, access_denied…"
            aria-label="Kode error OAuth dari OpenAI"
          />
          <input
            type="text"
            spellCheck={false}
            value={errorUrlInput}
            onChange={(event) => { setErrorUrlInput(event.target.value); setDiag(null); }}
            placeholder="Opsional: tempel URL halaman error-nya (agar tahapnya tepat)"
            aria-label="URL halaman error OpenAI"
          />
          <button type="submit" disabled={!errorCodeInput.trim()}>
            <CircleAlert size={13} /> Jelaskan
          </button>
          <button type="button" onClick={() => { setErrorCodeInput('invalid_state'); setErrorUrlInput(''); diagnose('invalid_state'); }}>
            <ShieldCheck size={13} /> invalid_state
          </button>
        </form>
        {diag && (
          <div className="oauth-diag" role="status">
            <b>{diag.code}</b>
            {diag.stage && <small>Langkah: {diag.stage}</small>}
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
          Belum ada akun OpenAI yang ditautkan. Menekan tombol di atas akan membuka halaman izin OpenAI;
          setelah disetujui, akun ini otomatis masuk pool untuk chat & agen.
        </p>
      ) : (
        <ul className="oauth-links">
          {links.map((link) => {
            const meta = STATUS_META[link.status] || { label: link.status, tone: 'muted' };
            return (
              <li key={link.id} className={`oauth-link is-${meta.tone}`}>
                <div className="oauth-link-main">
                  <b>{link.email || 'Akun OpenAI'}</b>
                  <span className={`oauth-state is-${meta.tone}`}>{meta.label}</span>
                  {link.plan_usage && <span className="oauth-state is-ok">paket aktif</span>}
                </div>
                <small>
                  {link.client_id ? `client ${link.client_id.slice(0, 14)}…` : 'client belum terbit'}
                  {link.access_expires_at ? ` · akses s/d ${new Date(link.access_expires_at).toLocaleString('id-ID')}` : ''}
                </small>
                {link.error && (
                  // Jejak teknis dipisah dari pesan yang harus dibaca: yang
                  // penting "apa yang harus dilakukan", bukan potongan JSON.
                  <details className="oauth-link-trace">
                    <summary>
                      {link.status === 'failed'
                        ? 'Pertukaran kode ditolak — apa yang harus dilakukan'
                        : 'Jejak teknis'}
                    </summary>
                    {link.status === 'failed' && (
                      <p>
                        OpenAI menolak penukaran kode. {planGranted(link)
                          ? 'Izin pemakaian paket akun sudah tercatat di callback, jadi bukan itu sebabnya. '
                          : 'Izin paket tidak terlihat di callback — centang saat menyetujui. '}
                        Sisa kemungkinan: paket akun harus Plus/Pro pada akun pribadi (bukan Free/Go
                        atau workspace kerja), atau kode sudah kedaluwarsa. Ulangi dengan
                        <b> Simpan aksesnya ke pool</b>; client terbitan tetap dipakai.
                      </p>
                    )}
                    <small className="oauth-link-error">{link.error}</small>
                  </details>
                )}
                {link.status === 'expired' && (
                  <form className="oauth-inline-form" onSubmit={completeFromUrl}>
                    <input
                      type="url"
                      value={pasteUrl}
                      onChange={(event) => setPasteUrl(event.target.value)}
                      placeholder="Tempel URL callback (…?code=…&state=…)"
                      aria-label="URL callback OpenAI"
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

export default OpenAiOAuthPanel;
