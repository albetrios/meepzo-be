import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  InstagramWebhookEventRepository,
  type NewInstagramWebhookEvent,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import { InstagramWebhookEventKeyRepository } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event-key.repository.js';
import { InstagramWebhookEventService } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import {
  type TestInstagramAccount,
  insertTestInstagramAccount,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';

/**
 * The store function against Postgres (feat-instagram-dm-sending § 5.B.3, WH9 steps 5–6, WH19,
 * WH20, WH22 — WHC11, WHC12; AC-16.4): the keys of `app.instagram_webhook_event_keys` make a repeat
 * save nothing, filed under Meta's event day; an event over 8 days old is never saved; a skipped
 * event is born without its body; every row lands in its day part. Runs in the organization's own
 * verified scope, as the receiver does, so it also holds under `pnpm test:rls-role`.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type TestOrganization = { id: number; public_id: string };

function commentEvent(
  commentId: string,
  overrides: Partial<NewInstagramWebhookEvent> = {},
): NewInstagramWebhookEvent {
  return {
    instagramUserId: '17841400000000001',
    contactInstagramUserId: '17841400000000777',
    eventKind: 'comment',
    eventKey: `comment:${commentId}`,
    skipReason: null,
    payload: { field: 'comments', value: { id: commentId, text: 'Price?' } },
    occurredAt: new Date(Date.now() - 60_000),
    ...overrides,
  };
}

async function countRows(table: string, organizationId: number): Promise<number> {
  const [row] = await operatorQuery.unsafe<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM app.${table} WHERE organization_id = $1`,
    [organizationId],
  );
  return Number(row?.count ?? 0);
}

describe('InstagramWebhookEventService.recordReceivedEvents (database)', () => {
  const service = new InstagramWebhookEventService(
    new InstagramWebhookEventRepository(),
    // The store function reads no organization (only route 62 does).
    {} as OrganizationService,
    new InstagramWebhookEventKeyRepository(),
  );
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let account: TestInstagramAccount;
  let otherAccount: TestInstagramAccount;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    otherOrganization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertTestInstagramAccount(organization.id);
    otherAccount = await insertTestInstagramAccount(otherOrganization.id);
  });

  function store({
    events,
    target = organization,
    targetAccount = account,
    now,
  }: {
    events: NewInstagramWebhookEvent[];
    target?: TestOrganization;
    targetAccount?: TestInstagramAccount;
    now?: Date;
  }) {
    return service.recordReceivedEvents({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: target.public_id }),
      channelAccount: {
        organizationId: target.id,
        channelAccountId: targetAccount.channelAccountId,
      },
      requestId: 'req-store',
      events,
      ...(now === undefined ? {} : { now }),
    });
  }

  it('saves the same event delivered twice once — the key, not the row, is the guard (AC-16.4)', async () => {
    expect(await store({ events: [commentEvent('18000000000000001')] })).toHaveLength(1);
    expect(await store({ events: [commentEvent('18000000000000001')] })).toEqual([]);

    expect(await countRows('instagram_webhook_events', organization.id)).toBe(1);
    expect(await countRows('instagram_webhook_event_keys', organization.id)).toBe(1);
  });

  it('saves a missed-comment read of a delivered comment once: one Meta day, one key (WHC12)', async () => {
    const commentTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await store({ events: [commentEvent('18000000000000002', { occurredAt: commentTime })] });
    // The missed-comment check saves the same comment later, from its own time.
    const later = await store({
      events: [commentEvent('18000000000000002', { occurredAt: commentTime })],
      now: new Date(Date.now() + 30 * 60 * 1000),
    });

    expect(later).toEqual([]);
    const [key] = await operatorQuery<Array<{ event_day: string }>>`
      SELECT to_char(event_day, 'YYYY-MM-DD') AS event_day FROM app.instagram_webhook_event_keys
      WHERE organization_id = ${organization.id}`;
    expect(key?.event_day).toBe(commentTime.toISOString().slice(0, 10));
  });

  it('never saves an event whose Meta time is over 8 days old (the replay guard, AC-16.4)', async () => {
    const stored = await store({
      events: [
        commentEvent('18000000000000003', {
          occurredAt: new Date(Date.now() - 9 * DAY_MILLISECONDS),
        }),
      ],
    });

    expect(stored).toEqual([]);
    expect(await countRows('instagram_webhook_events', organization.id)).toBe(0);
    expect(await countRows('instagram_webhook_event_keys', organization.id)).toBe(0);
  });

  it("keys per account: another organization's same key saves its own event", async () => {
    await store({ events: [commentEvent('18000000000000004')] });
    const other = await store({
      events: [
        commentEvent('18000000000000004', { instagramUserId: otherAccount.instagramUserId }),
      ],
      target: otherOrganization,
      targetAccount: otherAccount,
    });

    expect(other).toHaveLength(1);
  });

  it('saves a received event with its body and a skipped one without (WH22)', async () => {
    const [received, skipped] = await store({
      events: [
        commentEvent('18000000000000005'),
        commentEvent('18000000000000006', {
          skipReason: 'own_comment',
          contactInstagramUserId: null,
        }),
      ],
    });

    expect(received).toMatchObject({
      status: 'received',
      channel_account_id: account.channelAccountId,
      intake_group: 'comments',
    });
    expect(received?.payload).not.toBeNull();
    expect(skipped).toMatchObject({ status: 'skipped', skip_reason: 'own_comment', payload: null });
  });

  it('generates the intake group from the kind (WH11)', async () => {
    const rows = await store({
      events: [
        commentEvent('18000000000000007', {
          eventKind: 'live_comment',
          eventKey: 'live_comment:1',
        }),
        commentEvent('18000000000000008', { eventKind: 'postback', eventKey: 'postback:mid-1' }),
      ],
    });

    expect(rows.map((row) => row.intake_group)).toEqual(['live', 'messages']);
  });

  it("files every event in today's day part — never the default part", async () => {
    await store({ events: [commentEvent('18000000000000009')] });

    const [row] = await operatorQuery<Array<{ part: string }>>`
      SELECT tableoid::regclass::text AS part FROM app.instagram_webhook_events
      WHERE organization_id = ${organization.id}`;
    const today = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    expect(row?.part).toBe(`app.instagram_webhook_events_p${today}`);
    const [key] = await operatorQuery<Array<{ part: string }>>`
      SELECT tableoid::regclass::text AS part FROM app.instagram_webhook_event_keys
      WHERE organization_id = ${organization.id}`;
    expect(key?.part).toMatch(/^app\.instagram_webhook_event_keys_p\d{8}$/);
  });

  it('refuses a body on a done event and its absence on a waiting one (chk_instagram_webhook_events_body)', async () => {
    const [stored] = await store({ events: [commentEvent('18000000000000010')] });

    await expect(
      operatorQuery`
        UPDATE app.instagram_webhook_events SET status = 'processed', processed_at = now()
        WHERE id = ${stored?.id ?? 0}`,
    ).rejects.toThrow(/chk_instagram_webhook_events_body/);
    await expect(
      operatorQuery`
        UPDATE app.instagram_webhook_events SET payload = NULL WHERE id = ${stored?.id ?? 0}`,
    ).rejects.toThrow(/chk_instagram_webhook_events_body/);
  });
});
