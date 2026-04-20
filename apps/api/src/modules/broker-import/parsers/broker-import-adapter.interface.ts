import { NormalizedImportRow } from '../dto/import-row.dto';

/**
 * A BrokerImportAdapter parses a broker-specific CSV and emits normalized rows.
 * Each adapter owns: format detection, row parsing, field mapping, initial validation.
 * Asset matching and duplicate detection happen in the import service (not per-adapter).
 */
export interface BrokerImportAdapter {
  readonly format: string; // 'interactive_brokers' | 'degiro' | ...
  readonly label: string;

  /** Heuristic detection — returns confidence 0..1 from CSV header/content. */
  detect(csvContent: string): number;

  /** Parse CSV → normalized rows (no DB access, pure function). */
  parse(csvContent: string): NormalizedImportRow[];
}
