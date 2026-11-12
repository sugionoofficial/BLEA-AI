import { useState } from 'react';
import { Brand } from './Brand';
import { supabase } from '../lib/supabase';
import {
  ArrowDown, ArrowRight, ArrowUpRight, Check, CirclePlay, Command, Cpu,
  FileText, Globe2, Layers3, Menu, MessageCircle, Sparkles, ShieldCheck,
  Upload, WandSparkles, X, Zap,
} from 'lucide-react';

const navItems = [
  ['Karya', '#karya'],
  ['Fitur', '#fitur'],
  ['Cara kerja', '#cara-kerja'],
  ['Model', '#model'],
];

const heroStats = [
  ['10', 'model AI aktif'],
  ['30MB', 'upload per pesan'],
  ['500', 'pesan tersimpan'],
  ['0', 'kartu kredit'],
];

const stats = [
  ['10', 'Model AI aktif · UnoRouter'],
  ['30MB', 'Batas upload per pesan'],
  ['500', 'Pesan tersimpan per percakapan'],
  ['100%', 'Riwayat privat milik akun'],
];

const works = [
  ['Konten', 'Artikel blog pribadi · 3 bab · 1.200 kata', 'No. 024', 'purple', FileText],
  ['Strategi', 'Rencana konten 30 hari · 5 tema utama', 'No. 023', 'blue', Layers3],
  ['Konsep', 'Naskah video 60s · storyboard lengkap', 'No. 022', 'teal', WandSparkles],
  ['Branding', 'Positioning brand · nada suara unik', 'No. 021', 'peach', Sparkles],
  ['Rencana', 'Pecah proyek besar · 7 langkah nyata', 'No. 020', 'pink', Command],
  ['Ide', 'Ide nama produk · 10 opsi bedah', 'No. 019', 'indigo', MessageCircle],
];

const disciplines = [
  ['01 / AI Studio', 'Chat dengan AI tentang idemu, proyek, atau apa pun. Riwayat tersimpan di akunmu — bukan di cloud yang hilang.', 'Sparkles'],
  ['02 / Proyek', 'Kelompokkan ide dalam proyek. Maju langkah demi langkah, dengan progress yang tetap kamu punya.', 'Layers3'],
  ['03 / Upload', 'Kirim foto, video, atau file — PDF, DOCX, ZIP, sampai 30MB per pesan. AI melihat apa yang kamu kirim.', 'Upload'],
  ['04 / Riwayat', 'Setiap percakapan tersimpan privat. Hanya kamu yang bisa mengakses — enkripsi dari ujung ke ujung.', 'ShieldCheck'],
  ['05 / Model', 'Pilih dari 10 model AI gratis UnoRouter. Ganti model kapan saja — dari opsi, bukan untung.', 'Cpu'],
];

const steps = [
  ['Step 01', 'Tulis idemu', 'Satu pesan bisa disertai foto atau file. Tidak ada setup — langsung kirim.'],
  ['Step 02', 'AI membalas', 'Model gratis UnoRouter menjawab dalam hitungan detik.'],
  ['Step 03', 'Simpan ke proyek', 'Ide tersimpan otomatis. Lanjut kapan saja dari riwayatmu.'],
  ['Step 04', 'Kembangkan', 'Ulangi, perbaiki, eksekusi — langkah demi langkah, di ruangmu sendiri.'],
];

const models = [
  'gpt-oss-120b',
  'deepseek-v4.1-flash',
  'glm-5.2',
  'gpt-5.4',
  'gpt-5.5',
  'minimax-m2.7',
  'gemini-3.5-flash-lite',
  'nemotron-3-ultra-550b',
  'step-3.7-flash',
  'qwen3.5-397b',
];

const testimonials = [
  ['AI Studio membantu saya pecah proyek besar jadi langkah kecil. Riwayat tersimpan — saya selalu bisa kembali ke ide awal.', 'Alex', 'Kreator konten'],
  ['Saya kirim foto produk plus deskripsi, AI membantu buat copy yang personal. Gratis dan cepat.', 'Nisa', 'Pemilik usaha'],
  ['Dari ide kosong jadi rencana konten 30 hari dalam satu malam.', 'Reza', 'Founder'],
];

const journal = [
  ['Gunakan prompt spesifik', 'Beri konteks: audiens, tujuan, nada. Jawaban AI jadi jauh lebih tepat dan personal.', 'Prompt · 11 Nov 2026'],
  ['Simpan ide ke proyek', 'Jangan biarkan ide hilang. Proyek menjaga momentum kreasimu tetap hidup.', 'Proyek · 09 Nov 2026'],
  ['Coba model berbeda', 'Setiap model punya karakter. Ganti model untuk hasil yang berbeda dari yang biasa.', 'Model · 04 Nov 2026'],
];

const iconMap = { Sparkles, Layers3, Upload, ShieldCheck, Cpu, FileText, WandSparkles, Command, MessageCircle, Globe2, Zap };

function StudioPreview() {
  return (
    <div className="briv-preview" aria-label="Pratinjau AI Studio BLEA AI">
      <div className="briv-preview-top">
        <div className="window-dots"><i /><i /><i /></div>
        <span className="briv-preview-title">AI Studio · BLEA AI</span>
        <span className="briv-preview-live"><i /> LIVE</span>
      </div>
      <div className="briv-preview-body">
        <div className="briv-msg user">
          <span className="briv-msg-meta">Kamu · 14:02</span>
          <p>Bantu aku pecah ide peluncuran produk jadi 7 langkah kecil.</p>
        </div>
        <div className="briv-msg ai">
          <span className="briv-msg-meta">BLEA AI · gpt-oss-120b</span>
          <p>Siap. Kita mulai dari bagian paling seru: 1) definisi masalah 2) audiens 3) pesan utama 4) kanal 5) asset 6) timeline 7) target. Mau mulai dari nomor berapa?</p>
        </div>
        <div className="briv-composer"><span>Tanya tentang idemu...</span><i><ArrowRight size={13} /></i></div>
      </div>
    </div>
  );
}

export function LandingPage() {
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
    <div id="top" className="briv-shell">
      <div className="briv-ambient" />
      <header className="briv-header">
        <div className="briv-container briv-nav">
          <Brand />
          <nav className={menuOpen ? 'briv-nav-links open' : 'briv-nav-links'} aria-label="Navigasi utama">{navItems.map(([label, href]) => <a key={label} onClick={() => setMenuOpen(false)} href={href}>{label}</a>)}</nav>
          <div className="briv-nav-actions"><a className="briv-login" href="/login">Masuk</a><a className="briv-cta" href="/signup">Mulai gratis <ArrowUpRight size={14} /></a></div>
          <button className="menu-toggle" aria-label={menuOpen ? 'Tutup menu' : 'Buka menu'} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X /> : <Menu />}</button>
        </div>
      </header>

      <main>
        <section className="briv-hero">
          <div className="briv-container">
            <div className="briv-hero-copy">
              <span className="briv-eyebrow"><span /> RUANG KREATIV · AI · 2026</span>
              <h1>Ide besar.<br /><span className="briv-gradient">Eksekusi lebih cepat.</span></h1>
              <p className="briv-hero-desc">Ruang kreatif berbasis AI yang membantu kamu berpikir lebih jernih, bergerak lebih cepat, dan menciptakan hal yang berarti. Dari ide pertama sampai karya jadi — di satu ruang yang tenang.</p>
              <div className="briv-hero-actions">
                <a className="briv-btn-primary" href="/signup">Mulai berkarya gratis <ArrowRight size={15} /></a>
                <a className="briv-btn-ghost" href="#cara-kerja"><span className="play-circle"><CirclePlay size={16} /></span> Lihat cara kerja</a>
              </div>
              <div className="briv-hero-stats">
                {heroStats.map(([value, label]) => <div key={label} className="briv-hero-stat"><b>{value}</b><span>{label}</span></div>)}
              </div>
            </div>
            <div className="briv-hero-visual"><StudioPreview /><div className="briv-hero-caption"><span className="caption-line" /> DARI IDE PERTAMA, SAMPAI JADI NYATA</div></div>
          </div>
          <a className="briv-scroll" href="#karya"><span>Scroll untuk eksplorasi</span><ArrowDown size={12} /></a>
        </section>

        <section className="briv-stats-strip container">
          {stats.map(([value, label]) => <div key={label} className="briv-stat"><b>{value}</b><span>{label}</span></div>)}
        </section>

        <section id="karya" className="briv-section">
          <div className="briv-container">
            <div className="briv-section-head">
              <span className="briv-eyebrow"><span /> KARYA YANG DIHASILKAN</span>
              <h2>Contoh karya dari<br /><span className="briv-gradient">AI Studio.</span></h2>
              <p>Dari satu pesan, AI membantu kamu menghasilkan konten, strategi, konsep, hingga rencana eksekusi. Inilah yang bisa terjadi di ruangmu.</p>
            </div>
            <div className="briv-work-grid">
              {works.map(([category, title, no, tone, Icon]) => <a key={no} className={`briv-work-card ${tone}`} href="#fitur">
                <span className="briv-work-icon"><Icon size={20} /></span>
                <span className="briv-work-cat">{category}</span>
                <span className="briv-work-title">{title}</span>
                <span className="briv-work-no">{no}</span>
              </a>)}
            </div>
            <div className="briv-work-more"><a href="/signup">Lihat semua contoh karya <ArrowRight size={13} /></a></div>
          </div>
        </section>

        <section id="tentang" className="briv-chapter">
          <div className="briv-container">
            <span className="briv-chapter-mark">CHAPTER 01</span>
            <h2>AI yang bikin kamu<br /><em>lebih jadi kamu.</em></h2>
            <p>BLEA AI dimulai dari satu pengamatan: ide besar sering mati karena tidak ada ruang untuk menghidupkannya. Kami membangun ruang itu — AI Studio yang mendengarkan, mencatat, dan membantu eksekusi. Satu akun, riwayat tersimpan, model gratis tanpa kartu kredit.</p>
            <blockquote>Kami mendengarkan lebih lama dari yang kamu kira. Jawabannya datang lebih cepat dari yang kamu kira.<span>— Tim BLEA AI</span></blockquote>
            <div className="briv-chapter-art">
              <div className="orbit orbit-one" /><div className="orbit orbit-two" />
              <div className="orbit-core"><Sparkles size={20} /></div>
              <span className="orbit-dot a" /><span className="orbit-dot b" />
              <span className="orbit-label">IDE → NYATA</span>
            </div>
          </div>
        </section>

        <section id="fitur" className="briv-section">
          <div className="briv-container">
            <div className="briv-section-head">
              <span className="briv-eyebrow"><span /> APA YANG KAMI LAKUKAN</span>
              <h2>Lima kemampuan.<br /><span className="briv-gradient">Satu ruang.</span></h2>
              <p>Satu ruang untuk berpikir, mencatat, dan eksekusi. Semua di bawah satu akun — tanpa potongan fitur.</p>
            </div>
            <div className="briv-disciplines">
              {disciplines.map(([num, title, desc]) => <div key={num} className="briv-discipline">
                <span className="briv-discipline-num">{num}</span>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>)}
              <div className="briv-discipline-art"><StudioPreview /></div>
            </div>
          </div>
        </section>

        <section id="cara-kerja" className="briv-chapter briv-chapter-alt">
          <div className="briv-container">
            <span className="briv-chapter-mark">HOW WE WORK</span>
            <h2>Dari ide pertama<br />ke karya jadi.</h2>
            <p>Tidak ada setup yang rumit. Tulis, kirim, AI membalas, simpan ke proyek — dan kembangkan lebih lanjut kapan saja.</p>
            <div className="briv-steps">
              {steps.map(([step, title, desc]) => <div key={step} className="briv-step">
                <span className="briv-step-num">{step}</span>
                <h3>{title}</h3>
                <p>{desc}</p>
              </div>)}
            </div>
            <div className="briv-steps-art">
              <div className="briv-steps-card"><span className="briv-steps-card-label">Hari ke-1 · Studio</span><div className="briv-steps-bar"><i /></div><span className="briv-steps-card-cap">AI membalas dalam hitungan detik</span></div>
            </div>
            <a className="briv-btn-primary briv-btn-inline" href="/signup">Coba AI Studio gratis <ArrowRight size={15} /></a>
          </div>
        </section>

        <section id="model" className="briv-section">
          <div className="briv-container">
            <div className="briv-section-head">
              <span className="briv-eyebrow"><span /> STUDIO MODEL</span>
              <h2>Ten model AI gratis.<br /><span className="briv-gradient">Berganti kapan saja.</span></h2>
              <p>Disediakan oleh UnoRouter — model gratis yang aktif 24 jam. Kamu bebas mencoba setiap model; cukup pilih di AI Studio sebelum mengirim pesan.</p>
            </div>
            <div className="briv-model-grid">
              {models.map((model) => <span key={model} className="briv-model-chip"><Cpu size={13} /> {model}</span>)}
            </div>
            <div className="briv-model-note"><ShieldCheck size={13} /> Kunci API dikelola server-side oleh edge function — tidak pernah sampai ke browsermu.</div>
          </div>
        </section>

        <section className="briv-section briv-section-narrow">
          <div className="briv-container">
            <div className="briv-section-head">
              <span className="briv-eyebrow"><span /> KATA KREATOR</span>
              <h2>Dipercaya para kreator<br />yang berani mulai.</h2>
            </div>
            <div className="briv-quotes">
              {testimonials.map(([quote, name, role]) => <figure key={name} className="briv-quote">
                <blockquote>“{quote}”</blockquote>
                <figcaption><b>{name}</b><span>{role}</span></figcaption>
              </figure>)}
            </div>
          </div>
        </section>

        <section className="briv-section briv-section-narrow">
          <div className="briv-container">
            <div className="briv-section-head">
              <span className="briv-eyebrow"><span /> CATATAN DARI STUDIO</span>
              <h2>Tips dari lantai studio.</h2>
              <p>Catatan singkat dari tim BLEA — kadang tentang prompt, kadang tentang proyek, kadang tentang model.</p>
            </div>
            <div className="briv-journal">
              {journal.map(([title, desc, meta]) => <article key={title} className="briv-journal-card">
                <span className="briv-journal-cat">{meta}</span>
                <h3>{title}</h3>
                <p>{desc}</p>
                <a href="#fitur"> Baca catatan <ArrowRight size={12} /></a>
              </article>)}
            </div>
          </div>
        </section>

        <section id="join" className="briv-cta-wrap">
          <div className="briv-container">
            <div className="briv-cta-card">
              <div className="briv-cta-glow" />
              <div className="briv-cta-content">
                <span className="briv-eyebrow"><span /> MULAI DARI SINI</span>
                <h2>Punya ide yang<br /><span className="briv-gradient">nggak sabar dibuat?</span></h2>
                <p>Ruangmu sudah siap. Tinggal kamu dan ide berikutnya.</p>
                <form className="briv-signup-form" onSubmit={handleJoin}>
                  <label className="visually-hidden" htmlFor="email">Email kamu</label>
                  <input id="email" type="email" autoComplete="email" placeholder="Masukkan email kamu" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={joined} />
                  <button type="submit" disabled={submitting || joined}>{submitting ? 'Mengirim...' : joined ? <>Kamu masuk daftar <Check size={15} /></> : <>Gabung gratis <ArrowRight size={15} /></>}</button>
                </form>
                <span className={`briv-form-note${signupError ? ' is-error' : ''}`} role="status" aria-live="polite">{signupMessage || 'Tanpa kartu kredit. Mulai kapan saja.'}</span>
              </div>
              <div className="briv-cta-art">
                <div className="cta-ring ring-outer" /><div className="cta-ring ring-middle" /><div className="cta-ring ring-inner" />
                <div className="cta-star">✳</div>
                <div className="cta-mini mini-one"><Sparkles size={12} /></div>
                <div className="cta-mini mini-two"><Zap size={12} /></div>
                <span className="cta-art-caption">IDE KECIL,<br />DAMPAK BESAR.</span>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="briv-footer">
        <div className="briv-container briv-footer-top">
          <div><Brand light /><p>Ruang kreatif untuk masa depan yang kamu bayangkan.</p></div>
          <div className="briv-footer-links"><a href="#karya">Karya</a><a href="#fitur">Fitur</a><a href="#cara-kerja">Cara kerja</a><a href="#model">Model</a><a href="mailto:halo@blea.ai">Hubungi kami</a></div>
          <a href="#top" className="briv-back-top">Kembali ke atas <ArrowUpRight size={13} /></a>
        </div>
        <div className="briv-container briv-footer-bottom">
          <span>© 2026 BLEA AI. Dibuat untuk ide-ide besar.</span>
          <div><a href="#privasi">Privasi</a><a href="#ketentuan">Ketentuan</a><span className="briv-footer-status"><i /> Semua sistem beroperasi</span></div>
        </div>
      </footer>
    </div>
  );
}
