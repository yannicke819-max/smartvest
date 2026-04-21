import { Module } from '@nestjs/common';
import { ProposalGeneratorController } from './proposal-generator.controller';
import { ProposalGeneratorService } from './services/proposal-generator.service';
import { ProposalScorerService } from './services/proposal-scorer.service';
import { FrictionEstimatorService } from './services/friction-estimator.service';
import { DriftSource } from './services/sources/drift.source';
import { ConcentrationSource } from './services/sources/concentration.source';
import { GoalTriggerSource } from './services/sources/goal-trigger.source';
import { MacroSignalSource } from './services/sources/macro-signal.source';
import { PerformanceSource } from './services/sources/performance.source';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [ProposalGeneratorController],
  providers: [
    ProposalGeneratorService,
    ProposalScorerService,
    FrictionEstimatorService,
    DriftSource,
    ConcentrationSource,
    GoalTriggerSource,
    MacroSignalSource,
    PerformanceSource,
  ],
  exports: [ProposalGeneratorService],
})
export class ProposalGeneratorModule {}
