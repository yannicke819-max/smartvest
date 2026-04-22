import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { LisaController } from './lisa.controller';
import { LisaService } from './services/lisa.service';

@Module({
  imports: [SupabaseModule],
  controllers: [LisaController],
  providers: [LisaService],
  exports: [LisaService],
})
export class LisaModule {}
