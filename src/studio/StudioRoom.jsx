import { Link } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import './room.css';

/**
 * Bingkai ruang kerja Studio yang SENGAJA tanpa navigasi.
 *
 * Navigasi utama sudah ada di shell aplikasi (sidebar DropX), jadi setiap tool
 * hanya menampilkan: judul alat, tombol kembali ke daftar alat, dan isinya.
 * Tidak ada sidebar kedua, tidak ada breadcrumb kedua — itu dulu membuat
 * halaman terasa seperti aplikasi di dalam aplikasi.
 */
export function StudioRoom({ tool, note = '', actions = null, children }) {
  return (
    <div className="room">
      <header className="room-head">
        <div className="room-head-text">
          <Link className="room-back" to="/studio">
            <ArrowLeft size={13} /> Studio
            <ChevronRight size={11} aria-hidden="true" />
            <span>{tool.group}</span>
          </Link>
          <h1>{tool.label}</h1>
          <p>{note || tool.description}</p>
        </div>
        {actions && <div className="room-head-actions">{actions}</div>}
      </header>
      <div className="room-body">{children}</div>
    </div>
  );
}

export default StudioRoom;
