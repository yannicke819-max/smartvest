import { Injectable, Logger, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { SupabaseService } from '../../supabase/supabase.service';
import { BrokerSyncJob, BrokerSyncResult, SyncKind } from '../dto/broker-sync.dto';

/**
 * BrokerSyncService handles the *architecture* of broker read-only data synchronization.
 *
 * Phase 4 scope:
 *  - create sync jobs
 *  - track status / errors
 *  - enforce sync_mode == 'read_only' on the connection
 *  - NO actual broker API calls — connectors will be plugged in Phase 5+
 *
 * If BROKER_EXECUTION_ENABLED flag is false, execution_live sync mode is rejected.
 */
@Injectable()
export class BrokerSyncService {
  private readonly logger = new Logger(BrokerSyncService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async listConnections(userId: string, portfolioId: string) {
    if (!this.supabase.isReady()) return [];
    const { data } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('*')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId);
    return data ?? [];
  }

  async listSyncJobs(userId: string, portfolioId: string): Promise<BrokerSyncJob[]> {
    if (!this.supabase.isReady()) return [];
    const { data } = await this.supabase
      .getClient()
      .from('broker_sync_jobs')
      .select('*')
      .eq('user_id', userId)
      .eq('portfolio_id', portfolioId)
      .order('created_at', { ascending: false })
      .limit(50);
    return (data ?? []).map((row) => this.toJob(row));
  }

  async createSyncJob(input: {
    userId: string;
    portfolioId: string;
    connectionId: string | null;
    syncKind: SyncKind;
  }): Promise<BrokerSyncResult> {
    const startedAt = new Date().toISOString();

    if (input.connectionId) {
      const connection = await this.getConnection(input.userId, input.connectionId);
      if (!connection) throw new BadRequestException('Connexion broker introuvable');
      if (connection.sync_mode === 'execution_live') {
        throw new UnauthorizedException('sync_mode execution_live requiert un mandat valide');
      }
    }

    let jobId = '';
    if (this.supabase.isReady()) {
      const { data, error } = await this.supabase
        .getClient()
        .from('broker_sync_jobs')
        .insert({
          connection_id: input.connectionId,
          portfolio_id: input.portfolioId,
          user_id: input.userId,
          sync_kind: input.syncKind,
          status: 'pending',
          started_at: startedAt,
        })
        .select('id')
        .single();

      if (error || !data) {
        this.logger.warn(`createSyncJob failed: ${error?.message}`);
      } else {
        jobId = data.id as string;
      }
    }

    // Phase 4 scaffolding: no connector actually runs yet
    const completedAt = new Date().toISOString();
    if (this.supabase.isReady() && jobId) {
      await this.supabase
        .getClient()
        .from('broker_sync_jobs')
        .update({
          status: 'done',
          rows_synced: 0,
          rows_errored: 0,
          completed_at: completedAt,
          error_message: 'Connecteur broker non encore implémenté — scaffolding Phase 4',
        })
        .eq('id', jobId);
    }

    return {
      jobId,
      connectionId: input.connectionId,
      syncKind: input.syncKind,
      status: 'done',
      rowsSynced: 0,
      rowsErrored: 0,
      startedAt,
      completedAt,
      errors: ['Connecteur non actif — scaffolding uniquement'],
    };
  }

  private async getConnection(userId: string, connectionId: string) {
    if (!this.supabase.isReady()) return null;
    const { data } = await this.supabase
      .getClient()
      .from('broker_connections')
      .select('*')
      .eq('id', connectionId)
      .eq('user_id', userId)
      .single();
    return data;
  }

  private toJob(row: Record<string, unknown>): BrokerSyncJob {
    return {
      id: row['id'] as string,
      connectionId: (row['connection_id'] as string) ?? null,
      portfolioId: row['portfolio_id'] as string,
      userId: row['user_id'] as string,
      syncKind: row['sync_kind'] as SyncKind,
      status: row['status'] as BrokerSyncJob['status'],
      rowsSynced: (row['rows_synced'] as number) ?? 0,
      rowsErrored: (row['rows_errored'] as number) ?? 0,
      errorMessage: (row['error_message'] as string) ?? null,
      startedAt: (row['started_at'] as string) ?? null,
      completedAt: (row['completed_at'] as string) ?? null,
      createdAt: row['created_at'] as string,
    };
  }
}
