import { Navigate, useParams } from 'react-router-dom';
import { DropXLayout } from '../dropx/DropXLayout';
import { GenerateImagePanel } from '../auth/GenerateImagePanel';
import { GenerateMusicPanel } from '../auth/GenerateMusicPanel';
import { MetadataCheckPage } from '../auth/MetadataCheckPage';
import { AIStudio } from '../auth/AIStudio';
import { AgentPage } from '../agent/AgentPage';
import { StudioVideoRoom } from './StudioVideoRoom';
import { findStudioTool } from './toolCatalog';
import { StudioRoom } from './StudioRoom';
import './studio-home.css';

/**
 * Satu ruang kerja per tool.
 *
 * Aturan yang berlaku untuk semua ruang:
 *   1. TIDAK ada navigasi di dalam. Shell aplikasi (sidebar DropX) sudah
 *      menyediakannya; menambah sidebar/breadcrumb kedua membuat halaman terasa
 *      seperti aplikasi di dalam aplikasi. Yang tersisa hanya satu bilah judul
 *      tipis dengan tautan kembali ke daftar alat.
 *   2. Memakai komponen yang sudah ada (bukan salinan), supaya perbaikan di
 *      Generate/Metadata/Agent otomatis ikut ke Studio.
 *   3. Tool yang belum punya mesin tidak dipalsukan: halamannya menjelaskan
 *      status dan mengarahkan ke ruang yang berfungsi.
 */
const ROOMS = {
  chat: {
    render: () => <AIStudio />,
    fill: true,
    note: 'Percakapan, penulisan, dan riwayat. Model chat yang aktif dipakai di sini.',
  },
  agent: {
    render: () => <AgentPage />,
    fill: true,
    note: 'Agen bertahap: riset web, baca URL, muat skill, dan usulkan klip.',
  },
  image: {
    render: () => <GenerateImagePanel />,
    note: 'Gambar dibuat lewat pool akun OpenAI (gpt-image-1). Kuota akun, bukan kredit BLEA.',
  },
  video: {
    render: () => <StudioVideoRoom />,
    note: 'Video dibuat lewat pool akun OpenAI (Sora). Kuota akun, bukan kredit BLEA.',
  },
  music: {
    render: () => <GenerateMusicPanel />,
    note: 'Musik dan vokal bergantung pada provider yang terhubung.',
  },
  metadata: {
    render: () => <MetadataCheckPage />,
    note: 'Pindai lalu bersihkan metadata buatan AI tanpa kehilangan kualitas gambar.',
  },
};

export function StudioRoomPage() {
  const { toolId } = useParams();
  const tool = findStudioTool(toolId);
  if (!tool) return <Navigate to="/studio" replace />;

  const room = ROOMS[tool.id];

  // Shell aplikasi tetap dipakai untuk sidebar + header global, tetapi header
  // halaman dari DropXLayout dimatikan (title kosong) karena StudioRoom punya
  // bilah judulnya sendiri yang lebih ringkas.
  return (
    <DropXLayout footer={false} header={false} fill={Boolean(room?.fill)}>
      {room ? (
        <StudioRoom tool={tool} note={room.note}>{room.render()}</StudioRoom>
      ) : (
        <StudioRoom tool={tool}>
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
                Yang sudah berfungsi sekarang: buat gambar, chat, agen otonom, klip + subtitle,
                dan pemindai metadata.
              </p>
            </section>
          </div>
        </StudioRoom>
      )}
    </DropXLayout>
  );
}

export default StudioRoomPage;
