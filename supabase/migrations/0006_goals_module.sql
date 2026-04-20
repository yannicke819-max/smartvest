-- Goals / Trigger / Plan d'action module

-- Goals (GoalIntent)
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references portfolios(id) on delete cascade,
  type text not null check (type in ('retirement','education','real_estate','emergency_fund','travel','business','other')),
  status text not null default 'draft' check (status in ('draft','active','paused','achieved','abandoned')),
  name text not null,
  description text,
  target_amount numeric(20,8) not null,
  currency char(3) not null default 'EUR',
  current_amount numeric(20,8) not null default 0,
  -- GoalConstraint embedded
  monthly_contribution numeric(20,8) not null default 0,
  horizon_months int not null,
  target_date date,
  risk_tolerance_override text,
  max_volatility_pct numeric(6,4),
  min_monthly_liquidity_amount numeric(20,8),
  active_plan_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table goals enable row level security;
create policy "goals: owner access" on goals for all using (auth.uid() = user_id);

-- Goal triggers
create table if not exists goal_triggers (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  type text not null check (type in (
    'date_reached','value_reached','drawdown_exceeded',
    'allocation_drift_exceeded','contribution_missed',
    'goal_achieved','goal_at_risk','manual_review'
  )),
  params jsonb not null default '{}',
  is_active boolean not null default true,
  linked_alert_rule_id uuid,
  last_fired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table goal_triggers enable row level security;
create policy "goal_triggers: owner via goal" on goal_triggers for all
  using (exists (select 1 from goals g where g.id = goal_id and g.user_id = auth.uid()));

-- Feasibility assessments
create table if not exists feasibility_assessments (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  credibility_score numeric(5,4) not null,
  is_credible boolean not null,
  implied_annual_return_required numeric(8,4) not null,
  current_portfolio_return numeric(8,4),
  tensions jsonb not null default '[]',
  levers jsonb not null default '[]',
  risk_profile_adequate boolean not null,
  risk_profile_note text,
  horizon_months int not null,
  gap_to_target numeric(20,8) not null,
  assessed_at timestamptz not null default now(),
  notes text
);

alter table feasibility_assessments enable row level security;
create policy "feasibility_assessments: owner via goal" on feasibility_assessments for all
  using (exists (select 1 from goals g where g.id = goal_id and g.user_id = auth.uid()));

-- Objective scenarios (3 per goal: prudent/central/ambitieux)
create table if not exists objective_scenarios (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  scenario_type text not null check (scenario_type in ('prudent','central','ambitieux')),
  annual_return_assumption_pct numeric(8,4) not null,
  volatility_assumption_pct numeric(8,4) not null,
  monthly_contribution numeric(20,8) not null,
  projected_final_value numeric(20,8) not null,
  shortfall_or_surplus numeric(20,8) not null,
  estimated_probability numeric(5,4),
  suggested_allocation jsonb not null default '{}',
  assumptions jsonb not null default '[]',
  risks jsonb not null default '[]',
  failure_conditions jsonb not null default '[]',
  trajectory jsonb not null default '[]',
  generated_at timestamptz not null default now()
);

alter table objective_scenarios enable row level security;
create policy "objective_scenarios: owner via goal" on objective_scenarios for all
  using (exists (select 1 from goals g where g.id = goal_id and g.user_id = auth.uid()));

create unique index if not exists objective_scenarios_goal_type_ux
  on objective_scenarios(goal_id, scenario_type);

-- Objective plans
create table if not exists objective_plans (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  scenario_id uuid not null references objective_scenarios(id),
  status text not null default 'draft' check (status in ('draft','active','completed','abandoned')),
  delegation_mode text not null default 'MANUAL_EXPLICIT' check (delegation_mode in ('MANUAL_EXPLICIT','HYBRID_SUGGESTIVE','AUTONOMOUS_GUARDED')),
  selected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table objective_plans enable row level security;
create policy "objective_plans: owner via goal" on objective_plans for all
  using (exists (select 1 from goals g where g.id = goal_id and g.user_id = auth.uid()));

-- Plan steps
create table if not exists objective_plan_steps (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references objective_plans(id) on delete cascade,
  "order" int not null,
  title text not null,
  description text not null,
  action_kind text not null check (action_kind in ('contribution_setup','allocation_rebalance','product_selection','review','monitoring')),
  target_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table objective_plan_steps enable row level security;
create policy "objective_plan_steps: owner via plan" on objective_plan_steps for all
  using (exists (
    select 1 from objective_plans op
    join goals g on g.id = op.goal_id
    where op.id = plan_id and g.user_id = auth.uid()
  ));

-- Plan action candidates
create table if not exists plan_action_candidates (
  id uuid primary key default gen_random_uuid(),
  step_id uuid not null references objective_plan_steps(id) on delete cascade,
  kind text not null check (kind in ('contribute','rebalance','buy','sell','review','inform')),
  ticker text,
  isin text,
  amount numeric(20,8),
  quantity numeric(20,8),
  rationale text not null,
  delegation_mode text not null default 'MANUAL_EXPLICIT',
  status text not null default 'pending' check (status in ('pending','suggested','approved','rejected','executed')),
  created_at timestamptz not null default now()
);

alter table plan_action_candidates enable row level security;
create policy "plan_action_candidates: owner via step" on plan_action_candidates for all
  using (exists (
    select 1 from objective_plan_steps ops
    join objective_plans op on op.id = ops.plan_id
    join goals g on g.id = op.goal_id
    where ops.id = step_id and g.user_id = auth.uid()
  ));

-- Review checkpoints
create table if not exists objective_review_checkpoints (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references objective_plans(id) on delete cascade,
  scheduled_at date not null,
  title text not null,
  description text not null,
  trigger_ids jsonb not null default '[]',
  completed_at timestamptz,
  outcome text check (outcome in ('on_track','off_track','achieved','abandoned')),
  notes text,
  created_at timestamptz not null default now()
);

alter table objective_review_checkpoints enable row level security;
create policy "objective_review_checkpoints: owner via plan" on objective_review_checkpoints for all
  using (exists (
    select 1 from objective_plans op
    join goals g on g.id = op.goal_id
    where op.id = plan_id and g.user_id = auth.uid()
  ));

-- Goal events log (append-only)
create table if not exists goal_events (
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references goals(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  event_kind text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table goal_events enable row level security;
create policy "goal_events: owner access" on goal_events for all using (auth.uid() = user_id);

-- FK from goals.active_plan_id after objective_plans table exists
alter table goals add constraint goals_active_plan_id_fk
  foreign key (active_plan_id) references objective_plans(id) on delete set null;
