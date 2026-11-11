import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RotateCw, Sparkles } from 'lucide-react';

export class StudioErrorBoundary extends React.Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('AI Studio render error:', error, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <main className="studio-crash-page">
        <div className="studio-crash-card">
          <span className="studio-crash-icon"><Sparkles size={20} /></span>
          <span className="studio-eyebrow">BLEA AI STUDIO</span>
          <h1>Studio belum bisa dibuka.</h1>
          <p>Terjadi kendala saat menyiapkan halaman. Coba muat ulang; riwayat percakapanmu tetap aman tersimpan.</p>
          <div><button onClick={() => window.location.reload()}><RotateCw size={14} /> Muat ulang halaman</button><Link to="/app"><ArrowLeft size={14} /> Kembali ke dashboard</Link></div>
        </div>
      </main>
    );
  }
}
