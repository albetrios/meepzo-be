/**
 * Instagram webhook event bulk seeder — gives every seeded Instagram account of a registry
 * organization a set of received events covering every kind and every status of route 18's list
 * (routes-final § 4.B, WHC16): waiting (`received`, `queued`), `processed`, `failed` (a permanent
 * refusal and spent attempts) and `skipped` with each skip reason. Payloads follow Meta's shapes, and
 * the DM carries an `example.com` email and a phone number, so the list's masking shows.
 *
 * Idempotency: event keys are fixed per account (`<kind>:seed-…`), and every insert is
 * `ON CONFLICT DO NOTHING` on the per-account key, so a re-run writes nothing new. Received times
 * sit within the last day — well inside the 30-day clean-up (WH19). No reference data.
 */
import { and, inArray, ne } from 'drizzle-orm';
import { getRequestDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { instagram_webhook_events } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.js';
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

/** Every kind and every status of route 18 — one template each (13 events per account). */
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
    status: 'processed',
    skipReason: null,
    errorMessage: null,
    attemptCount: 1,
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
    skipReason: 'echo',
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
    eventKind: 'read',
    eventKey: 'read:seed-mid-message',
    status: 'skipped',
    skipReason: 'read_receipt',
    errorMessage: null,
    attemptCount: 0,
    namesContact: true,
    buildPayload: (parties) =>
      messagingItem({ parties, item: { read: { mid: 'seed-mid-message' } } }),
  },
  {
    eventKind: 'reaction',
    eventKey: 'reaction:seed-mid-message:react:1',
    status: 'skipped',
    skipReason: 'reaction',
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
function seededContactInstagramUserId(instagramAccountId: number): string {
  return `7${String(instagramAccountId).padStart(15, '0')}`;
}

/**
 * Seeds the 13 demo events of every not-revoked Instagram account of the registry organizations.
 *
 * @remarks
 * Parents read: `context.registry.organizations`, and the accounts the Instagram account seeder
 * wrote for them (the app domain composes this contribution after it). Algorithm: list those
 * organizations' not-revoked accounts; per account, one insert of the templates — received an
 * hour apart over the last 13 hours, Meta's time two seconds before, final statuses finished three
 * seconds after — `ON CONFLICT DO NOTHING` on the per-account key. Side effects: inserts into
 * `app.instagram_webhook_events`. Failure modes: warns and returns early when the registry has no
 * organizations or they have no accounts; otherwise propagates database errors.
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
      organizationId: instagram_accounts.organization_id,
      instagramAccountId: instagram_accounts.id,
      instagramUserId: instagram_accounts.instagram_user_id,
    })
    .from(instagram_accounts)
    .where(
      and(
        inArray(instagram_accounts.organization_id, organizationIds),
        ne(instagram_accounts.connection_status, 'revoked'),
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
    const content = generateBulkInstagramWebhookEventContent(context.faker);
    const contactInstagramUserId = seededContactInstagramUserId(account.instagramAccountId);
    const inserted = await database
      .insert(instagram_webhook_events)
      .values(
        SEEDED_EVENT_TEMPLATES.map((template, index) => {
          const receivedAt = new Date(now - (index + 1) * MILLISECONDS_PER_HOUR);
          const isFinal = template.status !== 'received' && template.status !== 'queued';
          return {
            public_id: generatePublicId('instagramWebhookEvent'),
            organization_id: account.organizationId,
            instagram_account_id: account.instagramAccountId,
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
            payload: template.buildPayload({
              accountInstagramUserId: account.instagramUserId,
              contactInstagramUserId,
              timestampMilliseconds: receivedAt.getTime() - 2 * MILLISECONDS_PER_SECOND,
              content,
            }),
            occurred_at: new Date(receivedAt.getTime() - 2 * MILLISECONDS_PER_SECOND),
            processed_at: isFinal
              ? new Date(receivedAt.getTime() + 3 * MILLISECONDS_PER_SECOND)
              : null,
            request_id: `seed-instagram-webhook-${account.instagramAccountId}`,
            created_at: receivedAt,
          };
        }),
      )
      .onConflictDoNothing({
        target: [
          instagram_webhook_events.organization_id,
          instagram_webhook_events.instagram_account_id,
          instagram_webhook_events.event_key,
        ],
      })
      .returning({ id: instagram_webhook_events.id });
    created += inserted.length;
  }
  context.logger.info(
    { accounts: accounts.length, created },
    'seed.bulk.instagram-webhook-event: demo events seeded',
  );
}
