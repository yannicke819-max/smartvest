import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';
import type { RawProposal } from '../../interfaces/raw-proposal';

// Inlined from @smartvest/portfolio-engine — avoids Jest moduleNameMapper path issue.
// Logic is identical to computeDrift() in packages/portfolio-engine/src/index.ts.
interface AllocationTarget {
  assetClass: string;
  targetWeight: number;
}

function computeDrift(template: AllocationTarget[], current: Record<string, number>, thresholdPct = 5) {
  return template.map((t) => {
    const cur = current[t.assetClass] ?? 0;
    const drift = (cur - t.targetWeight) * 100;
    return { assetClass: t.assetClass, current: cur, target: t.targetWeight, drift, needsRebalance: Math.abs(drift) > thresholdPct };
  });
}

// Inlined from DEFAULT_TEMPLATES in @smartvest/portfolio-engine
const RISK_TEMPLATES: Record<string, AllocationTarget[]> = {
  prudent:   [{ assetClass: 'bond', targetWeight: 0.6 }, { assetClass: 'etf', targetWeight: 0.2 }, { assetClass: 'cash', targetWeight: 0.2 }],
  equilibre: [{ assetClass: 'etf', targetWeight: 0.5 }, { assetClass: 'bond', targetWeight: 0.35 }, { assetClass: 'cash', targetWeight: 0.15 }],
  dynamique: [{ assetClass: 'etf', targetWeight: 0.7 }, { assetClass: 'bond', targetWeight: 0.2 }, { assetClass: 'cash', targetWeight: 0.1 }],
  offensif:  [{ assetClass: 'equity', targetWeight: 0.6 }, { assetClass: 'etf', targetWeight: 0.25 }, { assetClass: 'crypto', targetWeight: 0.1 }, { assetClass: 'cash', targetWeight: 0.05 }],
};

@Injectable()
export class DriftSource {
  constructor(private readonly supabase: SupabaseService) {}

  async detect(portfolioId: string, userId: string): Promise<RawProposal[]> {
    // Get latest allocation snapshot
    const { data: snapshot } = await this.supabase.getClient()
      .from('portfolio_history_snapshots')
      .select('allocation_snapshot')
      .eq('portfolio_id', portfolioId)
      .order('as_of_date', { ascending: false })
      .limit(1)
      .single();

    if (!snapshot?.allocation_snapshot) return [];

    const allocationSnapshot = snapshot.allocation_snapshot as Record<string, number>;

    // Get user risk profile
    const { data: profile } = await this.supabase.getClient()
      .from('user_profiles')
      .select('risk_profile')
      .eq('user_id', userId)
      .maybeSingle();

    const riskProfile = (profile?.risk_profile as string | null) ?? 'equilibre';
    const template = RISK_TEMPLATES[riskProfile] ?? RISK_TEMPLATES['equilibre']!;

    const drifts = computeDrift(template, allocationSnapshot, 5);
    const proposals: RawProposal[] = [];

    for (const d of drifts) {
      if (!d.needsRebalance) continue;

      const absDrift = Math.abs(d.drift);
      const score = absDrift > 20 ? 0.75 : absDrift > 10 ? 0.65 : 0.45;
      const direction = d.drift < 0 ? 'sous-exposé' : 'surexposé';

      proposals.push({
        action: 'rebalance',
        assetClass: d.assetClass,
        currency: 'EUR',
        rationale: `Dérive d'allocation détectée sur la classe "${d.assetClass}" : ${direction} de ${absDrift.toFixed(1)} points (actuel ${(d.current * 100).toFixed(1)}% vs cible ${(d.target * 100).toFixed(1)}% pour le profil ${riskProfile}).`,
        assumptions: [
          `Profil de risque : ${riskProfile}`,
          `Allocation actuelle "${d.assetClass}" : ${(d.current * 100).toFixed(1)}%`,
          `Allocation cible "${d.assetClass}" : ${(d.target * 100).toFixed(1)}%`,
          'Seuil de déclenchement : 5 points de pourcentage',
        ],
        sourceKind: 'drift',
        score,
        expiresInDays: 14,
        dedupKey: `drift:${portfolioId}:${d.assetClass}`,
      });
    }

    return proposals;
  }
}
