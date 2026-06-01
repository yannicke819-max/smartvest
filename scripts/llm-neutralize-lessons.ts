/**
 * Audit + nettoyage rétroactif des lessons qui mentionnent un LLM par nom.
 *
 * Politique :
 * - "Gemini Pro" / "Gemini 2.5 Pro" → "le LLM décideur" ou "tu" selon contexte
 * - "Gemini Flash" / "Gemini" générique → "le LLM" ou "decideur"
 * - "Mistral Medium 3.5" / "Mistral Large 3" / "Mistral" → CONSERVÉ si c'est
 *   un fait observé sur ce provider précis (bug spécifique, output format)
 *
 * Mode dry-run par défaut. Lancer avec --apply pour effectuer les UPDATE.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const APPLY = process.argv.includes('--apply');

// Patterns d'instructions LLM (à neutraliser) vs faits observés (à conserver)
function neutralizeLessonText(text: string, id: string): { newText: string; changed: boolean; reason: string } {
  let out = text;
  const transforms: string[] = [];

  // Cas 1 : "Gemini Pro doit" / "Gemini Pro applique" / "Gemini Pro VA" — instruction/observation comportementale
  if (/Gemini Pro\s+(doit|applique|va|propose|appliquait|fait|ignore|suit)/i.test(out)) {
    out = out.replace(/Gemini Pro\s+doit/gi, 'le LLM décideur doit');
    out = out.replace(/Gemini Pro\s+applique/gi, 'le LLM décideur applique');
    out = out.replace(/Gemini Pro\s+va/gi, 'le LLM décideur va');
    out = out.replace(/Gemini Pro\s+propose/gi, 'le LLM décideur propose');
    out = out.replace(/Gemini Pro\s+appliquait/gi, 'le LLM décideur appliquait');
    out = out.replace(/Gemini Pro\s+fait/gi, 'le LLM décideur fait');
    out = out.replace(/Gemini Pro\s+ignore/gi, 'le LLM décideur ignore');
    out = out.replace(/Gemini Pro\s+suit/gi, 'le LLM décideur suit');
    transforms.push('Gemini Pro behavior → "le LLM décideur"');
  }

  // Cas 2 : "côté prompt Gemini Pro" → "côté prompt LLM décideur"
  if (/c[oô]t[eé]\s+prompt\s+Gemini/i.test(out)) {
    out = out.replace(/c([oô])t([eé])\s+prompt\s+Gemini\s+Pro/gi, 'côté prompt LLM décideur');
    out = out.replace(/c([oô])t([eé])\s+prompt\s+Gemini/gi, 'côté prompt LLM décideur');
    transforms.push('côté prompt → neutre');
  }

  // Cas 3 : "système prompt Gemini" → générique
  if (/(syst[èe]me|persona|prompt)\s+Gemini\s+Pro/i.test(out)) {
    out = out.replace(/(syst[èe]me|persona|prompt)\s+Gemini\s+Pro/gi, '$1 LLM décideur');
    transforms.push('système/persona/prompt Gemini Pro → LLM décideur');
  }

  // Cas 4 : "RÈGLE pour Gemini Pro" → "RÈGLE TRADER"
  if (/(RÈGLE|R[ÈE]GLE)\s+pour\s+Gemini\s+Pro/i.test(out)) {
    out = out.replace(/(RÈGLE|R[ÈE]GLE)\s+pour\s+Gemini\s+Pro/gi, '$1 EXÉCUTIVE pour le LLM décideur');
    transforms.push('RÈGLE pour Gemini Pro → générique');
  }

  // Cas 5 : "Gemini Pro" tout seul comme sujet — context-aware safer replace
  if (out.includes('Gemini Pro')) {
    out = out.replace(/Gemini Pro/g, 'le LLM décideur');
    transforms.push('Gemini Pro résiduel → LLM décideur');
  }

  // Cas 6 : "Gemini 2.5 Pro" / "Gemini 2.5"
  if (/Gemini\s+2\.5\s+Pro/i.test(out)) {
    out = out.replace(/Gemini\s+2\.5\s+Pro/gi, 'le LLM décideur');
    transforms.push('Gemini 2.5 Pro → LLM décideur');
  }

  // Cas 7 : Résiduel "Gemini" (sans Pro) en tant que sujet/verbe
  if (/Gemini\s+(ouvre|propose|fait|suit|applique|prend|décide|évalue|considère|teste)/i.test(out)) {
    out = out.replace(/Gemini\s+(ouvre|propose|fait|suit|applique|prend|décide|évalue|considère|teste)/gi, 'le LLM décideur $1');
    transforms.push('Gemini résiduel + verbe → LLM décideur');
  }

  // Cas 8 : Résiduel "Pro" comme raccourci de Gemini Pro (sans Mistral Pro etc.)
  if (/\bsi\s+Pro\s+(suit|doit|va|fait|propose)/i.test(out)) {
    out = out.replace(/\bsi\s+Pro\s+(suit|doit|va|fait|propose)/gi, 'si le LLM décideur $1');
    transforms.push('"si Pro" résiduel → LLM décideur');
  }
  if (/\bc[ôo]t[eé]\s+Pro\b/i.test(out)) {
    out = out.replace(/c([ôo])t([eé])\s+Pro\b/gi, 'côté LLM décideur');
    transforms.push('"côté Pro" résiduel → LLM décideur');
  }

  // Cas 9 : Mistral mentions — CONSERVÉ (faits observés spécifiques au provider).

  return { newText: out, changed: out !== text, reason: transforms.join(' + ') };
}

async function main() {
  const { data: lessons, error } = await sb
    .from('scanner_lessons')
    .select('id, lesson_kind, scope, macro_condition, lesson_text, is_active, confidence')
    .eq('is_active', true);

  if (error) { console.error('Err:', error.message); process.exit(1); }
  if (!lessons) return;

  console.log(`Total lessons actives = ${lessons.length}\n`);
  console.log(`Mode = ${APPLY ? 'APPLY (effectue les UPDATE)' : 'DRY-RUN (--apply pour effectuer)'}\n`);

  let changedCount = 0;
  for (const l of lessons) {
    const { newText, changed, reason } = neutralizeLessonText(l.lesson_text as string, l.id as string);
    if (!changed) continue;
    changedCount++;

    console.log(`\n${'═'.repeat(80)}`);
    console.log(`ID=${l.id?.slice(0,8)} [${l.lesson_kind}] scope=${l.scope} macro=${l.macro_condition}`);
    console.log(`Transforms: ${reason}`);
    console.log(`\n--- AVANT (${(l.lesson_text as string).length} chars) ---`);
    console.log((l.lesson_text as string).slice(0, 400) + ((l.lesson_text as string).length > 400 ? '...' : ''));
    console.log(`\n--- APRÈS ---`);
    console.log(newText.slice(0, 400) + (newText.length > 400 ? '...' : ''));

    if (APPLY) {
      const { error: upErr } = await sb.from('scanner_lessons').update({ lesson_text: newText }).eq('id', l.id);
      if (upErr) console.log(`  ❌ UPDATE failed: ${upErr.message}`);
      else console.log(`  ✅ UPDATED`);
    }
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Lessons modifiées : ${changedCount}/${lessons.length}`);
  if (!APPLY && changedCount > 0) console.log(`\n→ Pour appliquer : npx tsx scripts/llm-neutralize-lessons.ts --apply`);
}

main().catch(e => { console.error(e); process.exit(1); });
