import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

/**
 * BrokerProvider — concrete broker implementations SmartVest can connect to.
 * MANUAL is the always-available fallback (CSV import via /imports).
 */
export const BrokerProvider = z.enum([
  'INTERACTIVE_BROKERS',
  'SAXO',
  'DEGIRO',
  'TRADING212',
  'BOURSE_DIRECT',
  'FORTUNEO',
  'MANUAL',
]);
export type BrokerProvider = z.infer<typeof BrokerProvider>;

export const BrokerConnectionStatus = z.enum([
  'pending',          // credentials submitted, connectivity not yet verified
  'active',           // last test OK, sync allowed
  'error',            // last sync or test failed — requires user attention
  'revoked',          // user-revoked, no sync possible
  'expired',          // credentials expired (OAuth token, etc.)
]);
export type BrokerConnectionStatus = z.infer<typeof BrokerConnectionStatus>;

export const BrokerSyncStatus = z.enum([
  'pending',
  'running',
  'success',
  'partial',      // some accounts synced, some failed
  'failed',
  'cancelled',    // aborted by kill-switch or suspended mandate
]);
export type BrokerSyncStatus = z.infer<typeof BrokerSyncStatus>;

/**
 * BrokerCapabilities — declarative flags per provider. Read-only surface
 * of what a provider CAN do. Actual availability is gated by feature flags
 * (BROKER_EXECUTION_ENABLED, BROKER_ADAPTER_*_ENABLED).
 */
export const BrokerCapabilities = z.object({
  supportsRead: z.boolean(),
  supportsExecution: z.boolean(),
  supportsStreaming: z.boolean(),
  supportsOptions: z.boolean(),
  supportsCrypto: z.boolean(),
  supportsCsvImport: z.boolean(),
});
export type BrokerCapabilities = z.infer<typeof BrokerCapabilities>;

export const PROVIDER_CAPABILITIES: Record<BrokerProvider, BrokerCapabilities> = {
  INTERACTIVE_BROKERS: {
    supportsRead: true, supportsExecution: true, supportsStreaming: true,
    supportsOptions: true, supportsCrypto: true, supportsCsvImport: true,
  },
  SAXO: {
    supportsRead: true, supportsExecution: true, supportsStreaming: true,
    supportsOptions: true, supportsCrypto: false, supportsCsvImport: true,
  },
  DEGIRO: {
    // No official API — read-only via CSV import only (see ManualAdapter delegation).
    supportsRead: false, supportsExecution: false, supportsStreaming: false,
    supportsOptions: false, supportsCrypto: false, supportsCsvImport: true,
  },
  TRADING212: {
    supportsRead: true, supportsExecution: true, supportsStreaming: false,
    supportsOptions: false, supportsCrypto: false, supportsCsvImport: true,
  },
  BOURSE_DIRECT: {
    supportsRead: false, supportsExecution: false, supportsStreaming: false,
    supportsOptions: false, supportsCrypto: false, supportsCsvImport: true,
  },
  FORTUNEO: {
    supportsRead: false, supportsExecution: false, supportsStreaming: false,
    supportsOptions: false, supportsCrypto: false, supportsCsvImport: true,
  },
  MANUAL: {
    supportsRead: false, supportsExecution: false, supportsStreaming: false,
    supportsOptions: false, supportsCrypto: false, supportsCsvImport: true,
  },
};

/**
 * BrokerCredentials — strongly typed shape of what each provider needs at
 * connect time. All fields are expected to be sent ONCE at /connections POST
 * and immediately forwarded to Supabase Vault. They MUST NEVER be logged,
 * stored in plain text, or returned by any API response.
 *
 * The union is discriminated by `provider` so the server can validate
 * per-provider and route to the right adapter.
 */
export const BrokerCredentials = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('INTERACTIVE_BROKERS'),
    // IB Client Portal Gateway: session + account
    accountId: z.string().min(1),
    sessionToken: z.string().min(1),
  }),
  z.object({
    provider: z.literal('SAXO'),
    // OpenAPI OAuth2
    oauthAccessToken: z.string().min(1),
    oauthRefreshToken: z.string().min(1),
    expiresAt: z.string().datetime(),
    accountId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal('DEGIRO'),
    // Not implemented as live adapter — CSV-only via existing /imports.
    note: z.literal('use-csv-import'),
  }),
  z.object({
    provider: z.literal('TRADING212'),
    apiKey: z.string().min(1),
    accountId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal('BOURSE_DIRECT'),
    note: z.literal('use-csv-import'),
  }),
  z.object({
    provider: z.literal('FORTUNEO'),
    note: z.literal('use-csv-import'),
  }),
  z.object({
    provider: z.literal('MANUAL'),
    note: z.literal('no-credentials'),
  }),
]);
export type BrokerCredentials = z.infer<typeof BrokerCredentials>;

/**
 * BrokerConnection — user-owned link to a broker. Credentials live in
 * Supabase Vault, referenced by credentialsVaultRef. The row itself is
 * safe to return via the API (no secrets).
 */
export const BrokerConnection = z.object({
  id: Uuid,
  userId: Uuid,
  provider: BrokerProvider,
  label: z.string().min(1).max(100),
  status: BrokerConnectionStatus,
  capabilities: BrokerCapabilities,
  /** Vault secret ID — NEVER the secret itself. Null for MANUAL. */
  credentialsVaultRef: z.string().nullable(),
  connectedAt: z.string().datetime().nullable(),
  lastSyncAt: z.string().datetime().nullable(),
  lastErrorAt: z.string().datetime().nullable(),
  lastErrorMessage: z.string().nullable(),
  meta: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BrokerConnection = z.infer<typeof BrokerConnection>;

/**
 * BrokerAccount — one real account exposed by a connection (a single IB
 * login can expose multiple accounts, hence the 1:N relation).
 */
export const BrokerAccountType = z.enum([
  'cash',
  'margin',
  'pea',
  'pea_pme',
  'tax_sheltered',
  'retirement',
  'other',
]);
export type BrokerAccountType = z.infer<typeof BrokerAccountType>;

export const BrokerAccount = z.object({
  id: Uuid,
  connectionId: Uuid,
  userId: Uuid,
  accountIdExternal: z.string().min(1),
  accountType: BrokerAccountType,
  baseCurrency: z.string().length(3),
  displayName: z.string().nullable(),
  isActive: z.boolean(),
  meta: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type BrokerAccount = z.infer<typeof BrokerAccount>;

/**
 * BrokerSyncResult — wire shape returned by an adapter after a sync call.
 * Always aggregated in a BrokerSyncJob row; never stored directly.
 */
export const SyncedPosition = z.object({
  accountIdExternal: z.string(),
  instrumentRef: z.string(),   // ticker | ISIN | provider-specific opaque id
  quantity: z.string(),        // decimal as string
  avgCost: z.string().nullable(),
  currency: z.string().length(3),
  meta: z.record(z.unknown()).optional(),
});
export type SyncedPosition = z.infer<typeof SyncedPosition>;

export const SyncedCashBalance = z.object({
  accountIdExternal: z.string(),
  currency: z.string().length(3),
  amount: z.string(),          // decimal
});
export type SyncedCashBalance = z.infer<typeof SyncedCashBalance>;

export const SyncedTransaction = z.object({
  accountIdExternal: z.string(),
  externalId: z.string(),      // dedup key
  tradeDate: z.string().datetime(),
  side: z.enum(['buy', 'sell', 'dividend', 'fee', 'deposit', 'withdrawal', 'other']),
  instrumentRef: z.string().nullable(),
  quantity: z.string().nullable(),
  unitPrice: z.string().nullable(),
  totalAmount: z.string(),
  currency: z.string().length(3),
  meta: z.record(z.unknown()).optional(),
});
export type SyncedTransaction = z.infer<typeof SyncedTransaction>;

export const BrokerSyncResult = z.object({
  connectionId: Uuid,
  adapter: BrokerProvider,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  status: BrokerSyncStatus,
  positions: z.array(SyncedPosition),
  cash: z.array(SyncedCashBalance),
  transactions: z.array(SyncedTransaction),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
});
export type BrokerSyncResult = z.infer<typeof BrokerSyncResult>;
