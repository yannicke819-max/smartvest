import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QwDecisionLoggerService } from './qw-decision-logger.service';
import type { QwSignal, QwTrace } from './types';

/**
 * QW#6 — Blacklist statique de tickers (gaspilleurs confirmés).
 *
 * Default : CGNX, PODD, ORA, QCOM, ST, PRU (6 tickers identifiés sur
 * baseline 14j PnL négatif sans signal de retournement).
 * Override : env QW_6_SYMBOL_BLACKLIST=CSV.
 *
 * Note : ortho de TickerBlacklistService (qui gère les 404 EODHD).
 * Ici on bloque l'ouverture, pas le fetch.
 */
@Injectable()
export class Qw6SymbolBlacklistService {
  private readonly blacklist: Set<string>;

  constructor(
    private readonly config: ConfigService,
    private readonly decisionLogger: QwDecisionLoggerService,
  ) {
    const raw = this.config.get<string>('QW_6_SYMBOL_BLACKLIST') ?? 'CGNX,PODD,ORA,QCOM,ST,PRU';
    this.blacklist = new Set(
      raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
  }

  check(signal: QwSignal): QwTrace {
    if (this.blacklist.size === 0) {
      return { qwId: 'QW_6', decision: 'pass', reason: 'empty_blacklist' };
    }

    const baseSymbol = signal.symbol.split('.')[0].toUpperCase();
    if (!this.blacklist.has(baseSymbol)) {
      return { qwId: 'QW_6', decision: 'pass', reason: 'not_in_blacklist' };
    }

    this.decisionLogger.log({
      qwId: 'QW_6',
      symbol: signal.symbol,
      assetClass: signal.assetClass,
      decision: 'block',
      reason: 'blacklist_static',
      wouldHavePassedWithoutFlag: true,
      details: { baseSymbol, blacklistSize: this.blacklist.size },
    });

    return { qwId: 'QW_6', decision: 'block', reason: 'blacklist_static' };
  }
}
