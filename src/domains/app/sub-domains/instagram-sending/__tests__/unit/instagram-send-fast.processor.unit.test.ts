import { type Job, UnrecoverableError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/infrastructure/queue/dlq/poison-job.util.js', () => ({
  parseJobDataOrDeadLetter: async ({ schema, job }: { schema: z.ZodType; job: Job }) => {
    const parsed = schema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('bullmq.invalid_job_payload');
    return parsed.data;
  },
}));

import { processInstagramSendFastTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-fast.processor.js';

/** A BullMQ job stand-in: its id, name, data and the move a ticket that goes back makes. */
function fakeJob({ name = 'job', data = {} }: { name?: string; data?: unknown } = {}) {
  return {
    id: 'ticket-1',
    name,
    data,
    moveToDelayed: vi.fn(async () => {}),
  } as unknown as Job & { moveToDelayed: ReturnType<typeof vi.fn> };
}

const allowed = { mayTakeTickets: vi.fn(async () => true) };

describe('Instagram fast-message tickets on instagram-send-fast (SN2 — ROUTE row R37)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a fast message with no work built yet is finished; with work it is sent through it', async () => {
    const jobData = {
      organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
      channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
      instagramMessagePublicId: 'igm_aaaaaaaaaaaaaaaaaaaaa',
      automationRunStartedAt: '2026-11-25T10:00:00.000Z',
      tries: 0,
    };
    await processInstagramSendFastTicket({
      job: fakeJob(),
      token: 'lock',
      jobData,
      services: { sendingGate: allowed, fastMessage: null },
    });
    expect(allowed.mayTakeTickets).not.toHaveBeenCalled();
    const sendFastMessage = vi.fn(async () => {});
    await processInstagramSendFastTicket({
      job: fakeJob(),
      token: 'lock',
      jobData,
      services: { sendingGate: allowed, fastMessage: { sendFastMessage } },
    });
    expect(sendFastMessage).toHaveBeenCalledWith({
      ticket: jobData,
      scope: expect.objectContaining({ organizationPublicId: jobData.organizationPublicId }),
      context: expect.objectContaining({ jobId: 'ticket-1' }),
    });
  });
});
