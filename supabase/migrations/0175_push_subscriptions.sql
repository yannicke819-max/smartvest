-- Migration 0175 — push_subscriptions (LISA refonte B.4.c).
--
-- Stocke les subscriptions Web Push API par user. Un user peut avoir
-- plusieurs subscriptions (mobile + desktop). Endpoint UNIQUE per user
-- (re-subscribe → upsert).

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid NOT NULL,
  -- Push service endpoint (Firebase Cloud Messaging, Mozilla Autopush, etc.)
  endpoint text NOT NULL,
  -- ECDH public key (base64url) côté client
  p256dh text NOT NULL,
  -- Auth secret (base64url) côté client
  auth text NOT NULL,
  -- User-Agent à la souscription (debug)
  user_agent text,
  -- Dernier envoi réussi (debug + cleanup endpoints stale)
  last_sent_at timestamptz,
  last_error text
);

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_user_endpoint_idx
  ON public.push_subscriptions (user_id, endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "push_subscriptions_select_owner" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_select_owner" ON public.push_subscriptions
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "push_subscriptions_insert_owner" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_insert_owner" ON public.push_subscriptions
  FOR INSERT WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "push_subscriptions_delete_owner" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_delete_owner" ON public.push_subscriptions
  FOR DELETE USING (user_id = auth.uid());

COMMENT ON TABLE public.push_subscriptions IS
'Web Push API subscriptions LISA B.4.c. Service-role peut envoyer ; user voit/supprime ses propres rows.';

NOTIFY pgrst, 'reload schema';
