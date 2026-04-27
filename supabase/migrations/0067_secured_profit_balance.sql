-- 0067 — DAILY_HARVEST : balance de profits sécurisés (vault)
--
-- Compartiment distinct du capital de trading. Quand une position gagnante
-- est fermée en mode DAILY_HARVEST, le profit est sweepé du capital de
-- trading vers ce vault. Le vault est :
--   - Lecture seule pour Lisa (jamais réinjecté dans les décisions de trading)
--   - Lecture seule pour le user dans l'UI (visible mais pas modifiable)
--   - Source de vérité pour la "réussite" de la stratégie
--
-- Une ligne par portfolio. Cumul de tous les sweeps sur la durée de vie
-- du portfolio. Reset uniquement via une action explicite admin (jamais
-- par un cycle de reset journalier).

CREATE TABLE IF NOT EXISTS public.secured_profit_balance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id uuid NOT NULL UNIQUE REFERENCES public.portfolios(id) ON DELETE CASCADE,

  -- Cumul total des profits sécurisés (jamais décrémenté sauf reset admin)
  total_secured_usd numeric(28, 2) NOT NULL DEFAULT 0,

  -- Métriques utiles
  sweep_count integer NOT NULL DEFAULT 0,
  first_sweep_at timestamptz,
  last_sweep_at timestamptz,
  largest_single_sweep_usd numeric(28, 2),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_secured_profit_portfolio
  ON public.secured_profit_balance (portfolio_id);

ALTER TABLE public.secured_profit_balance ENABLE ROW LEVEL SECURITY;

CREATE POLICY secured_profit_owner_select
  ON public.secured_profit_balance
  FOR SELECT
  USING (
    portfolio_id IN (
      SELECT id FROM public.portfolios WHERE user_id = auth.uid()
    )
  );

-- INSERT/UPDATE réservés au service role.

COMMENT ON TABLE public.secured_profit_balance IS
  'Vault des profits journaliers sweepés en mode DAILY_HARVEST. Lecture seule depuis le runtime Lisa (jamais réinjecté en capital de trading).';
