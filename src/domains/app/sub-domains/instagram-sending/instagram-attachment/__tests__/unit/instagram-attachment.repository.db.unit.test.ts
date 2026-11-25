import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { RequestScopedPostgresDatabase } from '@/infrastructure/database/contexts/database-context-runtime.js';
import {
  getPostgresConstraintName,
  getPostgresErrorCode,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type InstagramAttachmentKey,
  InstagramAttachmentRepository,
} from '@/domains/app/sub-domains/instagram-sending/instagram-attachment/instagram-attachment.repository.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const UPLOAD_PUBLIC_ID = 'upl_aaaaaaaaaaaaaaaaaaaaa';

/**
 * `app.instagram_attachments` against the database (routes-final § 6.C.3, SN20): the first write
 * keeps Meta's id and a second write of the same account and file keeps the first (one id per
 * account and file), another account of the organization has its own row, the delete forgets only
 * that row, and the CHECK refuses a malformed upload public id. Every statement runs in the
 * organization's job scope (`pnpm test:rls-role` safe).
 */
describe('InstagramAttachmentRepository (database)', () => {
  let organizationPublicId: string;
  let key: InstagramAttachmentKey;
  let sisterKey: InstagramAttachmentKey;

  function inUnit<T>(
    callback: (repository: InstagramAttachmentRepository) => Promise<T>,
  ): Promise<T> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId }),
      callback: (databaseHandle) =>
        callback(
          new InstagramAttachmentRepository(databaseHandle as RequestScopedPostgresDatabase),
        ),
    });
  }

  beforeEach(async () => {
    await cleanupDatabase();
    const organization = await createTestOrganization({
      ownerUserId: (await createTestUser({ email: 'attachment-repository@example.com' })).id,
    });
    organizationPublicId = organization.public_id;
    const account = await insertInstagramAccount({ organizationId: organization.id });
    const sister = await insertInstagramAccount({ organizationId: organization.id });
    key = {
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      uploadPublicId: UPLOAD_PUBLIC_ID,
    };
    sisterKey = { ...key, channelAccountId: sister.channel_account_id };
  });

  it('finds nothing for a file never uploaded, then the kept id after the first write', async () => {
    expect(await inUnit((repository) => repository.findByKey(key))).toBeNull();
    const inserted = await inUnit((repository) =>
      repository.insertIfMissing({ ...key, attachmentId: '185777777482101' }),
    );
    expect(inserted).toMatchObject({
      channel_account_id: key.channelAccountId,
      upload_public_id: UPLOAD_PUBLIC_ID,
      attachment_id: '185777777482101',
    });
    expect(await inUnit((repository) => repository.findByKey(key))).toMatchObject({
      id: inserted.id,
      attachment_id: '185777777482101',
    });
  });

  it('a second write of the same account and file keeps the first id', async () => {
    await inUnit((repository) =>
      repository.insertIfMissing({ ...key, attachmentId: '185777777482101' }),
    );
    const second = await inUnit((repository) =>
      repository.insertIfMissing({ ...key, attachmentId: '185777777482102' }),
    );
    expect(second.attachment_id).toBe('185777777482101');
  });

  it('another account keeps its own id, and the delete forgets only the one row', async () => {
    await inUnit((repository) =>
      repository.insertIfMissing({ ...key, attachmentId: '185777777482101' }),
    );
    await inUnit((repository) =>
      repository.insertIfMissing({ ...sisterKey, attachmentId: '185777777482109' }),
    );
    expect(await inUnit((repository) => repository.deleteByKey(key))).toBe(true);
    expect(await inUnit((repository) => repository.deleteByKey(key))).toBe(false);
    expect(await inUnit((repository) => repository.findByKey(key))).toBeNull();
    expect(await inUnit((repository) => repository.findByKey(sisterKey))).toMatchObject({
      attachment_id: '185777777482109',
    });
  });

  it('refuses a malformed upload public id (chk_instagram_attachments_upload_public_id)', async () => {
    let error: unknown;
    try {
      await inUnit((repository) =>
        repository.insertIfMissing({ ...key, uploadPublicId: 'not-an-upload', attachmentId: '1' }),
      );
    } catch (caught) {
      error = caught;
    }
    expect(getPostgresErrorCode(error)).toBe('23514');
    expect(getPostgresConstraintName(error)).toBe('chk_instagram_attachments_upload_public_id');
  });
});
