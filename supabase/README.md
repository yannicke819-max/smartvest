# Supabase — SmartVest

Schéma initial dans `migrations/0001_init_schema.sql`.

## Appliquer le schéma

```bash
npx supabase start
npx supabase db push
```

Ou bien coller le SQL via l'éditeur web Supabase pour un projet managé.

## RLS

Toutes les tables utilisateur sont en RLS, avec des policies scoped sur `auth.uid()`.
Les inserts dans `execution_audits` passent par le service role côté API (jamais depuis le front).
