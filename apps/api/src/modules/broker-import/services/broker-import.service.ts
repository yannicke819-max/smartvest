import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { SupabaseService } from '../../supabase/supabase.service';
import { ParserRegistry } from '../parsers/parser-registry';
import { AssetMatcherService } from './asset-matcher.service';
import {
  NormalizedImportRow,
  ImportPreviewResult,
  ImportCommitResult,
} from '../dto/import-row.dto';

export interface PreviewInput {
  userId: string;
  portfolioId: string;
  accountId: string | null;
  csvContent: string;
  filename: string | null;
  brokerFormat: string | null; // if null, auto-detect
}

@Injectable()
export class BrokerImportService {
  private readonly logger = new Logger(BrokerImportService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly registry: ParserRegistry,
    private readonly assetMatcher: AssetMatcherService,
  ) {}

  async preview(input: PreviewInput): Promise<ImportPreviewResult> {
    if (!input.csvContent || input.csvContent.trim().length === 0) {
      throw new BadRequestException('CSV vide');
    }

    // Resolve adapter
    const adapter = input.brokerFormat
      ? this.registry.getByFormat(input.brokerFormat)
      : this.registry.detectBest(input.csvContent)?.adapter ?? null;

    if (!adapter) {
      throw new BadRequestException('Format broker non reconnu — sélectionner manuellement');
    }

    // Parse
    const parsed = adapter.parse(input.csvContent);
    if (parsed.length === 0) {
      throw new BadRequestException('Aucune ligne exploitable dans le CSV');
    }

    // Asset matching
    const enriched = await this.assetMatcher.enrich(parsed);

    // Duplicate detection
    const withDuplicates = await this.detectDuplicates(input.portfolioId, enriched);

    const rowsValid = withDuplicates.filter((r) => r.status === 'valid').length;
    const rowsInvalid = withDuplicates.filter((r) => r.status === 'invalid').length;
    const rowsDuplicate = withDuplicates.filter((r) => r.status === 'duplicate').length;

    // Persist job + rows
    const sha = createHash('sha256').update(input.csvContent).digest('hex');
    const jobId = await this.createJob({
      userId: input.userId,
      portfolioId: input.portfolioId,
      accountId: input.accountId,
      filename: input.filename,
      fileSha256: sha,
      brokerFormat: adapter.format,
      rowsDetected: withDuplicates.length,
      rowsValid,
      rowsInvalid,
    });

    if (jobId) {
      await this.insertRows(jobId, withDuplicates);
      await this.markPreviewed(jobId);
    }

    return {
      jobId: jobId ?? 'no-job',
      brokerFormat: adapter.format,
      filename: input.filename,
      rowsDetected: withDuplicates.length,
      rowsValid,
      rowsInvalid,
      rowsDuplicate,
      rows: withDuplicates,
    };
  }

  async commit(userId: string, jobId: string, rowsToSkip: number[] = []): Promise<ImportCommitResult> {
    if (!this.supabase.isReady()) {
      return { jobId, rowsCommitted: 0, rowsSkipped: 0, transactionsCreated: 0, positionsUpdated: 0 };
    }
    const client = this.supabase.getClient();

    const { data: job, error: jobErr } = await client
      .from('import_jobs')
      .select('id, portfolio_id, account_id, status, user_id')
      .eq('id', jobId)
      .single();

    if (jobErr || !job) throw new BadRequestException('Import introuvable');
    if ((job.user_id as string) !== userId) throw new BadRequestException('Import non autorisé');
    if (job.status !== 'previewed') throw new BadRequestException('Import non prévisualisé');

    const { data: rows, error: rowsErr } = await client
      .from('import_rows')
      .select('*')
      .eq('job_id', jobId)
      .eq('status', 'valid');

    if (rowsErr || !rows) throw new BadRequestException('Lignes introuvables');

    let transactionsCreated = 0;
    let rowsCommitted = 0;
    let rowsSkipped = 0;

    for (const r of rows) {
      if (rowsToSkip.includes(r.row_number as number)) {
        await client.from('import_rows').update({ status: 'skipped' }).eq('id', r.id);
        rowsSkipped++;
        continue;
      }

      const accountId = (job.account_id as string) ?? (await this.ensureDefaultAccount(client, job.portfolio_id as string, userId));
      if (!accountId) { rowsSkipped++; continue; }

      const { error: txErr } = await client.from('transactions').insert({
        account_id: accountId,
        asset_id: r.asset_id,
        type: r.action,
        trade_date: r.trade_date,
        quantity: r.quantity,
        unit_price: r.unit_price,
        currency: r.currency,
        note: `import:${jobId}:row:${r.row_number}`,
      });

      if (txErr) {
        this.logger.error(`commit row ${r.row_number} failed: ${txErr.message}`);
        rowsSkipped++;
        continue;
      }

      await client.from('import_rows').update({ status: 'committed' }).eq('id', r.id);
      transactionsCreated++;
      rowsCommitted++;
    }

    await client
      .from('import_jobs')
      .update({
        status: 'committed',
        rows_committed: rowsCommitted,
        committed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    return {
      jobId,
      rowsCommitted,
      rowsSkipped,
      transactionsCreated,
      positionsUpdated: 0, // reconstitution is handled by PortfolioReconstitutionService
    };
  }

  async history(userId: string, portfolioId: string) {
    if (!this.supabase.isReady()) return [];
    const { data } = await this.supabase
      .getClient()
      .from('import_jobs')
      .select('*')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('created_at', { ascending: false })
      .limit(50);
    return data ?? [];
  }

  private async detectDuplicates(
    portfolioId: string,
    rows: NormalizedImportRow[],
  ): Promise<NormalizedImportRow[]> {
    if (!this.supabase.isReady()) return rows;
    const client = this.supabase.getClient();

    // Fetch existing transactions for this portfolio (last 2 years)
    const since = new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10);
    const { data: existing } = await client
      .from('transactions')
      .select('asset_id, trade_date, quantity, unit_price, portfolio_accounts!inner(portfolio_id)')
      .eq('portfolio_accounts.portfolio_id', portfolioId)
      .gte('trade_date', since);

    if (!existing) return rows;

    const key = (assetId: string | null, date: string | null, qty: string | null, price: string | null) =>
      `${assetId ?? ''}|${date ?? ''}|${qty ?? ''}|${price ?? ''}`;

    const seen = new Set<string>();
    for (const t of existing) {
      seen.add(
        key(t.asset_id as string | null, t.trade_date as string | null, String(t.quantity ?? ''), String(t.unit_price ?? '')),
      );
    }

    return rows.map((r) =>
      r.status === 'valid' && seen.has(key(r.assetId, r.tradeDate, r.quantity, r.unitPrice))
        ? { ...r, status: 'duplicate' as const, validationErrors: [...r.validationErrors, 'Transaction déjà existante'] }
        : r,
    );
  }

  private async createJob(input: {
    userId: string;
    portfolioId: string;
    accountId: string | null;
    filename: string | null;
    fileSha256: string;
    brokerFormat: string;
    rowsDetected: number;
    rowsValid: number;
    rowsInvalid: number;
  }): Promise<string | null> {
    if (!this.supabase.isReady()) return null;
    const { data, error } = await this.supabase
      .getClient()
      .from('import_jobs')
      .insert({
        portfolio_id: input.portfolioId,
        user_id: input.userId,
        source: 'csv',
        broker_format: input.brokerFormat,
        account_id: input.accountId,
        filename: input.filename,
        file_sha256: input.fileSha256,
        rows_detected: input.rowsDetected,
        rows_valid: input.rowsValid,
        rows_invalid: input.rowsInvalid,
      })
      .select('id')
      .single();
    if (error || !data) { this.logger.warn(`createJob failed: ${error?.message}`); return null; }
    return data.id as string;
  }

  private async insertRows(jobId: string, rows: NormalizedImportRow[]): Promise<void> {
    if (!this.supabase.isReady() || rows.length === 0) return;
    const payload = rows.map((r) => ({
      job_id: jobId,
      row_number: r.rowNumber,
      raw_payload: r.rawPayload,
      trade_date: r.tradeDate,
      action: r.action,
      ticker: r.ticker,
      isin: r.isin,
      quantity: r.quantity,
      unit_price: r.unitPrice,
      currency: r.currency,
      broker_fee: r.brokerFee,
      tax: r.tax,
      fx_rate: r.fxRate,
      asset_id: r.assetId,
      matched_asset_confidence: r.matchedAssetConfidence,
      status: r.status,
      validation_errors: r.validationErrors,
    }));
    await this.supabase.getClient().from('import_rows').insert(payload);
  }

  private async markPreviewed(jobId: string): Promise<void> {
    await this.supabase
      .getClient()
      .from('import_jobs')
      .update({ status: 'previewed', previewed_at: new Date().toISOString() })
      .eq('id', jobId);
  }

  private async ensureDefaultAccount(client: ReturnType<SupabaseService['getClient']>, portfolioId: string, userId: string): Promise<string | null> {
    const { data: existing } = await client
      .from('portfolio_accounts')
      .select('id')
      .eq('portfolio_id', portfolioId)
      .limit(1);
    if (existing && existing.length > 0) return existing[0].id as string;

    const { data: created } = await client
      .from('portfolio_accounts')
      .insert({
        portfolio_id: portfolioId,
        user_id: userId,
        label: 'Compte import',
        kind: 'brokerage',
        currency: 'EUR',
      })
      .select('id')
      .single();
    return (created?.id as string) ?? null;
  }
}
