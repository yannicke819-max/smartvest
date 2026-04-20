import { z } from 'zod';
import { Uuid } from '@smartvest/shared-types';

export const AuditAction = z.enum([
  'user_auth',
  'portfolio_create',
  'portfolio_update',
  'account_link',
  'transaction_import',
  'transaction_create',
  'scenario_run',
  'flag_toggle',
  'suggestion_view',
  'suggestion_act',
  'order_draft',
  'order_submit',
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const ExecutionAudit = z.object({
  id: Uuid,
  userId: Uuid.nullable(),
  action: AuditAction,
  subjectType: z.string(),
  subjectId: z.string().nullable(),
  payload: z.record(z.unknown()),
  prevHash: z.string().nullable(),
  hash: z.string(),
  createdAt: z.string().datetime(),
});
export type ExecutionAudit = z.infer<typeof ExecutionAudit>;
