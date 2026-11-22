import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { InstagramAccountService } from '@/domains/app/sub-domains/instagram-account/instagram-account.service.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import {
  getPostgresConstraintName,
  getPostgresErrorCode,
} from '@/shared/utils/infrastructure/postgres-error.util.js';
import { AutomationRepository } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { AutomationService } from '@/domains/app/sub-domains/automation/automation.service.js';
import { runAutomationNextPostExpiryJob } from '@/domains/app/sub-domains/automation/workers/automation-next-post-expiry.processor.js';
import {
  type AutomationFixtureRow,
  insertAutomation,
  readAutomationRow,
  revokeInstagramAccount,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The automation repository's own SQL against the database (routes-final § 3.A — AU9, AU15, AU27,
 * D9): the "next post" overlap read (per account, keywords, touching windows, itself and drafts
 * left out), linking a post (the window holds it, live waiting ones only, two may link one post, a
 * post another automation targeted stays taken, a repeat changes nothing, another account is never
 * touched), the 15-minute expiry (a cross-organization scan, each organization changed in its
 * own scope, linked and still-open windows untouched) and the table's own proof of the opening
 * message's button (D56). Every statement runs in an organization's
 * own context or the retention sweep, so the suite also holds under `pnpm test:rls-role`.
 */

type TestOrganization = { id: number; public_id: string; type: string };

/** One fixed base per file, so two windows that touch (one ends where the next starts) never drift apart by the milliseconds between calls. */
const TEST_CLOCK_BASE = Date.now();
const day = (daysFromNow: number) => new Date(TEST_CLOCK_BASE + daysFromNow * MILLISECONDS_PER_DAY);

describe('AutomationRepository (database)', () => {
  let organization: TestOrganization;
  let account: { id: number; public_id: string };
  let service: AutomationService;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    const organizationService = {
      requireOrganizationByPublicId: async () => organization,
    } as unknown as OrganizationService;
    service = new AutomationService(
      new AutomationRepository(),
      {} as InstagramAccountService,
      organizationService,
      [],
    );
  });

  const scope = () => PRINCIPAL_SCOPE.VERIFIED({ organizationPublicId: organization.public_id });

  /** A live, waiting "next post" automation of `instagramAccountId` on [from, to) days from now. */
  function waitingAutomation({
    from,
    to,
    keywords,
    instagramAccountId = account.id,
    status = 'live',
  }: {
    from: number;
    to: number;
    keywords: string[];
    instagramAccountId?: number;
    status?: 'live' | 'inactive';
  }): Promise<AutomationFixtureRow> {
    return insertAutomation({
      organizationId: organization.id,
      instagramAccountId,
      status,
      target_scope: 'next',
      keywords,
      next_post_starts_at: day(from),
      next_post_ends_at: day(to),
      next_post_status: 'waiting',
    });
  }

  function findOverlap({
    from,
    to,
    keywords,
    excludedAutomationId = null,
    instagramAccountId = account.id,
  }: {
    from: number;
    to: number;
    keywords: string[];
    excludedAutomationId?: number | null;
    instagramAccountId?: number;
  }) {
    return withAppDatabaseContext({
      scope: scope(),
      callback: () =>
        new AutomationRepository().findNextPostOverlap({
          organizationId: organization.id,
          instagramAccountId,
          excludedAutomationId,
          startsAt: day(from),
          endsAt: day(to),
          keywords,
        }),
    });
  }

  describe('findNextPostOverlap (AU9)', () => {
    it('finds an overlapping window that shares a keyword — or where either side has none', async () => {
      const other = await waitingAutomation({ from: 1, to: 5, keywords: ['shop', 'link'] });
      expect((await findOverlap({ from: 3, to: 8, keywords: ['link'] }))?.public_id).toBe(
        other.public_id,
      );
      expect((await findOverlap({ from: 3, to: 8, keywords: [] }))?.public_id).toBe(
        other.public_id,
      );
      expect(await findOverlap({ from: 3, to: 8, keywords: ['price'] })).toBeNull();

      const anyComment = await waitingAutomation({ from: 10, to: 12, keywords: [] });
      expect((await findOverlap({ from: 11, to: 13, keywords: ['price'] }))?.public_id).toBe(
        anyComment.public_id,
      );
    });

    it('half-open windows: touching ends never overlap', async () => {
      await waitingAutomation({ from: 1, to: 5, keywords: ['shop'] });
      expect(await findOverlap({ from: 5, to: 6, keywords: ['shop'] })).toBeNull();
      expect(await findOverlap({ from: 0, to: 1, keywords: ['shop'] })).toBeNull();
    });

    it('leaves out the saved automation itself, drafts, linked, expired and deleted ones', async () => {
      const itself = await waitingAutomation({ from: 1, to: 5, keywords: ['shop'] });
      await waitingAutomation({ from: 1, to: 5, keywords: ['shop'], status: 'inactive' });
      await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        status: 'live',
        target_scope: 'next',
        keywords: ['shop'],
        target_instagram_media_id: '18030000000000001',
        next_post_starts_at: day(1),
        next_post_ends_at: day(5),
        next_post_status: 'linked',
        next_post_linked_at: day(0),
      });
      await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        status: 'live',
        target_scope: 'next',
        keywords: ['shop'],
        next_post_starts_at: day(1),
        next_post_ends_at: day(5),
        next_post_status: 'waiting',
        deleted_at: new Date(),
        delete_reason: 'mistake',
      });
      expect(
        await findOverlap({ from: 2, to: 4, keywords: ['shop'], excludedAutomationId: itself.id }),
      ).toBeNull();
    });

    it("never reads another account's automations (AU27)", async () => {
      await waitingAutomation({ from: 1, to: 5, keywords: ['shop'] });
      await revokeInstagramAccount({
        organizationId: organization.id,
        instagramAccountId: account.id,
      });
      const second = await insertInstagramAccount({ organizationId: organization.id });
      expect(
        await findOverlap({ from: 1, to: 5, keywords: ['shop'], instagramAccountId: second.id }),
      ).toBeNull();
    });
  });

  describe('linkNextPostAutomations (AU15, AQ4)', () => {
    function link({
      instagramMediaId = '18030000000000042',
      publishedAt = day(2),
      instagramAccountPublicId = account.public_id,
    }: {
      instagramMediaId?: string;
      publishedAt?: Date;
      instagramAccountPublicId?: string;
    } = {}) {
      return service.linkNextPostAutomations({
        scope: scope(),
        instagramAccountPublicId,
        instagramMediaId,
        publishedAt,
      });
    }

    it('links every live, waiting automation whose window holds the post — two may link one post', async () => {
      const first = await waitingAutomation({ from: 1, to: 5, keywords: ['shop'] });
      const second = await waitingAutomation({ from: 0, to: 3, keywords: ['price'] });
      const draft = await waitingAutomation({
        from: 1,
        to: 5,
        keywords: ['x'],
        status: 'inactive',
      });
      const later = await waitingAutomation({ from: 3, to: 6, keywords: ['y'] });

      const linked = await link();

      expect(linked.sort()).toEqual([first.public_id, second.public_id].sort());
      for (const automation of [first, second]) {
        expect(await readAutomationRow(automation.public_id)).toMatchObject({
          next_post_status: 'linked',
          target_instagram_media_id: '18030000000000042',
        });
        expect((await readAutomationRow(automation.public_id))?.next_post_linked_at).not.toBeNull();
      }
      for (const untouched of [draft, later]) {
        expect((await readAutomationRow(untouched.public_id))?.next_post_status).toBe('waiting');
      }
      // A repeat changes nothing; the post stays taken for a later waiting automation.
      expect(await link()).toEqual([]);
      await waitingAutomation({ from: 1, to: 4, keywords: ['z'] });
      expect(await link()).toEqual([]);
    });

    it("leaves a post another automation already targeted, and another account's automations", async () => {
      await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        target_scope: 'specific',
        target_instagram_media_id: '18030000000000042',
      });
      const waiting = await waitingAutomation({ from: 1, to: 5, keywords: ['shop'] });
      expect(await link()).toEqual([]);
      expect((await readAutomationRow(waiting.public_id))?.next_post_status).toBe('waiting');

      // Another account's id links nothing of this account.
      const other = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
      const otherAccount = await insertInstagramAccount({ organizationId: other.id });
      expect(
        await link({
          instagramMediaId: '18030000000000043',
          instagramAccountPublicId: otherAccount.public_id,
        }),
      ).toEqual([]);
      expect((await readAutomationRow(waiting.public_id))?.next_post_status).toBe('waiting');
    });

    it('a window holds its start and not its end', async () => {
      const window = await waitingAutomation({ from: 1, to: 2, keywords: ['shop'] });
      const startsAt = (await readAutomationRow(window.public_id))?.next_post_starts_at as Date;
      const endsAt = (await readAutomationRow(window.public_id))?.next_post_ends_at as Date;
      expect(await link({ publishedAt: endsAt })).toEqual([]);
      expect(await link({ publishedAt: startsAt })).toEqual([window.public_id]);
    });
  });

  describe('the opening message’s button of a comment automation (AU8, AQ2, D56)', () => {
    function insertWithOpeningMessage(
      opening_message: Record<string, unknown>,
      overrides: Partial<AutomationFixtureRow> = {},
    ): Promise<AutomationFixtureRow> {
      return insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        opening_message: opening_message as unknown as AutomationFixtureRow['opening_message'],
        ...overrides,
      });
    }

    it.each([
      ['without a button_title', { text: 'Hi there' }],
      ['with a null button_title', { text: 'Hi there', button_title: null }],
      ['with a button_title that is not a text', { text: 'Hi there', button_title: 1 }],
    ])('refuses one %s', async (_shape, openingMessage) => {
      const failure = await insertWithOpeningMessage(openingMessage).then(
        () => null,
        (error: unknown) => error,
      );

      expect(getPostgresErrorCode(failure)).toBe('23514');
      expect(getPostgresConstraintName(failure)).toBe('chk_automations_comment_opening_button');
    });

    it('takes one with a button_title, and one without while the opening message is off', async () => {
      await expect(
        insertWithOpeningMessage({ text: 'Hi there', button_title: 'Send it' }),
      ).resolves.toMatchObject({ trigger_type: 'comment' });
      await expect(
        insertWithOpeningMessage({ text: 'Hi there' }, { is_opening_message_enabled: false }),
      ).resolves.toMatchObject({ is_opening_message_enabled: false });
    });

    it('needs none on a DM automation', async () => {
      await expect(
        insertWithOpeningMessage(
          { text: 'Hi there' },
          { trigger_type: 'dm', keywords: ['catalog'] },
        ),
      ).resolves.toMatchObject({ trigger_type: 'dm' });
    });
  });

  describe('the "next post" expiry (D9, WC-6)', () => {
    it('expires the waiting windows that ended, in every organization, and nothing else', async () => {
      const ended = await waitingAutomation({ from: -5, to: -1, keywords: ['a'] });
      const open = await waitingAutomation({ from: -1, to: 3, keywords: ['b'] });
      const linkedEnded = await insertAutomation({
        organizationId: organization.id,
        instagramAccountId: account.id,
        status: 'live',
        target_scope: 'next',
        target_instagram_media_id: '18030000000000050',
        next_post_starts_at: day(-5),
        next_post_ends_at: day(-1),
        next_post_status: 'linked',
        next_post_linked_at: day(-3),
      });
      const draftEnded = await waitingAutomation({
        from: -5,
        to: -1,
        keywords: ['c'],
        status: 'inactive',
      });
      const other = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
      const otherAccount = await insertInstagramAccount({ organizationId: other.id });
      const otherEnded = await insertAutomation({
        organizationId: other.id,
        instagramAccountId: otherAccount.id,
        target_scope: 'next',
        next_post_starts_at: day(-5),
        next_post_ends_at: day(-2),
        next_post_status: 'waiting',
      });

      const result = await runAutomationNextPostExpiryJob({ now: new Date() });

      expect(result).toEqual({ scanned: 3, expired: 3, failedOrganizationCount: 0 });
      for (const automation of [ended, draftEnded, otherEnded]) {
        expect((await readAutomationRow(automation.public_id))?.next_post_status).toBe('expired');
      }
      expect((await readAutomationRow(open.public_id))?.next_post_status).toBe('waiting');
      expect((await readAutomationRow(linkedEnded.public_id))?.next_post_status).toBe('linked');

      // A repeat changes nothing.
      expect(await runAutomationNextPostExpiryJob({ now: new Date() })).toEqual({
        scanned: 0,
        expired: 0,
        failedOrganizationCount: 0,
      });
    });
  });
});
