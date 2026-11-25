import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NotFoundError } from '@/shared/errors/index.js';
import type { InstagramAttachmentOutcome } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.types.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { instagramAttachmentUploadJobId } from '@/domains/app/sub-domains/instagram-sending/queues/instagram-attachment-upload.job.schema.js';
import { createInstagramAttachmentUploadTaskHandler } from '@/domains/app/sub-domains/instagram-sending/workers/instagram-attachment-upload.processor.js';

const ORGANIZATION = 'org_aaaaaaaaaaaaaaaaaaaaa';
const INPUT = {
  channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
  uploadPublicId: 'upl_aaaaaaaaaaaaaaaaaaaaa',
};

/** A ticket context that records slot use and a ticket put back. */
function fakeContext() {
  const returned: number[] = [];
  const context: InstagramSendTicketContext = {
    jobId: 'job-1',
    runInDatabaseSlot: vi.fn((callback) =>
      callback(),
    ) as InstagramSendTicketContext['runInDatabaseSlot'],
    returnTicket: async (delayMilliseconds) => {
      returned.push(delayMilliseconds);
      throw new Error('returned');
    },
  };
  return { context, returned };
}

function handlerAnswering(outcome: InstagramAttachmentOutcome | Error) {
  const uploadAttachments = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return new Map([[INPUT.uploadPublicId, outcome]]);
  });
  return {
    handler: createInstagramAttachmentUploadTaskHandler({
      attachmentService: { uploadAttachments },
    }),
    uploadAttachments,
  };
}

describe('attachment-upload task (WC-32, SN20 — ROUTE row R46, AC-15.4)', () => {
  it('is a Meta-calling task with one job per account and file', () => {
    const { handler } = handlerAnswering({ status: 'ready', attachmentId: '1', wasUploaded: true });
    expect(handler.callsMeta).toBe(true);
    expect(instagramAttachmentUploadJobId(INPUT)).toBe(
      `attachment-upload-${INPUT.channelAccountPublicId}-${INPUT.uploadPublicId}`,
    );
    expect(handler.inputSchema.safeParse({ ...INPUT, uploadPublicId: 'con_x' }).success).toBe(
      false,
    );
  });

  it('uploads the one file in a database slot, in the job scope', async () => {
    const { handler, uploadAttachments } = handlerAnswering({
      status: 'ready',
      attachmentId: '1789',
      wasUploaded: true,
    });
    const { context, returned } = fakeContext();
    await handler.run({ organizationPublicId: ORGANIZATION, taskInput: INPUT, context });
    expect(context.runInDatabaseSlot).toHaveBeenCalledTimes(1);
    expect(uploadAttachments).toHaveBeenCalledWith({
      scope: expect.objectContaining({ organizationPublicId: ORGANIZATION }),
      channelAccountPublicId: INPUT.channelAccountPublicId,
      uploadPublicIds: [INPUT.uploadPublicId],
    });
    expect(returned).toEqual([]);
  });

  it("puts the ticket back, no try used, until Meta's usage lets it go", async () => {
    const waitUntil = new Date(Date.now() + 120_000);
    const { handler } = handlerAnswering({ status: 'usage_wait', waitUntil });
    const { context, returned } = fakeContext();
    await expect(
      handler.run({ organizationPublicId: ORGANIZATION, taskInput: INPUT, context }),
    ).rejects.toThrow('returned');
    expect(returned[0]).toBeGreaterThan(100_000);
    expect(returned[0]).toBeLessThanOrEqual(120_000);
  });

  it('ends quietly for an unusable file or an account that is gone; other errors propagate', async () => {
    const { context } = fakeContext();
    await handlerAnswering({ status: 'unusable' }).handler.run({
      organizationPublicId: ORGANIZATION,
      taskInput: INPUT,
      context,
    });
    await handlerAnswering(
      new NotFoundError('Channel account').withReason('channel_account_not_found'),
    ).handler.run({ organizationPublicId: ORGANIZATION, taskInput: INPUT, context });
    await expect(
      handlerAnswering(new Error('database down')).handler.run({
        organizationPublicId: ORGANIZATION,
        taskInput: INPUT,
        context,
      }),
    ).rejects.toThrow('database down');
  });
});
