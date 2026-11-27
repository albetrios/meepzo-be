import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { META_GRAPH_BASE_URL } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  eraseContactRow,
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { insertAutomation } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertAutomationRun } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { parseAutomationButtonPayload } from '@/domains/app/sub-domains/automation/automation-run/automation-run-button-payload.util.js';
import {
  insertInstagramOutgoingMessage,
  readInstagramOutgoingMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import { insertLanes } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import {
  buildLaneHarness,
  type LaneHarness,
  type LaneHarnessAccount,
  LaneHarnessTicketReturned,
  readLaneRow,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-lane-harness.factory.js';
import { InstagramSendComposeService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-compose.service.js';
import { InstagramFastLaneRules } from '@/domains/app/sub-domains/instagram-sending/instagram-fast-lane.service.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HOUR = 3_600_000;
const MINUTE = 60_000;

type MessageRow = Awaited<ReturnType<typeof insertInstagramOutgoingMessage>>;

/**
 * The fast lane's rules in the real send core (feat-instagram-dm-sending routes-final § 6.10 WC-7;
 * plan §30; ROUTE row R44 — AC-17.3, AC-17.5, AC-17.6, AC-17.14, AC-17.15, AC-16.18, AC-17.17):
 * her answers as DMs with their payload's message part, one of hers at a time, the account's 20 /
 * 5 audio and the organization's in-flight cap (S21), the window, the nudge, the follow check's two
 * tries and the Live private reply's 240 minutes. Meta via nock only.
 */
describe('InstagramFastLaneRules (database)', () => {
  let organization: { id: number; public_id: string };
  let account: LaneHarnessAccount;
  let automationId: number;
  let harness: LaneHarness;

  const igUserId = () => `1784${account.channel_account_id}`;

  async function contactWith(
    overrides: Omit<
      Parameters<typeof insertContact>[0],
      'organizationId' | 'instagramAccountId'
    > = {},
  ) {
    return insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      full_name: 'Riya',
      username: 'riya.k',
      last_direct_message_received_at: new Date(),
      ...overrides,
    });
  }

  /** A run of `triggerType` and one waiting fast message of it. */
  async function waitingFast({
    contactId,
    triggerType = 'dm_keyword',
    message = {},
  }: {
    contactId: number;
    triggerType?: 'dm_keyword' | 'comment' | 'live_comment';
    message?: Partial<Parameters<typeof insertInstagramOutgoingMessage>[0]>;
  }): Promise<MessageRow> {
    const isComment = triggerType !== 'dm_keyword';
    const occurredAt = (message.trigger_occurred_at as Date | undefined) ?? new Date();
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId,
      contactId,
      // Two of her runs side by side in one test (no open key to share).
      isOpenKeyLeftOut: true,
      trigger_type: triggerType,
      trigger_occurred_at: occurredAt,
      ...(isComment
        ? {
            trigger_instagram_comment_id: '17900000000000001',
            trigger_instagram_media_id: '17800000000000001',
          }
        : {}),
      status: 'running',
      current_step: 'messages',
      waiting_for: null,
      waiting_since_at: null,
    });
    return insertInstagramOutgoingMessage({
      run,
      channelAccountId: account.channel_account_id,
      message_type: 'message',
      message_number: 1,
      lane: 'fast',
      channel: 'direct',
      is_counted_as_direct_message: true,
      status: 'waiting',
      reason: null,
      not_before: new Date(Date.now() - 1_000),
      trigger_occurred_at: occurredAt,
      ...message,
    });
  }

  function metaSends(answers: Array<{ status: number; body: object }>, bodies: unknown[] = []) {
    let scope = nock(META_GRAPH_BASE_URL);
    for (const answer of answers) {
      scope = scope
        .post(`/v27.0/${igUserId()}/messages`, (body) => {
          bodies.push(body);
          return true;
        })
        .query(true)
        .reply(answer.status, answer.body);
    }
    return scope;
  }

  async function returnedDelay(message: MessageRow): Promise<number | null> {
    try {
      await harness.fast(message);
      return null;
    } catch (error) {
      if (error instanceof LaneHarnessTicketReturned) return error.delayMilliseconds;
      throw error;
    }
  }

  async function messageOf(publicId: string) {
    return (await readInstagramOutgoingMessages(organization.id)).find(
      (row) => row.public_id === publicId,
    )!;
  }

  /** Erases her once the core claimed the message, before its compose (a commit mid-send). */
  function eraseAfterClaim(contactId: number, statuses: string[]) {
    harness.beforeCompose.value = async (claimed) => {
      statuses.push((await messageOf(claimed.public_id)).status);
      await eraseContactRow({
        organizationPublicId: organization.public_id,
        organizationId: organization.id,
        contactId,
      });
    };
  }

  beforeEach(async () => {
    await cleanupDatabase();
    nock.cleanAll();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    await insertLanes({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    });
    const automation = await insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      steps: {
        hello: {
          on: true,
          nudge: true,
          versions: [
            {
              text: 'Hi {name}! Want the guide?',
              buttons: [{ title: 'Send me the guide', action: 'next' }],
            },
          ],
        },
        messages: [{ kind: 'text', text: 'Here it is, {name}', wait_minutes: 0 }],
      },
    });
    automationId = automation.id;
    harness = buildLaneHarness({
      organization,
      account,
      laneRules: (messageService) => ({
        fast: new InstagramFastLaneRules({
          messageService,
          composeService: new InstagramSendComposeService({ translate: (key) => `t:${key}` }),
        }),
      }),
    });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('sends her answer as a DM in the fast lane, counted 1 in the month, its place back on the lane (AC-17.3, AC-17.17)', async () => {
    const contact = await contactWith();
    const message = await waitingFast({ contactId: contact.id });
    const bodies: unknown[] = [];
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.fast.1' } }], bodies);
    await harness.fast(message);
    expect(meta.isDone()).toBe(true);
    expect(bodies[0]).toMatchObject({
      recipient: { id: contact.instagram_user_id },
      message: { text: 'Here it is, Riya' },
    });
    expect(await messageOf(message.public_id)).toMatchObject({ status: 'sent' });
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'fast' })).sending_count,
    ).toBe(0);
    const [month] = await operatorQuery<{ used: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${organization.id}`;
    expect(month?.used).toBe(1);
    const [attempt] = await operatorQuery<{ count_group: string }[]>`
      SELECT count_group FROM app.instagram_send_attempts WHERE organization_id = ${organization.id}`;
    expect(attempt?.count_group).toBe('fast');
    expect(harness.recorded).toEqual([
      expect.objectContaining({ step: 'messages', result: 'sent' }),
    ]);
  });

  it('carries the message in the hello button payload `<aut_…>::<run_…>::<igm_…>` (plan §30.8, WH8)', async () => {
    const contact = await contactWith();
    const hello = await waitingFast({
      contactId: contact.id,
      message: { message_type: 'opening_message', message_number: null },
    });
    const bodies: Array<{
      message: { attachment: { payload: { buttons: Array<{ payload: string }> } } };
    }> = [];
    metaSends([{ status: 200, body: { message_id: 'mid.hello' } }], bodies);
    await harness.fast(hello);
    const payload = bodies[0]!.message.attachment.payload.buttons[0]!.payload;
    expect(parseAutomationButtonPayload(payload)).toMatchObject({
      messagePublicId: hello.public_id,
    });
  });

  it('proves an `unknown` message `sent` by her tap on its button (plan §14)', async () => {
    const contact = await contactWith();
    const message = await waitingFast({
      contactId: contact.id,
      message: { status: 'unknown', reason: null },
    });
    const { withAppDatabaseContext, PRINCIPAL_SCOPE } = await import(
      '@/infrastructure/database/contexts/database-context.js'
    );
    const moved = await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
      callback: (databaseHandle) =>
        harness.messageService.markTappedMessageSent({
          databaseHandle,
          organizationId: organization.id,
          messagePublicId: message.public_id,
        }),
    });
    expect(moved).toBe(true);
    expect(await messageOf(message.public_id)).toMatchObject({ status: 'sent', reason: null });
  });

  it('skips a message whose window closed `window_closed` and tells the run (AC-17.5)', async () => {
    const contact = await contactWith({
      last_direct_message_received_at: new Date(Date.now() - 24 * HOUR),
    });
    const message = await waitingFast({ contactId: contact.id });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.fast(message);
    expect(meta.isDone()).toBe(false);
    expect(await messageOf(message.public_id)).toMatchObject({
      status: 'skipped',
      reason: 'window_closed',
    });
    expect(harness.recorded).toEqual([
      expect.objectContaining({ step: 'messages', result: 'skipped', reason: 'window_closed' }),
    ]);
  });

  it("moves a comment's opening DM back to the slow lane as a private reply when her window closed (plan §27.12)", async () => {
    const contact = await contactWith({
      last_direct_message_received_at: new Date(Date.now() - 24 * HOUR),
    });
    const message = await waitingFast({
      contactId: contact.id,
      triggerType: 'comment',
      message: { message_type: 'opening_message', message_number: null },
    });
    await harness.fast(message);
    expect(await messageOf(message.public_id)).toMatchObject({
      status: 'waiting',
      lane: 'slow',
      channel: 'private_reply',
    });
  });

  it('sends one message of hers at a time: another of hers `sending` puts the ticket back 1 s (plan §30.2 step 5, AC-17.15)', async () => {
    const contact = await contactWith();
    await waitingFast({
      contactId: contact.id,
      message: { status: 'sending', sending_at: new Date() },
    });
    const second = await waitingFast({ contactId: contact.id });
    expect(await returnedDelay(second)).toBe(1_000);
    expect(await messageOf(second.public_id)).toMatchObject({ status: 'waiting', tries: 0 });
  });

  it("holds at the account's 20 `sending`, its 5 audio and the organization's 25 places: back in 500 ms (plan §30.2 step 8, S21)", async () => {
    const contact = await contactWith();
    const message = await waitingFast({ contactId: contact.id });
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET sending_count = 20
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'fast'`;
    expect(await returnedDelay(message)).toBe(500);

    await operatorQuery`
      UPDATE app.instagram_send_lanes SET sending_count = 0
      WHERE channel_account_id = ${account.channel_account_id} AND lane = 'fast'`;
    const others = await Promise.all(
      [0, 1].map(() => insertInstagramAccount({ organizationId: organization.id })),
    );
    for (const other of others) {
      await insertLanes({
        organizationId: organization.id,
        channelAccountId: other.channel_account_id,
      });
    }
    await operatorQuery`
      UPDATE app.instagram_send_lanes SET sending_count = CASE
        WHEN channel_account_id = ${others[0]!.channel_account_id} THEN 15 ELSE 10 END
      WHERE organization_id = ${organization.id} AND lane = 'fast'
        AND channel_account_id <> ${account.channel_account_id}`;
    expect(await returnedDelay(message)).toBe(500);

    await operatorQuery`
      UPDATE app.instagram_send_lanes SET sending_count = 0 WHERE organization_id = ${organization.id}`;
    const audio = await waitingFast({
      contactId: contact.id,
      message: { message_kind: 'audio' },
    });
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET status = 'waiting' WHERE public_id = ${message.public_id}`;
    for (let index = 0; index < 5; index += 1) {
      const someone = await contactWith({ username: `listener.${index}` });
      await waitingFast({
        contactId: someone.id,
        message: { message_kind: 'audio', status: 'sending', sending_at: new Date() },
      });
    }
    expect(await returnedDelay(audio)).toBe(500);
  });

  it('cancels a nudge she answered after the hello `answered`; an unanswered one goes (AC-17.6)', async () => {
    const answered = await contactWith();
    const nudge = await waitingFast({
      contactId: answered.id,
      message: {
        message_type: 'nudge',
        message_number: null,
        created_at: new Date(Date.now() - 61 * MINUTE),
      },
    });
    await harness.fast(nudge);
    expect(await messageOf(nudge.public_id)).toMatchObject({
      status: 'cancelled',
      reason: 'answered',
    });

    const quiet = await contactWith({
      username: 'quiet.one',
      last_direct_message_received_at: new Date(Date.now() - 2 * HOUR),
    });
    const quietNudge = await waitingFast({
      contactId: quiet.id,
      message: {
        message_type: 'nudge',
        message_number: null,
        created_at: new Date(Date.now() - 61 * MINUTE),
      },
    });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.nudge' } }]);
    await harness.fast(quietNudge);
    expect(meta.isDone()).toBe(true);
    expect(await messageOf(quietNudge.public_id)).toMatchObject({ status: 'sent' });
  });

  it('tries the follow check twice — a refused read waits 2–5 s, the second failure is "following" — and never counts it (AC-17.14, AC-17.17)', async () => {
    const contact = await contactWith();
    const check = await waitingFast({
      contactId: contact.id,
      message: {
        message_type: 'follow_check',
        message_number: null,
        channel: null,
        is_counted_as_direct_message: false,
      },
    });
    const read = () =>
      nock(META_GRAPH_BASE_URL)
        .get(`/v27.0/${contact.instagram_user_id}`)
        .query(true)
        .reply(400, { error: { message: 'no consent', type: 'OAuthException', code: 230 } });
    read();
    const before = Date.now();
    await harness.fast(check);
    const afterFirst = await messageOf(check.public_id);
    expect(afterFirst).toMatchObject({ status: 'waiting', tries: 1 });
    expect(afterFirst.not_before!.getTime() - before).toBeGreaterThanOrEqual(2_000);
    expect(afterFirst.not_before!.getTime() - Date.now()).toBeLessThanOrEqual(5_000);
    expect(harness.fastTickets).toEqual([
      expect.objectContaining({ instagramMessagePublicId: check.public_id, tries: 1 }),
    ]);
    await operatorQuery`
      UPDATE app.instagram_outgoing_messages SET not_before = now() WHERE public_id = ${check.public_id}`;
    read();
    await harness.fast(afterFirst);
    expect(await messageOf(check.public_id)).toMatchObject({
      status: 'sent',
      reason: 'assumed_following',
    });
    expect(harness.recorded).toEqual([
      expect.objectContaining({
        step: 'follow_check',
        result: 'sent',
        reason: 'assumed_following',
      }),
    ]);
    const [month] = await operatorQuery<{ used: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${organization.id}`;
    expect(month?.used ?? 0).toBe(0);
  });

  it('saves what the follow check read: `following` (plan §30.9)', async () => {
    const contact = await contactWith();
    const check = await waitingFast({
      contactId: contact.id,
      message: {
        message_type: 'follow_check',
        message_number: null,
        channel: null,
        is_counted_as_direct_message: false,
      },
    });
    nock(META_GRAPH_BASE_URL)
      .get(`/v27.0/${contact.instagram_user_id}`)
      .query(true)
      .reply(200, { username: 'riya.k', is_user_follow_business: true });
    await harness.fast(check);
    expect(await messageOf(check.public_id)).toMatchObject({ status: 'sent', reason: 'following' });
  });

  it('sends a Live private reply to its comment while under 240 minutes; an older one is `expired` · `live_ended` without a call (AC-16.18)', async () => {
    const contact = await contactWith({
      last_direct_message_received_at: new Date(Date.now() - 48 * HOUR),
    });
    const fresh = await waitingFast({
      contactId: contact.id,
      triggerType: 'live_comment',
      message: {
        message_type: 'opening_message',
        message_number: null,
        channel: 'private_reply',
        trigger_occurred_at: new Date(Date.now() - 30 * MINUTE),
      },
    });
    const bodies: unknown[] = [];
    metaSends([{ status: 200, body: { message_id: 'mid.live' } }], bodies);
    await harness.fast(fresh);
    expect(bodies[0]).toMatchObject({ recipient: { comment_id: '17900000000000001' } });
    expect(await messageOf(fresh.public_id)).toMatchObject({ status: 'sent' });

    const other = await contactWith({ username: 'late.viewer' });
    const old = await waitingFast({
      contactId: other.id,
      triggerType: 'live_comment',
      message: {
        message_type: 'opening_message',
        message_number: null,
        channel: 'private_reply',
        trigger_occurred_at: new Date(Date.now() - 241 * MINUTE),
      },
    });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.fast(old);
    expect(meta.isDone()).toBe(false);
    expect(await messageOf(old.public_id)).toMatchObject({
      status: 'expired',
      reason: 'live_ended',
    });
  });

  it('skips an opted-out person `opted_out` before any call (plan §30.2 step 6)', async () => {
    const contact = await contactWith({ opted_out_at: new Date() });
    const message = await waitingFast({ contactId: contact.id });
    await harness.fast(message);
    expect(await messageOf(message.public_id)).toMatchObject({
      status: 'skipped',
      reason: 'opted_out',
    });
  });

  it('settles a claimed DM `skipped` · `contact_deleted` without a Meta call when she is erased mid-send, its place back (plan §30.2)', async () => {
    const contact = await contactWith();
    const message = await waitingFast({ contactId: contact.id });
    const statuses: string[] = [];
    eraseAfterClaim(contact.id, statuses);
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.fast(message);
    expect(statuses).toEqual(['sending']);
    expect(meta.isDone()).toBe(false);
    expect(await messageOf(message.public_id)).toMatchObject({
      status: 'skipped',
      reason: 'contact_deleted',
    });
    expect(harness.recorded).toEqual([
      expect.objectContaining({ step: 'messages', result: 'skipped', reason: 'contact_deleted' }),
    ]);
    expect(
      (await readLaneRow({ organizationId: organization.id, account, lane: 'fast' })).sending_count,
    ).toBe(0);
    const [month] = await operatorQuery<{ used: number }[]>`
      SELECT coalesce(sum(count), 0)::int AS used FROM app.message_month_counts
      WHERE organization_id = ${organization.id}`;
    expect(month?.used ?? 0).toBe(0);
  });

  it('settles a claimed follow check `skipped` · `contact_deleted` without reading her follow when she is erased mid-send (plan §30.9)', async () => {
    const contact = await contactWith();
    const check = await waitingFast({
      contactId: contact.id,
      message: {
        message_type: 'follow_check',
        message_number: null,
        channel: null,
        is_counted_as_direct_message: false,
      },
    });
    const statuses: string[] = [];
    eraseAfterClaim(contact.id, statuses);
    const read = nock(META_GRAPH_BASE_URL)
      .get(`/v27.0/${contact.instagram_user_id}`)
      .query(true)
      .reply(200, { username: 'riya.k', is_user_follow_business: true });
    await harness.fast(check);
    expect(statuses).toEqual(['sending']);
    expect(read.isDone()).toBe(false);
    expect(await messageOf(check.public_id)).toMatchObject({
      status: 'skipped',
      reason: 'contact_deleted',
    });
  });

  it('skips a message of an erased person `contact_deleted` at its check, before any claim (plan §30.2 step 6)', async () => {
    const contact = await contactWith();
    const message = await waitingFast({ contactId: contact.id });
    await eraseContactRow({
      organizationPublicId: organization.public_id,
      organizationId: organization.id,
      contactId: contact.id,
    });
    const meta = metaSends([{ status: 200, body: { message_id: 'mid.never' } }]);
    await harness.fast(message);
    expect(meta.isDone()).toBe(false);
    expect(await messageOf(message.public_id)).toMatchObject({
      status: 'skipped',
      reason: 'contact_deleted',
      tries: 0,
    });
  });
});
