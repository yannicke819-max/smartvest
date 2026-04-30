import { Module } from '@nestjs/common';
import { SupabaseModule } from '../supabase/supabase.module';
import { BrokersModule } from '../brokers/brokers.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

@Module({
  imports: [SupabaseModule, BrokersModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
