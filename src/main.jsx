import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider';
import { Dashboard } from './auth/Dashboard';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { AdminRoute } from './auth/AdminRoute';
import { StudioErrorBoundary } from './auth/StudioErrorBoundary';
import { LandingPage } from './components/Landing';
const AuthPage = lazy(() => import('./auth/AuthPages').then((module) => ({ default: module.AuthPage })));
const AccountSettings = lazy(() => import('./auth/AccountSettings').then((module) => ({ default: module.AccountSettings })));
const ForgotPasswordPage = lazy(() => import('./auth/RecoveryPages').then((module) => ({ default: module.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./auth/RecoveryPages').then((module) => ({ default: module.ResetPasswordPage })));
const CreditsPage = lazy(() => import('./auth/CreditsPage').then((module) => ({ default: module.CreditsPage })));
const HistoryPage = lazy(() => import('./auth/HistoryPage').then((module) => ({ default: module.HistoryPage })));
const CreditHistoryPage = lazy(() => import('./auth/CreditHistoryPage').then((module) => ({ default: module.CreditHistoryPage })));
const GeneratePage = lazy(() => import('./auth/GeneratePage').then((module) => ({ default: module.GeneratePage })));
const MetadataCheckPage = lazy(() => import('./auth/MetadataCheckPage').then((module) => ({ default: module.MetadataCheckPage })));
const LiveQueuePage = lazy(() => import('./auth/LiveQueuePage').then((module) => ({ default: module.LiveQueuePage })));
const FreebeatPage = lazy(() => import('./auth/FreebeatPage').then((module) => ({ default: module.FreebeatPage })));
const AdminPage = lazy(() => import('./auth/AdminPage').then((module) => ({ default: module.AdminPage })));
const TempMailPage = lazy(() => import('./auth/TempMailPage').then((module) => ({ default: module.TempMailPage })));
// Halaman Studio. Ketiganya WAJIB dideklarasikan di sini: tanpa deklarasi ini
// bundle produksi memuat identifier mentah (`StudioPage`) dan setiap rute
// /studio* melempar ReferenceError saat render — hasilnya halaman kosong.
const StudioPage = lazy(() => import('./studio/StudioPage').then((module) => ({ default: module.StudioPage })));
const StudioRoomPage = lazy(() => import('./studio/StudioRoomPage').then((module) => ({ default: module.StudioRoomPage })));
const ConnectionPage = lazy(() => import('./studio/ConnectionPage').then((module) => ({ default: module.ConnectionPage })));
import './dropx/dropx.css';
import './auth/studio.css';
import './agent/agent.css';
import './auth/studio-fallback.css';
import './auth/auth.css';
import './auth/settings.css';
import './auth/generate.css';
import './auth/metadata.css';
import './auth/live.css';
import './auth/admin.css';
import './auth/drawer.css';
import './auth/showcase.css';
import './landing.css';
import './styles.css';
import './readability.css';
import './mobile.css';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense fallback={<div className="auth-loading"><span className="loader-orbit" /><span>Menyiapkan halaman...</span></div>}>
          <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/app" element={<Dashboard />} />
            <Route path="/generate" element={<GeneratePage />} />
            <Route path="/metadata" element={<MetadataCheckPage />} />
            <Route path="/live" element={<LiveQueuePage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/credits" element={<CreditsPage />} />
            <Route path="/credits/history" element={<CreditHistoryPage />} />
            <Route path="/projects" element={<Navigate to="/generate" replace />} />
            {/* Studio: beranda alat + satu ruang kerja per tool. /studio/chat
                dan /studio/agent adalah komponen lama, tidak disalin. */}
            <Route path="/studio" element={<StudioErrorBoundary><StudioPage /></StudioErrorBoundary>} />
            <Route path="/studio/connection" element={<StudioErrorBoundary><ConnectionPage /></StudioErrorBoundary>} />
            <Route path="/studio/:toolId" element={<StudioErrorBoundary><StudioRoomPage /></StudioErrorBoundary>} />
            {/* URL lama tetap hidup supaya tautan/Bookmark tidak 404. */}
            <Route path="/agent" element={<Navigate to="/studio/agent" replace />} />
            <Route path="/settings" element={<AccountSettings />} />
            <Route element={<AdminRoute />}>
              <Route path="/admin" element={<AdminPage />} />
              <Route path="/admin/freebeat-oauth" element={<AdminPage initialTab="freebeat-oauth" />} />
              <Route path="/admin/freebeat" element={<FreebeatPage />} />
              <Route path="/tempmail" element={<TempMailPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')).render(<App />);
