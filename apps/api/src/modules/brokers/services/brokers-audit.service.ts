import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';

export type BrokerAuditKind =
  | 'connection_created' | 'connection_updated' | 'connection_revoked'
  | 'connection_tested_ok' | 'connection_tested_failed'
  | 'credentials_stored' | 'credentials_rotated' | 'credentials_cleared'
  | 'sync_started' | 'sync_completed' | 'sync_failed' | 'sync_cancelled'
  | 'sync_cancelled_by_kill_switch' | 'sync_cancelled_by_mandate';

export interface BrokerAuditInput {
  userId: string;
  connectionId: string;
  syncJobId?: string | null;
  kind: BrokerAuditKind;
  reason: string;
  payload?: Record<string, unknown> | null;
}

@Injectable()
export class BrokersAuditService {
  constructor(private readonly supabase: SupabaseService) {}

  async write(input: BrokerAuditInput): Promise<string> {
    const { data: prev } = await this.supabase
      .getClient()
      .from('broker_sync_audit_events')
      .select('hash')
      .eq('user_id', input.userId)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const prevHash = (prev as { hash: string } | null)?.hash ?? null;
    const eventId = uuid();
    const hash = createHash('sha256')
      .update(`${eventId}|${input.userId}|${input.kind}|${input.reason}|${prevHash ?? ''}`)
      .digest('hex');

    await this.supabase.getClient().from('broker_sync_audit_events').insert({
      id: eventId,
      connection_id: input.connectionId,
      sync_job_id: input.syncJobId ?? null,
      user_id: input.userId,
      kind: input.kind,
      reason: input.reason,
      payload: input.payload ?? null,
      hash,
      prev_hash: prevHash,
    });

    return eventId;
  }

  async listForConnection(connectionId: string, userId: string, limit = 100) {
    const { data, error } = await this.supabase
      .getClient()
      .from('broker_sync_audit_events')
      .select('*')
      .eq('user_id', userId)
      .eq('connection_id', connectionId)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  }
}
