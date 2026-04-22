/**
 * Lisa Persona — Orchestration et assemblage final du system prompt
 *
 * Le system prompt Lisa est construit en BLOCS SÉPARÉS pour optimiser le
 * prompt caching Anthropic (économie ~90% sur les tokens input répétés).
 *
 * Structure des blocs :
 *  - CACHEABLE (stable) : persona core + anti-consensus + flow/thesis +
 *    modes/output — ne change jamais entre appels Lisa
 *  - NON-CACHEABLE : profile override (dépend de la session)
 *  - DYNAMIQUE : contexte marché live + corpus extraits (append en user msg)
 */

import type { SessionProfile } from '../types';
import { LISA_PERSONA_CORE } from './01-persona-core';
import { LISA_ANTI_CONSENSUS } from './02-anti-consensus';
import { LISA_FLOW_THESIS } from './03-flow-thesis';
import { LISA_MODES_OUTPUT } from './04-modes-output';
import { getProfileOverride } from './05-profile-overrides';

export { LISA_PERSONA_CORE, LISA_ANTI_CONSENSUS, LISA_FLOW_THESIS, LISA_MODES_OUTPUT };
export { getProfileOverride, LISA_PROFILE_OVERRIDES } from './05-profile-overrides';

/**
 * Bloc CACHEABLE principal — stable entre sessions, candidat idéal pour
 * le prompt caching Anthropic (cache_control: { type: "ephemeral" }).
 */
export const LISA_SYSTEM_PROMPT_CACHEABLE = [
  LISA_PERSONA_CORE,
  LISA_ANTI_CONSENSUS,
  LISA_FLOW_THESIS,
  LISA_MODES_OUTPUT,
].join('\n\n---\n\n');

/**
 * Construit le system prompt complet pour une session donnée.
 * Le premier élément est cacheable, le second est spécifique à la session.
 *
 * Usage avec Anthropic SDK :
 * ```
 * const messages = await anthropic.messages.create({
 *   model: 'claude-opus-4-7',
 *   system: [
 *     { type: 'text', text: cacheable, cache_control: { type: 'ephemeral' } },
 *     { type: 'text', text: profileSpecific }
 *   ],
 *   messages: [{ role: 'user', content: userQuery }]
 * });
 * ```
 */
export function buildLisaSystemPrompt(profile: SessionProfile): {
  cacheable: string;
  profileSpecific: string;
} {
  return {
    cacheable: LISA_SYSTEM_PROMPT_CACHEABLE,
    profileSpecific: getProfileOverride(profile),
  };
}

/**
 * Returns the full system prompt as a single string (for debugging / tests).
 * In production, use buildLisaSystemPrompt() for caching benefits.
 */
export function buildLisaSystemPromptMonolithic(profile: SessionProfile): string {
  const { cacheable, profileSpecific } = buildLisaSystemPrompt(profile);
  return `${cacheable}\n\n---\n\n${profileSpecific}`;
}
