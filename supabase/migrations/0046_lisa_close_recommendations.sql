-- Lisa peut désormais recommander la fermeture de positions existantes
-- (en plus d'en ouvrir de nouvelles). Stocké côté proposal pour audit.
--
-- Format : Array<{ positionId: uuid, reason: string }>

alter table lisa_proposals
  add column if not exists close_recommendations jsonb not null default '[]'::jsonb;

comment on column lisa_proposals.close_recommendations is
  'Liste des positions que Lisa recommande de fermer à l''approbation de cette proposition.';
