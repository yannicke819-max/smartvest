/**
 * Phase B.1 — IBKR Client Portal Web API types.
 *
 * Reference: https://www.interactivebrokers.com/api/doc.html
 *
 * Auth model : Client Portal Web API uses session-based auth.
 *   1. User runs `client-portal-gateway` locally OR uses IBKR's hosted CP API
 *   2. User authenticates via browser OAuth flow → session token
 *   3. SmartVest receives the session token + accountId via UI form
 *   4. SmartVest pings /sso/validate every ~3 min to keep session alive
 *      (Phase B.2 — for B.1 we assume session is valid)
 *
 * Endpoints we use in V1 :
 *   POST /iserver/secdef/search          → ticker → conid lookup
 *   POST /iserver/account/{acctId}/orders → place order
 *   GET  /iserver/account/orders         → list pending/recent orders
 *   GET  /iserver/account/order/status/{orderId} → order status
 *   POST /iserver/account/{acctId}/order/{orderId} → cancel order
 *   GET  /portfolio/{acctId}/summary     → account balance + buying power
 *   GET  /portfolio/{acctId}/positions/0 → positions (1st page)
 */

/** IBKR contract identifier (numeric, opaque). */
export type IbkrConid = number;

/** IBKR account ID (e.g. "U1234567" for individual, "FZ1234567" for LLC). */
export type IbkrAccountId = string;

/** IBKR session token (opaque, comes from OAuth flow). */
export type IbkrSessionToken = string;

/**
 * Mapping IBKR order status → SmartVest BrokerOrderStatus.
 * Cf. https://www.interactivebrokers.com/api/doc.html#tag/Order/operation/iserverAccountOrders
 */
export type IbkrOrderStatusRaw =
  | 'Inactive'
  | 'PendingSubmit'
  | 'PendingCancel'
  | 'PreSubmitted'
  | 'Submitted'
  | 'Filled'
  | 'Cancelled'
  | 'ApiCancelled'
  | 'ApiPending';

export interface IbkrSearchContract {
  conid: number;
  symbol: string;
  description: string;
  companyHeader: string;
  companyName: string;
  restricted: boolean | null;
  fop: string | null;
  opt: string | null;
  war: string | null;
  /** Section list of available secTypes (STK, OPT, FUT, etc.) */
  sections: Array<{
    secType: string;
    months?: string;
    symbol?: string;
    exchange?: string;
  }>;
}

export interface IbkrOrderRequest {
  acctId: string;
  conid: number;
  orderType: 'MKT' | 'LMT' | 'STP' | 'STP_LMT';
  side: 'BUY' | 'SELL';
  quantity: number;
  /** Required if orderType=LMT or STP_LMT */
  price?: number;
  /** Required if orderType=STP or STP_LMT */
  auxPrice?: number;
  tif: 'DAY' | 'GTC' | 'IOC' | 'FOK';
  /** Optional outsideRTH for extended hours */
  outsideRTH?: boolean;
}

export interface IbkrOrderResponse {
  order_id: string;
  order_status: IbkrOrderStatusRaw;
  encrypt_message?: string;
  /** Présent si IBKR demande confirmation (margin warning, etc.) */
  message?: string[];
  /** Présent si IBKR demande confirmation, à renvoyer en reply */
  id?: string;
}

export interface IbkrOrderStatusResponse {
  order_id: number;
  status: IbkrOrderStatusRaw;
  side: 'BUY' | 'SELL';
  ticker: string;
  conid: number;
  /** Filled quantity */
  filled_quantity: number;
  /** Remaining quantity */
  remaining_quantity: number;
  /** Average fill price */
  avg_price: number | null;
  /** Total commission charged */
  commission: number | null;
  commission_currency?: string;
  /** Time in force used */
  tif: string;
  /** Order type */
  order_type: string;
  /** Limit price if applicable */
  limit_price?: number | null;
  /** Stop price if applicable */
  stop_price?: number | null;
  /** Submission timestamp ms */
  order_ref?: string;
  last_executed_time?: string;
}

export interface IbkrAccountSummary {
  /** Cash balance per currency */
  totalcashvalue?: { amount: number; currency: string; timestamp: number };
  /** Buying power in account base currency (usually USD) */
  buyingpower?: { amount: number; currency: string; timestamp: number };
  /** Net liquidation value */
  netliquidation?: { amount: number; currency: string; timestamp: number };
  /** Total cash from all currencies */
  cushion?: { amount: number; currency: string; timestamp: number };
  /** Excess liquidity */
  excessliquidity?: { amount: number; currency: string; timestamp: number };
}

/**
 * Phase B.2 — Position individuelle retournée par /portfolio/{id}/positions/0.
 * Plus de champs disponibles côté IBKR mais on ne mappe que ceux utilisés.
 */
export interface IbkrPositionRaw {
  acctId: string;
  conid: number;
  contractDesc: string;
  ticker?: string;
  /** Position size (peut être négative pour short) */
  position: number;
  /** Average cost */
  avgCost: number;
  /** Currency */
  currency: string;
  /** Asset class : STK, OPT, FUT, FOP, BOND, CASH, etc. */
  assetClass: string;
  /** Market value */
  mktValue?: number;
  mktPrice?: number;
  /** Unrealized PnL */
  unrealizedPnl?: number;
  realizedPnl?: number;
  /** Optional: latest trade price */
  lastTradeDate?: string;
}

/**
 * Phase B.2 — Ledger entry per currency.
 * GET /portfolio/{accountId}/ledger retourne un objet keyed by currency code.
 */
export interface IbkrLedgerEntry {
  /** Cash balance dans cette devise */
  cashbalance: number;
  /** Currency code (ex: USD, EUR, JPY) */
  currency: string;
  /** Net liquidation value en cette devise */
  netliquidationvalue?: number;
  /** Stock market value */
  stockmarketvalue?: number;
  /** Settled cash */
  settledcash?: number;
  timestamp?: number;
}

/**
 * Phase B.2 — Trade individuel retourné par /iserver/account/trades.
 * Ces sont des fills exécutés (différents des orders).
 */
export interface IbkrTradeRaw {
  execution_id: string;
  order_ref?: string;
  /** Order ID parent */
  order_id?: number;
  symbol: string;
  conid: number;
  side: 'B' | 'S' | 'BUY' | 'SELL';
  /** Quantity exécutée (signed: + buy, - sell) */
  size: number;
  price: number;
  /** Trade time ISO 8601 */
  trade_time: string;
  trade_time_r?: number;  // unix ms
  /** Currency */
  currency?: string;
  /** Commission charged on this fill */
  commission?: number;
  /** Commission currency (USD, EUR, etc.) */
  commission_currency?: string;
  /** Account this trade belongs to */
  account?: string;
  /** Asset class */
  asset_class?: string;
  /** Net amount (qty × price ± fees) */
  net_amount?: number;
}

/**
 * Map IBKR raw status → SmartVest BrokerOrderStatus union.
 */
export function mapIbkrStatusToBrokerStatus(
  raw: IbkrOrderStatusRaw,
):
  | 'submitted'
  | 'accepted'
  | 'partial_fill'
  | 'filled'
  | 'rejected'
  | 'canceled'
  | 'expired'
  | 'unknown' {
  switch (raw) {
    case 'PendingSubmit':
    case 'PendingCancel':
    case 'ApiPending':
      return 'submitted';
    case 'PreSubmitted':
    case 'Submitted':
      return 'accepted';
    case 'Filled':
      return 'filled';
    case 'Cancelled':
    case 'ApiCancelled':
      return 'canceled';
    case 'Inactive':
      return 'rejected';
    default:
      return 'unknown';
  }
}
