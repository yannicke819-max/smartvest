#!/usr/bin/env node
// Applique les migrations supabase/migrations/*.sql via la Management API.
// Requiert l'env var SUPABASE_ACCESS_TOKEN (PAT sbp_*) et le project ref.
// Ne stocke rien, ne log rien de secret.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
    // 503 DNS overflow sometimes transient — retry
    if (res.status === 503 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    return { ok: false, status: res.status, body };
  }
  return { ok: false, status: 0, body: 'exhausted' };
}

const files = readdirSync(new URL(MIG_DIR))
  .filter((f) => f.endsWith('.sql'))
  .sort();

console.log(`Applying ${files.length} migrations to ${PROJECT_REF}...\n`);

let successes = 0;
let failures = 0;
for (const f of files) {
  const sql = readFileSync(new URL(f, MIG_DIR), 'utf8');
  process.stdout.write(`  ${f.padEnd(45)} `);
  const r = await runSql(sql);
  if (r.ok) {
    console.log('OK');
    successes++;
  } else {
    console.log(`FAIL HTTP ${r.status}`);
    console.log('   → ', String(r.body).slice(0, 400));
    failures++;
  }
}

console.log(`\n${successes} OK · ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
