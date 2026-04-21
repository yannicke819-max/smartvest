#!/usr/bin/env node
// Applique les migrations supabase/migrations/*.sql via la Management API.
// Requiert l'env var SUPABASE_ACCESS_TOKEN (PAT sbp_*) et le project ref.
// Ne stocke rien, ne log rien de secret.
//
// Tracking : une table _smartvest_migrations conserve les migrations déjà
// appliquées. Seules les nouvelles sont rejouées — le script est idempotent.

import { readFileSync, readdirSync, createHash } from 'node:fs';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? 'mfuutigfhrawccotinpo';
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SUPABASE_ACCESS_TOKEN manquant.');
  process.exit(1);
}

const API = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
const MIG_DIR = new URL('../supabase/migrations/', import.meta.url);

async function runSql(sql) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    const body = await res.text();
    if (res.ok) return { ok: true, body };
    // 503 transient — retry
    if (res.status === 503 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    return { ok: false, status: res.status, body };
  }
  return { ok: false, status: 0, body: 'exhausted' };
}

// PostgreSQL error messages that indicate the object already exists.
// The Supabase Management API surfaces these in the response body.
function isAlreadyExistsError(body) {
  const s = String(body).toLowerCase();
  return (
    s.includes('already exists') ||
    s.includes('duplicate key') ||
    s.includes('42p07') || // duplicate_table
    s.includes('42710')    // duplicate_object (index, constraint, etc.)
  );
}

// Ensure tracking table exists (idempotent DDL).
const INIT_TRACKER = `
  create table if not exists _smartvest_migrations (
    filename   text primary key,
    sha256     text not null,
    applied_at timestamptz not null default now()
  );
`;
const initResult = await runSql(INIT_TRACKER);
if (!initResult.ok) {
  console.error('Impossible de créer la table de tracking :', initResult.body);
  process.exit(1);
}

// Load already-applied migrations.
const listResult = await runSql('select filename, sha256 from _smartvest_migrations order by filename;');
if (!listResult.ok) {
  console.error('Impossible de lire le tracking :', listResult.body);
  process.exit(1);
}
const applied = new Map();
try {
  const rows = JSON.parse(listResult.body);
  for (const row of Array.isArray(rows) ? rows : []) {
    applied.set(row.filename, row.sha256);
  }
} catch {
  // empty result or unexpected format — proceed with empty map
}

const files = readdirSync(new URL(MIG_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

console.log(`${files.length} migrations trouvées · ${applied.size} déjà appliquées · projet ${PROJECT_REF}\n`);

let successes = 0;
let skipped = 0;
let failures = 0;

for (const f of files) {
  const sql = readFileSync(new URL(f, MIG_DIR), 'utf8');
  const sha256 = createHash('sha256').update(sql).digest('hex');

  if (applied.has(f)) {
    process.stdout.write(`  ${f.padEnd(45)} SKIP\n`);
    skipped++;
    continue;
  }

  process.stdout.write(`  ${f.padEnd(45)} `);
  const r = await runSql(sql);

  // "already exists" errors mean the migration ran before the tracker existed.
  // Treat as already applied — record and move on.
  const alreadyExists = !r.ok && isAlreadyExistsError(r.body);

  if (r.ok || alreadyExists) {
    const label = alreadyExists ? 'ALREADY APPLIED (bootstrap)' : 'OK';
    const record = await runSql(
      `insert into _smartvest_migrations (filename, sha256) values ('${f.replace(/'/g, "''")}', '${sha256}') on conflict (filename) do nothing;`
    );
    if (!record.ok) {
      console.log(`${label} (warn: tracking write failed — ${String(record.body).slice(0, 120)})`);
    } else {
      console.log(label);
    }
    successes++;
  } else {
    console.log(`FAIL HTTP ${r.status}`);
    console.log('   → ', String(r.body).slice(0, 400));
    failures++;
  }
}

console.log(`\n${successes} appliquées · ${skipped} ignorées · ${failures} échecs`);
process.exit(failures === 0 ? 0 : 1);
