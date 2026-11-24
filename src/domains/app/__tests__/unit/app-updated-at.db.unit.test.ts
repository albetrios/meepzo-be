import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildInstagramPickValues } from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { ChannelAccountRepository } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import type { AutomationMergedFields } from '@/domains/app/sub-domains/automation/automation.types.js';
import {
  insertAutomation,
  type AutomationFixtureRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { AutomationCommentLogRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.repository.js';
import { AutomationRunRepository } from '@/domains/app/sub-domains/automation/automation-run/automation-run.repository.js';
import {
  insertAutomationCommentLog,
  insertAutomationRun,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import {
  insertContact,
  insertInstagramAccount,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { InstagramAccountRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import { ChannelConnectionTokenRepository } from '@/domains/app/sub-domains/channel-connection/channel-connection-token.repository.js';
import { InstagramAccountSettingsRepository } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramMediaRepository } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * `updated_at` of the app tables against `chk_<table>_updated` (`updated_at >= created_at`, D53.7):
 * Postgres `now()` is the time a transaction began, and a transaction that began before another
 * one inserted a row still sees and changes that row (READ COMMITTED) — a plain `now()` would then
 * lie before the row's `created_at` and refuse the change (23514), rolling a delete, a disconnect or
 * an erase back. Every test below changes a row another transaction inserted after this one began,
 * in the organization's own context, so the suite also holds under `pnpm test:rls-role`.
 */

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;

type TestOrganization = { id: number; public_id: string };

describe('app tables: updated_at when the row was created after this transaction began', () => {
  let organization: TestOrganization;
  let account: { id: number; public_id: string };

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
  });

  /**
   * Opens the organization's unit of work, then lets `insert` write through another connection, then
   * runs `change` in the unit opened first.
   */
  function changeAfterInsert<Row, Result>({
    insert,
    change,
  }: {
    insert: () => Promise<Row>;
    change: (row: Row) => Promise<Result>;
  }): Promise<Result> {
    return withAppDatabaseContext({
      scope: PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id }),
      callback: async () => change(await insert()),
    });
  }

  /** Whether every row of the organization's table still satisfies `updated_at >= created_at`. */
  function expectNotBeforeCreation(row: { created_at: Date; updated_at: Date } | null): void {
    expect(row).not.toBeNull();
    expect(row!.updated_at.getTime()).toBeGreaterThanOrEqual(row!.created_at.getTime());
  }

  describe('automations', () => {
    const repository = new AutomationRepository();
    const insertNew = (overrides: Partial<AutomationFixtureRow> = {}) =>
      insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        status: 'live',
        ...overrides,
      });
    const waitingForNextPost = (endsAt: Date): Partial<AutomationFixtureRow> => ({
      target_scope: 'next',
      next_post_status: 'waiting',
      next_post_starts_at: new Date(endsAt.getTime() - 2 * DAY_MILLISECONDS),
      next_post_ends_at: endsAt,
    });

    it('edits one', async () => {
      const row = await changeAfterInsert({
        insert: () => insertNew(),
        change: (automation) =>
          repository.update({
            organizationId: organization.id,
            automationId: automation.id,
            fields: {
              ...(automation as unknown as AutomationMergedFields),
              name: 'Edited automation',
            },
            updatedByUserId: null,
          }),
      });
      expectNotBeforeCreation(row);
    });

    it('deletes one', async () => {
      const row = await changeAfterInsert({
        insert: () => insertNew(),
        change: (automation) =>
          repository.softDelete({
            organizationId: organization.id,
            automationId: automation.id,
            reason: 'mistake',
            note: null,
            updatedByUserId: null,
          }),
      });
      expectNotBeforeCreation(row);
    });

    it('links a "next post" one', async () => {
      const linked = await changeAfterInsert({
        insert: () => insertNew(waitingForNextPost(new Date(Date.now() + DAY_MILLISECONDS))),
        change: () =>
          repository.linkNextPost({
            organizationId: organization.id,
            instagramAccountPublicId: account.public_id,
            instagramMediaId: '18030000000000001',
            publishedAt: new Date(),
          }),
      });
      expect(linked).toHaveLength(1);
    });

    it('expires a "next post" one', async () => {
      const expired = await changeAfterInsert({
        insert: () => insertNew(waitingForNextPost(new Date(Date.now() - DAY_MILLISECONDS))),
        change: (automation) =>
          repository.expireNextPostWindows({
            organizationId: organization.id,
            automationIds: [automation.id],
            endedBefore: new Date(),
          }),
      });
      expect(expired).toBe(1);
    });
  });

  describe('automation runs and comment logs', () => {
    const runRepository = new AutomationRunRepository();
    const commentLogRepository = new AutomationCommentLogRepository();

    async function insertParents() {
      const automation = await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        status: 'live',
      });
      const contact = await insertContact({
        organizationId: organization.id,
        instagramAccountId: account.id,
      });
      return { automation, contact };
    }

    async function insertRunAndLog() {
      const { automation, contact } = await insertParents();
      const run = await insertAutomationRun({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
      });
      const log = await insertAutomationCommentLog({
        organizationId: organization.id,
        automationId: automation.id,
        contactId: contact.id,
        automation_run_id: run.id,
      });
      return { automation, contact, run, log };
    }

    it('writes a step of one', async () => {
      const row = await changeAfterInsert({
        insert: insertRunAndLog,
        change: ({ run }) =>
          runRepository.update({
            organizationId: organization.id,
            runId: run.id,
            changes: { queued_automations: [] },
          }),
      });
      expectNotBeforeCreation(row);
    });

    it('cancels the open runs of an automation and marks their logs', async () => {
      const { runIds, logCount } = await changeAfterInsert({
        insert: insertRunAndLog,
        change: async ({ automation }) => {
          const runIds = await runRepository.cancelOpenRunsOfAutomation({
            organizationId: organization.id,
            automationId: automation.id,
          });
          const logCount = await commentLogRepository.markRunsCancelled({
            organizationId: organization.id,
            runIds,
          });
          return { runIds, logCount };
        },
      });
      expect(runIds).toHaveLength(1);
      expect(logCount).toBe(1);
    });

    it('erases a contact’s copies from both', async () => {
      const counts = await changeAfterInsert({
        insert: insertRunAndLog,
        change: async ({ contact }) => ({
          runs: await runRepository.eraseContactCopies({
            organizationId: organization.id,
            contactId: contact.id,
          }),
          logs: await commentLogRepository.eraseContactCopies({
            organizationId: organization.id,
            contactId: contact.id,
          }),
        }),
      });
      expect(counts).toEqual({ runs: 1, logs: 1 });
    });

    it('writes a step of a comment log', async () => {
      const row = await changeAfterInsert({
        insert: insertRunAndLog,
        change: ({ log }) =>
          commentLogRepository.update({
            organizationId: organization.id,
            commentLogId: log.id,
            changes: { overall_status: 'completed' },
          }),
      });
      expectNotBeforeCreation(row);
    });
  });

  describe('contacts', () => {
    const repository = new ContactRepository();
    const insertNew = () =>
      insertContact({ organizationId: organization.id, instagramAccountId: account.id });

    it('touches one again', async () => {
      const { contact, isInserted } = await changeAfterInsert({
        insert: insertNew,
        change: (inserted) =>
          repository.upsertInteraction({
            organizationId: organization.id,
            instagramAccountId: account.id,
            instagramUserId: inserted.instagram_user_id as string,
            username: 'jordan.lee',
            occurredAt: new Date(),
            isDirectMessage: true,
          }),
      });
      expect(isInserted).toBe(false);
      expectNotBeforeCreation(contact);
    });

    it('saves a collected email', async () => {
      const row = await changeAfterInsert({
        insert: insertNew,
        change: (contact) =>
          repository.recordEmail({
            organizationId: organization.id,
            contactId: contact.id,
            email: 'jordan@example.com',
            collectedAt: new Date(),
          }),
      });
      expectNotBeforeCreation(row);
    });

    it('erases one', async () => {
      const row = await changeAfterInsert({
        insert: insertNew,
        change: (contact) =>
          repository.erase({ organizationId: organization.id, contactId: contact.id }),
      });
      expectNotBeforeCreation(row);
    });
  });

  describe('Instagram accounts, connection tokens, settings and posts', () => {
    const accountRepository = new InstagramAccountRepository();
    const tokenRepository = new ChannelConnectionTokenRepository();
    const settingsRepository = new InstagramAccountSettingsRepository();
    const mediaRepository = new InstagramMediaRepository();

    /** A fresh connected account of a fresh organization, inserted by another connection. */
    const insertNew = async () => {
      await operatorQuery`DELETE FROM app.instagram_accounts WHERE id = ${account.id}`;
      const inserted = await insertInstagramAccount({ organizationId: organization.id });
      return { organizationId: organization.id, instagramAccountId: inserted.id };
    };

    async function readChannelAccountId(instagramAccountId: number): Promise<number> {
      const rows = await operatorQuery<Array<{ channel_account_id: string }>>`
        SELECT channel_account_id FROM app.instagram_accounts WHERE id = ${instagramAccountId}`;
      return Number(rows[0]?.channel_account_id);
    }

    async function readInstagramUserId(instagramAccountId: number): Promise<string> {
      const rows = await operatorQuery<Array<{ instagram_user_id: string }>>`
        SELECT instagram_user_id FROM app.instagram_accounts WHERE id = ${instagramAccountId}`;
      return rows[0]?.instagram_user_id as string;
    }

    it('picks one again', async () => {
      const reconnected = await changeAfterInsert({
        insert: insertNew,
        change: async (key) =>
          accountRepository.upsertAtPick(
            buildInstagramPickValues({
              organizationId: organization.id,
              channelAccountId: await readChannelAccountId(key.instagramAccountId),
              instagramUserId: await readInstagramUserId(key.instagramAccountId),
              username: 'acme.shop',
            }),
          ),
      });
      expectNotBeforeCreation(reconnected);
    });

    it('erases the profile of a revoked one', async () => {
      const erased = await changeAfterInsert({
        insert: insertNew,
        change: async (key) => {
          await new ChannelAccountRepository().revoke({
            organizationId: organization.id,
            channelAccountId: await readChannelAccountId(key.instagramAccountId),
          });
          return accountRepository.eraseProfile(key);
        },
      });
      expectNotBeforeCreation(erased);
    });

    it('stamps the webhook subscription and the daily profile refresh', async () => {
      const written = await changeAfterInsert({
        insert: insertNew,
        change: async (key) => [
          await accountRepository.recordWebhookSubscribed(key),
          await accountRepository.recordProfileRefresh({
            ...key,
            instagramUserId: await readInstagramUserId(key.instagramAccountId),
            profile: {
              username: 'acme.shop',
              biography: null,
              website: null,
              profilePictureUrl: null,
              followersCount: 2,
              followsCount: 2,
              mediaCount: 2,
            },
          }),
        ],
      });
      expect(written).toEqual([true, true]);
    });

    /** The account's channel connection token row, written by another connection. */
    const insertToken = async (encryptedAccessToken: string) => {
      const [row] = await operatorQuery<Array<{ channel_connection_id: string }>>`
        SELECT c.channel_connection_id FROM app.instagram_accounts AS a
        INNER JOIN app.channel_accounts AS c ON c.id = a.channel_account_id
        WHERE a.id = ${account.id}`;
      const channelConnectionId = Number(row?.channel_connection_id);
      await operatorQuery`
        UPDATE app.channel_connection_tokens SET encrypted_access_token = ${encryptedAccessToken}
        WHERE channel_connection_id = ${channelConnectionId}`;
      return { organizationId: organization.id, channelConnectionId };
    };

    it('replaces a token on reconnect', async () => {
      const { channelConnectionId } = await changeAfterInsert({
        insert: () => insertToken('ciphertext-one'),
        change: async (key) => {
          await tokenRepository.upsert({
            ...key,
            encryptedAccessToken: 'ciphertext-two',
            encryptedRefreshToken: null,
            tokenType: 'system_user',
            expiresAt: null,
          });
          return key;
        },
      });
      const rows = await operatorQuery<Array<{ encrypted_access_token: string }>>`
        SELECT encrypted_access_token FROM app.channel_connection_tokens
        WHERE channel_connection_id = ${channelConnectionId}`;
      expect(rows).toEqual([{ encrypted_access_token: 'ciphertext-two' }]);
    });

    it('changes the settings', async () => {
      const row = await changeAfterInsert({
        insert: async () => {
          const [settings] = await operatorQuery<Array<{ channel_account_id: number }>>`
            INSERT INTO app.instagram_account_settings (organization_id, channel_account_id)
            SELECT organization_id, channel_account_id FROM app.instagram_accounts
            WHERE id = ${account.id}
            RETURNING channel_account_id`;
          return {
            organizationId: organization.id,
            channelAccountId: Number(settings?.channel_account_id),
          };
        },
        change: (key) =>
          settingsRepository.update({
            ...key,
            changes: { is_automatic_notice_enabled: true },
            updatedByUserId: null,
          }),
      });
      expectNotBeforeCreation(row);
    });

    it('refreshes a stored post', async () => {
      const row = await changeAfterInsert({
        insert: async () => {
          await operatorQuery`
            INSERT INTO app.instagram_media (organization_id, instagram_account_id, instagram_media_id, published_at)
            VALUES (${organization.id}, ${account.id}, ${'18030000000000001'}, now())`;
          return { organizationId: organization.id, instagramAccountId: account.id };
        },
        change: (key) =>
          mediaRepository.upsertForAccount({
            ...key,
            instagramMediaId: '18030000000000001',
            shortcode: null,
            mediaType: 'image',
            mediaProductType: 'feed',
            caption: 'New drop this Friday',
            mediaUrl: null,
            thumbnailUrl: null,
            permalink: null,
            publishedAt: new Date(),
            commentsCount: 1,
            likeCount: 1,
            isCommentEnabled: true,
            graphData: { id: '18030000000000001' },
          }),
      });
      expectNotBeforeCreation(row);
    });
  });
});
