import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './services/goals.service';
import { FeasibilityService } from './services/feasibility.service';
import { ScenarioGeneratorService } from './services/scenario-generator.service';
import { PlanGeneratorService } from './services/plan-generator.service';
import { GoalAuditService } from './services/goal-audit.service';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule],
  controllers: [GoalsController],
  providers: [GoalsService, FeasibilityService, ScenarioGeneratorService, PlanGeneratorService, GoalAuditService],
  exports: [GoalsService],
})
export class GoalsModule {}
