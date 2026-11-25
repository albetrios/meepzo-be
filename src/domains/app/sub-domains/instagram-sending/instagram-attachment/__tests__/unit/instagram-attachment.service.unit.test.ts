import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type OrganizationPrincipalDatabaseScope,
  PRINCIPAL_SCOPE,
} from '@/infrastructure/database/contexts/database-context.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import type { MetaUsageDecision } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import type { InstagramSendAccess } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';

const { repository } = vi.hoisted(() => ({
  repository: {
    findByKey: vi.fn(),
    insertIfMissing: vi.fn(),
    deleteByKey: vi.fn(),
  },
}));

vi.mock('@/shared/utils/infrastructure/logger.util.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/infrastructure/database/contexts/database-context.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    withAppDatabaseContext: vi.fn(
      async ({ callback }: { callback: (databaseHandle: unknown) => Promise<unknown> }) =>
        callback({}),
    ),
  };
});
vi.mock(
  '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.repository.js',
  () => ({
    InstagramAttachmentRepository: vi.fn(function construct() {
      return repository;
    }),
  }),
);

import { InstagramAttachmentService } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.service.js';
import type {
  InstagramAttachmentFilePort,
  InstagramAttachmentUploader,
  InstagramAttachmentUploadQueue,
} from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.types.js';

const ORGANIZATION_PUBLIC_ID = 'org_a1b2c3d4e5f6g7h8i9j0k';
const ACCOUNT_PUBLIC_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';
const UPLOAD_PUBLIC_ID = 'upl_aaaaaaaaaaaaaaaaaaaaa';
const scope: OrganizationPrincipalDatabaseScope = PRINCIPAL_SCOPE.JOB({
  organizationPublicId: ORGANIZATION_PUBLIC_ID,
});
const USABLE_FILE = {
  upload_public_id: UPLOAD_PUBLIC_ID,
  content_type: 'image/png',
  download_url: 'https://files.example.com/a.png',
};

function accessOf(overrides: Partial<InstagramSendAccess> = {}): InstagramSendAccess {
  return {
    channelAccount: { organizationId: 7, channelAccountId: 11 },
    channelAccountPublicId: ACCOUNT_PUBLIC_ID,
    channelConnection: { organizationId: 7, channelConnectionId: 3 },
    channelConnectionPublicId: 'chc_ccccccccccccccccccccc',
    clientBusinessId: '5550001',
    instagramUserId: '178411',
    encryptedAccessToken: 'ciphertext',
    isSendable: true,
    ...overrides,
  };
}

/**
 * Instagram's message files with the repository, the database unit, Meta and the file read faked
 * (routes-final § 6.C — SN20, SN21; AC-15.4): a kept id is reused without a call, an unusable file or
 * an unsendable account never reaches Meta, the connection's `wait` holds the upload, Meta's refusal
 * is an outcome while any other error propagates, two callers share one upload, the list stops at a
 * wait, and the upload ask is a no-op until R46 wires its queue. The database side is
 * `instagram-attachment.service.db.unit.test.ts` and `instagram-attachment.repository.db.unit.test.ts`.
 */
describe('InstagramAttachmentService', () => {
  let file: Awaited<ReturnType<InstagramAttachmentFilePort['findUsableMessageFile']>>;
  let pace: MetaUsageDecision;
  let upload: ReturnType<typeof vi.fn<InstagramAttachmentUploader>>;
  let sendAccessService: {
    readSendAccess: ReturnType<typeof vi.fn>;
    readSendPace: ReturnType<typeof vi.fn>;
    buildUsageRecorder: ReturnType<typeof vi.fn>;
  };

  function build(uploadQueue?: InstagramAttachmentUploadQueue): InstagramAttachmentService {
    return new InstagramAttachmentService({
      sendAccessService: sendAccessService as never,
      filePort: { findUsableMessageFile: vi.fn(async () => file) },
      uploadAttachment: upload,
      uploadQueue,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    file = USABLE_FILE;
    pace = { pace: 'normal', waitUntil: null };
    upload = vi.fn<InstagramAttachmentUploader>(async () => ({ attachmentId: 'meta-1' }));
    sendAccessService = {
      readSendAccess: vi.fn(async () => accessOf()),
      readSendPace: vi.fn(async () => pace),
      buildUsageRecorder: vi.fn(() => vi.fn()),
    };
    repository.findByKey.mockResolvedValue(null);
    repository.insertIfMissing.mockImplementation(async ({ attachmentId }) => ({
      attachment_id: attachmentId,
    }));
  });

  it('reuses the kept Meta id without reading the file or calling Meta', async () => {
    repository.findByKey.mockResolvedValue({ attachment_id: 'kept-1' });
    const outcome = await build().findOrUploadAttachment({
      scope,
      access: accessOf(),
      uploadPublicId: UPLOAD_PUBLIC_ID,
    });
    expect(outcome).toEqual({ status: 'ready', attachmentId: 'kept-1', wasUploaded: false });
    expect(repository.findByKey).toHaveBeenCalledWith({
      organizationId: 7,
      channelAccountId: 11,
      uploadPublicId: UPLOAD_PUBLIC_ID,
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads a new file once with the usage recorder and keeps its id', async () => {
    const outcome = await build().findOrUploadAttachment({
      scope,
      access: accessOf(),
      uploadPublicId: UPLOAD_PUBLIC_ID,
      requestId: 'request-1',
    });
    expect(outcome).toEqual({ status: 'ready', attachmentId: 'meta-1', wasUploaded: true });
    expect(upload).toHaveBeenCalledWith({
      encryptedAccessToken: 'ciphertext',
      instagramUserId: '178411',
      type: 'image',
      url: USABLE_FILE.download_url,
      requestId: 'request-1',
      recordUsage: expect.any(Function),
    });
    expect(repository.insertIfMissing).toHaveBeenCalledWith({
      organizationId: 7,
      channelAccountId: 11,
      uploadPublicId: UPLOAD_PUBLIC_ID,
      attachmentId: 'meta-1',
    });
  });

  it('a missing file or a type Instagram does not take is unusable and never uploaded', async () => {
    file = null;
    const service = build();
    const input = { scope, access: accessOf(), uploadPublicId: UPLOAD_PUBLIC_ID };
    expect(await service.findOrUploadAttachment(input)).toEqual({ status: 'unusable' });
    file = { ...USABLE_FILE, content_type: 'application/x-msdownload' };
    expect(await service.findOrUploadAttachment(input)).toEqual({ status: 'unusable' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('an account that is not sendable, or has no token, makes no call', async () => {
    const service = build();
    for (const access of [
      accessOf({ isSendable: false }),
      accessOf({ encryptedAccessToken: null }),
    ]) {
      expect(
        await service.findOrUploadAttachment({ scope, access, uploadPublicId: UPLOAD_PUBLIC_ID }),
      ).toEqual({ status: 'not_sendable' });
    }
    expect(sendAccessService.readSendPace).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("the connection's wait holds the upload (SN23)", async () => {
    const waitUntil = new Date('2026-11-25T12:00:00.000Z');
    pace = { pace: 'wait', waitUntil };
    expect(
      await build().findOrUploadAttachment({
        scope,
        access: accessOf(),
        uploadPublicId: UPLOAD_PUBLIC_ID,
      }),
    ).toEqual({ status: 'usage_wait', waitUntil });
    expect(upload).not.toHaveBeenCalled();
  });

  it("Meta's refusal is an outcome and keeps no row; any other error propagates", async () => {
    const refusal = new MetaGraphApiError({
      errorClass: 'refused',
      category: 'unknown',
      fallbackMessage: 'the file could not be fetched',
    });
    upload.mockRejectedValueOnce(refusal);
    const service = build();
    const input = { scope, access: accessOf(), uploadPublicId: UPLOAD_PUBLIC_ID };
    expect(await service.findOrUploadAttachment(input)).toEqual({
      status: 'upload_failed',
      error: refusal,
    });
    expect(repository.insertIfMissing).not.toHaveBeenCalled();
    upload.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(service.findOrUploadAttachment(input)).rejects.toThrow('socket hang up');
  });

  it('two callers asking for the same account and file at once share one upload', async () => {
    let finish: (value: { attachmentId: string }) => void = () => {};
    upload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = build();
    const input = { scope, access: accessOf(), uploadPublicId: UPLOAD_PUBLIC_ID };
    const first = service.findOrUploadAttachment(input);
    const second = service.findOrUploadAttachment(input);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    finish({ attachmentId: 'meta-shared' });
    expect(await first).toEqual(await second);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('forgets a file Meta says is gone', async () => {
    repository.deleteByKey.mockResolvedValue(true);
    const key = { organizationId: 7, channelAccountId: 11, uploadPublicId: UPLOAD_PUBLIC_ID };
    expect(await build().forgetAttachment({ scope, key })).toBe(true);
    expect(repository.deleteByKey).toHaveBeenCalledWith(key);
  });

  it('uploads a list once per file and stops the rest at a wait', async () => {
    const service = build();
    const outcomes = await service.uploadAttachments({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      uploadPublicIds: [UPLOAD_PUBLIC_ID, UPLOAD_PUBLIC_ID, 'upl_bbbbbbbbbbbbbbbbbbbbb'],
    });
    expect(sendAccessService.readSendAccess).toHaveBeenCalledTimes(1);
    expect([...outcomes.keys()]).toEqual([UPLOAD_PUBLIC_ID, 'upl_bbbbbbbbbbbbbbbbbbbbb']);

    pace = { pace: 'wait', waitUntil: null };
    upload.mockClear();
    const held = await service.uploadAttachments({
      scope,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      uploadPublicIds: ['upl_ccccccccccccccccccccc', 'upl_ddddddddddddddddddddd'],
    });
    expect([...held.values()]).toEqual([{ status: 'usage_wait', waitUntil: null }]);
    expect(upload).not.toHaveBeenCalled();
  });

  it('asks the task queue for uploads only once it is wired and there is a file', async () => {
    const input = {
      organizationPublicId: ORGANIZATION_PUBLIC_ID,
      channelAccountPublicId: ACCOUNT_PUBLIC_ID,
      uploadPublicIds: [UPLOAD_PUBLIC_ID],
    };
    expect(await build().requestAttachmentUploads(input)).toBe(false);
    const uploadQueue = { enqueueAttachmentUpload: vi.fn(async () => {}) };
    const service = build(uploadQueue);
    expect(await service.requestAttachmentUploads({ ...input, uploadPublicIds: [] })).toBe(false);
    expect(await service.requestAttachmentUploads(input)).toBe(true);
    expect(uploadQueue.enqueueAttachmentUpload).toHaveBeenCalledWith(input);
  });
});
