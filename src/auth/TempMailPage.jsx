import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Inbox, Mail, RefreshCw, RotateCcw, ShieldCheck, Unplug } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { extractVerificationCode } from '../lib/chatgptSignup';
import './tempmail.css';

const POLL_MS = 15_000;

async function getAccessToken() {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) throw new Error('Sesi login tidak tersedia. Silakan login kembali.');
  return data.session.access_token;
}

async function tempmailRequest(action, { method = 'GET', params = {} } = {}) {
  const token = await getAccessToken();
  const query = new URLSearchParams({ action, ...params });
  const response = await fetch(`/api/tempmail?${query}`, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error([data?.error, data?.hint].filter(Boolean).join(' ')
    || `Permintaan TempMail gagal (HTTP ${response.status}).`);
  return data;
}

function emailFrameDocument(html) {
  const safeHtml = String(html || '');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px/1.55 system-ui,sans-serif;color:#172033;padding:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:#4f46e5}</style></head><body>${safeHtml}</body></html>`;
}

function displayDate(value) {
  if (!value) return '';
  const numeric = /^\d{10,}$/.test(String(value)) ? Number(value) * 1000 : value;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' });
}

export function TempMailPage() {
  const [email, setEmail] = useState('');
  const [messages, setMessages] = useState([]);
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Memeriksa koneksi dan alamat TempMail...');
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [gmailConfigured, setGmailConfigured] = useState(false);
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailAccountEmail, setGmailAccountEmail] = useState('');
  const [gmailTag, setGmailTag] = useState('');
  // Diambil dari isi pesan yang sedang dibuka. Email verifikasi berisi KODE,
  // dan menyalinnya manual dari iframe email sering meleset (angka terpotong
  // atau ikut terambil teks lain).
  const [codeCopied, setCodeCopied] = useState(false);

  const loadMessages = useCallback(async (targetEmail, quiet = false) => {
    if (!targetEmail) return;
    if (!quiet) setBusy(true);
    try {
      const data = await tempmailRequest('messages', { params: { email: targetEmail } });
      setMessages(Array.isArray(data.messages) ? data.messages : []);
      setLastUpdated(new Date());
      setError('');
      setStatus('Inbox diperbarui.');
    } catch (requestError) {
      setError(requestError.message || 'Gagal memuat inbox.');
      if (!quiet) setStatus('Inbox belum dapat dimuat.');
    } finally {
      if (!quiet) setBusy(false);
    }
  }, []);

  const loadAlias = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const gmail = await tempmailRequest('gmail-status');
      setGmailConfigured(Boolean(gmail.configured));
      setGmailConnected(Boolean(gmail.connected));
      setGmailAccountEmail(gmail.connected ? String(gmail.email || '') : '');
      const data = await tempmailRequest('alias');
      const aliasProvider = String(data?.alias?.provider || '');
      const isGmailAlias = aliasProvider === 'gmailapi';
      const aliasMatchesMode = gmail.configured ? Boolean(gmail.connected && isGmailAlias) : !isGmailAlias;
      const savedEmail = data?.alias?.email && aliasMatchesMode ? data.alias.email : '';
      setEmail(savedEmail);
      if (savedEmail) {
        setStatus('Alamat TempMail siap.');
        await loadMessages(savedEmail, true);
      } else if (gmail.configured && !gmail.connected) {
        setStatus('Hubungkan akun Gmail untuk mulai membuat alamat +tag.');
      } else {
        setStatus('Belum ada alamat. Buat alamat untuk mulai menerima email.');
      }
    } catch (requestError) {
      setError(requestError.message || 'Gagal menyiapkan TempMail.');
      setStatus('TempMail belum siap.');
    } finally {
      setLoading(false);
    }
  }, [loadMessages]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gmailResult = params.get('gmail');
    const gmailReason = params.get('reason') || 'OAuth dibatalkan atau gagal.';
    if (gmailResult) {
      params.delete('gmail');
      params.delete('reason');
      const query = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
    }
    loadAlias().then(() => {
      if (gmailResult === 'connected') setStatus('Gmail berhasil dihubungkan. Sekarang isi akhiran lalu tekan Generate ujung.');
      if (gmailResult === 'error') setError(`Gagal menghubungkan Gmail: ${gmailReason}`);
    });
  }, [loadAlias]);

  useEffect(() => {
    if (!email) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadMessages(email, true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [email, loadMessages]);

  const createAddress = async (rotate = false) => {
    if (rotate && !window.confirm('Buat alamat baru? Inbox alamat lama tidak akan lagi muncul di halaman ini.')) return;
    setBusy(true);
    setError('');
    setStatus(rotate ? 'Membuat alamat baru...' : 'Menyiapkan alamat TempMail...');
    try {
      const data = await tempmailRequest(rotate ? 'rotate' : 'create', { method: 'POST' });
      setEmail(data.email);
      setMessages([]);
      setSelectedMessage(null);
      setStatus(data.reused ? 'Menggunakan kembali alamat tersimpan.' : 'Alamat TempMail baru siap.');
      await loadMessages(data.email, true);
    } catch (requestError) {
      setError(requestError.message || 'Gagal membuat alamat TempMail.');
      setStatus('Pembuatan alamat gagal.');
    } finally {
      setBusy(false);
    }
  };

  const connectGmail = async () => {
    setBusy(true);
    setError('');
    try {
      const data = await tempmailRequest('gmail-connect');
      const authUrl = new URL(String(data.authUrl || ''));
      if (authUrl.protocol !== 'https:' || authUrl.hostname !== 'accounts.google.com') throw new Error('URL OAuth Google tidak valid.');
      window.location.assign(authUrl.toString());
    } catch (requestError) {
      setError(requestError.message || 'Gagal membuka Google OAuth.');
    } finally {
      setBusy(false);
    }
  };

  const disconnectGmail = async () => {
    if (!window.confirm('Putuskan akun Gmail dan hapus alias TempMail aktif?')) return;
    setBusy(true);
    setError('');
    try {
      await tempmailRequest('gmail-disconnect', { method: 'POST' });
      setGmailConnected(false);
      setGmailAccountEmail('');
      setEmail('');
      setMessages([]);
      setSelectedMessage(null);
      setStatus('Koneksi Gmail diputus.');
    } catch (requestError) {
      setError(requestError.message || 'Gagal memutuskan Gmail.');
    } finally {
      setBusy(false);
    }
  };

  const generateGmailAlias = async () => {
    setBusy(true);
    setError('');
    try {
      const tag = gmailTag.trim();
      const data = await tempmailRequest('rotate', { method: 'POST', params: tag ? { tag } : {} });
      setEmail(data.email);
      setMessages([]);
      setSelectedMessage(null);
      setStatus(`Akhiran baru dibuat: ${data.email}`);
      await loadMessages(data.email, true);
    } catch (requestError) {
      setError(requestError.message || 'Gagal membuat akhiran Gmail.');
    } finally {
      setBusy(false);
    }
  };

  const openMessage = async (message) => {
    setBusy(true);
    setError('');
    try {
      const data = await tempmailRequest('message', { params: { email, messageId: message.id } });
      setSelectedMessage(data.message || null);
      setCodeCopied(false);
    } catch (requestError) {
      setError(requestError.message || 'Gagal membuka pesan.');
    } finally {
      setBusy(false);
    }
  };

  const copyEmail = async () => {
    try {
      await navigator.clipboard.writeText(email);
      setStatus('Alamat email disalin.');
    } catch {
      setError('Clipboard tidak tersedia di browser ini.');
    }
  };

  const copyVerificationCode = async () => {
    const value = verificationCode.code;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCodeCopied(true);
    } catch {
      setError('Clipboard tidak tersedia di browser ini.');
    }
  };

  const gmailPreview = useMemo(() => {
    const [local = '', domain = 'gmail.com'] = gmailAccountEmail.split('@');
    return `${local}+${gmailTag.trim() || 'angka'}@${domain}`;
  }, [gmailAccountEmail, gmailTag]);
  const htmlDocument = useMemo(() => emailFrameDocument(selectedMessage?.bodyHtml), [selectedMessage?.bodyHtml]);
  const verificationCode = useMemo(() => {
    if (!selectedMessage) return { code: '', candidates: [] };
    return extractVerificationCode({
      subject: selectedMessage.subject,
      bodyText: selectedMessage.bodyText,
      bodyHtml: selectedMessage.bodyHtml,
    });
  }, [selectedMessage]);
  const gmailActive = gmailConfigured && gmailConnected;

  return (
    <DropXLayout title="TempMail" description="Kotak masuk email sementara khusus admin." footer={false}>
      <main className="tempmail-page">
        <header className="tempmail-heading">
          <div className="tempmail-heading-icon"><Mail size={20} /></div>
          <div>
            <span className="tempmail-eyebrow"><ShieldCheck size={13} /> ADMIN ONLY</span>
            <h1>TempMail</h1>
            <p>Hubungkan Gmail, buat alamat +tag, dan pantau inbox dari satu tempat.</p>
          </div>
        </header>

        <section className="tempmail-card tempmail-gmail-card" aria-label="Hubungkan akun Gmail">
          <div className="tempmail-card-title"><div><span className="tempmail-kicker">GOOGLE OAUTH · GMAIL READ ONLY</span><h2>Hubungkan Gmail Anda</h2></div><span className={`tempmail-provider-pill ${gmailActive ? 'is-connected' : ''}`}>{gmailActive ? 'Terhubung' : gmailConfigured ? 'Belum terhubung' : 'Perlu konfigurasi'}</span></div>
          {!gmailConfigured ? <>
            <p className="tempmail-gmail-copy">Hubungkan Gmail Anda menggunakan Google OAuth untuk membuat alamat seperti <code>nama+tag@gmail.com</code> dan membaca email yang dikirim ke alias tersebut.</p>
            <div className="tempmail-gmail-setup" role="note"><b>OAuth Gmail belum diaktifkan.</b> Admin perlu menyiapkan Gmail API, OAuth Web Client, callback <code>/api/tempmail-gmail-callback</code>, dan secret Worker: <code>GMAIL_CLIENT_ID</code>, <code>GMAIL_CLIENT_SECRET</code>, serta <code>PROVIDER_CREDENTIAL_ENCRYPTION_KEY</code>.</div>
            <p className="tempmail-security-note">Kredensial OAuth disimpan terenkripsi di server. Aplikasi hanya meminta izin baca email; tidak dapat mengirim atau menghapus email.</p>
          </> : <>
            <p className="tempmail-gmail-copy">{gmailActive ? <>Akun terhubung: <b>{gmailAccountEmail}</b>. Generate akhiran untuk menerima email di inbox Gmail ini.</> : 'Google OAuth siap. Hubungkan akun Gmail yang ingin Anda gunakan.'}</p>
            <div className="tempmail-actions">
              <button type="button" className="tempmail-button" disabled={busy} onClick={connectGmail}><ShieldCheck size={15} /> {gmailActive ? 'Hubungkan ulang Gmail' : 'Hubungkan Gmail'}</button>
              {gmailActive && <button type="button" className="tempmail-button tempmail-button-secondary" disabled={busy} onClick={disconnectGmail}><Unplug size={15} /> Putuskan</button>}
            </div>
            {gmailActive && <div className="tempmail-gmail-generator">
              <label htmlFor="tempmail-gmail-tag">Akhiran setelah tanda + <small>(misalnya 1, toko-2026; maksimal 32 karakter)</small></label>
              <div className="tempmail-gmail-tag-row">
                <input id="tempmail-gmail-tag" value={gmailTag} maxLength={32} autoComplete="off" spellCheck="false" placeholder="1 (kosongkan untuk angka acak)" onChange={(event) => setGmailTag(event.target.value)} />
                <button type="button" className="tempmail-button" disabled={busy} onClick={generateGmailAlias}><Mail size={15} /> Generate ujung</button>
              </div>
              <div className="tempmail-gmail-preview">Contoh alamat: <code>{gmailPreview}</code></div>
            </div>}
          </>}
        </section>

        {!gmailActive && <section className="tempmail-card tempmail-address-card" aria-label="Alamat email sementara">
          <div className="tempmail-card-title"><div><span className="tempmail-kicker">MODE TEMPMAIL SEMENTARA</span><h2>Alamat email sementara</h2></div><span className="tempmail-provider-pill">mail.tm</span></div>
          {email ? <div className="tempmail-address-row"><code>{email}</code><button type="button" className="tempmail-button tempmail-button-secondary" onClick={copyEmail} aria-label="Salin alamat email"><Copy size={15} /> Salin</button></div> : <p className="tempmail-empty-address">{loading ? 'Memeriksa alamat tersimpan…' : gmailConfigured ? 'Hubungkan Gmail di atas untuk membuat alamat Gmail +tag.' : 'Belum ada alamat TempMail.'}</p>}
          <div className="tempmail-actions">
            {!gmailConfigured && !email && <button type="button" className="tempmail-button" disabled={busy || loading} onClick={() => createAddress(false)}><Mail size={15} /> Buat alamat email</button>}
            {email && <><button type="button" className="tempmail-button" disabled={busy} onClick={() => loadMessages(email)}><RefreshCw size={15} className={busy ? 'tempmail-spin' : ''} /> Refresh inbox</button>{!gmailConfigured && <button type="button" className="tempmail-button tempmail-button-secondary" disabled={busy} onClick={() => createAddress(true)}><RotateCcw size={15} /> Alamat baru</button>}</>}
            <span className="tempmail-poll-hint">Pembaruan otomatis tiap 15 detik</span>
          </div>
          <div className={`tempmail-status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || status}{lastUpdated && !error ? ` · ${lastUpdated.toLocaleTimeString('id-ID')}` : ''}</div>
          <p className="tempmail-security-note">Alamat mail.tm bersifat sementara. Gunakan mode ini hanya jika Gmail OAuth belum dikonfigurasi; jangan gunakan untuk menerima informasi sensitif atau pemulihan akun penting.</p>
        </section>}

        {gmailActive && <section className="tempmail-card tempmail-address-card" aria-label="Alamat Gmail sementara">
          <div className="tempmail-card-title"><div><span className="tempmail-kicker">ALAMAT GMAIL AKTIF</span><h2>Alias Gmail</h2></div><span className="tempmail-provider-pill is-connected">gmail.com</span></div>
          {email ? <div className="tempmail-address-row"><code>{email}</code><button type="button" className="tempmail-button tempmail-button-secondary" onClick={copyEmail} aria-label="Salin alamat email"><Copy size={15} /> Salin</button></div> : <p className="tempmail-empty-address">Belum ada akhiran Gmail. Isi akhiran di atas dan pilih Generate ujung.</p>}
          <div className="tempmail-actions">{email && <button type="button" className="tempmail-button" disabled={busy} onClick={() => loadMessages(email)}><RefreshCw size={15} className={busy ? 'tempmail-spin' : ''} /> Refresh inbox</button>}<span className="tempmail-poll-hint">Inbox diperbarui otomatis tiap 15 detik</span></div>
          <div className={`tempmail-status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || status}{lastUpdated && !error ? ` · ${lastUpdated.toLocaleTimeString('id-ID')}` : ''}</div>
          <p className="tempmail-security-note">Alias +tag dikirim ke Gmail Anda. Email yang ditujukan ke alamat dasar tanpa akhiran tidak ditampilkan sebagai pesan alias.</p>
        </section>}

        <div className="tempmail-content-grid">
          <section className="tempmail-card tempmail-inbox-card">
            <div className="tempmail-card-title"><div><span className="tempmail-kicker">INBOX</span><h2>Pesan masuk</h2></div><span className="tempmail-count">{messages.length}</span></div>
            {!email ? <div className="tempmail-list-empty"><Inbox size={24} /><span>Buat alias email untuk melihat inbox.</span></div> : messages.length === 0 ? <div className="tempmail-list-empty"><Inbox size={24} /><span>{busy ? 'Memeriksa pesan…' : 'Belum ada pesan masuk.'}</span></div> : <div className="tempmail-message-list">{messages.map((message) => <button type="button" key={message.id} className={`tempmail-message-item ${selectedMessage?.id === message.id ? 'is-selected' : ''}`} onClick={() => openMessage(message)}><span className="tempmail-message-top"><b>{message.subject || '(Tanpa subjek)'}</b><time>{displayDate(message.createdAt)}</time></span><span className="tempmail-message-from">{message.from || 'Pengirim tidak diketahui'}</span>{message.preview && <span className="tempmail-message-preview">{message.preview}</span>}</button>)}</div>}
          </section>

          <section className="tempmail-card tempmail-detail-card" aria-label="Isi email">
            <div className="tempmail-card-title"><div><span className="tempmail-kicker">PESAN</span><h2>{selectedMessage?.subject || 'Isi email'}</h2></div></div>
            {!selectedMessage ? <div className="tempmail-list-empty"><Mail size={24} /><span>Pilih pesan di inbox untuk membaca isinya.</span></div> : <><div className="tempmail-detail-meta"><b>Dari</b><span>{selectedMessage.from || '—'}</span><b>Kepada</b><span>{selectedMessage.to || email}</span><b>Tanggal</b><span>{displayDate(selectedMessage.createdAt) || '—'}</span></div>
              {verificationCode.code && <div className="tempmail-code"><div><span className="tempmail-kicker">KODE TERBACA</span><code className="tempmail-code-value">{verificationCode.code}</code></div><button type="button" className="tempmail-button tempmail-button-secondary" onClick={copyVerificationCode}><Copy size={14} /> {codeCopied ? 'Kode disalin' : 'Salin kode'}</button><small>Kode ini sekali pakai. Tempel di kolom verifikasi, bukan di URL.</small></div>}{selectedMessage.bodyHtml ? <iframe className="tempmail-message-frame" title="Isi pesan email (terisolasi)" sandbox="" referrerPolicy="no-referrer" srcDoc={htmlDocument} /> : <pre className="tempmail-message-text">{selectedMessage.bodyText || 'Email ini tidak berisi teks.'}</pre>}</>}
          </section>
        </div>
      </main>
    </DropXLayout>
  );
}
