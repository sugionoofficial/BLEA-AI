import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Inbox, Mail, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
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
  if (!response.ok) throw new Error(data?.error || `Permintaan TempMail gagal (HTTP ${response.status}).`);
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
  const [status, setStatus] = useState('Memuat alamat TempMail...');
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);

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
      const data = await tempmailRequest('alias');
      const savedEmail = data?.alias?.email || '';
      setEmail(savedEmail);
      if (savedEmail) {
        setStatus('Alamat TempMail siap.');
        await loadMessages(savedEmail, true);
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

  useEffect(() => { loadAlias(); }, [loadAlias]);

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

  const openMessage = async (message) => {
    setBusy(true);
    setError('');
    try {
      const data = await tempmailRequest('message', { params: { email, messageId: message.id } });
      setSelectedMessage(data.message || null);
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

  const htmlDocument = useMemo(() => emailFrameDocument(selectedMessage?.bodyHtml), [selectedMessage?.bodyHtml]);

  return (
    <DropXLayout title="TempMail" description="Kotak masuk email sementara khusus admin." footer={false}>
      <main className="tempmail-page">
        <header className="tempmail-heading">
          <div className="tempmail-heading-icon"><Mail size={20} /></div>
          <div>
            <span className="tempmail-eyebrow"><ShieldCheck size={13} /> ADMIN ONLY</span>
            <h1>TempMail</h1>
            <p>Buat alamat email sementara dan pantau inbox dari satu tempat.</p>
          </div>
        </header>

        <section className="tempmail-card tempmail-address-card" aria-label="Alamat email sementara">
          <div className="tempmail-card-title"><div><span className="tempmail-kicker">ALAMAT AKTIF</span><h2>Email sementara</h2></div><span className="tempmail-provider-pill">mail.tm</span></div>
          {email ? (
            <div className="tempmail-address-row">
              <code>{email}</code>
              <button type="button" className="tempmail-button tempmail-button-secondary" onClick={copyEmail} aria-label="Salin alamat email"><Copy size={15} /> Salin</button>
            </div>
          ) : <p className="tempmail-empty-address">{loading ? 'Memeriksa alamat tersimpan…' : 'Belum ada alamat TempMail.'}</p>}
          <div className="tempmail-actions">
            {!email && <button type="button" className="tempmail-button" disabled={busy || loading} onClick={() => createAddress(false)}><Mail size={15} /> Buat alamat email</button>}
            {email && <>
              <button type="button" className="tempmail-button" disabled={busy} onClick={() => loadMessages(email)}><RefreshCw size={15} className={busy ? 'tempmail-spin' : ''} /> Refresh inbox</button>
              <button type="button" className="tempmail-button tempmail-button-secondary" disabled={busy} onClick={() => createAddress(true)}><RotateCcw size={15} /> Alamat baru</button>
            </>}
            <span className="tempmail-poll-hint">Pembaruan otomatis tiap 15 detik</span>
          </div>
          <div className={`tempmail-status ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{error || status}{lastUpdated && !error ? ` · ${lastUpdated.toLocaleTimeString('id-ID')}` : ''}</div>
          <p className="tempmail-security-note">Alamat ini dikelola oleh layanan mail.tm dan mungkin bersifat sementara. Jangan gunakan untuk menerima informasi sensitif atau pemulihan akun penting.</p>
        </section>

        <div className="tempmail-content-grid">
          <section className="tempmail-card tempmail-inbox-card">
            <div className="tempmail-card-title"><div><span className="tempmail-kicker">INBOX</span><h2>Pesan masuk</h2></div><span className="tempmail-count">{messages.length}</span></div>
            {!email ? <div className="tempmail-list-empty"><Inbox size={24} /><span>Buat alamat email untuk melihat inbox.</span></div> : messages.length === 0 ? <div className="tempmail-list-empty"><Inbox size={24} /><span>{busy ? 'Memeriksa pesan…' : 'Belum ada pesan masuk.'}</span></div> : (
              <div className="tempmail-message-list">
                {messages.map((message) => (
                  <button type="button" key={message.id} className={`tempmail-message-item ${selectedMessage?.id === message.id ? 'is-selected' : ''}`} onClick={() => openMessage(message)}>
                    <span className="tempmail-message-top"><b>{message.subject || '(Tanpa subjek)'}</b><time>{displayDate(message.createdAt)}</time></span>
                    <span className="tempmail-message-from">{message.from || 'Pengirim tidak diketahui'}</span>
                    {message.preview && <span className="tempmail-message-preview">{message.preview}</span>}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="tempmail-card tempmail-detail-card" aria-label="Isi email">
            <div className="tempmail-card-title"><div><span className="tempmail-kicker">PESAN</span><h2>{selectedMessage?.subject || 'Isi email'}</h2></div></div>
            {!selectedMessage ? <div className="tempmail-list-empty"><Mail size={24} /><span>Pilih pesan di inbox untuk membaca isinya.</span></div> : <>
              <div className="tempmail-detail-meta"><b>Dari</b><span>{selectedMessage.from || '—'}</span><b>Kepada</b><span>{selectedMessage.to || email}</span><b>Tanggal</b><span>{displayDate(selectedMessage.createdAt) || '—'}</span></div>
              {selectedMessage.bodyHtml ? <iframe className="tempmail-message-frame" title="Isi pesan email (terisolasi)" sandbox="" referrerPolicy="no-referrer" srcDoc={htmlDocument} /> : <pre className="tempmail-message-text">{selectedMessage.bodyText || 'Email ini tidak berisi teks.'}</pre>}
            </>}
          </section>
        </div>
      </main>
    </DropXLayout>
  );
}
