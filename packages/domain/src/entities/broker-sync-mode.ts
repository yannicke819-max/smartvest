import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

/**
 * BrokerSyncMode defines how SmartVest interacts with a broker connection.
 *
 * read_only: import positions, transactions, balances — no write operations
 * execution_preview: read + can generate order previews (cost simulation) — no real orders
 * execution_live: read + real order submission — requires AUTONOMOUS_GUARDED + valid mandate
 *
 * execution_live is never enabled by default and requires BROKER_EXECUTION_ENABLED flag.
 */
export const BrokerSyncMode = z.enum([
  'read_only',          // Data import only — positions, transactions, balances
  'execution_preview',  // Read + order cost simulation — no real orders sent
  'execution_live',     // Read + real order submission — requires valid mandate
]);
export type BrokerSyncMode = z.infer<typeof BrokerSyncMode>;

/**
 * BrokerConnection represents an authorized link between a portfolio account
 * and a broker API, with its current sync mode and health state.
 */
export const BrokerConnectionStatus = z.enum([
  'connected',
  'disconnected',
  'error',
  'pending_auth',
  'suspended', // Suspended by kill-switch or policy
]);
export type BrokerConnectionStatus = z.infer<typeof BrokerConnectionStatus>;

export const BrokerConnection = z.object({
  id: Uuid,
  accountId: Uuid,
  portfolioId: Uuid,
  userId: Uuid,
  brokerId: Uuid,

  syncMode: BrokerSyncMode,
  status: BrokerConnectionStatus,

  // The last successful sync of each data type
  lastPositionsSyncAt: z.string().datetime().nullable(),
  lastTransactionsSyncAt: z.string().datetime().nullable(),
  lastBalanceSyncAt: z.string().datetime().nullable(),

  // For execution_live mode: which mandate authorizes this connection
  authorizedMandateId: Uuid.nullable(),

  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BrokerConnection = z.infer<typeof BrokerConnection>;
