/**
 * P19x.6 (29/04/2026) — In-memory ring buffer pour capturer les logs Nest
 * et les exposer via admin endpoint.
 *
 * Use case : user veut grep les logs Fly (e.g. `[provider-router] eodhd 1m
 * OK for ...`, `[MÉCANIQUE] Skip closed_target ...`, `[gemini] call OK...`)
 * sans flyctl auth local. Cet endpoint expose les N derniers logs en
 * mémoire avec filter regex.
 *
 * Limites volontaires :
 *  - Buffer 5000 lignes max (rolls over) → ne grow pas indéfiniment
 *  - Pas de persistence DB → si le container restart, buffer est vide
 *  - Capture seulement après `app.useLogger(custom)` au bootstrap
 *  - N'expose JAMAIS de secrets (Logger Nest ne log pas les API keys par défaut)
 *
 * Implémentation : étend `ConsoleLogger` pour intercepter chaque log et le
 * pousser dans un singleton statique. Le controller lit ce singleton.
 *
 * Pour activer côté main.ts :
 *   const app = await NestFactory.create(AppModule, { logger: false });
 *   const bufferLogger = new BufferLogger();
 *   app.useLogger(bufferLogger);
 */

import { ConsoleLogger, type LogLevel } from '@nestjs/common';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  context: string | undefined;
  message: string;
}

const MAX_BUFFER_SIZE = 5000;

/**
 * Ring buffer singleton (process-level). Toutes les instances de BufferLogger
 * pushent dans ce buffer commun. Le AdminLogsController lit ce singleton.
 */
class LogRingBuffer {
  private static instance: LogRingBuffer | null = null;
  private buffer: LogEntry[] = [];

  static getInstance(): LogRingBuffer {
    if (!LogRingBuffer.instance) {
      LogRingBuffer.instance = new LogRingBuffer();
    }
    return LogRingBuffer.instance;
  }

  push(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER_SIZE);
    }
  }

  /**
   * Retourne les N derniers logs filtrés par regex pattern.
   * Pattern compile-once via cache simple.
   */
  recent(opts: { limit?: number; pattern?: string; level?: LogLevel } = {}): LogEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, MAX_BUFFER_SIZE));
    let regex: RegExp | null = null;
    if (opts.pattern) {
      try {
        regex = new RegExp(opts.pattern, 'i');
      } catch {
        regex = null; // pattern invalide → ignore filter
      }
    }
    const filtered = this.buffer
      .filter((e) => {
        if (opts.level && e.level !== opts.level) return false;
        if (regex && !regex.test(e.message) && !regex.test(e.context ?? '')) return false;
        return true;
      });
    return filtered.slice(-limit);
  }

  size(): number {
    return this.buffer.length;
  }
}

export const logBuffer = LogRingBuffer.getInstance();

/**
 * BufferLogger — ConsoleLogger qui mirror chaque log dans le ring buffer.
 *
 * Wire au bootstrap :
 *   app.useLogger(new BufferLogger());
 */
export class BufferLogger extends ConsoleLogger {
  override log(message: unknown, context?: string): void {
    super.log(message as string, context);
    this.capture('log', message, context);
  }

  override warn(message: unknown, context?: string): void {
    super.warn(message as string, context);
    this.capture('warn', message, context);
  }

  override error(message: unknown, trace?: string, context?: string): void {
    super.error(message as string, trace, context);
    this.capture('error', message, context);
    if (trace) this.capture('error', `  ${trace.slice(0, 500)}`, context);
  }

  override debug(message: unknown, context?: string): void {
    super.debug(message as string, context);
    this.capture('debug', message, context);
  }

  override verbose(message: unknown, context?: string): void {
    super.verbose(message as string, context);
    this.capture('verbose', message, context);
  }

  private capture(level: LogLevel, message: unknown, context?: string): void {
    const text = typeof message === 'string' ? message : JSON.stringify(message);
    logBuffer.push({
      timestamp: Date.now(),
      level,
      context,
      // Truncate to avoid huge payloads
      message: text.length > 2000 ? text.slice(0, 2000) + '…[truncated]' : text,
    });
  }
}
