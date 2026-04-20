import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../../supabase/supabase.service';
import type { RawProposal } from '../../interfaces/raw-proposal';

const SEVERITY_SCORES: Record<string, number> = {
  systemic: 0.95,
  critical: 0.85,
  warning: 0.65,
  watch: 0.50,
};

const EXPIRES_BY_SEVERITY: Record<string, number> = {
  systemic: 3,
  critical: 5,
  warning: 7,
  watch: 14,
};

@Injectable()
export class MacroSignalSource {
  constructor(private readonly supabase: SupabaseService) {}

  async detect(_portfolioId: string, _userId: string): Promise<RawProposal[]> {
    // Recent conclusions with output_mode=alert or action_candidate, joined with signal severity
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: conclusions } = await this.supabase.getClient()
      .from('signal_conclusions')
      .select(`
        id,
        summary_text,
        main_risk,
        probable_scenario,
        output_mode,
        generated_at,
        signal:macro_signals(id, title, severity, category)
      `)
      .in('output_mode', ['alert', 'action_candidate'])
      .gte('generated_at', sevenDaysAgo)
      .order('generated_at', { ascending: false })
      .limit(5);

    if (!conclusions?.length) return [];

    const proposals: RawProposal[] = [];

    for (const c of conclusions as Array<Record<string, unknown>>) {
      const signal = c['signal'] as Record<string, unknown> | null;
      const severity = (signal?.['severity'] as string) ?? 'warning';
      if (!SEVERITY_SCORES[severity]) continue;

      const score = SEVERITY_SCORES[severity]!;
      const expiresInDays = EXPIRES_BY_SEVERITY[severity] ?? 7;
      const category = (signal?.['category'] as string) ?? 'marché';

      proposals.push({
        action: 'other',
        currency: 'EUR',
        rationale: `Signal macro (${severity.toUpperCase()}) — ${signal?.['title'] as string ?? c['summary_text'] as string}. Scénario probable : ${c['probable_scenario'] as string}. Risque principal : ${c['main_risk'] as string}.`,
        assumptions: [
          `Catégorie : ${category}`,
          `Sévérité : ${severity}`,
          `Généré le : ${new Date(c['generated_at'] as string).toLocaleDateString('fr-FR')}`,
          'Les performances passées ne préjugent pas des performances futures.',
        ],
        sourceKind: 'macro_signal',
        sourceId: (c['id'] as string),
        score,
        expiresInDays,
        dedupKey: `macro_signal:${c['id'] as string}`,
      });
    }

    return proposals;
  }
}
