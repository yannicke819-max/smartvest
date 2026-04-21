import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { v4 as uuid } from 'uuid';
import { SupabaseService } from '../../supabase/supabase.service';
import type { HyperTradingAuditKind } from '@smartvest/domain';

export interface HyperTradingAuditInput {
  userId: string;
  profileId: string;
  sessionId?: string | null;
  kind: HyperTradingAuditKind;
  reason: string;
  payload?: Record<string, unknown> | null;
}

/**
 * Hash-chained audit for hyper-trading transitions and guardrail decisions.
 * chain: hash = sha256(eventId | userId | kind | reason | prevHash)
 */
@Injectable()
export class HyperTradingAuditService {
  constructor(private readonly supabase: SupabaseService) {}

  async write(input: HyperTradingAuditInput): Promise<string> {
    const { data: prev } = await this.supabase
      .getClient()
      .from('hyper_trading_audit_events')
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

    await this.supabase.getClient().from('hyper_trading_audit_events').insert({
      id: eventId,
      profile_id: input.profileId,
      session_id: input.sessionId ?? null,
      user_id: input.userId,
      kind: input.kind,
      reason: input.reason,
      payload: input.payload ?? null,
      hash,
      prev_hash: prevHash,
    });

    return eventId;
  }

  async listForProfile(profileId: string, userId: string, limit = 100) {
    const { data, error } = await this.supabase
      .getClient()
      .from('hyper_trading_audit_events')
      .select('*')
      .eq('user_id', userId)
      .eq('profile_id', profileId)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    return data ?? [];
  }
}
