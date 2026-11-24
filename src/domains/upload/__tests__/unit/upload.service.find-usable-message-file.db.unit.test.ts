import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { UploadRepository } from '@/domains/upload/upload.repository.js';
import { UploadService } from '@/domains/upload/upload.service.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { PRESIGNED_URL_EXPIRY_SECONDS, UPLOAD_STATUS } from '@/domains/upload/upload.constants.js';

type TestOrganization = Awaited<ReturnType<typeof createTestOrganization>>;

/**
 * `UploadService.findUsableMessageFile` — the one read the automation go-live check (R13) and the
 * Instagram attachment task (R20) make (routes-final § 12 UP5, UPC3). Only this organization's
 * confirmed, live `message-media` upload is usable; everything else reads as `null`.
 */
describe('UploadService.findUsableMessageFile (database)', () => {
  const repository = new UploadRepository();
  const objectStorage = createObjectStoragePortMock();
  const organizationsByPublicId = new Map<string, TestOrganization>();
  const organizationService = {
    findOrganizationByPublicId: async (publicId: string) =>
      organizationsByPublicId.get(publicId) ?? null,
  } as unknown as OrganizationService;
  const service = new UploadService(
    repository,
    {} as UserService,
    organizationService,
    objectStorage,
  );

  let ownerId: number;
  let organization: TestOrganization;
  let otherOrganization: TestOrganization;

  beforeEach(async () => {
    await cleanupDatabase();
    organizationsByPublicId.clear();
    const owner = await createTestUser({ email: 'message-file-owner@example.com' });
    const otherOwner = await createTestUser({ email: 'message-file-other@example.com' });
    ownerId = owner.id;
    organization = await createTestOrganization({ ownerUserId: owner.id });
    otherOrganization = await createTestOrganization({ ownerUserId: otherOwner.id });
    organizationsByPublicId.set(organization.public_id, organization);
    organizationsByPublicId.set(otherOrganization.public_id, otherOrganization);
  });

  async function insertUpload(options: {
    owner: TestOrganization;
    keyPrefix: string;
    status: string;
    mimeType?: string;
  }) {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: options.owner.public_id }),
      callback: () =>
        repository.create({
          user_id: ownerId,
          organization_id: options.owner.id,
          file_name: 'voice.m4a',
          file_key: `${options.keyPrefix}/${options.owner.public_id}/file.m4a`,
          mime_type: options.mimeType ?? 'audio/mp4',
          file_size: 2048,
          storage_provider: 's3',
          bucket: 'test-bucket',
          status: options.status,
        }),
    });
  }

  function read(uploadPublicId: string) {
    return service.findUsableMessageFile({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
      uploadPublicId,
    });
  }

  it('returns the confirmed message file with a presigned download link', async () => {
    const row = await insertUpload({
      owner: organization,
      keyPrefix: 'message-media',
      status: UPLOAD_STATUS.UPLOADED,
    });

    const file = await read(row.public_id);

    expect(file).toEqual({
      upload_public_id: row.public_id,
      content_type: 'audio/mp4',
      file_size: 2048,
      download_url: expect.any(String),
    });
    expect(objectStorage.createPresignedDownloadUrl).toHaveBeenCalledWith({
      key: row.file_key,
      expiresInSeconds: PRESIGNED_URL_EXPIRY_SECONDS,
      fileName: 'voice.m4a',
    });
  });

  it("returns null for another organization's message file", async () => {
    const row = await insertUpload({
      owner: otherOrganization,
      keyPrefix: 'message-media',
      status: UPLOAD_STATUS.UPLOADED,
    });
    expect(await read(row.public_id)).toBeNull();
  });

  it('returns null for an upload of another purpose', async () => {
    const row = await insertUpload({
      owner: organization,
      keyPrefix: 'organization-files',
      status: UPLOAD_STATUS.UPLOADED,
      mimeType: 'application/pdf',
    });
    expect(await read(row.public_id)).toBeNull();
  });

  it('returns null for a pending or a failed message file', async () => {
    const pending = await insertUpload({
      owner: organization,
      keyPrefix: 'pending/message-media',
      status: UPLOAD_STATUS.PENDING,
    });
    const failed = await insertUpload({
      owner: organization,
      keyPrefix: 'message-media',
      status: UPLOAD_STATUS.FAILED,
    });
    expect(await read(pending.public_id)).toBeNull();
    expect(await read(failed.public_id)).toBeNull();
  });

  it('returns null for a deleted message file and for an unknown id', async () => {
    const row = await insertUpload({
      owner: organization,
      keyPrefix: 'message-media',
      status: UPLOAD_STATUS.UPLOADED,
    });
    await withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id }),
      callback: () => repository.softDeleteById(row.id),
    });
    expect(await read(row.public_id)).toBeNull();
    expect(await read('upl_aaaaaaaaaaaaaaaaaaaaa')).toBeNull();
  });
});
