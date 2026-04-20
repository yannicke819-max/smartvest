import { z } from 'zod';

// Montants stockés en string (Decimal) — jamais en float (perte de précision).
export const MoneyAmount = z.string().regex(/^-?\d+(\.\d+)?$/, {
  message: 'Montant monétaire invalide (attendu: décimal en string).',
});
export type MoneyAmount = z.infer<typeof MoneyAmount>;

export const CurrencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Code devise ISO 4217 attendu (ex: EUR, USD).');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

export const Money = z.object({
  amount: MoneyAmount,
  currency: CurrencyCode,
});
export type Money = z.infer<typeof Money>;
