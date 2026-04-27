/**
 * Position row mapper — Supabase snake_case → domain camelCase.
 *
 * INCIDENT 27/04/2026 (BTC + RTX positions silencieusement non protégées) :
 * `mechanical-trading.service.ts` chargeait des positions via
 * `.from('lisa_positions').select('*')` puis castait directement en
 * `OpenPosition[]`. Les colonnes DB sont en snake_case (entry_price,
 * asset_class, stop_loss_price, take_profit_price, ...) mais le contrat
 * `OpenPosition` les déclare en camelCase. Conséquence :
 *
 *  - `pos.stopLossPrice` et `pos.takeProfitPrice` toujours `undefined` →
 *    `checkStopTarget` early-return ligne 1446 → stops jamais évalués.
 *  - `pos.assetClass.toLowerCase()` ligne 1886 crashe sur BTC car undefined →
 *    autonomy rules cassées par cycle.
 *  - `pos.entryPrice` undefined → `new Decimal(undefined)` throw silencieux
 *    dans plusieurs branches.
 *
 * Ce helper est la SOURCE UNIQUE pour transformer un row brut
 * `lisa_positions` en objet domaine. À utiliser à CHAQUE site qui fait un
 * `.from('lisa_positions').select('*')` et l'utilise ensuite avec un
 * accès camelCase.
 *
 * Note : `PaperBrokerService.mapRow` fait déjà ce travail correctement
 * pour les call sites qui passent par `paperBroker.getPositions()`. Ce
 * helper duplique partiellement la logique pour les call sites directs ;
 * unification possible plus tard (refactor de `OpenPosition` <-> `PaperPosition`).
 */
export interface PositionCamelCaseFields {
  assetClass: string;
  entryPrice: string;
  entryTimestamp: string;
  entryNotionalUsd: string;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  horizonTargetDate: string | null;
}

/**
 * Ajoute les alias camelCase à un row Supabase tout en préservant les
 * champs snake_case originaux (les call sites mixtes continuent à
 * fonctionner — cf. lisa.service.ts:815, 1321 qui lisent toujours en
 * snake_case via `as Record<>`).
 *
 * Les nouveaux champs sont **alias**, pas des doublons sémantiques —
 * `row.entryPrice === row.entry_price` après mapping.
 */
export function mapPositionRow<T extends Record<string, unknown>>(
  row: T,
): T & PositionCamelCaseFields {
  return {
    ...row,
    assetClass: row.asset_class as string,
    entryPrice: row.entry_price as string,
    entryTimestamp: row.entry_timestamp as string,
    entryNotionalUsd: row.entry_notional_usd as string,
    stopLossPrice: (row.stop_loss_price as string | null) ?? null,
    takeProfitPrice: (row.take_profit_price as string | null) ?? null,
    horizonTargetDate: (row.horizon_target_date as string | null) ?? null,
  };
}

export function mapPositionRows<T extends Record<string, unknown>>(
  rows: T[] | null | undefined,
): (T & PositionCamelCaseFields)[] {
  return (rows ?? []).map(mapPositionRow);
}
