import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Find by full ID prefix match via or filter
  const { data: before } = await sb.from('scanner_lessons').select('id, lesson_text, confidence').ilike('lesson_text', '%208710.KQ%').limit(1);
  if (!before || before.length === 0) { console.log('Lesson introuvable'); return; }
  const lesson = before[0];
  console.log(`Found ID=${lesson.id}`);
  console.log(`AVANT (${(lesson.lesson_text as string).length} chars):`);
  console.log((lesson.lesson_text as string).slice(0, 300));

  const newText = `⚠️ SAMPLE NON-VÉRIFIABLE : les trades originaux (28/05 sur portfolio Dynamique) ont été PURGÉS de lisa_positions le 30/05. Cette lesson conserve l'INTUITION du pattern mais les chiffres exacts (+2.10%, +1.89%, hold 4-5min) ne peuvent pas être audités. À RE-CONFIRMER sur les portfolios actuels (TRADER/HIGH/MIDDLE/SMALL créés le 30/05) avant de l'utiliser comme référence forte.

PATTERN À RECONFIRMER : KOSDAQ small-mid (suffix .KQ) en session asia matin (00-06 UTC). Caractéristiques observées (non-vérifiables) : changePct 3-8%, persistenceScore ≥ 0.6, TP touchable à ~2% en hold 3-5 min.

RÈGLE EXÉCUTIVE prudente pour le LLM décideur :
- TRADER tradant un .KQ avec changePct 3-8% et persistence ≥ 0.6 → conf 0.70 (pas 0.85+) tant que pas re-confirmé
- Notional 2000-3000 USD (pas 3000-4000) en mode prudent
- TP réaliste 0.5-1% (cf. constat 01/06 : MFE moyen .KQ < 1%, capture rate négatif sur TP 1.7%)
- SL 1% (pas 1.5%)
- Re-évaluer ce pattern après 10 trades confirmés sur les nouveaux portfolios`;

  const { error } = await sb.from('scanner_lessons').update({ lesson_text: newText, confidence: 0.6 }).eq('id', lesson.id);
  console.log(`\nUPDATE ${error ? 'FAILED: ' + error.message : 'OK'}`);
}
main().catch(e => { console.error(e); process.exit(1); });
