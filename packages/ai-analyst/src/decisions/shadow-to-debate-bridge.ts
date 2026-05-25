/**
 * AXEES T1/T2 Bridge — Shadow signals -> Debate input.
 *
 * Aujourd'hui SmartVest stocke chaque décision de scanner gainers dans la
 * table `gainers_user_shadow_signals` avec une colonne `decision` legacy
 * (`accept`, `reject_persistence`, `reject_overextended`, etc.). T1-#4
 * (PR #444) a livré un mapping `mapShadowDecisionToSemantic()` mais aucun
 * consumer n'utilise ces verdicts sémantiques.
 *
 * Cette couche introduit la passerelle entre les données legacy déjà
 * persistées et le nouveau framework de débat (T1-#1, T1-#2) sans toucher
 * au code émetteur. Permet de :
 *
 *   1. Valider end-to-end T1+T2 sur des données réelles
 *   2. Préparer le wiring runtime du Debate Orchestrator
 *   3. Backfill historique sans migration DB destructive
 *
 * Pure fn déterministe — pas d'I/O DB. Le caller fournit les rows pré-fetchées.
 */

import type { DebateInput } from './debate-orchestrator';
import { buildSignal, type HalfLifePreset } from './signal-half-life';
import { mapShadowDecisionToSemantic } from './trading-decision';

/**
 * Row brute de `gainers_user_shadow_signals` (subset utile pour le bridge).
 * Le caller fournit ce shape sans dépendance Supabase ici.
 */
export interface ShadowSignalRow {
  /** Decision legacy ('accept', 'reject_persistence', ...). */
  decision: string;
  /** Timestamp d'émission ISO 8601 ou epoch ms. */
  emittedAt: string | number;
  /** Optionnel : score de confiance déjà calculé par le scanner. */
  confidence?: number;
  /** Optionnel : reason human-readable. */
  reason?: string;
  /** Optionnel : agentId pour distinguer plusieurs scanners. */
  agentId?: string;
  /** Optionnel : metadata libre. */
  metadata?: Record<string, unknown>;
}

export interface BridgeOptions {
  /** Preset de half-life à appliquer. Default INTRADAY_5M (scanner gainers cycle). */
  halfLifePreset?: HalfLifePreset;
  /** AgentId par défaut si la row n'en porte pas. */
  defaultAgentId?: string;
  /** Confidence par défaut si la row n'en porte pas. */
  defaultConfidence?: number;
  /** Poids relatif de l'agent dans le débat. Default 1.0. */
  agentWeight?: number;
}

/**
 * Convertit une row legacy en DebateInput prêt pour resolveDebate().
 *
 * Étapes :
 *   1. Mappe `decision` legacy -> TradingDecision sémantique (via T1-#4)
 *   2. Wrappe en SignalEnvelope avec half-life preset (via T1-#2)
 *   3. Conserve confidence/reason/metadata si présent dans la row
 *   4. Renvoie un DebateInput consommable par T1-#1
 */
export function bridgeShadowToDebate(
  row: ShadowSignalRow,
  opts: BridgeOptions = {},
): DebateInput {
  const semanticDecision = mapShadowDecisionToSemantic(row.decision);
  const emittedAtMs = typeof row.emittedAt === 'number'
    ? row.emittedAt
    : Date.parse(row.emittedAt);

  const buildOpts: {
    confidence?: number;
    emittedAt?: number;
    metadata?: Record<string, unknown>;
  } = { emittedAt: emittedAtMs };
  const conf = row.confidence ?? opts.defaultConfidence;
  if (conf !== undefined) buildOpts.confidence = conf;
  if (row.metadata !== undefined) buildOpts.metadata = row.metadata;

  const signal = buildSignal(
    semanticDecision,
    row.reason ?? `Legacy decision: ${row.decision}`,
    row.agentId ?? opts.defaultAgentId ?? 'scanner_gainers',
    opts.halfLifePreset ?? 'INTRADAY_5M',
    buildOpts,
  );

  const inp: DebateInput = {
    agentId: row.agentId ?? opts.defaultAgentId ?? 'scanner_gainers',
    signal,
  };
  if (opts.agentWeight !== undefined) inp.agentWeight = opts.agentWeight;
  return inp;
}

/**
 * Batch helper : convertit plusieurs rows en une fois.
 * Utile pour récupérer "tous les signaux des 15 dernières minutes sur SYMBOL"
 * et les passer directement à resolveDebate().
 */
export function bridgeShadowBatch(
  rows: ReadonlyArray<ShadowSignalRow>,
  opts: BridgeOptions = {},
): ReadonlyArray<DebateInput> {
  return rows.map((r) => bridgeShadowToDebate(r, opts));
}
