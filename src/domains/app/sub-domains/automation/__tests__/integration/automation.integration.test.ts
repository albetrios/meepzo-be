import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '@/shared/config/env.config.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import { seedAllPermissions } from '@/domains/tenancy/__tests__/factories/permission.factory.js';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import {
  CREATOR_PLAN_FEATURES,
  FREE_PLAN_FEATURES,
} from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
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
  endPaidPlanWithoutPaying,
  readStagedAuditRows,
  type InstagramTeamFixture,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  AUTOMATIONS_PATH,
  automationActionPath,
  automationPath,
  commentAutomationBody,
  completeAutomationSteps,
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';

/** The error body of a refusal. */
interface ErrorBody {
  code?: string;
  reason?: string;
  errors?: Array<{ field: string; reason?: string; message: string }>;
}

/**
 * Routes 27–35 of the shared automations (feat-instagram-dm-sending routes-final § 4.A, ROUTE R13)
 * over HTTP: a draft needs only a name, an account and a way to start; the list of one account with
 * its counts; go-live's every check answered together as `409 automation_not_ready` with `errors[]`
 * (account, plan, month, content, feature check, starter total, ref code, catch-all, files) and its
 * warnings; the content checks and the PRO turn-on on a live save; pause keep and cancel; duplicate;
 * delete without a reason; the keyword test; the gates, the idempotency keys, the audit entries and
 * team-only. The database, auth, permissions, idempotency and audit are real.
 */
describe('Automation routes 27–35 (shared automations, § 4.A)', () => {
  let app: FastifyInstance;
  let team: InstagramTeamFixture;
  let account: { id: number; public_id: string; channel_account_id: number };

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

  function errorOf(response: InjectHttpResult): ErrorBody {
    return (response.json() as { error: ErrorBody }).error;
  }

  function dataOf<T = Record<string, unknown>>(response: InjectHttpResult): T {
    return (response.json() as { data: T }).data;
  }

  /** Gives the team a plan with these features (Free or Creator, P83). */
  async function usePlan(features: typeof FREE_PLAN_FEATURES): Promise<void> {
    const plan = await createTestPlan({ features, priceMonthly: '29.00', priceYearly: '276.00' });
    await createTestSubscription({
      organizationId: team.organization.id,
      planId: plan.id,
      status: 'ACTIVE',
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

  /** Saves a draft on the team's account and returns its `aut_…` id. */
  async function createDraft(overrides: Record<string, unknown> = {}): Promise<string> {
    const response = await create({
      body: commentAutomationBody({ channelAccountPublicId: account.public_id, overrides }),
    });
    expect(response.statusCode).toBe(200);
    return dataOf<{ id: string }>(response).id;
  }

  function action({
    automationPublicId,
    name,
    body,
    token = team.ownerToken,
    idempotencyKey,
  }: {
    automationPublicId: string;
    name: 'go-live' | 'pause' | 'duplicate' | 'keyword-test';
    body?: unknown;
    token?: string;
    idempotencyKey?: string;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(app, {
      method: 'POST',
      url: automationActionPath({ automationPublicId, action: name }),
      token,
      headers: idempotencyKey === undefined ? {} : { 'x-idempotency-key': idempotencyKey },
      ...(body === undefined ? {} : { payload: body }),
    });
  }

  function goLive(automationPublicId: string, token = team.ownerToken) {
    return action({ automationPublicId, name: 'go-live', token });
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

  function read(automationPublicId: string, token = team.ownerToken) {
    return injectAuthenticated(app, {
      method: 'GET',
      url: automationPath(automationPublicId),
      token,
    });
  }

  function list(query: string, token = team.ownerToken) {
    return injectAuthenticated(app, { method: 'GET', url: `${AUTOMATIONS_PATH}?${query}`, token });
  }

  function remove(automationPublicId: string, query = '', token = team.ownerToken) {
    return injectAuthenticated(app, {
      method: 'DELETE',
      url: `${automationPath(automationPublicId)}${query === '' ? '' : `?${query}`}`,
      token,
    });
  }

  /** The `field: reason` pairs of a go-live refusal. */
  function problemsOf(response: InjectHttpResult): string[] {
    return (errorOf(response).errors ?? []).map((item) => `${item.field}: ${item.reason}`);
  }

  describe('route 28 — save a draft (AU11, AC-6.1, AC-6.26)', () => {
    it('saves a draft on the named account and sends nothing; without a way to start it is refused', async () => {
      const response = await create({
        body: { name: 'Guide', channel_account_id: account.public_id, trigger_type: 'comment' },
      });
      expect(response.statusCode).toBe(200);
      expect(dataOf(response)).toMatchObject({
        status: 'draft',
        channel: 'instagram',
        channel_account_id: account.public_id,
        steps: {},
        counts: { runs_started: 0 },
      });
      const refused = await create({
        body: { name: 'Guide', channel_account_id: account.public_id },
      });
      expect(refused.statusCode).toBe(400);
    });

    it('refuses an account of another organization (400) and a disconnected one (409)', async () => {
      const unknown = await create({
        body: {
          name: 'G',
          channel_account_id: generatePublicId('channelAccount'),
          trigger_type: 'comment',
        },
      });
      expect(unknown.statusCode).toBe(400);
      expect(errorOf(unknown).errors?.[0]?.field).toBe('channel_account_id');
      const revoked = await insertInstagramAccount({
        organizationId: team.organization.id,
        connectionStatus: 'revoked',
      });
      const disconnected = await create({
        body: { name: 'G', channel_account_id: revoked.public_id, trigger_type: 'comment' },
      });
      expect(disconnected.statusCode).toBe(409);
      expect(errorOf(disconnected).reason).toBe('instagram_not_connected');
    });

    it('needs an idempotency key (AC-6.26)', async () => {
      const response = await create({
        body: commentAutomationBody({ channelAccountPublicId: account.public_id }),
        idempotencyKey: null,
      });
      expect(response.statusCode).toBe(422);
    });

    it('gives a link automation a free link name and refuses one the account uses (AC-6.12)', async () => {
      const linkId = await createDraft({ trigger_type: 'ref_link' });
      const linkRow = await readAutomationRow(linkId);
      expect(linkRow?.ref_code).toMatch(/^link-[A-Za-z0-9]{4}$/);
      const clash = await create({
        body: commentAutomationBody({
          channelAccountPublicId: account.public_id,
          overrides: { trigger_type: 'ref_link', ref_code: linkRow?.ref_code },
        }),
      });
      expect(clash.statusCode).toBe(409);
      expect(errorOf(clash).reason).toBe('automation_ref_code_exists');
    });

    it('starts "Reply like a person" on for a paid plan and off on Free (D59, AC-6.13)', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const paid = await read(await createDraft());
      expect(dataOf(paid)).toMatchObject({ is_reply_like_person_enabled: true });
    });
  });

  describe("route 27 — one account's list (AU10, AC-6.2)", () => {
    it('needs the account, lists its automations with runs and % tapped, and totals the top bar', async () => {
      expect((await list('')).statusCode).toBe(400);
      const live = await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        name: 'Live one',
      });
      await createDraft({ name: 'Draft one' });
      await operatorQuery`
        INSERT INTO app.automation_counts (organization_id, automation_id, slot, runs_started, taps, typed_answers)
        VALUES (${team.organization.id}, ${live.id}, 0, 1200, 600, 12),
               (${team.organization.id}, ${live.id}, 5, 100, 50, 1)`;
      const response = await list(`channel_account_id=${account.public_id}&sort=name&order=asc`);
      expect(response.statusCode).toBe(200);
      const rows = dataOf<Array<Record<string, unknown>>>(response);
      expect(
        rows.map((row) => [row.name, row.status, row.runs_started, row.tapped_percent]),
      ).toEqual([
        ['Draft one', 'draft', 0, null],
        ['Live one', 'live', 1300, 51],
      ]);
      expect((response.json() as { meta: { totals: unknown } }).meta.totals).toEqual({
        live_count: 1,
        runs_started: 1300,
      });
      const drafts = await list(`channel_account_id=${account.public_id}&status=draft`);
      expect(dataOf<unknown[]>(drafts)).toHaveLength(1);
      const unknown = await list(`channel_account_id=${generatePublicId('channelAccount')}`);
      expect(dataOf<unknown[]>(unknown)).toEqual([]);
    });
  });

  describe('route 32 — go live (AU13)', () => {
    it('goes live, writes its audit entry, and a repeat changes nothing (AU3, AC-6.27)', async () => {
      const automationId = await createDraft();
      const response = await goLive(automationId);
      expect(response.statusCode).toBe(200);
      expect(dataOf(response)).toMatchObject({ status: 'live' });
      const again = await goLive(automationId);
      expect(again.statusCode).toBe(200);
      const audits = await readStagedAuditRows({
        organizationPublicId: team.organization.public_id,
        action: 'app.automation.go_live',
      });
      expect(audits).toHaveLength(1);
    });

    it('lists every problem with its step and changes nothing (AC-6.3, AC-6.4)', async () => {
      const automationId = await createDraft({
        trigger_type: 'dm_keyword',
        steps: {
          hello: {
            on: true,
            versions: [
              {
                text: 'Hi',
                buttons: [{ title: 'Shop', action: 'link', url: 'https://x.example' }],
              },
            ],
          },
          email: { on: true, wordings: [] },
          messages: [],
          tags: { on: true, list: [] },
        },
      });
      const response = await goLive(automationId);
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).reason).toBe('automation_not_ready');
      expect(problemsOf(response)).toEqual(
        expect.arrayContaining([
          'keywords: missing',
          'steps.hello.versions.0.buttons: next_button_missing',
          'steps.email.wordings: count',
          'steps.messages: count',
          'steps.tags.list: count',
          'features.email_ask: plan_lacks_feature',
        ]),
      );
      expect((await readAutomationRow(automationId))?.status).toBe('draft');
    });

    it('on Free, a draft with an email step saves; its go-live names the email ask (AC-6.7)', async () => {
      await usePlan(FREE_PLAN_FEATURES);
      const automationId = await createDraft({
        steps: completeAutomationSteps({ email: { on: true, wordings: ['Your email?'] } }),
      });
      const response = await goLive(automationId);
      expect(response.statusCode).toBe(409);
      expect(problemsOf(response)).toEqual(['features.email_ask: plan_lacks_feature']);
    });

    it('lists the month limit reached and the account not connected (AC-6.8)', async () => {
      const automationId = await createDraft();
      await usePlan(FREE_PLAN_FEATURES);
      await operatorQuery`
        INSERT INTO app.message_month_counts (organization_id, month_start, slot, count)
        VALUES (${team.organization.id}, date_trunc('month', now() AT TIME ZONE 'UTC')::date, 0, 1000),
               (${team.organization.id}, date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')::date, 1, 1000)
        ON CONFLICT DO NOTHING`;
      await operatorQuery`
        UPDATE app.channel_accounts SET connection_status = 'error' WHERE id = ${account.channel_account_id}`;
      const refused = await goLive(automationId);
      expect(refused.statusCode).toBe(409);
      expect(problemsOf(refused)).toEqual([
        'channel_account_id: account_not_connected',
        'channel_account_id: month_limit_reached',
      ]);
    });

    it('refuses the Meta-tested ways and kinds with feature_not_offered (P36, AC-6.9)', async () => {
      const repost = await createDraft({
        trigger_type: 'story_repost',
        steps: { messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }] },
      });
      expect(problemsOf(await goLive(repost))).toEqual(['trigger_type: feature_not_offered']);
      const cards = await createDraft({
        steps: completeAutomationSteps({
          messages: [{ kind: 'cards', wait_minutes: 0, cards: [{ title: 'A', subtitle: 'B' }] }],
        }),
      });
      expect(problemsOf(await goLive(cards))).toEqual(['steps.messages: feature_not_offered']);
    });

    it('allows one live first-message automation per account, naming the one that answers (AC-6.10)', async () => {
      const steps = { messages: [{ kind: 'text', wait_minutes: 0, text: 'Welcome' }] };
      const first = await createDraft({ trigger_type: 'first_message', name: 'Welcome A', steps });
      const second = await createDraft({ trigger_type: 'first_message', name: 'Welcome B', steps });
      expect((await goLive(first)).statusCode).toBe(200);
      const refused = await goLive(second);
      expect(problemsOf(refused)).toEqual(['trigger_type: catch_all_taken']);
      expect(errorOf(refused).errors?.[0]?.message).toContain('Welcome A');
    });

    it('refuses a fifth live starter question on the account (AC-6.11)', async () => {
      await usePlan(CREATOR_PLAN_FEATURES);
      const steps = { messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }] };
      const three = await createDraft({
        trigger_type: 'starter_question',
        starter_questions: ['One?', 'Two?', 'Three?'],
        steps,
      });
      expect((await goLive(three)).statusCode).toBe(200);
      const two = await createDraft({
        trigger_type: 'starter_question',
        starter_questions: ['Four?', 'Five?'],
        steps,
      });
      expect(problemsOf(await goLive(two))).toEqual([
        'starter_questions: starter_questions_over_limit',
      ]);
    });

    it('refuses a file not uploaded and checked (AC-6.14, D58)', async () => {
      const automationId = await createDraft({
        steps: completeAutomationSteps({
          messages: [{ kind: 'file', wait_minutes: 0, upload_id: generatePublicId('upload') }],
        }),
      });
      expect(problemsOf(await goLive(automationId))).toEqual([
        'steps.messages.0.upload_id: file_not_usable',
      ]);
    });

    it('only warns about a shared keyword and a private account on a comment kind (AC-6.5)', async () => {
      await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        name: 'GUIDE 2',
        keywords: ['guide'],
      });
      await operatorQuery`UPDATE app.instagram_accounts SET is_private = true WHERE id = ${account.id}`;
      const automationId = await createDraft({ keywords: ['guide'] });
      const response = await goLive(automationId);
      expect(response.statusCode).toBe(200);
      const warnings = (
        response.json() as { meta: { warnings: Array<{ reason: string; detail: string }> } }
      ).meta.warnings;
      expect(warnings.map((warning) => warning.reason)).toEqual([
        'keyword_shared',
        'account_private',
      ]);
      expect(warnings[0]?.detail).toContain('GUIDE 2');
    });
  });

  describe('a read-only plan (AU4 (1), P10, AC-6.8, AC-6.24)', () => {
    const enforced = env.BILLING_READ_ONLY_ENFORCED;

    afterEach(() => {
      env.BILLING_READ_ONLY_ENFORCED = enforced;
    });

    it('refuses go-live with 403 organization_read_only; drafts, pause and delete stay open', async () => {
      const live = await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        steps: completeAutomationSteps(),
      });
      await endPaidPlanWithoutPaying(team.organization.id);
      env.BILLING_READ_ONLY_ENFORCED = true;

      const draft = await create({
        body: commentAutomationBody({ channelAccountPublicId: account.public_id }),
      });
      expect(draft.statusCode).toBe(200);
      const refused = await goLive(dataOf<{ id: string }>(draft).id);
      expect(refused.statusCode).toBe(403);
      expect(errorOf(refused).reason).toBe('organization_read_only');
      const paused = await action({
        automationPublicId: live.public_id,
        name: 'pause',
        body: { mode: 'keep' },
      });
      expect(paused.statusCode).toBe(200);
      expect((await remove(live.public_id)).statusCode).toBe(204);
    });
  });

  describe('route 30 — save content (AU12, AC-6.6)', () => {
    it('saves anything on a draft; on a live one refuses a content problem and saves nothing', async () => {
      const automationId = await createDraft();
      expect(
        (await edit({ automationPublicId: automationId, body: { steps: { messages: [] } } }))
          .statusCode,
      ).toBe(200);
      await edit({ automationPublicId: automationId, body: { steps: completeAutomationSteps() } });
      await goLive(automationId);
      const refused = await edit({
        automationPublicId: automationId,
        body: { steps: { messages: [] } },
      });
      expect(refused.statusCode).toBe(400);
      expect(errorOf(refused).errors?.map((item) => item.field)).toContain('body.steps.messages');
      expect((await readAutomationRow(automationId))?.steps).toEqual(completeAutomationSteps());
    });

    it('refuses turning a PRO part on without PRO, keeps one already on, and keeps the way to start in its group', async () => {
      await usePlan(FREE_PLAN_FEATURES);
      const live = await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        steps: completeAutomationSteps({ email: { on: true, wordings: ['Email?'] } }),
      });
      const turnOn = await edit({
        automationPublicId: live.public_id,
        body: {
          steps: completeAutomationSteps({
            email: { on: true, wordings: ['Email?'] },
            phone: { on: true, wordings: ['Phone?'] },
          }),
        },
      });
      expect(turnOn.statusCode).toBe(403);
      expect(errorOf(turnOn).reason).toBe('plan_lacks_feature');
      const keepsIt = await edit({ automationPublicId: live.public_id, body: { name: 'Renamed' } });
      expect(keepsIt.statusCode).toBe(200);
      expect(dataOf(keepsIt)).toMatchObject({ name: 'Renamed', pro_parts_off: ['email_ask'] });
      const otherGroup = await edit({
        automationPublicId: live.public_id,
        body: { trigger_type: 'dm_keyword' },
      });
      expect(otherGroup.statusCode).toBe(400);
    });
  });

  describe('routes 33 and 34 — pause and duplicate (AU14, AU15)', () => {
    it('pause keep, then cancel sets the cut-off; a draft cannot pause; go live again from paused (AC-6.15, AC-6.16)', async () => {
      const draft = await createDraft();
      const refused = await action({
        automationPublicId: draft,
        name: 'pause',
        body: { mode: 'keep' },
      });
      expect(refused.statusCode).toBe(409);
      expect(errorOf(refused).reason).toBe('transition_not_allowed');
      await goLive(draft);
      const kept = await action({
        automationPublicId: draft,
        name: 'pause',
        body: { mode: 'keep' },
      });
      expect(dataOf(kept)).toMatchObject({ status: 'paused', cancelled_before_at: null });
      const cancelled = await action({
        automationPublicId: draft,
        name: 'pause',
        body: { mode: 'cancel' },
      });
      expect(dataOf(cancelled)).toMatchObject({
        status: 'paused',
        cancelled_before_at: expect.any(String),
      });
      expect((await goLive(draft)).statusCode).toBe(200);
      expect((await readAutomationRow(draft))?.status).toBe('live');
    });

    it('duplicates as a draft "(copy)" with counters at 0 and a new link name (AC-6.17)', async () => {
      const source = await createDraft({
        trigger_type: 'ref_link',
        ref_code: 'spring',
        name: 'Spring',
      });
      const copy = await action({
        automationPublicId: source,
        name: 'duplicate',
        idempotencyKey: randomUUID(),
      });
      expect(copy.statusCode).toBe(200);
      expect(dataOf(copy)).toMatchObject({
        name: 'Spring (copy)',
        status: 'draft',
        counts: { runs_started: 0 },
        ref_code: expect.stringMatching(/^spring-[A-Za-z0-9]{4}$/),
      });
      const withoutKey = await action({ automationPublicId: source, name: 'duplicate' });
      expect(withoutKey.statusCode).toBe(422);
    });
  });

  describe('route 31 — delete (AU16, P11, AC-6.18)', () => {
    it('deletes without a reason; other needs a note; it is gone from list and read', async () => {
      const automationId = await createDraft();
      expect((await remove(automationId, 'reason=other')).statusCode).toBe(400);
      expect((await remove(automationId)).statusCode).toBe(204);
      expect((await read(automationId)).statusCode).toBe(404);
      expect(dataOf<unknown[]>(await list(`channel_account_id=${account.public_id}`))).toEqual([]);
    });
  });

  describe('route 35 — the keyword test (AU17, AC-6.20, AC-6.21)', () => {
    it('answers the match, exact or close, and which automation answers first; it saves nothing', async () => {
      const older = await insertAutomation({
        organizationId: team.organization.id,
        channelAccountId: account.channel_account_id,
        status: 'live',
        name: 'Older guide',
        keywords: ['free guide'],
      });
      const automationId = await createDraft({ keywords: ['free guide'] });
      await goLive(automationId);
      const close = await action({
        automationPublicId: automationId,
        name: 'keyword-test',
        body: { text: 'Can I get the FREE guida please' },
      });
      expect(close.statusCode).toBe(200);
      expect(dataOf(close)).toEqual({
        is_match: false,
        matched_keyword: 'free guide',
        match_kind: 'close',
        first_answering_automation: { id: older.public_id, name: 'Older guide' },
        reason: 'other_answers_first',
      });
      const shortWord = await action({
        automationPublicId: older.public_id,
        name: 'keyword-test',
        body: { text: 'fret guide' },
      });
      expect(dataOf(shortWord)).toMatchObject({ is_match: false, reason: 'no_keyword' });
      const exact = await action({
        automationPublicId: older.public_id,
        name: 'keyword-test',
        body: { text: 'the free guide' },
      });
      expect(dataOf(exact)).toMatchObject({ is_match: true, match_kind: 'exact', reason: null });
    });
  });

  describe('gates, team-only and audit (AC-6.25, AC-6.27)', () => {
    it('lets a Viewer read and refuses every write with missing_permission; an Editor may do them all', async () => {
      const automationId = await createDraft();
      expect((await read(automationId, team.viewerToken)).statusCode).toBe(200);
      const writes = [
        create({
          body: commentAutomationBody({ channelAccountPublicId: account.public_id }),
          token: team.viewerToken,
        }),
        edit({ automationPublicId: automationId, body: { name: 'X' }, token: team.viewerToken }),
        goLive(automationId, team.viewerToken),
        action({
          automationPublicId: automationId,
          name: 'pause',
          body: { mode: 'keep' },
          token: team.viewerToken,
        }),
        action({
          automationPublicId: automationId,
          name: 'duplicate',
          token: team.viewerToken,
          idempotencyKey: randomUUID(),
        }),
        remove(automationId, '', team.viewerToken),
      ];
      for (const response of await Promise.all(writes)) {
        expect(response.statusCode).toBe(403);
        expect(errorOf(response).reason).toBe('missing_permission');
      }
      const editorDraft = await create({
        body: commentAutomationBody({ channelAccountPublicId: account.public_id }),
        token: team.editorToken,
      });
      const editorId = dataOf<{ id: string }>(editorDraft).id;
      expect(
        (await edit({ automationPublicId: editorId, body: { name: 'E' }, token: team.editorToken }))
          .statusCode,
      ).toBe(200);
      expect((await goLive(editorId, team.editorToken)).statusCode).toBe(200);
      expect(
        (
          await action({
            automationPublicId: editorId,
            name: 'pause',
            body: { mode: 'keep' },
            token: team.editorToken,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await action({
            automationPublicId: editorId,
            name: 'duplicate',
            token: team.editorToken,
            idempotencyKey: randomUUID(),
          })
        ).statusCode,
      ).toBe(200);
      expect((await remove(editorId, '', team.editorToken)).statusCode).toBe(204);
    });

    it('leaves one audit entry per create, edit, go-live, pause, duplicate and delete', async () => {
      const automationId = await createDraft();
      await edit({ automationPublicId: automationId, body: { name: 'Renamed' } });
      await goLive(automationId);
      await action({ automationPublicId: automationId, name: 'pause', body: { mode: 'cancel' } });
      await action({
        automationPublicId: automationId,
        name: 'duplicate',
        idempotencyKey: randomUUID(),
      });
      await remove(automationId, 'reason=duplicate');
      for (const actionName of [
        'app.automation.create',
        'app.automation.update',
        'app.automation.go_live',
        'app.automation.pause',
        'app.automation.duplicate',
        'app.automation.delete',
      ]) {
        const rows = await readStagedAuditRows({
          organizationPublicId: team.organization.public_id,
          action: actionName,
        });
        expect(rows, actionName).toHaveLength(1);
      }
    });

    it('is team-only: a personal organization reads 404 and writes 422', async () => {
      const personal = await createPersonalOrganizationWithInstagramCodes({
        permissionCodes: ['automation:read', 'automation:create'],
      });
      const readResponse = await list(`channel_account_id=${account.public_id}`, personal.token);
      expect(readResponse.statusCode).toBe(404);
      expect(errorOf(readResponse).reason).toBe('team_organization_required');
      const write = await create({
        body: commentAutomationBody({ channelAccountPublicId: account.public_id }),
        token: personal.token,
      });
      expect(write.statusCode).toBe(422);
    });

    it("answers 404 automation_not_found for another organization's automation — read and every action, the row unchanged", async () => {
      const other = await createInstagramTeam();
      const otherAccount = await insertInstagramAccount({ organizationId: other.organization.id });
      const foreign = await insertAutomation({
        organizationId: other.organization.id,
        channelAccountId: otherAccount.channel_account_id,
      });
      const response = await read(foreign.public_id);
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).reason).toBe('automation_not_found');
      for (const response of [
        await goLive(foreign.public_id),
        await action({
          automationPublicId: foreign.public_id,
          name: 'pause',
          body: { mode: 'keep' },
        }),
        await action({
          automationPublicId: foreign.public_id,
          name: 'duplicate',
          idempotencyKey: randomUUID(),
        }),
        await action({
          automationPublicId: foreign.public_id,
          name: 'keyword-test',
          body: { text: 'price' },
        }),
      ]) {
        expect(response.statusCode).toBe(404);
        expect(errorOf(response).reason).toBe('automation_not_found');
      }
      expect(await readAutomationRow(foreign.public_id)).toEqual(foreign);
    });
  });
});
