/**
 * Catalogue des docs Markdown exposés dans /help.
 *
 * Discipline compliance (CLAUDE.md §1) : on n'expose JAMAIS les docs
 * internes (CLAUDE.md, .claude/skills/*, README dev) qui contiennent
 * du wording réservé aux développeurs ou des secrets de positionnement.
 *
 * Tout nouveau doc destiné aux utilisateurs doit être ajouté ici.
 */

export interface HelpDocEntry {
  /** Slug URL : /help/[slug] */
  slug: string;
  /** Chemin relatif au repo root */
  path: string;
  /** Titre affiché dans l'index et la page */
  title: string;
  /** Description courte sous le titre */
  description: string;
  /** Catégorie pour grouper l'index */
  category: 'audit' | 'guide' | 'admin' | 'concept';
  /** Visible dans le menu principal de /help (sinon accessible mais pas listé) */
  listed: boolean;
}

export const HELP_DOCS: HelpDocEntry[] = [
  // ── Guides utilisateur ───────────────────────────────────────────
  {
    slug: 'premiers-pas',
    path: 'docs/guides/premiers-pas.md',
    title: 'Premiers pas sur SmartVest',
    description: 'De la création de votre profil à votre premier tableau de bord — guide débutant.',
    category: 'guide',
    listed: true,
  },
  {
    slug: 'simuler-sans-risque',
    path: 'docs/guides/simuler-sans-risque.md',
    title: 'Simuler sans risque',
    description: 'Comprendre le mode simulation : portefeuille virtuel, paper trading, réinitialisation.',
    category: 'guide',
    listed: true,
  },
  {
    slug: 'lire-votre-tableau-de-bord',
    path: 'docs/guides/lire-votre-tableau-de-bord.md',
    title: 'Lire votre tableau de bord',
    description: 'Comprendre chaque indicateur : valeur de marché, P&L latent, alertes, widgets.',
    category: 'guide',
    listed: true,
  },
  {
    slug: 'configurer-lisa',
    path: 'docs/guides/configurer-lisa.md',
    title: 'Configurer Lisa',
    description: 'Les 3 modes stratégiques (Investment / Harvest / Gainers), autopilot, garde-fous.',
    category: 'guide',
    listed: true,
  },
  // ── Docs techniques ──────────────────────────────────────────────
  {
    slug: 'broker-connections',
    path: 'docs/BROKER_CONNECTIONS.md',
    title: 'Connexions brokers — guide technique',
    description: 'Capabilities matrix, méthodes de connexion, sécurité credentials Vault.',
    category: 'guide',
    listed: true,
  },
  // ── Audit ────────────────────────────────────────────────────────
  {
    slug: 'audit-2026-04',
    path: 'docs/audit-2026-04.md',
    title: 'Audit produit — Avril 2026',
    description: 'Audit exhaustif des 40 pages : statut, gaps, roadmap Go Live (P1 à P5).',
    category: 'audit',
    listed: true,
  },
  // ── Admin ────────────────────────────────────────────────────────
  {
    slug: 'deploy',
    path: 'docs/DEPLOY.md',
    title: 'Guide de déploiement',
    description: 'Documentation déploiement Vercel + Supabase + Fly.io.',
    category: 'admin',
    listed: true,
  },
];

export function findHelpDoc(slug: string): HelpDocEntry | undefined {
  return HELP_DOCS.find((doc) => doc.slug === slug);
}
