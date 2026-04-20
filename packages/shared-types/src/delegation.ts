import { z } from 'zod';

/**
 * The three delegation modes that govern what SmartVest can do on behalf of a user.
 * MANUAL_EXPLICIT is always the default. AUTONOMOUS_GUARDED requires a valid AutonomyMandate.
 */
export const DelegationMode = z.enum([
  'MANUAL_EXPLICIT',    // Analyse, explain, simulate, alert — never act
  'HYBRID_SUGGESTIVE',  // Propose concrete changes — explicit user validation required
  'AUTONOMOUS_GUARDED', // Act within explicitly mandated scope — full audit, instant kill-switch
]);
export type DelegationMode = z.infer<typeof DelegationMode>;

/**
 * The five semantic layers of any SmartVest output or action.
 * Every API response and UI element must be classifiable into exactly one of these.
 */
export const ExecutionIntentKind = z.enum([
  'information',        // Educational or static data — no action implied
  'simulation',         // Probabilistic scenario — explicit assumptions, no commitment
  'suggestion',         // Concrete proposed action — awaiting explicit user validation
  'execution_intent',   // User-validated intent — pre-execution (HYBRID or AUTONOMOUS only)
  'execution',          // Action performed — always audited (AUTONOMOUS_GUARDED only)
]);
export type ExecutionIntentKind = z.infer<typeof ExecutionIntentKind>;

export const DEFAULT_DELEGATION_MODE: DelegationMode = 'MANUAL_EXPLICIT';
