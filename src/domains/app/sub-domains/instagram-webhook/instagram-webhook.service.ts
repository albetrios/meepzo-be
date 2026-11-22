import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { recordInstagramWebhookUnknownAccountEntry } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { getEnv } from '@/shared/config/env.config.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import { cleanStorableJson } from '@/shared/utils/text/storable-text.util.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import type { InstagramWebhookAccountState } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramWebhookEventSkipReason } from './instagram-webhook-event/instagram-webhook-event.constants.js';
import type { InstagramWebhookEventService } from './instagram-webhook-event/instagram-webhook-event.service.js';
import {
  INSTAGRAM_WEBHOOK_OBJECT,
  INSTAGRAM_WEBHOOK_SUBSCRIBE_MODE,
} from './instagram-webhook.constants.js';
import { InstagramWebhookDeliveryDto, InstagramWebhookEntryDto } from './instagram-webhook.dto.js';
import {
  type ClassifiedInstagramWebhookEvent,
  type InstagramWebhookEntryItem,
  classifyInstagramWebhookItem,
  listInstagramWebhookEntryItems,
  readInstagramWebhookUserId,
} from './instagram-webhook-event-classifier.util.js';
import {
  instagramWebhookNotConfiguredError,
  invalidWebhookVerifyTokenError,
} from './instagram-webhook-error.util.js';
import type {
  InstagramWebhookAccountProcessingEnqueue,
  InstagramWebhookDeliveryInput,
  InstagramWebhookDeliveryResult,
  InstagramWebhookSubscriptionCheck,
} from './instagram-webhook.types.js';

/** What storing one delivery entry came to (the delivery's counts add these up). */
type EntryOutcome =
  | { outcome: 'dropped' }
  | { outcome: 'unknown_account' }
  | { outcome: 'stored'; storedEventCount: number; duplicateEventCount: number };

/**
 * Whether the presented verify token equals the expected one — compared in constant time over the
 * two values' SHA-256 digests, so neither the content nor the length leaks (WH7).
 */
function isVerifyTokenEqual({
  presentedToken,
  expectedToken,
}: {
  presentedToken: string;
  expectedToken: string;
}): boolean {
  const presentedDigest = createHash('sha256').update(presentedToken, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * The status an event is born with (WH10): the kind's own skip reason first (WH9), then the
 * automation switch off (`automation_disabled`), then an `expired` or `error` account
 * (`account_disconnected`); `null` stores it `received`.
 */
function storedSkipReason({
  event,
  account,
}: {
  event: ClassifiedInstagramWebhookEvent;
  account: InstagramWebhookAccountState;
}): InstagramWebhookEventSkipReason | null {
  if (event.kindSkipReason !== null) return event.kindSkipReason;
  if (!account.isAutomationEnabled) return 'automation_disabled';
  if (account.connectionStatus !== 'connected') return 'account_disconnected';
  return null;
}

/** Keeps the first event of each key — an item Meta repeats inside one entry is stored once. */
function firstEventPerKey(
  events: readonly ClassifiedInstagramWebhookEvent[],
): ClassifiedInstagramWebhookEvent[] {
  const seenKeys = new Set<string>();
  return events.filter((event) => {
    if (seenKeys.has(event.eventKey)) return false;
    seenKeys.add(event.eventKey);
    return true;
  });
}

/**
 * The Instagram webhook receiver (routes-final § 4.A, routes 16–17): Meta's subscription check, and
 * the store of each delivered event before Meta gets its answer.
 *
 * @remarks
 * Algorithm:
 * - Route 16 (WH7): `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` must be set (`503`); `hub.mode` must be
 *   `subscribe` and `hub.verify_token` equal the setting in constant time (`400`); the challenge is
 *   then returned as received.
 * - Route 17 (WH10), after the ingress plugin checked `X-Hub-Signature-256` (WH8): a body that is
 *   not a readable delivery, or whose `object` is not `instagram`, is logged and stored nowhere.
 *   Each `entry[]` is then stored on its own, its text cleaned first of what Postgres refuses (NUL
 *   and lone surrogates — every string of the stored payloads and their event keys, once, after the
 *   signature; D53): its Instagram user id (digits; else the entry is dropped with a log line),
 *   sub-domain 1's resolver for the organization (WH3 — `null`: an
 *   account no organization holds or a revoked one, logged and counted, never stored, WH4), then
 *   one unit of work in that organization's `PRINCIPAL_SCOPE.VERIFIED` scope (a signed Meta
 *   delivery is a flow-proved id): the account's state through sub-domain 1, every item classified
 *   (WH9), born `received` or `skipped` with its reason, all inserted in one `INSERT … ON CONFLICT
 *   DO NOTHING` through 4.B's service — a repeat delivery inserts nothing.
 * - After each commit, through the wired {@link InstagramWebhookAccountProcessingEnqueue} (the app
 *   container's `enqueueInstagramWebhookAccountProcessing`): the account's processing job is added
 *   and the just-stored `received` rows turn `queued`.
 *
 * Failure modes:
 * - `503 instagram_webhook_not_configured`, `400 invalid_webhook_verify_token` (route 16).
 * - A store failure never stops the delivery's other entries (other organizations'): each is
 *   stored, then the first failure is thrown — the answer is `500` / `503`, never `200`, so Meta
 *   delivers again and the part already stored dedupes (WH10, D53). A failed processing add is only
 *   logged.
 *
 * Side effects:
 * - Writes `app.instagram_webhook_events` only, through `InstagramWebhookEventService` (WH1). Log
 *   lines and the `instagram_webhook_unknown_account_entries_total` metric. No audit entry, no
 *   `*_by_user_id` — nobody signed in acts here (WH6).
 *
 * Notes:
 * - Logs carry the request id, Instagram ids, public ids and counts — never the payload, message or
 *   comment text, emails or phone numbers (WH6, K7).
 * - Processing the stored events (dispatch, order per account, retries, the stuck-event pick-up)
 *   is the worker's (`workers/instagram-webhook.processor.ts`); this service stops at the store and
 *   the enqueue hook.
 */
export class InstagramWebhookService {
  constructor(
    private readonly accountService: InstagramAccountService,
    private readonly eventService: InstagramWebhookEventService,
    /** The processing enqueue; without one (a unit test) stored events stay `received`. */
    private readonly enqueueAccountProcessing?: InstagramWebhookAccountProcessingEnqueue,
  ) {}

  /**
   * Meta's subscription check (route 16, WH7): returns the challenge to echo as `text/plain`.
   *
   * @remarks
   * Algorithm: the setting first (unset → `503`), then the mode and the token — both checked, the
   * token in constant time, so a wrong mode costs what a wrong token does. Failure modes:
   * `503 instagram_webhook_not_configured`; `400 invalid_webhook_verify_token`. Side effects: none.
   */
  verifySubscription({ mode, verifyToken, challenge }: InstagramWebhookSubscriptionCheck): string {
    const expectedToken = getEnv().INSTAGRAM_WEBHOOK_VERIFY_TOKEN;
    if (!expectedToken) {
      throw instagramWebhookNotConfiguredError();
    }
    const isTokenEqual = isVerifyTokenEqual({ presentedToken: verifyToken, expectedToken });
    if (mode !== INSTAGRAM_WEBHOOK_SUBSCRIBE_MODE || !isTokenEqual) {
      throw invalidWebhookVerifyTokenError();
    }
    return challenge;
  }

  /**
   * Stores a signed delivery's events (route 17, WH10) — each once, before Meta gets its answer —
   * and returns what it stored, in counts.
   *
   * @remarks
   * Algorithm: as the class describes for route 17; entries are stored one after another, each in
   * its own unit of work, whatever happened to the ones before. Failure modes: after the last entry,
   * the first entry's failure is thrown (the answer is not `200`); each is one error log line — the
   * request id, the entry's place and the error's name. Side effects: inserts events; log lines; the
   * unknown-account metric; the processing enqueue.
   */
  async receiveDelivery({
    body,
    requestId,
  }: InstagramWebhookDeliveryInput): Promise<InstagramWebhookDeliveryResult> {
    const result: InstagramWebhookDeliveryResult = {
      ignoredBecause: null,
      entryCount: 0,
      droppedEntryCount: 0,
      unknownAccountEntryCount: 0,
      failedEntryCount: 0,
      storedEventCount: 0,
      duplicateEventCount: 0,
    };
    const delivery = InstagramWebhookDeliveryDto.safeParse(body);
    if (!delivery.success) {
      logger.warn({ requestId }, 'instagram.webhook.unreadable_body');
      return { ...result, ignoredBecause: 'unreadable_body' };
    }
    if (delivery.data.object !== INSTAGRAM_WEBHOOK_OBJECT) {
      logger.warn({ requestId }, 'instagram.webhook.unsupported_object');
      return { ...result, ignoredBecause: 'unsupported_object' };
    }

    result.entryCount = delivery.data.entry.length;
    const failures: unknown[] = [];
    for (const [entryIndex, rawEntry] of delivery.data.entry.entries()) {
      try {
        const entryOutcome = await this.storeEntry({
          rawEntry: cleanStorableJson(rawEntry),
          entryIndex,
          requestId,
        });
        if (entryOutcome.outcome === 'dropped') result.droppedEntryCount += 1;
        else if (entryOutcome.outcome === 'unknown_account') result.unknownAccountEntryCount += 1;
        else {
          result.storedEventCount += entryOutcome.storedEventCount;
          result.duplicateEventCount += entryOutcome.duplicateEventCount;
        }
      } catch (error) {
        // D53: one entry is one organization's — its failure must not cost the others their events.
        failures.push(error);
        result.failedEntryCount += 1;
        logger.error(
          {
            requestId,
            entryIndex,
            errorName: error instanceof Error ? error.name : typeof error,
          },
          'instagram.webhook.entry_store_failed',
        );
      }
    }
    logger.info({ requestId, ...result }, 'instagram.webhook.delivery_received');
    if (failures.length > 0) throw failures[0];
    return result;
  }

  /**
   * One `entry[]` item (its text already cleaned): resolve its organization, then store its events in
   * that organization's unit.
   */
  private async storeEntry({
    rawEntry,
    entryIndex,
    requestId,
  }: {
    rawEntry: unknown;
    entryIndex: number;
    requestId: string;
  }): Promise<EntryOutcome> {
    const entry = InstagramWebhookEntryDto.safeParse(rawEntry);
    const instagramUserId = entry.success ? readInstagramWebhookUserId(entry.data.id) : null;
    if (!entry.success || instagramUserId === null) {
      logger.warn({ requestId, entryIndex }, 'instagram.webhook.entry_without_account_id');
      return { outcome: 'dropped' };
    }
    const { items, droppedItemCount } = listInstagramWebhookEntryItems(entry.data);
    if (droppedItemCount > 0) {
      logger.warn(
        { requestId, instagramUserId, droppedItemCount },
        'instagram.webhook.items_not_objects',
      );
    }
    if (items.length === 0) {
      return { outcome: 'stored', storedEventCount: 0, duplicateEventCount: 0 };
    }

    const organizationPublicId =
      await this.accountService.resolveOrganizationPublicIdForInstagramUser(instagramUserId);
    if (organizationPublicId === null) {
      return this.recordUnknownAccount({ requestId, instagramUserId, eventCount: items.length });
    }

    // WH3: a signed Meta delivery is a flow-proved id — the resolver named the organization.
    const scope = PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId });
    const stored = await this.storeEntryEvents({
      scope,
      instagramUserId,
      items,
      entryTime: entry.data.time,
      requestId,
    });
    if (stored === null) {
      return this.recordUnknownAccount({ requestId, instagramUserId, eventCount: items.length });
    }

    const { account, eventCount, receivedEventIds, storedEventCount } = stored;
    logger.info(
      {
        requestId,
        instagramUserId,
        organizationPublicId,
        instagramAccountPublicId: account.instagramAccountPublicId,
        eventCount,
        storedEventCount,
        receivedEventCount: receivedEventIds.length,
      },
      'instagram.webhook.entry_stored',
    );
    await this.enqueueProcessingBestEffort({ scope, account, receivedEventIds, requestId });
    return {
      outcome: 'stored',
      storedEventCount,
      duplicateEventCount: eventCount - storedEventCount,
    };
  }

  /**
   * One unit of work in the organization's verified scope (WH10): the account's state through
   * sub-domain 1, every item classified with its stored status, all inserted at once. `null` when
   * the organization holds no live account with this Instagram user id any more.
   */
  private async storeEntryEvents({
    scope,
    instagramUserId,
    items,
    entryTime,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    instagramUserId: string;
    items: readonly InstagramWebhookEntryItem[];
    entryTime: unknown;
    requestId: string;
  }): Promise<{
    account: InstagramWebhookAccountState;
    eventCount: number;
    storedEventCount: number;
    receivedEventIds: number[];
  } | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        const account = await this.accountService.findWebhookAccountState({
          scope,
          instagramUserId,
        });
        if (account === null) return null;
        const accountIds = {
          instagramUserId: account.instagramUserId,
          instagramAppUserId: account.instagramAppUserId,
        };
        const events = firstEventPerKey(
          items.map((entryItem) =>
            classifyInstagramWebhookItem({ ...entryItem, accountIds, entryTime }),
          ),
        );
        const rows = await this.eventService.recordReceivedEvents({
          scope,
          instagramAccount: account.instagramAccount,
          requestId,
          events: events.map((event) => ({
            instagramUserId,
            contactInstagramUserId: event.contactInstagramUserId,
            eventKind: event.eventKind,
            eventKey: event.eventKey,
            skipReason: storedSkipReason({ event, account }),
            payload: event.payload,
            occurredAt: event.occurredAt,
          })),
        });
        return {
          account,
          eventCount: events.length,
          storedEventCount: rows.length,
          receivedEventIds: rows.filter((row) => row.status === 'received').map((row) => row.id),
        };
      },
    });
  }

  /**
   * An entry for an account no organization holds, or a revoked one (WH4, WQ1): one log line (the
   * Instagram user id and the event count, never the payload) and the metric; nothing stored.
   */
  private recordUnknownAccount({
    requestId,
    instagramUserId,
    eventCount,
  }: {
    requestId: string;
    instagramUserId: string;
    eventCount: number;
  }): EntryOutcome {
    logger.info({ requestId, instagramUserId, eventCount }, 'instagram.webhook.unknown_account');
    recordInstagramWebhookUnknownAccountEntry();
    return { outcome: 'unknown_account' };
  }

  /**
   * After the entry's commit (WH10): the processing enqueue, then the just-stored `received` rows
   * turn `queued`. Without an enqueue, or with nothing `received`, it does nothing; a failure is
   * logged and left to the stuck-event pick-up (WH15) — it never fails Meta's answer.
   */
  private async enqueueProcessingBestEffort({
    scope,
    account,
    receivedEventIds,
    requestId,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    account: InstagramWebhookAccountState;
    receivedEventIds: readonly number[];
    requestId: string;
  }): Promise<void> {
    if (this.enqueueAccountProcessing === undefined || receivedEventIds.length === 0) return;
    try {
      await this.enqueueAccountProcessing({
        organizationPublicId: scope.organizationPublicId,
        instagramAccountPublicId: account.instagramAccountPublicId,
        requestId,
      });
      await this.eventService.markEventsQueued({
        scope,
        instagramAccount: account.instagramAccount,
        eventIds: receivedEventIds,
      });
    } catch (error) {
      logger.warn(
        {
          requestId,
          instagramAccountPublicId: account.instagramAccountPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'instagram.webhook.processing_enqueue_failed',
      );
    }
  }
}
