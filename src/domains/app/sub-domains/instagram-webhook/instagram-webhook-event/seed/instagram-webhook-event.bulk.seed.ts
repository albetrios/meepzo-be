/**
 * Instagram webhook event bulk seeder — gives every seeded Instagram channel account of a registry
 * organization a set of saved events covering the statuses of route 62's list (launch WHC16,
 * feat-instagram-dm-sending § 5.B): waiting (`received`, `queued`), `processed`, `failed` (a
 * permanent refusal and spent attempts) and `skipped` with its reasons. Payloads follow Meta's
 * shapes, and the DM carries an `example.com` email and a phone number, so the list's masking shows;
 * a done event is stored without its body (WH22).
 *
 * Idempotency: event keys are fixed per account (`<kind>:seed-…`); every key goes into
 * `app.instagram_webhook_event_keys` first and an account whose seed keys are already there is
 * skipped, so a re-run writes nothing new. Received times sit within the last day — inside the
 * 8-day keep time (WH19). No reference data.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_webhook_events } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.js';
import { instagram_webhook_event_keys } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event-key.schema.js';
import type {
  InstagramWebhookEventKind,
  InstagramWebhookEventSkipReason,
  InstagramWebhookEventStatus,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.constants.js';
import {
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { SeedContext } from '@/scripts/seed/seed-contract.js';
import {
  type BulkInstagramWebhookEventContent,
  generateBulkInstagramWebhookEventContent,
} from './instagram-webhook-event.faker.js';

/** One seeded event before its account's ids and times are filled in. */
interface SeededEventTemplate {
  eventKind: InstagramWebhookEventKind;
  eventKey: string;
  status: InstagramWebhookEventStatus;
  skipReason: InstagramWebhookEventSkipReason | null;
  errorMessage: string | null;
  attemptCount: number;
  /** Whether the item names the contact (`null` contact id otherwise). */
  namesContact: boolean;
  buildPayload: (parties: SeededParties) => Record<string, unknown>;
}

/** The two Instagram ids an event names, and the generated texts. */
interface SeededParties {
  accountInstagramUserId: string;
  contactInstagramUserId: string;
  timestampMilliseconds: number;
  content: BulkInstagramWebhookEventContent;
}

/** A `messaging[]` item between the contact (sender) and the account (recipient). */
function messagingItem({
  parties,
  item,
}: {
  parties: SeededParties;
  item: Record<string, unknown>;
}) {
  return {
    sender: { id: parties.contactInstagramUserId },
    recipient: { id: parties.accountInstagramUserId },
    timestamp: parties.timestampMilliseconds,
    ...item,
  };
}

/** A comment `changes[]` item by the contact on a feed post. */
function commentItem({ parties, commentId }: { parties: SeededParties; commentId: string }) {
  return {
    field: 'comments',
    value: {
      from: { id: parties.contactInstagramUserId, username: parties.content.contactUsername },
      media: { id: '17900000000000001', media_product_type: 'FEED' },
      id: commentId,
      text: parties.content.commentText,
    },
  };
}

/** Every kind, status and skip reason of route 62 (19 events per account). */
const SEEDED_EVENT_TEMPLATES: readonly SeededEventTemplate[] = [
  {
    eventKind: 'comment',
    eventKey: 'comment:18000000000000001',
    status: 'received',
    skipReason: null,
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) => commentItem({ parties, commentId: '18000000000000001' }),
  },
  {
    eventKind: 'comment',
    eventKey: 'comment:18000000000000002',
    status: 'queued',
    skipReason: null,
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) => commentItem({ parties, commentId: '18000000000000002' }),
  },
  {
    eventKind: 'message',
    eventKey: 'message:seed-mid-message',
    status: 'received',
    skipReason: null,
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          message: { mid: 'seed-mid-message', text: parties.content.directMessageText },
        },
      }),
  },
  {
    eventKind: 'postback',
    eventKey: 'postback:seed-mid-postback',
    status: 'processed',
    skipReason: null,
    errorMessage: null,
    attemptCount: 1,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          postback: { mid: 'seed-mid-postback', title: 'Send me the link', payload: 'seed-button' },
        },
      }),
  },
  {
    eventKind: 'story_reply',
    eventKey: 'message:seed-mid-story-reply',
    status: 'failed',
    skipReason: null,
    errorMessage: 'instagram_api:10/2534022',
    attemptCount: 1,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          message: {
            mid: 'seed-mid-story-reply',
            text: parties.content.storyReplyText,
            reply_to: {
              story: { id: '17950000000000001', url: 'https://example.com/stories/seed' },
            },
          },
        },
      }),
  },
  {
    eventKind: 'comment',
    eventKey: 'comment:18000000000000003',
    status: 'failed',
    skipReason: null,
    errorMessage: 'processing_attempts_exhausted',
    attemptCount: 5,
    namesContact: true,
    buildPayload: (parties) => commentItem({ parties, commentId: '18000000000000003' }),
  },
  {
    eventKind: 'echo',
    eventKey: 'echo:seed-mid-echo',
    status: 'skipped',
    skipReason: 'unsupported',
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) => ({
      sender: { id: parties.accountInstagramUserId },
      recipient: { id: parties.contactInstagramUserId },
      timestamp: parties.timestampMilliseconds,
      message: { mid: 'seed-mid-echo', text: 'Here is the link you asked for', is_echo: true },
    }),
  },
  {
    eventKind: 'comment',
    eventKey: 'comment:18000000000000005',
    status: 'skipped',
    skipReason: 'own_comment',
    errorMessage: null,
    attemptCount: 0,
    namesContact: false,
    buildPayload: (parties) => ({
      field: 'comments',
      value: {
        from: { id: parties.accountInstagramUserId, username: 'seed_account' },
        media: { id: '17900000000000001', media_product_type: 'FEED' },
        id: '18000000000000005',
        text: 'Sent you a DM!',
      },
    }),
  },
  {
    eventKind: 'reaction',
    eventKey: 'reaction:seed-mid-message:react:1',
    status: 'skipped',
    skipReason: 'unsupported',
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          reaction: { mid: 'seed-mid-message', action: 'react', reaction: 'love', emoji: '❤' },
        },
      }),
  },
  {
    eventKind: 'edit',
    eventKey: 'edit:seed-mid-message:1',
    status: 'skipped',
    skipReason: 'edit',
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          message_edit: { mid: 'seed-mid-message', text: 'Edited message', num_edit: 1 },
        },
      }),
  },
  {
    eventKind: 'unknown',
    eventKey: 'change:mentions:seed',
    status: 'skipped',
    skipReason: 'unsupported',
    errorMessage: null,
    attemptCount: 0,
    namesContact: false,
    buildPayload: () => ({
      field: 'mentions',
      value: { media_id: '17900000000000001', comment_id: '18000000000000009' },
    }),
  },
  {
    eventKind: 'message',
    eventKey: 'message:seed-mid-switch-off',
    status: 'skipped',
    skipReason: 'automation_disabled',
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({ parties, item: { message: { mid: 'seed-mid-switch-off', text: 'Hello?' } } }),
  },
  {
    eventKind: 'live_comment',
    eventKey: 'live_comment:18000000000000006',
    status: 'processed',
    skipReason: null,
    errorMessage: null,
    attemptCount: 1,
    namesContact: true,
    buildPayload: (parties) => ({
      field: 'live_comments',
      value: {
        from: { id: parties.contactInstagramUserId, username: parties.content.contactUsername },
        media: { id: '17900000000000002', media_product_type: 'LIVE' },
        id: '18000000000000006',
        text: parties.content.commentText,
      },
    }),
  },
  {
    eventKind: 'story_mention',
    eventKey: 'message:seed-mid-story-mention',
    status: 'queued',
    skipReason: null,
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          message: {
            mid: 'seed-mid-story-mention',
            attachments: [
              { type: 'story_mention', payload: { url: 'https://example.com/stories/mention' } },
            ],
          },
        },
      }),
  },
  {
    eventKind: 'shared_post',
    eventKey: 'message:seed-mid-shared-post',
    status: 'processed',
    skipReason: null,
    errorMessage: null,
    attemptCount: 1,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          message: {
            mid: 'seed-mid-shared-post',
            attachments: [{ type: 'share', payload: { url: 'https://example.com/p/seed' } }],
          },
        },
      }),
  },
  {
    eventKind: 'ice_breaker',
    eventKey: 'postback:seed-mid-starter',
    status: 'processed',
    skipReason: null,
    errorMessage: null,
    attemptCount: 1,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: {
          postback: { mid: 'seed-mid-starter', title: 'What do you sell?', payload: 'starter:1' },
        },
      }),
  },
  {
    eventKind: 'referral',
    eventKey: 'referral:seed-referral',
    status: 'received',
    skipReason: null,
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({
        parties,
        item: { referral: { ref: 'spring-sale', source: 'SHORTLINK', type: 'OPEN_THREAD' } },
      }),
  },
  {
    eventKind: 'message',
    eventKey: 'message:seed-mid-flood',
    status: 'skipped',
    skipReason: 'flood',
    errorMessage: null,
    attemptCount: 1,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({ parties, item: { message: { mid: 'seed-mid-flood', text: 'hi' } } }),
  },
  {
    eventKind: 'comment',
    eventKey: 'comment:18000000000000004',
    status: 'skipped',
    skipReason: 'account_disconnected',
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) => commentItem({ parties, commentId: '18000000000000004' }),
  },
];

/** The demo contact's Instagram id, derived from the account id (digits behind a `7`). */
function seededContactInstagramUserId(channelAccountId: number): string {
  return `7${String(channelAccountId).padStart(15, '0')}`;
}

/**
 * Seeds the 19 demo events of every not-revoked Instagram channel account of the registry
 * organizations.
 *
 * @remarks
 * Parents read: `context.registry.organizations`, and the channel accounts the account seeders wrote
 * for them (the app domain composes this contribution after them). Algorithm: list those
 * organizations' not-revoked Instagram channel accounts; skip an account whose seed keys are already
 * stored; else insert the templates' keys (each on the UTC day of its Meta time) and then the events
 * — received an hour apart over the last 19 hours, Meta's time two seconds before, final statuses
 * finished three seconds after, done ones without a body. Side effects: inserts into
 * `app.instagram_webhook_event_keys` and `app.instagram_webhook_events`. Failure modes: warns and
 * returns early when the registry has no organizations or they have no accounts; otherwise
 * propagates database errors.
 */
export async function seedInstagramWebhookEventsBulk(context: SeedContext): Promise<void> {
  const organizationIds = context.registry.organizations.map((organization) => organization.id);
  if (organizationIds.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-webhook-event: empty organization pool; run the tenancy seeder first',
    );
    return;
  }

  const database = getRequestDatabase();
  const accounts = await database
    .select({
      organizationId: channel_accounts.organization_id,
      channelAccountId: channel_accounts.id,
      // The Instagram user id (CAC5) — the delivery entry's `id`.
      instagramUserId: channel_accounts.provider_account_id,
    })
    .from(channel_accounts)
    .where(
      and(
        inArray(channel_accounts.organization_id, organizationIds),
        eq(channel_accounts.channel, 'instagram'),
        ne(channel_accounts.connection_status, 'revoked'),
      ),
    );
  if (accounts.length === 0) {
    context.logger.warn(
      'seed.bulk.instagram-webhook-event: no Instagram accounts; run the account seeder first',
    );
    return;
  }

  const now = Date.now();
  let created = 0;
  for (const account of accounts) {
    const seededKeys = await database
      .select({ eventKey: instagram_webhook_event_keys.event_key })
      .from(instagram_webhook_event_keys)
      .where(
        and(
          eq(instagram_webhook_event_keys.organization_id, account.organizationId),
          eq(instagram_webhook_event_keys.channel_account_id, account.channelAccountId),
          inArray(
            instagram_webhook_event_keys.event_key,
            SEEDED_EVENT_TEMPLATES.map((template) => template.eventKey),
          ),
        ),
      )
      .limit(1);
    if (seededKeys.length > 0) continue;
    const content = generateBulkInstagramWebhookEventContent(context.faker);
    const contactInstagramUserId = seededContactInstagramUserId(account.channelAccountId);
    const occurredAtOf = (index: number) =>
      new Date(now - (index + 1) * MILLISECONDS_PER_HOUR - 2 * MILLISECONDS_PER_SECOND);
    await database.insert(instagram_webhook_event_keys).values(
      SEEDED_EVENT_TEMPLATES.map((template, index) => ({
        organization_id: account.organizationId,
        channel_account_id: account.channelAccountId,
        event_key: template.eventKey,
        event_day: occurredAtOf(index).toISOString().slice(0, 10),
      })),
    );
    const inserted = await database
      .insert(instagram_webhook_events)
      .values(
        SEEDED_EVENT_TEMPLATES.map((template, index) => {
          const receivedAt = new Date(now - (index + 1) * MILLISECONDS_PER_HOUR);
          const isFinal = template.status !== 'received' && template.status !== 'queued';
          const keepsBody = template.status !== 'processed' && template.status !== 'skipped';
          return {
            public_id: generatePublicId('instagramWebhookEvent'),
            organization_id: account.organizationId,
            channel_account_id: account.channelAccountId,
            instagram_user_id: account.instagramUserId,
            contact_instagram_user_id: template.namesContact ? contactInstagramUserId : null,
            event_kind: template.eventKind,
            event_key: template.eventKey,
            status: template.status,
            skip_reason: template.skipReason,
            error_message: template.errorMessage,
            attempt_count: template.attemptCount,
            last_attempted_at:
              template.attemptCount > 0
                ? new Date(receivedAt.getTime() + MILLISECONDS_PER_SECOND)
                : null,
            payload: keepsBody
              ? template.buildPayload({
                  accountInstagramUserId: account.instagramUserId,
                  contactInstagramUserId,
                  timestampMilliseconds: occurredAtOf(index).getTime(),
                  content,
                })
              : null,
            occurred_at: occurredAtOf(index),
            processed_at: isFinal
              ? new Date(receivedAt.getTime() + 3 * MILLISECONDS_PER_SECOND)
              : null,
            request_id: `seed-instagram-webhook-${account.channelAccountId}`,
            created_at: receivedAt,
          };
        }),
      )
      .returning({ id: instagram_webhook_events.id });
    created += inserted.length;
  }
  context.logger.info(
    { accounts: accounts.length, created },
    'seed.bulk.instagram-webhook-event: demo events seeded',
  );
}
