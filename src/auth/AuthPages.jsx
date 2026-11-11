import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import { Brand } from '../components/Brand';

export function AuthPage({ mode = 'login' }) {
  const isSignup = mode === 'signup';
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  if (authLoading) return <div className="auth-loading"><span className="loader-orbit" /><span>Menyiapkan ruangmu...</span></div>;
  if (user && !needsConfirmation) return <Navigate to="/app" replace />;

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    setErrorMessage('');
    const normalizedEmail = email.trim().toLowerCase();

    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email: normalizedEmail,
          password,
          options: {
            data: { full_name: name.trim() },
            emailRedirectTo: `${window.location.origin}/app`,
          },
        });
        if (error) throw error;
        if (data.session) {
          navigate('/app', { replace: true });
        } else {
          setNeedsConfirmation(true);
          setNotice('Kami sudah mengirim tautan konfirmasi ke emailmu. Buka tautan itu untuk mengaktifkan akun.');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
        if (error) throw error;
        navigate(location.state?.from?.pathname || '/app', { replace: true });
      }
    } catch (error) {
      const message = error?.message || '';
      if (message.toLowerCase().includes('invalid login credentials')) {
        setErrorMessage('Email atau kata sandi belum cocok. Coba periksa lagi.');
      } else if (message.toLowerCase().includes('already registered') || message.toLowerCase().includes('already been registered')) {
        setErrorMessage('Email ini sudah punya akun. Coba masuk saja.');
      } else if (message.toLowerCase().includes('password')) {
        setErrorMessage('Kata sandi belum memenuhi ketentuan. Gunakan minimal 8 karakter.');
      } else {
        setErrorMessage('Ada kendala saat memproses akunmu. Coba lagi sebentar.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    setResending(true);
    setResendMessage('');
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: email.trim().toLowerCase(),
      options: { emailRedirectTo: `${window.location.origin}/app` },
    });
    setResendMessage(error ? 'Belum berhasil mengirim ulang. Tunggu sebentar lalu coba lagi.' : 'Tautan konfirmasi baru sudah dikirim.');
    setResending(false);
  }

  return (
    <main className="auth-page">
      <div className="auth-backdrop auth-backdrop-left" /><div className="auth-backdrop auth-backdrop-right" />
      <header className="auth-header"><Brand /><Link to="/" className="auth-home-link"><ArrowLeft size={14} /> Kembali ke beranda</Link></header>
      <div className="auth-layout">
        <section className="auth-story">
          <span className="auth-kicker"><Sparkles size={13} /> RUANG KREATIF BERBASIS AI</span>
          <h1>{isSignup ? <>Mulai dari<br /><em>ide berikutnya.</em></> : <>Senang melihatmu<br /><em>kembali.</em></>}</h1>
          <p>{isSignup ? 'Buat ruang untuk pikiran-pikiran hebatmu. BLEA siap membantumu mengubahnya jadi nyata.' : 'Masuk ke ruang kreatifmu dan lanjutkan hal hebat yang sedang kamu bangun.'}</p>
          <div className="auth-quote"><span>“</span><p>Hal besar selalu dimulai dari keberanian untuk mencoba.</p><i /></div>
        </section>
        <section className="auth-card-wrap">
          <div className="auth-card">
            <div className="auth-card-top"><div className="auth-card-icon"><Sparkles size={17} /></div><span className="auth-step">{isSignup ? 'LANGKAH PERTAMA' : 'RUANG KERJAMU'}</span></div>
            {needsConfirmation ? (
              <div className="auth-confirmation">
                <div className="confirmation-check"><Check size={22} /></div>
                <h2>Cek emailmu.</h2>
                <p>{notice}</p>
                <span className="confirmation-email">{email}</span>
                <button type="button" className="resend-confirmation" onClick={resendConfirmation} disabled={resending}>{resending ? 'Mengirim ulang...' : 'Kirim ulang tautan konfirmasi'}</button>
                {resendMessage && <span className="resend-status" role="status">{resendMessage}</span>}
                <Link to="/login" className="auth-submit confirmation-button">Kembali ke masuk <ArrowRight size={16} /></Link>
              </div>
            ) : (
              <>
                <h2>{isSignup ? 'Buat akun BLEA' : 'Masuk ke BLEA'}</h2>
                <p className="auth-subtitle">{isSignup ? 'Hanya butuh beberapa detik untuk mulai.' : 'Masukkan detail akunmu untuk melanjutkan.'}</p>
                <form className="auth-form" onSubmit={handleSubmit}>
                  {isSignup && <label className="auth-field"><span>Nama lengkap</span><div className="auth-input-wrap"><input type="text" autoComplete="name" placeholder="Nama kamu" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80} /></div></label>}
                  <label className="auth-field"><span>Email</span><div className="auth-input-wrap"><Mail size={16} /><input type="email" autoComplete="email" placeholder="nama@email.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></div></label>
                  <label className="auth-field"><span>Kata sandi</span><div className="auth-input-wrap"><LockKeyhole size={16} /><input type={showPassword ? 'text' : 'password'} autoComplete={isSignup ? 'new-password' : 'current-password'} placeholder={isSignup ? 'Minimal 8 karakter' : 'Masukkan kata sandi'} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={isSignup ? 8 : 1} /><button className="password-toggle" type="button" aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
                  {!isSignup && <div className="auth-form-meta"><span /> <Link to="/forgot-password">Lupa kata sandi?</Link></div>}
                  {errorMessage && <div className="auth-alert auth-alert-error" role="alert">{errorMessage}</div>}
                  {notice && <div className="auth-alert auth-alert-success" role="status">{notice}</div>}
                  <button className="auth-submit" type="submit" disabled={busy}>{busy ? <><span className="button-loader" /> Memproses...</> : <>{isSignup ? 'Buat akun gratis' : 'Masuk ke ruangku'} <ArrowRight size={16} /></>}</button>
                </form>
                <div className="auth-switch">{isSignup ? 'Sudah punya akun?' : 'Belum punya akun?'} <Link to={isSignup ? '/login' : '/signup'}>{isSignup ? 'Masuk' : 'Buat akun'}</Link></div>
                <div className="auth-terms">Dengan {isSignup ? 'mendaftar' : 'masuk'}, kamu menyetujui <a href="#ketentuan">Ketentuan Layanan</a> dan <a href="#privasi">Kebijakan Privasi</a>.</div>
              </>
            )}
          </div>
          <div className="auth-secure"><LockKeyhole size={12} /> Akses akunmu terlindungi Supabase Auth</div>
        </section>
      </div>
      <footer className="auth-footer"><span>© 2026 BLEA AI</span><span>Ide besar. Eksekusi lebih cepat.</span></footer>
    </main>
  );
}
