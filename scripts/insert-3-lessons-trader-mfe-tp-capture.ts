/**
 * Insert 3 lessons data-driven issues de l'audit empirique MFE 01/06 03:00 UTC :
 *
 * 1. KOSDAQ_SMALL_TP_REALITY — TP visé (1.74%) trop ambitious vs MFE max observé (0.82%)
 * 2. CLOSED_CHOPPY_NORMAL_BEHAVIOR — le guard 1.2% est correctement calibré, ne pas toucher
 * 3. TRADER_CAPTURE_NEGATIVE_VS_SHADOWS — TRADER ouvre trop tôt sur explosion 1m
 *
 * Wording LLM-neutral (utilise "le LLM décideur" / "tu" plutôt que "Gemini Pro")
 * pour back-compat si on switch decideur vers Mistral / autre provider.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const lessons = [
    {
      lesson_kind: 'gate_calibration',
      scope: 'trader_agent_only',
      lesson_text:
        `KOSDAQ_SMALL_TP_REALITY — Constat 01/06 (audit empirique MFE n=4) : sur 4 trades 216080.KQ + 241520.KQ (TRADER + HIGH), MFE max observé = 0.82% alors que TP visé = 1.74%. Ratio MFE/TP = 0.47 — le TP est 2× plus haut que ce que le setup peut livrer en pratique.\n\nDONNÉE comparée (BNB MIDDLE/SMALL gagnants) : MFE 0.44-0.51%, TP visé 2.20-3.30%, capture rate 39-47%. Les wins viennent du closed_choppy qui exit au profit partiel — pas du TP touché.\n\nRÈGLE EXÉCUTIVE pour le LLM décideur :\n- Sur KOSDAQ small-cap (.KQ) en session asia morning (00-06 UTC) : TP doit être <= 0.8% (pas 1.5-2%)\n- Mieux : utiliser TP adaptatif basé sur MFE p90 historique du symbole (cf. symbol-atr-cache)\n- Le closed_choppy ferme aux niveaux de MFE atteignables ; aligner TP avec MFE réaliste évite l'illusion "TP jamais touché → trade raté"\n\nIMPACT escompté : sur les 2 KOSDAQ de ce matin, TP 0.7-0.8% au lieu de 1.74% aurait converti -$13.82 en ~+$10-15 (TP touché à MFE 0.82%).`,
      macro_condition: 'KOSDAQ_SMALL_TP_CALIBRATION',
      confidence: 0.85,
      sample_size: 4,
      win_rate_observed: 25,
      avg_pnl_usd: -3.46,
      proposed_config_change: null,
      is_active: true,
      applied: false,
    },
    {
      lesson_kind: 'risk_observation',
      scope: 'all_scanner',
      lesson_text:
        `CLOSED_CHOPPY_NORMAL_BEHAVIOR — Constat 01/06 (audit empirique n=7) : le guard peak_amplitude=1.2% dans mechanical-trading.service.ts:2049 est CORRECTEMENT calibré. Tentative de baisser à 0.5% aurait été pire (-2.79% net effect théorique vs status quo).\n\nDONNÉE : sur 6 closed_choppy all-time, MIDDLE et SMALL ont gagné (capture 39-47%) avec MFE 0.44-0.51% < 1.2%. TRADER+HIGH ont perdu (-25% capture) avec MFE 0.38-0.82% < 1.2%. La différence n'est PAS dans le guard — c'est dans l'entry timing (TRADER entre sur explosion 1m, MIDDLE/SMALL entrent sur retracement post-explosion).\n\nRÈGLE : ne pas modifier gainers_choppy_min_monotonicity ni le guard 1.2% sur peakPnl. Si le LLM décideur veut "faire respirer" un trade en early-momentum, il doit AGIR sur l'entry (attendre retracement) pas sur l'exit.\n\nNOTE technique : guard 1.2% = "peak > 1.2% → c'est un trail classique, on laisse courir". En dessous, choppy-exit s'applique. Confirmé que ça fonctionne sur sample wins MIDDLE/SMALL.`,
      macro_condition: 'CHOPPY_EXIT_GUARD_VALIDATED',
      confidence: 0.9,
      sample_size: 7,
      win_rate_observed: 29,
      avg_pnl_usd: -2.45,
      proposed_config_change: null,
      is_active: true,
      applied: false,
    },
    {
      lesson_kind: 'losing_pattern',
      scope: 'trader_agent_only',
      lesson_text:
        `TRADER_CAPTURE_NEGATIVE_VS_SHADOWS — Constat 01/06 : avec MFE comparable, TRADER capture -13% pendant MIDDLE/SMALL captures +39% à +47%. Le bug n'est PAS dans le code exit. C'est l'ENTRY TIMING.\n\nDONNÉE :\n- TRADER 216080.KQ entry sur explosion 1m → MFE peak 0.82% → chop arrive après 19min → exit -0.20%\n- MIDDLE BNB entry sur retracement post-explosion → MFE 0.51% → chop arrive APRÈS profit établi → exit +0.20% (capture 39%)\n- SMALL BNB entry similaire post-retracement → capture 47%\n\nDIFFÉRENCE : TRADER catche le chop pendant la respiration normale post-pump 1m. MIDDLE/SMALL entrent quand la respiration est déjà passée et le mouvement re-consolide.\n\nRÈGLE EXÉCUTIVE pour le LLM décideur TRADER :\n- Si candidate.change_pct > 5% ET tu détectes que le mouvement vient d'exploser (pump_age_seconds < 180s ou estimable via candles 1m), HOLD ce cycle\n- Ré-évaluer 5 min plus tard si le candidate est toujours présent ET pump_age >= 5min → entry sur retracement, pas sur pic\n- Pour les KOSDAQ .KQ qui pumpent 1m intense : attendre 1 cycle complet (5 min) après détection persistence=1.0 avant ouverture\n\nCible : porter capture rate TRADER de -13% (état actuel) à +30% minimum (parité MIDDLE/SMALL).`,
      macro_condition: 'TRADER_ENTRY_TIMING_TOO_EARLY',
      confidence: 0.8,
      sample_size: 5,
      win_rate_observed: 20,
      avg_pnl_usd: -5.06,
      proposed_config_change: null,
      is_active: true,
      applied: false,
    },
  ];

  console.log('=== INSERT 3 lessons dans scanner_lessons ===');
  for (const l of lessons) {
    const { data, error } = await sb
      .from('scanner_lessons')
      .insert({ ...l, derived_from_date: new Date().toISOString().slice(0, 10) })
      .select('id,lesson_kind,scope,macro_condition');
    if (error) {
      console.log(`  ❌ ${l.macro_condition} : ${error.message}`);
    } else {
      console.log(`  ✅ ${(data?.[0]?.id as string)?.slice(0, 8)} [${l.lesson_kind}] scope=${l.scope} macro=${l.macro_condition}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
