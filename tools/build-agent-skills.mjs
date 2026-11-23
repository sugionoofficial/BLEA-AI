// Generates src/agent/skills/skills.generated.json from the vendored Markdown.
//
// Why a generated JSON instead of importing the .md files directly: the client
// bundle is built by Vite (which understands `?raw` and `import.meta.glob`) but
// the same modules are also bundled by Wrangler's esbuild for the Worker, which
// understands neither. JSON imports work in both. Keeping one generated file
// also means `tests/agent-skills.test.js` can assert the JSON matches the
// Markdown on disk, so the two can never drift apart.
//
// Usage: node tools/build-agent-skills.mjs [--check]
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const skillsDir = path.join(root, 'src/agent/skills');
const outFile = path.join(skillsDir, 'skills.generated.json');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (/\.(md|txt)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

const files = {};
for (const file of (await walk(skillsDir)).sort()) {
  const relative = path.relative(skillsDir, file).split(path.sep).join('/');
  const text = await readFile(file, 'utf8');
  files[relative] = {
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  };
}

const payload = `${JSON.stringify({ generatedAt: 'vendored-source-of-truth', files }, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outFile, 'utf8').catch(() => '');
  if (current !== payload) {
    console.error('skills.generated.json sudah tidak sinkron dengan berkas Markdown. Jalankan: node tools/build-agent-skills.mjs');
    process.exit(1);
  }
  console.log('skills.generated.json sinkron.');
} else {
  await writeFile(outFile, payload);
  console.log(`Ditulis ${path.relative(root, outFile)} (${Object.keys(files).length} berkas).`);
}
