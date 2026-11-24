import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { APP_PERMISSIONS } from '@/domains/app/app.permissions.js';
import { createAutomationDto } from '@/domains/app/sub-domains/automation/automation.dto.js';
import { createTestApp } from '@/tests/helpers/test-app.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  injectAuthenticated,
  type InjectHttpResult,
} from '@/tests/helpers/test-http-inject.helper.js';
import {
  createInstagramTeam,
  createPersonalOrganizationWithInstagramCodes,
  endTrialWithoutPaying,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  AUTOMATIONS_PATH,
  automationPath,
  type AutomationFixtureRow,
  commentAutomationBody,
  insertAutomation,
  readAutomationRow,
  revokeInstagramAccount,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/**
 * Routes 11–15 of the automations (routes-final § 3.A, ROUTE R9) over HTTP: each route's success and
 * every error of 3.A.9 — the flow rules, the "next post" window and its overlap `409` (two saves at
 * once, never across two accounts), the account set at create (AU27) and kept by an edit, a copy
 * of an automation (Duplicate, 3.A.10), a stale save, a linked window, the delete's reason; the
 * list's filters, search and every sort in both directions across pages; the audit entries;
 * team-only (AU3), the Editor role on route 15, the read-only plan on the three writes with the
 * reads open (AQ8, D27), and another organization's automation (K1). The database, auth,
 * permissions, idempotency and audit are real.
 */
describe('Automation routes (list, create, read, edit, delete)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string };

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupDatabase();
    await seedAllPermissions();
    team = await createInstagramTeam();
    account = await insertInstagramAccount({ organizationId: team.organization.id });
  });

  const day = (daysFromNow: number) => new Date(Date.now() + daysFromNow * MILLISECONDS_PER_DAY);

  /** An automation of the team's account, inserted directly. */
  function automationOfTeam(
    overrides: Partial<
      Omit<AutomationFixtureRow, 'id' | 'organization_id' | 'instagram_account_id'>
    > = {},
  ): Promise<AutomationFixtureRow> {
    return insertAutomation({
      organizationId: team.organization.id,
      instagramAccountId: account.id,
      ...overrides,
    });
  }

  function create({
    body,
    token = team.ownerToken,
    idempotencyKey = `automation-${randomUUID()}`,
  }: {
    body: unknown;
    token?: string;
    idempotencyKey?: string | null;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: AUTOMATIONS_PATH,
      token,
      headers: idempotencyKey === null ? {} : { 'x-idempotency-key': idempotencyKey },
      payload: body,
    });
  }

  function read({
    automationPublicId,
    token = team.ownerToken,
  }: {
    automationPublicId: string;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'GET',
      url: automationPath(automationPublicId),
      token,
    });
  }

  function edit({
    automationPublicId,
    body,
    token = team.ownerToken,
  }: {
    automationPublicId: string;
    body: unknown;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'PATCH',
      url: automationPath(automationPublicId),
      token,
      payload: body,
    });
  }

  function remove({
    automationPublicId,
    query = 'reason=mistake',
    token = team.ownerToken,
  }: {
    automationPublicId: string;
    query?: string;
    token?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url:
        query === ''
          ? automationPath(automationPublicId)
          : `${automationPath(automationPublicId)}?${query}`,
      token,
    });
  }

  function list({
    token = team.ownerToken,
    query = '',
  }: {
    token?: string;
    query?: string;
  } = {}): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'GET',
      url: query === '' ? AUTOMATIONS_PATH : `${AUTOMATIONS_PATH}?${query}`,
      token,
    });
  }

  type AutomationBody = Record<string, unknown> & { id: string };
  type ListBody = {
    data: AutomationBody[];
    meta: {
      pagination: {
        per_page: number;
        next: string | null;
        has_more: boolean;
        estimated_total?: number;
      };
    };
  };

  function dataOf(response: InjectHttpResult): AutomationBody {
    return (response.json() as { data: AutomationBody }).data;
  }

  function errorOf(response: InjectHttpResult): {
    code?: string;
    reason?: string;
    detail?: string;
    errors?: Array<{ field: string }>;
  } {
    return (response.json() as { error: Record<string, never> }).error;
  }

  function errorFields(response: InjectHttpResult): string[] {
    return (errorOf(response).errors ?? []).map((item) => item.field);
  }

  /** The automation public ids `query` lists (one page of 100). */
  async function listedIds(query = '', token = team.ownerToken): Promise<string[]> {
    const response = await list({
      token,
      query: query === '' ? 'limit=100' : `${query}&limit=100`,
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as ListBody).data.map((automation) => automation.id);
  }

  /** Every page of `query`, `limit` at a time, as one list of public ids. */
  async function pagedIds(query: string, limit: number): Promise<string[]> {
    const ids: string[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const cursor: string = after === null ? '' : `&after=${encodeURIComponent(after)}`;
      const response = await list({ query: `${query}&limit=${limit}${cursor}` });
      expect(response.statusCode).toBe(200);
      const body = response.json() as ListBody;
      ids.push(...body.data.map((automation) => automation.id));
      if (!body.meta.pagination.has_more) return ids;
      after = body.meta.pagination.next;
    }
    throw new Error('paging did not end');
  }

  /** A live, waiting "next post" body on the window [from, to) days from now. */
  function nextPostBody({
    from,
    to,
    keywords,
    name = 'Next post',
  }: {
    from: number;
    to: number;
    keywords: string[];
    name?: string;
  }): Record<string, unknown> {
    return commentAutomationBody({
      name,
      status: 'live',
      target_scope: 'next',
      keywords,
      next_post_starts_at: day(from).toISOString(),
      next_post_ends_at: day(to).toISOString(),
    });
  }

  describe('POST /app/automations (route 12)', () => {
    it('creates on the connected account, inactive, normalised, with the caller as creator and editor (AC-5.1)', async () => {
      const response = await create({
        body: commentAutomationBody({
          keywords: ['  Price ', 'PRICE', 'link'],
          tags: ['vip', 'vip', 'launch'],
        }),
      });

      expect(response.statusCode).toBe(200);
      const automation = dataOf(response);
      expect(automation).toMatchObject({
        instagram_account_id: account.public_id,
        name: 'Comment for the link',
        status: 'inactive',
        trigger_type: 'comment',
        target_scope: 'any',
        keywords: ['price', 'link'],
        tags: ['vip', 'launch'],
        is_opening_message_enabled: true,
        opening_message: { text: 'Thanks for your comment!', button_title: 'Send it' },
        final_message: {
          text: 'Here you go',
          links: [{ title: 'Shop', url: 'https://shop.example.com' }],
        },
        next_post_status: null,
        completed_run_count: 0,
        last_triggered_at: null,
        created_by_user_id: team.owner.public_id,
        updated_by_user_id: team.owner.public_id,
      });
      expect(automation.id).toMatch(/^aut_[a-z0-9]{21}$/);
      expect(automation).not.toHaveProperty('deleted_at');
      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.automation.create',
      });
      expect(audit).toEqual([
        expect.objectContaining({
          resource_type: 'automation',
          metadata: expect.objectContaining({ automation_public_id: automation.id }),
        }),
      ]);
    });

    it("creates on an expired or error account too — it is still the organization's (AU27)", async () => {
      await operatorQuery`UPDATE app.instagram_accounts SET connection_status = 'expired' WHERE id = ${account.id}`;
      const response = await create({ body: commentAutomationBody() });
      expect(response.statusCode).toBe(200);
      expect(dataOf(response).instagram_account_id).toBe(account.public_id);
    });

    it('answers 409 instagram_not_connected without a not-revoked account (AC-5.2)', async () => {
      await revokeInstagramAccount({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const response = await create({ body: commentAutomationBody() });
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('instagram_not_connected');
      // A broken body is still a 400 first.
      const invalid = await create({ body: commentAutomationBody({ opening_message: null }) });
      expect(invalid.statusCode).toBe(400);
    });

    it('requires X-Idempotency-Key (AC-5.3)', async () => {
      const missing = await create({ body: commentAutomationBody(), idempotencyKey: null });
      expect(missing.statusCode).toBe(422);
    });

    // The automation object carries `is_email_collection_enabled` and `email_request_message`: an
    // email is personal data, not a secret (launch D40), so the create's answer is cached.
    it('replays the first automation for the same key and body, and refuses another body (AC-5.3)', async () => {
      const key = `automation-${randomUUID()}`;
      const first = await create({ body: commentAutomationBody(), idempotencyKey: key });
      const second = await create({ body: commentAutomationBody(), idempotencyKey: key });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(dataOf(second).id).toBe(dataOf(first).id);
      // The same key with another body is a reused key: 422, nothing created.
      const reused = await create({
        body: commentAutomationBody({ name: 'Another automation' }),
        idempotencyKey: key,
      });
      expect(reused.statusCode).toBe(422);
      expect(await listedIds()).toEqual([dataOf(first).id]);
    });

    it('refuses the scope and target rules on their fields (AC-5.4)', async () => {
      const storyNext = await create({
        body: {
          name: 'Story',
          trigger_type: 'story_reply',
          target_scope: 'next',
          is_opening_message_enabled: false,
          final_message: { text: 'Bye' },
        },
      });
      expect(storyNext.statusCode).toBe(400);
      expect(errorFields(storyNext)).toContain('body.target_scope');

      const dmSpecific = await create({
        body: {
          name: 'DM',
          trigger_type: 'dm',
          target_scope: 'specific',
          keywords: ['price'],
          is_opening_message_enabled: false,
          final_message: { text: 'Bye' },
        },
      });
      expect(errorFields(dmSpecific)).toContain('body.target_scope');

      const specificWithoutPost = await create({
        body: commentAutomationBody({ target_scope: 'specific' }),
      });
      expect(errorFields(specificWithoutPost)).toEqual(['body.target_instagram_media_id']);

      const mediaOnNext = await create({
        body: {
          ...nextPostBody({ from: 1, to: 3, keywords: ['x'] }),
          target_instagram_media_id: '18030000000000001',
        },
      });
      expect(errorFields(mediaOnNext)).toEqual(['body.target_instagram_media_id']);

      const notDigits = await create({
        body: commentAutomationBody({ target_scope: 'specific', target_instagram_media_id: 'abc' }),
      });
      expect(notDigits.statusCode).toBe(400);
    });

    it('a DM automation needs a keyword and the DM keyword trigger on (AC-5.5)', async () => {
      const response = await create({
        body: {
          name: 'DM',
          trigger_type: 'dm',
          is_dm_keyword_trigger_enabled: false,
          is_opening_message_enabled: false,
          final_message: { text: 'Bye' },
        },
      });
      expect(response.statusCode).toBe(400);
      expect(errorFields(response).sort()).toEqual([
        'body.is_dm_keyword_trigger_enabled',
        'body.keywords',
      ]);
    });

    it('public replies only on comments, with 1–20 texts (AC-5.6)', async () => {
      const onStory = await create({
        body: {
          name: 'Story',
          trigger_type: 'story_reply',
          is_public_reply_enabled: true,
          public_reply_texts: ['Thanks'],
          is_opening_message_enabled: false,
          final_message: { text: 'Bye' },
        },
      });
      expect(errorFields(onStory)).toEqual(['body.is_public_reply_enabled']);
      const withoutTexts = await create({
        body: commentAutomationBody({ is_public_reply_enabled: true }),
      });
      expect(errorFields(withoutTexts)).toEqual(['body.public_reply_texts']);
    });

    it('public replies: a DM automation, 21 texts and a text over 300 characters are refused; 20 texts are kept (AC-5.6)', async () => {
      const replyTexts = (count: number) =>
        Array.from({ length: count }, (_text, index) => `Sent, reply ${index}`);
      const withReplyTexts = (texts: string[]) =>
        commentAutomationBody({ is_public_reply_enabled: true, public_reply_texts: texts });

      const onDirectMessage = await create({
        body: {
          name: 'DM',
          trigger_type: 'dm',
          keywords: ['price'],
          is_public_reply_enabled: true,
          public_reply_texts: ['Thanks'],
          is_opening_message_enabled: false,
          final_message: { text: 'Bye' },
        },
      });
      expect(onDirectMessage.statusCode).toBe(400);
      expect(errorFields(onDirectMessage)).toEqual(['body.is_public_reply_enabled']);

      const tooMany = await create({ body: withReplyTexts(replyTexts(21)) });
      expect(tooMany.statusCode).toBe(400);
      expect(errorFields(tooMany)).toEqual(['body.public_reply_texts']);
      const tooLong = await create({ body: withReplyTexts(['Sent', 'x'.repeat(301)]) });
      expect(tooLong.statusCode).toBe(400);
      expect(errorFields(tooLong)).toEqual(['body.public_reply_texts/1']);
      expect(await listedIds()).toEqual([]);

      const atTheLimit = await create({ body: withReplyTexts(replyTexts(20)) });
      expect(atTheLimit.statusCode).toBe(200);
      expect(dataOf(atTheLimit).public_reply_texts).toEqual(replyTexts(20));
      // An edit is refused the same way, and the stored texts stay.
      const edited = await edit({
        automationPublicId: dataOf(atTheLimit).id,
        body: { public_reply_texts: replyTexts(21) },
      });
      expect(edited.statusCode).toBe(400);
      expect(errorFields(edited)).toEqual(['body.public_reply_texts']);
      expect((await readAutomationRow(dataOf(atTheLimit).id))?.public_reply_texts).toEqual(
        replyTexts(20),
      );
    });

    it("needs the final message and each enabled step's message, one item each (AC-5.7)", async () => {
      const withoutFinal = await create({
        body: {
          name: 'X',
          trigger_type: 'comment',
          opening_message: { text: 'Hi', button_title: 'Go' },
        },
      });
      expect(withoutFinal.statusCode).toBe(400);
      expect(errorFields(withoutFinal)).toContain('body.final_message');

      const missingSteps = await create({
        body: commentAutomationBody({ opening_message: null, is_follow_required: true }),
      });
      expect(errorFields(missingSteps).sort()).toEqual([
        'body.follow_request_message',
        'body.opening_message',
      ]);
    });

    it('a comment automation with the opening message on needs a button title (AC-5.8)', async () => {
      const response = await create({
        body: commentAutomationBody({ opening_message: { text: 'Hi', button_title: null } }),
      });
      expect(errorFields(response)).toEqual(['body.opening_message.button_title']);
    });

    it('refuses each "next post" date rule with its own message (AC-5.9)', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [
          { next_post_starts_at: null, next_post_ends_at: day(2).toISOString() },
          'body.next_post_starts_at',
        ],
        [
          { next_post_starts_at: day(2).toISOString(), next_post_ends_at: day(1).toISOString() },
          'body.next_post_ends_at',
        ],
        [
          { next_post_starts_at: day(-2).toISOString(), next_post_ends_at: day(2).toISOString() },
          'body.next_post_starts_at',
        ],
        [
          {
            next_post_starts_at: day(-0.5).toISOString(),
            next_post_ends_at: day(-0.1).toISOString(),
          },
          'body.next_post_ends_at',
        ],
      ];
      for (const [window, field] of cases) {
        const response = await create({
          body: { ...nextPostBody({ from: 1, to: 2, keywords: ['x'] }), ...window },
        });
        expect(response.statusCode, JSON.stringify(window)).toBe(400);
        expect(errorFields(response)).toEqual([field]);
      }
      const invalid = await create({
        body: { ...nextPostBody({ from: 1, to: 2, keywords: ['x'] }), next_post_ends_at: 'soon' },
      });
      expect(invalid.statusCode).toBe(400);
    });

    it('refuses a read-only field and an unknown key — instagram_account_id included (AC-5.14)', async () => {
      for (const field of ['instagram_account_id', 'completed_run_count', 'next_post_status']) {
        const response = await create({
          body: commentAutomationBody({ [field]: field === 'completed_run_count' ? 3 : 'x' }),
        });
        expect(response.statusCode, field).toBe(400);
      }
    });

    it('has no plan limit on the number of automations (AC-5.21)', async () => {
      for (let index = 0; index < 12; index += 1) {
        expect(
          (await create({ body: commentAutomationBody({ name: `A${index}` }) })).statusCode,
        ).toBe(200);
      }
    });
  });

  describe('the "next post" overlap (AU9, AC-5.11)', () => {
    it('refuses a live, waiting window that overlaps and shares a keyword, naming the other one', async () => {
      const first = await create({
        body: nextPostBody({ from: 1, to: 5, keywords: ['shop', 'link'], name: 'Giveaway' }),
      });
      expect(first.statusCode).toBe(200);

      const clash = await create({ body: nextPostBody({ from: 3, to: 8, keywords: ['link'] }) });
      expect(clash.statusCode).toBe(409);
      const error = errorOf(clash);
      expect(error.reason).toBe('next_post_window_overlap');
      expect(error.detail).toContain('Giveaway');
      expect(error.detail).toContain('link');
      expect(error.errors ?? []).toEqual([]);

      // Without keywords the other side answers any comment.
      const anyComment = await create({ body: nextPostBody({ from: 2, to: 3, keywords: [] }) });
      expect(errorOf(anyComment).reason).toBe('next_post_window_overlap');
    });

    it('allows a different keyword, a window that only touches, and an inactive draft', async () => {
      await create({ body: nextPostBody({ from: 1, to: 5, keywords: ['shop'] }) });
      expect(
        (await create({ body: nextPostBody({ from: 1, to: 5, keywords: ['price'] }) })).statusCode,
      ).toBe(200);
      const touching = nextPostBody({ from: 5, to: 6, keywords: ['shop'] });
      expect((await create({ body: touching })).statusCode).toBe(200);
      const draft = { ...nextPostBody({ from: 2, to: 4, keywords: ['shop'] }), status: 'inactive' };
      const draftResponse = await create({ body: draft });
      expect(draftResponse.statusCode).toBe(200);
      // The draft is checked when it turns live.
      const goLive = await edit({
        automationPublicId: dataOf(draftResponse).id,
        body: { status: 'live' },
      });
      expect(errorOf(goLive).reason).toBe('next_post_window_overlap');
    });

    it('two saves at the same moment never both pass', async () => {
      const responses = await Promise.all([
        create({ body: nextPostBody({ from: 1, to: 5, keywords: ['shop'] }) }),
        create({ body: nextPostBody({ from: 2, to: 6, keywords: ['shop'] }) }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    });

    it('never clashes across two Instagram accounts of the organization (AU27, D26)', async () => {
      const onFirst = await create({ body: nextPostBody({ from: 1, to: 5, keywords: ['shop'] }) });
      expect(onFirst.statusCode).toBe(200);
      await revokeInstagramAccount({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const second = await insertInstagramAccount({ organizationId: team.organization.id });

      const onSecond = await create({ body: nextPostBody({ from: 1, to: 5, keywords: ['shop'] }) });
      expect(onSecond.statusCode).toBe(200);
      expect(dataOf(onSecond).instagram_account_id).toBe(second.public_id);
    });
  });

  describe('Duplicate — read one (route 13), create from it (route 12) (3.A.10, AC-5.23)', () => {
    /**
     * The body a Duplicate posts: every field route 12 takes, as route 13 read it — but the post of
     * a "next post" automation, which only the server sets when it links one (AU9).
     */
    async function duplicateBody(automationPublicId: string): Promise<Record<string, unknown>> {
      const response = await read({ automationPublicId });
      expect(response.statusCode).toBe(200);
      const original = dataOf(response);
      const body: Record<string, unknown> = {};
      for (const field of Object.keys(createAutomationDto.shape)) {
        // The read carries every field the create takes — a copy loses none.
        expect(original).toHaveProperty(field);
        body[field] = original[field];
      }
      if (original.target_scope === 'next') delete body.target_instagram_media_id;
      return body;
    }

    /** The team leaves its Instagram account for another one, which is the account connected now. */
    async function switchAccount(): Promise<{ id: number; public_id: string }> {
      await revokeInstagramAccount({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      return insertInstagramAccount({ organizationId: team.organization.id });
    }

    it("copies every field onto the account connected now — not the original's, nor its counters", async () => {
      const original = await automationOfTeam({
        name: 'Spring guide',
        status: 'live',
        target_scope: 'specific',
        target_instagram_media_id: '18030000000000021',
        keywords: ['guide', 'link'],
        tags: ['spring'],
        is_dm_keyword_trigger_enabled: false,
        is_public_reply_enabled: true,
        public_reply_texts: ['Sent!', 'Check your DMs'],
        is_follow_required: true,
        follow_request_message: {
          text: 'Follow us first',
          following_button_title: "I'm following",
          profile_button_title: 'Profile',
        },
        is_email_collection_enabled: true,
        email_request_message: { text: 'Your email?' },
        is_phone_collection_enabled: true,
        phone_request_message: { text: 'Your phone?' },
        final_message: {
          text: 'Here you go',
          links: [{ title: 'Shop', url: 'https://shop.example.com' }],
        },
        completed_run_count: 7,
        last_triggered_at: day(-1),
      });
      const connectedNow = await switchAccount();
      const body = await duplicateBody(original.public_id);

      const response = await create({ body, token: team.editorToken });

      expect(response.statusCode, response.body).toBe(200);
      const copy = dataOf(response);
      expect(copy).toMatchObject({
        ...body,
        instagram_account_id: connectedNow.public_id,
        completed_run_count: 0,
        last_triggered_at: null,
        created_by_user_id: team.editor.public_id,
        updated_by_user_id: team.editor.public_id,
      });
      expect(copy.id).not.toBe(original.public_id);
      expect((await readAutomationRow(copy.id))?.instagram_account_id).toBe(connectedNow.id);
      // The original is only read: still its own account's, its counters untouched.
      expect(await readAutomationRow(original.public_id)).toEqual(original);
    });

    it('a copy of a linked "next post" automation arrives waiting, with no post of its own', async () => {
      const linked = await automationOfTeam({
        name: 'Giveaway',
        status: 'live',
        target_scope: 'next',
        keywords: ['gift'],
        target_instagram_media_id: '18030000000000022',
        next_post_starts_at: day(-0.5),
        next_post_ends_at: day(3),
        next_post_status: 'linked',
        next_post_linked_at: day(-0.25),
      });
      const connectedNow = await switchAccount();
      const body = await duplicateBody(linked.public_id);

      const response = await create({ body });

      expect(response.statusCode, response.body).toBe(200);
      expect(dataOf(response)).toMatchObject({
        name: 'Giveaway',
        status: 'live',
        target_scope: 'next',
        keywords: ['gift'],
        instagram_account_id: connectedNow.public_id,
        next_post_status: 'waiting',
        next_post_linked_at: null,
        target_instagram_media_id: null,
        next_post_starts_at: linked.next_post_starts_at?.toISOString(),
        next_post_ends_at: linked.next_post_ends_at?.toISOString(),
      });
      expect(await readAutomationRow(linked.public_id)).toEqual(linked);
      // Sent with the original's post it is refused: only the server links one (AU9).
      const withPost = await create({
        body: { ...body, target_instagram_media_id: linked.target_instagram_media_id },
      });
      expect(withPost.statusCode).toBe(400);
      expect(errorFields(withPost)).toEqual(['body.target_instagram_media_id']);
    });

    it('a copied window must still pass the window rules: an ended one needs new dates, then it waits (AU9)', async () => {
      const ended = await automationOfTeam({
        target_scope: 'next',
        target_instagram_media_id: '18030000000000023',
        next_post_starts_at: day(-10),
        next_post_ends_at: day(-3),
        next_post_status: 'linked',
        next_post_linked_at: day(-5),
      });
      const body = await duplicateBody(ended.public_id);

      const asRead = await create({ body });
      expect(asRead.statusCode).toBe(400);
      expect(errorFields(asRead).sort()).toEqual([
        'body.next_post_ends_at',
        'body.next_post_starts_at',
      ]);

      const redated = await create({
        body: {
          ...body,
          next_post_starts_at: day(1).toISOString(),
          next_post_ends_at: day(4).toISOString(),
        },
      });
      expect(redated.statusCode, redated.body).toBe(200);
      expect(dataOf(redated)).toMatchObject({
        instagram_account_id: account.public_id,
        next_post_status: 'waiting',
        next_post_linked_at: null,
        target_instagram_media_id: null,
      });
    });
  });

  describe('GET /app/automations/{automation_id} (route 13)', () => {
    it('reads one automation; a deleted, missing or foreign one is 404 automation_not_found (AC-5.17)', async () => {
      const automation = await automationOfTeam({ name: 'Readable' });
      const response = await read({ automationPublicId: automation.public_id });
      expect(response.statusCode).toBe(200);
      expect(dataOf(response)).toMatchObject({
        id: automation.public_id,
        name: 'Readable',
        instagram_account_id: account.public_id,
      });

      const deleted = await automationOfTeam({ deleted_at: new Date(), delete_reason: 'mistake' });
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertAutomation({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
      });
      for (const automationPublicId of [
        deleted.public_id,
        foreign.public_id,
        generatePublicId('automation'),
      ]) {
        const missing = await read({ automationPublicId });
        expect(missing.statusCode).toBe(404);
        expect(errorOf(missing).reason).toBe('automation_not_found');
      }
      expect((await read({ automationPublicId: 'not-an-id' })).statusCode).toBe(400);
    });
  });

  describe('PATCH /app/automations/{automation_id} (route 14)', () => {
    it('edits, runs every create rule on the merged automation and keeps the account (AC-5.12)', async () => {
      const automation = await automationOfTeam();
      const renamed = await edit({
        automationPublicId: automation.public_id,
        body: { name: 'Renamed', status: 'live', keywords: ['NEW'] },
      });
      expect(renamed.statusCode).toBe(200);
      expect(dataOf(renamed)).toMatchObject({
        name: 'Renamed',
        status: 'live',
        keywords: ['new'],
        instagram_account_id: account.public_id,
        updated_by_user_id: team.owner.public_id,
      });

      const broken = await edit({
        automationPublicId: automation.public_id,
        body: { opening_message: { text: 'No button', button_title: null } },
      });
      expect(errorFields(broken)).toEqual(['body.opening_message.button_title']);

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.automation.update',
      });
      expect(audit).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            automation_public_id: automation.public_id,
            changed_fields: ['name', 'status', 'keywords'],
          }),
        }),
      ]);
    });

    it('refuses an empty body and every read-only field, the account included (AC-5.14)', async () => {
      const automation = await automationOfTeam();
      expect((await edit({ automationPublicId: automation.public_id, body: {} })).statusCode).toBe(
        400,
      );
      for (const body of [
        { instagram_account_id: generatePublicId('instagramAccount') },
        { completed_run_count: 5 },
        { last_triggered_at: new Date().toISOString() },
        { next_post_status: 'waiting' },
        { next_post_linked_at: new Date().toISOString() },
      ]) {
        expect((await edit({ automationPublicId: automation.public_id, body })).statusCode).toBe(
          400,
        );
      }
    });

    it('refuses a stale save with 409 record_changed (AC-5.15)', async () => {
      const automation = await automationOfTeam();
      const first = await edit({
        automationPublicId: automation.public_id,
        body: { name: 'First', expected_updated_at: automation.updated_at.toISOString() },
      });
      expect(first.statusCode).toBe(200);
      const stale = await edit({
        automationPublicId: automation.public_id,
        body: { name: 'Second', expected_updated_at: automation.updated_at.toISOString() },
      });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).reason).toBe('record_changed');
    });

    it('a changed window waits again on an expired automation; a linked one is fixed (AC-5.13)', async () => {
      const expired = await automationOfTeam({
        target_scope: 'next',
        next_post_starts_at: day(-10),
        next_post_ends_at: day(-3),
        next_post_status: 'expired',
      });
      const reopened = await edit({
        automationPublicId: expired.public_id,
        body: { next_post_ends_at: day(4).toISOString() },
      });
      expect(reopened.statusCode).toBe(200);
      expect(dataOf(reopened).next_post_status).toBe('waiting');

      const linked = await automationOfTeam({
        target_scope: 'next',
        target_instagram_media_id: '18030000000000009',
        next_post_starts_at: day(-10),
        next_post_ends_at: day(-3),
        next_post_status: 'linked',
        next_post_linked_at: day(-5),
      });
      for (const body of [
        { next_post_ends_at: day(4).toISOString() },
        { target_scope: 'any' },
        { target_instagram_media_id: '18030000000000010' },
      ]) {
        const response = await edit({ automationPublicId: linked.public_id, body });
        expect(response.statusCode).toBe(409);
        expect(errorOf(response).reason).toBe('next_post_already_linked');
      }
      // Anything else still changes.
      expect(
        (await edit({ automationPublicId: linked.public_id, body: { name: 'Still linked' } }))
          .statusCode,
      ).toBe(200);
    });

    it('a started window may move later, never earlier (AC-5.10)', async () => {
      const started = await automationOfTeam({
        status: 'live',
        target_scope: 'next',
        next_post_starts_at: day(-0.5),
        next_post_ends_at: day(3),
        next_post_status: 'waiting',
      });
      const later = await edit({
        automationPublicId: started.public_id,
        body: { next_post_starts_at: day(-0.25).toISOString() },
      });
      expect(later.statusCode).toBe(200);
      const earlier = await edit({
        automationPublicId: started.public_id,
        body: { next_post_starts_at: day(-0.75).toISOString() },
      });
      expect(errorFields(earlier)).toEqual(['body.next_post_starts_at']);
    });

    it("answers 404 for a deleted or another organization's automation (K1)", async () => {
      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertAutomation({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
        name: 'Foreign',
      });
      const response = await edit({
        automationPublicId: foreign.public_id,
        body: { name: 'Taken' },
      });
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('automation_not_found');
      expect((await readAutomationRow(foreign.public_id))?.name).toBe('Foreign');
    });
  });

  describe('DELETE /app/automations/{automation_id} (route 15)', () => {
    it('soft-deletes with the reason, writes the audit entry and never lists or reads it again (AC-5.18)', async () => {
      const automation = await automationOfTeam();
      const response = await remove({
        automationPublicId: automation.public_id,
        query: 'reason=other&note=Season%20over',
      });
      expect(response.statusCode).toBe(204);
      const row = await readAutomationRow(automation.public_id);
      expect(row).toMatchObject({ delete_reason: 'other', delete_note: 'Season over' });
      expect(row?.deleted_at).not.toBeNull();
      expect(await listedIds()).toEqual([]);
      expect((await read({ automationPublicId: automation.public_id })).statusCode).toBe(404);
      expect((await remove({ automationPublicId: automation.public_id })).statusCode).toBe(404);

      const audit = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.automation.delete',
      });
      expect(audit).toEqual([
        expect.objectContaining({
          severity: 'WARNING',
          metadata: expect.objectContaining({
            automation_public_id: automation.public_id,
            delete_reason: 'other',
            cancelled_run_count: 0,
          }),
        }),
      ]);
    });

    it('needs a reason, and a note for other (AQ6)', async () => {
      const automation = await automationOfTeam();
      expect(
        (await remove({ automationPublicId: automation.public_id, query: '' })).statusCode,
      ).toBe(400);
      expect(
        (await remove({ automationPublicId: automation.public_id, query: 'reason=other' }))
          .statusCode,
      ).toBe(400);
      expect(
        (await remove({ automationPublicId: automation.public_id, query: 'reason=gone' }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await remove({
            automationPublicId: automation.public_id,
            query: `reason=other&note=${'n'.repeat(281)}`,
          })
        ).statusCode,
      ).toBe(400);
    });

    it("lets an Editor delete (TN1, AC-12.2), refuses a Viewer with 403 missing_permission (AC-12.3) and another organization's automation with 404 (AC-5.19)", async () => {
      const kept = await automationOfTeam();
      const viewerResponse = await remove({
        automationPublicId: kept.public_id,
        token: team.viewerToken,
      });
      expect(viewerResponse.statusCode).toBe(403);
      expect(errorOf(viewerResponse).reason).toBe('missing_permission');
      expect((await readAutomationRow(kept.public_id))?.deleted_at).toBeNull();

      const automation = await automationOfTeam();
      const editorResponse = await remove({
        automationPublicId: automation.public_id,
        token: team.editorToken,
      });
      expect(editorResponse.statusCode).toBe(204);
      expect((await readAutomationRow(automation.public_id))?.deleted_at).not.toBeNull();

      const otherTeam = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({
        organizationId: otherTeam.organization.id,
      });
      const foreign = await insertAutomation({
        organizationId: otherTeam.organization.id,
        instagramAccountId: otherAccount.id,
      });
      expect((await remove({ automationPublicId: foreign.public_id })).statusCode).toBe(404);
      expect((await readAutomationRow(foreign.public_id))?.deleted_at).toBeNull();
    });
  });

  describe('a Viewer (feat-instagram-dm-sending TN1, AC-12.3)', () => {
    it('lists and reads, and is refused create and edit with 403 missing_permission', async () => {
      const automation = await automationOfTeam();
      expect(
        (await read({ automationPublicId: automation.public_id, token: team.viewerToken }))
          .statusCode,
      ).toBe(200);
      expect(await listedIds('', team.viewerToken)).toEqual([automation.public_id]);
      for (const response of [
        await create({ body: commentAutomationBody(), token: team.viewerToken }),
        await edit({
          automationPublicId: automation.public_id,
          body: { status: 'live' },
          token: team.viewerToken,
        }),
      ]) {
        expect(response.statusCode).toBe(403);
        expect(errorOf(response).reason).toBe('missing_permission');
      }
    });
  });

  describe('an Editor (AC-5.19, AC-12.2)', () => {
    it('lists, reads, creates and edits', async () => {
      const created = await create({ body: commentAutomationBody(), token: team.editorToken });
      expect(created.statusCode).toBe(200);
      const automationPublicId = dataOf(created).id;
      expect((await read({ automationPublicId, token: team.editorToken })).statusCode).toBe(200);
      expect(
        (await edit({ automationPublicId, body: { status: 'live' }, token: team.editorToken }))
          .statusCode,
      ).toBe(200);
      expect(await listedIds('', team.editorToken)).toEqual([automationPublicId]);
    });
  });

  describe('team-only (AU3)', () => {
    it('a personal organization: the reads 404 team_organization_required, the writes 422', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: [
          APP_PERMISSIONS.AUTOMATION_READ,
          APP_PERMISSIONS.AUTOMATION_CREATE,
          APP_PERMISSIONS.AUTOMATION_UPDATE,
          APP_PERMISSIONS.AUTOMATION_DELETE,
        ],
      });
      const listResponse = await list({ token: personal.token });
      expect(listResponse.statusCode).toBe(404);
      expect(errorOf(listResponse).reason).toBe('team_organization_required');
      const readResponse = await read({
        automationPublicId: generatePublicId('automation'),
        token: personal.token,
      });
      expect(errorOf(readResponse).reason).toBe('team_organization_required');
      expect(
        (await create({ body: commentAutomationBody(), token: personal.token })).statusCode,
      ).toBe(422);
      const placeholder = generatePublicId('automation');
      expect(
        (
          await edit({
            automationPublicId: placeholder,
            body: { name: 'X' },
            token: personal.token,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await remove({ automationPublicId: placeholder, token: personal.token })).statusCode,
      ).toBe(422);
    });
  });

  describe('a read-only plan (AQ8, D27, AC-5.20)', () => {
    const enforced = env.BILLING_READ_ONLY_ENFORCED;

    afterEach(() => {
      env.BILLING_READ_ONLY_ENFORCED = enforced;
    });

    it('refuses the three writes with 403 organization_read_only; the reads stay open', async () => {
      const automation = await automationOfTeam();
      await endTrialWithoutPaying(team.organization.id);
      env.BILLING_READ_ONLY_ENFORCED = true;

      for (const response of [
        await create({ body: commentAutomationBody() }),
        await edit({ automationPublicId: automation.public_id, body: { name: 'Blocked' } }),
        await remove({ automationPublicId: automation.public_id }),
      ]) {
        expect(response.statusCode).toBe(403);
        expect(errorOf(response).reason).toBe('organization_read_only');
      }
      expect((await list()).statusCode).toBe(200);
      expect((await read({ automationPublicId: automation.public_id })).statusCode).toBe(200);
      expect((await readAutomationRow(automation.public_id))?.name).toBe('Fixture automation');
    });
  });

  describe('GET /app/automations (route 11)', () => {
    it('lists the live automations with the estimated total on the first page (AC-5.16)', async () => {
      const first = await automationOfTeam({ name: 'First' });
      const second = await automationOfTeam({ name: 'Second' });
      await automationOfTeam({ deleted_at: new Date(), delete_reason: 'mistake' });

      const response = await list();
      expect(response.statusCode).toBe(200);
      const body = response.json() as ListBody;
      expect(body.data.map((automation) => automation.id)).toEqual([
        second.public_id,
        first.public_id,
      ]);
      expect(body.meta.pagination.estimated_total).toBe(2);
    });

    it('filters by status, trigger, scope, next-post status and account; searches the name (AC-5.16)', async () => {
      const liveComment = await automationOfTeam({ status: 'live', name: 'Spring SALE link' });
      const story = await automationOfTeam({
        trigger_type: 'story_reply',
        is_opening_message_enabled: false,
        name: 'Story thanks',
      });
      const waiting = await automationOfTeam({
        target_scope: 'next',
        next_post_starts_at: day(1),
        next_post_ends_at: day(3),
        next_post_status: 'waiting',
        name: 'Next one',
      });

      expect(await listedIds('status=live')).toEqual([liveComment.public_id]);
      expect(await listedIds('trigger_type=story_reply')).toEqual([story.public_id]);
      expect(await listedIds('target_scope=next')).toEqual([waiting.public_id]);
      expect(await listedIds('next_post_status=waiting')).toEqual([waiting.public_id]);
      expect(await listedIds('q=sale')).toEqual([liveComment.public_id]);
      expect(await listedIds('q=50%25_off')).toEqual([]);

      await revokeInstagramAccount({
        organizationId: team.organization.id,
        instagramAccountId: account.id,
      });
      const secondAccount = await insertInstagramAccount({ organizationId: team.organization.id });
      const onSecond = await insertAutomation({
        organizationId: team.organization.id,
        instagramAccountId: secondAccount.id,
      });
      expect(await listedIds(`instagram_account_id=${secondAccount.public_id}`)).toEqual([
        onSecond.public_id,
      ]);
      expect(await listedIds(`instagram_account_id=${account.public_id}`)).toHaveLength(3);
      expect(
        await listedIds(`instagram_account_id=${generatePublicId('instagramAccount')}`),
      ).toEqual([]);
      expect((await list({ query: 'instagram_account_id=con_abc' })).statusCode).toBe(400);
      expect((await list({ query: 'search=x' })).statusCode).toBe(400);
    });

    describe('sorts across pages, both directions (AU13, AQ9)', () => {
      it('created_at: newest first by default, oldest first with order=asc', async () => {
        const rows = [];
        for (let index = 0; index < 4; index += 1) {
          rows.push(await automationOfTeam({ name: `A${index}`, created_at: day(-10 + index) }));
        }
        const oldestFirst = rows.map((row) => row.public_id);
        expect(await pagedIds('sort=created_at', 1)).toEqual([...oldestFirst].reverse());
        expect(await pagedIds('order=asc', 3)).toEqual(oldestFirst);
      });

      it('name: A→Z by default, Z→A with order=desc', async () => {
        const zed = await automationOfTeam({ name: 'Zed' });
        const amy = await automationOfTeam({ name: 'Amy' });
        const mia = await automationOfTeam({ name: 'Mia' });
        expect(await pagedIds('sort=name', 1)).toEqual([amy, mia, zed].map((row) => row.public_id));
        expect(await pagedIds('sort=name&order=desc', 2)).toEqual(
          [zed, mia, amy].map((row) => row.public_id),
        );
      });

      it('last_triggered_at: newest first by default, never-triggered last in both directions', async () => {
        const never = await automationOfTeam({ name: 'Never' });
        const old = await automationOfTeam({ last_triggered_at: day(-5) });
        const neverToo = await automationOfTeam({ name: 'Never too' });
        const recent = await automationOfTeam({ last_triggered_at: day(-1) });
        const descending = [recent, old, never, neverToo].map((row) => row.public_id);
        const ascending = [old, recent, never, neverToo].map((row) => row.public_id);
        for (const limit of [1, 2, 3]) {
          expect(await pagedIds('sort=last_triggered_at', limit)).toEqual(descending);
          expect(await pagedIds('sort=last_triggered_at&order=asc', limit)).toEqual(ascending);
        }
      });

      it('completed_run_count: most first by default, fewest first with order=asc; ties by id', async () => {
        const five = await automationOfTeam({ completed_run_count: 5 });
        const zero = await automationOfTeam({ completed_run_count: 0 });
        const fiveToo = await automationOfTeam({ completed_run_count: 5 });
        const twelve = await automationOfTeam({ completed_run_count: 12 });
        for (const limit of [1, 2]) {
          expect(await pagedIds('sort=completed_run_count', limit)).toEqual(
            [twelve, five, fiveToo, zero].map((row) => row.public_id),
          );
          expect(await pagedIds('sort=completed_run_count&order=asc', limit)).toEqual(
            [zero, five, fiveToo, twelve].map((row) => row.public_id),
          );
        }
      });
    });
  });
});
