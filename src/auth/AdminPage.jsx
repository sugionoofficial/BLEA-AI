import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ChevronRight, CircleHelp, Clock3, FolderKanban, KeyRound, LayoutDashboard, LockKeyhole, LoaderCircle, LogOut, Mail, MessagesSquare, Plus, Search, ShieldCheck, Trash2, Users, X, Zap } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { verifyKey, fetchAdminModels, saveProviderModels } from '../api/unorouter';
import { useAuth } from './AuthProvider';

const tabs = [
  { id: 'overview', label: 'Ringkasan', icon: LayoutDashboard },
  { id: 'users', label: 'Pengguna', icon: Users },
  { id: 'projects', label: 'Proyek', icon: FolderKanban },
  { id: 'conversations', label: 'Percakapan', icon: MessagesSquare },
  { id: 'waitlist', label: 'Waitlist', icon: Mail },
  { id: 'api-keys', label: 'API Key', icon: KeyRound },
];

const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (value) => value ? dateFormat.format(new Date(value)) : '—';
const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

export function AdminPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [profiles, setProfiles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [providerKeys, setProviderKeys] = useState([]);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [keyNotices, setKeyNotices] = useState({});
  const [keyBusy, setKeyBusy] = useState('');
  const [newProvider, setNewProvider] = useState({ provider: '', label: '' });
  const [unoModels, setUnoModels] = useState([]);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelBusy, setModelBusy] = useState('');
  const [modelNotice, setModelNotice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMessage('');
    const [profileResult, projectResult, conversationResult, waitlistResult, providerKeyResult] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,created_at').order('created_at', { ascending: false }).limit(500),
      supabase.from('projects').select('id,user_id,name,description,created_at,updated_at').order('updated_at', { ascending: false }).limit(500),
      supabase.from('ai_conversations').select('id,user_id,project_id,title,created_at,updated_at').order('updated_at', { ascending: false }).limit(500),
      supabase.from('waitlist_signups').select('id,email,created_at').order('created_at', { ascending: false }).limit(500),
      supabase.from('provider_api_keys').select('provider,label,api_key,key_version,min_verified_at').order('provider'),
    ]);
    const errors = [profileResult.error, projectResult.error, conversationResult.error, waitlistResult.error, providerKeyResult.error].filter(Boolean);
    if (errors.length) {
      console.error('Admin data load failed:', errors);
      setErrorMessage('Sebagian data belum bisa dimuat. Pastikan akunmu memiliki role admin lalu coba lagi.');
    } else {
      setProfiles(profileResult.data ?? []);
      setProjects(projectResult.data ?? []);
      setConversations(conversationResult.data ?? []);
      setWaitlist(waitlistResult.data ?? []);
      setProviderKeys(providerKeyResult.data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    const uno = providerKeys.find((item) => item.provider === 'unorouter');
    if (uno?.api_key && !modelsLoaded && !modelBusy) loadUnoModels();
  }, [providerKeys, modelsLoaded, modelBusy]);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const query = search.trim().toLowerCase();
  const filteredProfiles = profiles.filter((profile) => `${profile.email || ''} ${profile.full_name || ''}`.toLowerCase().includes(query));
  const filteredProjects = projects.filter((project) => `${project.name} ${project.description} ${profileById.get(project.user_id)?.email || ''}`.toLowerCase().includes(query));
  const filteredConversations = conversations.filter((item) => `${item.title} ${profileById.get(item.user_id)?.email || ''}`.toLowerCase().includes(query));
  const filteredWaitlist = waitlist.filter((entry) => entry.email.toLowerCase().includes(query));

  async function deleteRecord() {
    if (!deleteTarget) return;
    setDeleting(true);
    const table = deleteTarget.kind === 'project' ? 'projects' : deleteTarget.kind === 'conversation' ? 'ai_conversations' : 'waitlist_signups';
    const { error } = await supabase.from(table).delete().eq('id', deleteTarget.id);
    if (error) {
      console.error('Admin delete failed:', error);
      setErrorMessage('Data belum berhasil dihapus. Coba lagi.');
    } else {
      setDeleteTarget(null);
      await loadData();
    }
    setDeleting(false);
  }

  async function exportWaitlist() {
    const csv = ['email,created_at', ...waitlist.map((item) => `${escapeCsv(item.email)},${escapeCsv(item.created_at)}`)].join('\n');
    const file = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
    const href = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = href;
    link.download = `blea-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(href);
  }

  async function saveProviderKey(provider) {
    const apiKey = String(keyDrafts[provider] || '').trim();
    if (!apiKey) {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Masukkan API key terlebih dahulu.' } }));
      return;
    }
    setKeyBusy(`save-${provider}`);
    const { error } = await supabase
      .from('provider_api_keys')
      .upsert({ provider, api_key: apiKey, updated_at: new Date().toISOString() });
    if (error) {
      console.error('Save provider key failed:', error);
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Penyimpanan gagal. Cek permission admin.' } }));
    } else {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'success', text: 'API key disimpan di Supabase.' } }));
      setKeyDrafts((current) => ({ ...current, [provider]: '' }));
      await loadData();
    }
    setKeyBusy('');
  }

  async function verifyProviderKey(provider) {
    const apiKey = String(keyDrafts[provider] || '').trim();
    if (!apiKey) {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Masukkan API key terlebih dahulu.' } }));
      return;
    }
    setKeyBusy(`verify-${provider}`);
    setKeyNotices((current) => ({ ...current, [provider]: { type: 'info', text: 'Memverifikasi ke UnoRouter...' } }));
    const { data, status } = await verifyKey({ apiKey });
    if (data?.ok) {
      const msg = data.verifiedVia === 'chat'
        ? 'Valid — key bisa digunakan (verifikasi via chat). Simpan untuk mengaktifkan.'
        : `Valid — ${data.modelsCount} model tersedia. Simpan untuk mengaktifkan.`;
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'success', text: msg } }));
    } else {
      console.warn('verify key failed:', { provider, status, data });
      setKeyNotices((current) => ({
        ...current,
        [provider]: {
          type: 'error',
          text: status === 401
            ? 'Sesi expired — login lagi sebelum verifikasi key.'
            : data?.error || `Verifikasi gagal (HTTP ${status ?? '—'}). Cek koneksi atau coba lagi.`,
        },
      }));
    }
    setKeyBusy('');
  }

  async function loadUnoModels() {
    setModelBusy('load');
    setModelNotice({ type: 'info', text: 'Memuat daftar model dari UnoRouter...' });
    const { models, error, status } = await fetchAdminModels({});
    if (Array.isArray(models)) {
      setUnoModels(models);
      setModelsLoaded(true);
      setModelNotice({
        type: 'success',
        text: `${models.length} model gratis tersedia. Pilih model aktif ( hijau ), lalu simpan.`,
      });
    } else {
      const msg = status === 401
        ? 'Sesi kamu expired — login lagi untuk memuat daftar model.'
        : error || `Pemuatan daftar model gagal (HTTP ${status ?? '—'}). Coba lagi.`;
      setModelNotice({ type: 'error', text: msg });
    }
    setModelBusy('');
  }

  function toggleUnoModel(modelId) {
    setUnoModels((current) => current.map((model) => model.id === modelId ? { ...model, active: !model.active } : model));
  }

  async function saveUnoModels() {
    const active = unoModels.filter((model) => model.active).map((model) => model.id);
    setModelBusy('save');
    const { data, status } = await saveProviderModels({ provider: 'unorouter', models: active });
    if (data?.ok) {
      setModelNotice({ type: 'success', text: `${data.activeCount} model aktif disimpan. AI Studio memakai model ini.` });
    } else {
      const msg = status === 401
        ? 'Sesi expired — login lagi sebelum menyimpan pilihan model.'
        : data?.error || `Penyimpanan model gagal (HTTP ${status ?? '—'}). Cek permission admin.`;
      setModelNotice({ type: 'error', text: msg });
    }
    setModelBusy('');
  }

  async function addProvider() {    const provider = newProvider.provider.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const label = newProvider.label.trim();
    if (!provider || !label) return;
    setKeyBusy('add');
    const { error } = await supabase
      .from('provider_api_keys')
      .insert({ provider, label, api_key: '' });
    if (error) {
      console.error('Add provider failed:', error);
      setKeyNotices((current) => ({ ...current, [`add:${provider}`]: { type: 'error', text: 'Provider tidak bisa ditambahkan.' } }));
    } else {
      setNewProvider({ provider: '', label: '' });
      await loadData();
    }
    setKeyBusy('');
  }

  async function removeProvider(provider) {
    setKeyBusy(`delete-${provider}`);
    const { error } = await supabase.from('provider_api_keys').delete().eq('provider', provider);
    if (error) {
      console.error('Remove provider failed:', error);
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Penghapusan gagal.' } }));
    } else {
      await loadData();
    }
    setKeyBusy('');
  }

  async function signOut() {
    setSigningOut(true);
    await supabase.auth.signOut();
    navigate('/login', { replace: true });
  }

  const activeRows = tab === 'users' ? filteredProfiles : tab === 'projects' ? filteredProjects : tab === 'conversations' ? filteredConversations : filteredWaitlist;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><Brand /></div>
        <div className="admin-console-mark"><span><ShieldCheck size={15} /></span><div><b>Admin console</b><small>BLEA AI management</small></div></div>
        <div className="admin-nav-label">PENGELOLAAN</div>
        <nav className="admin-nav" aria-label="Navigasi admin">{tabs.map(({ id, label, icon: Icon }) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setSearch(''); }}><Icon size={16} /><span>{label}</span>{id === 'users' && <small>{profiles.length}</small>}{id === 'projects' && <small>{projects.length}</small>}{id === 'conversations' && <small>{conversations.length}</small>}{id === 'waitlist' && <small>{waitlist.length}</small>}</button>)}</nav>
        <div className="admin-sidebar-bottom"><span className="admin-live"><i /> ADMIN MODE</span><button onClick={signOut} disabled={signingOut}><LogOut size={14} />{signingOut ? 'Keluar...' : 'Keluar'}</button></div>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar"><div className="admin-breadcrumb"><span>BLEA AI</span><ChevronRight size={13} /><b>{tabs.find((item) => item.id === tab)?.label}</b></div><div className="admin-top-actions"><span className="admin-access"><ShieldCheck size={13} /> Akses administrator</span><Link to="/app" className="admin-back-link"><ArrowLeft size={14} /> Kembali ke aplikasi</Link></div></header>
        <div className="admin-content">
          <div className="admin-heading"><div><span className="admin-eyebrow"><i /> ADMINISTRATOR</span><h1>{tab === 'overview' ? 'Pusat kendali.' : tab === 'users' ? 'Pengguna.' : tab === 'projects' ? 'Semua proyek.' : tab === 'conversations' ? 'Percakapan.' : tab === 'api-keys' ? 'Connect API key.' : 'Daftar tunggu.'}</h1><p>{tab === 'overview' ? 'Kelola pengguna dan konten BLEA AI dari satu tempat.' : tab === 'users' ? 'Akun yang sudah terdaftar di BLEA AI.' : tab === 'projects' ? 'Pantau dan kelola proyek di semua workspace.' : tab === 'conversations' ? 'Lihat ringkasan percakapan tersimpan; isi pesan tetap privat bagi pemilik akun.' : tab === 'api-keys' ? 'Semua provider yang memakai API key dikelola dari halaman ini. Kunci disimpan di Supabase dan digunakan server-side melalui edge function — tidak pernah sampai ke browser.' : 'Email yang meminta akses awal BLEA AI.'}</p></div><div className="admin-heading-meta"><span><Clock3 size={13} /> {new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</span><span className="admin-user-chip"><i>{(user?.user_metadata?.full_name || user?.email || 'A').slice(0, 1).toUpperCase()}</i>{user?.email}</span></div></div>
          {errorMessage && <div className="admin-error" role="alert">{errorMessage}<button onClick={loadData}>Coba lagi</button></div>}
          {tab === 'overview' && <>
            <section className="admin-metrics"><article><span className="metric-icon metric-purple"><Users size={17} /></span><span className="metric-label">PENGGUNA</span><b>{loading ? '—' : profiles.length}</b><small>Akun terdaftar</small></article><article><span className="metric-icon metric-blue"><FolderKanban size={17} /></span><span className="metric-label">PROYEK</span><b>{loading ? '—' : projects.length}</b><small>Di semua workspace</small></article><article><span className="metric-icon metric-peach"><Mail size={17} /></span><span className="metric-label">WAITLIST</span><b>{loading ? '—' : waitlist.length}</b><small>Pendaftar akses awal</small></article><article><span className="metric-icon metric-green"><MessagesSquare size={17} /></span><span className="metric-label">PERCAKAPAN</span><b>{loading ? '—' : conversations.length}</b><small>Riwayat tersimpan</small></article></section>
            <section className="admin-overview-grid"><article className="admin-overview-card"><div className="admin-card-heading"><div><span className="admin-eyebrow">AKTIVITAS TERBARU</span><h2>Pengguna terbaru</h2></div><button onClick={() => setTab('users')}>Semua <ArrowUpRight size={13} /></button></div>{loading ? <div className="admin-skeleton" /> : profiles.slice(0, 5).map((profile) => <div className="admin-activity-row" key={profile.id}><span className="admin-avatar">{(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}</span><span className="admin-row-main"><b>{profile.full_name || 'Nama belum diatur'}</b><small>{profile.email || '—'}</small></span><small className="admin-row-date">{formatDate(profile.created_at)}</small></div>)}{!loading && profiles.length === 0 && <div className="admin-empty-inline">Belum ada pengguna terdaftar.</div>}</article><article className="admin-overview-card"><div className="admin-card-heading"><div><span className="admin-eyebrow">KONTEN TERBARU</span><h2>Proyek terbaru</h2></div><button onClick={() => setTab('projects')}>Semua <ArrowUpRight size={13} /></button></div>{loading ? <div className="admin-skeleton" /> : projects.slice(0, 5).map((project) => <div className="admin-activity-row" key={project.id}><span className="admin-project-icon"><FolderKanban size={14} /></span><span className="admin-row-main"><b>{project.name}</b><small>{profileById.get(project.user_id)?.email || 'Akun tidak ditemukan'}</small></span><small className="admin-row-date">{formatDate(project.updated_at)}</small></div>)}{!loading && projects.length === 0 && <div className="admin-empty-inline">Belum ada proyek.</div>}</article></section>
            <section className="admin-note"><ShieldCheck size={16} /><div><b>Akses admin terlindungi.</b><p>Panel ini dan operasi datanya diproteksi oleh role `app_metadata` serta Row Level Security di Supabase.</p></div><span>RLS ACTIVE</span></section>
          </>}

          {tab === 'api-keys' && <>
            <section className="admin-api-card">
              <div className="admin-api-heading"><div><span className="admin-eyebrow">GATEWAY · UNORouter</span><h2>Provider API key</h2></div><span className="admin-api-badge"><Zap size={13} /> Server-side · edge function</span></div>
              <p className="admin-api-note">Menyimpan kunci API untuk provider seperti UnoRouter. Kunci dipakai oleh edge function <b>ai-chat</b> di Supabase — klien browser hanya mengirim permintaan tanpa melihat kunci.</p>
              {providerKeys.length === 0 && <div className="admin-empty-inline">Belum ada provider. Masukkan kunci UnoRouter di bawah — tersimpan otomatis.</div>}
              {(providerKeys.some((item) => item.provider === 'unorouter') ? providerKeys : [{ provider: 'unorouter', label: 'UnoRouter', api_key: '' }, ...providerKeys]).map((provider) => <div className="admin-api-row" key={provider.provider}>
                <div className="admin-api-row-top"><div><span className="admin-api-name">{provider.label || provider.provider}</span><small>{provider.provider}</small></div><span className={`admin-api-state ${provider.api_key ? '' : 'is-empty'}`}>{provider.api_key ? 'Terhubung' : 'Belum terhubung'}</span></div>
                <div className="admin-api-input-row">
                  <LockKeyhole size={14} />
                  <input type="password" value={keyDrafts[provider.provider] || ''} onChange={(event) => setKeyDrafts((current) => ({ ...current, [provider.provider]: event.target.value }))} placeholder={provider.api_key ? 'Ganti kunci...' : 'Masukkan API key...'} />
                  <button className="admin-api-verify" onClick={() => verifyProviderKey(provider.provider)} disabled={keyBusy === `verify-${provider.provider}`}><Check size={14} /> Verifikasi</button>
                  <button className="admin-api-save" onClick={() => saveProviderKey(provider.provider)} disabled={keyBusy === `save-${provider.provider}`}>Simpan</button>
                  <button className="admin-api-remove" onClick={() => removeProvider(provider.provider)} disabled={keyBusy === `delete-${provider.provider}`} aria-label={`Hapus ${provider.provider}`}><Trash2 size={14} /></button>
                </div>
                {keyNotices[provider.provider] && <div className={`admin-api-notice is-${keyNotices[provider.provider].type}`}>{keyNotices[provider.provider].text}</div>}
              </div>)}
            </section>
            {providerKeys.some((item) => item.provider === 'unorouter') && <section className="admin-api-card">
              <div className="admin-api-heading"><div><span className="admin-eyebrow">MODEL · UNORouter</span><h2>Model tersedia</h2></div><span className="admin-api-badge"><Zap size={13} /> Model gratis · disaring</span></div>
              <p className="admin-api-note">Daftar model dari UnoRouter — hanya model gratis yang ditampilkan. Tombol <b>Active</b> (hijau) mengaktifkan model untuk AI Studio; <b>OFF</b> (merah) menonaktifkannya. Pilih lalu simpan.</p>
              <div className="admin-model-toolbar"><button className="admin-api-verify" onClick={loadUnoModels} disabled={modelBusy === 'load' || !providerKeys.find((item) => item.provider === 'unorouter')?.api_key}>{modelBusy === 'load' ? 'Memuat...' : 'Muat daftar model'}</button><small>{unoModels.filter((model) => model.active).length} model aktif · {unoModels.length} tersedia</small></div>
              {modelNotice && <div className={`admin-api-notice is-${modelNotice.type}`}>{modelNotice.text}</div>}
              {modelsLoaded && unoModels.length > 0 && <div className="admin-model-list">{unoModels.map((model) => <div className="admin-model-row" key={model.id}><span className="admin-model-name">{model.id}</span><button className={`admin-model-toggle ${model.active ? 'is-active' : 'is-off'}`} onClick={() => toggleUnoModel(model.id)} aria-pressed={model.active}><span className="admin-model-dot" />{model.active ? 'Active' : 'OFF'}</button></div>)}</div>}
              {modelsLoaded && unoModels.length === 0 && <div className="admin-empty-inline">Tidak ada model gratis yang ditemukan. Cek API key atau muat ulang.</div>}
              {modelsLoaded && unoModels.length > 0 && <div className="admin-api-input-row" style={{ marginTop: 12 }}><button className="admin-api-save" onClick={saveUnoModels} disabled={modelBusy === 'save'}>Simpan pilihan model</button></div>}
            </section>}
            <section className="admin-api-card">
              <div className="admin-api-heading"><div><span className="admin-eyebrow">TAMBAH PROVIDER</span><h2>Provider baru</h2></div></div>
              <p className="admin-api-note">Provider lain yang memakai API key (misal gateway model tambahan) dapat ditambahkan di sini. Kunci baru tetap disimpan di Supabase dan diakses server-side.</p>
              <div className="admin-api-input-row">
                <input value={newProvider.provider} onChange={(event) => setNewProvider((current) => ({ ...current, provider: event.target.value }))} placeholder="id provider (contoh: openai)" />
                <input value={newProvider.label} onChange={(event) => setNewProvider((current) => ({ ...current, label: event.target.value }))} placeholder="Nama tampilan" />
                <button className="admin-api-save" onClick={addProvider} disabled={keyBusy === 'add' || !newProvider.provider.trim() || !newProvider.label.trim()}><Plus size={14} /> Tambah provider</button>
              </div>
              {keyNotices[`add:${newProvider.provider}`] && <div className={`admin-api-notice is-${keyNotices[`add:${newProvider.provider}`].type}`}>{keyNotices[`add:${newProvider.provider}`].text}</div>}
            </section>
          </>}
          {tab !== 'overview' && tab !== 'api-keys' && <section className="admin-table-card"><div className="admin-table-toolbar"><label className="admin-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === 'users' ? 'Cari nama atau email...' : tab === 'projects' ? 'Cari proyek atau pemilik...' : tab === 'conversations' ? 'Cari percakapan atau pemilik...' : 'Cari email waitlist...'} /></label>{tab === 'waitlist' && <button className="admin-export-button" onClick={exportWaitlist} disabled={!waitlist.length}><ArrowDownToLine size={14} /> Ekspor CSV</button>}<button className="admin-refresh-button" onClick={loadData} disabled={loading}><LoaderCircle size={14} className={loading ? 'spinning' : ''} /> Muat ulang</button></div>
            <div className="admin-table-scroll"><table><thead><tr>{tab === 'users' ? <><th>PENGGUNA</th><th>ID AKUN</th><th>BERGABUNG</th><th>STATUS</th></> : tab === 'projects' ? <><th>NAMA PROYEK</th><th>PEMILIK</th><th>DIPERBARUI</th><th></th></> : tab === 'conversations' ? <><th>JUDUL</th><th>PEMILIK</th><th>DIPERBARUI</th><th></th></> : <><th>EMAIL</th><th>MENDAFTAR</th><th></th></>}</tr></thead><tbody>
              {loading ? <tr><td colSpan={4} className="admin-table-message">Memuat data...</td></tr> : tab === 'users' ? filteredProfiles.map((profile) => <tr key={profile.id}><td><span className="admin-user-cell"><i className="admin-avatar">{(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}</i><span><b>{profile.full_name || 'Nama belum diatur'}</b><small>{profile.email || '—'}</small></span></span></td><td className="admin-id-cell">{profile.id.slice(0, 8)}…</td><td>{formatDate(profile.created_at)}</td><td><span className="admin-status-pill"><i /> Terdaftar</span></td></tr>) : tab === 'projects' ? filteredProjects.map((project) => <tr key={project.id}><td><span className="admin-project-cell"><b>{project.name}</b><small>{project.description || 'Tanpa deskripsi'}</small></span></td><td>{profileById.get(project.user_id)?.email || '—'}</td><td>{formatDate(project.updated_at)}</td><td><button className="admin-delete-icon" aria-label={`Hapus ${project.name}`} onClick={() => setDeleteTarget({ kind: 'project', id: project.id, label: project.name })}><Trash2 size={14} /></button></td></tr>) : tab === 'conversations' ? filteredConversations.map((conversation) => <tr key={conversation.id}><td><span className="admin-project-cell"><b>{conversation.title}</b><small>Isi pesan tidak ditampilkan demi privasi</small></span></td><td>{profileById.get(conversation.user_id)?.email || '—'}</td><td>{formatDate(conversation.updated_at)}</td><td><button className="admin-delete-icon" aria-label={`Hapus percakapan ${conversation.title}`} onClick={() => setDeleteTarget({ kind: 'conversation', id: conversation.id, label: conversation.title })}><Trash2 size={14} /></button></td></tr>) : filteredWaitlist.map((entry) => <tr key={entry.id}><td><b className="admin-email-cell">{entry.email}</b></td><td>{formatDate(entry.created_at)}</td><td><button className="admin-delete-icon" aria-label={`Hapus ${entry.email} dari waitlist`} onClick={() => setDeleteTarget({ kind: 'waitlist', id: entry.id, label: entry.email })}><Trash2 size={14} /></button></td></tr>)}
              {!loading && activeRows.length === 0 && <tr><td colSpan={4} className="admin-table-message">{query ? 'Tidak ada hasil yang cocok.' : 'Belum ada data.'}</td></tr>}
            </tbody></table></div><div className="admin-table-footer"><span>Menampilkan {activeRows.length} dari {tab === 'users' ? profiles.length : tab === 'projects' ? projects.length : tab === 'conversations' ? conversations.length : waitlist.length} data (maks. 500)</span><span>Perubahan tersimpan langsung</span></div>
          </section>}
          <footer className="admin-footer"><span>BLEA AI · Admin console</span><span><i /> Hanya administrator terverifikasi</span></footer>
        </div>
      </main>
      {deleteTarget && <div className="admin-modal-backdrop"><section className="admin-delete-modal" role="dialog" aria-modal="true" aria-labelledby="admin-delete-title"><button className="admin-modal-close" onClick={() => setDeleteTarget(null)} aria-label="Tutup"><X size={16} /></button><span className="admin-delete-icon-large"><Trash2 size={19} /></span><h2 id="admin-delete-title">Hapus data ini?</h2><p><b>{deleteTarget.label}</b> akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.</p><div><button className="admin-cancel-button" onClick={() => setDeleteTarget(null)}>Batal</button><button className="admin-confirm-delete" onClick={deleteRecord} disabled={deleting}>{deleting ? 'Menghapus...' : 'Ya, hapus'}</button></div></section></div>}
    </div>
  );
}
