import { InteractiveBrokersParser } from '../interactive-brokers.parser';

const IB_SAMPLE = `Statement,Header,Field Name,Field Value
Statement,Data,BrokerName,Interactive Brokers
Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Comm/Fee,Tax,Buy/Sell,TradeDate
Trades,Data,Order,Stocks,USD,AAPL,"2024-03-15, 14:30:00",10,175.50,-1.00,0,BUY,2024-03-15
Trades,Data,Order,Stocks,USD,MSFT,"2024-03-16, 10:00:00",5,410.25,-1.00,0,BUY,2024-03-16
Trades,Data,Order,Stocks,USD,AAPL,"2024-04-01, 14:30:00",-3,180.00,-1.00,0,SELL,2024-04-01
`;

describe('InteractiveBrokersParser', () => {
  const parser = new InteractiveBrokersParser();

  it('detects IB format from content', () => {
    expect(parser.detect(IB_SAMPLE)).toBeGreaterThan(0.5);
  });

  it('returns 0 detection for non-IB CSV', () => {
    expect(parser.detect('Datum,Product,ISIN\n01-01-2024,Foo,FR0000000001')).toBeLessThan(0.3);
  });

  it('parses 3 transactions from the sample', () => {
    const rows = parser.parse(IB_SAMPLE);
    expect(rows).toHaveLength(3);
  });

  it('maps AAPL BUY correctly', () => {
    const rows = parser.parse(IB_SAMPLE);
    const aapl = rows[0];
    expect(aapl.ticker).toBe('AAPL');
    expect(aapl.action).toBe('buy');
    expect(aapl.quantity).toBe('10');
    expect(aapl.unitPrice).toBe('175.50');
    expect(aapl.currency).toBe('USD');
    expect(aapl.tradeDate).toBe('2024-03-15');
    expect(aapl.status).toBe('valid');
  });

  it('detects SELL correctly', () => {
    const rows = parser.parse(IB_SAMPLE);
    const sell = rows[2];
    expect(sell.action).toBe('sell');
    expect(sell.quantity).toBe('3'); // absolute value
  });

  it('marks row invalid when required fields missing', () => {
    const bad = `Statement,Header,Field Name,Field Value
Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,Comm/Fee,Tax,Buy/Sell,TradeDate
Trades,Data,Order,Stocks,,,"2024-03-15",10,,,0,BUY,2024-03-15
`;
    const rows = parser.parse(bad);
    expect(rows[0].status).toBe('invalid');
    expect(rows[0].validationErrors.length).toBeGreaterThan(0);
  });
});
