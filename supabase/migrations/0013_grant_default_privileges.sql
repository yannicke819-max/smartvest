-- Grants explicites pour anon / authenticated sur le schéma public.
-- Les tables sont créées via la Supabase Management API (script apply-migrations.mjs)
-- qui n'hérite pas des default privileges automatiques de Supabase Studio.
-- Sans ces grants, une requête depuis le navigateur avec la clé anon échoue sur
-- "permission denied for table X" AVANT même que les policies RLS soient évaluées.
-- RLS reste actif : les utilisateurs ne voient que leurs propres lignes via les
-- policies existantes (user_id = auth.uid()).

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;

grant usage, select on all sequences in schema public to authenticated;

-- Pour que les futures tables créées dans public héritent des mêmes privilèges.
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant select on tables to anon;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;
