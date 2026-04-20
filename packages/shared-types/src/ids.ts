import { z } from 'zod';

export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

export const Isin = z
  .string()
  .length(12)
  .regex(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, 'ISIN invalide.');
export type Isin = z.infer<typeof Isin>;

export const Ticker = z.string().min(1).max(20);
export type Ticker = z.infer<typeof Ticker>;

// MIC = Market Identifier Code (ISO 10383). Ex: XPAR, XNYS.
export const Mic = z.string().length(4).regex(/^[A-Z0-9]{4}$/);
export type Mic = z.infer<typeof Mic>;
