import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { GainersBloc1Service } from './bloc1/gainers-bloc1.service';
import { VolumeBaselineService } from './bloc2/volume-baseline.service';
import { UniverseGuardService } from './bloc2/universe-guard.service';
import { GainersBloc2Service } from './bloc2/gainers-bloc2.service';

/**
 * ADR-005 Gainers Algo V1 — Module NestJS découplé (ADR-006).
 * BLOC 1 (PR2) + BLOC 2 (PR3) wired. BLOC 3-4 ajoutés dans PR4-PR5.
 */
@Module({
  imports: [SupabaseModule],
  providers: [GainersBloc1Service, VolumeBaselineService, UniverseGuardService, GainersBloc2Service],
  exports: [GainersBloc1Service, VolumeBaselineService, UniverseGuardService, GainersBloc2Service],
})
export class GainersModule {}
