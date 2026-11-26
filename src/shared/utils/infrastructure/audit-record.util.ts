import type { FastifyBaseLogger } from 'fastify';
import type { AuditService } from '@/domains/audit/audit.service.js';
import type { AuditLogRecordInput } from '@/domains/audit/audit.types.js';

/**
 * Best-effort audit write — failures are logged and must not fail the HTTP request or the job.
 */
export async function recordAuditEvent({
  auditService,
  input,
  log,
}: {
  auditService: Pick<AuditService, 'record'>;
  input: AuditLogRecordInput;
  /** The request's logger, or the shared one where there is no request (a job, an after-commit). */
  log: Pick<FastifyBaseLogger, 'warn'>;
}): Promise<void> {
  try {
    await auditService.record(input);
  } catch (error) {
    log.warn({ error, action: input.action }, 'audit.record.failed');
  }
}
