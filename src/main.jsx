import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { AuthPage } from './auth/AuthPages';
import { Dashboard } from './auth/Dashboard';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { Brand } from './components/Brand';
import { supabase } from './lib/supabase';
import './auth/auth.css';
import {
  ArrowDown, ArrowRight, ArrowUpRight, AudioLines, Check, ChevronDown,
  CirclePlay, Command, Globe2, Layers3, Menu, MessageCircle,
  Sparkles, WandSparkles, X, Zap
} from 'lucide-react';
import './styles.css';

const navItems = [
  ['Fitur', '#fitur'],
  ['Cara kerja', '#cara-kerja'],
  ['Tentang', '#tentang'],
];

function ProductPreview() {
  return (
    <div className="preview-shell" aria-label="Pratinjau antarmuka BLEA AI">
      <div className="preview-topbar">
        <div className="window-dots"><i /><i /><i /></div>
        <div className="preview-workspace"><span className="workspace-icon"><Sparkles size={12} /></span> Studio kreatif <ChevronDown size={13} /></div>
        <div className="avatar-stack"><span className="avatar avatar-a">A</span><span className="avatar avatar-b">N</span><span className="avatar avatar-c">+2</span></div>
      </div>
      <div className="preview-body">
        <aside className="preview-sidebar">
          <div className="side-section-label">WORKSPACE</div>
          <div className="side-link selected"><Command size={14} /> Overview</div>
          <div className="side-link"><WandSparkles size={14} /> AI Studio</div>
          <div className="side-link"><Layers3 size={14} /> Proyek saya <span className="side-count">4</span></div>
          <div className="side-link"><MessageCircle size={14} /> Asisten</div>
          <div className="side-bottom"><div className="usage-top"><span>Penggunaan AI</span><span>72%</span></div><div className="usage-track"><i /></div><span className="usage-caption">Reset dalam 12 hari</span></div>
        </aside>
        <main className="preview-main">
          <div className="preview-greeting"><div><div className="eyebrow-small">SELASA, 11 NOVEMBER</div><h3>Halo, Alex <span className="wave">✳</span></h3><p>Apa yang ingin kamu ciptakan hari ini?</p></div><button className="new-project"><span>+</span> Proyek baru</button></div>
          <div className="prompt-box"><div className="prompt-label"><span className="pulse-dot" /> BLEA siap membantu</div><p>Buat sesuatu yang <span>luar biasa.</span></p><div className="prompt-bottom"><span className="prompt-hint">Ceritakan ide yang ada di pikiranmu...</span><button aria-label="Kirim prompt"><ArrowRight size={15} /></button></div></div>
          <div className="quick-label">MULAI DARI SINI</div>
          <div className="quick-actions"><div className="quick-card lilac"><span className="quick-icon"><WandSparkles size={15} /></span><div><b>Tulis sesuatu</b><small>Konten yang terasa personal</small></div><ArrowUpRight size={14} /></div><div className="quick-card peach"><span className="quick-icon"><Layers3 size={15} /></span><div><b>Bangun ide</b><small>Dari konsep ke strategi</small></div><ArrowUpRight size={14} /></div></div>
          <div className="recent-head"><span>Aktivitas terbaru</span><span>Lihat semua <ArrowRight size={11} /></span></div>
          <div className="activity-row"><span className="activity-icon"><AudioLines size={14} /></span><span className="activity-title">Brand story — Lumora Studio<small>Diubah 20 menit lalu</small></span><span className="activity-tag">Draft</span><ArrowUpRight size={13} /></div>
        </main>
      </div>
      <div className="floating-note note-one"><span className="note-spark"><Sparkles size={13} /></span><span><b>Ide jadi nyata.</b><small>Dalam hitungan detik</small></span><span className="note-check"><Check size={12} /></span></div>
      <div className="floating-note note-two"><span className="note-avatar">✦</span><span><b>AI yang paham konteks</b><small>Bukan sekadar chatbot</small></span></div>
    </div>
  );
}

function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [joined, setJoined] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signupMessage, setSignupMessage] = useState('');
  const [signupError, setSignupError] = useState(false);

  const handleJoin = async (event) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || submitting) return;

    setSubmitting(true);
    setSignupMessage('');
    setSignupError(false);
    try {
      const { error } = await supabase
        .from('waitlist_signups')
        .insert({ email: normalizedEmail });

      if (error?.code === '23505') {
        setSignupMessage('Email ini sudah terdaftar di daftar tunggu.');
      } else if (error) {
        console.error('Waitlist signup failed:', error);
        setSignupMessage('Pendaftaran belum berhasil. Coba lagi sebentar, ya.');
        setSignupError(true);
      } else {
        setJoined(true);
        setSignupMessage('Berhasil! Email kamu sudah masuk daftar tunggu.');
      }
    } catch (error) {
      console.error('Waitlist signup failed:', error);
      setSignupMessage('Koneksi sedang bermasalah. Coba lagi sebentar, ya.');
      setSignupError(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div id="top" className="site-shell">
      <div className="ambient ambient-top" />
      <header className="header">
        <div className="container nav-wrap"><Brand />
          <nav className={menuOpen ? 'nav-links open' : 'nav-links'} aria-label="Navigasi utama">{navItems.map(([label, href]) => <a key={label} onClick={() => setMenuOpen(false)} href={href}>{label}</a>)}</nav>
          <div className="nav-actions"><a className="login-link" href="/login">Masuk</a><a className="nav-cta" href="/signup">Mulai gratis <ArrowUpRight size={15} /></a></div>
          <button className="menu-toggle" aria-label={menuOpen ? 'Tutup menu' : 'Buka menu'} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
        </div>
      </header>

      <main>
        <section className="hero container">
          <div className="hero-copy">
            <a className="announcement" href="#fitur"><span className="announcement-dot"><Sparkles size={12} /></span><span>Kenalan dengan cara baru berkarya</span><ArrowRight size={13} /></a>
            <h1>Ide besar.<br /><span className="headline-gradient">Eksekusi lebih cepat.</span></h1>
            <p className="hero-description">Ruang kreatif berbasis AI yang membantu kamu berpikir lebih jernih, bergerak lebih cepat, dan menciptakan hal yang berarti.</p>
            <div className="hero-actions"><a className="button-primary" href="/signup">Mulai berkarya gratis <ArrowRight size={16} /></a><a className="button-secondary" href="#cara-kerja"><span className="play-circle"><CirclePlay size={17} /></span> Lihat cara kerja</a></div>
            <div className="social-proof"><div className="proof-avatars"><span>R</span><span>M</span><span>A</span><span>+</span></div><div><div className="proof-stars">★★★★★ <span>4.9/5</span></div><p>Dipercaya para kreator yang berani mulai</p></div></div>
          </div>
          <div className="hero-visual"><div className="visual-glow" /><div className="orbit orbit-one" /><div className="orbit orbit-two" /><ProductPreview /><div className="visual-caption"><span className="caption-line" /> DARI IDE PERTAMA, SAMPAI JADI NYATA</div></div>
          <a className="scroll-cue" href="#fitur"><span>Scroll untuk eksplor</span><ArrowDown size={13} /></a>
        </section>

        <section className="trust-strip container" aria-label="Kompatibilitas"><span className="trust-label">SATU RUANG UNTUK</span><div className="trust-item"><WandSparkles size={16} /> Ide & inspirasi</div><i className="trust-separator" /><div className="trust-item"><AudioLines size={16} /> Kata & cerita</div><i className="trust-separator" /><div className="trust-item"><Layers3 size={16} /> Proyek & rencana</div><i className="trust-separator" /><div className="trust-item"><Globe2 size={16} /> Tim & kolaborasi</div></section>

        <section id="fitur" className="features-section section-pad">
          <div className="container"><div className="section-heading"><span className="eyebrow"><span /> KARYA TANPA BATAS</span><h2>Lebih dari AI.<br /><span>Partner untuk ide-idemu.</span></h2><p>Semua yang kamu butuhkan untuk melewati halaman kosong dan mulai membuat sesuatu yang hebat.</p></div>
            <div className="feature-grid">
              <article className="feature-card feature-large"><div className="feature-copy"><div className="feature-icon purple-icon"><WandSparkles size={18} /></div><span className="feature-number">01 / BERKREASI</span><h3>Mulai dari kosong.<br />Selesai dengan wow.</h3><p>Ubah satu kalimat ide menjadi strategi, tulisan, atau konsep visual. BLEA membantu mengisi ruang antara “bagaimana kalau” dan “ini dia”.</p><a className="text-link" href="#daftar">Jelajahi AI Studio <ArrowRight size={14} /></a></div><div className="creation-visual"><div className="creation-orb"><div className="orb-core"><Sparkles size={22} /></div></div><div className="orbit-label label-top">IDE</div><div className="orbit-label label-right">KREASI</div><div className="orbit-label label-bottom">KAMU + AI</div><div className="spark spark-a">✳</div><div className="spark spark-b">✦</div><div className="spark spark-c">✧</div></div></article>
              <article className="feature-card feature-small"><div className="feature-icon peach-icon"><MessageCircle size={18} /></div><span className="feature-number">02 / BERPIKIR</span><h3>Ngobrol yang<br />punya arah.</h3><p>Asisten yang memahami konteks, bukan hanya menjawab pertanyaan.</p><div className="chat-visual"><span className="chat-bubble user-bubble">Bantu aku pecah ide ini ✨</span><span className="chat-bubble ai-bubble"><span className="tiny-spark">✳</span> Siap. Kita mulai dari bagian paling seru.</span></div></article>
              <article className="feature-card feature-small feature-project"><div className="feature-icon blue-icon"><Layers3 size={18} /></div><span className="feature-number">03 / BERGERAK</span><h3>Satu ide.<br />Banyak langkah maju.</h3><p>Jaga momentum dan rapikan proyekmu di satu ruang yang tenang.</p><div className="task-visual"><div className="task-line done"><i><Check size={9} /></i><span>Temukan arah kreatif</span><b>SELESAI</b></div><div className="task-line active"><i><span /></i><span>Susun konsep utama</span><b>BERJALAN</b></div><div className="task-line"><i /><span>Bagikan dengan tim</span><b>NANTI</b></div></div></article>
            </div>
          </div>
        </section>

        <section id="cara-kerja" className="manifesto-section"><div className="container manifesto-wrap"><div className="manifesto-mark"><span /><span /><span /><span /></div><span className="eyebrow"><span /> CARA KERJA KAMI</span><h2>AI yang bikin kamu<br /><em>lebih jadi kamu.</em></h2><p>Teknologi terbaik bukan yang mengambil alih. Tapi yang membuka ruang agar versi terbaik dari idemu bisa muncul.</p><a href="#tentang" className="manifesto-link">Kenali BLEA <ArrowUpRight size={15} /></a><div className="manifesto-decoration deco-one">✳</div><div className="manifesto-decoration deco-two">✦</div></div></section>

        <section id="tentang" className="cta-section section-pad"><div className="container"><div className="cta-card" id="daftar"><div className="cta-glow" /><div className="cta-content"><span className="eyebrow"><span /> MULAI DARI SINI</span><h2>Punya ide yang<br /><span>nggak sabar dibuat?</span></h2><p>Ruangmu sudah siap. Tinggal kamu dan ide berikutnya.</p><form className="signup-form" onSubmit={handleJoin}><label className="visually-hidden" htmlFor="email">Email kamu</label><input id="email" type="email" autoComplete="email" placeholder="Masukkan email kamu" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={joined} /><button type="submit" disabled={submitting || joined}>{submitting ? 'Mengirim...' : joined ? <>Kamu masuk daftar <Check size={16} /></> : <>Gabung gratis <ArrowRight size={16} /></>}</button></form><span className={`form-note${signupError ? ' form-note-error' : ''}`} role="status" aria-live="polite">{signupMessage || 'Tanpa kartu kredit. Mulai kapan saja.'}</span></div><div className="cta-art"><div className="cta-ring ring-outer" /><div className="cta-ring ring-middle" /><div className="cta-ring ring-inner" /><div className="cta-star">✳</div><div className="cta-mini mini-one"><Sparkles size={13} /></div><div className="cta-mini mini-two"><Zap size={13} /></div><span className="cta-art-caption">IDE KECIL,<br />DAMPAK BESAR.</span></div></div></div></section>
      </main>

      <footer className="footer"><div className="container footer-top"><div><Brand light /><p>Ruang kreatif untuk masa depan yang kamu bayangkan.</p></div><div className="footer-links"><a href="#fitur">Fitur</a><a href="#cara-kerja">Cara kerja</a><a href="#tentang">Tentang kami</a><a href="mailto:halo@blea.ai">Hubungi kami</a></div><a href="#top" className="back-top">Kembali ke atas <ArrowUpRight size={14} /></a></div><div className="container footer-bottom"><span>© 2026 BLEA AI. Dibuat untuk ide-ide besar.</span><div><a href="#privasi">Privasi</a><a href="#ketentuan">Ketentuan</a><span className="footer-status"><i /> Semua sistem beroperasi</span></div></div></footer>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/app" element={<Dashboard />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(<App />);
