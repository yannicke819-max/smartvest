import { Injectable } from '@nestjs/common';
import { BrokerImportAdapter } from './broker-import-adapter.interface';
import { NormalizedImportRow } from '../dto/import-row.dto';
import { parseCsv, parseLocaleNumber, parseFlexibleDate } from './csv-utils';

/**
 * Interactive Brokers Activity Statement CSV parser.
 * Expected format: "Statement,Header,Field Name,...,TradeDate,Buy/Sell,Symbol,..."
 * Only 'Trades' sections (Data rows) are consumed here.
 */
@Injectable()
export class InteractiveBrokersParser implements BrokerImportAdapter {
  readonly format = 'interactive_brokers';
  readonly label = 'Interactive Brokers (Activity Statement)';

  detect(csvContent: string): number {
    const head = csvContent.slice(0, 500);
    let score = 0;
    if (head.includes('Interactive Brokers')) score += 0.6;
    if (/^Statement,/m.test(head)) score += 0.2;
    if (/Trades,Header,/m.test(head)) score += 0.2;
    return Math.min(score, 1);
  }

  parse(csvContent: string): NormalizedImportRow[] {
    const rows = parseCsv(csvContent, ',');
    if (rows.length === 0) return [];

    const out: NormalizedImportRow[] = [];
    let tradesHeader: string[] | null = null;

    rows.forEach((row, idx) => {
      const rowNumber = idx + 1;
      if (row.length < 3) return;

      const section = row[0];
      const kind = row[1];
      if (section !== 'Trades') return;

      if (kind === 'Header') {
        tradesHeader = row;
        return;
      }
      if (kind !== 'Data' || !tradesHeader) return;

      const get = (col: string): string | undefined => {
        const i = tradesHeader!.indexOf(col);
        return i >= 0 ? row[i] : undefined;
      };

      const rawPayload: Record<string, unknown> = {};
      tradesHeader.forEach((col, i) => {
        rawPayload[col] = row[i];
      });

      const errors: string[] = [];
      const tradeDate = parseFlexibleDate(get('TradeDate') ?? get('Date/Time') ?? null);
      if (!tradeDate) errors.push('Date de transaction manquante ou invalide');

      const buySell = (get('Buy/Sell') ?? '').toUpperCase();
      const quantityRaw = parseLocaleNumber(get('Quantity'));
      const quantity = quantityRaw ? quantityRaw.replace(/^-/, '') : null;
      const action = this.inferAction(buySell, quantityRaw);

      const ticker = (get('Symbol') ?? '').trim() || null;
      if (!ticker) errors.push('Ticker manquant');

      const unitPrice = parseLocaleNumber(get('T. Price') ?? get('TradePrice'));
      if (!unitPrice && action === 'buy') errors.push('Prix unitaire manquant');

      const currency = (get('Currency') ?? '').toUpperCase().trim() || null;
      if (!currency) errors.push('Devise manquante');

      const brokerFee = parseLocaleNumber(get('Comm/Fee') ?? get('Commission'));
      const tax = parseLocaleNumber(get('Tax'));

      const status: NormalizedImportRow['status'] = errors.length > 0 ? 'invalid' : 'valid';

      out.push({
        rowNumber,
        rawPayload,
        tradeDate,
        action,
        ticker,
        isin: null,
        quantity,
        unitPrice,
        currency,
        brokerFee: brokerFee ? brokerFee.replace(/^-/, '') : null,
        tax,
        fxRate: null,
        assetId: null,
        matchedAssetConfidence: null,
        status,
        validationErrors: errors,
      });
    });

    return out;
  }

  private inferAction(buySell: string, quantityRaw: string | null): string {
    if (buySell === 'BUY') return 'buy';
    if (buySell === 'SELL') return 'sell';
    if (quantityRaw && quantityRaw.startsWith('-')) return 'sell';
    return 'buy';
  }
}
