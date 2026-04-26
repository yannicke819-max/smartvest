import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../../supabase/supabase.service';

/**
 * Canonical JSON : sérialisation déterministe, clés triées alphabétiquement.
 * Postgres jsonb ne préserve pas l'ordre des clés — sans ça le hash calculé
 * à l'insertion ne correspondrait plus à celui recalculé à la vérification.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

/**
 * Normalise un timestamp en ISO-8601 canonique (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 * Supabase renvoie les `timestamptz` avec suffixe `+00:00` alors que l'insertion
 * envoie du `Z` — sans normalisation le hash diverge entre append et verify.
 */
function canonicalTimestamp(ts: string): string {
  return new Date(ts).toISOString();
}

/**
 * DecisionLogService — audit trail hash-chaîné pour Lisa.
 *
 * Chaque entrée référence le hash de l'entrée précédente (même portfolio)
 * via `hash_chain_prev`. Le hash courant est calculé sur :
 *   sha256(prev_hash || kind || summary || rationale || payload_json || timestamp)
 *
 * Garanties :
 *  - Immutabilité : altérer une ligne casse la chaîne pour toutes les
 *    lignes postérieures (détection facile)
 *  - Ordering : la chaîne établit un total ordering par portfolio
 *  - Verifiable : n'importe qui peut recalculer et vérifier
 */
@Injectable()
export class DecisionLogService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Mutex applicatif par portfolioId. Sérialise les append() concurrents
   * pour empêcher la race condition SELECT prev_hash → INSERT (où 2 crons
   * concurrents lisaient le même prev_hash et insertaient des lignes en
   * conflit, cassant le hash chain).
   *
   * Causes historiques de corruption :
   *  - runAutopilotCycle (every minute) + runFastRiskMonitor (every minute)
   *    + runMechanicalCycle (every minute) tournent en parallèle.
   *  - chacun appelle append() sur le même portfolio, race sur prev_hash.
   *
   * Limitations : fonctionne uniquement single-instance Fly. Si scaling
   * horizontal multi-machine → migrer vers advisory locks Postgres.
   */
  private readonly portfolioQueues = new Map<string, Promise<unknown>>();

  /**
   * Append une entrée au decision log avec hash chaîné.
   * Sérialisé par portfolioId via mutex applicatif.
   */
  async append(entry: {
    portfolioId: string;
    kind: string;
    summary: string;
    rationale: string;
    payload: Record<string, unknown>;
    triggeredBy: 'user_manual' | 'autopilot_cron' | 'risk_monitor' | 'corpus_trigger' | 'market_event' | 'mechanical_cron';
  }): Promise<{ id: string; hashChainCurrent: string; hashChainPrev: string | null }> {
    // Enchaîne sur la queue du portfolio (initialisée à Promise.resolve si vide)
    const queueHead = this.portfolioQueues.get(entry.portfolioId) ?? Promise.resolve();
    const result = queueHead
      .catch(() => null) // si l'append précédent a échoué, on continue quand même
      .then(() => this.appendInternal(entry));
    // Stocke la nouvelle queue head (catch pour ne pas bloquer en cas d'échec)
    this.portfolioQueues.set(
      entry.portfolioId,
      result.catch(() => null),
    );
    return result;
  }

  /**
   * Implémentation interne (sans mutex) — appelée uniquement via append()
   * qui garantit la sérialisation par portfolioId.
   */
  private async appendInternal(entry: {
    portfolioId: string;
    kind: string;
    summary: string;
    rationale: string;
    payload: Record<string, unknown>;
    triggeredBy: 'user_manual' | 'autopilot_cron' | 'risk_monitor' | 'corpus_trigger' | 'market_event' | 'mechanical_cron';
  }): Promise<{ id: string; hashChainCurrent: string; hashChainPrev: string | null }> {
    // 1. Fetch previous hash for this portfolio
    const { data: prev } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('hash_chain_current')
      .eq('portfolio_id', entry.portfolioId)
      .order('timestamp', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = (prev?.hash_chain_current as string | undefined) ?? null;
    const timestamp = new Date().toISOString();

    // 2. Compute current hash — canonical stringification pour stabilité
    //    (jsonb reordering + timestamptz formatting)
    const input = [
      prevHash ?? 'GENESIS',
      entry.kind,
      entry.summary,
      entry.rationale,
      canonicalJson(entry.payload),
      canonicalTimestamp(timestamp),
    ].join('|');
    const hashChainCurrent = createHash('sha256').update(input).digest('hex');

    // 3. Insert
    const { data, error } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .insert({
        portfolio_id: entry.portfolioId,
        kind: entry.kind,
        summary: entry.summary,
        rationale: entry.rationale,
        payload: entry.payload,
        hash_chain_prev: prevHash,
        hash_chain_current: hashChainCurrent,
        triggered_by: entry.triggeredBy,
        timestamp,
      })
      .select('id')
      .single();

    if (error || !data) {
      throw new Error(`Decision log append failed: ${error?.message ?? 'unknown'}`);
    }

    return {
      id: data.id as string,
      hashChainCurrent,
      hashChainPrev: prevHash,
    };
  }

  /**
   * Vérifie l'intégrité de la chaîne pour un portefeuille donné.
   * Retourne le nombre d'entrées + un booléen valid + un indice de corruption
   * si trouvé.
   */
  async verifyChain(portfolioId: string): Promise<{
    totalEntries: number;
    isValid: boolean;
    firstCorruptedIndex: number | null;
  }> {
    const { data: entries, error } = await this.supabase.getClient()
      .from('lisa_decision_log')
      .select('kind, summary, rationale, payload, hash_chain_prev, hash_chain_current, timestamp')
      .eq('portfolio_id', portfolioId)
      .order('timestamp', { ascending: true });

    if (error || !entries) {
      return { totalEntries: 0, isValid: false, firstCorruptedIndex: null };
    }

    let prevHash: string | null = null;

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const input = [
        prevHash ?? 'GENESIS',
        e.kind as string,
        e.summary as string,
        e.rationale as string,
        canonicalJson(e.payload),
        canonicalTimestamp(e.timestamp as string),
      ].join('|');
      const expected = createHash('sha256').update(input).digest('hex');

      if (expected !== e.hash_chain_current) {
        return {
          totalEntries: entries.length,
          isValid: false,
          firstCorruptedIndex: i,
        };
      }

      prevHash = e.hash_chain_current as string;
    }

    return {
      totalEntries: entries.length,
      isValid: true,
      firstCorruptedIndex: null,
    };
  }
}
