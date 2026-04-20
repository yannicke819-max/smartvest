import { createHash } from 'node:crypto';
import type { AuditAction, ExecutionAudit } from '@smartvest/domain';

export interface AuditEntryInput {
  userId: string | null;
  action: AuditAction;
  subjectType: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
}

// Journal append-only avec hash chaîné — rejouable et détection de tampering.
export function buildAuditEntry(
  input: AuditEntryInput,
  prevHash: string | null,
  now: Date = new Date(),
): Omit<ExecutionAudit, 'id'> {
  const createdAt = now.toISOString();
  const body = JSON.stringify({
    userId: input.userId,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    payload: input.payload,
    prevHash,
    createdAt,
  });
  const hash = createHash('sha256').update(body).digest('hex');
  return {
    userId: input.userId,
    action: input.action,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    payload: input.payload,
    prevHash,
    hash,
    createdAt,
  };
}
