import {
  Controller, Get, Post, Patch, Param, Body, Query, Headers, HttpCode,
} from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { GoalsService } from './services/goals.service';
import type { CreateGoalDto, UpdateGoalDto, CreateTriggerDto, UpdateCheckpointDto } from './dto/goals.dto';

function extractUserId(headers: Record<string, string>): string {
  const id = headers['x-user-id'];
  if (!id) throw new UnauthorizedException('x-user-id header manquant');
  return id;
}

@Controller('goals')
export class GoalsController {
  constructor(private readonly goals: GoalsService) {}

  @Get()
  listGoals(
    @Headers() headers: Record<string, string>,
    @Query('portfolioId') portfolioId?: string,
  ) {
    return this.goals.listGoals(extractUserId(headers), portfolioId);
  }

  @Post()
  createGoal(
    @Headers() headers: Record<string, string>,
    @Body() dto: CreateGoalDto,
  ) {
    return this.goals.createGoal(extractUserId(headers), dto);
  }

  @Get(':id')
  getGoal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.getGoal(id, extractUserId(headers));
  }

  @Patch(':id')
  updateGoal(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() dto: UpdateGoalDto,
  ) {
    return this.goals.updateGoal(id, extractUserId(headers), dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.goals.updateGoalStatus(id, extractUserId(headers), status);
  }

  // ── Feasibility ──────────────────────────────────────────────────────────────

  @Post(':id/assess-feasibility')
  @HttpCode(200)
  assessFeasibility(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.assessFeasibility(id, extractUserId(headers));
  }

  @Get(':id/feasibility')
  getLatestFeasibility(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.getLatestFeasibility(id, extractUserId(headers));
  }

  // ── Scenarios ────────────────────────────────────────────────────────────────

  @Post(':id/generate-scenarios')
  @HttpCode(200)
  generateScenarios(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.generateScenarios(id, extractUserId(headers));
  }

  @Get(':id/scenarios')
  getScenarios(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.getScenarios(id, extractUserId(headers));
  }

  // ── Plans ────────────────────────────────────────────────────────────────────

  @Post(':id/generate-plan')
  @HttpCode(200)
  generatePlan(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('scenarioId') scenarioId: string,
    @Body('delegationMode') delegationMode?: string,
  ) {
    return this.goals.generatePlan(id, extractUserId(headers), scenarioId, delegationMode);
  }

  @Get(':id/plan')
  getPlan(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.getPlan(id, extractUserId(headers));
  }

  @Get(':id/review-checkpoints')
  getCheckpoints(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.getReviewCheckpoints(id, extractUserId(headers));
  }

  @Patch(':id/checkpoints/:cpId')
  updateCheckpoint(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Param('cpId') cpId: string,
    @Body() dto: UpdateCheckpointDto,
  ) {
    return this.goals.updateCheckpoint(id, extractUserId(headers), cpId, dto);
  }

  // ── Triggers ─────────────────────────────────────────────────────────────────

  @Get(':id/triggers')
  listTriggers(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
  ) {
    return this.goals.listTriggers(id, extractUserId(headers));
  }

  @Post(':id/triggers')
  createTrigger(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body() dto: CreateTriggerDto,
  ) {
    return this.goals.createTrigger(id, extractUserId(headers), dto);
  }

  // ── Suggestion conversion ────────────────────────────────────────────────────

  @Post(':id/convert-to-suggestion')
  @HttpCode(200)
  convertToSuggestion(
    @Headers() headers: Record<string, string>,
    @Param('id') id: string,
    @Body('scenarioId') scenarioId: string,
    @Body('delegationMode') delegationMode?: string,
  ) {
    return this.goals.convertToSuggestion(id, extractUserId(headers), scenarioId, delegationMode);
  }
}
