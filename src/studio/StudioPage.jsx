import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, Bot, BookOpen, Briefcase, ChartColumn, CheckCircle2, Clapperboard, Cloud, Code, Coins,
  Cpu, Database, FileSearch2, FileText, FolderDown, Globe, GraduationCap, Image as ImageIcon, KeyRound,
  Languages, Layers, Link as LinkIcon, Lock, Map, MapPin, Megaphone, MessageSquare, Music, Palette, PenLine,
  Phone, Plug, Scale, Scissors, Search, Server, ShieldCheck, ShoppingCart, Sparkles, Table, Video, Workflow,
} from 'lucide-react';
import { DropXLayout } from '../dropx/DropXLayout';
import { STUDIO_TOOLS, STUDIO_TOOL_STATUS, TOOL_SEPARATION_REASONS, findStudioTool, toolsByGroup } from './toolCatalog';
import { OUTPUT_CAPABILITIES, SKILL_CATALOG, SKILL_CATALOG_COUNT, searchSkillCatalog, toolForCategory } from './skillCatalog';
import './studio-home.css';

// Ikon katalog kemampuan (dipetakan sekali supaya data tetap murni teks).
const SKILL_ICONS = {
  ai: Sparkles, key: KeyRound, code: Code, globe: Globe, phone: Phone, server: Server, database: Database,
  chart: ChartColumn, brain: Cpu, image: ImageIcon, video: Video, music: Music, shield: ShieldCheck,
  cloud: Cloud, workflow: Workflow, layers: Layers, briefcase: Briefcase, megaphone: Megaphone, coins: Coins,
  file: FileText, search: Search, pen: PenLine, graduation: GraduationCap, palette: Palette, cart: ShoppingCart,
  link: LinkIcon, cpu: Cpu, map: Map, scale: Scale, check: CheckCircle2, message: MessageSquare, bot: Bot,
  table: Table, presentation: BookOpen, mapPin: MapPin,
};

// Status output yang benar-benar bisa dijanjikan sekarang.
const OUTPUT_STATUS = {
  live: { label: 'Siap', tone: 'ok' },
  partial: { label: 'Butuh kuota', tone: 'warn' },
  advisory: { label: 'Panduan', tone: 'muted' },
};

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
  const [skillQuery, setSkillQuery] = useState('');
  const [openCategory, setOpenCategory] = useState('');

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
  const skillHits = useMemo(() => searchSkillCatalog(skillQuery), [skillQuery]);

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
            Studio memakai <b>model ChatGPT</b> lewat pool akun yang ditambahkan admin, bukan katalog
            model provider lain. Setiap alat punya ruang kerjanya sendiri: pengaturan, biaya, dan
            riwayatnya terpisah supaya tidak tercampur.
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

        {/* ---- Katalog kemampuan: isi Studio, bukan hiasan ---- */}
        <section className="studio-skills" id="kemampuan">
          <header className="studio-skills-head">
            <div>
              <h2><BookOpen size={13} /> Katalog kemampuan</h2>
              <p>
                {SKILL_CATALOG.length} kategori · {SKILL_CATALOG_COUNT} kemampuan. Setiap kategori menunjuk
                ke tool yang benar-benar mengerjakannya; yang hanya bisa dijelaskan tidak dipura-purakan
                bisa dieksekusi.
              </p>
            </div>
            <div className="studio-skills-search">
              <Search size={13} />
              <input
                type="search"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder="Cari kemampuan: RAG, Docker, SEO, lip-sync…"
                aria-label="Cari kemampuan"
              />
            </div>
          </header>

          {skillQuery.trim() ? (
            <div className="studio-skills-hits">
              {skillHits.length === 0 && <p className="studio-home-empty">Tidak ada kemampuan yang cocok dengan “{skillQuery}”.</p>}
              {skillHits.slice(0, 40).map((hit) => {
                const tool = findStudioTool(toolForCategory(hit.categoryId));
                return (
                  <button
                    type="button"
                    key={`${hit.categoryId}-${hit.skill}`}
                    className="studio-skill-hit"
                    onClick={() => tool && navigate(`${tool.href}?skill=${encodeURIComponent(hit.skill)}`)}
                    disabled={!tool}
                  >
                    <b>{hit.skill}</b>
                    <small>{hit.category}{tool ? ` · buka ${tool.label}` : ''}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <ul className="studio-skills-grid">
              {SKILL_CATALOG.map((category) => {
                const Icon = SKILL_ICONS[category.icon] || Sparkles;
                const open = openCategory === category.id;
                const tool = findStudioTool(toolForCategory(category.id));
                return (
                  <li key={category.id} className={`studio-skill-card ${open ? 'is-open' : ''}`}>
                    <button
                      type="button"
                      className="studio-skill-card-head"
                      onClick={() => setOpenCategory(open ? '' : category.id)}
                      aria-expanded={open}
                    >
                      <span className="studio-skill-icon"><Icon size={14} /></span>
                      <span className="studio-skill-title">
                        <b>{category.label}</b>
                        <small>{category.skills.length} kemampuan</small>
                      </span>
                      <ArrowUpRight size={12} className={open ? 'is-open' : ''} />
                    </button>
                    {open && (
                      <>
                        <div className="studio-skill-tags">
                          {category.skills.map((skill) => <em key={skill}>{skill}</em>)}
                        </div>
                        {tool && (
                          <button
                            type="button"
                            className="studio-skill-cta"
                            onClick={() => navigate(`${tool.href}?skill=${encodeURIComponent(category.label)}`)}
                          >
                            Kerjakan di {tool.label} <ArrowUpRight size={11} />
                          </button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="studio-outputs">
            <h3>Output yang bisa dihasilkan</h3>
            <ul>
              {OUTPUT_CAPABILITIES.map((output) => {
                const Icon = SKILL_ICONS[output.icon] || Sparkles;
                const meta = OUTPUT_STATUS[output.status] || OUTPUT_STATUS.advisory;
                const tool = findStudioTool(output.tool);
                return (
                  <li key={output.label} className={`is-${meta.tone}`}>
                    <Icon size={13} />
                    <b>{output.label}</b>
                    <span className={`studio-output-state is-${meta.tone}`}>{meta.label}</span>
                    {tool && <small>{tool.label}</small>}
                  </li>
                );
              })}
            </ul>
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
