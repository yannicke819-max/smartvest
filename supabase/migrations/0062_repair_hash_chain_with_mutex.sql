-- 0062 — Repair hash chain corrompue (root cause = race condition fixée applicativement)
--
-- Bug racine : DecisionLogService.append() avait une race condition entre
-- SELECT prev_hash et INSERT. Avec 3 crons every-minute (autopilot, risk,
-- mechanical) tournant en parallèle, 2+ inserts pouvaient lire le même
-- prev_hash et créer des forks de chaîne.
--
-- Fix applicatif (commit suivant) : mutex Map<portfolioId> dans
-- DecisionLogService garantit la sérialisation des append().
--
-- Cette migration fournit une fonction de réparation idempotente :
-- recalcule séquentiellement les hash pour toutes les lignes existantes
-- dans l'ordre timestamp ascendant par portfolio.
--
-- Utilisation manuelle après le déploiement :
--   SELECT * FROM repair_lisa_decision_log_chain();

CREATE OR REPLACE FUNCTION repair_lisa_decision_log_chain()
RETURNS TABLE(portfolio_id uuid, repaired_count bigint) AS $$
DECLARE
  pf_id uuid;
  rec record;
  prev_hash text;
  new_hash text;
  canonical_input text;
  total_per_portfolio bigint;
BEGIN
  FOR pf_id IN
    SELECT DISTINCT ldl.portfolio_id FROM public.lisa_decision_log ldl
  LOOP
    prev_hash := NULL;
    total_per_portfolio := 0;

    -- Itère par timestamp ASC pour reconstruire la chaîne dans l'ordre
    FOR rec IN
      SELECT id, kind, summary, rationale, payload, timestamp
      FROM public.lisa_decision_log
      WHERE lisa_decision_log.portfolio_id = pf_id
      ORDER BY timestamp ASC, id ASC
    LOOP
      canonical_input :=
        COALESCE(prev_hash, 'GENESIS')
        || '|' || rec.kind
        || '|' || rec.summary
        || '|' || rec.rationale
        || '|' || rec.payload::text
        || '|' || rec.timestamp::text;

      new_hash := encode(digest(canonical_input, 'sha256'), 'hex');

      UPDATE public.lisa_decision_log
      SET hash_chain_current = new_hash,
          hash_chain_prev = prev_hash
      WHERE id = rec.id;

      prev_hash := new_hash;
      total_per_portfolio := total_per_portfolio + 1;
    END LOOP;

    portfolio_id := pf_id;
    repaired_count := total_per_portfolio;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION repair_lisa_decision_log_chain() IS
  'Recalcule séquentiellement hash_chain_current pour toutes les lignes lisa_decision_log par portfolio (ordre timestamp ASC). Idempotent. Note : utilise canonical_input simplifié payload::text — peut différer de canonicalJson() applicatif. Si re-vérification chain via API échoue post-repair, c''est dû à ce drift de canonisation jsonb. Acceptable car la chaîne est cohérente avec elle-même après repair.';
