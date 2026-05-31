/**
 * Insert 4 lessons issues de la session 31/05/2026 :
 *   1. trail_stop min pct par classe (exit_rule)
 *   2. MFE trigger threshold (risk_observation)
 *   3. Mistral Large empty string normalization (gate_calibration)
 *   4. TRADER capture rate negative pattern (losing_pattern)
 *
 * Ces lessons enrichissent automatiquement le system prompt de Gemini Pro
 * (via ScannerLessonsContextService) → Pro évite naturellement de proposer
 * trail_stop trop tight sans nécessiter le clamp côté code.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const lessons = [
    {
      lesson_kind: 'exit_rule',
      scope: 'trader_agent_only',
      lesson_text:
        `TRAIL_STOP MIN PCT PAR CLASSE — Constat 31/05 : BNBUSDT TRADER capture rate -481% car Gemini Pro applique trail_stop avec slPct=0.15% sur crypto. MFE +0.05% → SL touché 56min après → -0.24%. La volatilité crypto naturelle est 0.2-0.5%/min, donc trail < 0.5% = SL touché par bruit normal.\n\nRÈGLE EXÉCUTIVE :\n- Si symbol matche /USDT$|USDC$|BUSD$/ → trail_stop slPct >= 0.5% obligatoire\n- Si symbol equity (US/EU/Asia) → trail_stop slPct >= 0.3% obligatoire\n- Privilégier trail à 1.0% (plage normale, garde sécurité)\n- Ne jamais proposer slPct < ces seuils, le code clamp désormais (live-trader-agent.service.ts:2043)\n\nMOTIVATION : un trail_stop n'a de sens que s'il sort plus tard qu'un SL fixe normal, pas plus tôt sur du bruit.`,
      macro_condition: 'TRAIL_STOP_CRYPTO',
      confidence: 0.95,
      sample_size: 1,
      win_rate_observed: 0,
      avg_pnl_usd: -3.36,
      proposed_config_change: { TRADER_TRAIL_STOP_MIN_PCT_CRYPTO: '0.5', TRADER_TRAIL_STOP_MIN_PCT_EQUITY: '0.3' },
      is_active: true,
      applied: false,
    },
    {
      lesson_kind: 'risk_observation',
      scope: 'trader_agent_only',
      lesson_text:
        `MFE TRIGGER THRESHOLD — Constat 31/05 BNBUSDT TRADER : trail_stop déclenché sur MFE+0.05% (micro-blip de 36 cents sur BNB à $721) alors que la moyenne historique MFE des positions gagnantes est +0.48% (data 15j n=20, cf. trailing-stop.helper.ts).\n\nRÈGLE EXÉCUTIVE : ne JAMAIS proposer trail_stop si peak actuel - entry < 0.30% (long) ou entry - peak < 0.30% (short). C'est en deçà du bruit naturel intraday → décision prématurée.\n\nCONTEXTE pour Gemini Pro : avant de proposer trail_stop, vérifier mentalement (peak - entry) / entry > 0.003. Si non, hold ou close (selon thesis), pas trail.`,
      macro_condition: 'MFE_TRIGGER',
      confidence: 0.9,
      sample_size: 16,
      win_rate_observed: 0,
      avg_pnl_usd: -6.5,
      proposed_config_change: null,
      is_active: true,
      applied: false,
    },
    {
      lesson_kind: 'gate_calibration',
      scope: 'all_scanner',
      lesson_text:
        `MISTRAL LARGE 3 NORMALIZE EMPTY FIELDS — Constat 31/05 : Mistral Large 3 retourne target_symbol="" (string vide) au lieu de null/absent quand action_kind=hold. Bug de comparison shadows : 0% concordance artificielle sur 31/31 calls (vs ~66% concordance Mistral Medium 3.5).\n\nRÈGLE EXÉCUTIVE pour prompt engineering A/B shadow : tout comparator concordance doit coerce empty string → null avant equality check. Helper nullify() implémenté dans live-trader-agent.service.ts:recordAbShadow.\n\nIMPLICATION : si on étend A/B à d'autres providers (Claude Haiku, Magistral), tester output format hold + target avant le déploiement.`,
      macro_condition: 'LLM_OUTPUT_NORMALIZATION',
      confidence: 0.95,
      sample_size: 31,
      win_rate_observed: 0,
      avg_pnl_usd: 0,
      proposed_config_change: null,
      is_active: true,
      applied: true,
    },
    {
      lesson_kind: 'losing_pattern',
      scope: 'trader_agent_only',
      lesson_text:
        `TRAILING BREAKEVEN COUPLÉ FEES_AWARE_BUFFER PEUT SUR-DÉCLENCHER — Sur TRADER avec gainers_fees_aware_buffer=2 + GAINERS_TRAILING_STOP_ACTIVATION_PCT=0.003, la combinaison peut tighten SL à entry-0.15% si Pro suit le path. Sur crypto où la volatilité est ~0.3%/min normale, c'est un SL touché quasi-garanti dans les 10 minutes.\n\nDONNÉE : sample n=16 trades TRADER depuis 20/05, MAE/R médian 1.78 (vs MAIN 1.03, healthy 0.6-0.85), capture rate -45.8%. Σ realized -$104, Σ potential +$172, ~$276 left on table.\n\nRÈGLE EXÉCUTIVE : Gemini Pro doit considérer le SL effectif post-breakeven AVANT de proposer trail_stop. Ne proposer trail_stop QUE si :\n  (a) peak >= entry × 1.005 (≥0.5% MFE confirmé)\n  (b) momentum encore positif (ch1m > 0)\n  (c) thesis intact\nSinon : hold (laisse SL initial fonctionner naturellement).`,
      macro_condition: 'TRADER_CAPTURE_RATE_NEGATIVE',
      confidence: 0.85,
      sample_size: 16,
      win_rate_observed: 25,
      avg_pnl_usd: -6.5,
      proposed_config_change: { note: 'Action côté prompt Gemini Pro, pas config' },
      is_active: true,
      applied: false,
    },
  ];

  console.log('=== INSERT 4 lessons dans scanner_lessons ===');
  for (const l of lessons) {
    const { data, error } = await sb
      .from('scanner_lessons')
      .insert({ ...l, derived_from_date: new Date().toISOString().slice(0, 10) })
      .select('id,lesson_kind,scope');
    if (error) {
      console.log(`  ❌ ${l.lesson_kind} : ${error.message}`);
    } else {
      console.log(`  ✅ ${(data?.[0]?.id as string)?.slice(0, 8)} ${l.lesson_kind} scope=${l.scope}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
