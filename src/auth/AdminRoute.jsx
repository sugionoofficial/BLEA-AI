import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './AuthProvider';

export function AdminRoute() {
  const { user, loading } = useAuth();
  if (loading) return <div className="auth-loading"><span className="loader-orbit" /><span>Memeriksa hak akses...</span></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.app_metadata?.role !== 'admin') return <Navigate to="/app" replace />;
  return <Outlet />;
}
