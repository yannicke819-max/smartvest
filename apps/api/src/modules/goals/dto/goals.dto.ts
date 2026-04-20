export interface CreateGoalDto {
  portfolioId: string;
  type: 'retirement' | 'education' | 'real_estate' | 'emergency_fund' | 'travel' | 'business' | 'other';
  name: string;
  description?: string;
  targetAmount: string;
  currency: string;
  currentAmount: string;
  monthlyContribution: string;
  horizonMonths: number;
  targetDate?: string;
  riskToleranceOverride?: string;
  maxVolatilityPct?: string;
}

export interface UpdateGoalDto {
  name?: string;
  description?: string;
  targetAmount?: string;
  monthlyContribution?: string;
  horizonMonths?: number;
  targetDate?: string;
  status?: 'draft' | 'active' | 'paused' | 'achieved' | 'abandoned';
}

export interface CreateTriggerDto {
  type: string;
  params: Record<string, unknown>;
  linkedAlertRuleId?: string;
}

export interface UpdateCheckpointDto {
  outcome?: 'on_track' | 'off_track' | 'achieved' | 'abandoned';
  notes?: string;
}
