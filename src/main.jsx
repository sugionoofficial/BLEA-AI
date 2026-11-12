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
const ProjectsPage = lazy(() => import('./auth/ProjectsPage').then((module) => ({ default: module.ProjectsPage })));
const AdminPage = lazy(() => import('./auth/AdminPage').then((module) => ({ default: module.AdminPage })));
const AIStudio = lazy(() => import('./auth/AIStudio').then((module) => ({ default: module.AIStudio })));
import './dropx/dropx.css';
import './auth/studio.css';
import './auth/studio-fallback.css';
import './auth/auth.css';
import './auth/settings.css';
import './auth/projects.css';
import './auth/admin.css';
import './auth/drawer.css';
import './landing.css';
import './styles.css';
import './readability.css';

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
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/studio" element={<StudioErrorBoundary><AIStudio /></StudioErrorBoundary>} />
            <Route path="/settings" element={<AccountSettings />} />
            <Route element={<AdminRoute />}>
              <Route path="/admin" element={<AdminPage />} />
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
