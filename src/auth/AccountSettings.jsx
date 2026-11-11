import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, CircleHelp, KeyRound, Mail, Save, ShieldCheck, UserRound } from 'lucide-react';
import { Brand } from '../components/Brand';
import { useAuth } from './AuthProvider';
import { supabase } from '../lib/supabase';

export function AccountSettings() {
  const { user } = useAuth();
  const isAdmin = user?.app_metadata?.role === 'admin';
  const [name, setName] = useState(user?.user_metadata?.full_name || '');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const emailVerified = Boolean(user?.email_confirmed_at);
  const pendingEmail = user?.new_email;

  async function saveProfile(event) {
    event.preventDefault();
    setBusy(true);
    setNotice('');
    setErrorMessage('');
    try {
      const { error } = await supabase.auth.updateUser({ data: { full_name: name.trim() } });
      if (error) throw error;
      setNotice('Nama profil berhasil diperbarui.');
    } catch (error) {
      console.error('Profile update failed:', error);
      setErrorMessage('Belum berhasil menyimpan perubahan. Coba lagi.');
    } finally {
      setBusy(false);
    }
  }

  async function requestEmailChange(event) {
    event.preventDefault();
    const nextEmail = email.trim().toLowerCase();
    if (!nextEmail || nextEmail === user?.email?.toLowerCase()) {
      setNotice('Alamat emailmu tidak berubah.');
      return;
    }
    setBusy(true);
    setNotice('');
    setErrorMessage('');
    try {
      const { error } = await supabase.auth.updateUser(
        { email: nextEmail },
        { emailRedirectTo: `${window.location.origin}/settings` },
      );
      if (error) throw error;
      setNotice('Permintaan perubahan email terkirim. Ikuti konfirmasi yang dikirim ke alamat emailmu.');
    } catch (error) {
      console.error('Email update failed:', error);
      setErrorMessage('Belum berhasil mengubah email. Pastikan alamatnya benar lalu coba lagi.');
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    setResending(true);
    setNotice('');
    setErrorMessage('');
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: user.email,
        options: { emailRedirectTo: `${window.location.origin}/app` },
      });
      if (error) throw error;
      setNotice('Tautan verifikasi baru sudah dikirim.');
    } catch (error) {
      console.error('Verification resend failed:', error);
      setErrorMessage('Belum berhasil mengirim ulang tautan. Tunggu sebentar lalu coba lagi.');
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-sidebar-brand"><Brand /></div>
        <div className="workspace-switcher"><span className="workspace-logo"><UserRound size={15} /></span><span><b>Pengaturan akun</b><small>Profil dan keamanan</small></span></div>
        <div className="app-nav-label">AKUN</div>
        <Link className="app-nav-item active" to="/settings"><UserRound size={16} /> Profil & keamanan</Link>
        <Link className="app-nav-item" to="/app"><ArrowRight size={16} /> Kembali ke ringkasan</Link>
        {isAdmin && <Link className="app-nav-item admin-nav-shortcut" to="/admin"><ShieldCheck size={16} /> Admin panel</Link>}
        <div className="sidebar-spacer" />
        <a className="app-nav-item" href="mailto:halo@blea.ai"><CircleHelp size={16} /> Bantuan</a>
      </aside>
      <main className="app-main">
        <header className="app-topbar"><div className="app-breadcrumb"><Link to="/app">Ruang pribadi</Link><span>/</span><b>Pengaturan akun</b></div><a href="/" className="website-link">Lihat website <ArrowRight size={14} /></a></header>
        <div className="app-content settings-content">
          <div className="settings-heading"><span className="app-date">PREFERENSI AKUN</span><h1>Profil & keamanan</h1><p>Kelola identitas, email, dan akses akun BLEA-mu.</p></div>
          {notice && <div className="settings-banner settings-success" role="status"><Check size={15} />{notice}</div>}
          {errorMessage && <div className="settings-banner settings-error" role="alert">{errorMessage}</div>}

          <form className="settings-card" onSubmit={saveProfile}>
            <div className="settings-card-title"><span className="settings-card-icon"><UserRound size={16} /></span><div><h2>Informasi profil</h2><p>Nama ini akan tampil di ruang kerjamu.</p></div></div>
            <label className="settings-field"><span>Nama lengkap</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nama kamu" maxLength={80} required /></label>
            <div className="settings-card-actions"><span className="settings-hint">Perubahan disimpan di profil akunmu.</span><button type="submit" className="settings-save" disabled={busy}><Save size={14} /> {busy ? 'Menyimpan...' : 'Simpan profil'}</button></div>
          </form>

          <section className="settings-card">
            <div className="settings-card-title"><span className="settings-card-icon"><Mail size={16} /></span><div><h2>Alamat email</h2><p>Gunakan alamat yang bisa kamu akses.</p></div><span className={`verification-pill ${emailVerified ? 'is-verified' : 'is-pending'}`}>{emailVerified ? <><Check size={11} /> Terverifikasi</> : 'Belum diverifikasi'}</span></div>
            {!emailVerified && <div className="verification-notice"><ShieldCheck size={14} /><span>Verifikasi email untuk membantu menjaga keamanan akun.</span><button type="button" onClick={resendVerification} disabled={resending}>{resending ? 'Mengirim...' : 'Kirim ulang'}</button></div>}
            <form className="settings-field-row" onSubmit={requestEmailChange}><label className="settings-field"><span>Email saat ini</span><input type="email" value={user?.email || ''} readOnly /></label><label className="settings-field"><span>Email baru</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="email-baru@contoh.com" autoComplete="email" required /></label><button className="settings-save" type="submit" disabled={busy || email.trim().toLowerCase() === user?.email?.toLowerCase()}><Mail size={14} /> Ubah email</button></form>
            {pendingEmail && <p className="pending-email-note">Konfirmasi perubahan email masih menunggu untuk <b>{pendingEmail}</b>.</p>}
          </section>

          <section className="settings-card security-card">
            <div className="settings-card-title"><span className="settings-card-icon"><KeyRound size={16} /></span><div><h2>Kata sandi</h2><p>Kirim tautan aman untuk mengganti kata sandi.</p></div></div>
            <div className="settings-card-actions"><span className="settings-hint">Tautan dikirim ke {user?.email}.</span><Link className="settings-save settings-link-button" to="/forgot-password">Kirim tautan reset <ArrowRight size={14} /></Link></div>
          </section>
          <div className="app-footer settings-footer"><span>BLEA AI · Pengaturan akun</span><div><span className="footer-status"><i /> Akses akunmu terlindungi</span></div></div>
        </div>
      </main>
    </div>
  );
}
