import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { SignalNormalizerService, type RawSignalInput } from './signal-normalizer.service';
import { ImpactMapperService } from './impact-mapper.service';
import { AnalogFinderService } from './analog-finder.service';
import { ConclusionEngineService } from './conclusion-engine.service';
import { v4 as uuid } from 'uuid';
import type { SignalImpactAssessment } from '@smartvest/domain';

@Injectable()
export class MacroService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly normalizer: SignalNormalizerService,
    private readonly impactMapper: ImpactMapperService,
    private readonly analogFinder: AnalogFinderService,
    private readonly conclusionEngine: ConclusionEngineService,
  ) {}

  // ── Ingest ───────────────────────────────────────────────────────────────────

  async ingestSignal(input: RawSignalInput) {
    const normalized = this.normalizer.normalize(input);

    const { data, error } = await this.supabase.getClient()
      .from('macro_signals')
      .insert({
        id: normalized.id,
        category: normalized.category,
        status: normalized.status,
        title: normalized.title,
        summary: normalized.summary,
        raw_content: normalized.rawContent,
        source_kind: normalized.source.kind,
        source_name: normalized.source.name,
        source_url: normalized.source.url,
        source_reliability_score: normalized.source.reliabilityScore,
        severity: normalized.severity,
        confidence: normalized.confidence,
        impact_horizon: normalized.impactHorizon,
        geographic_zones: normalized.geographicZones,
        countries: normalized.countries,
        affected_sectors: normalized.affectedSectors,
        affected_currencies: normalized.affectedCurrencies,
        affected_asset_classes: normalized.affectedAssetClasses,
        references: normalized.references,
        tags: normalized.tags,
        occurred_at: normalized.occurredAt,
        ingested_at: normalized.ingestedAt,
        updated_at: normalized.updatedAt,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  // ── List / Get ────────────────────────────────────────────────────────────────

  async listSignals(filters?: { category?: string; severity?: string; limit?: number }) {
    let q = this.supabase.getClient()
      .from('macro_signals')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(filters?.limit ?? 50);

    if (filters?.category) q = q.eq('category', filters.category);
    if (filters?.severity) q = q.eq('severity', filters.severity);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async getSignal(signalId: string) {
    const { data, error } = await this.supabase.getClient()
      .from('macro_signals')
      .select('*')
      .eq('id', signalId)
      .single();
    if (error || !data) throw new NotFoundException('Signal introuvable');
    return data;
  }

  // ── Impact assessment ─────────────────────────────────────────────────────────

  async assessImpact(signalId: string, portfolioId: string): Promise<SignalImpactAssessment> {
    const signal = await this.getSignal(signalId);

    // Fetch portfolio positions for asset-level mapping
    const { data: positions } = await this.supabase.getClient()
      .from('positions')
      .select('id, asset_id, assets!inner(ticker, isin, asset_class)')
      .eq('portfolio_id', portfolioId)
      .gt('quantity', 0);

    const portfolioAssets = ((positions ?? []) as Record<string, unknown>[]).map((p) => {
      const asset = Array.isArray(p.assets) ? p.assets[0] : p.assets as Record<string, unknown>;
      return {
        assetId: p.asset_id as string,
        ticker: (asset?.ticker as string) ?? '',
        isin: (asset?.isin as string | null) ?? null,
        assetClass: (asset?.asset_class as string) ?? 'equity',
      };
    });

    const sectorExposures = this.impactMapper.mapSectorExposures(
      signal.category,
      signal.severity,
      signal.confidence,
    );

    const assetExposures = this.impactMapper.mapAssetExposures(
      signal.category,
      portfolioAssets,
      signal.severity,
      signal.confidence,
    );

    const exposedCount = assetExposures.filter((a) => a.direction !== 'neutral').length;

    const assessment: SignalImpactAssessment = {
      id: this.impactMapper.buildAssessmentId(),
      signalId,
      assetExposures,
      sectorExposures,
      portfolioImpacts: exposedCount > 0
        ? [{
            portfolioId,
            estimatedImpactPct: null,
            exposedPositionCount: exposedCount,
            exposedNotionalPct: null,
            currency: 'EUR',
            aggravatingFactors: sectorExposures.filter((s) => s.direction === 'negative').map((s) => s.sector),
            mitigatingFactors: sectorExposures.filter((s) => s.direction === 'positive').map((s) => s.sector),
            invalidationConditions: ['Retournement de politique monétaire', 'Résolution rapide du contexte géopolitique'],
            estimatedAt: new Date().toISOString(),
          }]
        : [],
      overallSeverity: signal.severity,
      overallConfidence: signal.confidence,
      assessedAt: new Date().toISOString(),
      notes: null,
    };

    // Persist
    await this.supabase.getClient().from('signal_impact_assessments').insert({
      id: assessment.id,
      signal_id: signalId,
      asset_exposures: JSON.stringify(assessment.assetExposures),
      sector_exposures: JSON.stringify(assessment.sectorExposures),
      portfolio_impacts: JSON.stringify(assessment.portfolioImpacts),
      overall_severity: assessment.overallSeverity,
      overall_confidence: assessment.overallConfidence,
      assessed_at: assessment.assessedAt,
    });

    for (const exp of assetExposures) {
      if (exp.assetId) {
        await this.supabase.getClient().from('asset_signal_exposures').insert({
          id: uuid(),
          signal_id: signalId,
          portfolio_id: portfolioId,
          asset_id: exp.assetId,
          ticker: exp.ticker,
          isin: exp.isin,
          direction: exp.direction,
          magnitude_pct: exp.magnitudePct,
          rationale: exp.rationale,
          confidence: exp.confidence,
        }).then(() => {});
      }
    }

    // Update signal status
    await this.supabase.getClient()
      .from('macro_signals')
      .update({ status: 'assessed', updated_at: new Date().toISOString() })
      .eq('id', signalId);

    return assessment;
  }

  // ── Historical analogs ────────────────────────────────────────────────────────

  async findAnalogs(signalId: string) {
    const signal = await this.getSignal(signalId);
    const { analogs, insights } = this.analogFinder.findAnalogs(signalId, signal.category, signal.severity);

    for (const analog of analogs) {
      await this.supabase.getClient().from('historical_analogs').insert({
        id: analog.id,
        signal_id: signalId,
        episode_title: analog.episodeTitle,
        episode_date_start: analog.episodeDateStart,
        episode_date_end: analog.episodeDateEnd,
        context_description: analog.contextDescription,
        similarity_score: analog.similarityScore,
        key_drivers: JSON.stringify(analog.keyDrivers),
        resolution: analog.resolution,
        asset_class_behaviors: JSON.stringify(analog.assetClassBehaviors),
        limitations_of_comparison: JSON.stringify(analog.limitationsOfComparison),
      });
    }

    for (const insight of insights) {
      await this.supabase.getClient().from('retex_insights').insert({
        id: insight.id,
        signal_id: signalId,
        analog_id: insight.analogId,
        lesson: insight.lesson,
        applicability_note: insight.applicabilityNote,
        observed_behavior: insight.observedBehavior,
        confidence_level: insight.confidenceLevel,
      });
    }

    return { analogs, insights };
  }

  // ── Conclusion ────────────────────────────────────────────────────────────────

  async generateConclusion(signalId: string) {
    const signal = await this.getSignal(signalId);

    const { data: assessmentRow } = await this.supabase.getClient()
      .from('signal_impact_assessments')
      .select('*')
      .eq('signal_id', signalId)
      .order('assessed_at', { ascending: false })
      .limit(1)
      .single();

    const assessment = assessmentRow
      ? {
          ...assessmentRow,
          assetExposures: typeof assessmentRow.asset_exposures === 'string' ? JSON.parse(assessmentRow.asset_exposures) : assessmentRow.asset_exposures,
          sectorExposures: typeof assessmentRow.sector_exposures === 'string' ? JSON.parse(assessmentRow.sector_exposures) : assessmentRow.sector_exposures,
          portfolioImpacts: typeof assessmentRow.portfolio_impacts === 'string' ? JSON.parse(assessmentRow.portfolio_impacts) : assessmentRow.portfolio_impacts,
        } as SignalImpactAssessment
      : null;

    const { data: analogRows } = await this.supabase.getClient()
      .from('historical_analogs')
      .select('*')
      .eq('signal_id', signalId);

    const analogs = ((analogRows ?? []) as Record<string, unknown>[]).map((r) => ({
      ...r,
      keyDrivers: typeof r.key_drivers === 'string' ? JSON.parse(r.key_drivers as string) : r.key_drivers,
      assetClassBehaviors: typeof r.asset_class_behaviors === 'string' ? JSON.parse(r.asset_class_behaviors as string) : r.asset_class_behaviors,
      limitationsOfComparison: typeof r.limitations_of_comparison === 'string' ? JSON.parse(r.limitations_of_comparison as string) : r.limitations_of_comparison,
    }));

    const conclusion = this.conclusionEngine.generate(
      signalId,
      signal.category,
      signal.severity,
      signal.confidence,
      assessment,
      analogs as never,
    );

    await this.supabase.getClient().from('signal_conclusions').insert({
      id: conclusion.id,
      signal_id: signalId,
      summary_text: conclusion.summaryText,
      exposed_assets: JSON.stringify(conclusion.exposedAssets),
      exposed_sectors: JSON.stringify(conclusion.exposedSectors),
      probable_scenario: conclusion.probableScenario,
      main_risk: conclusion.mainRisk,
      counter_arguments: JSON.stringify(conclusion.counterArguments),
      overall_confidence: conclusion.overallConfidence,
      needs_review: conclusion.needsReview,
      output_mode: conclusion.outputMode,
      proposed_actions: JSON.stringify(conclusion.proposedActions),
      delegation_mode: conclusion.delegationMode,
      generated_at: conclusion.generatedAt,
    });

    await this.supabase.getClient()
      .from('macro_signals')
      .update({ status: 'concluded', updated_at: new Date().toISOString() })
      .eq('id', signalId);

    return conclusion;
  }

  // ── Portfolio context ─────────────────────────────────────────────────────────

  async getPortfolioSignalImpact(portfolioId: string) {
    const { data, error } = await this.supabase.getClient()
      .from('portfolio_signal_impacts')
      .select('*, macro_signals(*)')
      .eq('portfolio_id', portfolioId)
      .order('estimated_at', { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async getMarketContext(portfolioId: string) {
    const { data: recentSignals } = await this.supabase.getClient()
      .from('macro_signals')
      .select('id, category, severity, confidence, title, occurred_at, status')
      .in('severity', ['warning', 'critical', 'systemic'])
      .order('occurred_at', { ascending: false })
      .limit(10);

    const { data: conclusions } = await this.supabase.getClient()
      .from('signal_conclusions')
      .select('*, macro_signals(title, category, severity)')
      .order('generated_at', { ascending: false })
      .limit(5);

    return {
      portfolioId,
      watchSignals: recentSignals ?? [],
      recentConclusions: (conclusions ?? []).map((c) => ({
        ...c,
        exposedAssets: typeof c.exposed_assets === 'string' ? JSON.parse(c.exposed_assets) : c.exposed_assets,
        exposedSectors: typeof c.exposed_sectors === 'string' ? JSON.parse(c.exposed_sectors) : c.exposed_sectors,
        proposedActions: typeof c.proposed_actions === 'string' ? JSON.parse(c.proposed_actions) : c.proposed_actions,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  async getWatchSignals() {
    const { data, error } = await this.supabase.getClient()
      .from('macro_signals')
      .select('*')
      .in('status', ['ingested', 'assessed'])
      .order('occurred_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  // ── Conversions ───────────────────────────────────────────────────────────────

  async convertToAlert(signalId: string, portfolioId: string) {
    const signal = await this.getSignal(signalId);
    await this.logWatch(signalId, 'system', 'converted_to_alert', { portfolioId });
    return {
      kind: 'information' as const,
      message: 'Signal transmis au moteur d\'alertes pour création d\'une alerte portfolio. Aucune action exécutée.',
      signalId,
      portfolioId,
      signalTitle: signal.title,
      severity: signal.severity,
      requiresUserValidation: true,
    };
  }

  async convertToSimulation(signalId: string, portfolioId: string) {
    const signal = await this.getSignal(signalId);
    await this.logWatch(signalId, 'system', 'converted_to_simulation', { portfolioId });
    return {
      kind: 'simulation' as const,
      message: 'Le signal peut être utilisé comme hypothèse de stress dans le moteur de simulation. Aucune action exécutée.',
      signalId,
      portfolioId,
      signalTitle: signal.title,
      hypothesis: `Impact signal "${signal.category}" (${signal.severity})`,
      requiresUserValidation: true,
    };
  }

  async convertToSuggestion(signalId: string, portfolioId: string) {
    const signal = await this.getSignal(signalId);
    await this.logWatch(signalId, 'system', 'converted_to_suggestion', { portfolioId });
    return {
      kind: 'suggestion' as const,
      message: 'Suggestion générée en mode MANUAL_EXPLICIT. Aucune action exécutée. Validation utilisateur requise.',
      signalId,
      portfolioId,
      signalTitle: signal.title,
      delegationMode: 'MANUAL_EXPLICIT',
      requiresUserValidation: true,
    };
  }

  private async logWatch(signalId: string, userId: string, kind: string, payload: Record<string, unknown>) {
    await this.supabase.getClient().from('signal_watch_events').insert({
      id: uuid(),
      signal_id: signalId,
      user_id: userId,
      event_kind: kind,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    }).then(() => {});
  }
}
