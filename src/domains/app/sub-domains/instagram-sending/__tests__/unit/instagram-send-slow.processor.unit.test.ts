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

import { processInstagramSendSlowTicket } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-send-slow.processor.js';

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
const refused = { mayTakeTickets: vi.fn(async () => false) };

const slowTicket = {
  organizationPublicId: 'org_aaaaaaaaaaaaaaaaaaaaa',
  channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
  lane: 'slow' as const,
  turnNumber: 3,
};

describe('Instagram lane-turn tickets on instagram-send-slow (SN2 — ROUTE row R37)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a lane turn with no work built yet is finished without asking the gate or touching a row', async () => {
    await processInstagramSendSlowTicket({
      job: fakeJob(),
      token: 'lock',
      jobData: slowTicket,
      services: { sendingGate: refused, laneTurn: null },
    });
    expect(refused.mayTakeTickets).not.toHaveBeenCalled();
  });

  it('hands a lane turn to its work with the ticket and a slot context', async () => {
    const workLaneTurn = vi.fn(async () => {});
    await processInstagramSendSlowTicket({
      job: fakeJob(),
      token: 'lock',
      jobData: slowTicket,
      services: { sendingGate: allowed, laneTurn: { workLaneTurn } },
    });
    expect(allowed.mayTakeTickets).toHaveBeenCalledTimes(1);
    expect(workLaneTurn).toHaveBeenCalledWith({
      ticket: slowTicket,
      scope: expect.objectContaining({ organizationPublicId: slowTicket.organizationPublicId }),
      context: {
        jobId: 'ticket-1',
        runInDatabaseSlot: expect.any(Function),
        returnTicket: expect.any(Function),
      },
    });
  });
});
