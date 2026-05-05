import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SupabaseModule } from '../supabase/supabase.module';
import { GainersBloc1Service } from './bloc1/gainers-bloc1.service';
import { VolumeBaselineService } from './bloc2/volume-baseline.service';
import { VolumeBaselineCalculatorService } from './bloc2/volume-baseline-calculator.service';
import { UniverseGuardService } from './bloc2/universe-guard.service';
import { GainersBloc2Service } from './bloc2/gainers-bloc2.service';
import { GainersBloc3Service } from './bloc3/gainers-bloc3.service';
import { PositionsManagerService } from './bloc4/positions-manager.service';
import { GainersShadowRunService } from './shadow/shadow-run.service';
import { ShadowDailyReportService } from './shadow/shadow-daily-report.service';
import { TargetDerivationService } from './target-modes/target-derivation.service';
import { KellySizingService } from './kelly/kelly-sizing.service';
import { ModePresetsService } from './presets/mode-presets.service';
import { GainersInsightsService } from './insights/gainers-insights.service';
import { DriftDetectorService } from './automations/drift-detector.service';
import { RejectedInsightsService } from './automations/rejected-insights.service';
import { ThresholdAutoTunerService } from './automations/threshold-auto-tuner.service';

/**
 * ADR-005 Gainers Algo V1 — Module NestJS découplé (ADR-006).
 * BLOC 1 (PR2) + BLOC 2 (PR3) + BLOC 3 (PR4) + BLOC 4 (PR5) wired.
 * BLOC 4.0 ETL câblé via OnModuleInit pour éviter dépendance circulaire.
 * Shadow run (PR6) wired pour Step 9 validation.
 * Target modes + Kelly sizing (ADR-007 PR #207a) wired.
 * Mode presets (ADR-007 PR #207b) wired.
 * Insights log (Phase A) + DriftDetector (Phase B) wired.
 */
@Module({
  imports: [SupabaseModule, ConfigModule],
  providers: [
    GainersBloc1Service,
    VolumeBaselineService,
    VolumeBaselineCalculatorService,
    UniverseGuardService,
    GainersBloc2Service,
    GainersBloc3Service,
    PositionsManagerService,
    GainersShadowRunService,
    ShadowDailyReportService,
    TargetDerivationService,
    KellySizingService,
    ModePresetsService,
    GainersInsightsService,
    // Phase B — cron daily 23:50 UTC qui auto-log drifts/anomalies
    DriftDetectorService,
    // PR6.8 RCFT — FP-rate par reject_reason × env_tag (input AutoTuner Phase C V2)
    RejectedInsightsService,
    // PR #5 — AutoTuner Phase C : cron daily 03:00 UTC qui consomme FP-rate
    // pour ajuster automatiquement les seuils gainers_min_persistence_score
    // et gainers_min_path_efficiency. Ferme la boucle d'apprentissage.
    ThresholdAutoTunerService,
  ],
  exports: [
    GainersBloc1Service,
    VolumeBaselineService,
    VolumeBaselineCalculatorService,
    UniverseGuardService,
    GainersBloc2Service,
    GainersBloc3Service,
    PositionsManagerService,
    GainersShadowRunService,
    ShadowDailyReportService,
    TargetDerivationService,
    KellySizingService,
    ModePresetsService,
    GainersInsightsService,
    RejectedInsightsService,
    ThresholdAutoTunerService,
  ],
})
export class GainersModule implements OnModuleInit {
  constructor(
    private readonly volumeBaseline: VolumeBaselineService,
    private readonly calculator: VolumeBaselineCalculatorService,
  ) {}

  onModuleInit(): void {
    // Wire ETL runner — exécuté au démarrage du cron 01:00 UTC.
    this.volumeBaseline.setEtlRunner(() => this.calculator.runEtl().then(() => undefined));
  }
}
