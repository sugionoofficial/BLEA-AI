import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, Bot, Clapperboard, Code, FileSearch2, FileText, FolderDown, Globe, GraduationCap,
  Image as ImageIcon, Languages, Lock, MessageSquare, Music, Plug, Scissors, Search, Sparkles,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { STUDIO_TOOLS, STUDIO_TOOL_STATUS, TOOL_SEPARATION_REASONS, toolsByGroup } from './toolCatalog';
import './studio-home.css';

const ICONS = {
  MessageSquare, Bot, Image: ImageIcon, Clapperboard, Music, Scissors, FileSearch2, Globe, Code, FileText, GraduationCap, Languages, Plug,
  FolderDown,
};

/**
 * Beranda Studio: daftar tool, bukan percakapan.
 *
 * Setiap kartu membuka ruang kerja sendiri (/studio/image, /studio/video, ...)
 * karena tiap alat punya form dan batasan biaya yang berbeda. Tool yang belum
 * punya mesin (video/musik saat provider putus) tetap tampil tetapi ditandai,
 * supaya pengguna tidak menemukan tombol mati tanpa penjelasan.
 */
export function StudioPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('Semua');

  const groups = useMemo(() => toolsByGroup(), []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return STUDIO_TOOLS.filter((tool) => {
      if (group !== 'Semua' && tool.group !== group) return false;
      if (!needle) return true;
      return [tool.label, tool.description, tool.group, ...(tool.skills || [])]
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [query, group]);

  const visibleGroups = useMemo(() => toolsByGroup(filtered), [filtered]);

  return (
    <DropXLayout
      title="Studio"
      description="Semua alat BLEA dalam satu tempat: teks, gambar, video, audio, dan utilitas."
      actions={(
        <Link className="studio-home-connection" to="/studio/connection">
          <Plug size={13} /> Koneksi
        </Link>
      )}
    >
      <div className="studio-home">
        <section className="studio-home-hero">
          <span className="studio-home-badge"><Sparkles size={12} /> Studio</span>
          <h1>Pilih alat, lalu mulai.</h1>
          <p>
            Setiap alat punya ruang kerjanya sendiri di dalam Studio. Pilih satu kartu di bawah;
            pengaturan, biaya kredit, dan riwayatnya terpisah supaya tidak tercampur.
          </p>
          <div className="studio-home-search">
            <Search size={14} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Cari alat: gambar, subtitle, metadata, riset…"
              aria-label="Cari alat Studio"
            />
          </div>
          <div className="studio-home-tabs">
            {['Semua', ...groups.map((item) => item.group)].map((name) => (
              <button
                type="button"
                key={name}
                className={`studio-home-tab ${group === name ? 'is-active' : ''}`}
                onClick={() => setGroup(name)}
              >
                {name}
              </button>
            ))}
          </div>
        </section>

        {visibleGroups.length === 0 && (
          <p className="studio-home-empty">Tidak ada alat yang cocok dengan “{query}”.</p>
        )}

        {visibleGroups.map((section) => (
          <section className="studio-home-group" key={section.group}>
            <h2>{section.group}</h2>
            <div className="studio-home-grid">
              {section.tools.map((tool) => {
                const Icon = ICONS[tool.icon] || Sparkles;
                const disabled = tool.status === 'soon';
                return (
                  <button
                    type="button"
                    key={tool.id}
                    className={`studio-tool-card is-${tool.status}`}
                    onClick={() => navigate(tool.href)}
                    disabled={disabled}
                    aria-label={`${tool.label} — ${STUDIO_TOOL_STATUS[tool.status]}`}
                  >
                    <span className="studio-tool-card-head">
                      <span className="studio-tool-icon"><Icon size={17} /></span>
                      <span className={`studio-tool-status is-${tool.status}`}>
                        {tool.status === 'degraded' && <Lock size={9} />}
                        {STUDIO_TOOL_STATUS[tool.status]}
                      </span>
                    </span>
                    <b>{tool.label}</b>
                    <small>{tool.description}</small>
                    <span className="studio-tool-skills">
                      {(tool.skills || []).slice(0, 3).map((skill) => (
                        <em key={skill}>{skill}</em>
                      ))}
                    </span>
                    <span className="studio-tool-cta">
                      {tool.cta} <ArrowUpRight size={11} />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        {/* Alasan tool dipisah ditampilkan di beranda, bukan disembunyikan di
            dokumentasi: ini keputusan desain yang menentukan biaya & keamanan. */}
        {group === 'Semua' && !query.trim() && (
          <section className="studio-home-why">
            <h2>Kenapa satu alat = satu fungsi</h2>
            <ul>
              {TOOL_SEPARATION_REASONS.map((reason) => (
                <li key={reason.title}>
                  <b>{reason.title}</b>
                  <small>{reason.body}</small>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </DropXLayout>
  );
}

export default StudioPage;
