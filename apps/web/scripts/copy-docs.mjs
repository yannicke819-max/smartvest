/**
 * Copie les docs Markdown publics depuis `docs/` (repo root) vers
 * `apps/web/content/docs/` afin qu'ils soient bundled avec l'app web
 * sur Vercel (sinon `fs.readFileSync(docs/...)` retourne 404 à runtime).
 *
 * Exécuté en prebuild + predev (cf. package.json scripts).
 *
 * Liste blanche stricte — les docs internes (CLAUDE.md, README dev,
 * .claude/skills/*) ne sont JAMAIS copiés. Cf. apps/web/src/lib/help-docs.ts
 * pour les docs exposés à l'utilisateur.
 */

import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
const DEST = join(WEB_ROOT, 'content', 'docs');

// Liste explicite. Synchroniser avec apps/web/src/lib/help-docs.ts.
const FILES = [
  'docs/audit-2026-04.md',
  'docs/BROKER_CONNECTIONS.md',
  'docs/DEPLOY.md',
];

mkdirSync(DEST, { recursive: true });

let copied = 0;
let missing = 0;
for (const rel of FILES) {
  const src = join(REPO_ROOT, rel);
  if (!existsSync(src)) {
    console.warn(`[copy-docs] missing source: ${rel}`);
    missing++;
    continue;
  }
  const filename = rel.split('/').pop();
  const dst = join(DEST, filename);
  copyFileSync(src, dst);
  copied++;
}

console.log(`[copy-docs] ${copied} copied, ${missing} missing → ${DEST}`);
