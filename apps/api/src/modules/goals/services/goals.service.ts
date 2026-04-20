import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { FeasibilityService } from './feasibility.service';
import { ScenarioGeneratorService } from './scenario-generator.service';
import { PlanGeneratorService } from './plan-generator.service';
import { GoalAuditService } from './goal-audit.service';
import { v4 as uuid } from 'uuid';
import type { CreateGoalDto, UpdateGoalDto, CreateTriggerDto, UpdateCheckpointDto } from '../dto/goals.dto';
import type { FeasibilityAssessment } from '@smartvest/domain';

@Injectable()
export class GoalsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly feasibility: FeasibilityService,
    private readonly scenarioGen: ScenarioGeneratorService,
    private readonly planGen: PlanGeneratorService,
    private readonly audit: GoalAuditService,
  ) {}

  // ── Goals CRUD ──────────────────────────────────────────────────────────────

  async listGoals(userId: string, portfolioId?: string) {
    let q = this.supabase.getClient()
      .from('goals')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (portfolioId) q = q.eq('portfolio_id', portfolioId);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async getGoal(goalId: string, userId: string) {
    const { data, error } = await this.supabase.getClient()
      .from('goals')
      .select('*')
      .eq('id', goalId)
      .eq('user_id', userId)
      .single();
    if (error || !data) throw new NotFoundException('Objectif introuvable');
    return data;
  }

  async createGoal(userId: string, dto: CreateGoalDto) {
    const { data, error } = await this.supabase.getClient()
      .from('goals')
      .insert({
        id: uuid(),
        user_id: userId,
        portfolio_id: dto.portfolioId,
        type: dto.type,
        status: 'draft',
        name: dto.name,
        description: dto.description ?? null,
        target_amount: dto.targetAmount,
        currency: dto.currency,
        current_amount: dto.currentAmount,
        monthly_contribution: dto.monthlyContribution,
        horizon_months: dto.horizonMonths,
        target_date: dto.targetDate ?? null,
        risk_tolerance_override: dto.riskToleranceOverride ?? null,
        max_volatility_pct: dto.maxVolatilityPct ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    await this.logEvent(data.id, userId, 'goal_created', { name: dto.name });
    return data;
  }

  async updateGoal(goalId: string, userId: string, dto: UpdateGoalDto) {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (dto.name !== undefined) updates.name = dto.name;
    if (dto.description !== undefined) updates.description = dto.description;
    if (dto.targetAmount !== undefined) updates.target_amount = dto.targetAmount;
    if (dto.monthlyContribution !== undefined) updates.monthly_contribution = dto.monthlyContribution;
    if (dto.horizonMonths !== undefined) updates.horizon_months = dto.horizonMonths;
    if (dto.targetDate !== undefined) updates.target_date = dto.targetDate;
    if (dto.status !== undefined) updates.status = dto.status;

    const { data, error } = await this.supabase.getClient()
      .from('goals')
      .update(updates)
      .eq('id', goalId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new NotFoundException('Objectif introuvable');
    await this.logEvent(goalId, userId, 'goal_updated', updates);
    return data;
  }

  async updateGoalStatus(goalId: string, userId: string, status: string) {
    const { data, error } = await this.supabase.getClient()
      .from('goals')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', goalId)
      .eq('user_id', userId)
      .select()
      .single();
    if (error || !data) throw new NotFoundException('Objectif introuvable');
    await this.logEvent(goalId, userId, 'status_changed', { status });
    return data;
  }

  // ── Feasibility ─────────────────────────────────────────────────────────────

  async assessFeasibility(goalId: string, userId: string): Promise<FeasibilityAssessment> {
    const goal = await this.getGoal(goalId, userId);

    const assessment = this.feasibility.assess({
      goalId,
      targetAmount: goal.target_amount,
      currentAmount: goal.current_amount,
      monthlyContribution: goal.monthly_contribution,
      horizonMonths: goal.horizon_months,
      riskProfile: goal.risk_tolerance_override,
    });

    await this.supabase.getClient().from('feasibility_assessments').insert({
      id: assessment.id,
      goal_id: goalId,
      credibility_score: assessment.credibilityScore,
      is_credible: assessment.isCredible,
      implied_annual_return_required: assessment.impliedAnnualReturnRequired,
      current_portfolio_return: assessment.currentPortfolioReturn,
      tensions: JSON.stringify(assessment.tensions),
      levers: JSON.stringify(assessment.levers),
      risk_profile_adequate: assessment.riskProfileAdequate,
      risk_profile_note: assessment.riskProfileNote,
      horizon_months: assessment.horizonMonths,
      gap_to_target: assessment.gapToTarget,
      assessed_at: assessment.assessedAt,
      notes: assessment.notes,
    });

    await this.logEvent(goalId, userId, 'feasibility_assessed', { credibilityScore: assessment.credibilityScore });
    return assessment;
  }

  async getLatestFeasibility(goalId: string, userId: string) {
    await this.getGoal(goalId, userId); // verify ownership
    const { data } = await this.supabase.getClient()
      .from('feasibility_assessments')
      .select('*')
      .eq('goal_id', goalId)
      .order('assessed_at', { ascending: false })
      .limit(1)
      .single();
    return data ?? null;
  }

  // ── Scenarios ────────────────────────────────────────────────────────────────

  async generateScenarios(goalId: string, userId: string) {
    const goal = await this.getGoal(goalId, userId);

    const scenarios = this.scenarioGen.generate(
      goalId,
      goal.target_amount,
      goal.current_amount,
      goal.monthly_contribution,
      goal.horizon_months,
    );

    // Upsert (delete then insert to replace previous generation)
    await this.supabase.getClient().from('objective_scenarios').delete().eq('goal_id', goalId);

    const rows = scenarios.map((s) => ({
      id: s.id,
      goal_id: goalId,
      scenario_type: s.scenarioType,
      annual_return_assumption_pct: s.annualReturnAssumptionPct,
      volatility_assumption_pct: s.volatilityAssumptionPct,
      monthly_contribution: s.monthlyContribution,
      projected_final_value: s.projectedFinalValue,
      shortfall_or_surplus: s.shortfallOrSurplus,
      estimated_probability: s.estimatedProbability,
      suggested_allocation: JSON.stringify(s.suggestedAllocation),
      assumptions: JSON.stringify(s.assumptions),
      risks: JSON.stringify(s.risks),
      failure_conditions: JSON.stringify(s.failureConditions),
      trajectory: JSON.stringify(s.trajectory),
      generated_at: s.generatedAt,
    }));

    const { error } = await this.supabase.getClient().from('objective_scenarios').insert(rows);
    if (error) throw new Error(error.message);

    await this.logEvent(goalId, userId, 'scenarios_generated', { count: scenarios.length });
    return scenarios;
  }

  async getScenarios(goalId: string, userId: string) {
    await this.getGoal(goalId, userId);
    const { data, error } = await this.supabase.getClient()
      .from('objective_scenarios')
      .select('*')
      .eq('goal_id', goalId)
      .order('scenario_type', { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(this.deserializeScenario);
  }

  private deserializeScenario(row: Record<string, unknown>) {
    return {
      ...row,
      suggestedAllocation: typeof row.suggested_allocation === 'string' ? JSON.parse(row.suggested_allocation) : row.suggested_allocation,
      assumptions: typeof row.assumptions === 'string' ? JSON.parse(row.assumptions) : row.assumptions,
      risks: typeof row.risks === 'string' ? JSON.parse(row.risks) : row.risks,
      failureConditions: typeof row.failure_conditions === 'string' ? JSON.parse(row.failure_conditions) : row.failure_conditions,
      trajectory: typeof row.trajectory === 'string' ? JSON.parse(row.trajectory) : row.trajectory,
    };
  }

  // ── Plans ────────────────────────────────────────────────────────────────────

  async generatePlan(goalId: string, userId: string, scenarioId: string, delegationMode?: string) {
    const goal = await this.getGoal(goalId, userId);

    const { data: scenario } = await this.supabase.getClient()
      .from('objective_scenarios')
      .select('*')
      .eq('id', scenarioId)
      .eq('goal_id', goalId)
      .single();
    if (!scenario) throw new NotFoundException('Scénario introuvable');

    const allocation = typeof scenario.suggested_allocation === 'string'
      ? JSON.parse(scenario.suggested_allocation)
      : scenario.suggested_allocation;

    const mode = (delegationMode as 'MANUAL_EXPLICIT' | 'HYBRID_SUGGESTIVE' | 'AUTONOMOUS_GUARDED') ?? 'MANUAL_EXPLICIT';

    const planData = this.planGen.generate(
      goalId,
      scenarioId,
      goal.horizon_months,
      scenario.monthly_contribution,
      allocation,
      mode,
    );

    const planId = uuid();
    const now = new Date().toISOString();

    const { error: planError } = await this.supabase.getClient().from('objective_plans').insert({
      id: planId,
      goal_id: goalId,
      scenario_id: scenarioId,
      status: 'draft',
      delegation_mode: mode,
      selected_at: now,
      created_at: now,
      updated_at: now,
    });
    if (planError) throw new Error(planError.message);

    // Insert steps
    for (const step of planData.steps) {
      await this.supabase.getClient().from('objective_plan_steps').insert({
        id: step.id,
        plan_id: planId,
        order: step.order,
        title: step.title,
        description: step.description,
        action_kind: step.actionKind,
        target_date: step.targetDate,
      });

      for (const candidate of step.actionCandidates) {
        await this.supabase.getClient().from('plan_action_candidates').insert({
          id: candidate.id,
          step_id: step.id,
          kind: candidate.kind,
          ticker: candidate.ticker,
          isin: candidate.isin,
          amount: candidate.amount,
          quantity: candidate.quantity,
          rationale: candidate.rationale,
          delegation_mode: candidate.delegationMode,
          status: candidate.status,
          created_at: candidate.createdAt,
        });
      }
    }

    // Insert checkpoints
    for (const cp of planData.checkpoints) {
      await this.supabase.getClient().from('objective_review_checkpoints').insert({
        id: cp.id,
        plan_id: planId,
        scheduled_at: cp.scheduledAt,
        title: cp.title,
        description: cp.description,
        trigger_ids: JSON.stringify(cp.triggerIds),
      });
    }

    // Set active plan on goal
    await this.supabase.getClient()
      .from('goals')
      .update({ active_plan_id: planId, updated_at: now })
      .eq('id', goalId);

    await this.logEvent(goalId, userId, 'plan_generated', { planId, delegationMode: mode });

    return this.getPlan(goalId, userId);
  }

  async getPlan(goalId: string, userId: string) {
    await this.getGoal(goalId, userId);

    const { data: goal } = await this.supabase.getClient()
      .from('goals')
      .select('active_plan_id')
      .eq('id', goalId)
      .single();
    if (!goal?.active_plan_id) return null;

    const planId = goal.active_plan_id;

    const [{ data: plan }, { data: steps }, { data: checkpoints }] = await Promise.all([
      this.supabase.getClient().from('objective_plans').select('*').eq('id', planId).single(),
      this.supabase.getClient().from('objective_plan_steps').select('*, plan_action_candidates(*)').eq('plan_id', planId).order('order'),
      this.supabase.getClient().from('objective_review_checkpoints').select('*').eq('plan_id', planId).order('scheduled_at'),
    ]);

    return { plan, steps: steps ?? [], checkpoints: checkpoints ?? [] };
  }

  async getReviewCheckpoints(goalId: string, userId: string) {
    const planData = await this.getPlan(goalId, userId);
    return planData?.checkpoints ?? [];
  }

  async updateCheckpoint(goalId: string, userId: string, checkpointId: string, dto: UpdateCheckpointDto) {
    await this.getGoal(goalId, userId);
    const updates: Record<string, unknown> = {};
    if (dto.outcome) {
      updates.outcome = dto.outcome;
      updates.completed_at = new Date().toISOString();
    }
    if (dto.notes !== undefined) updates.notes = dto.notes;

    const { data, error } = await this.supabase.getClient()
      .from('objective_review_checkpoints')
      .update(updates)
      .eq('id', checkpointId)
      .select()
      .single();
    if (error || !data) throw new NotFoundException('Point de contrôle introuvable');
    return data;
  }

  // ── Triggers ─────────────────────────────────────────────────────────────────

  async listTriggers(goalId: string, userId: string) {
    await this.getGoal(goalId, userId);
    const { data, error } = await this.supabase.getClient()
      .from('goal_triggers')
      .select('*')
      .eq('goal_id', goalId)
      .order('created_at');
    if (error) throw new Error(error.message);
    return data ?? [];
  }

  async createTrigger(goalId: string, userId: string, dto: CreateTriggerDto) {
    await this.getGoal(goalId, userId);
    const { data, error } = await this.supabase.getClient()
      .from('goal_triggers')
      .insert({
        id: uuid(),
        goal_id: goalId,
        type: dto.type,
        params: JSON.stringify(dto.params),
        linked_alert_rule_id: dto.linkedAlertRuleId ?? null,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    await this.logEvent(goalId, userId, 'trigger_created', { type: dto.type });
    return data;
  }

  // ── Convert to suggestion ─────────────────────────────────────────────────

  async convertToSuggestion(
    goalId: string,
    userId: string,
    scenarioId: string,
    delegationMode = 'MANUAL_EXPLICIT',
  ) {
    const goal = await this.getGoal(goalId, userId);

    // Gate: checks active mandate for non-MANUAL modes; always emits hash-chained audit event
    await this.audit.checkAndAuditConversion({
      portfolioId: goal.portfolio_id as string,
      userId,
      goalId,
      scenarioId,
      delegationMode,
    });

    await this.logEvent(goalId, userId, 'converted_to_suggestion', { scenarioId, delegationMode });
    return {
      kind: 'suggestion' as const,
      message: 'Le scénario a été converti en suggestion. Aucune action n\'a été exécutée. Veuillez valider explicitement chaque étape du plan.',
      scenarioId,
      goalId,
      delegationMode,
      requiresUserValidation: true,
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private async logEvent(goalId: string, userId: string, kind: string, payload: Record<string, unknown>) {
    await this.supabase.getClient().from('goal_events').insert({
      id: uuid(),
      goal_id: goalId,
      user_id: userId,
      event_kind: kind,
      payload: JSON.stringify(payload),
      created_at: new Date().toISOString(),
    });
  }
}
