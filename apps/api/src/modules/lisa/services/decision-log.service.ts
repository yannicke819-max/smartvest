import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { SupabaseService } from '../../supabase/supabase.service';

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
   * Append une entrée au decision log avec hash chaîné.
   * Retourne le hash_chain_current calculé.
   */
  async append(entry: {
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

    // 2. Compute current hash
    const input = [
      prevHash ?? 'GENESIS',
      entry.kind,
      entry.summary,
      entry.rationale,
      JSON.stringify(entry.payload),
      timestamp,
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
        JSON.stringify(e.payload),
        e.timestamp as string,
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
