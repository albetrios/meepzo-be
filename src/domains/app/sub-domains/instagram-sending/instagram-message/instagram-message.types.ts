import type { ChannelMessageResultInput } from '@/domains/app/app.channel-ports.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type {
  InstagramMessageChannel,
  InstagramMessageFinalStatus,
  InstagramMessageReason,
  InstagramSendAttemptCountGroup,
} from './instagram-message.constants.js';
import type { InstagramMessageKey } from './instagram-message.repository.js';
import type { InstagramSendAttemptKey } from './instagram-send-attempt.repository.js';

/**
 * The run engine's save-result entry point (4.B `AutomationRunService.recordMessageResult`, AU35) —
 * a closure in the app container, since the engine is built after this service.
 */
export type InstagramMessageRunResultPort = (input: ChannelMessageResultInput) => Promise<void>;

/**
 * The `retry-failed` job on `instagram-tasks` (WC-42, ROUTE row R46): one job per automation or
 * contact (job id `retry-failed-<aut_… or con_…>`), added after the press. Until R46 wires it the
 * retry runs in the request, piece by piece (P136).
 */
export interface InstagramMessageRetryQueue {
  enqueueRetryFailed(input: {
    organizationPublicId: string;
    by: 'automation' | 'contact';
    id: number;
  }): Promise<void>;
}

/** The claim's message and attempt parts (SN3 (d)) — the lanes' commit adds the gates (R42). */
export interface InstagramMessageClaimInput {
  scope: OrganizationPrincipalDatabaseScope;
  key: InstagramMessageKey;
  lane: InstagramSendLane;
  channel: InstagramMessageChannel | null;
  countGroup: InstagramSendAttemptCountGroup;
}

/**
 * One answer to save (SN4 `saveSendResult`): the message's final status and Meta's id and codes,
 * the attempt's result group, HTTP status and duration.
 */
export interface InstagramSendResultInput {
  scope: OrganizationPrincipalDatabaseScope;
  key: InstagramMessageKey;
  attempt: InstagramSendAttemptKey | null;
  status: InstagramMessageFinalStatus;
  reason: InstagramMessageReason | null;
  /** Meta's `mid` of a sent message. */
  instagramMessageId: string | null;
  errorCode: number | null;
  errorSubcode: number | null;
  /** `sent` or a group of 6.A.10. */
  resultGroup: string;
  httpStatus: number | null;
  durationMilliseconds: number | null;
}
