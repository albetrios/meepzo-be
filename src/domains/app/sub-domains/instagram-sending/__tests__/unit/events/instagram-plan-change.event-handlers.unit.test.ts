import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDomainEvent } from '@/core/events/event-bus.js';
import type { PlanStateChangedPayload } from '@/domains/billing/sub-domains/subscription/events/subscription.events.js';

const enqueued = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const failNext = vi.hoisted(() => ({ value: false }));

vi.mock(
  '@/domains/app/sub-domains/instagram-sending/queues/instagram-database-tasks.queue.js',
  () => ({
    enqueueInstagramDatabaseTask: async (input: Record<string, unknown>) => {
      if (failNext.value) {
        failNext.value = false;
        throw new Error('redis down');
      }
      enqueued.push(input);
    },
  }),
);

const { onPlanStateChangedEvent } = await import(
  '@/domains/app/sub-domains/instagram-sending/events/instagram-plan-change.event-handlers.js'
);
const { instagramMonthWakeJobId, instagramPlanChangeTaskInputSchema } = await import(
  '@/domains/app/sub-domains/instagram-sending/queues/instagram-plan-change.job.schema.js'
);

function payload(overrides: Partial<PlanStateChangedPayload> = {}): PlanStateChangedPayload {
  return {
    organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
    change: 'plan_ended',
    previous: { state: 'grace', plan_public_id: 'pln_aaaaaaaaaaaaaaaaaaaaa' },
    current: { state: 'read_only', plan_public_id: 'pln_bbbbbbbbbbbbbbbbbbbbb' },
    features: null,
    kept_channel_account_public_ids: null,
    change_key: null,
    ...overrides,
  };
}

const emit = (body: PlanStateChangedPayload) =>
  onPlanStateChangedEvent(
    buildDomainEvent({ type: 'subscription.plan_state_changed', payload: body }),
  );

/**
 * feat-instagram-dm-sending ROUTE row R52 — routes-final § 8 BL8 (WC-38): billing's plan-state
 * change becomes one `plan-change` task per organization and change.
 */
describe('onPlanStateChangedEvent (WC-38)', () => {
  beforeEach(() => {
    enqueued.length = 0;
    failNext.value = false;
  });

  it('keys a check finding by its change key, so a repeat has the same job id (BL17)', async () => {
    await emit(payload({ change_key: '1764000000000' }));
    await emit(payload({ change_key: '1764000000000' }));
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toMatchObject({
      jobName: 'plan-change',
      jobId: 'plan-change-org_aaaaaaaaaaaaaaaaaaaaa-plan_ended-1764000000000',
      organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
      taskInput: { change: 'plan_ended', keptChannelAccountPublicIds: null },
    });
    expect(enqueued[1]?.jobId).toBe(enqueued[0]?.jobId);
  });

  it('gives every other change its own job, with the kept accounts (BL6)', async () => {
    const kept = ['cha_aaaaaaaaaaaaaaaaaaaaa'];
    await emit(payload({ change: 'moved_down', kept_channel_account_public_ids: kept }));
    await emit(payload({ change: 'moved_down', kept_channel_account_public_ids: kept }));
    expect(enqueued[0]?.jobId).not.toBe(enqueued[1]?.jobId);
    expect(String(enqueued[0]?.jobId)).not.toContain(':');
    expect(instagramPlanChangeTaskInputSchema.parse(enqueued[0]?.taskInput)).toEqual({
      change: 'moved_down',
      keptChannelAccountPublicIds: kept,
    });
  });

  it('logs a failed add and never throws (the backup puts it right)', async () => {
    failNext.value = true;
    await expect(emit(payload())).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it('keys the month wake by the organization and its month, never with a colon', () => {
    expect(
      instagramMonthWakeJobId({
        organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
        month: '2026-12_2026-12-01T05',
      }),
    ).toBe('month-wake-org_aaaaaaaaaaaaaaaaaaaaa-2026_12_2026_12_01t05');
  });
});
