import { Module } from '@nestjs/common';
import { MacroController } from './macro.controller';
import { MacroService } from './services/macro.service';
import { SignalNormalizerService } from './services/signal-normalizer.service';
import { ImpactMapperService } from './services/impact-mapper.service';
import { AnalogFinderService } from './services/analog-finder.service';
import { ConclusionEngineService } from './services/conclusion-engine.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [MacroController],
  providers: [MacroService, SignalNormalizerService, ImpactMapperService, AnalogFinderService, ConclusionEngineService],
  exports: [MacroService],
})
export class MacroModule {}
