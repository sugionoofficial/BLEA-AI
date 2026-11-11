import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Eye, EyeOff, LockKeyhole, Mail, Sparkles } from 'lucide-react';
import { Brand } from '../components/Brand';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

function RecoveryFrame({ kicker, title, children }) {
  return (
    <main className="auth-page">
      <div className="auth-backdrop auth-backdrop-left" /><div className="auth-backdrop auth-backdrop-right" />
      <header className="auth-header"><Brand /><Link to="/login" className="auth-home-link"><ArrowLeft size={14} /> Kembali ke masuk</Link></header>
      <div className="recovery-layout">
        <section className="auth-card-wrap">
          <div className="auth-card">
            <div className="auth-card-top"><div className="auth-card-icon"><Sparkles size={17} /></div><span className="auth-step">{kicker}</span></div>
            <h2>{title}</h2>
            {children}
          </div>
          <div className="auth-secure"><LockKeyhole size={12} /> Akunmu terlindungi Supabase Auth</div>
        </section>
      </div>
      <footer className="auth-footer"><span>© 2026 BLEA AI</span><span>Ide besar. Eksekusi lebih cepat.</span></footer>
    </main>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setErrorMessage('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) throw error;
      setSent(true);
    } catch (error) {
      console.error('Password recovery request failed:', error);
      setErrorMessage('Belum berhasil mengirim tautan. Coba lagi sebentar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <RecoveryFrame kicker="PEMULIHAN AKUN" title={sent ? 'Periksa emailmu.' : 'Atur ulang kata sandi.'}>
      {sent ? <div className="recovery-success"><div className="confirmation-check"><Check size={22} /></div><p>Jika alamat tersebut terdaftar, kami akan mengirim tautan aman untuk membuat kata sandi baru.</p><span className="confirmation-email">{email}</span><Link to="/login" className="auth-submit confirmation-button">Kembali ke masuk <ArrowRight size={16} /></Link></div> : <><p className="auth-subtitle">Masukkan email yang terhubung dengan akun BLEA-mu.</p><form className="auth-form recovery-form" onSubmit={handleSubmit}><label className="auth-field"><span>Email</span><div className="auth-input-wrap"><Mail size={16} /><input type="email" autoComplete="email" placeholder="nama@email.com" value={email} onChange={(event) => setEmail(event.target.value)} required /></div></label>{errorMessage && <div className="auth-alert auth-alert-error" role="alert">{errorMessage}</div>}<button className="auth-submit" type="submit" disabled={busy}>{busy ? <><span className="button-loader" /> Mengirim...</> : <>Kirim tautan pemulihan <ArrowRight size={16} /></>}</button></form><p className="recovery-help">Ingat kata sandinya? <Link to="/login">Kembali masuk</Link></p></>}
    </RecoveryFrame>
  );
}

export function ResetPasswordPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  async function handleSubmit(event) {
    event.preventDefault();
    setErrorMessage('');
    if (password !== confirmPassword) {
      setErrorMessage('Kedua kata sandi belum sama.');
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      navigate('/app', { replace: true, state: { passwordUpdated: true } });
    } catch (error) {
      console.error('Password update failed:', error);
      setErrorMessage('Belum berhasil memperbarui kata sandi. Minta tautan baru lalu coba lagi.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="auth-loading"><span className="loader-orbit" /><span>Memeriksa tautan pemulihan...</span></div>;

  return (
    <RecoveryFrame kicker="KATA SANDI BARU" title="Buat kata sandi baru.">
      {!user ? <div className="recovery-success"><p className="recovery-no-session">Tautan pemulihan tidak aktif atau sudah kedaluwarsa. Minta tautan baru untuk melanjutkan.</p><Link to="/forgot-password" className="auth-submit confirmation-button">Minta tautan baru <ArrowRight size={16} /></Link></div> : <><p className="auth-subtitle">Pilih kata sandi baru dengan minimal 8 karakter.</p><form className="auth-form recovery-form" onSubmit={handleSubmit}><label className="auth-field"><span>Kata sandi baru</span><div className="auth-input-wrap"><LockKeyhole size={16} /><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="Minimal 8 karakter" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} /><button className="password-toggle" type="button" aria-label={showPassword ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label><label className="auth-field"><span>Ulangi kata sandi</span><div className="auth-input-wrap"><LockKeyhole size={16} /><input type={showPassword ? 'text' : 'password'} autoComplete="new-password" placeholder="Ketik ulang kata sandi" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required minLength={8} /></div></label>{errorMessage && <div className="auth-alert auth-alert-error" role="alert">{errorMessage}</div>}<button className="auth-submit" type="submit" disabled={busy}>{busy ? <><span className="button-loader" /> Memperbarui...</> : <>Simpan kata sandi <ArrowRight size={16} /></>}</button></form></>}
    </RecoveryFrame>
  );
}
