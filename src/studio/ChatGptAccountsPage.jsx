import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { ChatGptOAuthPanel } from './ChatGptOAuthPanel';
import {
  createChatGptAccount,
  deleteChatGptAccount,
  fetchChatGptAccounts,
  testChatGptAccount,
  updateChatGptAccount,
} from './studioClient';
import './chatgpt-accounts.css';

const CAPABILITY_LABELS = {
  chat: 'Chat',
  agent: 'Agen',
  image: 'Gambar',
  video: 'Video',
  audio: 'Audio',
  music: 'Musik',
  metadata: 'Metadata',
};

const STATE_META = {
  siap: { label: 'Siap dipakai', tone: 'ok' },
  'kuota-habis': { label: 'Kuota harian habis', tone: 'warn' },
  cooldown: { label: 'Cooldown', tone: 'warn' },
  nonaktif: { label: 'Nonaktif', tone: 'muted' },
  'tidak-bisa-dipanggil': { label: 'Token sesi (tidak dipanggil)', tone: 'muted' },
};

const EMPTY_FORM = {
  account_email: '',
  account_label: '',
  token: '',
  credential_kind: 'api_key',
  daily_limit: 200,
  priority: '',
  capabilities: ['chat', 'agent'],
  model_default: 'gpt-4o-mini',
  api_base: '',
};

function relTime(iso) {
  if (!iso) return 'belum pernah';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'baru saja';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} menit lalu`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} jam lalu`;
  return new Date(iso).toLocaleDateString('id-ID');
}

export function ChatGptAccountsPage() {
  const [accounts, setAccounts] = useState([]);
  const [capabilities, setCapabilities] = useState(Object.keys(CAPABILITY_LABELS));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState('info');
  const [busyId, setBusyId] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [confirmDeleteId, setConfirmDeleteId] = useState('');
  const [formOpen, setFormOpen] = useState(false);

  const setBanner = useCallback((message, tone = 'info') => {
    setNotice(message);
    setNoticeTone(tone);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await fetchChatGptAccounts();
    if (!res.ok) {
      setError(res.data?.error || 'Daftar akun tidak dapat dimuat.');
      setAccounts([]);
    } else {
      setAccounts(Array.isArray(res.data?.accounts) ? res.data.accounts : []);
      if (Array.isArray(res.data?.capabilities) && res.data.capabilities.length) setCapabilities(res.data.capabilities);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = useMemo(() => {
    const total = accounts.length;
    const usable = accounts.filter((account) => account.usable).length;
    const exhausted = accounts.filter((account) => account.state === 'kuota-habis').length;
    const cooling = accounts.filter((account) => account.state === 'cooldown').length;
    return { total, usable, exhausted, cooling };
  }, [accounts]);

  const createAccount = useCallback(async (event) => {
    event.preventDefault();
    setCreating(true);
    setBanner('', 'info');
    try {
      const payload = {
        account_email: form.account_email,
        account_label: form.account_label,
        token: form.token,
        credential_kind: form.credential_kind,
        daily_limit: Number(form.daily_limit) || 0,
        capabilities: form.capabilities,
        model_default: form.model_default,
      };
      if (form.priority !== '' && form.priority !== null) payload.priority = Number(form.priority);
      if (form.api_base.trim()) payload.api_base = form.api_base.trim();
      const res = await createChatGptAccount(payload);
      if (!res.ok) throw new Error(res.data?.error || 'Akun gagal ditambahkan.');
      setForm(EMPTY_FORM);
      setFormOpen(false);
      setBanner(`Akun ${res.data?.account?.account_email || res.data?.account?.account_label || ''} ditambahkan ke pool.`, 'ok');
      await load();
    } catch (err) {
      setBanner(String(err?.message || err), 'error');
    } finally {
      setCreating(false);
    }
  }, [form, load, setBanner]);

  const patch = useCallback(async (id, body, successMessage) => {
    setBusyId(id);
    const res = await updateChatGptAccount({ id, ...body });
    setBusyId('');
    if (!res.ok) {
      setBanner(res.data?.error || 'Perubahan gagal disimpan.', 'error');
      return;
    }
    await load();
    if (successMessage) setBanner(successMessage, 'ok');
  }, [load, setBanner]);

  const runTest = useCallback(async (account) => {
    setBusyId(account.id);
    const res = await testChatGptAccount(account.id);
    setBusyId('');
    if (!res.ok) {
      setBanner(res.data?.error || 'Uji akun gagal.', 'error');
      return;
    }
    setBanner(res.data?.result?.message || 'Uji selesai.', res.data?.result?.ok ? 'ok' : 'error');
    await load();
  }, [load, setBanner]);

  const remove = useCallback(async (id) => {
    setBusyId(id);
    const res = await deleteChatGptAccount(id);
    setBusyId('');
    setConfirmDeleteId('');
    if (!res.ok) {
      setBanner(res.data?.error || 'Akun gagal dihapus.', 'error');
      return;
    }
    setBanner('Akun dihapus dari pool.', 'ok');
    await load();
  }, [load, setBanner]);

  const toggleCapability = useCallback((capability) => {
    setForm((current) => {
      const has = current.capabilities.includes(capability);
      const next = has ? current.capabilities.filter((item) => item !== capability) : [...current.capabilities, capability];
      return { ...current, capabilities: next.length ? next : ['chat'] };
    });
  }, []);

  return (
    <DropXLayout
      title="Akun ChatGPT"
      description="Pool akun manual: bila batas harian akun pertama habis, permintaan pindah ke akun berikutnya."
      actions={(
        <button type="button" className="studio-home-connection" onClick={load} disabled={loading}>
          {loading ? <Loader2 size={13} className="agent-spin" /> : <RefreshCw size={13} />} Muat ulang
        </button>
      )}
    >
      <div className="chatgpt-accounts">
        <section className="cga-hero">
          <span className="cga-badge"><KeyRound size={12} /> Admin · Koneksi</span>
          <h1>ChatGPT disambungkan seperti freebeat.</h1>
          <p>
            Ada dua jalur masuk pool. <b>Pertama</b> — jalur utama, tanpa API key sama sekali:
            <b> Continue with ChatGPT</b> di bawah memakai OAuth resmi OpenAI, jadi kuota yang
            terpakai adalah paket ChatGPT pemilik akun. <b>Kedua</b> — jalur cadangan untuk tool
            media: API key milik admin, karena izin OAuth hanya berlaku untuk chat & agen.
            Keduanya masuk pool yang sama: prioritas naik, kuota harian per akun, cooldown saat
            akun menolak, lalu lanjut ke akun berikutnya.
          </p>
          <ul className="cga-stats">
            <li><b>{summary.total}</b><small>akun di pool</small></li>
            <li><b>{summary.usable}</b><small>siap dipakai</small></li>
            <li><b>{summary.exhausted}</b><small>kuota habis</small></li>
            <li><b>{summary.cooling}</b><small>cooldown</small></li>
          </ul>
          <div className="cga-hero-actions">
            <button type="button" className="cga-primary" onClick={() => setFormOpen((open) => !open)}>
              <Plus size={13} /> {formOpen ? 'Tutup form' : 'Tambah akun manual'}
            </button>
            <Link className="cga-link" to="/studio/connection">Lihat status koneksi</Link>
          </div>
        </section>

        <ChatGptOAuthPanel onLinked={load} />

        {notice && (
          <p className={`cga-notice is-${noticeTone}`}>
            {noticeTone === 'error' ? <CircleAlert size={13} /> : noticeTone === 'ok' ? <CircleCheck size={13} /> : <ShieldAlert size={13} />}
            {notice}
          </p>
        )}
        {error && <p className="cga-notice is-error"><CircleAlert size={13} /> {error}</p>}

        {formOpen && (
          <form className="cga-form" onSubmit={createAccount}>
            <div className="cga-form-grid">
              <label>
                <span>Email akun</span>
                <input
                  type="email"
                  value={form.account_email}
                  onChange={(event) => setForm({ ...form, account_email: event.target.value })}
                  placeholder="nama@email.com (opsional)"
                  maxLength={320}
                />
              </label>
              <label>
                <span>Label</span>
                <input
                  type="text"
                  value={form.account_label}
                  onChange={(event) => setForm({ ...form, account_label: event.target.value })}
                  placeholder="mis. Akun utama, Akun cadangan"
                  maxLength={100}
                />
              </label>
              <label className="cga-span-2">
                <span>Kunci API / Token</span>
                <input
                  type="password"
                  value={form.token}
                  onChange={(event) => setForm({ ...form, token: event.target.value })}
                  placeholder="sk-… (disimpan tersegel di server)"
                  autoComplete="off"
                  required
                />
                <small>
                  Untuk pemakaian nyata pakai API key dari platform.openai.com. Token sesi ChatGPT
                  bisa disimpan sebagai catatan, tetapi tidak dipanggil ke backend non-publik.
                </small>
              </label>
              <label>
                <span>Jenis kredensial</span>
                <select
                  value={form.credential_kind}
                  onChange={(event) => setForm({ ...form, credential_kind: event.target.value })}
                >
                  <option value="api_key">API key resmi (bisa dipanggil)</option>
                  <option value="session">Token sesi ChatGPT (catatan)</option>
                </select>
              </label>
              <label>
                <span>Batas harian (0 = tanpa batas)</span>
                <input
                  type="number"
                  min="0"
                  max="1000000"
                  value={form.daily_limit}
                  onChange={(event) => setForm({ ...form, daily_limit: event.target.value })}
                />
              </label>
              <label>
                <span>Prioritas (kosong = otomatis di akhir)</span>
                <input
                  type="number"
                  min="0"
                  max="100000"
                  value={form.priority}
                  onChange={(event) => setForm({ ...form, priority: event.target.value })}
                  placeholder="100"
                />
              </label>
              <label>
                <span>Model default</span>
                <input
                  type="text"
                  value={form.model_default}
                  onChange={(event) => setForm({ ...form, model_default: event.target.value })}
                  placeholder="gpt-4o-mini"
                  maxLength={120}
                />
              </label>
              <label className="cga-span-2">
                <span>Base URL (opsional)</span>
                <input
                  type="url"
                  value={form.api_base}
                  onChange={(event) => setForm({ ...form, api_base: event.target.value })}
                  placeholder="https://api.openai.com"
                />
              </label>
            </div>
            <fieldset className="cga-caps">
              <legend>Boleh dipakai tool</legend>
              {capabilities.map((capability) => (
                <label key={capability} className="cga-cap">
                  <input
                    type="checkbox"
                    checked={form.capabilities.includes(capability)}
                    onChange={() => toggleCapability(capability)}
                  />
                  {CAPABILITY_LABELS[capability] || capability}
                </label>
              ))}
            </fieldset>
            <div className="cga-form-actions">
              <button type="submit" className="cga-primary" disabled={creating || !form.token.trim()}>
                {creating ? <Loader2 size={13} className="agent-spin" /> : <Plus size={13} />} Simpan akun
              </button>
              <small>Kredensial dienkripsi AES-GCM dan tidak pernah dikirim balik ke browser.</small>
            </div>
          </form>
        )}

        {loading && !accounts.length && (
          <p className="cga-empty"><Loader2 size={14} className="agent-spin" /> Memuat akun…</p>
        )}
        {!loading && !accounts.length && !error && (
          <div className="cga-empty-block">
            <p>Pool masih kosong. Tambahkan akun pertama supaya tool chat/agen punya cadangan.</p>
          </div>
        )}

        <ul className="cga-list">
          {accounts.map((account) => {
            const state = STATE_META[account.state] || { label: account.state, tone: 'muted' };
            const busy = busyId === account.id;
            const limit = account.daily_limit;
            const percentUsed = limit > 0 ? Math.min(100, Math.round((account.used_today / limit) * 100)) : 0;
            return (
              <li key={account.id} className={`cga-item is-${state.tone}`}>
                <div className="cga-item-head">
                  <div className="cga-item-id">
                    <b>{account.account_label || account.account_email || 'Akun tanpa label'}</b>
                    <small>
                      {account.account_email || 'tanpa email'} · prioritas {account.priority} ·{' '}
                      {account.credential_kind === 'api_key' ? `kunci ${account.token_hint || '—'}` : 'token sesi'}
                    </small>
                  </div>
                  <span className={`cga-state is-${state.tone}`}>
                    {account.state === 'cooldown' ? <Clock size={11} /> : account.enabled ? <CircleCheck size={11} /> : <CircleSlash size={11} />}
                    {state.label}
                  </span>
                </div>

                <div className="cga-quota">
                  <div className="cga-quota-bar"><span style={{ width: `${percentUsed}%` }} /></div>
                  <small>
                    {limit > 0
                      ? `${account.used_today} / ${limit} hari ini · sisa ${account.remaining}`
                      : `${account.used_today} hari ini · tanpa batas`}
                  </small>
                </div>

                <div className="cga-caps-row">
                  {account.capabilities.map((capability) => (
                    <em key={capability}>{CAPABILITY_LABELS[capability] || capability}</em>
                  ))}
                </div>

                {account.cooldown_until && (
                  <p className="cga-meta"><Clock size={11} /> Cooldown sampai {new Date(account.cooldown_until).toLocaleTimeString('id-ID')}</p>
                )}
                {account.last_error && <p className="cga-meta cga-meta-error"><CircleAlert size={11} /> {account.last_error}</p>}
                <p className="cga-meta">
                  Sukses terakhir: {relTime(account.last_ok_at)} · Uji terakhir: {relTime(account.last_test_at)}
                  {account.last_test_ok === false ? ' (gagal)' : account.last_test_ok === true ? ' (berhasil)' : ''}
                </p>

                <div className="cga-item-actions">
                  <button type="button" onClick={() => runTest(account)} disabled={busy}>
                    {busy ? <Loader2 size={12} className="agent-spin" /> : <ShieldAlert size={12} />} Uji
                  </button>
                  <button type="button" onClick={() => patch(account.id, { enabled: !account.enabled }, account.enabled ? 'Akun dinonaktifkan.' : 'Akun diaktifkan.')} disabled={busy}>
                    {account.enabled ? <CircleSlash size={12} /> : <CircleCheck size={12} />}
                    {account.enabled ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                  <button type="button" onClick={() => patch(account.id, { used_today: 0 }, 'Kuota harian direset.')} disabled={busy}>
                    <RefreshCw size={12} /> Reset kuota
                  </button>
                  {confirmDeleteId === account.id ? (
                    <>
                      <button type="button" className="cga-danger" onClick={() => remove(account.id)} disabled={busy}>
                        <Trash2 size={12} /> Yakin hapus
                      </button>
                      <button type="button" onClick={() => setConfirmDeleteId('')}>Batal</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDeleteId(account.id)}>
                      <Trash2 size={12} /> Hapus
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <section className="cga-explain">
          <h2>Bagaimana pemilihan akun bekerja</h2>
          <ol>
            <li>Urut prioritas naik, lalu akun yang paling sedikit dipakai hari ini.</li>
            <li>Akun yang kuota hariannya habis dilewati otomatis; permintaan pindah ke akun berikutnya.</li>
            <li>Akun yang ditolak (401/402/403/429) masuk cooldown 10–60 menit lalu dilewati.</li>
            <li>Tanggal kuota mengikuti WIB; akun hanya dipakai untuk tool yang dicentang di atas.</li>
          </ol>
          <p>
            Pemakaian pool oleh tool chat/agen akan aktif begitu ada minimal satu akun berjenis
            <b> API key</b> yang siap. Akun berjenis token sesi tetap tersimpan sebagai catatan,
            tetapi sengaja tidak dipanggil ke backend non-publik.
          </p>
        </section>
      </div>
    </DropXLayout>
  );
}

export default ChatGptAccountsPage;
