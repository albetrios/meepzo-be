import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { UserService } from '@/domains/user/user.service.js';
import { UploadRepository } from '@/domains/upload/upload.repository.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import { UPLOAD_STATUS } from '@/domains/upload/upload.constants.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { InstagramAttachmentService } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.service.js';
import { instagram_attachments } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.schema.js';
import type { InstagramAttachmentUploader } from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.types.js';
import type { InstagramSendAccess } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import type { MetaUsageDecision } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type TestOrganization = Awaited<ReturnType<typeof createTestOrganization>>;
type TestAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;

/**
 * Instagram's message files against the database (feat-instagram-dm-sending routes-final § 6.C —
 * SN20, SN21, SNC15; AC-15.4): a file used by several messages of one account is uploaded to Meta
 * once and reused; another account uploads its own; a file that is not a confirmed message file of
 * this organization is never uploaded and never sent; a held connection or a gone account makes no
 * call; Meta's "gone" forgets the row. The file read is the real upload service (P25); Meta is a
 * recorded fake (the wire is `meta-graph.contract.test.ts`). Every unit runs in the organization's
 * job scope (`pnpm test:rls-role` safe).
 */
describe('InstagramAttachmentService (database)', () => {
  const objectStorage = createObjectStoragePortMock();
  const organizationsByPublicId = new Map<string, TestOrganization>();
  const uploadService = new UploadService(
    new UploadRepository(),
    {} as UserService,
    {
      findOrganizationByPublicId: async (publicId: string) =>
        organizationsByPublicId.get(publicId) ?? null,
    } as unknown as OrganizationService,
    objectStorage,
  );

  let ownerId: number;
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;
  let account: TestAccount;
  let sisterAccount: TestAccount;
  let pace: MetaUsageDecision;
  let uploadCalls: Array<Parameters<InstagramAttachmentUploader>[0]>;
  let uploadAnswer: () => Promise<{ attachmentId: string }>;
  let service: InstagramAttachmentService;

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  function accessOf(
    target: TestAccount,
    overrides: Partial<InstagramSendAccess> = {},
  ): InstagramSendAccess {
    return {
      channelAccount: {
        organizationId: organization.id,
        channelAccountId: target.channel_account_id,
      },
      channelAccountPublicId: target.public_id,
      channelConnection: { organizationId: organization.id, channelConnectionId: 1 },
      channelConnectionPublicId: 'chc_ccccccccccccccccccccc',
      clientBusinessId: '5550001',
      instagramUserId: `1784${target.channel_account_id}`,
      encryptedAccessToken: 'ciphertext',
      isSendable: true,
      ...overrides,
    };
  }

  async function insertUpload(options: {
    owner: TestOrganization;
    keyPrefix: string;
    status: string;
    mimeType?: string;
  }) {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: options.owner.public_id }),
      callback: () =>
        new UploadRepository().create({
          user_id: ownerId,
          organization_id: options.owner.id,
          file_name: 'photo.png',
          file_key: `${options.keyPrefix}/${options.owner.public_id}/photo.png`,
          mime_type: options.mimeType ?? 'image/png',
          file_size: 4096,
          storage_provider: 's3',
          bucket: 'test-bucket',
          status: options.status,
        }),
    });
  }

  async function confirmedMessageFile() {
    return insertUpload({
      owner: organization,
      keyPrefix: 'message-media',
      status: UPLOAD_STATUS.UPLOADED,
    });
  }

  async function readAttachmentRows() {
    return getOperatorDatabase()
      .select()
      .from(instagram_attachments)
      .where(eq(instagram_attachments.organization_id, organization.id));
  }

  beforeEach(async () => {
    await cleanupDatabase();
    organizationsByPublicId.clear();
    const owner = await createTestUser({ email: 'attachment-owner@example.com' });
    ownerId = owner.id;
    organization = await createTestOrganization({ ownerUserId: owner.id });
    otherOrganization = await createTestOrganization({
      ownerUserId: (await createTestUser({ email: 'attachment-other@example.com' })).id,
    });
    organizationsByPublicId.set(organization.public_id, organization);
    organizationsByPublicId.set(otherOrganization.public_id, otherOrganization);
    account = await insertInstagramAccount({ organizationId: organization.id });
    sisterAccount = await insertInstagramAccount({ organizationId: organization.id });
    pace = { pace: 'normal', waitUntil: null };
    uploadCalls = [];
    let attachmentNumber = 0;
    uploadAnswer = async () => {
      attachmentNumber += 1;
      return { attachmentId: `18577777748210${attachmentNumber}` };
    };
    service = new InstagramAttachmentService({
      sendAccessService: {
        readSendAccess: async ({ channelAccountPublicId }) =>
          accessOf(channelAccountPublicId === account.public_id ? account : sisterAccount),
        readSendPace: async () => pace,
        buildUsageRecorder: () => undefined,
      },
      filePort: uploadService,
      uploadAttachment: async (input) => {
        uploadCalls.push(input);
        return uploadAnswer();
      },
    });
  });

  describe('one upload per account and file (AC-15.4)', () => {
    it('uploads a file once for the first message and reuses its id for every later one', async () => {
      const file = await confirmedMessageFile();

      const first = await service.findOrUploadAttachment({
        scope: scope(),
        access: accessOf(account),
        uploadPublicId: file.public_id,
      });
      const second = await service.findOrUploadAttachment({
        scope: scope(),
        access: accessOf(account),
        uploadPublicId: file.public_id,
      });

      expect(first).toEqual({
        status: 'ready',
        attachmentId: expect.any(String),
        wasUploaded: true,
      });
      expect(second).toEqual({
        status: 'ready',
        attachmentId: (first as { attachmentId: string }).attachmentId,
        wasUploaded: false,
      });
      expect(uploadCalls).toHaveLength(1);
      expect(uploadCalls[0]).toMatchObject({
        instagramUserId: accessOf(account).instagramUserId,
        type: 'image',
        url: expect.any(String),
      });
      expect(await readAttachmentRows()).toEqual([
        expect.objectContaining({
          channel_account_id: account.channel_account_id,
          upload_public_id: file.public_id,
          attachment_id: (first as { attachmentId: string }).attachmentId,
        }),
      ]);
    });

    it('shares one upload between two messages of the account sent at the same moment', async () => {
      const file = await confirmedMessageFile();
      const outcomes = await Promise.all(
        [1, 2, 3].map(() =>
          service.findOrUploadAttachment({
            scope: scope(),
            access: accessOf(account),
            uploadPublicId: file.public_id,
          }),
        ),
      );
      expect(uploadCalls).toHaveLength(1);
      expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(1);
      expect(await readAttachmentRows()).toHaveLength(1);
    });

    it("uploads the same file again for the sister account — Meta's ids are per account", async () => {
      const file = await confirmedMessageFile();
      await service.findOrUploadAttachment({
        scope: scope(),
        access: accessOf(account),
        uploadPublicId: file.public_id,
      });
      await service.findOrUploadAttachment({
        scope: scope(),
        access: accessOf(sisterAccount),
        uploadPublicId: file.public_id,
      });
      expect(uploadCalls.map((call) => call.instagramUserId)).toEqual([
        accessOf(account).instagramUserId,
        accessOf(sisterAccount).instagramUserId,
      ]);
      expect(await readAttachmentRows()).toHaveLength(2);
    });

    it('keeps the first id when another server wrote one between the look-up and the write', async () => {
      const file = await confirmedMessageFile();
      uploadAnswer = async () => {
        // Another server's sender of the same file finished first.
        await getOperatorDatabase().insert(instagram_attachments).values({
          organization_id: organization.id,
          channel_account_id: account.channel_account_id,
          upload_public_id: file.public_id,
          attachment_id: 'kept-by-the-other-server',
        });
        return { attachmentId: 'ours-not-kept' };
      };
      const outcome = await service.findOrUploadAttachment({
        scope: scope(),
        access: accessOf(account),
        uploadPublicId: file.public_id,
      });
      expect(outcome).toMatchObject({ status: 'ready', attachmentId: 'kept-by-the-other-server' });
      expect(await readAttachmentRows()).toHaveLength(1);
    });
  });

  describe('only a confirmed message file of this organization is ever sent (SN21, P25)', () => {
    it('never uploads a pending, a failed, a wrong-purpose or another organization’s upload', async () => {
      const uploads = [
        await insertUpload({
          owner: organization,
          keyPrefix: 'pending/message-media',
          status: UPLOAD_STATUS.PENDING,
        }),
        await insertUpload({
          owner: organization,
          keyPrefix: 'message-media',
          status: UPLOAD_STATUS.FAILED,
        }),
        await insertUpload({
          owner: organization,
          keyPrefix: 'organization-files',
          status: UPLOAD_STATUS.UPLOADED,
          mimeType: 'application/pdf',
        }),
        await insertUpload({
          owner: otherOrganization,
          keyPrefix: 'message-media',
          status: UPLOAD_STATUS.UPLOADED,
        }),
      ];
      for (const upload of uploads) {
        expect(
          await service.findOrUploadAttachment({
            scope: scope(),
            access: accessOf(account),
            uploadPublicId: upload.public_id,
          }),
        ).toEqual({ status: 'unusable' });
      }
      expect(uploadCalls).toEqual([]);
      expect(await readAttachmentRows()).toEqual([]);
    });
  });

  describe('no Meta call when the account may not call', () => {
    it('answers not_sendable for a broken connection and usage_wait at 95 % of Meta’s usage (SN23)', async () => {
      const file = await confirmedMessageFile();
      expect(
        await service.findOrUploadAttachment({
          scope: scope(),
          access: accessOf(account, { isSendable: false }),
          uploadPublicId: file.public_id,
        }),
      ).toEqual({ status: 'not_sendable' });

      const waitUntil = new Date(Date.now() + 15 * 60 * 1000);
      pace = { pace: 'wait', waitUntil };
      expect(
        await service.findOrUploadAttachment({
          scope: scope(),
          access: accessOf(account),
          uploadPublicId: file.public_id,
        }),
      ).toEqual({ status: 'usage_wait', waitUntil });
      expect(uploadCalls).toEqual([]);
      expect(await readAttachmentRows()).toEqual([]);
    });
  });

  describe("Meta's refusals and a file Meta says is gone (SN20)", () => {
    it('answers upload_failed with Meta’s error and keeps nothing; a forgotten file goes up again', async () => {
      const file = await confirmedMessageFile();
      const refusal = new MetaGraphApiError({
        errorClass: 'refused',
        category: 'unknown',
        fallbackMessage: 'the file could not be fetched',
      });
      uploadAnswer = async () => {
        throw refusal;
      };
      expect(
        await service.findOrUploadAttachment({
          scope: scope(),
          access: accessOf(account),
          uploadPublicId: file.public_id,
        }),
      ).toEqual({ status: 'upload_failed', error: refusal });
      expect(await readAttachmentRows()).toEqual([]);

      uploadAnswer = async () => ({ attachmentId: 'first-id' });
      await service.findOrUploadAttachment({
        scope: scope(),
        access: accessOf(account),
        uploadPublicId: file.public_id,
      });
      expect(
        await service.forgetAttachment({
          scope: scope(),
          key: {
            organizationId: organization.id,
            channelAccountId: account.channel_account_id,
            uploadPublicId: file.public_id,
          },
        }),
      ).toBe(true);
      uploadAnswer = async () => ({ attachmentId: 'second-id' });
      expect(
        await service.findOrUploadAttachment({
          scope: scope(),
          access: accessOf(account),
          uploadPublicId: file.public_id,
        }),
      ).toEqual({ status: 'ready', attachmentId: 'second-id', wasUploaded: true });
      expect(uploadCalls).toHaveLength(3);
    });
  });

  describe('the attachment-upload task body (WC-32, wired by R46)', () => {
    it('uploads each named file once for the account and answers each outcome', async () => {
      const photo = await confirmedMessageFile();
      const pending = await insertUpload({
        owner: organization,
        keyPrefix: 'pending/message-media',
        status: UPLOAD_STATUS.PENDING,
      });
      const outcomes = await service.uploadAttachments({
        scope: scope(),
        channelAccountPublicId: account.public_id,
        uploadPublicIds: [photo.public_id, photo.public_id, pending.public_id],
      });
      expect(outcomes.get(photo.public_id)).toMatchObject({ status: 'ready', wasUploaded: true });
      expect(outcomes.get(pending.public_id)).toEqual({ status: 'unusable' });
      expect(uploadCalls).toHaveLength(1);
      // Without the task queue (R46), nothing is queued: files go up at their first send.
      expect(
        await service.requestAttachmentUploads({
          organizationPublicId: organization.public_id,
          channelAccountPublicId: account.public_id,
          uploadPublicIds: [photo.public_id],
        }),
      ).toBe(false);
    });
  });
});
