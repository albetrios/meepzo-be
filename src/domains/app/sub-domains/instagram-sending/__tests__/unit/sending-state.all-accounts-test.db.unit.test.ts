import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  SendingStateService,
  allAccountsReleaseAt,
  decideAllAccountsGate,
} from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';

const MINUTE = 60_000;

/**
 * The all-accounts test and the release (plan §33.6 rules 2–3 — ROUTE row R62; AC-27.8): after an
 * all-accounts stop the first lane takes the one test; a good test releases the lanes spread over
 * 5 minutes; a bad one starts the stop again one step longer; an unclear one the same step again.
 */
describe('SendingStateService — the all-accounts test (database)', () => {
  const service = new SendingStateService({ readClockSkewMilliseconds: () => 0 });

  async function row() {
    const state = await service.readSendingState();
    if (state === null) throw new Error('no sending row');
    return state;
  }

  beforeEach(async () => {
    await cleanupDatabase();
    await service.ensureSendingState({ environmentId: 'test' });
    await operatorQuery`
      UPDATE app.sending_states SET all_stop_reason = NULL, all_stop_until = NULL, all_stop_count = 0,
        testing_lane = NULL, testing_until = NULL, all_release_started_at = NULL`;
  });

  it('holds every lane during the stop, gives its test to one lane only, and releases on a good test', async () => {
    await service.startAllAccountsDownStop();
    expect((await service.readAllAccountsGate()).kind).toBe('stopped');
    expect(await service.claimAllAccountsTest({ lane: 'slow' })).toBeNull();

    await operatorQuery`UPDATE app.sending_states SET all_stop_until = now() - interval '1 second'`;
    expect((await service.readAllAccountsGate()).kind).toBe('test_due');
    expect(await service.claimAllAccountsTest({ lane: 'slow' })).toBe('instagram_down');
    expect(await service.claimAllAccountsTest({ lane: 'fast' })).toBeNull();
    expect((await service.readAllAccountsGate()).kind).toBe('testing');

    await service.finishAllAccountsTest({ outcome: 'good' });
    const released = await row();
    expect(released.testing_lane).toBeNull();
    expect(released.all_release_started_at).toBeInstanceOf(Date);
    expect((await service.readAllAccountsGate()).kind).toBe('releasing');
    expect(
      (
        await service.readAllAccountsGate(
          new Date(released.all_release_started_at!.getTime() + 5 * MINUTE),
        )
      ).kind,
    ).toBe('free');
  });

  it('a bad test starts the stop again one step longer and counted; an unclear one the same step; none frees the test', async () => {
    await service.startAllAccountsDownStop();
    await operatorQuery`UPDATE app.sending_states SET all_stop_until = now() - interval '1 second'`;
    await service.claimAllAccountsTest({ lane: 'slow' });
    await service.finishAllAccountsTest({ outcome: 'bad' });
    const bad = await row();
    expect(bad.all_stop_count).toBe(2);
    const badMinutes = (bad.all_stop_until!.getTime() - Date.now()) / MINUTE;
    expect(badMinutes).toBeGreaterThan(9);
    expect(badMinutes).toBeLessThanOrEqual(10);

    await operatorQuery`UPDATE app.sending_states SET all_stop_until = now() - interval '1 second'`;
    await service.claimAllAccountsTest({ lane: 'reply' });
    await service.finishAllAccountsTest({ outcome: 'unclear' });
    const unclear = await row();
    expect(unclear.all_stop_count).toBe(2);
    expect((unclear.all_stop_until!.getTime() - Date.now()) / MINUTE).toBeLessThanOrEqual(10);

    await operatorQuery`UPDATE app.sending_states SET all_stop_until = now() - interval '1 second'`;
    await service.claimAllAccountsTest({ lane: 'broadcast' });
    await service.finishAllAccountsTest({ outcome: 'none' });
    expect((await service.readAllAccountsGate()).kind).toBe('test_due');
    // A good test releases; a new stop starts again without that release.
    await service.claimAllAccountsTest({ lane: 'slow' });
    await service.finishAllAccountsTest({ outcome: 'good' });
    expect((await row()).all_release_started_at).toBeInstanceOf(Date);
    expect(await service.startAllAccountsDownStop()).toBeInstanceOf(Date);
    expect(await row()).toMatchObject({ all_release_started_at: null, testing_lane: null });
  });
});

describe('the all-accounts gate and release (pure)', () => {
  it('spreads the lanes of 200 accounts over the 5 minutes, each lane always at the same place', () => {
    const releaseStartedAt = new Date('2026-11-25T11:00:00Z');
    const offsets = Array.from({ length: 200 }, (_, index) =>
      [0, 1, 2, 3].map(
        (laneIndex) =>
          allAccountsReleaseAt({
            releaseStartedAt,
            channelAccountId: index + 1,
            laneIndex,
          }).getTime() - releaseStartedAt.getTime(),
      ),
    ).flat();
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...offsets)).toBeLessThan(5 * MINUTE);
    // Every minute of the spread takes some lanes (no rush at its start).
    for (let minute = 0; minute < 5; minute += 1) {
      const inMinute = offsets.filter((offset) => Math.floor(offset / MINUTE) === minute).length;
      expect(inMinute).toBeGreaterThan(80);
    }
    expect(allAccountsReleaseAt({ releaseStartedAt, channelAccountId: 7, laneIndex: 2 })).toEqual(
      allAccountsReleaseAt({ releaseStartedAt, channelAccountId: 7, laneIndex: 2 }),
    );
  });

  it('decides free, stopped, test due, testing and releasing from the row', () => {
    const now = new Date('2026-11-25T11:00:00Z');
    const base = {
      all_stop_reason: 'app_limit',
      all_stop_until: new Date(now.getTime() - 1000),
      testing_lane: null,
      testing_until: null,
      all_release_started_at: null,
    };
    expect(decideAllAccountsGate({ state: null, now }).kind).toBe('free');
    expect(
      decideAllAccountsGate({
        state: { ...base, all_stop_until: new Date(now.getTime() + 1000) },
        now,
      }).kind,
    ).toBe('stopped');
    expect(decideAllAccountsGate({ state: base, now }).kind).toBe('test_due');
    expect(
      decideAllAccountsGate({
        state: { ...base, testing_lane: 'slow', testing_until: new Date(now.getTime() + 1000) },
        now,
      }).kind,
    ).toBe('testing');
    expect(
      decideAllAccountsGate({
        state: { ...base, all_release_started_at: new Date(now.getTime() - MINUTE) },
        now,
      }).kind,
    ).toBe('releasing');
    expect(
      decideAllAccountsGate({
        state: { ...base, all_release_started_at: new Date(now.getTime() - 6 * MINUTE) },
        now,
      }).kind,
    ).toBe('free');
  });
});
