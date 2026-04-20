import { Injectable } from '@nestjs/common';
import { BrokerImportAdapter } from './broker-import-adapter.interface';
import { NormalizedImportRow } from '../dto/import-row.dto';
import { parseCsv, parseLocaleNumber, parseFlexibleDate } from './csv-utils';

/**
 * Degiro Account statement CSV parser.
 * Typical header: "Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,..."
 * or English: "Date,Time,Product,ISIN,Exchange,Venue,Quantity,Price,..."
 */
@Injectable()
export class DegiroParser implements BrokerImportAdapter {
  readonly format = 'degiro';
  readonly label = 'Degiro (Transactions)';

  detect(csvContent: string): number {
    const head = csvContent.slice(0, 500).toLowerCase();
    let score = 0;
    if (head.includes('degiro')) score += 0.6;
    if (/isin/.test(head) && /koers|price/.test(head) && /aantal|quantity/.test(head)) score += 0.4;
    return Math.min(score, 1);
  }

  parse(csvContent: string): NormalizedImportRow[] {
    const rows = parseCsv(csvContent);
    if (rows.length < 2) return [];

    const header = rows[0].map((c) => c.trim().toLowerCase());
    const col = (...names: string[]): number => {
      for (const n of names) {
        const i = header.indexOf(n.toLowerCase());
        if (i >= 0) return i;
      }
      return -1;
    };

    const dateIdx = col('datum', 'date');
    const productIdx = col('product', 'produit');
    const isinIdx = col('isin');
    const quantityIdx = col('aantal', 'quantity', 'quantité');
    const priceIdx = col('koers', 'price', 'prix');
    const currencyIdx = col('valuta', 'currency');
    const feeIdx = col('transactiekosten', 'transaction costs', 'frais de transaction');
    const totalIdx = col('totaal', 'total');

    const out: NormalizedImportRow[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.every((c) => c.trim() === '')) continue;

      const rawPayload: Record<string, unknown> = {};
      header.forEach((col, j) => { rawPayload[col] = row[j]; });

      const errors: string[] = [];
      const tradeDate = parseFlexibleDate(dateIdx >= 0 ? row[dateIdx] : null);
      if (!tradeDate) errors.push('Date manquante ou invalide');

      const isin = (isinIdx >= 0 ? row[isinIdx] : '').trim().toUpperCase() || null;
      const product = (productIdx >= 0 ? row[productIdx] : '').trim();
      const ticker = product ? this.tickerFromProduct(product) : null;

      if (!ticker && !isin) errors.push('Ni ticker ni ISIN identifiables');

      const qtyRaw = quantityIdx >= 0 ? parseLocaleNumber(row[quantityIdx]) : null;
      const quantity = qtyRaw ? qtyRaw.replace(/^-/, '') : null;
      if (!quantity) errors.push('Quantité manquante');

      const unitPrice = priceIdx >= 0 ? parseLocaleNumber(row[priceIdx]) : null;
      const currency = currencyIdx >= 0
        ? (row[currencyIdx] ?? '').trim().toUpperCase() || null
        : null;
      const brokerFee = feeIdx >= 0 ? parseLocaleNumber(row[feeIdx]) : null;

      const action = qtyRaw && qtyRaw.startsWith('-') ? 'sell' : 'buy';

      const status: NormalizedImportRow['status'] = errors.length > 0 ? 'invalid' : 'valid';

      // Total is sometimes the only reliable cross-check; parse for rawPayload use only
      if (totalIdx >= 0) rawPayload['_parsed_total'] = parseLocaleNumber(row[totalIdx]);

      out.push({
        rowNumber: i + 1,
        rawPayload,
        tradeDate,
        action,
        ticker,
        isin,
        quantity,
        unitPrice,
        currency,
        brokerFee: brokerFee ? brokerFee.replace(/^-/, '') : null,
        tax: null,
        fxRate: null,
        assetId: null,
        matchedAssetConfidence: null,
        status,
        validationErrors: errors,
      });
    }

    return out;
  }

  private tickerFromProduct(product: string): string | null {
    // Degiro product is usually "ISHARES CORE MSCI WORLD UCITS ETF USD (ACC)"
    // Not reliably mappable to ticker. Return first 10 alphanumerics as fallback label.
    const cleaned = product.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    return cleaned[0] ?? null;
  }
}
