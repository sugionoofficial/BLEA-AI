import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowUpRight,
  Clapperboard,
  FileText,
  Film,
  GraduationCap,
  Mail,
  MessageSquare,
  MessagesSquare,
  Rocket,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  WandSparkles,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../auth/AuthProvider';

const chartColors = {
  primary: 'var(--chart-1)',
  violet: 'var(--chart-2)',
  success: 'var(--chart-3)',
  warning: 'var(--chart-4)',
  pink: 'var(--chart-5)',
  danger: 'var(--chart-6)',
  info: 'var(--chart-7)',
  muted: 'var(--chart-muted)',
};

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 11 };

const tooltipProps = {
  contentStyle: {
    backgroundColor: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    boxShadow: 'var(--shadow-dropdown)',
    fontSize: '12px',
    padding: '8px 10px',
    color: 'var(--foreground)',
  },
  labelStyle: { color: 'var(--foreground)', fontWeight: 600, marginBottom: 2 },
  cursor: { fill: 'var(--muted)', fillOpacity: 0.5, stroke: 'var(--border)' },
};

const baseQuickLinks = [
  { title: 'Chat AI', href: '/studio', icon: MessageSquare, color: 'var(--chart-1)', description: 'Chat & ide' },
  { title: 'Generate', href: '/generate', icon: Clapperboard, color: 'var(--chart-3)', description: 'Generate video AI' },
  { title: 'Setting', href: '/settings', icon: Settings2, color: 'var(--chart-2)', description: 'Akun & profil' },
  { title: 'Beranda', href: '/', icon: Rocket, color: 'var(--chart-4)', description: 'Website publik' },
];

const adminQuickLink = {
  title: 'Admin Panel',
  href: '/admin',
  icon: ShieldCheck,
  color: 'var(--chart-5)',
  description: 'Kelola aplikasi',
};

const VIDEO_STATUS_BADGE = {
  completed: { label: 'Selesai', cls: 'is-success' },
  in_progress: { label: 'Diproses', cls: 'is-info' },
  queued: { label: 'Antrean', cls: '' },
  failed: { label: 'Gagal', cls: 'is-danger' },
};

function formatNumber(value) {
  return (value ?? 0).toLocaleString('id-ID');
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function last7Days() {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = dayKey(d);
    days.push({
      key,
      label: d.toLocaleDateString('id-ID', { weekday: 'short' }).slice(0, 3),
      chats: 0,
      messages: 0,
      users: 0,
      videos: 0,
    });
  }
  return days;
}

function monthKey(date) {
  return date.toISOString().slice(0, 7);
}

function last6Months() {
  const months = [];
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    months.push({ key: monthKey(d), label: d.toLocaleDateString('id-ID', { month: 'short' }), users: 0, videos: 0 });
  }
  return months;
}

export function DropXDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ users: 0, videos: 0, completedVideos: 0, conversations: 0, waitlist: 0 });
  const [weekly, setWeekly] = useState(() => last7Days());
  const [monthly, setMonthly] = useState(() => last6Months());
  const [recent, setRecent] = useState({ conversations: [], profiles: [], videos: [], waitlist: [], feed: [] });
  const [messageCounts, setMessageCounts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [profilesRes, videosRes, conversationsRes, waitlistRes, messagesRes] = await Promise.all([
        supabase.from('profiles').select('id,email,full_name,created_at').order('created_at', { ascending: false }).limit(500),
        supabase.from('video_generations').select('id,user_id,provider,model,prompt,aspect_ratio,resolution,duration,status,created_at,updated_at').order('created_at', { ascending: false }).limit(500),
        supabase.from('ai_conversations').select('id,user_id,title,created_at,updated_at').order('updated_at', { ascending: false }).limit(200),
        supabase.from('waitlist_signups').select('id,email,created_at').order('created_at', { ascending: false }).limit(200),
        supabase.from('ai_messages').select('conversation_id,created_at').order('created_at', { ascending: false }).limit(2000),
      ]);
      if (cancelled) return;
      const errors = [profilesRes.error, videosRes.error, conversationsRes.error, waitlistRes.error, messagesRes.error].filter(Boolean);
      if (errors.length) console.error('Dashboard load failed:', errors);

      const profiles = profilesRes.data ?? [];
      const videos = videosRes.data ?? [];
      const conversations = conversationsRes.data ?? [];
      const waitlist = waitlistRes.data ?? [];
      const messages = messagesRes.data ?? [];

      const w = last7Days();
      const byDay = new Map(w.map((d) => [d.key, d]));
      conversations.forEach((c) => {
        const key = dayKey(new Date(c.created_at));
        if (byDay.has(key)) byDay.get(key).chats += 1;
      });
      messages.forEach((m) => {
        const key = dayKey(new Date(m.created_at));
        if (byDay.has(key)) byDay.get(key).messages += 1;
      });
      profiles.forEach((p) => {
        const key = dayKey(new Date(p.created_at));
        if (byDay.has(key)) byDay.get(key).users += 1;
      });
      videos.forEach((v) => {
        const key = dayKey(new Date(v.created_at));
        if (byDay.has(key)) byDay.get(key).videos += 1;
      });

      const m = last6Months();
      const byMonth = new Map(m.map((d) => [d.key, d]));
      profiles.forEach((p) => {
        const key = monthKey(new Date(p.created_at));
        if (byMonth.has(key)) byMonth.get(key).users += 1;
      });
      videos.forEach((v) => {
        const key = monthKey(new Date(v.created_at));
        if (byMonth.has(key)) byMonth.get(key).videos += 1;
      });

      const counts = {};
      messages.forEach((msg) => {
        counts[msg.conversation_id] = (counts[msg.conversation_id] || 0) + 1;
      });

      const nameByUser = new Map(profiles.map((p) => [p.id, p.full_name || p.email]));

      const feed = [
        ...profiles.map((p) => ({
          time: p.created_at,
          icon: Users,
          cls: 'is-info',
          text: (
            <>
              <b>Pengguna baru:</b> {p.full_name || p.email} mendaftar
            </>
          ),
        })),
        ...videos.map((v) => ({
          time: v.created_at,
          icon: Video,
          cls: 'is-success',
          text: (
            <>
              <b>Generate video:</b> {v.model} oleh {nameByUser.get(v.user_id) || 'kreator'}
            </>
          ),
        })),
        ...conversations.map((c) => ({
          time: c.created_at,
          icon: MessageSquare,
          cls: '',
          text: (
            <>
              <b>Percakapan baru:</b> “{c.title || 'Untitled chat'}” dibuka
            </>
          ),
        })),
        ...waitlist.map((wl) => ({
          time: wl.created_at,
          icon: Mail,
          cls: 'is-warning',
          text: (
            <>
              <b>Waitlist:</b> {wl.email} mendaftar untuk rilis
            </>
          ),
        })),
      ]
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, 6);

      if (cancelled) return;
      setStats({
        users: profiles.length,
        videos: videos.length,
        completedVideos: videos.filter((v) => v.status === 'completed').length,
        conversations: conversations.length,
        waitlist: waitlist.length,
      });
      setWeekly(w);
      setMonthly(m);
      setRecent({
        conversations: conversations.slice(0, 6).map((c) => ({
          ...c,
          userName: nameByUser.get(c.user_id),
          messageCount: counts[c.id] || 0,
        })),
        profiles: profiles.slice(0, 5),
        videos: videos.slice(0, 5).map((v) => ({
          ...v,
          userName: nameByUser.get(v.user_id),
        })),
        waitlist: waitlist.slice(0, 5),
        feed,
      });
      setMessageCounts(counts);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const firstName = useMemo(() => {
    const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'Kreator';
    return fullName.trim().split(/\s+/)[0];
  }, [user]);
  const isAdmin = user?.app_metadata?.role === 'admin';
  const quickLinks = useMemo(
    () => (isAdmin
      ? [...baseQuickLinks.slice(0, 3), adminQuickLink, ...baseQuickLinks.slice(3)]
      : baseQuickLinks),
    [isAdmin],
  );

  const totalMessages = Object.values(messageCounts).reduce((sum, count) => sum + count, 0);

  return (
    <div className="dx-space-y-6 dropx-fade-in">
      {/* Welcome header */}
      <div className="dropx-page-header">
        <div>
          <nav className="dropx-breadcrumb">
            <span>App</span>
            <span>/</span>
            <b>Dashboard</b>
          </nav>
          <div className="dropx-page-title">
            <h1>Selamat datang kembali, {firstName} 👋</h1>
            <p>Ikhtisar aktivitas di ruang kerja BLEA AI kamu.</p>
          </div>
        </div>
        <div className="dropx-page-actions">
          <Link to="/generate" className="dropx-btn dropx-btn-primary dropx-btn-sm">
            <Clapperboard size={15} /> Generate Video
          </Link>
          <Link to="/studio" className="dropx-btn dropx-btn-outline dropx-btn-sm">
            <MessageSquare size={15} /> Chat AI
          </Link>
        </div>
      </div>

      {/* Overview stats */}
      <div className="dropx-stagger dx-grid dx-grid-4">
        <div className="dropx-stat">
          <div className="dropx-stat-top">
            <span className="dropx-stat-icon"><Users size={18} className="icon" /></span>
          </div>
          <span className="dropx-stat-title">Total Pengguna</span>
          <span className="dropx-stat-value">{formatNumber(stats.users)}</span>
          <span className="dropx-stat-foot">
            <span className="dropx-stat-change is-up">+{stats.users}</span>
            <span>daftar total</span>
          </span>
        </div>
        <div className="dropx-stat">
          <div className="dropx-stat-top">
            <span className="dropx-stat-icon" style={{ background: 'rgb(16 185 129 / 0.1)', color: 'var(--success)' }}><Clapperboard size={18} className="icon" /></span>
          </div>
          <span className="dropx-stat-title">Video Dihasilkan</span>
          <span className="dropx-stat-value">{formatNumber(stats.videos)}</span>
          <span className="dropx-stat-foot">
            <span className="dropx-stat-change is-up">{stats.completedVideos} selesai</span>
            <span>generasi video</span>
          </span>
        </div>
        <div className="dropx-stat">
          <div className="dropx-stat-top">
            <span className="dropx-stat-icon" style={{ background: 'rgb(139 92 246 / 0.1)', color: 'var(--purple)' }}><MessagesSquare size={18} className="icon" /></span>
          </div>
          <span className="dropx-stat-title">Percakapan</span>
          <span className="dropx-stat-value">{formatNumber(stats.conversations)}</span>
          <span className="dropx-stat-foot">
            <span className="dropx-stat-change is-up">{totalMessages} pesan</span>
            <span>di seluruh chat</span>
          </span>
        </div>
        <div className="dropx-stat">
          <div className="dropx-stat-top">
            <span className="dropx-stat-icon" style={{ background: 'rgb(245 158 11 / 0.1)', color: 'var(--warning)' }}><Mail size={18} className="icon" /></span>
          </div>
          <span className="dropx-stat-title">Waitlist</span>
          <span className="dropx-stat-value">{formatNumber(stats.waitlist)}</span>
          <span className="dropx-stat-foot">
            <span className="dropx-stat-change is-up">+{stats.waitlist}</span>
            <span>pendaftar waiting list</span>
          </span>
        </div>
      </div>

      {/* Quick links */}
      <div className="dropx-quick-grid">
        {quickLinks.map((link) => {
          const Icon = link.icon;
          return (
            <Link key={link.title} to={link.href} className="dropx-quick-card" style={{ '--quick-color': link.color }}>
              <span className="dropx-quick-icon"><Icon size={17} className="icon" /></span>
              <span className="dropx-quick-copy">
                <p>{link.title}</p>
                <small>{link.description}</small>
              </span>
            </Link>
          );
        })}
      </div>

      {/* Charts: chats per day (area) + users/videos per month (bar) */}
      <div className="dx-grid dx-grid-7">
        <div className="dropx-card dx-col-span-4">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <MessagesSquare size={16} className="icon" style={{ color: 'var(--chart-1)' }} />
              Aktivitas percakapan (7 hari)
            </span>
            <Link to="/studio" className="dropx-card-link">
              Buka Chat AI <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body">
            <div className="dropx-chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={weekly}>
                  <defs>
                    <linearGradient id="gChatsHub" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={chartColors.primary} stopOpacity={0.2} />
                      <stop offset="95%" stopColor={chartColors.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip {...tooltipProps} />
                  <Area type="monotone" dataKey="chats" stroke={chartColors.primary} fill="url(#gChatsHub)" strokeWidth={2} name="Percakapan" />
                  <Area type="monotone" dataKey="messages" stroke={chartColors.violet} fill="transparent" strokeWidth={2} strokeDasharray="4 4" name="Pesan" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        <div className="dropx-card dx-col-span-3">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <Users size={16} className="icon" style={{ color: 'var(--chart-3)' }} />
              Pengguna &amp; video baru
            </span>
            <Link to={isAdmin ? '/admin' : '/generate'} className="dropx-card-link">
              Lihat semua <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body">
            <div className="dropx-chart-box">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip {...tooltipProps} />
                  <Bar dataKey="users" fill={chartColors.success} radius={[3, 3, 0, 0]} name="Pengguna" />
                  <Bar dataKey="videos" fill={chartColors.violet} radius={[3, 3, 0, 0]} name="Video" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* Recent video generations + recent conversations */}
      <div className="dx-grid dx-grid-2">
        <div className="dropx-card">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <Film size={16} className="icon" style={{ color: 'var(--chart-7)' }} />
              Generasi video terbaru
            </span>
            <Link to="/generate" className="dropx-card-link">
              Buka studio video <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body">
            {loading ? (
              <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>Memuat...</p>
            ) : recent.videos.length === 0 ? (
              <div className="dropx-empty">
                <Clapperboard className="icon" />
                <h3>Belum ada video</h3>
                <p>Mulai buat video pertamamu dari teks, gambar, video, atau audio referensi.</p>
                <Link to="/generate" className="dropx-btn dropx-btn-primary dropx-btn-sm">Generate video</Link>
              </div>
            ) : (
              <div className="dropx-recent-list">
                {recent.videos.map((video) => {
                  const status = VIDEO_STATUS_BADGE[video.status] || { label: video.status, cls: '' };
                  return (
                    <Link
                      key={video.id}
                      to={`/generate?id=${encodeURIComponent(video.id)}`}
                      className="dropx-recent-row"
                    >
                      <span className="dropx-avatar">
                        <Video size={13} />
                      </span>
                      <div className="dropx-recent-main">
                        <p className="dropx-recent-title">
                          {video.prompt || '(Video berbasis media)'}
                        </p>
                        <p className="dropx-recent-sub">
                          {video.model} · {video.aspect_ratio} · {video.resolution} · {video.duration}s
                        </p>
                      </div>
                      <div className="dropx-recent-end">
                        <span className={`dropx-badge ${status.cls}`}>{status.label}</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="dropx-card">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <MessageSquare size={16} className="icon" style={{ color: 'var(--chart-6)' }} />
              Percakapan terbaru
            </span>
            <Link to="/studio" className="dropx-card-link">
              Buka studio <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body">
            {loading ? (
              <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>Memuat...</p>
            ) : recent.conversations.length === 0 ? (
              <div className="dropx-empty">
                <WandSparkles className="icon" />
                <h3>Belum ada percakapan</h3>
                <p>Coba AI Studio untuk mengobrol dengan AI dan menyimpan ide.</p>
                <Link to="/studio" className="dropx-btn dropx-btn-primary dropx-btn-sm">Coba AI Studio</Link>
              </div>
            ) : (
              <div className="dropx-recent-list">
                {recent.conversations.map((conversation) => {
                  const status = conversation.messageCount === 0
                    ? { label: 'Baru', cls: '' }
                    : conversation.messageCount <= 5
                      ? { label: 'Aktif', cls: 'is-info' }
                      : { label: 'Lancar', cls: 'is-success' };
                  return (
                    <div key={conversation.id} className="dropx-recent-row">
                      <span className="dropx-avatar">
                        {(conversation.title || 'C').slice(0, 1).toUpperCase()}
                      </span>
                      <div className="dropx-recent-main">
                        <p className="dropx-recent-title">
                          {conversation.title || 'Percakapan tanpa judul'}
                        </p>
                        <p className="dropx-recent-sub">
                          {conversation.userName || conversation.user_id} · {new Date(conversation.updated_at || conversation.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
                        </p>
                      </div>
                      <div className="dropx-recent-end">
                        <span className="dropx-recent-count">{conversation.messageCount}</span>
                        <span className={`dropx-badge ${status.cls}`}>{status.label}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Activity feed + mini stats */}
      <div className="dx-grid dx-grid-3">
        <div className="dropx-card dx-col-span-2">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <Sparkles size={16} className="icon" style={{ color: 'var(--chart-2)' }} />
              Aktivitas live
            </span>
            <span className="dropx-live">Live</span>
          </div>
          <div className="dropx-card-body">
            {loading ? (
              <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>Memuat...</p>
            ) : (
              <div className="dropx-feed">
                {recent.feed.map((item, i) => {
                  const Icon = item.icon;
                  return (
                    <div className="dropx-feed-item" key={`${item.time}-${i}`}>
                      <span className={`dropx-feed-dot ${item.cls}`}>
                        <Icon size={13} className="icon" />
                      </span>
                      <div className="dropx-feed-body">
                        <p className="dropx-feed-text">{item.text}</p>
                        <p className="dropx-feed-time">
                          {new Date(item.time).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="dropx-metrics-col dx-col-span-1">
          <div className="dropx-metric">
            <span className="dropx-metric-icon"><GraduationCap size={17} className="icon" /></span>
            <div className="dropx-metric-copy">
              <p className="dropx-metric-label">Keterlibatan chat</p>
              <p className="dropx-metric-value">
                {stats.conversations ? Math.round((totalMessages / stats.conversations) * 10) / 10 : 0}
              </p>
            </div>
          </div>
          <div className="dropx-metric">
            <span className="dropx-metric-icon" style={{ background: 'rgb(16 185 129 / 0.1)', color: 'var(--success)' }}><Video size={17} className="icon" /></span>
            <div className="dropx-metric-copy">
              <p className="dropx-metric-label">Sukses video</p>
              <p className="dropx-metric-value">
                {stats.videos ? Math.round((stats.completedVideos / stats.videos) * 100) : 0}%
              </p>
            </div>
          </div>
          <div className="dropx-metric">
            <span className="dropx-metric-icon" style={{ background: 'rgb(59 130 246 / 0.1)', color: 'var(--info)' }}><FileText size={17} className="icon" /></span>
            <div className="dropx-metric-copy">
              <p className="dropx-metric-label">Pesan total</p>
              <p className="dropx-metric-value">{formatNumber(totalMessages)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
