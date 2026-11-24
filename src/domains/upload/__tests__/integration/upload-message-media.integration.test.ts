import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { injectAuthenticated } from '@/tests/helpers/test-http-inject.helper.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { generateTestToken } from '@/tests/helpers/test-auth.js';
import { createObjectStoragePortMock } from '@/tests/helpers/object-storage-mock.helper.js';
import { getDefaultS3ObjectStorageAdapter } from '@/infrastructure/storage/s3-adapter.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import {
  createMembership,
  createRoleWithPermissions,
  seedPermissions,
} from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { uploads } from '@/domains/upload/upload.schema.js';
import { UPLOAD_PERMISSIONS } from '@/domains/upload/upload.permissions.js';
import {
  MESSAGE_AUDIO_MAX_BYTES,
  MESSAGE_FILE_MAX_BYTES,
  MESSAGE_IMAGE_MAX_BYTES,
} from '@/domains/upload/upload.constants.js';

/** The leading bytes of a real `.m4a` — a 32-byte box whose type is `ftyp` (offset 4). */
const VOICE_NOTE_LEADING_BYTES = Buffer.from([
  0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
]);

/** A "voice note" that is really an HTML page. */
const FAKE_VOICE_NOTE_LEADING_BYTES = Buffer.from('<html><body>not audio</body></html>');

/**
 * Routes 140 and 150 with the `message-media` purpose (routes-final § 12 UPC4; AC-15.1, AC-15.2,
 * AC-15.5): each type at its cap and one byte over, webp refused, a member without `upload:manage`
 * refused (`missing_permission`), a member with it allowed, and a fake `.m4a` refused on confirm.
 */
describe('Upload — message files (integration)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { app: testApplication } = await createTestApp();
    app = testApplication;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A member of a new organization holding `permissionCodes`, with its organization token. */
  async function memberWith(permissionCodes: string[]) {
    await seedPermissions([UPLOAD_PERMISSIONS.UPLOAD_MANAGE]);
    const owner = await createTestUser();
    const organization = await createTestOrganization({ ownerUserId: owner.id });
    const member = await createTestUser();
    const role = await createRoleWithPermissions({
      organizationId: organization.id,
      permissionCodes,
    });
    await createMembership({ userId: member.id, organizationId: organization.id, roleId: role.id });
    const token = await generateTestToken({
      userId: member.public_id,
      organizationPublicId: organization.public_id,
    });
    return { organization, token };
  }

  function requestMessageFile(options: {
    token: string;
    organizationPublicId: string;
    contentType: string;
    fileName: string;
    fileSize: number;
  }) {
    return injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath('/uploads'),
      token: options.token,
      payload: {
        purpose: 'message-media',
        for: 'organization',
        organization_id: options.organizationPublicId,
        content_type: options.contentType,
        file_name: options.fileName,
        file_size: options.fileSize,
      },
    });
  }

  /** The first `errors[].field` of a refused answer. */
  function refusedField(body: string): string | undefined {
    return (JSON.parse(body) as { error: { errors?: { field: string }[] } }).error.errors?.[0]
      ?.field;
  }

  it('accepts each message type at its cap and refuses one byte over (AC-15.1)', async () => {
    const { organization, token } = await memberWith([UPLOAD_PERMISSIONS.UPLOAD_MANAGE]);
    const cases = [
      ['image/png', 'picture.png', MESSAGE_IMAGE_MAX_BYTES],
      ['image/jpeg', 'picture.jpg', MESSAGE_IMAGE_MAX_BYTES],
      ['audio/aac', 'voice.aac', MESSAGE_AUDIO_MAX_BYTES],
      ['audio/mp4', 'voice.m4a', MESSAGE_AUDIO_MAX_BYTES],
      ['audio/x-m4a', 'voice.m4a', MESSAGE_AUDIO_MAX_BYTES],
      ['audio/wav', 'voice.wav', MESSAGE_AUDIO_MAX_BYTES],
      ['application/pdf', 'menu.pdf', MESSAGE_FILE_MAX_BYTES],
    ] as const;
    for (const [contentType, fileName, cap] of cases) {
      const base = { token, organizationPublicId: organization.public_id, contentType, fileName };
      const atCap = await requestMessageFile({ ...base, fileSize: cap });
      expect(atCap.statusCode, `${contentType} at cap: ${atCap.body}`).toBe(200);
      expect((atCap.json() as { data: { id: string } }).data.id).toMatch(/^upl_/);

      const over = await requestMessageFile({ ...base, fileSize: cap + 1 });
      expect(over.statusCode, `${contentType} over cap: ${over.body}`).toBe(400);
      // Over the 25 MB ceiling the route schema refuses first (`body.file_size`); under it, over
      // the type's cap, the validator does (`file_size`).
      expect(refusedField(over.body)).toMatch(/^(body\.)?file_size$/);
    }
  });

  it('refuses webp and other types outside the message list (AC-15.1)', async () => {
    const { organization, token } = await memberWith([UPLOAD_PERMISSIONS.UPLOAD_MANAGE]);
    for (const [contentType, fileName] of [
      ['image/webp', 'picture.webp'],
      ['audio/ogg', 'voice.ogg'],
    ] as const) {
      const response = await requestMessageFile({
        token,
        organizationPublicId: organization.public_id,
        contentType,
        fileName,
        fileSize: 1024,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(refusedField(response.body)).toBe('content_type');
    }
  });

  it('refuses a member without upload:manage and allows one with it (AC-15.5)', async () => {
    // The named Viewer and Editor roles land at R28; here a role without the code stands in for
    // the Viewer and a role holding it for the Editor.
    const viewer = await memberWith([]);
    const refused = await requestMessageFile({
      token: viewer.token,
      organizationPublicId: viewer.organization.public_id,
      contentType: 'audio/mp4',
      fileName: 'voice.m4a',
      fileSize: 1024,
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((refused.json() as { error: { reason?: string } }).error.reason).toBe(
      'missing_permission',
    );

    const editor = await memberWith([UPLOAD_PERMISSIONS.UPLOAD_MANAGE]);
    const allowed = await requestMessageFile({
      token: editor.token,
      organizationPublicId: editor.organization.public_id,
      contentType: 'audio/mp4',
      fileName: 'voice.m4a',
      fileSize: 1024,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
  });

  /** Creates a `voice.m4a` message file and confirms it with `leadingBytes` as its stored bytes. */
  async function createAndConfirm(leadingBytes: Buffer) {
    const { organization, token } = await memberWith([UPLOAD_PERMISSIONS.UPLOAD_MANAGE]);
    const objectStorageMock = createObjectStoragePortMock({
      getObjectFirstBytes: vi
        .fn()
        .mockResolvedValue({ body: leadingBytes, contentType: 'audio/mp4', eTag: '"etag"' }),
    });
    const adapter = getDefaultS3ObjectStorageAdapter();
    vi.spyOn(adapter, 'verifyUploadedObject').mockImplementation(
      objectStorageMock.verifyUploadedObject,
    );
    vi.spyOn(adapter, 'getObjectFirstBytes').mockImplementation(
      objectStorageMock.getObjectFirstBytes,
    );
    vi.spyOn(adapter, 'copyObject').mockImplementation(objectStorageMock.copyObject);
    vi.spyOn(adapter, 'deleteObject').mockImplementation(objectStorageMock.deleteObject);

    const create = await requestMessageFile({
      token,
      organizationPublicId: organization.public_id,
      contentType: 'audio/mp4',
      fileName: 'voice.m4a',
      fileSize: 4096,
    });
    expect(create.statusCode, create.body).toBe(200);
    const uploadPublicId = (create.json() as { data: { id: string } }).data.id;
    const confirm = await injectAuthenticated(app, {
      method: 'POST',
      url: testApiPath(`/uploads/${uploadPublicId}/confirm`),
      token,
      payload: {},
    });
    const [row] = await getOperatorDatabase()
      .select()
      .from(uploads)
      .where(eq(uploads.public_id, uploadPublicId));
    return { confirm, row: row!, objectStorageMock };
  }

  it('refuses to confirm a fake .m4a and marks it FAILED (AC-15.2)', async () => {
    const { confirm, row, objectStorageMock } = await createAndConfirm(
      FAKE_VOICE_NOTE_LEADING_BYTES,
    );
    expect(confirm.statusCode, confirm.body).toBe(400);
    expect(refusedField(confirm.body)).toBe('file');
    expect(row.status).toBe('FAILED');
    expect(objectStorageMock.copyObject).not.toHaveBeenCalled();
  });

  it('confirms a real .m4a under the message-media key', async () => {
    const { confirm, row } = await createAndConfirm(VOICE_NOTE_LEADING_BYTES);
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(row.status).toBe('UPLOADED');
    expect(row.file_key).toMatch(/^message-media\/org_[a-z0-9]{21}\/[0-9a-f-]{36}\.m4a$/);
  });
});
