import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import {
  type InstagramTeamFixture,
  createInstagramTeam,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { setMonthCount } from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';
import { runInstagramOwnerProblemEmailJob } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-owner-problem-email.processor.js';
import { runMessageMonthNoticeCheckJob } from '@/domains/app/sub-domains/instagram-sending/workers/message-month-notice-check.processor.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MINUTE = 60 * 1000;

/**
 * The app's notices against Postgres (feat-instagram-dm-sending WC-56, WC-57, UN1, ROUTE row R53 —
 * AC-10.3–AC-10.6, AC-14.8, AC-14.9): the month's 80 % and 100 % notices once per organization,
 * month and line — two at once still one email each —, the every-minute backup check, the owners'
 * problem emails once per kind and account in 6 hours (a stop that ended before its email was due
 * sends none), and the two app reads notify's weekly summary and grouped note take.
 */
describe('Instagram sending notices (R53)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
  });

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: team.organization.public_id });

  async function onFreePlan() {
    // A Free plan subscription: 1,000 messages a month (P37).
    const free = await createTestPlan({ name: 'Free', priceMonthly: '0.00', priceYearly: '0.00' });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: free.id,
      status: 'ACTIVE',
    });
  }

  async function inboxOf(type: string) {
    return operatorQuery<{ user_id: number; data: Record<string, unknown> }[]>`
      SELECT user_id::int AS user_id, data FROM notify.notifications
      WHERE organization_id = ${team.organization.id} AND type = ${type} ORDER BY id`;
  }

  const editorIds = () => [team.owner.id, team.editor.id];

  it('80 % sends one notice and one email per person that month, again nothing; 100 % one more — two at once still once (AC-10.3–AC-10.5)', async () => {
    await onFreePlan();
    await insertChannelAccount({
      organizationId: team.organization.id,
      providerAccountId: '17841499000000101',
    });
    const service = app.appDomain.messageMonthNoticeService;

    await setMonthCount({ organizationId: team.organization.id, count: 799 });
    expect(await service.tellMonthLine({ scope: scope() })).toEqual({
      line: null,
      notifiedCount: 0,
    });

    await setMonthCount({ organizationId: team.organization.id, count: 800 });
    const nearly = await service.tellMonthLine({ scope: scope() });
    expect(nearly.line).toBe(80);
    expect(nearly.notifiedCount).toBeGreaterThanOrEqual(2);
    const firstRows = await inboxOf('billing.usage_threshold');
    expect(firstRows.map((row) => row.user_id)).toEqual(expect.arrayContaining(editorIds()));
    expect(firstRows.map((row) => row.user_id)).not.toContain(team.viewer.id);
    expect(firstRows[0]!.data).toMatchObject({ percent: 80 });
    // Email on by default: each inbox row carries its email (the notification worker sends it,
    // keyed by the row — one email per person).
    expect(firstRows.every((row) => (row.data.channels as string[]).includes('email'))).toBe(true);

    // Crossing again the same month: nothing more.
    await setMonthCount({ organizationId: team.organization.id, count: 850 });
    expect((await service.tellMonthLine({ scope: scope() })).notifiedCount).toBe(0);
    expect(await inboxOf('billing.usage_threshold')).toHaveLength(firstRows.length);

    // Two servers reach 100 % at once: one notice and one email per person.
    await setMonthCount({ organizationId: team.organization.id, count: 1000 });
    await Promise.all([
      service.tellMonthLine({ scope: scope() }),
      service.tellMonthLine({ scope: scope() }),
    ]);
    const allRows = await inboxOf('billing.usage_threshold');
    expect(allRows).toHaveLength(2 * firstRows.length);
    expect(allRows.filter((row) => row.data.percent === 100)).toHaveLength(firstRows.length);
    // The every-minute backup check finds the organization counted lately and tells nothing new.
    const checked = await runMessageMonthNoticeCheckJob({ monthNotice: service });
    expect(checked).toMatchObject({ checkedCount: 1, notifiedCount: 0, failedCount: 0 });
  });

  it('owner problem emails: a block is told once to Owner, Admin and Editor; a long stop only after an hour and never after it ended (AC-10.6)', async () => {
    const blocked = await insertChannelAccount({
      organizationId: team.organization.id,
      providerAccountId: '17841499000000102',
      displayName: '@acme.blocked',
    });
    const slow = await insertChannelAccount({
      organizationId: team.organization.id,
      providerAccountId: '17841499000000103',
    });
    const short = await insertChannelAccount({
      organizationId: team.organization.id,
      providerAccountId: '17841499000000104',
    });
    const now = new Date();
    const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE).toISOString();
    await operatorQuery`
      INSERT INTO app.instagram_send_stops (organization_id, channel_account_id, lane, reason, started_at)
      VALUES (${team.organization.id}, ${blocked.id}, 'slow', 'blocked', ${at(1)}),
             (${team.organization.id}, ${blocked.id}, 'reply', 'blocked', ${at(1)}),
             (${team.organization.id}, ${slow.id}, 'slow', 'too_fast', ${at(30)})`;
    await operatorQuery`
      INSERT INTO app.instagram_send_stops
        (organization_id, channel_account_id, lane, reason, started_at, ended_at, ended_by)
      VALUES (${team.organization.id}, ${short.id}, 'slow', 'too_fast', ${at(70)}, ${at(65)}, 'time')`;

    await runInstagramOwnerProblemEmailJob({ now });
    const rows = await inboxOf('automation.stopped');
    expect(rows.every((row) => row.data.problem === 'blocked')).toBe(true);
    expect(rows.map((row) => row.user_id)).toEqual(expect.arrayContaining(editorIds()));
    expect(rows.map((row) => row.user_id)).not.toContain(team.viewer.id);
    const told = rows.length;
    expect(rows.every((row) => (row.data.channels as string[]).includes('email'))).toBe(true);

    // The next minute: nothing again for the block; a second block within 6 hours adds nothing.
    await operatorQuery`
      INSERT INTO app.instagram_send_stops (organization_id, channel_account_id, lane, reason, started_at)
      VALUES (${team.organization.id}, ${blocked.id}, 'fast', 'blocked', ${at(0)})`;
    await runInstagramOwnerProblemEmailJob({ now: new Date(now.getTime() + MINUTE) });
    expect(await inboxOf('automation.stopped')).toHaveLength(told);

    // 31 minutes on, the too-fast stop has lasted an hour: told as a long stop.
    await runInstagramOwnerProblemEmailJob({ now: new Date(now.getTime() + 31 * MINUTE) });
    const later = await inboxOf('automation.stopped');
    expect(later.filter((row) => row.data.problem === 'long_stop')).toHaveLength(told);
    expect(later.filter((row) => row.data.channel_account_id === short.public_id)).toHaveLength(0);
  });

  it('the weekly summary and the grouped note read the app through its services (UN1)', async () => {
    const account = await insertInstagramAccount({ organizationId: team.organization.id });
    const now = new Date();
    const since = new Date(now.getTime() - 60 * MINUTE);
    const inWindow = new Date(now.getTime() - 10 * MINUTE);
    await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      first_seen_at: inWindow,
      email: 'a@example.com',
      email_collected_at: inWindow,
    });
    await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      first_seen_at: inWindow,
      phone: '+15550000001',
      phone_collected_at: inWindow,
    });
    await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      first_seen_at: inWindow,
      email: 'c@example.com',
      email_collected_at: inWindow,
      phone: '+15550000002',
      phone_collected_at: inWindow,
    });
    // Before the window: not counted.
    await insertContact({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      first_seen_at: new Date(now.getTime() - 3 * 60 * MINUTE),
      email: 'old@example.com',
      email_collected_at: new Date(now.getTime() - 2 * 60 * MINUTE),
    });
    const [channelAccount] = await operatorQuery<{ public_id: string }[]>`
      SELECT public_id FROM app.channel_accounts WHERE id = ${account.channel_account_id}`;

    const counted = await app.appDomain.contactService.countContactsWithDetailsLeft({
      scope: scope(),
      channelAccountPublicId: channelAccount!.public_id,
      since,
      until: now,
    });
    expect(counted).toMatchObject({ count: 3 });

    const week = await app.appDomain.channelAccountService.readWeeklySummary({
      scope: scope(),
      since: new Date(now.getTime() - 7 * 24 * 60 * MINUTE),
      until: new Date(now.getTime() + MINUTE),
    });
    expect(week.accounts).toHaveLength(1);
    expect(week.accounts[0]).toMatchObject({
      channelAccountPublicId: channelAccount!.public_id,
      runsStarted: 0,
      newContacts: 4,
      emailsCollected: 3,
      phonesCollected: 2,
      tappedPercent: 0,
      topAutomationName: null,
    });
    expect(week.monthUsed).toBe(0);
  });
});
