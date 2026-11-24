import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { recordInstagramWebhookUnknownAccountEntry } from '@/infrastructure/observability/metrics/prometheus-metrics.js';
import { INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS } from '@/shared/constants/instagram.constants.js';
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
import { readMetaWebhookSettings } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-signature.js';
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
  toInstagramWebhookStoreFailure,
} from './instagram-webhook-error.util.js';
import {
  type InstagramOwnSentMessageLookup,
  type InstagramWebhookAccountProcessingEnqueue,
  type InstagramWebhookDeliveryInput,
  type InstagramWebhookDeliveryResult,
  type InstagramWebhookSubscriptionCheck,
  NO_OWN_SENT_MESSAGES,
} from './instagram-webhook.types.js';

/** What storing one delivery entry came to (the delivery's counts add these up). */
type EntryOutcome =
  | { outcome: 'dropped' }
  | { outcome: 'unknown_account' }
  | {
      outcome: 'stored';
      storedEventCount: number;
      duplicateEventCount: number;
      droppedEventCount: number;
    };

/**
 * Whether the presented verify token equals the expected one — compared in constant time over the
 * two values' SHA-256 digests, so neither the content nor the length leaks (WH4).
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
 * The status an event is born with (WH3): the kind's own skip reason first (WH8), then the
 * automation switch off (`automation_disabled`); `null` saves it `received` — an `error` account's
 * events too, so its messages wait in its stopped lanes until the owner reconnects (WH3).
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
 * The Instagram webhook receiver (feat-instagram-dm-sending routes-final § 5.A, routes 60–61):
 * Meta's subscription check, and the save of each delivered event before Meta gets its answer — it
 * saves only; intake per kind decides later (WH5, ROUTE row R38).
 *
 * @remarks
 * Algorithm:
 * - Route 60 (WH4): the Meta webhook verify token must be set (`503`); `hub.mode` must be
 *   `subscribe` and `hub.verify_token` equal the setting in constant time (`400`); the challenge
 *   is then returned as received.
 * - Route 61 (WH9), after the ingress plugin checked `X-Hub-Signature-256` with the Meta app
 *   secret (step 1): a body that is not a readable delivery, or whose `object` is not `instagram`,
 *   is logged and saved nowhere. Each `entry[]` is then handled on its own, its text cleaned first
 *   of what Postgres refuses (NUL and lone surrogates, D53): its Instagram user id (digits; else the
 *   entry is dropped with a log line), instagram-account's resolver for the organization (step 4 —
 *   `null`: an account no organization holds or a revoked one, logged and counted, never saved,
 *   WH3), then **one unit of work** in that organization's `PRINCIPAL_SCOPE.VERIFIED` scope whose
 *   first statement caps every statement at {@link INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS} (WH2): the
 *   account's state, every item classified (step 2 — a read receipt is dropped), the echoes of our
 *   own sent messages dropped through the {@link InstagramOwnSentMessageLookup} (step 3, WHQ1), the
 *   rest born `received` or `skipped` with its reason and handed to 5.B's store function
 *   (`recordReceivedEvents`: the 8-day replay guard, the keys first, then the events of only the new
 *   keys — steps 5–6), then the commit (step 7).
 * - After each commit (step 8), through the wired {@link InstagramWebhookAccountProcessingEnqueue}
 *   (the app container's `enqueueInstagramWebhookAccountProcessing`): the channel account's
 *   processing job is added (`channelAccountPublicId`, WHC4) and the just-saved `received` rows turn
 *   `queued`.
 *
 * Failure modes:
 * - `503 instagram_webhook_not_configured`, `400 invalid_webhook_verify_token` (route 60).
 * - A store failure never stops the delivery's other entries (other organizations'): each is
 *   handled, then the first failure is thrown — the answer is `500` / `503`, never `200`, so Meta
 *   delivers again and the part already saved is a repeat (D53). A unit over its time — a statement
 *   or lock wait cancelled — is a `503` (WH2, {@link toInstagramWebhookStoreFailure}); Postgres
 *   down is the error handler's `503`. Nothing is kept anywhere else meanwhile — no Redis buffer
 *   (P32). A failed processing add is only logged.
 *
 * Side effects:
 * - Writes `app.instagram_webhook_event_keys` and `app.instagram_webhook_events` only, through
 *   `InstagramWebhookEventService` (WH1). Log lines and the
 *   `instagram_webhook_unknown_account_entries_total` metric. No audit entry, no `*_by_user_id` —
 *   nobody signed in acts here (WH6).
 *
 * Notes:
 * - Logs carry the request id, Instagram ids, public ids and counts — never the payload, message or
 *   comment text, emails or phone numbers (WH6, K7).
 * - Processing the saved events is the worker's (`workers/instagram-webhook.processor.ts`, intake
 *   per kind at ROUTE row R38); this service stops at the save and the enqueue hook.
 */
export class InstagramWebhookService {
  constructor(
    private readonly accountService: InstagramAccountService,
    private readonly eventService: InstagramWebhookEventService,
    /** The processing enqueue; without one (a unit test) stored events stay `received`. */
    private readonly enqueueAccountProcessing?: InstagramWebhookAccountProcessingEnqueue,
    /** The own-message lookup (WH9 step 3); sub-domain 6's from ROUTE row R19, none before. */
    private readonly findOwnSentMessageIds: InstagramOwnSentMessageLookup = NO_OWN_SENT_MESSAGES,
  ) {}

  /**
   * Meta's subscription check (route 60, WH4): returns the challenge to echo as `text/plain`.
   *
   * @remarks
   * Algorithm: the setting first (unset → `503`), then the mode and the token — both checked, the
   * token in constant time, so a wrong mode costs what a wrong token does. Failure modes:
   * `503 instagram_webhook_not_configured`; `400 invalid_webhook_verify_token`. Side effects: none.
   */
  verifySubscription({ mode, verifyToken, challenge }: InstagramWebhookSubscriptionCheck): string {
    const expectedToken = readMetaWebhookSettings().verifyToken;
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
   * Saves a signed delivery's events (route 61, WH9) — each once, before Meta gets its answer —
   * and returns what it saved, in counts.
   *
   * @remarks
   * Algorithm: as the class describes for route 61; entries are stored one after another, each in
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
      droppedEventCount: 0,
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
          result.droppedEventCount += entryOutcome.droppedEventCount;
        }
      } catch (error) {
        // D53: one entry is one organization's — its failure must not cost the others their events.
        failures.push(toInstagramWebhookStoreFailure(error));
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
      return {
        outcome: 'stored',
        storedEventCount: 0,
        duplicateEventCount: 0,
        droppedEventCount: 0,
      };
    }

    const organizationPublicId =
      await this.accountService.resolveOrganizationPublicIdForInstagramUser(instagramUserId);
    if (organizationPublicId === null) {
      return this.recordUnknownAccount({ requestId, instagramUserId, eventCount: items.length });
    }

    // WH9: a signed Meta delivery is a flow-proved id — the resolver named the organization.
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

    const { account, eventCount, receivedEventIds, storedEventCount, droppedEventCount } = stored;
    logger.info(
      {
        requestId,
        instagramUserId,
        organizationPublicId,
        channelAccountPublicId: account.instagramAccountPublicId,
        eventCount,
        storedEventCount,
        droppedEventCount,
        receivedEventCount: receivedEventIds.length,
      },
      'instagram.webhook.entry_stored',
    );
    await this.enqueueProcessingBestEffort({ scope, account, receivedEventIds, requestId });
    return {
      outcome: 'stored',
      storedEventCount,
      duplicateEventCount: eventCount - storedEventCount,
      droppedEventCount,
    };
  }

  /**
   * One unit of work in the organization's verified scope (WH9 steps 2–7): the statement cap first
   * (WH2), the account's state, every item classified, read receipts and our own echoes dropped,
   * the rest handed to the store function. `null` when the organization holds no live account with
   * this Instagram user id any more.
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
    droppedEventCount: number;
    receivedEventIds: number[];
  } | null> {
    return withAppDatabaseContext({
      scope,
      callback: async () => {
        await this.eventService.limitStoreStatementTime({
          scope,
          milliseconds: INSTAGRAM_WEBHOOK_STORE_TIMEOUT_MS,
        });
        const account = await this.accountService.findWebhookAccountState({
          scope,
          instagramUserId,
        });
        if (account === null) return null;
        const channelAccount = {
          organizationId: account.instagramAccount.organizationId,
          channelAccountId: account.channelAccountId,
        };
        // Under Unified Login the id send URLs take is the Instagram user id (2.A IA8).
        const accountIds = { instagramUserId: account.instagramUserId };
        const classified = items.flatMap((entryItem) => {
          const event = classifyInstagramWebhookItem({ ...entryItem, accountIds, entryTime });
          return event === null ? [] : [event];
        });
        const ownSentMessageIds = await this.readOwnSentMessageIds({
          scope,
          channelAccount,
          events: classified,
        });
        const kept = classified.filter(
          (event) =>
            event.echoMessageId === undefined || !ownSentMessageIds.has(event.echoMessageId),
        );
        const events = firstEventPerKey(kept);
        const rows = await this.eventService.recordReceivedEvents({
          scope,
          channelAccount,
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
          droppedEventCount: items.length - kept.length,
          receivedEventIds: rows.filter((row) => row.status === 'received').map((row) => row.id),
        };
      },
    });
  }

  /**
   * The echoes' `mid`s the own-message lookup knows as our sent messages (WH9 step 3) — no lookup
   * when the entry holds no echo.
   */
  private async readOwnSentMessageIds({
    scope,
    channelAccount,
    events,
  }: {
    scope: OrganizationPrincipalDatabaseScope;
    channelAccount: { organizationId: number; channelAccountId: number };
    events: readonly ClassifiedInstagramWebhookEvent[];
  }): Promise<ReadonlySet<string>> {
    const messageIds = events.flatMap((event) =>
      event.echoMessageId === undefined ? [] : [event.echoMessageId],
    );
    if (messageIds.length === 0) return new Set<string>();
    return this.findOwnSentMessageIds({ scope, channelAccount, messageIds });
  }

  /**
   * An entry for an account no organization holds, or a revoked one (WH3): one log line (the
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
   * After the entry's commit (WH9 step 8): the processing enqueue, then the just-saved `received`
   * rows turn `queued`. Without an enqueue, or with nothing `received`, it does nothing; a failure
   * is logged and left to the stuck-event pick-up (WH17) — it never fails Meta's answer.
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
        channelAccountPublicId: account.instagramAccountPublicId,
        requestId,
      });
      await this.eventService.markEventsQueued({
        scope,
        channelAccount: {
          organizationId: account.instagramAccount.organizationId,
          channelAccountId: account.channelAccountId,
        },
        eventIds: receivedEventIds,
      });
    } catch (error) {
      logger.warn(
        {
          requestId,
          channelAccountPublicId: account.instagramAccountPublicId,
          errorName: error instanceof Error ? error.name : typeof error,
        },
        'instagram.webhook.processing_enqueue_failed',
      );
    }
  }
}
