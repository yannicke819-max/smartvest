-- Active Supabase Realtime sur lisa_session_configs.
--
-- Permet à un device de voir en temps réel les changements de config faits
-- depuis un autre device. Sans cette publication, l'UI doit refresh manuel
-- pour voir une modification faite sur mobile vs ordi.
--
-- Idempotent : ne fait rien si la table est déjà dans la publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'lisa_session_configs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.lisa_session_configs;
  END IF;
END $$;
