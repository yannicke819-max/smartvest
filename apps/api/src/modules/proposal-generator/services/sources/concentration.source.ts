import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';
import type { RawProposal } from '../../interfaces/raw-proposal';

interface MandateGuardrail {
  max_position_size_pct: string | number;
}

@Injectable()
export class ConcentrationSource {
  constructor(private readonly supabase: SupabaseService) {}

  async detect(
    portfolioId: string,
    _userId: string,
    mandate: MandateGuardrail | null,
  ): Promise<RawProposal[]> {
    // Without a mandate, use 40% as a conservative concentration ceiling
    const limitPct = mandate
      ? parseFloat(String(mandate.max_position_size_pct))
      : 40;

    const { data: snapshot } = await this.supabase.getClient()
      .from('portfolio_history_snapshots')
      .select('allocation_snapshot')
      .eq('portfolio_id', portfolioId)
      .order('as_of_date', { ascending: false })
      .limit(1)
      .single();

    if (!snapshot?.allocation_snapshot) return [];

    const allocation = snapshot.allocation_snapshot as Record<string, number>;
    const proposals: RawProposal[] = [];

    for (const [assetClass, weight] of Object.entries(allocation)) {
      const weightPct = weight * 100;
      if (weightPct <= limitPct) continue;

      const ratio = weightPct / limitPct;
      const score = ratio >= 2 ? 0.80 : ratio >= 1.5 ? 0.60 : 0.45;

      proposals.push({
        action: 'rebalance',
        assetClass,
        currency: 'EUR',
        rationale: `Concentration excessive sur la classe "${assetClass}" : ${weightPct.toFixed(1)}% du portefeuille${mandate ? ` (limite mandat : ${limitPct}%)` : ` (seuil prudent : ${limitPct}%)`}. Une réduction vers une allocation plus diversifiée est suggérée.`,
        assumptions: [
          `Poids actuel de "${assetClass}" : ${weightPct.toFixed(1)}%`,
          `Plafond de concentration : ${limitPct}%`,
          'Calcul basé sur le dernier snapshot journalier',
          'Aucune exécution automatique — validation requise',
        ],
        sourceKind: 'concentration',
        score,
        expiresInDays: 7,
        dedupKey: `concentration:${portfolioId}:${assetClass}`,
      });
    }

    return proposals;
  }
}
