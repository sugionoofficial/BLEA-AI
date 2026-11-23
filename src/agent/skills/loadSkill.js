import generated from './skills.generated.json' with { type: 'json' };
import { SKILLS, SKILL_OVERLAYS, SOURCE, findSkill } from './manifest.js';

// The vendored Markdown travels as JSON because the same module graph is
// bundled twice: Vite for the browser (understands `?raw`) and Wrangler's
// esbuild for the Worker (does not). JSON imports work in both. Regenerate with
// `node tools/build-agent-skills.mjs`; tests fail if it is stale.
const FILES = generated?.files || {};

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Read one vendored skill file and verify it against the manifest checksum.
 * A mismatch or a missing file is a hard error, not a warning: a skill file
 * silently edited on disk is exactly what the checksum exists to catch.
 */
export async function readVerifiedSkillFile(skillId, relativePath, expectedSha256) {
  const key = `${skillId}/${relativePath}`;
  const entry = FILES[key];
  if (!entry) throw new Error(`Berkas skill tidak ditemukan: ${key}`);
  if (!expectedSha256) throw new Error(`Manifest tidak memuat checksum untuk ${key}`);
  const actual = await sha256Hex(entry.text);
  if (actual !== expectedSha256) {
    throw new Error(`Checksum skill tidak cocok: ${key} (manifest ${expectedSha256.slice(0, 12)}, berkas ${actual.slice(0, 12)})`);
  }
  return entry.text;
}

/** Synchronous verification for cheap pre-flight checks (tests, admin page). */
export function skillFileStatus(skillId, relativePath) {
  const entry = FILES[`${skillId}/${relativePath}`];
  return entry ? { present: true, sha256: entry.sha256, bytes: entry.text.length } : { present: false };
}

export function availableSkills() {
  return SKILLS.map(({ id, name, description, triggers, files, resources }) => ({
    id,
    name,
    description,
    triggers,
    files: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    resources: (resources || []).map(({ id: resourceId, description: resourceDescription, path: resourcePath }) => ({
      id: resourceId,
      description: resourceDescription,
      path: resourcePath,
    })),
  }));
}

/**
 * Cheap trigger matcher. NOT used to auto-inject skills — a 9 KB instruction
 * file loaded on a keyword false-positive costs more context than it saves.
 * The page uses it to suggest a pin; the model uses `load_skill` for the rest.
 */
export function matchSkills(text, { limit = 2 } = {}) {
  const haystack = String(text || '').toLowerCase();
  if (!haystack.trim()) return [];
  const hits = [];
  for (const skill of SKILLS) {
    const matched = skill.triggers.filter((trigger) => haystack.includes(trigger.toLowerCase()));
    if (matched.length) hits.push({ skill, matched, score: matched.length });
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.skill);
}

/**
 * Build the system-prompt section for a loaded skill. Includes provenance so
 * the model cannot present the guidance as Anthropic-endorsed, and keeps the
 * licence file in the repo for redistribution compliance.
 */
export async function loadSkillSection(skillId, { resourceId = '' } = {}) {
  const skill = findSkill(skillId);
  if (!skill) throw new Error(`Skill tidak dikenal: ${skillId}`);

  const skillEntry = skill.files.find((file) => file.path === 'SKILL.md');
  const skillMd = await readVerifiedSkillFile(skill.id, 'SKILL.md', skillEntry.sha256);

  const parts = [
    `## Panduan aktif: ${skill.name} (\`${skill.id}\`)`,
    `Sumber: ${SOURCE.repo} · lisensi ${SOURCE.license} · teks verbatim, checksum terverifikasi. Ini panduan pihak ketiga, bukan fitur produk Anthropic dan tidak disponsori Anthropic; perlakukan sebagai saran yang sudah ditinjau.`,
  ];

  if (resourceId) {
    const resource = (skill.resources || []).find((item) => item.id === resourceId);
    if (!resource) {
      throw new Error(`Contoh "${resourceId}" tidak ada untuk skill ${skill.id}. Pilihan: ${(skill.resources || []).map((item) => item.id).join(', ')}`);
    }
    const resourceText = await readVerifiedSkillFile(skill.id, resource.path, resource.sha256);
    parts.push(`### Contoh format: ${resource.id} — ${resource.description}`, resourceText.trim());
  }

  parts.push(skillMd.trim());

  const overlay = SKILL_OVERLAYS[skill.id];
  if (overlay) parts.push('### Batasan lingkungan BLEA', overlay);

  return parts.join('\n\n');
}

export { FILES as skillFiles };
