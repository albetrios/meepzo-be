import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  createMembership,
  createRoleWithPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';

/** `GET /app/social/instagram/webhook-events` (route 62). */
export const INSTAGRAM_WEBHOOK_EVENTS_PATH = testApiPath('/app/social/instagram/webhook-events');

/** The other side of every test event — a commenter or sender. */
export const TEST_CONTACT_INSTAGRAM_USER_ID = '17841400000000777';

/**
 * A connected Instagram account inserted for tests: its internal id, its channel account (the key
 * the events are saved under since R16) and its webhook user id.
 */
export interface TestInstagramAccount {
  /** `app.instagram_accounts.id`. */
  id: number;
  /** `app.channel_accounts.id`. */
  channelAccountId: number;
  /** `cha_…`. */
  channelAccountPublicId: string;
  instagramUserId: string;
}

/**
 * Inserts a connected Instagram account for the organization, as the operator — the events'
 * parent. Its Instagram ids are derived from the organization id, so two never clash.
 */
export async function insertTestInstagramAccount(
  organizationId: number,
): Promise<TestInstagramAccount> {
  const instagramUserId = `9${String(organizationId).padStart(15, '0')}`;
  const channelAccount = await insertChannelAccount({
    organizationId,
    providerAccountId: instagramUserId,
    displayName: '@acme_shop',
  });
  const [account] = await operatorQuery<Array<{ id: string }>>`
    INSERT INTO app.instagram_accounts
      (organization_id, channel_account_id, instagram_user_id, username)
    VALUES (${organizationId}, ${channelAccount.id}, ${instagramUserId}, 'acme_shop')
    RETURNING id`;
  return {
    id: Number(account?.id),
    channelAccountId: channelAccount.id,
    channelAccountPublicId: channelAccount.public_id,
    instagramUserId,
  };
}

/** What a test event may set; everything else takes a received comment's values. */
export interface TestInstagramWebhookEventValues {
  organizationId: number;
  /**
   * The event's account: its channel account when given, else the one its Instagram account row
   * (`id`) extends.
   */
  account: Pick<TestInstagramAccount, 'id' | 'instagramUserId'> &
    Partial<Pick<TestInstagramAccount, 'channelAccountId'>>;
  eventKind?: string;
  eventKey?: string;
  status?: string;
  skipReason?: string | null;
  errorMessage?: string | null;
  attemptCount?: number;
  payload?: Record<string, unknown>;
  /** The received time (`created_at`); defaults to now. */
  receivedAt?: Date;
  /** A failed event's next try. */
  nextAttemptAt?: Date | null;
  contactInstagramUserId?: string | null;
}

/**
 * Inserts one event as the operator (bypassing RLS), with `processed_at` set when the status is
 * final and the body only while it waits or failed — the table's CHECKs pair them (WH22). Writes no
 * event key (the store function's job). Returns its internal and public ids.
 */
export async function insertTestInstagramWebhookEvent(
  values: TestInstagramWebhookEventValues,
): Promise<{ id: number; publicId: string }> {
  const status = values.status ?? 'received';
  const receivedAt = values.receivedAt ?? new Date();
  const isFinal = status !== 'received' && status !== 'queued';
  const keepsBody = !isFinal || status === 'failed';
  const publicId = generatePublicId('instagramWebhookEvent');
  const eventKey =
    values.eventKey ?? `comment:${generatePublicId('instagramWebhookEvent').slice(4)}`;
  const payload = values.payload ?? {
    field: 'comments',
    value: {
      from: { id: TEST_CONTACT_INSTAGRAM_USER_ID, username: 'acme_customer' },
      id: eventKey.replace(/^comment:/, ''),
      text: 'Price please?',
    },
  };
  const [row] = await operatorQuery<Array<{ id: string }>>`
    INSERT INTO app.instagram_webhook_events
      (public_id, organization_id, channel_account_id, instagram_user_id,
       contact_instagram_user_id, event_kind, event_key, status, skip_reason, error_message,
       attempt_count, next_attempt_at, payload, processed_at, created_at, updated_at)
    VALUES (${publicId}, ${values.organizationId},
            COALESCE(${values.account.channelAccountId ?? null}::bigint,
                     (SELECT channel_account_id FROM app.instagram_accounts
                       WHERE id = ${values.account.id})),
            ${values.account.instagramUserId},
            ${values.contactInstagramUserId === undefined ? TEST_CONTACT_INSTAGRAM_USER_ID : values.contactInstagramUserId},
            ${values.eventKind ?? 'comment'}, ${eventKey}, ${status},
            ${values.skipReason ?? (status === 'skipped' ? 'own_comment' : null)},
            ${values.errorMessage ?? (status === 'failed' ? 'instagram_api:2/0' : null)},
            ${values.attemptCount ?? 0}, ${values.nextAttemptAt ?? null},
            ${keepsBody ? JSON.stringify(payload) : null}::jsonb,
            ${isFinal ? receivedAt : null}, ${receivedAt}, ${receivedAt})
    RETURNING id`;
  return { id: Number(row?.id), publicId };
}

/** The status, attempt count, lease, error and body of one event — read as the operator. */
export async function readTestInstagramWebhookEvent(eventId: number): Promise<{
  status: string;
  attempt_count: number;
  last_attempted_at: Date | null;
  error_message: string | null;
  skip_reason: string | null;
  processed_at: Date | null;
  payload: Record<string, unknown> | null;
} | null> {
  const [row] = await operatorQuery<
    Array<{
      status: string;
      attempt_count: number;
      last_attempted_at: Date | null;
      error_message: string | null;
      skip_reason: string | null;
      processed_at: Date | null;
      payload: Record<string, unknown> | null;
    }>
  >`
    SELECT status, attempt_count, last_attempted_at, error_message, skip_reason, processed_at,
           payload
    FROM app.instagram_webhook_events WHERE id = ${eventId}`;
  return row ?? null;
}

/**
 * A PERSONAL organization whose caller holds `instagram-webhook-event:read` through a custom role —
 * a shape the API never builds (a personal Owner holds no app code, IA2), made so a test reaches
 * the team-only read guard behind the permission gate: `404 team_organization_required`.
 */
export async function createPersonalOrganizationWithWebhookEventRead(): Promise<{
  organization: { id: number; public_id: string };
  token: string;
}> {
  const owner = await createTestUser();
  const organization = await createTestOrganization({ ownerUserId: owner.id, type: 'PERSONAL' });
  const role = await createRoleWithPermissions({
    organizationId: organization.id,
    permissionCodes: [APP_PERMISSIONS.INSTAGRAM_WEBHOOK_EVENT_READ],
  });
  await createMembership({ userId: owner.id, organizationId: organization.id, roleId: role.id });
  const token = await generateTestToken({
    userId: owner.public_id,
    organizationPublicId: organization.public_id,
  });
  return { organization, token };
}

/** `app.channel_accounts.id` an Instagram account row extends — read as the operator. */
export async function readChannelAccountIdOfInstagramAccount(
  instagramAccountId: number,
): Promise<number> {
  const [row] = await operatorQuery<Array<{ channel_account_id: string }>>`
    SELECT channel_account_id FROM app.instagram_accounts WHERE id = ${instagramAccountId}`;
  if (row === undefined) throw new Error('instagram account fixture has no channel account');
  return Number(row.channel_account_id);
}

/**
 * `app.channel_accounts.public_id` (`cha_…`) an Instagram account row extends — what the webhook's
 * processing job names the account by (feat-instagram-dm-sending R17, WHC4); read as the operator.
 */
export async function readChannelAccountPublicIdOfInstagramAccount(
  instagramAccountId: number,
): Promise<string> {
  const [row] = await operatorQuery<Array<{ public_id: string }>>`
    SELECT channel_accounts.public_id FROM app.instagram_accounts
    JOIN app.channel_accounts ON channel_accounts.id = instagram_accounts.channel_account_id
    WHERE instagram_accounts.id = ${instagramAccountId}`;
  if (row === undefined) throw new Error('instagram account fixture has no channel account');
  return row.public_id;
}
