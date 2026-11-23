// Provenance + integrity manifest for the Agent Skills that ship inside
// BLEA's one-page agent (/agent).
//
// The skills below are copied verbatim from the public Apache-2.0 repository
// `anthropics/skills`. They are NOT Anthropic product features, are not
// executed by Claude, and are not endorsed by Anthropic — they are instruction
// documents (Markdown) that BLEA injects into its own system prompt when a
// matching skill is activated.
//
// Upstream marks these skills "for demonstration and educational purposes
// only"; treat their guidance as reviewed-but-unvetted advice. Every load
// verifies the bytes against `sha256` and refuses a file that does not match,
// so the licence header and the instruction text cannot drift silently.
//
// Deliberately not vendored: `skill-creator` (33 KB, teaches the format rather
// than a capability), `mcp-builder` (73 KB with its reference bundle, quoted
// scripts we cannot run), `brand-guidelines` (Anthropic's own identity — wrong
// brand for BLEA), and the document skills (`docx`/`pdf`/`pptx`/`xlsx`), which
// assume a code-execution sandbox this Worker does not have.

export const SOURCE = {
  repo: 'anthropics/skills',
  url: 'https://github.com/anthropics/skills',
  license: 'Apache-2.0',
};

export const SKILLS = [
  {
    id: 'frontend-design',
    name: 'Frontend design',
    description: 'Aesthetic direction, typography, and layout choices for UI work that should not look templated.',
    triggers: ['desain', 'design', 'ui', 'ux', 'landing page', 'tampilan', 'layout', 'tipografi', 'typography', 'palet', 'warna', 'hero', 'komponen'],
    files: [
      { path: 'SKILL.md', sha256: 'd91970639e9f5c37682ac7ab60094d35f1c7c1f38d731bd56396563aee10c1d3' },
      { path: 'LICENSE.txt', sha256: '0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594' },
    ],
  },
  {
    id: 'internal-comms',
    name: 'Internal comms',
    description: 'Formats for 3P updates, company newsletters, FAQs, status reports, and incident reports.',
    triggers: ['newsletter', '3p', 'update tim', 'laporan status', 'faq', 'komunikasi internal', 'incident', 'post mortem', 'siaran pers', 'pengumuman'],
    files: [
      { path: 'SKILL.md', sha256: '067b7587a344a928fc6534ef66b1bcd591fc7c26d207ea7ca3334aeb678d6475' },
      { path: 'LICENSE.txt', sha256: 'bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362' },
    ],
    resources: [
      { id: '3p', path: 'examples/3p-updates.md', sha256: '087e4363c0f3513728a7e695eeb9ead5c3ecd12a4681b59340691180e65b68fc', description: 'Progress / Plans / Problems team update' },
      { id: 'newsletter', path: 'examples/company-newsletter.md', sha256: '30f81cfbdb03858a006169c72169024089c7c5d3d32611d337782da4f38c86b5', description: 'Company-wide newsletter' },
      { id: 'faq', path: 'examples/faq-answers.md', sha256: '5ecd3356cd6666937f2ebefa753253edfdbdca15e368d07baf398bfcced72484', description: 'Answers to frequently asked questions' },
      { id: 'general', path: 'examples/general-comms.md', sha256: '4d3a4bb198a77626bcf018e96b2b45a2dbabed172d4ade0fcd70d23ae8a47a47', description: 'Fallback format for anything else' },
    ],
  },
  {
    id: 'web-artifacts-builder',
    name: 'Web artifacts',
    description: 'How to build rich single-file HTML/React deliverables and avoid generic "AI slop" UI.',
    triggers: ['artifact', 'artefak', 'single file', 'satu file', 'html demo', 'prototipe', 'purwarupa', 'embed', 'mini app'],
    files: [
      { path: 'SKILL.md', sha256: '81c5002c6643b0de7b8710b00e7a9038daa6fb9b68d59870ee6adb12da8d10f8' },
      { path: 'LICENSE.txt', sha256: 'bc6b3af2f331cbc7fb0da1344efb2cbe5877a31498b4d70dbc7000f3405a1362' },
    ],
  },
];

// Upstream tells the model to run `scripts/*.sh`, `python …`, `pip install …`
// and to fetch SDK docs with a WebFetch tool. None of that exists here: this is
// a Cloudflare Worker with no shell. Without an overlay the model promises
// build steps it cannot perform.
export const SKILL_OVERLAYS = {
  'frontend-design': 'Lingkungan BLEA: keluaran Anda adalah teks di dalam chat, bukan file proyek. Terjemahkan arahan desain menjadi kode dan alasan yang bisa langsung dipakai pengguna.',
  'internal-comms': 'Lingkungan BLEA: Anda tidak bisa membuka folder `examples/` sendiri. Jika pengguna menyebut jenis komunikasi tertentu, pakai strukturnya dari SKILL.md; jika butuh contoh format lengkap, minta pengguna memilih salah satu contoh (3p, newsletter, faq, general) agar sistem memuatkannya.',
  'web-artifacts-builder': 'Lingkungan BLEA: tidak ada shell, Node, npm, atau bundler, dan `scripts/init-artifact.sh` maupun `scripts/bundle-artifact.sh` tidak tersedia. Jangan menjanjikan menjalankan skrip itu atau mengunggah file hasil build. Hasilkan satu file HTML mandiri (CSS + JS inline, tanpa langkah build) atau blok kode terpisah beserta instruksi merakitnya. Sebutkan batas ini hanya jika relevan dengan tugas.',
};

export function findSkill(id) {
  return SKILLS.find((skill) => skill.id === id) || null;
}
