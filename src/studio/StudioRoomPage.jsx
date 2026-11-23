import { Link, Navigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { GenerateImagePanel } from '../auth/GenerateImagePanel';
import { GenerateMusicPanel } from '../auth/GenerateMusicPanel';
import { MetadataCheckPage } from '../auth/MetadataCheckPage';
import { AIStudio } from '../auth/AIStudio';
import { AgentPage } from '../agent/AgentPage';
import { findStudioTool } from './toolCatalog';
import './studio-home.css';

/**
 * Satu ruang kerja per tool. Komponen yang dipakai adalah komponen yang sudah
 * ada (bukan salinan), supaya perbaikan di Generate/Metadata/Agent otomatis ikut
 * di Studio dan tidak ada dua versi form yang harus dijaga sinkron.
 *
 * Tool yang belum punya mesin (video saat provider putus) TIDAK dipalsukan:
 * halamannya menjelaskan status dan mengarahkan ke ruang yang berfungsi.
 */
const ROOMS = {
  chat: { render: () => <AIStudio /> },
  agent: { render: () => <AgentPage /> },
  image: { render: () => <GenerateImagePanel />, note: 'Model gambar dikunci admin; biaya dipotong dari kredit BLEA.' },
  music: { render: () => <GenerateMusicPanel />, note: 'Musik dan vokal bergantung pada provider yang terhubung.' },
  metadata: { render: () => <MetadataCheckPage /> },
};

export function StudioRoomPage() {
  const { toolId } = useParams();
  const tool = findStudioTool(toolId);
  if (!tool) return <Navigate to="/studio" replace />;

  const room = ROOMS[tool.id];
  if (!room) {
    return (
      <DropXLayout
        title={tool.label}
        description={tool.description}
        actions={<Link className="studio-home-connection" to="/studio"><ArrowLeft size={13} /> Semua alat</Link>}
      >
        <div className="studio-home">
          <section className="studio-home-hero">
            <span className="studio-home-badge">{tool.group}</span>
            <h1>{tool.label} belum bisa dijalankan dari Studio.</h1>
            <p>
              {tool.note || 'Alat ini belum punya mesin di server.'} Statusnya
              {' '}<b>{tool.status === 'degraded' ? 'terbatas' : 'segera'}</b>, jadi halaman ini
              sengaja tidak menampilkan form yang pasti gagal.
            </p>
            <p>
              Yang sudah berfungsi dan bisa dipakai sekarang: buat gambar, chat, agen otonom,
              klip + subtitle, dan pemindai metadata.
            </p>
            <Link className="studio-home-connection" to="/studio"><ArrowLeft size={13} /> Pilih alat lain</Link>
          </section>
        </div>
      </DropXLayout>
    );
  }

  return (
    <DropXLayout
      title={tool.label}
      description={room.note || tool.description}
      actions={<Link className="studio-home-connection" to="/studio"><ArrowLeft size={13} /> Semua alat</Link>}
    >
      {room.render()}
    </DropXLayout>
  );
}

export default StudioRoomPage;
