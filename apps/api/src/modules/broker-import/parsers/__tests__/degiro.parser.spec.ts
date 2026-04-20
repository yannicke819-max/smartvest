import { DegiroParser } from '../degiro.parser';

const DEGIRO_SAMPLE = `Datum,Tijd,Product,ISIN,Beurs,Uitvoeringsplaats,Aantal,Koers,,Valuta,Transactiekosten,Totaal
15-03-2024,14:30,ISHARES CORE MSCI WORLD,IE00B4L5Y983,EAM,MESI,10,85,75,EUR,-2,00,-859,50
16-03-2024,10:00,VANGUARD S P 500 UCITS ETF,IE00B3XXRP09,LSE,LSE,5,95,20,USD,-2,50,-478,50
`;

describe('DegiroParser', () => {
  const parser = new DegiroParser();

  it('detects degiro CSV by headers', () => {
    expect(parser.detect(DEGIRO_SAMPLE)).toBeGreaterThan(0.3);
  });

  it('parses rows and extracts ISIN', () => {
    const rows = parser.parse(DEGIRO_SAMPLE);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const first = rows[0];
    expect(first.isin).toBe('IE00B4L5Y983');
    expect(first.tradeDate).toBe('2024-03-15');
    expect(first.currency).toBe('EUR');
  });

  it('maps to buy action when quantity positive', () => {
    const rows = parser.parse(DEGIRO_SAMPLE);
    expect(rows[0].action).toBe('buy');
  });
});
