import type {
  AutomationBackfillFailReason,
  AutomationBackfillStatus,
} from './automation-backfill.constants.js';
import type { AutomationBackfillOutput } from './automation-backfill.types.js';

/** The `app.automation_backfills` columns the object reads (never `last_error`). */
interface AutomationBackfillSerializableRow {
  public_id: string;
  days: number;
  status: string;
  posts_read: number;
  found: number;
  matched: number;
  queued_count: number;
  fail_reason: string | null;
  created_at: Date;
  started_at: Date | null;
  done_at: Date | null;
  updated_at: Date;
}

/**
 * Shapes one past-comments read as the Automation backfill object of routes 38–39 and the
 * automation's `open_backfill` (feat-instagram-dm-sending routes-final § 4.C.6).
 *
 * @remarks
 * Pure — the service resolves the automation's and the person's public ids first. Internal ids and
 * `last_error` (codes for support) never leave.
 */
export function serializeAutomationBackfill({
  backfill,
  automation_public_id,
  requested_by_user_public_id,
}: {
  backfill: AutomationBackfillSerializableRow;
  automation_public_id: string;
  requested_by_user_public_id: string | null;
}): AutomationBackfillOutput {
  return {
    id: backfill.public_id,
    automation_id: automation_public_id,
    days: backfill.days,
    status: backfill.status as AutomationBackfillStatus,
    posts_read: backfill.posts_read,
    found: backfill.found,
    matched: backfill.matched,
    queued_count: backfill.queued_count,
    fail_reason: backfill.fail_reason as AutomationBackfillFailReason | null,
    requested_by_user_id: requested_by_user_public_id,
    created_at: backfill.created_at.toISOString(),
    started_at: backfill.started_at?.toISOString() ?? null,
    done_at: backfill.done_at?.toISOString() ?? null,
    updated_at: backfill.updated_at.toISOString(),
  };
}
