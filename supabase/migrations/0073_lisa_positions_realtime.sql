-- Active Supabase Realtime sur lisa_positions.
--
-- Pourquoi : le mécanique (cron 60s) ouvre/ferme des positions de manière
-- programmatique, sans interaction UI. Sans Realtime, le hook front
-- `useLisaPositions` doit polling 5-30s avant de voir une nouvelle ligne →
-- l'utilisateur voit "1 position" alors que le bot vient d'ouvrir RTX
-- (incident 27/04 : RTX ouvert 19:14 UTC, UI affichait toujours 1 seule
-- position pendant 30s).
--
-- Cette migration ajoute lisa_positions au publication supabase_realtime.
-- Le hook `useLisaPositionsRealtime` côté front peut alors invalider la
-- query React Query dès qu'un INSERT/UPDATE/DELETE arrive sur la table.
--
-- Idempotent : ne fait rien si la table est déjà dans la publication.
-- Cf. fix/lisa-positions-refetch-realtime (PR E suite incident 27/04).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lisa_positions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lisa_positions;
  END IF;
END $$;
