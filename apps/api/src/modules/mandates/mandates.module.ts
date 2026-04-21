import { Module } from '@nestjs/common';
import { MandatesController } from './mandates.controller';
import { MandatesService } from './services/mandates.service';
import { MandateGuardrailService } from './services/mandate-guardrail.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [MandatesController],
  providers: [MandatesService, MandateGuardrailService],
  exports: [MandatesService, MandateGuardrailService],
})
export class MandatesModule {}
