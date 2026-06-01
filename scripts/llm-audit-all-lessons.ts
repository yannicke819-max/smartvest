/**
 * Audit LARGE de toutes les lessons (active + inactive) cherchant TOUTE mention
 * d'un LLM par nom : Gemini, Mistral, Claude, GPT, OpenAI, Anthropic, Pro,
 * Flash, Sonnet, Opus, Haiku, etc.
 *
 * Reporte chaque match avec contexte (10 chars avant/après) pour qu'on puisse
 * décider lesson par lesson si neutraliser ou conserver.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const LLM_PATTERNS = [
  /\bGemini\b/g,
  /\bMistral\b/g,
  /\bClaude\b/g,
  /\bGPT\b/g,
  /\bOpenAI\b/g,
  /\bAnthropic\b/g,
  /\b(2\.5\s+Pro|2\.5\s+Flash)\b/g,
  /\bSonnet\b/g,
  /\bOpus\b/g,
  /\bHaiku\b/g,
];

async function main() {
  const { data: lessons } = await sb
    .from('scanner_lessons')
    .select('id, lesson_kind, scope, macro_condition, lesson_text, is_active');

  if (!lessons) return;

  console.log(`Total lessons (active + inactive) = ${lessons.length}\n`);
  console.log(`Active = ${lessons.filter(l => l.is_active).length}\n`);

  let hit = 0;
  const byProvider: Record<string, number> = {};

  for (const l of lessons) {
    const text = (l.lesson_text as string) ?? '';
    const matches: Array<{ pattern: string; match: string; context: string }> = [];

    for (const pattern of LLM_PATTERNS) {
      const regex = new RegExp(pattern);
      let m: RegExpExecArray | null;
      const r = new RegExp(pattern.source, pattern.flags);
      while ((m = r.exec(text)) !== null) {
        const start = Math.max(0, m.index - 20);
        const end = Math.min(text.length, m.index + m[0].length + 20);
        const context = text.slice(start, end).replace(/\n/g, ' ');
        matches.push({ pattern: pattern.source, match: m[0], context });
        byProvider[m[0]] = (byProvider[m[0]] || 0) + 1;
      }
    }

    if (matches.length > 0) {
      hit++;
      console.log(`\n${l.id?.slice(0,8)} [${l.lesson_kind}] active=${l.is_active} scope=${l.scope} macro=${l.macro_condition}`);
      const unique = new Set<string>();
      for (const m of matches) {
        const key = `${m.match}::${m.context}`;
        if (unique.has(key)) continue;
        unique.add(key);
        console.log(`  → "${m.match}" : ...${m.context}...`);
      }
    }
  }

  console.log(`\n${'═'.repeat(80)}`);
  console.log(`Lessons avec LLM mention : ${hit}/${lessons.length}`);
  console.log('\nProviders fréquence :');
  for (const [k, v] of Object.entries(byProvider).sort((a,b) => b[1] - a[1])) {
    console.log(`  "${k}": ${v}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
