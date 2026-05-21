-- Micro-momentum probes — expérience shadow d'entrée haute fréquence (crypto).
--
-- Hypothèse à mesurer : X échantillons haussiers consécutifs + vitesse de
-- croissance suffisante prédisent-ils un forward-return positif net de frais à
-- un horizon de quelques minutes ? On échantillonne le prix spot Binance à
-- cadence fine (~secondes — pas 100ms, infaisable à notre latence d'exécution),
-- on détecte un trigger (run haussier + vélocité), on enregistre une "probe",
-- puis un cron résout le forward-return aux horizons via les klines 1m existantes.
--
-- 100% mesure, ZÉRO trade : aucune position n'est ouverte. Sert à prouver (ou
-- réfuter) l'edge AVANT d'envisager un quelconque déploiement. Gated OFF par
-- défaut (MICRO_MOMENTUM_ENABLED). Append-only, fire-and-forget.

CREATE TABLE IF NOT EXISTS micro_momentum_probes (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  trigger_ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entry_price NUMERIC(20,8) NOT NULL,
  -- Nb d'échantillons strictement haussiers consécutifs au moment du trigger.
  run_length INT NOT NULL,
  -- Cadence d'échantillonnage effective (ms) — pour interpréter run_length.
  sample_interval_ms INT NOT NULL,
  -- Vitesse de croissance sur le run : %/seconde.
  velocity_pct_per_s NUMERIC(14,8) NOT NULL,
  -- Accélération sur le run : (%/s) par seconde. NULL si run trop court.
  acceleration_pct_per_s2 NUMERIC(14,8),
  -- Forward-returns par horizon, résolus a posteriori depuis les klines 1m.
  -- Shape: [{ "horizon_min": 1, "ret_pct": 0.004, "ret_net_pct": 0.002 }, ...]
  forward_returns JSONB,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_micro_momentum_probes_unresolved
  ON micro_momentum_probes(trigger_ts) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_micro_momentum_probes_symbol
  ON micro_momentum_probes(symbol, trigger_ts DESC);

COMMENT ON TABLE micro_momentum_probes IS
  'Expérience shadow micro-momentum crypto : run haussier + vélocité → forward-return net de frais. Mesure pure, aucun trade.';
