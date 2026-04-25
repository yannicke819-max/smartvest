-- 0061 — Lisa positions : autonomyRules pour décisions H24 hors cycle Lisa
--
-- Contexte : actuellement le mécanique ne peut que déclencher les stops et
-- targets quantifiés au moment de l'ouverture. Entre 2 cycles Lisa (toutes
-- les 20 min), si VIX double ou si BTC casse un support, le mécanique attend
-- passivement le prochain wake-up Lisa (max 8/jour).
--
-- AutonomyRules permettent à Lisa de transmettre, avec chaque thèse, des
-- conditions de déclenchement et actions à exécuter en autonomie 24h/24 par
-- le mécanique. Format JSON stocké :
--
--   [
--     { metric: 'vix', op: 'gt', value: 25, action: 'close', reason: '...' },
--     { metric: 'price', op: 'lt', value: 76000, action: 'close', reason: '...' },
--     { metric: 'funding_annual_pct', op: 'gt', value: 1, action: 'tighten_stop', reason: '...' },
--   ]
--
-- Évalués à chaque cycle mécanique (60s) par AutonomyRuleEvaluatorService.
-- Trace dans lisa_decision_log (kind='autonomous_rule_triggered').
--
-- Aligné CLAUDE.md : reste dans le cadre AUTONOMOUS_GUARDED car les règles
-- sont définies par Lisa elle-même, pas inférées par le mécanique.

ALTER TABLE public.lisa_positions
  ADD COLUMN IF NOT EXISTS autonomy_rules jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.lisa_positions.autonomy_rules IS
  'Règles d''autonomie transmises avec la thèse Lisa. Évaluées toutes les 60s par le mécanique. Format : array de {metric, op, value, action, reason}.';
