import { adminUserAction, adminUserRoles } from '../api/adminUsers';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlibabaCloudPanel } from './AlibabaCloudPanel';
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  ChevronDown,
  Cloud,
  Clapperboard,
  Clock3,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  KeyRound,
  LayoutDashboard,
  LoaderCircle,
  RefreshCw,
  LockKeyhole,
  Mail,
  MessagesSquare,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { supabase } from '../lib/supabase';
import { PROVIDER_PRESETS, validateProviderBaseUrl } from '../lib/videoCatalog';
import {
  fetchAdminModels,
  fetchCatalog,
  saveProviderModels,
  saveSingleProviderModel,
  verifyKey,
  fetchProviderQuota,
} from '../api/unorouter';
import { useAuth } from './AuthProvider';

const NAV_GROUPS = [
  {
    label: 'Ringkasan & Data',
    items: [
      {
        id: 'overview',
        label: 'Ikhtisar',
        icon: LayoutDashboard,
        children: [
          { id: 'all', label: 'Semua Ringkasan' },
          { id: 'metrics', label: 'Metrik & Keamanan' },
          { id: 'activity', label: 'Aktivitas Terbaru' },
        ],
      },
      {
        id: 'users',
        label: 'Pengguna',
        icon: Users,
        children: [
          { id: 'all', label: 'Semua Akun' },
          { id: 'recent', label: '7 Hari Terakhir' },
        ],
      },
      {
        id: 'videos',
        label: 'Generasi video',
        icon: Clapperboard,
        children: [
          { id: 'all', label: 'Semua Status' },
          { id: 'processing', label: 'Diproses & Antrean' },
          { id: 'completed', label: 'Selesai' },
          { id: 'failed', label: 'Gagal' },
        ],
      },
      {
        id: 'conversations',
        label: 'Percakapan',
        icon: MessagesSquare,
        children: [
          { id: 'all', label: 'Semua Percakapan' },
          { id: 'recent', label: '7 Hari Terakhir' },
        ],
      },
      {
        id: 'waitlist',
        label: 'Waitlist',
        icon: Mail,
        children: [
          { id: 'all', label: 'Semua Pendaftar' },
          { id: 'recent', label: '7 Hari Terakhir' },
        ],
      },
    ],
  },
  {
    label: 'Integrasi & AI',
    items: [
      {
        id: 'api-keys',
        label: 'API Key',
        icon: KeyRound,
        children: [
          { id: 'providers', label: 'Provider & API Key' },
          { id: 'catalog', label: 'Katalog Model' },
          { id: 'manual', label: 'Model Manual' },
          { id: 'add-provider', label: 'Tambah Provider' },
        ],
      },
      {
        id: 'alibaba',
        label: 'Alibaba Cloud',
        icon: Cloud,
        children: [
          { id: 'accounts', label: 'Akun & API Key' },
          { id: 'catalog', label: 'Katalog Free Quota' },
        ],
      },
    ],
  },
];

const QUICK_PROVIDER_PRESETS = [
  PROVIDER_PRESETS.cloudflare,
  PROVIDER_PRESETS.pekpik,
  PROVIDER_PRESETS.unorouter,
  PROVIDER_PRESETS.openrouter,
  PROVIDER_PRESETS.xai,
  PROVIDER_PRESETS.openai,
  PROVIDER_PRESETS.google,
  PROVIDER_PRESETS.doubao,
  PROVIDER_PRESETS.alibaba,
  PROVIDER_PRESETS.kling,
  PROVIDER_PRESETS.hailuo,
].filter(Boolean);

const USER_STATUS_LABEL = { active: 'Aktif', suspended: 'Suspended', banned: 'Banned' };
const VIDEO_STATUS_LABEL = {
  queued: 'Antrean',
  in_progress: 'Diproses',
  completed: 'Selesai',
  failed: 'Gagal',
  cancelled: 'Dibatalkan',
  expired: 'Kedaluwarsa',
};

const dateFormat = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (value) => (value ? dateFormat.format(new Date(value)) : '—');
const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

function isWithinDays(value, days) {
  if (!value) return false;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) && (Date.now() - ts) <= days * 24 * 60 * 60 * 1000;
}

export function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState('overview');
  const [subTab, setSubTab] = useState({
    overview: 'all',
    users: 'all',
    videos: 'all',
    conversations: 'all',
    waitlist: 'all',
    'api-keys': 'providers',
    alibaba: 'accounts',
  });
  const [apiTreeOpen, setApiTreeOpen] = useState(true);

  const [profiles, setProfiles] = useState([]);
  const [videos, setVideos] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [providerKeys, setProviderKeys] = useState([]);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [baseUrlDrafts, setBaseUrlDrafts] = useState({});
  const [revealedKeys, setRevealedKeys] = useState({});
  const [keyNotices, setKeyNotices] = useState({});
  const [keyBusy, setKeyBusy] = useState('');
  const [quotas, setQuotas] = useState({});
  const [quotaBusy, setQuotaBusy] = useState('');
  const [newProvider, setNewProvider] = useState({ provider: '', label: '', base_url: '' });
  const [catalogProvider, setCatalogProvider] = useState('');
  const [unoModels, setUnoModels] = useState([]);
  const [customModels, setCustomModels] = useState([]);
  const [newCustomModel, setNewCustomModel] = useState({ provider: '', model: '' });
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelBusy, setModelBusy] = useState('');
  const [modelNotice, setModelNotice] = useState(null);
  const [modelFilter, setModelFilter] = useState('All');
  const [modelQuery, setModelQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState('');
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [wallets, setWallets] = useState({});
  // null = peran belum/tidak dapat dimuat dari worker; kolom PEROAN menampilkan '—'.
  const [adminIds, setAdminIds] = useState(null);
  const [userAction, setUserAction] = useState(null);
  const [actionPassword, setActionPassword] = useState('');
  const [actionDelta, setActionDelta] = useState('100');
  const [actionDescription, setActionDescription] = useState('');
  const [actionStatus, setActionStatus] = useState('active');
  const [actionReason, setActionReason] = useState('');
  const [actionConfirmEmail, setActionConfirmEmail] = useState('');
  const [actionRole, setActionRole] = useState('user');
  const [actionBusy, setActionBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionNotice, setActionNotice] = useState('');

  function openUserAction(profile) {
    setUserAction(profile);
    setActionPassword(''); setActionDelta('100'); setActionDescription('');
    setActionStatus(profile.status || 'active'); setActionReason(profile.status_reason || '');
    setActionConfirmEmail(''); setActionRole((adminIds ?? []).includes(profile.id) ? 'admin' : 'user');
    setActionBusy(''); setActionError(''); setActionNotice('');
  }
  async function runUserAction(kind, extra = {}) {
    if (!userAction || actionBusy) return;
    if (actionPassword.length < 6) { setActionError('Masukkan password aksi admin (minimal 6 karakter).'); return; }
    setActionBusy(kind); setActionError(''); setActionNotice('');
    const res = await adminUserAction({ action: kind, user_id: userAction.id, password: actionPassword, ...extra });
    setActionBusy('');
    if (!res.ok) { setActionError(res.data?.error || 'Aksi gagal.'); return; }
    if (kind === 'delete') {
      setActionNotice('Akun dihapus permanen beserta seluruh datanya.');
      setUserAction(null);
      await loadData();
      return;
    }
    setActionNotice(kind === 'credits'
      ? `Saldo diperbarui menjadi ${res.data?.balance ?? '—'} kredit.`
      : kind === 'status'
        ? `Status akun diubah menjadi ${res.data?.status}.`
        : `Peran akun diubah menjadi ${res.data?.role}. Berlaku setelah user login ulang atau tokennya diperbarui.`);
    setActionPassword('');
    await loadData();
  }

  const isSelfAction = Boolean(userAction && user && userAction.id === user.id);
  const targetRole = userAction && adminIds ? (adminIds.includes(userAction.id) ? 'admin' : 'user') : null;

  const activeSubTab = subTab[tab] || 'all';
  const apiSection = subTab['api-keys'] || 'providers';
  const alibabaSection = subTab.alibaba || 'accounts';

  function selectFeature(nextTab, nextChild = null) {
    setTab(nextTab);
    setSearch('');
    if (nextTab === 'api-keys' || nextTab === 'alibaba') {
      setApiTreeOpen(true);
    }
    if (nextChild) {
      setSubTab((cur) => ({ ...cur, [nextTab]: nextChild }));
    }
  }

  function selectSubFeature(targetTab, childId) {
    setTab(targetTab);
    setSearch('');
    setSubTab((cur) => ({ ...cur, [targetTab]: childId }));
  }

  const loadData = useCallback(async () => {
    setLoading(true);
    setErrorMessage('');
    const [profileResult, videoResult, conversationResult, waitlistResult, providerKeyResult, dbModelsResult, walletResult] = await Promise.all([
      supabase.from('profiles').select('id,email,full_name,created_at,status,status_reason').order('created_at', { ascending: false }).limit(500),
      supabase.from('video_generations').select('id,user_id,provider,model,prompt,aspect_ratio,resolution,duration,status,created_at,updated_at').order('created_at', { ascending: false }).limit(500),
      supabase.from('ai_conversations').select('id,user_id,title,created_at,updated_at').order('updated_at', { ascending: false }).limit(500),
      supabase.from('waitlist_signups').select('id,email,created_at').order('created_at', { ascending: false }).limit(500),
      supabase.from('provider_api_keys').select('provider,label,api_key,base_url,key_version,min_verified_at').order('provider'),
      fetchAdminModels({}),
      supabase.from('credit_wallets').select('user_id,balance').limit(1000),
    ]);
    adminUserRoles()
      .then((res) => setAdminIds(Array.isArray(res?.data?.admin_ids) ? res.data.admin_ids : null))
      .catch(() => setAdminIds(null));
    const errors = [profileResult.error, videoResult.error, conversationResult.error, waitlistResult.error, providerKeyResult.error].filter(Boolean);
    if (errors.length) {
      console.error('Admin data load failed:', errors);
      setErrorMessage('Sebagian data belum bisa dimuat. Pastikan akunmu memiliki role admin lalu coba lagi.');
    } else {
      setProfiles(profileResult.data ?? []);
      setVideos(videoResult.data ?? []);
      setConversations(conversationResult.data ?? []);
      setWaitlist(waitlistResult.data ?? []);
      setWallets(Object.fromEntries((walletResult.data ?? []).map((row) => [row.user_id, Number(row.balance ?? 0)])));
      const keys = providerKeyResult.data ?? [];
      setProviderKeys(keys);
      setBaseUrlDrafts((prev) => {
        const next = { ...prev };
        for (const item of keys) {
          if (next[item.provider] === undefined) {
            next[item.provider] = item.base_url || PROVIDER_PRESETS[item.provider]?.baseUrl || '';
          }
        }
        return next;
      });
      setCatalogProvider((prev) => {
        if (prev && keys.some((item) => item.provider === prev)) return prev;
        return keys[0]?.provider || '';
      });
      setNewCustomModel((prev) => {
        if (prev.provider && keys.some((item) => item.provider === prev.provider)) return prev;
        return { ...prev, provider: keys[0]?.provider || '' };
      });
      if (Array.isArray(dbModelsResult?.models)) {
        setCustomModels(dbModelsResult.models);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const loadCatalogModels = useCallback(async (targetProvider = catalogProvider) => {
    if (!targetProvider) {
      setUnoModels([]);
      setModelsLoaded(false);
      setModelNotice({ type: 'error', text: 'Belum ada provider terdaftar. Tambahkan provider terlebih dahulu.' });
      return;
    }
    setModelBusy('load');
    setModelNotice({ type: 'info', text: `Memuat daftar model dari ${PROVIDER_PRESETS[targetProvider]?.label || targetProvider}...` });
    const [catalog, dbModels] = await Promise.all([
      fetchCatalog({ provider: targetProvider }),
      fetchAdminModels({}),
      supabase.from('credit_wallets').select('user_id,balance').limit(1000),
    ]);
    const allDbModels = dbModels.models || [];
    setCustomModels(allDbModels);

    const activeMap = new Map(
      allDbModels
        .filter((m) => m.provider === targetProvider && m.active)
        .map((m) => [m.id, true]),
    );
    if (Array.isArray(catalog.models)) {
      const merged = catalog.models.map((model) => ({ ...model, active: activeMap.has(model.id) }));
      for (const m of allDbModels.filter((row) => row.provider === targetProvider)) {
        if (!merged.some((item) => item.id === m.id)) {
          merged.push({ id: m.id, provider: targetProvider, category: 'Other', tags: [], active: m.active, isFree: m.id.endsWith(':free') });
        }
      }
      setUnoModels(merged);
      setModelsLoaded(true);
      setModelNotice({
        type: 'success',
        text: `${merged.length} model tersedia. Pilih model aktif (hijau), lalu simpan.`,
      });
    } else {
      const msg = catalog.status === 401
        ? 'Sesi kamu expired — login lagi untuk memuat daftar model.'
        : catalog.error || `Pemuatan daftar model gagal (HTTP ${catalog.status ?? '—'}). Coba lagi.`;
      setModelNotice({ type: 'error', text: msg });
    }
    setModelBusy('');
  }, [catalogProvider]);

  const profileById = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const query = search.trim().toLowerCase();

  const filteredProfiles = useMemo(() => (
    profiles.filter((profile) => {
      if (subTab.users === 'recent' && !isWithinDays(profile.created_at, 7)) return false;
      return `${profile.email || ''} ${profile.full_name || ''}`.toLowerCase().includes(query);
    })
  ), [profiles, subTab.users, query]);

  const filteredVideos = useMemo(() => (
    videos.filter((video) => {
      if (subTab.videos === 'completed' && video.status !== 'completed') return false;
      if (subTab.videos === 'failed' && video.status !== 'failed') return false;
      if (subTab.videos === 'processing' && video.status !== 'queued' && video.status !== 'in_progress') return false;
      return `${video.model} ${video.provider} ${video.prompt || ''} ${profileById.get(video.user_id)?.email || ''}`.toLowerCase().includes(query);
    })
  ), [videos, subTab.videos, profileById, query]);

  const filteredConversations = useMemo(() => (
    conversations.filter((item) => {
      if (subTab.conversations === 'recent' && !isWithinDays(item.updated_at || item.created_at, 7)) return false;
      return `${item.title} ${profileById.get(item.user_id)?.email || ''}`.toLowerCase().includes(query);
    })
  ), [conversations, subTab.conversations, profileById, query]);

  const filteredWaitlist = useMemo(() => (
    waitlist.filter((entry) => {
      if (subTab.waitlist === 'recent' && !isWithinDays(entry.created_at, 7)) return false;
      return entry.email.toLowerCase().includes(query);
    })
  ), [waitlist, subTab.waitlist, query]);

  async function deleteRecord() {
    if (!deleteTarget) return;
    setDeleting(true);

    if (deleteTarget.kind === 'all-providers') {
      const [modelsRes, keysRes] = await Promise.all([
        supabase.from('provider_models').delete().neq('provider', ''),
        supabase.from('provider_api_keys').delete().neq('provider', ''),
      ]);
      if (modelsRes.error || keysRes.error) {
        console.error('Remove all providers failed:', modelsRes.error || keysRes.error);
        setErrorMessage('Gagal menghapus semua provider. Pastikan akunmu memiliki role admin.');
      } else {
        setUnoModels([]);
        setCustomModels([]);
        setModelsLoaded(false);
        setModelNotice(null);
        setKeyDrafts({});
        setBaseUrlDrafts({});
        setKeyNotices({});
        setDeleteTarget(null);
        await loadData();
      }
      setDeleting(false);
      return;
    }

    const table = deleteTarget.kind === 'video'
      ? 'video_generations'
      : deleteTarget.kind === 'conversation'
        ? 'ai_conversations'
        : 'waitlist_signups';
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

  async function loadQuota(providerId) {
    const id = String(providerId || '').trim().toLowerCase();
    if (!id) return;
    setQuotaBusy(id);
    setQuotas((cur) => ({ ...cur, [id]: { ...(cur[id] || {}), state: 'loading' } }));
    try {
      const res = await fetchProviderQuota(id);
      const data = res.data || {};
      if (!res.ok) setQuotas((cur) => ({ ...cur, [id]: { state: 'error', error: data.error || `HTTP ${res.status}` } }));
      else if (data.supported === false) setQuotas((cur) => ({ ...cur, [id]: { state: 'unsupported', message: data.message, consoleUrl: data.consoleUrl } }));
      else if (data.ok === false) setQuotas((cur) => ({ ...cur, [id]: { state: 'error', error: data.error || 'Kuota gagal dimuat.' } }));
      else if (data.available === false) setQuotas((cur) => ({ ...cur, [id]: { state: 'empty', error: data.error || 'Belum ada API key tersimpan.' } }));
      else setQuotas((cur) => ({ ...cur, [id]: { state: 'ready', ...data } }));
    } catch (err) {
      setQuotas((cur) => ({ ...cur, [id]: { state: 'error', error: String(err?.message || err) } }));
    } finally {
      setQuotaBusy('');
    }
  }

  function quotaContent(providerId) {
    const q = quotas[providerId];
    const usd = (value) => (typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—');
    const quotaUsd = (value, perUnit) => (typeof value === 'number' && Number.isFinite(value) ? `$${(value / (perUnit || 500000)).toFixed(2)}` : '—');
    if (!q) return <span>Kuota belum dimuat.</span>;
    if (q.state === 'loading') return <span>Memuat kuota…</span>;
    if (q.state === 'error') return <span className="is-error">Kuota gagal dimuat: {q.error}</span>;
    if (q.state === 'empty') return <span>{q.error}</span>;
    if (q.state === 'unsupported') {
      return <span>{q.message}{q.consoleUrl ? <> <a href={q.consoleUrl} target="_blank" rel="noopener noreferrer">Buka konsol</a></> : null}</span>;
    }
    if (providerId === 'openrouter') {
      return (
        <span>
          Sisa <b>{q.limitRemaining == null ? '∞' : usd(q.limitRemaining)}</b>{q.limit != null && <> dari limit <b>{usd(q.limit)}</b></>}
          {q.limitReset ? <> · reset <b>{q.limitReset}</b></> : null}
          {' · '}terpakai hari ini <b>{usd(q.usageDaily)}</b> · minggu ini <b>{usd(q.usageWeekly)}</b> · bulan ini <b>{usd(q.usageMonthly)}</b>
          {q.freeRequests && q.freeRequests.limit > 0 ? <> · free <b>{q.freeRequests.remaining}/{q.freeRequests.limit}</b> req hari ini</> : null}
        </span>
      );
    }
    if (providerId === 'unorouter' || providerId === 'pekpik') {
      if (q.unlimitedQuota) return <span>Kuota: <b>unlimited</b> · terpakai <b>{quotaUsd(q.used, q.quotaPerUnit)}</b> ({q.name || providerId})</span>;
      return <span>Sisa <b>{quotaUsd(q.available, q.quotaPerUnit)}</b> dari <b>{quotaUsd(q.granted, q.quotaPerUnit)}</b> · terpakai <b>{quotaUsd(q.used, q.quotaPerUnit)}</b>{q.expiresAt ? <> · kedaluwarsa <b>{new Date(q.expiresAt * 1000).toLocaleDateString('id-ID')}</b></> : null}</span>;
    }
    return <span>Kuota tersedia.</span>;
  }

  async function saveProviderKey(providerRow) {
    const provider = providerRow.provider;
    const rawDraft = String(keyDrafts[provider] || '').trim();
    const rawBaseUrl = String(baseUrlDrafts[provider] ?? providerRow.base_url ?? '').trim();
    const urlCheck = validateProviderBaseUrl(rawBaseUrl, provider);
    if (!urlCheck.ok) {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: urlCheck.error } }));
      return;
    }
    const baseUrl = urlCheck.value;
    const apiKey = rawDraft || (provider === 'cloudflare' && (!providerRow.api_key || !baseUrl) ? 'binding:AI' : '');

    if (!apiKey && !providerRow.api_key) {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Masukkan API key terlebih dahulu.' } }));
      return;
    }

    setKeyBusy(`save-${provider}`);
    const payload = {
      provider,
      label: providerRow.label || PROVIDER_PRESETS[provider]?.label || provider,
      base_url: baseUrl,
      updated_at: new Date().toISOString(),
      ...(apiKey ? { api_key: apiKey } : {}),
    };

    const { error } = apiKey
      ? await supabase.from('provider_api_keys').upsert(payload)
      : await supabase.from('provider_api_keys').update({ base_url: baseUrl, updated_at: payload.updated_at }).eq('provider', provider);

    if (error) {
      console.error('Save provider key failed:', error);
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Penyimpanan gagal. Cek permission admin.' } }));
    } else {
      setKeyNotices((current) => ({
        ...current,
        [provider]: {
          type: 'success',
          text: apiKey === 'binding:AI'
            ? 'Cloudflare Workers AI disimpan dalam mode Binding native (env.AI).'
            : (apiKey ? 'API key & Base URL disimpan di Supabase.' : 'Base URL diperbarui.'),
        },
      }));
      setKeyDrafts((current) => ({ ...current, [provider]: '' }));
      await loadData();
    }
    setKeyBusy('');
  }

  async function resetCloudflareBinding() {
    setKeyBusy('save-cloudflare');
    const { error } = await supabase
      .from('provider_api_keys')
      .upsert({
        provider: 'cloudflare',
        label: PROVIDER_PRESETS.cloudflare.label,
        api_key: 'binding:AI',
        base_url: null,
        updated_at: new Date().toISOString(),
      });
    if (error) {
      setKeyNotices((current) => ({ ...current, cloudflare: { type: 'error', text: 'Gagal mereset Cloudflare ke Binding env.AI.' } }));
    } else {
      setKeyDrafts((current) => ({ ...current, cloudflare: '' }));
      setBaseUrlDrafts((current) => ({ ...current, cloudflare: '' }));
      setKeyNotices((current) => ({ ...current, cloudflare: { type: 'success', text: 'Cloudflare Workers AI dikembalikan ke mode Binding native (env.AI).' } }));
      await loadData();
    }
    setKeyBusy('');
  }

  async function verifyProviderKey(providerRow) {
    const provider = providerRow.provider;
    const rawBaseUrl = String(baseUrlDrafts[provider] ?? providerRow.base_url ?? '').trim();
    const urlCheck = validateProviderBaseUrl(rawBaseUrl, provider);
    if (!urlCheck.ok) {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: urlCheck.error } }));
      return;
    }
    const baseUrl = urlCheck.value || '';
    const apiKey = String(
      keyDrafts[provider]
      || providerRow.api_key
      || (provider === 'cloudflare' ? 'binding:AI' : ''),
    ).trim();
    if (!apiKey) {
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Masukkan API key terlebih dahulu.' } }));
      return;
    }
    setKeyBusy(`verify-${provider}`);
    setKeyNotices((current) => ({ ...current, [provider]: { type: 'info', text: `Memverifikasi ke ${providerRow.label || provider}...` } }));
    const { data, status } = await verifyKey({ provider, apiKey, baseUrl });
    if (data?.ok) {
      const msg = data.verifiedVia === 'binding'
        ? `Valid — Workers AI Binding (env.AI) aktif (${data.modelsCount ?? 0} model gratis siap dipakai).`
        : data.verifiedVia === 'cloudflare_rest'
          ? `Valid — Cloudflare Workers AI REST API terhubung (${data.modelsCount ?? 0} model gratis). Simpan untuk mengaktifkan.`
          : data.verifiedVia === 'chat'
            ? 'Valid — key dapat digunakan (verifikasi via endpoint chat). Simpan untuk mengaktifkan.'
            : `Valid — ${data.modelsCount ?? 0} model terdeteksi. Simpan untuk mengaktifkan.`;
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'success', text: msg } }));
    } else {
      setKeyNotices((current) => ({
        ...current,
        [provider]: {
          type: 'error',
          text: status === 401
            ? 'Sesi expired — login lagi sebelum verifikasi key.'
            : data?.error || `Verifikasi gagal (HTTP ${status ?? '—'}). Periksa key dan Base URL.`,
        },
      }));
    }
    setKeyBusy('');
  }

  function toggleUnoModel(modelId) {
    setUnoModels((current) => current.map((model) => (model.id === modelId ? { ...model, active: !model.active } : model)));
  }

  async function saveUnoModels() {
    if (!catalogProvider) return;
    const active = unoModels.filter((model) => model.active).map((model) => model.id);
    setModelBusy('save');
    const { data, status } = await saveProviderModels({ provider: catalogProvider, models: active });
    if (data?.ok) {
      setModelNotice({ type: 'success', text: `${data.activeCount} model aktif untuk ${catalogProvider} disimpan.` });
      await loadData();
    } else {
      const msg = status === 401
        ? 'Sesi expired — login lagi sebelum menyimpan pilihan model.'
        : data?.error || `Penyimpanan model gagal (HTTP ${status ?? '—'}). Cek permission admin.`;
      setModelNotice({ type: 'error', text: msg });
    }
    setModelBusy('');
  }

  async function addCustomVideoModel(e) {
    e.preventDefault();
    const provider = String(newCustomModel.provider || '').trim().toLowerCase();
    const model = String(newCustomModel.model || '').trim();
    if (!provider || !model) return;
    setModelBusy('add-custom');
    const { data } = await saveSingleProviderModel({ provider, model, active: true });
    if (data?.ok) {
      setNewCustomModel((cur) => ({ ...cur, model: '' }));
      setModelNotice({ type: 'success', text: `Model "${model}" diaktifkan untuk provider "${provider}".` });
      await loadData();
    } else {
      setModelNotice({ type: 'error', text: data?.error || 'Gagal menyimpan model.' });
    }
    setModelBusy('');
  }

  async function toggleCustomModel(item) {
    setModelBusy(`toggle-${item.provider}-${item.id}`);
    const { data } = await saveSingleProviderModel({ provider: item.provider, model: item.id, active: !item.active });
    if (data?.ok) {
      setCustomModels((cur) => cur.map((m) => (m.provider === item.provider && m.id === item.id ? { ...m, active: !item.active } : m)));
    }
    setModelBusy('');
  }

  async function addProvider(presetOverride = null) {
    const src = presetOverride || newProvider;
    const provider = String(src.id || src.provider || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const label = String(src.label || '').trim();
    const rawBaseUrl = String(src.baseUrl || src.base_url || '').trim();
    if (!provider || !label) return;
    const urlCheck = validateProviderBaseUrl(rawBaseUrl, provider);
    if (!urlCheck.ok) {
      setKeyNotices((current) => ({ ...current, [`add:${newProvider.provider}`]: { type: 'error', text: urlCheck.error } }));
      return;
    }
    const base_url = urlCheck.value;
    setKeyBusy('add');
    const { error } = await supabase
      .from('provider_api_keys')
      .insert({ provider, label, api_key: provider === 'cloudflare' ? 'binding:AI' : '', base_url });
    if (error) {
      console.error('Add provider failed:', error);
      setKeyNotices((current) => ({ ...current, [`add:${provider}`]: { type: 'error', text: 'Provider mungkin sudah ada atau tidak valid.' } }));
    } else {
      setNewProvider({ provider: '', label: '', base_url: '' });
      await loadData();
      setSubTab((cur) => ({ ...cur, 'api-keys': 'providers' }));
    }
    setKeyBusy('');
  }

  async function removeProvider(provider) {
    setKeyBusy(`delete-${provider}`);
    await supabase.from('provider_models').delete().eq('provider', provider);
    const { error } = await supabase.from('provider_api_keys').delete().eq('provider', provider);
    if (error) {
      console.error('Remove provider failed:', error);
      setKeyNotices((current) => ({ ...current, [provider]: { type: 'error', text: 'Penghapusan gagal.' } }));
    } else {
      if (catalogProvider === provider) {
        setUnoModels([]);
        setModelsLoaded(false);
        setModelNotice(null);
      }
      await loadData();
    }
    setKeyBusy('');
  }

  useEffect(() => {
    for (const item of providerKeys) {
      if (item.api_key && item.api_key !== 'binding:AI' && quotas[item.provider] === undefined) {
        loadQuota(item.provider);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKeys]);

  const displayedProviderRows = providerKeys;

  const navCounts = {
    users: profiles.length,
    videos: videos.length,
    conversations: conversations.length,
    waitlist: waitlist.length,
    'api-keys': providerKeys.length,
  };

  const subCounts = {
    alibaba: {},
    'api-keys': {
      providers: providerKeys.length,
      catalog: unoModels.filter((m) => m.active).length,
      manual: customModels.length,
    },
    videos: {
      processing: videos.filter((v) => v.status === 'queued' || v.status === 'in_progress').length,
      completed: videos.filter((v) => v.status === 'completed').length,
      failed: videos.filter((v) => v.status === 'failed').length,
    },
  };

  const activeNavItem = NAV_GROUPS.flatMap((g) => g.items).find((item) => item.id === tab);
  const activeChildItem = activeNavItem?.children?.find((c) => c.id === activeSubTab);

  const activeRows = tab === 'users'
    ? filteredProfiles
    : tab === 'videos'
      ? filteredVideos
      : tab === 'conversations'
        ? filteredConversations
        : filteredWaitlist;

  return (
    <DropXLayout
      title="Admin Panel"
      description="Kelola pengguna, generasi video, percakapan, waitlist, dan API key multi-provider."
    >
      <main className="admin-main">
        <div className="admin-content">
          <div className="admin-heading">
            <div>
              <div className="admin-breadcrumb-bar" aria-label="Breadcrumb navigasi admin">
                <span>Admin Panel</span>
                <span className="admin-breadcrumb-sep">/</span>
                <span>{activeNavItem?.label}</span>
                {activeChildItem && (
                  <>
                    <span className="admin-breadcrumb-sep">/</span>
                    <strong>{activeChildItem.label}</strong>
                  </>
                )}
              </div>
              <span className="admin-eyebrow"><i /> ADMINISTRATOR</span>
              <h1>
                {tab === 'overview'
                  ? 'Pusat kendali.'
                  : tab === 'users'
                    ? 'Pengguna.'
                    : tab === 'videos'
                      ? 'Generasi video.'
                      : tab === 'conversations'
                        ? 'Percakapan.'
                        : tab === 'api-keys'
                          ? (activeChildItem?.label || 'API Key.')
                          : 'Daftar tunggu.'}
              </h1>
              <p>
                {tab === 'overview'
                  ? 'Kelola pengguna, generasi video, dan konektor API BLEA AI dalam navigasi terstruktur.'
                  : tab === 'users'
                    ? 'Akun yang sudah terdaftar di BLEA AI.'
                    : tab === 'videos'
                      ? 'Pantau dan kelola riwayat generasi video dari seluruh pengguna.'
                      : tab === 'conversations'
                        ? 'Lihat ringkasan percakapan tersimpan; isi pesan tetap privat bagi pemilik akun.'
                        : tab === 'api-keys'
                          ? 'Kelola provider API key, katalog model, dan model manual dalam sub-navigasi terpisah.'
                          : 'Email yang meminta akses awal BLEA AI.'}
              </p>
            </div>
            <div className="admin-heading-meta">
              <span><Clock3 size={13} /> {new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}</span>
              <span className="admin-user-chip"><i>{(user?.user_metadata?.full_name || user?.email || 'A').slice(0, 1).toUpperCase()}</i>{user?.email}</span>
            </div>
          </div>

          {errorMessage && (
            <div className="admin-error" role="alert">
              <span>{errorMessage}</span>
              <button type="button" onClick={loadData}>Coba lagi</button>
            </div>
          )}

          <div className="admin-workspace">
            <aside className="admin-subnav" aria-label="Navigasi Admin">
              {NAV_GROUPS.map((group) => (
                <div className="admin-subnav-group" key={group.label}>
                  <span className="admin-subnav-label">{group.label}</span>
                  {group.items.map(({ id, label, icon: Icon, children }) => {
                    const isActive = tab === id;
                    const isApiNode = id === 'api-keys' || id === 'alibaba';
                    const showChildren = isApiNode ? (isActive || apiTreeOpen) : isActive;
                    return (
                      <div className="admin-subnav-node" key={id}>
                        <button
                          type="button"
                          className={`admin-subnav-item ${isActive ? 'is-active' : ''}`}
                          onClick={() => {
                            if (isApiNode && isActive) {
                              setApiTreeOpen((v) => !v);
                            } else {
                              selectFeature(id);
                            }
                          }}
                          aria-expanded={children?.length ? showChildren : undefined}
                        >
                          <Icon size={15} className="icon" />
                          <span className="label">{label}</span>
                          {navCounts[id] !== undefined && (
                            <span className="admin-subnav-count">{navCounts[id]}</span>
                          )}
                          {children?.length > 0 && (
                            <ChevronDown className={`admin-subnav-chevron ${showChildren ? 'is-open' : ''}`} />
                          )}
                        </button>

                        {children?.length > 0 && showChildren && (
                          <div className="admin-subnav-children">
                            {children.map((child) => {
                              const childActive = isActive && activeSubTab === child.id;
                              const childCount = subCounts[id]?.[child.id];
                              return (
                                <button
                                  key={child.id}
                                  type="button"
                                  className={`admin-subnav-child ${childActive ? 'is-active' : ''}`}
                                  onClick={() => selectSubFeature(id, child.id)}
                                >
                                  <span>{child.label}</span>
                                  {childCount !== undefined && <small>{childCount}</small>}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </aside>

            <div className="admin-panel-body">
              {activeNavItem?.children?.length > 0 && (
                <div className="admin-inner-nav" aria-label={`Sub-navigasi ${activeNavItem.label}`}>
                  <div className="admin-inner-pills">
                    {activeNavItem.children.map((child) => {
                      const childCount = subCounts[tab]?.[child.id];
                      return (
                        <button
                          key={child.id}
                          type="button"
                          className={`admin-inner-pill ${activeSubTab === child.id ? 'is-active' : ''}`}
                          onClick={() => selectSubFeature(tab, child.id)}
                        >
                          <span>{child.label}</span>
                          {childCount !== undefined && <small>{childCount}</small>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {tab === 'overview' && (
                <>
                  {(activeSubTab === 'all' || activeSubTab === 'metrics') && (
                    <section className="admin-metrics">
                      <article><span className="metric-icon metric-purple"><Users size={17} /></span><span className="metric-label">PENGGUNA</span><b>{loading ? '—' : profiles.length}</b><small>Akun terdaftar</small></article>
                      <article><span className="metric-icon metric-blue"><Clapperboard size={17} /></span><span className="metric-label">GENERASI VIDEO</span><b>{loading ? '—' : videos.length}</b><small>Di semua workspace</small></article>
                      <article><span className="metric-icon metric-peach"><Mail size={17} /></span><span className="metric-label">WAITLIST</span><b>{loading ? '—' : waitlist.length}</b><small>Pendaftar akses awal</small></article>
                      <article><span className="metric-icon metric-green"><MessagesSquare size={17} /></span><span className="metric-label">PERCAKAPAN</span><b>{loading ? '—' : conversations.length}</b><small>Riwayat tersimpan</small></article>
                    </section>
                  )}

                  {(activeSubTab === 'all' || activeSubTab === 'activity') && (
                    <section className="admin-overview-grid">
                      <article className="admin-overview-card">
                        <div className="admin-card-heading">
                          <div><span className="admin-eyebrow">AKTIVITAS TERBARU</span><h2>Pengguna terbaru</h2></div>
                          <button type="button" onClick={() => selectFeature('users', 'all')}>Semua <ArrowUpRight size={13} /></button>
                        </div>
                        {loading ? <div className="admin-skeleton" /> : profiles.slice(0, 5).map((profile) => (
                          <div className="admin-activity-row" key={profile.id}>
                            <span className="admin-avatar">{(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}</span>
                            <span className="admin-row-main"><b>{profile.full_name || 'Nama belum diatur'}</b><small>{profile.email || '—'}</small></span>
                            <small className="admin-row-date">{formatDate(profile.created_at)}</small>
                          </div>
                        ))}
                        {!loading && profiles.length === 0 && <div className="admin-empty-inline">Belum ada pengguna terdaftar.</div>}
                      </article>

                      <article className="admin-overview-card">
                        <div className="admin-card-heading">
                          <div><span className="admin-eyebrow">KONTEN TERBARU</span><h2>Video terbaru</h2></div>
                          <button type="button" onClick={() => selectFeature('videos', 'all')}>Semua <ArrowUpRight size={13} /></button>
                        </div>
                        {loading ? <div className="admin-skeleton" /> : videos.slice(0, 5).map((video) => (
                          <div className="admin-activity-row" key={video.id}>
                            <span className="admin-project-icon"><Video size={14} /></span>
                            <span className="admin-row-main">
                              <b>{video.prompt || video.model}</b>
                              <small>{video.model} · {profileById.get(video.user_id)?.email || 'Akun tidak ditemukan'}</small>
                            </span>
                            <small className="admin-row-date">{VIDEO_STATUS_LABEL[video.status] || video.status}</small>
                          </div>
                        ))}
                        {!loading && videos.length === 0 && <div className="admin-empty-inline">Belum ada generasi video.</div>}
                      </article>
                    </section>
                  )}

                  {(activeSubTab === 'all' || activeSubTab === 'metrics') && (
                    <section className="admin-note">
                      <ShieldCheck size={16} />
                      <div><b>Akses admin terlindungi.</b><p>Panel ini dan operasi datanya diproteksi oleh role <code>app_metadata</code> serta Row Level Security di Supabase.</p></div>
                      <span>RLS ACTIVE</span>
                    </section>
                  )}
                </>
              )}

              {tab === 'api-keys' && apiSection === 'providers' && (
                <section className="admin-api-card">
                  <div className="admin-api-heading">
                    <div><span className="admin-eyebrow">MULTI-PROVIDER GATEWAY</span><h2>Provider &amp; API Key</h2></div>
                    <div className="admin-api-heading-actions">
                      <span className="admin-api-badge"><Zap size={13} /> Server-side · Worker</span>
                      {displayedProviderRows.length > 0 && (
                        <button
                          type="button"
                          className="admin-api-danger-btn"
                          onClick={() => setDeleteTarget({
                            kind: 'all-providers',
                            label: `Semua ${displayedProviderRows.length} provider dan model terkait`,
                          })}
                        >
                          <Trash2 size={13} /> Hapus semua provider
                        </button>
                      )}
                    </div>
                  </div>
                  <p className="admin-api-note">
                    Kelola API key dan endpoint Base URL untuk setiap provider. Kunci disimpan di Supabase dan hanya dibaca oleh Cloudflare Worker di server.
                  </p>

                  {loading ? (
                    <div className="admin-skeleton" />
                  ) : displayedProviderRows.length === 0 ? (
                    <div className="admin-api-empty">
                      <b>Belum ada provider terdaftar.</b>
                      <p>Semua provider saat ini sudah kosong. Tambahkan provider baru seperti PEKPIK, OpenRouter, UnoRouter, OpenAI, atau gateway kustom.</p>
                      <button
                        type="button"
                        className="admin-api-save"
                        onClick={() => selectSubFeature('api-keys', 'add-provider')}
                      >
                        <Plus size={14} /> Tambah Provider
                      </button>
                    </div>
                  ) : (
                    displayedProviderRows.map((provider) => (
                      <div className="admin-api-row" key={provider.provider}>
                        <div className="admin-api-row-top">
                          <div>
                            <span className="admin-api-name">{provider.label || provider.provider}</span>
                            <small>{provider.provider}</small>
                          </div>
                          <span className={`admin-api-state ${provider.api_key ? '' : 'is-empty'}`}>
                            {provider.provider === 'cloudflare' && provider.api_key === 'binding:AI'
                              ? 'Workers AI Binding (env.AI)'
                              : (provider.api_key ? 'Terhubung' : 'Belum terhubung')}
                          </span>
                        </div>

                        <div className="admin-api-quota" role="status">
                          <Gauge size={13} aria-hidden="true" />
                          {quotaContent(provider.provider)}
                          <button
                            type="button"
                            className="admin-api-quota-refresh"
                            onClick={() => loadQuota(provider.provider)}
                            disabled={quotaBusy === provider.provider}
                            aria-label={`Muat ulang kuota ${provider.provider}`}
                          >
                            <RefreshCw size={11} aria-hidden="true" /> {quotaBusy === provider.provider ? 'Memuat…' : 'Muat ulang'}
                          </button>
                        </div>

                        <div className="admin-api-input-row">
                          <Globe size={14} />
                          <input
                            type="text"
                            inputMode="url"
                            name={`cfg-endpoint-${provider.provider}`}
                            autoComplete="off"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            data-lpignore="true"
                            data-1p-ignore="true"
                            data-bwignore="true"
                            data-form-type="other"
                            value={baseUrlDrafts[provider.provider] ?? provider.base_url ?? ''}
                            onChange={(event) => setBaseUrlDrafts((cur) => ({ ...cur, [provider.provider]: event.target.value }))}
                            placeholder={
                              provider.provider === 'cloudflare'
                                ? 'Opsional untuk REST API: https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1'
                                : provider.provider === 'alibaba'
                                  ? 'Wajib: https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com'
                                  : (PROVIDER_PRESETS[provider.provider]?.baseUrl || 'https://api.provider.com/v1')
                            }
                            aria-label={`Base URL ${provider.provider}`}
                          />
                        </div>
                        {provider.provider === 'alibaba' && (
                          <p className="admin-api-help" role="note">
                            Base URL wajib diisi: <code>https://{'{WorkspaceId}'}.ap-southeast-1.maas.aliyuncs.com</code> (Model Studio → Workspace, region ap-southeast-1 / Singapura). API key dibuat di Model Studio → API Key. Model: <b>wan3.0-video</b>. Video hasil Wan berlaku 24 jam di server Alibaba.
                          </p>
                        )}

                        <div className="admin-api-input-row">
                          <LockKeyhole size={14} />
                          <div className="admin-secret-wrap">
                            <input
                              type="text"
                              name={`cfg-secret-${provider.provider}`}
                              className={revealedKeys[provider.provider] ? '' : 'admin-secret-input'}
                              autoComplete="off"
                              spellCheck={false}
                              autoCapitalize="off"
                              autoCorrect="off"
                              data-lpignore="true"
                              data-1p-ignore="true"
                              data-bwignore="true"
                              data-form-type="other"
                              value={keyDrafts[provider.provider] || ''}
                              onChange={(current) => setKeyDrafts((prev) => ({ ...prev, [provider.provider]: current.target.value }))}
                              placeholder={
                                provider.provider === 'cloudflare'
                                  ? (provider.api_key === 'binding:AI'
                                    ? 'Aktif via Binding env.AI (kosongkan, atau tempel API Token Cloudflare)...'
                                    : 'Kosongkan untuk Binding env.AI, atau masukkan Cloudflare API Token...')
                                  : (provider.api_key ? 'Ganti API key...' : 'Masukkan API key...')
                              }
                              aria-label={`API key ${provider.provider}`}
                            />
                            <button
                              type="button"
                              className="admin-secret-toggle"
                              onClick={() => setRevealedKeys((cur) => ({ ...cur, [provider.provider]: !cur[provider.provider] }))}
                              aria-label={revealedKeys[provider.provider] ? 'Sembunyikan API key' : 'Tampilkan API key'}
                            >
                              {revealedKeys[provider.provider] ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>
                          <div className="admin-api-actions">
                            <button
                              type="button"
                              className="admin-api-verify"
                              onClick={() => verifyProviderKey(provider)}
                              disabled={keyBusy === `verify-${provider.provider}`}
                            >
                              <Check size={14} /> Verifikasi
                            </button>
                            <button
                              type="button"
                              className="admin-api-save"
                              onClick={() => saveProviderKey(provider)}
                              disabled={keyBusy === `save-${provider.provider}`}
                            >
                              Simpan
                            </button>
                            {provider.provider === 'cloudflare' && (provider.api_key !== 'binding:AI' || provider.base_url) && (
                              <button
                                type="button"
                                className="admin-api-verify"
                                onClick={resetCloudflareBinding}
                                disabled={keyBusy === 'save-cloudflare'}
                              >
                                Pakai Binding env.AI
                              </button>
                            )}
                            <button
                              type="button"
                              className="admin-api-remove"
                              onClick={() => removeProvider(provider.provider)}
                              disabled={keyBusy === `delete-${provider.provider}`}
                              aria-label={`Hapus ${provider.provider}`}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        {keyNotices[provider.provider] && (
                          <div className={`admin-api-notice is-${keyNotices[provider.provider].type}`}>{keyNotices[provider.provider].text}</div>
                        )}
                      </div>
                    ))
                  )}
                </section>
              )}

              {tab === 'api-keys' && apiSection === 'catalog' && (
                <section className="admin-api-card">
                  <div className="admin-api-heading">
                    <div><span className="admin-eyebrow">KATALOG MODEL · CHAT &amp; VIDEO</span><h2>Aktifkan model katalog</h2></div>
                    <span className="admin-api-badge"><Zap size={13} /> Gratis &amp; Berbayar</span>
                  </div>
                  <p className="admin-api-note">
                    Muat katalog model langsung dari provider yang sudah ditambahkan, pilih model aktif (hijau), lalu simpan.
                  </p>
                  {displayedProviderRows.length === 0 ? (
                    <div className="admin-api-empty">
                      <b>Belum ada provider untuk dimuat.</b>
                      <p>Tambahkan provider beserta API key terlebih dahulu sebelum memuat katalog model.</p>
                      <button
                        type="button"
                        className="admin-api-save"
                        onClick={() => selectSubFeature('api-keys', 'add-provider')}
                      >
                        <Plus size={14} /> Tambah Provider
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="admin-model-toolbar">
                        <select
                          value={catalogProvider}
                          onChange={(e) => {
                            const next = e.target.value;
                            setCatalogProvider(next);
                            loadCatalogModels(next);
                          }}
                          aria-label="Pilih katalog provider"
                        >
                          {displayedProviderRows.map((p) => (
                            <option key={p.provider} value={p.provider}>Katalog {p.label || p.provider}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="admin-api-verify"
                          onClick={() => loadCatalogModels(catalogProvider)}
                          disabled={modelBusy === 'load' || !catalogProvider}
                        >
                          {modelBusy === 'load' ? 'Memuat...' : 'Muat daftar model'}
                        </button>
                        <small>{unoModels.filter((model) => model.active).length} model aktif · {unoModels.length} tersedia</small>
                      </div>

                      {modelNotice && <div className={`admin-api-notice is-${modelNotice.type}`}>{modelNotice.text}</div>}

                      {modelsLoaded && unoModels.length > 0 && (
                        <>
                          <div className="admin-model-filters">
                            {['All', 'Video', 'Text', 'Image', 'Embedding', 'Speech', 'Other'].map((cat) => (
                              <button
                                key={cat}
                                type="button"
                                className={`admin-model-chip ${modelFilter === cat ? 'is-active' : ''}`}
                                onClick={() => setModelFilter(cat)}
                              >
                                {cat}
                              </button>
                            ))}
                            <input
                              className="admin-model-search"
                              value={modelQuery}
                              onChange={(event) => setModelQuery(event.target.value)}
                              placeholder="Cari model..."
                            />
                          </div>
                          <div className="admin-model-list" style={{ maxHeight: 380, overflowY: 'auto' }}>
                            {unoModels
                              .filter((model) => (modelFilter === 'All' || model.category === modelFilter) && model.id.toLowerCase().includes(modelQuery.toLowerCase()))
                              .map((model) => (
                                <div className="admin-model-row" key={`${model.provider || catalogProvider}-${model.id}`}>
                                  <span className="admin-model-info">
                                    <span className="admin-model-name">
                                      {model.id}
                                      {model.priceLabel && (
                                        <span className={`admin-model-badge ${model.isFree ? 'is-free' : 'is-paid'}`}>
                                          {model.priceLabel}
                                        </span>
                                      )}
                                      {model.online === false && <span className="admin-model-badge">Sibuk</span>}
                                    </span>
                                    <span className="admin-model-tags">
                                      {model.category}
                                      {model.tags?.length ? ' · ' + model.tags.slice(0, 3).join(' · ') : ''}
                                    </span>
                                  </span>
                                  <button
                                    type="button"
                                    className={`admin-model-toggle ${model.active ? 'is-active' : 'is-off'}`}
                                    onClick={() => toggleUnoModel(model.id)}
                                    aria-pressed={model.active}
                                  >
                                    <span className="admin-model-dot" />
                                    {model.active ? 'Active' : 'OFF'}
                                  </button>
                                </div>
                              ))}
                          </div>
                          <div className="admin-api-input-row" style={{ marginTop: 12 }}>
                            <button type="button" className="admin-api-save" onClick={saveUnoModels} disabled={modelBusy === 'save'}>
                              {modelBusy === 'save' ? 'Menyimpan...' : `Simpan pilihan model (${catalogProvider})`}
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </section>
              )}

              {tab === 'api-keys' && apiSection === 'manual' && (
                <section className="admin-api-card">
                  <div className="admin-api-heading">
                    <div><span className="admin-eyebrow">MODEL KUSTOM · CHAT &amp; VIDEO</span><h2>Tambah model manual</h2></div>
                  </div>
                  <p className="admin-api-note">
                    Aktifkan ID model Chat atau Video spesifik untuk provider mana pun (misal <code>gemini-2.5-flash</code> / <code>gpt-5.5</code> di PEKPIK, <code>google/veo-3.1</code> di OpenRouter, atau <code>sora-2</code> di OpenAI).
                  </p>
                  {displayedProviderRows.length === 0 ? (
                    <div className="admin-api-empty">
                      <b>Belum ada provider aktif.</b>
                      <p>Tambahkan provider terlebih dahulu sebelum mendaftarkan ID model manual.</p>
                      <button
                        type="button"
                        className="admin-api-save"
                        onClick={() => selectSubFeature('api-keys', 'add-provider')}
                      >
                        <Plus size={14} /> Tambah Provider
                      </button>
                    </div>
                  ) : (
                    <>
                      <form className="admin-api-input-row" onSubmit={addCustomVideoModel}>
                        <select
                          value={newCustomModel.provider}
                          onChange={(e) => setNewCustomModel((cur) => ({ ...cur, provider: e.target.value }))}
                          aria-label="Provider untuk model kustom"
                        >
                          {displayedProviderRows.map((p) => (
                            <option key={p.provider} value={p.provider}>{p.label || p.provider} ({p.provider})</option>
                          ))}
                        </select>
                        <input
                          value={newCustomModel.model}
                          onChange={(e) => setNewCustomModel((cur) => ({ ...cur, model: e.target.value }))}
                          placeholder="ID model (misal: gemini-2.5-flash atau google/veo-3.1)"
                        />
                        <button type="submit" className="admin-api-save" disabled={modelBusy === 'add-custom' || !newCustomModel.model.trim()}>
                          <Plus size={14} /> Tambah model
                        </button>
                      </form>
                      {modelNotice && <div className={`admin-api-notice is-${modelNotice.type}`}>{modelNotice.text}</div>}
                      {customModels.length > 0 && (
                        <div className="admin-model-list" style={{ marginTop: 12 }}>
                          {customModels.map((item) => (
                            <div className="admin-model-row" key={`${item.provider}-${item.id}`}>
                              <span className="admin-model-info">
                                <span className="admin-model-name">
                                  {item.id}
                                  <span className="admin-model-badge">{item.provider}</span>
                                </span>
                              </span>
                              <button
                                type="button"
                                className={`admin-model-toggle ${item.active ? 'is-active' : 'is-off'}`}
                                onClick={() => toggleCustomModel(item)}
                                disabled={modelBusy === `toggle-${item.provider}-${item.id}`}
                              >
                                <span className="admin-model-dot" />
                                {item.active ? 'Active' : 'OFF'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              {tab === 'alibaba' && <AlibabaCloudPanel subTab={alibabaSection} />}

              {tab === 'api-keys' && apiSection === 'add-provider' && (
                <section className="admin-api-card">
                  <div className="admin-api-heading">
                    <div><span className="admin-eyebrow">TAMBAH PROVIDER</span><h2>Provider baru</h2></div>
                  </div>
                  <p className="admin-api-note">
                    Pilih preset cepat di bawah atau tambahkan gateway OpenAI/Video API kustom dengan ID, nama tampilan, dan Base URL.
                  </p>
                  <div className="admin-api-presets">
                    {QUICK_PROVIDER_PRESETS.filter((preset) => !displayedProviderRows.some((r) => r.provider === preset.id)).map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        className="admin-model-chip"
                        onClick={() => addProvider(preset)}
                        disabled={keyBusy === 'add'}
                      >
                        + {preset.label}
                      </button>
                    ))}
                  </div>
                  <div className="admin-api-input-row">
                    <input
                      value={newProvider.provider}
                      onChange={(event) => setNewProvider((current) => ({ ...current, provider: event.target.value }))}
                      placeholder="id provider (contoh: custom-video)"
                    />
                    <input
                      value={newProvider.label}
                      onChange={(event) => setNewProvider((current) => ({ ...current, label: event.target.value }))}
                      placeholder="Nama tampilan"
                    />
                    <input
                      type="url"
                      value={newProvider.base_url}
                      onChange={(event) => setNewProvider((current) => ({ ...current, base_url: event.target.value }))}
                      placeholder="Base URL (contoh: https://api.provider.com/v1)"
                    />
                    <button
                      type="button"
                      className="admin-api-save"
                      onClick={() => addProvider()}
                      disabled={keyBusy === 'add' || !newProvider.provider.trim() || !newProvider.label.trim()}
                    >
                      <Plus size={14} /> Tambah provider
                    </button>
                  </div>
                  {keyNotices[`add:${newProvider.provider}`] && (
                    <div className={`admin-api-notice is-${keyNotices[`add:${newProvider.provider}`].type}`}>
                      {keyNotices[`add:${newProvider.provider}`].text}
                    </div>
                  )}
                </section>
              )}

              {tab !== 'overview' && tab !== 'api-keys' && tab !== 'alibaba' && (
                <section className="admin-table-card">
                  <div className="admin-table-toolbar">
                    <label className="admin-search">
                      <Search size={15} />
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={
                          tab === 'users'
                            ? 'Cari nama atau email...'
                            : tab === 'videos'
                              ? 'Cari model, prompt, atau pemilik...'
                              : tab === 'conversations'
                                ? 'Cari percakapan atau pemilik...'
                                : 'Cari email waitlist...'
                        }
                      />
                    </label>
                    {tab === 'waitlist' && (
                      <button type="button" className="admin-export-button" onClick={exportWaitlist} disabled={!waitlist.length}>
                        <ArrowDownToLine size={14} /> Ekspor CSV
                      </button>
                    )}
                    <button type="button" className="admin-refresh-button" onClick={loadData} disabled={loading}>
                      <LoaderCircle size={14} className={loading ? 'spinning' : ''} /> Muat ulang
                    </button>
                  </div>
                  <div className="admin-table-scroll">
                    <table>
                      <thead>
                        <tr>
                          {tab === 'users' ? (
                            <><th>PENGGUNA</th><th>ID AKUN</th><th>BERGABUNG</th><th>SALDO</th><th>STATUS</th><th>PEROAN</th><th></th></>
                          ) : tab === 'videos' ? (
                            <><th>MODEL &amp; PROMPT</th><th>SPESIFIKASI</th><th>PEMILIK</th><th>STATUS</th><th></th></>
                          ) : tab === 'conversations' ? (
                            <><th>JUDUL</th><th>PEMILIK</th><th>DIPERBARUI</th><th></th></>
                          ) : (
                            <><th>EMAIL</th><th>MENDAFTAR</th><th></th></>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {loading ? (
                          <tr><td colSpan={tab === 'users' ? 7 : tab === 'videos' ? 5 : tab === 'conversations' ? 4 : 3} className="admin-table-message">Memuat data...</td></tr>
                        ) : tab === 'users' ? (
                          filteredProfiles.map((profile) => (
                            <tr key={profile.id}>
                              <td>
                                <span className="admin-user-cell">
                                  <i className="admin-avatar">{(profile.full_name || profile.email || '?').slice(0, 1).toUpperCase()}</i>
                                  <span><b>{profile.full_name || 'Nama belum diatur'}</b><small>{profile.email || '—'}</small></span>
                                </span>
                              </td>
                              <td className="admin-id-cell">{profile.id.slice(0, 8)}…</td>
                              <td>{formatDate(profile.created_at)}</td>
                              <td>{wallets[profile.id] ?? 0} kredit</td>
                              <td><span className={`admin-status-pill status-${profile.status || 'active'}`}><i /> {USER_STATUS_LABEL[profile.status || 'active']}</span></td>
                              <td><span className={`admin-role-pill${adminIds === null ? '' : adminIds.includes(profile.id) ? ' is-admin' : ' is-user'}`}>{adminIds === null ? '—' : adminIds.includes(profile.id) ? 'Admin' : 'User'}</span></td>
                              <td><button type="button" className="admin-refresh-button" onClick={() => openUserAction(profile)}>Kelola</button></td>
                            </tr>
                          ))
                        ) : tab === 'videos' ? (
                          filteredVideos.map((video) => (
                            <tr key={video.id}>
                              <td>
                                <span className="admin-project-cell">
                                  <b>{video.model} ({video.provider})</b>
                                  <small>{video.prompt || '(Tanpa prompt teks)'}</small>
                                </span>
                              </td>
                              <td>{video.aspect_ratio} · {video.resolution} · {video.duration}s</td>
                              <td>{profileById.get(video.user_id)?.email || '—'}</td>
                              <td>{VIDEO_STATUS_LABEL[video.status] || video.status}</td>
                              <td>
                                <button
                                  type="button"
                                  className="admin-delete-icon"
                                  aria-label={`Hapus generasi ${video.model}`}
                                  onClick={() => setDeleteTarget({ kind: 'video', id: video.id, label: video.prompt || video.model })}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : tab === 'conversations' ? (
                          filteredConversations.map((conversation) => (
                            <tr key={conversation.id}>
                              <td>
                                <span className="admin-project-cell">
                                  <b>{conversation.title}</b>
                                  <small>Isi pesan tidak ditampilkan demi privasi</small>
                                </span>
                              </td>
                              <td>{profileById.get(conversation.user_id)?.email || '—'}</td>
                              <td>{formatDate(conversation.updated_at)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="admin-delete-icon"
                                  aria-label={`Hapus percakapan ${conversation.title}`}
                                  onClick={() => setDeleteTarget({ kind: 'conversation', id: conversation.id, label: conversation.title })}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                          ))
                        ) : (
                          filteredWaitlist.map((entry) => (
                            <tr key={entry.id}>
                              <td><b className="admin-email-cell">{entry.email}</b></td>
                              <td>{formatDate(entry.created_at)}</td>
                              <td>
                                <button
                                  type="button"
                                  className="admin-delete-icon"
                                  aria-label={`Hapus ${entry.email} dari waitlist`}
                                  onClick={() => setDeleteTarget({ kind: 'waitlist', id: entry.id, label: entry.email })}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                        {!loading && activeRows.length === 0 && (
                          <tr><td colSpan={tab === 'users' ? 7 : tab === 'videos' ? 5 : tab === 'conversations' ? 4 : 3} className="admin-table-message">{query ? 'Tidak ada hasil yang cocok.' : 'Belum ada data.'}</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="admin-table-footer">
                    <span>
                      Menampilkan {activeRows.length} dari {tab === 'users' ? profiles.length : tab === 'videos' ? videos.length : tab === 'conversations' ? conversations.length : waitlist.length} data (maks. 500)
                    </span>
                    <span>Perubahan tersimpan langsung</span>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      </main>

      {userAction && (
        <div className="admin-modal-backdrop">
          <section className="admin-delete-modal admin-user-modal" role="dialog" aria-modal="true" aria-labelledby="admin-user-title">
            <button type="button" className="admin-modal-close" onClick={() => setUserAction(null)} aria-label="Tutup"><X size={16} /></button>
            <h2 id="admin-user-title">Kelola pengguna</h2>
            <p className="admin-user-meta"><b>{userAction.full_name || 'Nama belum diatur'}</b>{isSelfAction && <span className="admin-self-tag">akun Anda</span>}<br />{userAction.email || '—'} · Saldo <b>{wallets[userAction.id] ?? 0} kredit</b> · <b>{USER_STATUS_LABEL[userAction.status || 'active']}</b> · Peran <b>{targetRole === null ? '—' : targetRole === 'admin' ? 'Admin' : 'User'}</b></p>
            {isSelfAction && <div className="admin-notice is-self" role="status"><span>Ini akun Anda sendiri. Hanya <b>Saldo kredit</b> yang bisa diubah dari sini; status, peran, dan penghapusan wajib dilakukan admin lain.</span></div>}

            <label className="admin-field admin-field-tight"><span>Password aksi admin (wajib)</span>
              <input type="text" className="admin-secret-input" value={actionPassword} autoComplete="off" inputMode="text" spellCheck={false} onChange={(event) => { setActionPassword(event.target.value); setActionError(''); }} placeholder="Password yang Anda setel di Supabase" />
            </label>
            {actionError && <div className="admin-error" role="alert"><span>{actionError}</span></div>}
            {actionNotice && <div className="admin-notice" role="status"><span>{actionNotice}</span></div>}

            <fieldset disabled={Boolean(actionBusy)}>
              <legend>Saldo kredit</legend>
              <div className="admin-user-row is-narrow-first">
                <label className="admin-field admin-field-tight"><span>Jumlah kredit</span>
                  <input type="number" min={1} max={1000000} step={1} value={actionDelta} onChange={(event) => setActionDelta(event.target.value)} />
                </label>
                <label className="admin-field admin-field-tight"><span>Catatan (masuk ke ledger)</span>
                  <input type="text" maxLength={200} value={actionDescription} onChange={(event) => setActionDescription(event.target.value)} placeholder="Contoh: kompensasi gangguan layanan" />
                </label>
              </div>
              <div className="admin-modal-actions">
                <button type="button" className="admin-refresh-button" disabled={Boolean(actionBusy) || !(Number(actionDelta) > 0)} onClick={() => runUserAction('credits', { delta: Number(actionDelta), description: actionDescription })}>{actionBusy === 'credits_add' ? 'Memproses…' : 'Tambah saldo'}</button>
                <button type="button" className="admin-cancel-button" disabled={Boolean(actionBusy) || !(Number(actionDelta) > 0)} onClick={() => runUserAction('credits', { delta: -Number(actionDelta), description: actionDescription })}>Kurangi saldo</button>
              </div>
            </fieldset>

            <fieldset disabled={Boolean(actionBusy) || isSelfAction || targetRole === null}>
              <legend>Peran akun</legend>
              <div className="admin-user-row is-narrow-first">
                <label className="admin-field admin-field-tight"><span>Peran</span>
                  <select value={actionRole} onChange={(event) => setActionRole(event.target.value)}>
                    <option value="user">User (akses standar)</option>
                    <option value="admin">Admin (panel /admin penuh)</option>
                  </select>
                </label>
              </div>
              <div className="admin-modal-actions">
                <button type="button" className="admin-refresh-button" disabled={Boolean(actionBusy) || isSelfAction || targetRole === null || actionRole === targetRole} onClick={() => runUserAction('role', { role: actionRole })}>{actionBusy === 'role' ? 'Memproses…' : actionRole === 'admin' ? 'Jadikan admin' : 'Jadikan user'}</button>
              </div>
              <p className="admin-hint is-compact">Perubahan tercatat di jejak audit dan diverifikasi password aksi admin. Berlaku setelah user login ulang (atau tokennya diperbarui).</p>
            </fieldset>

            <fieldset disabled={Boolean(actionBusy) || isSelfAction}>
              <legend>Status akun</legend>
              <div className="admin-user-row is-narrow-first">
                <label className="admin-field admin-field-tight"><span>Status</span>
                  <select value={actionStatus} onChange={(event) => setActionStatus(event.target.value)}>
                    <option value="active">Aktif</option>
                    <option value="suspended">Suspended (sementara)</option>
                    <option value="banned">Banned (permanen)</option>
                  </select>
                </label>
                <label className="admin-field admin-field-tight"><span>Alasan (opsional, jejak audit)</span>
                  <input type="text" maxLength={300} value={actionReason} onChange={(event) => setActionReason(event.target.value)} />
                </label>
              </div>
              <div className="admin-modal-actions">
                <button type="button" className="admin-refresh-button" disabled={Boolean(actionBusy)} onClick={() => runUserAction('status', { status: actionStatus, reason: actionReason || null })}>Simpan status</button>
              </div>
              <p className="admin-hint is-compact">Suspended/banned menutup seluruh akses API (chat, gambar, video, riwayat). Berlaku maks. 30 detik (cache gerbang).</p>
            </fieldset>

            <fieldset disabled={Boolean(actionBusy) || isSelfAction} className="admin-danger-zone">
              <legend>Hapus akun permanen</legend>
              <div className="admin-user-row admin-user-row-danger">
                <label className="admin-field admin-field-tight"><span>Ketik email konfirmasi: <b>{userAction.email || '—'}</b></span>
                  <input type="email" value={actionConfirmEmail} onChange={(event) => setActionConfirmEmail(event.target.value)} autoComplete="off" />
                </label>
                <button type="button" className="admin-confirm-delete" disabled={Boolean(actionBusy) || actionConfirmEmail.trim().toLowerCase() !== String(userAction.email || '').trim().toLowerCase()} onClick={() => runUserAction('delete', { confirm_email: actionConfirmEmail.trim() })}>{actionBusy === 'delete' ? 'Menghapus…' : 'Hapus akun'}</button>
              </div>
              <p className="admin-hint is-compact">Menghapus akun Supabase beserta profil, dompet, ledger, riwayat, dan percakapan. Tidak dapat dibatalkan.</p>
            </fieldset>
          </section>
        </div>
      )}
      {deleteTarget && (
        <div className="admin-modal-backdrop">
          <section className="admin-delete-modal" role="dialog" aria-modal="true" aria-labelledby="admin-delete-title">
            <button type="button" className="admin-modal-close" onClick={() => setDeleteTarget(null)} aria-label="Tutup"><X size={16} /></button>
            <span className="admin-delete-icon-large"><Trash2 size={19} /></span>
            <h2 id="admin-delete-title">Hapus data ini?</h2>
            <p><b>{deleteTarget.label}</b> akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.</p>
            <div>
              <button type="button" className="admin-cancel-button" onClick={() => setDeleteTarget(null)}>Batal</button>
              <button type="button" className="admin-confirm-delete" onClick={deleteRecord} disabled={deleting}>{deleting ? 'Menghapus...' : 'Ya, hapus'}</button>
            </div>
          </section>
        </div>
      )}
    </DropXLayout>
  );
}
