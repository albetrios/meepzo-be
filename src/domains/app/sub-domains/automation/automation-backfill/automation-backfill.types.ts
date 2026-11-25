import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type {
  AutomationBackfillFailReason,
  AutomationBackfillStatus,
} from './automation-backfill.constants.js';
import type {
  AutomationBackfillKey,
  AutomationBackfillReadTarget,
} from './automation-backfill.repository.js';

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
 * The past-comments read job (WC-41, AU32 — Instagram's `automation-backfill-read` task on
 * `instagram-tasks`, ROUTE row R41): route 38 wakes the account's reads after its commit, the watch
 * wakes a stuck one, an ended read wakes the account's next. Wired by the app container; without
 * it (a unit test) the row stays `queued` and nothing is enqueued.
 */
export interface AutomationBackfillReadQueue {
  enqueueAutomationBackfillRead(input: {
    organizationPublicId: string;
    channelAccountPublicId: string;
    /** `abf_…` — the read that asked (route 38); absent for the watch's wake-up of the account. */
    automationBackfillPublicId?: string | undefined;
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

/**
 * A started past-comments read as the read job works it (WC-41, AU32): its keys, the start it
 * carries (every write is guarded by it, so a read started again by the watch stops the old job),
 * the days back and the automation's fields (`null` when the automation is deleted).
 */
export interface AutomationBackfillRead {
  key: AutomationBackfillKey;
  /** `abf_…`. */
  automationBackfillPublicId: string;
  startedAt: Date;
  days: number;
  target: AutomationBackfillReadTarget | null;
}

/**
 * What `beginAutomationBackfillRead` found (AU32): a read to work (`reading`), another read of the
 * account still running (`busy`), nothing queued (`none`), the resumed read ended or started again
 * (`ended`), or the feature check refused it — the read ended `failed` (`refused`).
 */
export type AutomationBackfillReadBegin =
  | { kind: 'reading'; read: AutomationBackfillRead }
  | { kind: 'busy' }
  | { kind: 'none' }
  | { kind: 'ended' }
  | { kind: 'refused'; failReason: AutomationBackfillFailReason };
