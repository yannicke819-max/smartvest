-- Lisa option positions (sim paper-broker only).
--
-- Stocke les positions options ouvertes par Lisa : long calls et long puts
-- pour l'instant. Short options (besoin de marge specifications) viendront
-- dans une migration ultérieure.
--
-- Mark-to-market quotidien via Black-Scholes pricer (@smartvest/options).
-- Pas d'historical IV surface : IV constante par position (fixée à
-- l'ouverture), bonne approximation pour des holds courts (<60 jours).

CREATE TABLE IF NOT EXISTS public.lisa_option_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.portfolios(id) ON DELETE CASCADE,
  proposal_id uuid NULL,
  thesis_id uuid NULL,

  -- Identification du contrat
  underlying text NOT NULL,
  asset_class text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('call', 'put')),
  direction text NOT NULL CHECK (direction IN ('long')) DEFAULT 'long',
  strike numeric(14, 4) NOT NULL,
  expiry date NOT NULL,
  contracts numeric(10, 2) NOT NULL,

  -- Pricing à l'ouverture
  entry_underlying_price numeric(14, 4) NOT NULL,
  entry_iv numeric(6, 4) NOT NULL,
  premium_paid_usd numeric(14, 4) NOT NULL,
  entry_timestamp timestamptz NOT NULL DEFAULT now(),
  entry_fee_usd numeric(10, 4) NOT NULL DEFAULT 0,

  -- Statut
  status text NOT NULL CHECK (status IN ('open', 'closed_expired', 'closed_target', 'closed_stop', 'closed_invalidated')) DEFAULT 'open',
  exit_underlying_price numeric(14, 4) NULL,
  exit_value_usd numeric(14, 4) NULL,
  exit_timestamp timestamptz NULL,
  exit_fee_usd numeric(10, 4) NULL,
  realized_pnl_usd numeric(14, 4) NULL,
  realized_pnl_pct numeric(8, 4) NULL,

  -- Conviction Lisa (proxy de qualité du setup)
  conviction_score numeric(3, 1) NULL,

  -- Source : 'lisa' (proposition validée) | 'mechanical' (directive auto)
  source text NOT NULL DEFAULT 'lisa',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lisa_option_positions_portfolio_status
  ON public.lisa_option_positions(portfolio_id, status, expiry);

CREATE INDEX IF NOT EXISTS idx_lisa_option_positions_underlying
  ON public.lisa_option_positions(underlying);

ALTER TABLE public.lisa_option_positions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'lisa_option_positions' AND policyname = 'lisa_option_positions_owner'
  ) THEN
    CREATE POLICY lisa_option_positions_owner ON public.lisa_option_positions FOR ALL
      USING (
        portfolio_id IN (SELECT id FROM public.portfolios WHERE user_id = auth.uid())
      )
      WITH CHECK (
        portfolio_id IN (SELECT id FROM public.portfolios WHERE user_id = auth.uid())
      );
  END IF;
END $$;

COMMENT ON TABLE public.lisa_option_positions IS 'Positions options Lisa (sim paper-broker, long only pour l''instant).';
COMMENT ON COLUMN public.lisa_option_positions.entry_iv IS 'IV utilisée à l''ouverture, fixe pendant la durée de vie de la position.';
COMMENT ON COLUMN public.lisa_option_positions.premium_paid_usd IS 'Premium total payé (par contrat × contracts × 100, fees inclus).';
