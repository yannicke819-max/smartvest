import { Injectable } from '@nestjs/common';
import { BrokerImportAdapter } from './broker-import-adapter.interface';
import { InteractiveBrokersParser } from './interactive-brokers.parser';
import { DegiroParser } from './degiro.parser';

@Injectable()
export class ParserRegistry {
  private readonly adapters: BrokerImportAdapter[];

  constructor(
    ib: InteractiveBrokersParser,
    degiro: DegiroParser,
  ) {
    this.adapters = [ib, degiro];
  }

  getAll(): BrokerImportAdapter[] {
    return this.adapters;
  }

  getByFormat(format: string): BrokerImportAdapter | null {
    return this.adapters.find((a) => a.format === format) ?? null;
  }

  /** Run detect() on all adapters and pick the best match. */
  detectBest(csvContent: string): { adapter: BrokerImportAdapter; confidence: number } | null {
    let best: { adapter: BrokerImportAdapter; confidence: number } | null = null;
    for (const adapter of this.adapters) {
      const confidence = adapter.detect(csvContent);
      if (!best || confidence > best.confidence) {
        best = { adapter, confidence };
      }
    }
    return best && best.confidence > 0.3 ? best : null;
  }
}
