import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowUpRight,
  BookOpen,
  Briefcase,
  CreditCard,
  FileText,
  FolderKanban,
  GraduationCap,
  Mail,
  MessageSquare,
  MessagesSquare,
  Rocket,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
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

const quickLinks = [
  { title: 'AI Studio', href: '/studio', icon: WandSparkles, color: 'var(--chart-1)', description: 'Chat & ide' },
  { title: 'Proyek', href: '/projects', icon: FolderKanban, color: 'var(--chart-3)', description: 'Karya kamu' },
  { title: 'Pengaturan', href: '/settings', icon: Settings2, color: 'var(--chart-2)', description: 'Akun & profil' },
  { title: 'Admin panel', href: '/admin', icon: ShieldCheck, color: 'var(--chart-5)', description: 'Keseluruhan app' },
  { title: 'Landing', href: '/', icon: Rocket, color: 'var(--chart-4)', description: 'Website publik' },
  { title: 'Documentation', href: '/app', icon: BookOpen, color: 'var(--chart-7)', description: 'Panduan cepat' },
];

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
      projects: 0,
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
    months.push({ key: monthKey(d), label: d.toLocaleDateString('id-ID', { month: 'short' }), users: 0, projects: 0 });
  }
  return months;
}

export function DropXDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState({ users: 0, projects: 0, conversations: 0, waitlist: 0 });
  const [weekly, setWeekly] = useState(() => last7Days());
  const [monthly, setMonthly] = useState(() => last6Months());
  const [recent, setRecent] = useState({ conversations: [], profiles: [], projects: [], waitlist: [] });
  const [messageCounts, setMessageCounts] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [profilesRes, projectsRes, conversationsRes, waitlistRes, messagesRes] = await Promise.all([
        supabase.from('profiles').select('id,email,full_name,created_at').order('created_at', { ascending: false }).limit(500),
        supabase.from('projects').select('id,user_id,name,description,created_at,updated_at').order('created_at', { ascending: false }).limit(500),
        supabase.from('ai_conversations').select('id,user_id,project_id,title,created_at,updated_at').order('updated_at', { ascending: false }).limit(200),
        supabase.from('waitlist_signups').select('id,email,created_at').order('created_at', { ascending: false }).limit(200),
        supabase.from('ai_messages').select('conversation_id,created_at').order('created_at', { ascending: false }).limit(2000),
      ]);
      if (cancelled) return;
      const errors = [profilesRes.error, projectsRes.error, conversationsRes.error, waitlistRes.error, messagesRes.error].filter(Boolean);
      if (errors.length) console.error('Dashboard load failed:', errors);

      const profiles = profilesRes.data ?? [];
      const projects = projectsRes.data ?? [];
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
      projects.forEach((p) => {
        const key = dayKey(new Date(p.created_at));
        if (byDay.has(key)) byDay.get(key).projects += 1;
      });

      const m = last6Months();
      const byMonth = new Map(m.map((d) => [d.key, d]));
      profiles.forEach((p) => {
        const key = monthKey(new Date(p.created_at));
        if (byMonth.has(key)) byMonth.get(key).users += 1;
      });
      projects.forEach((p) => {
        const key = monthKey(new Date(p.created_at));
        if (byMonth.has(key)) byMonth.get(key).projects += 1;
      });

      const counts = {};
      messages.forEach((msg) => {
        counts[msg.conversation_id] = (counts[msg.conversation_id] || 0) + 1;
      });

      const nameByUser = new Map(profiles.map((p) => [p.id, p.full_name || p.email]));
      const nameByProject = new Map(projects.map((p) => [p.id, p.name]));

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
        ...projects.map((p) => ({
          time: p.created_at,
          icon: Briefcase,
          cls: 'is-success',
          text: (
            <>
              <b>Proyek baru:</b> {p.name} dibuat oleh {nameByUser.get(p.user_id) || 'kreator'}
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
        ...waitlist.map((w) => ({
          time: w.created_at,
          icon: Mail,
          cls: 'is-warning',
          text: (
            <>
              <b>Waitlist:</b> {w.email} mendaftar untuk rilis
            </>
          ),
        })),
      ]
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, 6);

      if (cancelled) return;
      setStats({
        users: profiles.length,
        projects: projects.length,
        conversations: conversations.length,
        waitlist: waitlist.length,
      });
      setWeekly(w);
      setMonthly(m);
      setRecent({
        conversations: conversations.slice(0, 6).map((c) => ({
          ...c,
          userName: nameByUser.get(c.user_id),
          projectName: c.project_id ? nameByProject.get(c.project_id) : null,
          messageCount: counts[c.id] || 0,
        })),
        profiles: profiles.slice(0, 5),
        projects: projects.slice(0, 5),
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

  const totalMessages = Object.values(messageCounts).reduce((sum, count) => sum + count, 0);
  const projectProgress = useMemo(() => {
    const max = Math.max(1, ...recent.projects.map((p) => messageCounts[p.id] || 0));
    return recent.projects
      .slice(0, 5)
      .map((p) => ({
        name: p.name,
        progress: Math.round(((messageCounts[p.id] || 0) / max) * 100),
        messages: messageCounts[p.id] || 0,
      }))
      .sort((a, b) => b.progress - a.progress);
  }, [recent.projects, messageCounts]);

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
          <Link to="/projects?new=1" className="dropx-btn dropx-btn-primary dropx-btn-sm">
            <Sparkles size={15} /> Proyek baru
          </Link>
          <Link to="/studio" className="dropx-btn dropx-btn-outline dropx-btn-sm">
            <WandSparkles size={15} /> AI Studio
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
            <span className="dropx-stat-icon" style={{ background: 'rgb(16 185 129 / 0.1)', color: 'var(--success)' }}><Briefcase size={18} className="icon" /></span>
          </div>
          <span className="dropx-stat-title">Proyek Aktif</span>
          <span className="dropx-stat-value">{formatNumber(stats.projects)}</span>
          <span className="dropx-stat-foot">
            <span className="dropx-stat-change is-up">+{stats.projects}</span>
            <span>karya tersimpan</span>
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
              <span className="dropx-quick-icon"><Icon size={20} className="icon" /></span>
              <p>{link.title}</p>
              <small>{link.description}</small>
            </Link>
          );
        })}
      </div>

      {/* Charts: chats per day (area) + users/projects per month (bar) */}
      <div className="dx-grid dx-grid-7">
        <div className="dropx-card dx-col-span-4">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <MessagesSquare size={16} className="icon" style={{ color: 'var(--chart-1)' }} />
              Aktivitas percakapan (7 hari)
            </span>
            <Link to="/studio" className="dropx-card-link">
              Buka AI Studio <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body">
            <div style={{ height: 280 }}>
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
              Pengguna &amp; proyek baru
            </span>
            <Link to="/admin" className="dropx-card-link">
              Lihat semua <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body">
            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="label" tick={axisTick} axisLine={false} tickLine={false} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip {...tooltipProps} />
                  <Bar dataKey="users" fill={chartColors.success} radius={[3, 3, 0, 0]} name="Pengguna" />
                  <Bar dataKey="projects" fill={chartColors.violet} radius={[3, 3, 0, 0]} name="Proyek" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>

      {/* Project progress + recent conversations */}
      <div className="dx-grid dx-grid-2">
        <div className="dropx-card">
          <div className="dropx-card-header">
            <span className="dropx-card-title">
              <Briefcase size={16} className="icon" style={{ color: 'var(--chart-7)' }} />
              Progres proyek
            </span>
            <Link to="/projects" className="dropx-card-link">
              Lihat semua <ArrowUpRight size={13} />
            </Link>
          </div>
          <div className="dropx-card-body dx-space-y-4">
            {loading ? (
              <p style={{ fontSize: 13, color: 'var(--muted-foreground)' }}>Memuat...</p>
            ) : projectProgress.length === 0 ? (
              <div className="dropx-empty">
                <FolderKanban className="icon" />
                <h3>Belum ada proyek</h3>
                <p>Buat proyek pertama untuk mulai mencatat progres karyamu.</p>
                <Link to="/projects?new=1" className="dropx-btn dropx-btn-primary dropx-btn-sm">Buat proyek</Link>
              </div>
            ) : (
              projectProgress.map((project) => (
                <div key={project.name}>
                  <div className="dropx-progress-label">
                    <span>{project.name}</span>
                    <span style={{ color: 'var(--muted-foreground)' }}>{project.messages} pesan</span>
                  </div>
                  <div className="dropx-progress-track">
                    <div
                      className="dropx-progress-fill"
                      style={{ width: `${project.progress}%`, '--progress-accent': 'linear-gradient(135deg, var(--chart-1) 0%, var(--chart-2) 100%)' }}
                    />
                  </div>
                </div>
              ))
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
              <div className="dx-space-y-3">
                {recent.conversations.map((conversation) => {
                  const status = conversation.messageCount === 0
                    ? { label: 'Baru', cls: '' }
                    : conversation.messageCount <= 5
                      ? { label: 'Aktif', cls: 'is-info' }
                      : { label: 'Lancar', cls: 'is-success' };
                  return (
                    <div key={conversation.id} className="flex items-center gap-3 py-1.5">
                      <span className="dropx-avatar" style={{ width: 32, height: 32 }}>
                        {(conversation.title || 'C').slice(0, 1).toUpperCase()}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {conversation.title || 'Percakapan tanpa judul'}
                        </p>
                        <p style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
                          {conversation.userName || conversation.user_id} · {conversation.projectName ? `${conversation.projectName}, ` : ''}
                          {new Date(conversation.updated_at || conversation.created_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: 13, fontWeight: 600 }}>{conversation.messageCount}</p>
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
                        <Icon size={14} className="icon" />
                      </span>
                      <div>
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

        <div className="dx-space-y-4 dx-col-span-1">
          <div className="dropx-metric">
            <span className="dropx-metric-icon"><GraduationCap size={20} className="icon" /></span>
            <div>
              <p className="dropx-metric-label">Keterlibatan chat</p>
              <p className="dropx-metric-value">
                {stats.conversations ? Math.round((totalMessages / stats.conversations) * 10) / 10 : 0}
              </p>
            </div>
          </div>
          <div className="dropx-metric">
            <span className="dropx-metric-icon" style={{ background: 'rgb(16 185 129 / 0.1)', color: 'var(--success)' }}><CreditCard size={20} className="icon" /></span>
            <div>
              <p className="dropx-metric-label">Proyek terisi</p>
              <p className="dropx-metric-value">
                {stats.projects ? Math.round((Object.values(messageCounts).filter((c) => c > 0).length / stats.projects) * 100) : 0}%
              </p>
            </div>
          </div>
          <div className="dropx-metric">
            <span className="dropx-metric-icon" style={{ background: 'rgb(59 130 246 / 0.1)', color: 'var(--info)' }}><FileText size={20} className="icon" /></span>
            <div>
              <p className="dropx-metric-label">Pesan total</p>
              <p className="dropx-metric-value">{formatNumber(totalMessages)}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
