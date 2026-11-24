import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type {
  AutomationBackfillFailReason,
  AutomationBackfillStatus,
} from './automation-backfill.constants.js';

/**
 * The Automation backfill object of routes 38–39 and the automation's `open_backfill`
 * (feat-instagram-dm-sending routes-final § 4.C.6). Never `last_error` (support reads the logs).
 */
export interface AutomationBackfillOutput {
  /** `abf_…`. */
  id: string;
  /** `aut_…`. */
  automation_id: string;
  days: number;
  status: AutomationBackfillStatus;
  posts_read: number;
  found: number;
  matched: number;
  queued_count: number;
  fail_reason: AutomationBackfillFailReason | null;
  /** `usr_…`, or `null` once the person is deleted. */
  requested_by_user_id: string | null;
  created_at: string;
  started_at: string | null;
  done_at: string | null;
  updated_at: string;
}

/** Route 38's input: the automation, the days back, who asked. */
export interface AutomationBackfillStartInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** `aut_…`. */
  automationPublicId: string;
  days: number;
  /** `usr_…`; `undefined` for an API-key principal (no acting user). */
  requestedByUserPublicId: string | undefined;
}

/** Route 39's input: the automation and the read. */
export interface AutomationBackfillGetInput {
  scope: OrganizationPrincipalDatabaseScope;
  /** `aut_…`. */
  automationPublicId: string;
  /** `abf_…`. */
  automationBackfillPublicId: string;
}

/**
 * The past-comments read job (WC-41, AU32 — the `instagram-tasks` worker of ROUTE row R41): route 38
 * enqueues the account's next read after its commit. Optional until R41 wires it; without it the
 * row stays `queued` and nothing is enqueued.
 */
export interface AutomationBackfillReadQueue {
  enqueueAutomationBackfillRead(input: {
    organizationPublicId: string;
    channelAccountPublicId: string;
    automationBackfillPublicId: string;
  }): Promise<void>;
}

/**
 * The automation's open read, as the Automation object shows it (4.A.6 `open_backfill`) — what the
 * automation service asks of this sub-domain, in its caller's unit.
 */
export interface AutomationOpenBackfillReader {
  findOpenAutomationBackfill(input: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    automationId: number;
    automationPublicId: string;
  }): Promise<AutomationBackfillOutput | null>;
}
