import { beforeEach, describe, expect, it } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { insertChannelAccount } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { MessageMonthCountRepository } from '@/domains/app/sub-domains/instagram-sending/message-month-count.repository.js';
import { MessageMonthCountService } from '@/domains/app/sub-domains/instagram-sending/message-month-count.service.js';
import { FREE_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import {
  readLaneRows,
  readStopRows,
} from '@/domains/app/sub-domains/instagram-sending/__tests__/factories/instagram-sending.factory.js';

/**
 * The lanes and their stops in the database (feat-instagram-dm-sending routes-final § 6.A SNC10):
 * the four lanes of a pick, a stronger stop wins, a lane is never worked by two turns, the break's
 * stop and the reconnect that ends it (with the history), and the month count's `plan_limit` (CA9).
 * Runs in the organization's own scope, so it also holds under `pnpm test:rls-role`.
 */
describe('InstagramSendLaneService (database)', () => {
  const service = new InstagramSendLaneService(
    new InstagramSendLaneRepository(),
    new InstagramSendStopRepository(),
  );
  let target: {
    scope: OrganizationPrincipalDatabaseScope;
    organizationId: number;
    channelAccountId: number;
  };

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser()).id,
    });
    const account = await insertChannelAccount({
      organizationId: organization.id,
      providerAccountId: '17841477000000001',
    });
    target = {
      scope: PRINCIPAL_SCOPE.VERIFIED({
        organizationPublicId: organization.public_id,
      }) as OrganizationPrincipalDatabaseScope,
      organizationId: organization.id,
      channelAccountId: account.id,
    };
    await service.createLanesForAccount(target);
  });

  it('makes the four ready lanes once — a reconnect keeps them', async () => {
    await service.createLanesForAccount(target);
    const lanes = await readLaneRows(target.channelAccountId);
    expect(lanes.map((lane) => [lane.lane, lane.state, lane.turn_number])).toEqual([
      ['slow', 'ready', '0'],
      ['reply', 'ready', '0'],
      ['fast', 'ready', '0'],
      ['broadcast', 'ready', '0'],
    ]);
  });

  it('lets a stronger stop win and keeps a stronger one against a weaker', async () => {
    const until = new Date(Date.now() + 15 * 60_000);
    expect(
      await service.startLaneStop({
        ...target,
        lanes: ['slow'],
        reason: 'too_fast',
        stopUntil: until,
      }),
    ).toEqual(['slow']);
    expect(
      await service.startLaneStop({
        ...target,
        lanes: ['slow'],
        reason: 'blocked',
        stopUntil: null,
      }),
    ).toEqual(['slow']);
    expect(
      await service.startLaneStop({
        ...target,
        lanes: ['slow'],
        reason: 'too_fast',
        stopUntil: until,
      }),
    ).toEqual([]);
    const slow = (await readLaneRows(target.channelAccountId))[0];
    expect(slow).toMatchObject({ lane: 'slow', state: 'stopped', stop_reason: 'blocked' });
    expect((await readStopRows(target.channelAccountId)).map((row) => row.reason)).toEqual([
      'too_fast',
      'blocked',
    ]);
  });

  it('never lets two turns work one lane', async () => {
    const first = await service.claimLaneTurn({
      ...target,
      lane: 'slow',
      turnNumber: 0,
      leaseSeconds: 120,
    });
    expect(first?.state).toBe('working');
    const second = await service.claimLaneTurn({
      ...target,
      lane: 'slow',
      turnNumber: 0,
      leaseSeconds: 120,
    });
    expect(second).toBeNull();
    // A stale release does nothing; the right one moves to the next turn.
    expect(
      await service.releaseLaneTurn({
        ...target,
        lane: 'slow',
        workingTurn: 7,
        nextRunAt: new Date(),
      }),
    ).toBeNull();
    const released = await service.releaseLaneTurn({
      ...target,
      lane: 'slow',
      workingTurn: 0,
      nextRunAt: new Date(Date.now() + 6_000),
    });
    expect(released).toMatchObject({ state: 'sleeping', turn_number: 1, working_turn: null });
    expect(
      await service.claimLaneTurn({ ...target, lane: 'slow', turnNumber: 0, leaseSeconds: 120 }),
    ).toBeNull();
    expect(
      (await service.claimLaneTurn({ ...target, lane: 'slow', turnNumber: 1, leaseSeconds: 120 }))
        ?.state,
    ).toBe('working');
  });

  it('a lane with an error stop takes no turn', async () => {
    await service.startLaneStop({
      ...target,
      lanes: ['fast'],
      reason: 'too_fast',
      stopUntil: null,
    });
    expect(
      await service.claimLaneTurn({ ...target, lane: 'fast', turnNumber: 0, leaseSeconds: 120 }),
    ).toBeNull();
  });

  it('the break stops every lane until a reconnect ends it, in the history too', async () => {
    await service.startBrokenAccountStop({ ...target, reason: 'login_expired' });
    expect(
      (await readLaneRows(target.channelAccountId)).every((lane) => lane.state === 'stopped'),
    ).toBe(true);
    expect(await service.readActiveStop(target)).toEqual({
      lane: 'all',
      reason: 'login_expired',
      stop_until: null,
    });
    // A wake (a resume) leaves an error stop alone (AC-2.3).
    await service.wakeLanes(target);
    expect(
      (await readLaneRows(target.channelAccountId)).every((lane) => lane.state === 'stopped'),
    ).toBe(true);

    await service.endLoginStops(target);
    const lanes = await readLaneRows(target.channelAccountId);
    expect(lanes.every((lane) => lane.state === 'ready' && lane.stop_reason === null)).toBe(true);
    expect(await service.readActiveStop(target)).toBeNull();
    expect(await readStopRows(target.channelAccountId)).toMatchObject([
      { lane: 'all', reason: 'login_expired', ended_by: 'owner' },
    ]);
  });

  it('the month count answers plan_limit once the plan limit is reached (CA9, D34)', async () => {
    const monthService = new MessageMonthCountService(new MessageMonthCountRepository(), {
      getPlanAccess: async () => ({
        state: 'active',
        graceEndsAt: null,
        seatLimit: null,
        defaultedKeys: [],
        overrides: [],
        isPlanChoiceRequired: false,
        trialEndsAt: null,
        plan: { publicId: 'pln_test', name: 'Free' },
        features: { ...FREE_PLAN_FEATURES, message_month_limit: 5 },
      }),
    });
    await monthService.addMessages({ ...target, count: 4 });
    expect(await monthService.readOrganizationPlanStop(target)).toBeNull();
    await monthService.addMessages({ ...target, count: 1 });
    expect(await monthService.readOrganizationPlanStop(target)).toBe('plan_limit');
    expect((await monthService.readMonthFromDatabase(target)).used).toBe(5);
  });
});
