/**
 * Phase B.1 — IBKR Client Portal Web API REST client.
 *
 * Stateless HTTP wrapper used by InteractiveBrokersAdapter. Caller injects
 * credentials at construction time; client never persists them.
 *
 * Default base URL : https://localhost:5000/v1/api (local IB Gateway).
 * Cloud option : pass baseUrl='https://api.ibkr.com/v1/api'.
 *
 * V1 scope (Phase B.1) :
 *   - searchSecdef(symbol)         → ticker → conid lookup
 *   - placeOrder(acctId, request)  → POST /orders
 *   - getOrderStatus(orderId)      → GET /order/status/{id}
 *   - cancelOrder(acctId, orderId) → DELETE /order/{id}
 *   - getAccountSummary(acctId)    → GET /portfolio/{id}/summary
 *
 * Out of scope V1 (Phase B.2+) :
 *   - WebSocket streaming fills
 *   - OAuth flow handler (UI-side, user copies session token)
 *   - Session keep-alive cron (/sso/validate every 3 min)
 *   - Order replies (when IBKR demands confirmation for warnings)
 *
 * Error handling :
 *   - HTTP 401 → IbkrAuthError (session expired, requires re-auth)
 *   - HTTP 429 → IbkrRateLimitError
 *   - HTTP 5xx → IbkrServerError
 *   - HTTP 4xx (other) → IbkrClientError with body details
 *   - Network/timeout → throws Error (caller retry with backoff)
 */

import type {
  IbkrAccountId,
  IbkrAccountSummary,
  IbkrLedgerEntry,
  IbkrOrderRequest,
  IbkrOrderResponse,
  IbkrOrderStatusResponse,
  IbkrPositionRaw,
  IbkrSearchContract,
  IbkrSessionToken,
  IbkrTradeRaw,
} from './ibkr-types';

export interface IbkrClientConfig {
  /** Base URL of CP Web API (default: local gateway). */
  baseUrl?: string;
  /** Session token from OAuth flow. */
  sessionToken: IbkrSessionToken;
  /** Account ID (selected post-auth). */
  accountId: IbkrAccountId;
  /** Request timeout in ms (default 8000). */
  timeoutMs?: number;
  /** Custom fetch impl for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://localhost:5000/v1/api';
const DEFAULT_TIMEOUT_MS = 8000;

export class IbkrAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IbkrAuthError';
  }
}

export class IbkrRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IbkrRateLimitError';
  }
}

export class IbkrServerError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'IbkrServerError';
  }
}

export class IbkrClientError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'IbkrClientError';
  }
}

export class IbkrClient {
  private readonly baseUrl: string;
  private readonly sessionToken: IbkrSessionToken;
  private readonly accountId: IbkrAccountId;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: IbkrClientConfig) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.sessionToken = cfg.sessionToken;
    this.accountId = cfg.accountId;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  getAccountId(): IbkrAccountId {
    return this.accountId;
  }

  /**
   * Search for a contract by ticker. Returns first matching STK contract.
   * Caller should cache (ticker → conid) — IBKR conid is stable.
   */
  async searchContract(symbol: string): Promise<IbkrSearchContract | null> {
    const res = await this.request<IbkrSearchContract[]>(
      'POST',
      '/iserver/secdef/search',
      { symbol },
    );
    if (!Array.isArray(res) || res.length === 0) return null;

    // Préfère STK (stocks), sinon prend le premier
    const stkMatch = res.find((c) =>
      c.sections?.some((s) => s.secType === 'STK'),
    );
    return stkMatch ?? res[0];
  }

  /**
   * Place an order. Returns IBKR order ID. If IBKR demands confirmation
   * (margin warning, etc.), the response includes a `message` array; the
   * caller should NOT auto-confirm — V2 will surface to user. For V1,
   * we throw IbkrClientError if confirmation is needed.
   */
  async placeOrder(req: IbkrOrderRequest): Promise<IbkrOrderResponse> {
    const acctId = req.acctId || this.accountId;
    const body = {
      orders: [
        {
          acctId,
          conid: req.conid,
          orderType: req.orderType,
          side: req.side,
          quantity: req.quantity,
          price: req.price,
          auxPrice: req.auxPrice,
          tif: req.tif,
          outsideRTH: req.outsideRTH ?? false,
        },
      ],
    };
    const res = await this.request<IbkrOrderResponse[]>(
      'POST',
      `/iserver/account/${encodeURIComponent(acctId)}/orders`,
      body,
    );
    if (!Array.isArray(res) || res.length === 0) {
      throw new IbkrClientError(
        500,
        'IBKR placeOrder: empty response array',
      );
    }
    const first = res[0];
    if (first.message && first.message.length > 0) {
      throw new IbkrClientError(
        400,
        `IBKR placeOrder requires confirmation (V1 unsupported): ${first.message.join(' / ')}`,
      );
    }
    return first;
  }

  /**
   * Get order status. Returns null if order not found (e.g. very old order
   * purged by broker).
   */
  async getOrderStatus(orderId: string): Promise<IbkrOrderStatusResponse | null> {
    try {
      const res = await this.request<IbkrOrderStatusResponse>(
        'GET',
        `/iserver/account/order/status/${encodeURIComponent(orderId)}`,
      );
      return res;
    } catch (e) {
      if (e instanceof IbkrClientError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * Cancel an order. Returns true if accepted, false if already filled or
   * not cancellable.
   */
  async cancelOrder(orderId: string): Promise<boolean> {
    try {
      await this.request<{ msg: string }>(
        'DELETE',
        `/iserver/account/${encodeURIComponent(this.accountId)}/order/${encodeURIComponent(orderId)}`,
      );
      return true;
    } catch (e) {
      if (e instanceof IbkrClientError && (e.status === 404 || e.status === 409)) {
        return false;
      }
      throw e;
    }
  }

  /**
   * Get account summary (cash, buying power, net liquidation, multi-currency).
   */
  async getAccountSummary(acctId?: IbkrAccountId): Promise<IbkrAccountSummary> {
    const id = acctId ?? this.accountId;
    return this.request<IbkrAccountSummary>(
      'GET',
      `/portfolio/${encodeURIComponent(id)}/summary`,
    );
  }

  /**
   * Phase B.2 — Liste les positions du compte. IBKR pagine par page de 30
   * positions max via index `pageNum`. On boucle jusqu'à array vide.
   */
  async getPositions(acctId?: IbkrAccountId): Promise<IbkrPositionRaw[]> {
    const id = acctId ?? this.accountId;
    const all: IbkrPositionRaw[] = [];
    let page = 0;
    const MAX_PAGES = 50; // sanity bound 1500 positions max
    while (page < MAX_PAGES) {
      const batch = await this.request<IbkrPositionRaw[]>(
        'GET',
        `/portfolio/${encodeURIComponent(id)}/positions/${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 30) break;
      page += 1;
    }
    return all;
  }

  /**
   * Phase B.2 — Ledger (cash) per currency. Retourne un objet keyed by
   * currency code. On filtre les entrées à zero balance.
   */
  async getLedger(acctId?: IbkrAccountId): Promise<Record<string, IbkrLedgerEntry>> {
    const id = acctId ?? this.accountId;
    return this.request<Record<string, IbkrLedgerEntry>>(
      'GET',
      `/portfolio/${encodeURIComponent(id)}/ledger`,
    );
  }

  /**
   * Phase B.2 — Trades exécutés. IBKR retourne les 7 derniers jours par
   * défaut, max 50 trades. Use-case principal : reconciliation +
   * actual_commission tracking.
   */
  async getTrades(): Promise<IbkrTradeRaw[]> {
    const res = await this.request<IbkrTradeRaw[]>(
      'GET',
      `/iserver/account/trades`,
    );
    return Array.isArray(res) ? res : [];
  }

  /**
   * Phase B.3 — Fills d'un ordre spécifique. IBKR ne fournit pas
   * d'endpoint dédié `/orders/{id}/fills`, on filtre /iserver/account/trades
   * par order_id. Pour des ordres market splittés, retourne plusieurs fills.
   *
   * Note : trades endpoint ne retourne que les 7 derniers jours. Pour des
   * ordres plus anciens (rare en scalping intraday), getFills retournera []
   * et le caller devra utiliser getOrderStatus pour les data agrégées.
   */
  async getFillsByOrderId(orderId: string): Promise<IbkrTradeRaw[]> {
    const trades = await this.getTrades();
    const numericId = Number(orderId);
    return trades.filter((t) => {
      if (Number.isFinite(numericId) && t.order_id === numericId) return true;
      if (t.order_ref === orderId) return true;
      return false;
    });
  }

  /**
   * Ping session validation (used by keep-alive cron — Phase B.4).
   * Returns true if session is still valid.
   */
  async validateSession(): Promise<boolean> {
    try {
      await this.request<unknown>('POST', '/sso/validate');
      return true;
    } catch (e) {
      if (e instanceof IbkrAuthError) return false;
      throw e;
    }
  }

  // ── Internal HTTP helper ──────────────────────────────────────────────

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          // CP Web API uses cookie-based auth typically; for header-based
          // sessions the token is passed as a custom header. Adjust per
          // deployment (gateway vs cloud).
          'X-IBKR-Session': this.sessionToken,
        },
        signal: controller.signal,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const res = await this.fetchImpl(url, init);

      const status = res.status;
      if (status === 401) {
        throw new IbkrAuthError(
          `IBKR session expired or invalid (401). Re-authenticate via Client Portal.`,
        );
      }
      if (status === 429) {
        throw new IbkrRateLimitError(
          `IBKR rate limit exceeded (429). Retry with backoff.`,
        );
      }
      if (status >= 500) {
        throw new IbkrServerError(
          status,
          `IBKR server error ${status} on ${method} ${path}`,
        );
      }
      if (status >= 400) {
        const errBody = await res.text().catch(() => '');
        throw new IbkrClientError(
          status,
          `IBKR client error ${status} on ${method} ${path}: ${errBody.slice(0, 200)}`,
        );
      }

      // 2xx — parse JSON
      const text = await res.text();
      if (text.length === 0) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (parseErr) {
        throw new IbkrServerError(
          status,
          `IBKR returned non-JSON on ${method} ${path}: ${String(parseErr).slice(0, 100)}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
