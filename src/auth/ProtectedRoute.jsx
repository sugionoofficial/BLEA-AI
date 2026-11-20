import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export function ProtectedRoute() {
  const { user, loading, accountBlocked, accountMessage, signOut } = useAuth();
  const location = useLocation();

  if (loading) return <div className="auth-loading"><span className="loader-orbit" /><span>Menyiapkan ruangmu...</span></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (accountBlocked) {
    return (
      <div className="auth-loading account-blocked" role="alert">
        <h2 className="account-blocked-title">Akses akun ditahan</h2>
        <p className="account-blocked-message">
          {accountMessage || 'Akun Anda sedang tidak dapat mengakses BLEA. Hubungi admin BLEA.'}
        </p>
        <button type="button" className="account-blocked-button" onClick={() => { if (signOut) signOut(); }}>Keluar</button>
      </div>
    );
  }
  return <Outlet />;
}
