import {
  type OrganizationPrincipalDatabaseScope,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { assertTeamOrganizationForRead } from '@/domains/tenancy/sub-domains/organization/organization-capability.js';
import { INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS } from '@/shared/constants/instagram.constants.js';
import type { InstagramWebhookEventSkipReason } from './instagram-webhook-event.constants.js';
import { InstagramWebhookEventKeyRepository } from './instagram-webhook-event-key.repository.js';
import type {
  InstagramWebhookEventAccountKey,
  InstagramWebhookEventClaimKey,
  InstagramWebhookEventClaimResult,
  InstagramWebhookEventRepository,
  InstagramWebhookEventRow,
  NewInstagramWebhookEvent,
} from './instagram-webhook-event.repository.js';
import { serializeInstagramWebhookEvent } from './instagram-webhook-event.serializer.js';
import type {
  InstagramWebhookEventListInput,
  InstagramWebhookEventListResult,
} from './instagram-webhook-event.types.js';

/**
 * The organization scope and the account an event write acts on.
 *
 * @remarks
 * Notes: the scope's organization must be the account's — under any other the rows are invisible
 * and unwritable (RLS). The receiver passes its verified organization scope (WH3 — a signed Meta
 * delivery, the minter it ledgers), processing its job scope (K8); a call inside the caller's open
 * unit of work joins it.
 */
export interface InstagramWebhookEventAccountTarget {
  scope: OrganizationPrincipalDatabaseScope;
  /** The organization and the channel account the events belong to (§ 5.B.3). */
  channelAccount: InstagramWebhookEventAccountKey;
}

/** Milliseconds in one day. */
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

/**
 * The UTC day (`YYYY-MM-DD`) an event's key is filed under (WH20): the day of Meta's own time for
 * the item, else — Meta named no time — the day it was received.
 *
 * @remarks
 * Algorithm: the ISO date of the time, in UTC. Failure modes: none — pure. Side effects: none.
 * Notes: computed once in the store function for all three paths (webhook, missed comments, past
 * comments), so a comment read twice files under one day (WHC12).
 */
export function instagramWebhookEventDay({
  occurredAt,
  receivedAt,
}: {
  occurredAt: Date | null;
  receivedAt: Date;
}): string {
  return (occurredAt ?? receivedAt).toISOString().slice(0, 10);
}

/**
 * The replay guard (WH9 step 5): whether Meta's time for the event is more than
 * {@link INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS} days before `now` — its key's day part may already be
 * gone, so it is never saved. An event without a Meta time is never a replay.
 *
 * @remarks
 * Algorithm: one comparison in milliseconds. Failure modes: none — pure. Side effects: none.
 * Notes: exactly 8 days old is still kept; older is dropped (AC-16.4).
 */
export function isInstagramWebhookEventReplay({
  occurredAt,
  now,
}: {
  occurredAt: Date | null;
  now: Date;
}): boolean {
  if (occurredAt === null) return false;
  return (
    now.getTime() - occurredAt.getTime() > INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS * DAY_MILLISECONDS
  );
}

/**
 * The organization scope and the claim a processing write acts on (WH12–WH14).
 *
 * @remarks
 * Notes: the claim's attempt count is its token — a write applies only while the row still carries
 * it, so a run whose 5-minute lease ran out (and another run claimed the event) changes nothing.
 */
export interface InstagramWebhookEventClaimTarget {
  scope: OrganizationPrincipalDatabaseScope;
  claim: InstagramWebhookEventClaimKey;
}

/**
 * The Instagram webhook events service (routes-final § 4.B): route 62's list, and the one write
 * path for `app.instagram_webhook_events` — the receiver (4.A, routes 16–17) stores events and
 * marks them `queued`, event processing claims and marks them; neither holds the table's SQL (WH1).
 *
 * @remarks
 * Algorithm:
 * - Every method runs in `withAppDatabaseContext` with the caller's organization scope, so a call
 *   inside an open unit of work joins it (the receiver reads the account's state and stores the
 *   entry's events in one unit, WH10).
 * - Route 62 is a team-only read (K1): a personal organization answers
 *   `404 team_organization_required` (`assertTeamOrganizationForRead`) behind the permission gate.
 *
 * Failure modes:
 * - Route 62: `400` on `after` for a cursor minted elsewhere or under other filters (from the
 *   repository); `404 team_organization_required`.
 * - The write methods return `null` / `false` / `0` when the rows are not in the state they need.
 *
 * Side effects:
 * - Writes `app.instagram_webhook_events` only. No audit entry — events are not team actions
 *   (WH6). A contact erase registers no erasure step here: the person's events wait for the 30-day
 *   clean-up (WH18, contacts CQ1).
 *
 * Notes:
 * - Which kind, key and status an event gets (WH9, WH10) and when it is claimed or marked (WH12–
 *   WH14) are the receiver's and processing's decisions; this service only writes them.
 */
export class InstagramWebhookEventService {
  constructor(
    private readonly eventRepository: InstagramWebhookEventRepository,
    private readonly organizationService: OrganizationService,
    private readonly eventKeyRepository: InstagramWebhookEventKeyRepository = new InstagramWebhookEventKeyRepository(),
  ) {}

  /**
   * Route 62 (WH17): the organization's events newest first, filtered and paged, each with its
   * payload masked.
   *
   * @remarks
   * Algorithm: in the caller's organization scope — the team check (`404
   * team_organization_required` for a personal organization), then the repository's keyset page
   * (organization filter plus RLS), then the serializer (masking). Failure modes: as the class lists
   * for route 62. Side effects: none — route 62 never changes an event.
   */
  async listEvents({
    scope,
    filters,
  }: InstagramWebhookEventListInput): Promise<InstagramWebhookEventListResult> {
    const page = await withAppDatabaseContext({
      scope,
      callback: async () => {
        const organization = await this.organizationService.requireOrganizationByPublicId(
          scope.organizationPublicId,
        );
        assertTeamOrganizationForRead({ organization });
        return this.eventRepository.listByOrganization({
          organizationId: organization.id,
          filters,
        });
      },
    });
    return {
      items: page.items.map((row) => serializeInstagramWebhookEvent(row)),
      total: page.total,
      limit: page.limit,
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    };
  }

  /**
   * The store function (WH9 steps 5–6, WH20): saves one account's events — born `received`, or
   * `skipped` with their reason and no body — and returns the rows this call inserted. A repeat (a
   * key already seen on its Meta day) and a replay (Meta's time over 8 days old) save nothing. The
   * one write path of the webhook, the missed-comment check and a past-comments read.
   *
   * @remarks
   * Algorithm: in one unit of the caller's organization scope — drop the replays
   * ({@link isInstagramWebhookEventReplay}); file each key under its Meta day
   * ({@link instagramWebhookEventDay}, computed here once for every path); insert the keys into
   * `app.instagram_webhook_event_keys` `ON CONFLICT DO NOTHING`; insert, in one statement, the events
   * of only the keys that statement returned. Failure modes: a database error propagates and the
   * unit rolls back whole — the receiver then answers `500` / `503` so Meta delivers again (WH2).
   * Side effects: inserts key rows and event rows.
   */
  async recordReceivedEvents({
    scope,
    channelAccount,
    requestId,
    events,
    now = new Date(),
  }: InstagramWebhookEventAccountTarget & {
    requestId: string | null;
    events: readonly NewInstagramWebhookEvent[];
    /** The received time the replay guard and a time-less event's day read; defaults to now. */
    now?: Date;
  }): Promise<InstagramWebhookEventRow[]> {
    const fresh = events.filter(
      (event) => !isInstagramWebhookEventReplay({ occurredAt: event.occurredAt, now }),
    );
    if (fresh.length === 0) return [];
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const newKeys = await this.eventKeyRepository.insertNewKeys({
          ...channelAccount,
          keys: fresh.map((event) => ({
            eventKey: event.eventKey,
            eventDay: instagramWebhookEventDay({ occurredAt: event.occurredAt, receivedAt: now }),
          })),
        });
        const newKeySet = new Set(newKeys.map((key) => `${key.eventDay}|${key.eventKey}`));
        const newEvents = fresh.filter((event) =>
          newKeySet.has(
            `${instagramWebhookEventDay({ occurredAt: event.occurredAt, receivedAt: now })}|${event.eventKey}`,
          ),
        );
        return this.eventRepository.insertEvents({
          ...channelAccount,
          requestId,
          events: newEvents,
        });
      },
    });
  }

  /**
   * Turns the just-stored `received` rows `queued` after their account's processing job was added
   * (WH10). Returns how many turned.
   *
   * @remarks
   * Algorithm: one guarded update (`received` only). Failure modes: none of its own. Side effects:
   * updates rows.
   */
  async markEventsQueued({
    scope,
    channelAccount,
    eventIds,
  }: InstagramWebhookEventAccountTarget & { eventIds: readonly number[] }): Promise<number> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.eventRepository.markQueued({ ...channelAccount, eventIds }),
    });
  }

  /**
   * Claims the account's oldest waiting event (WH12 step 1), or fails it when its attempts ran out;
   * `null` when nothing waits or another run holds the head.
   *
   * @remarks
   * Algorithm: the repository's `MATERIALIZED` CTE claim, in one short unit. Failure modes: none of
   * its own. Side effects: updates at most one row.
   */
  async claimNextEvent({
    scope,
    channelAccount,
    maxProcessingAttempts,
    claimLeaseMinutes,
  }: InstagramWebhookEventAccountTarget & {
    maxProcessingAttempts: number;
    claimLeaseMinutes: number;
  }): Promise<InstagramWebhookEventClaimResult | null> {
    return withAppDatabaseContext({
      scope,
      callback: () =>
        this.eventRepository.claimOldestWaitingEvent({
          ...channelAccount,
          maxProcessingAttempts,
          claimLeaseMinutes,
        }),
    });
  }

  /**
   * Marks a claimed event `processed` (WH12 step 4); `false` when the claim no longer holds.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: updates one row.
   */
  async markEventProcessed({ scope, claim }: InstagramWebhookEventClaimTarget): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.eventRepository.markProcessed(claim),
    });
  }

  /**
   * Marks a claimed event `skipped` with its reason (WH12 step 2); `false` when the claim no longer
   * holds.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: updates one row.
   */
  async markEventSkipped({
    scope,
    claim,
    skipReason,
  }: InstagramWebhookEventClaimTarget & {
    skipReason: InstagramWebhookEventSkipReason;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.eventRepository.markSkipped({ ...claim, skipReason }),
    });
  }

  /**
   * Marks a claimed event `failed` with a code and a short reason (WH14); `false` when the claim no
   * longer holds.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: updates one row.
   */
  async markEventFailed({
    scope,
    claim,
    errorMessage,
  }: InstagramWebhookEventClaimTarget & { errorMessage: string }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.eventRepository.markFailed({ ...claim, errorMessage }),
    });
  }

  /**
   * Gives a claim back so the next run claims the event at once (WH14): an Instagram outage gives
   * its attempt back too; a temporary failure (`isAttemptSpent`) keeps it and only ends the lease.
   * `false` when the claim no longer holds.
   *
   * @remarks
   * Algorithm: one guarded update. Failure modes: none of its own. Side effects: updates one row.
   */
  async releaseEventClaim({
    scope,
    claim,
    isAttemptSpent = false,
  }: InstagramWebhookEventClaimTarget & {
    /** `true` keeps the claim's attempt (a temporary failure); default `false` (an outage). */
    isAttemptSpent?: boolean;
  }): Promise<boolean> {
    return withAppDatabaseContext({
      scope,
      callback: () => this.eventRepository.releaseClaim({ ...claim, isAttemptSpent }),
    });
  }
}
