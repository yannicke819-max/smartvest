/**
 * Types pour les positions options.
 *
 * Foundation minimale : long calls et long puts (single-leg uniquement).
 * Spreads multi-jambes seront ajoutés dans une future itération.
 *
 * Convention :
 *  - strike : prix d'exercice
 *  - expiry : date d'expiration (YYYY-MM-DD)
 *  - kind : 'call' ou 'put'
 *  - direction : 'long' (acheté, premium payé) seulement pour l'instant
 */

import { z } from 'zod';

export const OptionKindSchema = z.enum(['call', 'put']);
export type OptionKind = z.infer<typeof OptionKindSchema>;

export const OptionDirectionSchema = z.enum(['long']);
export type OptionDirection = z.infer<typeof OptionDirectionSchema>;

export interface OptionPosition {
  id: string;
  underlying: string;
  kind: OptionKind;
  direction: OptionDirection;
  strike: number;
  expiry: string; // YYYY-MM-DD
  contracts: number; // 1 contrat = 100 sous-jacent
  premiumPaid: number; // par contrat × 100
  entryDate: string;
  entryUnderlyingPrice: number;
  /** Implied volatility implicite à l'achat (en fraction, 0.30 = 30%). */
  entryIv: number;
}

export interface OptionMarkResult {
  /** Valeur courante du contrat (× contracts × 100). */
  currentValueUsd: number;
  /** P&L latent (= currentValueUsd − premiumPaid). */
  pnlUsd: number;
  pnlPct: number;
  /** Greeks principaux (informatifs). */
  delta: number;
  theta: number; // par jour, en USD pour le contrat entier
}
