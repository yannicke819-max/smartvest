import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { GainersBloc1Service } from './bloc1/gainers-bloc1.service';
import { VolumeBaselineService } from './bloc2/volume-baseline.service';
import { UniverseGuardService } from './bloc2/universe-guard.service';
import { GainersBloc2Service } from './bloc2/gainers-bloc2.service';
import { GainersBloc3Service } from './bloc3/gainers-bloc3.service';

/**
 * ADR-005 Gainers Algo V1 — Module NestJS découplé (ADR-006).
 * BLOC 1 (PR2) + BLOC 2 (PR3) + BLOC 3 (PR4) wired. BLOC 4 dans PR5.
 */
@Module({
  imports: [SupabaseModule],
  providers: [GainersBloc1Service, VolumeBaselineService, UniverseGuardService, GainersBloc2Service, GainersBloc3Service],
  exports: [GainersBloc1Service, VolumeBaselineService, UniverseGuardService, GainersBloc2Service, GainersBloc3Service],
})
export class GainersModule {}
