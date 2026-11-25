import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRINCIPAL_SCOPE,
  withAppDatabaseContext,
} from '@/infrastructure/database/contexts/database-context.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import type { AutomationRunChannelAccount } from '@/domains/app/sub-domains/channel-account/channel-account.types.js';
import { ContactRepository } from '@/domains/app/sub-domains/contact/contact.repository.js';
import { ContactService } from '@/domains/app/sub-domains/contact/contact.service.js';
import { automation_counts } from '@/domains/app/sub-domains/automation/automation-count.schema.js';
import { AutomationCountRepository } from '@/domains/app/sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from '@/domains/app/sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from '@/domains/app/sub-domains/automation/automation-reply-state.service.js';
import type { AutomationSteps } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import type { AutomationRunEvent } from '@/domains/app/sub-domains/automation/automation-run/automation-run.types.js';
import {
  type ContactFixtureRow,
  insertContact,
  insertInstagramAccount,
  readContactRow,
  updateContactActivity,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  insertAutomationRun,
  nextInstagramObjectId,
  readCommentLogRows,
  readOpenRunKeys,
  readRunEventTrail,
  readRunRow,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  RecordingSendingPort,
  reportMessageResult,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { createTestOrganization } from '@/tests/factories/organization.factory.js';
import { createTestUser } from '@/tests/factories/user.factory.js';
import { cleanupDatabase } from '@/tests/helpers/test-database.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * The run engine against the database, behind a recording sending port (feat-instagram-dm-sending
 * routes-final § 4.B — AUC10, AUC14, AUC15; AC-6.22): it decides and never sends — every step a
 * waiting message through `ChannelSendingPort`, every result back through `recordMessageResult`.
 * Covers a comment's whole run (hello, public reply and hide, the tap, follow, email, the list, tags),
 * the once key, a comment replacing her open run in one commit (P35), `run_in_progress`, an `unknown`
 * result never sent again by itself, a move down skipping email and phone, a closed window, the
 * counts per hello version, the open keys and the month parts. Every unit runs in the organization's
 * own job scope (`pnpm test:rls-role` safe).
 */

const POST = '17900000000000001';
const OTHER_POST = '17900000000000002';

/** A hello with a "sends your next step" button, one text message, the given extras. */
function stepsWith(extra: Partial<AutomationSteps> = {}): AutomationSteps {
  return {
    hello: {
      on: true,
      versions: [{ text: 'Hey! Want the guide?', buttons: [{ title: 'Send it', action: 'next' }] }],
    },
    messages: [{ kind: 'text', wait_minutes: 0, text: 'Here it is' }],
    ...extra,
  };
}

describe('AutomationRunService (database, recording sending port)', () => {
  let organization: { id: number; public_id: string };
  let account: { id: number; public_id: string; channel_account_id: number };
  let contact: ContactFixtureRow;
  let port: RecordingSendingPort;
  let accountRules: { isCommentReplyTriggerEnabled: boolean; isOncePerPersonPerPost: boolean };
  let planSwitches: Record<string, boolean> | null;
  let draws: number[];
  let service: AutomationRunService;

  beforeEach(async () => {
    await cleanupDatabase();
    organization = await createTestOrganization({ ownerUserId: (await createTestUser()).id });
    account = await insertInstagramAccount({ organizationId: organization.id });
    contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      username: 'jordan.lee',
    });
    port = new RecordingSendingPort();
    accountRules = { isCommentReplyTriggerEnabled: true, isOncePerPersonPerPost: true };
    planSwitches = {
      email_ask: true,
      phone_ask: true,
      message_versions: true,
      reply_like_person: true,
    };
    draws = [];
    const runAccount = (): AutomationRunChannelAccount => ({
      organizationId: organization.id,
      id: account.channel_account_id,
      public_id: account.public_id,
      channel: 'instagram',
      connection_status: 'connected',
      is_automation_enabled: true,
      time_zone: 'UTC',
      is_comment_reply_trigger_enabled: accountRules.isCommentReplyTriggerEnabled,
      is_once_per_person_per_post_enabled: accountRules.isOncePerPersonPerPost,
    });
    service = new AutomationRunService({
      channelAccountService: {
        readAutomationRunAccount: async ({ channelAccountPublicId }) =>
          channelAccountPublicId === account.public_id ? runAccount() : null,
      },
      contactService: new ContactService(
        new ContactRepository(),
        {} as OrganizationService,
        [],
        async () => null,
      ),
      planAccessService: {
        getPlanAccess: (async () => ({
          features: planSwitches === null ? null : { feature_switches: planSwitches },
        })) as never,
      },
      countService: new AutomationCountService(new AutomationCountRepository()),
      replyStateService: new AutomationReplyStateService(new AutomationReplyStateRepository()),
      sendingPorts: { instagram: port },
      drawInteger: (maxExclusive) => Math.min(draws.shift() ?? 0, maxExclusive - 1),
    });
  });

  const scope = () => PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });

  function event(
    eventKey: string,
    eventId = eventKey.split(':')[1] ?? eventKey,
  ): AutomationRunEvent {
    return { eventKey, eventId, occurredAt: new Date(), isLastAttempt: false };
  }

  async function freshContact(): Promise<ContactFixtureRow> {
    const row = await readContactRow(contact.id);
    if (row === undefined) throw new Error('contact vanished');
    return row;
  }

  function liveAutomation(
    overrides: Parameters<typeof insertAutomation>[0] extends infer T
      ? Omit<T, 'organizationId' | 'channelAccountId'>
      : never,
  ): Promise<AutomationFixtureRow> {
    return insertAutomation({
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
      status: 'live',
      steps: stepsWith(),
      ...overrides,
    });
  }

  async function comment({
    mediaId = POST,
    commentId = nextInstagramObjectId(),
    text = 'guide please',
    parentCommentId = null,
  }: {
    mediaId?: string;
    commentId?: string;
    text?: string;
    parentCommentId?: string | null;
  } = {}) {
    const result = await service.startCommentRun({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(`comment:${commentId}`),
      kind: 'comment',
      commentId,
      mediaId,
      parentCommentId,
      text,
      commenterUsername: 'jordan.lee',
    });
    return { result, commentId };
  }

  async function directMessage(
    text: string,
    kind: 'message' | 'story_reply' = 'message',
    storyId?: string,
  ) {
    return service.handleDirectMessage({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(`message:m_${nextInstagramObjectId()}`),
      kind,
      text,
      quickReplyPayload: null,
      attachmentEmail: null,
      ...(storyId === undefined ? {} : { storyId }),
    });
  }

  async function tap(runPublicId: string, automationPublicId: string) {
    return service.handleButtonClick({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(`postback:p_${nextInstagramObjectId()}`),
      kind: 'postback',
      automationPublicId,
      runPublicId,
    });
  }

  function report(
    step: Parameters<RecordingSendingPort['last']>[0],
    result: 'sent' | 'failed' | 'skipped' | 'unknown',
    reason: string | null = null,
  ) {
    return reportMessageResult({
      service,
      scope: scope(),
      organizationId: organization.id,
      message: port.last(step),
      result,
      reason,
    });
  }

  async function countsOf(automationId: number) {
    const rows = await getOperatorDatabase()
      .select()
      .from(automation_counts)
      .where(eq(automation_counts.automation_id, automationId));
    const sum = (key: 'runs_started' | 'taps' | 'typed_answers') =>
      rows.reduce((total, row) => total + Number(row[key]), 0);
    const byVersion = (key: 'runs_by_version' | 'taps_by_version' | 'typed_by_version') =>
      rows.reduce<Record<string, number>>((all, row) => {
        for (const [version, value] of Object.entries(row[key])) {
          all[version] = (all[version] ?? 0) + Number(value);
        }
        return all;
      }, {});
    return {
      runsStarted: sum('runs_started'),
      taps: sum('taps'),
      typedAnswers: sum('typed_answers'),
      runsByVersion: byVersion('runs_by_version'),
      tapsByVersion: byVersion('taps_by_version'),
      typedByVersion: byVersion('typed_by_version'),
    };
  }

  it('runs a comment end to end through waiting messages — it never sends (AU24, AU35)', async () => {
    const automation = await liveAutomation({
      keywords: ['guide'],
      is_public_reply_enabled: true,
      public_reply_texts: ['Sent you a DM!'],
      is_hide_comment_after_direct_message_enabled: true,
      steps: stepsWith({
        follow: {
          on: true,
          versions: [
            {
              text: 'Follow first',
              profile_button_title: 'Profile',
              following_button_title: "I'm following",
            },
          ],
        },
        email: { on: true, wordings: ['Your email?', 'Drop your email'] },
        tags: { on: true, list: ['lead'] },
      }),
    });
    const { result, commentId } = await comment();
    expect(result.outcome).toBe('run_started');
    const [run] = await readRunRows(organization.id);
    expect(run).toMatchObject({
      status: 'running',
      current_step: 'comment_reply',
      trigger_type: 'comment',
      once_key: POST,
      version_numbers: { hello: 1, follow: 1 },
    });
    expect(port.steps()).toEqual(['hello']);
    expect(port.last('hello')).toMatchObject({
      answersEventId: commentId,
      content: { stepPath: 'steps.hello.versions.0', uploadPublicIds: [] },
      triggerOccurredAt: expect.any(Date),
      // A comment's opening DM is timed by the box, never her answer's delay (§30.12 rule 3, R44).
      organizationPublicId: organization.public_id,
      answerDelay: 'next',
    });
    expect(await readOpenRunKeys(organization.id)).toEqual([
      `${automation.id}:${contact.id}:${run!.id}`,
    ]);
    expect((await freshContact()).first_automation_id).toBe(automation.id);

    // The hello went: public reply and hide after the first DM, then the run waits for her tap.
    await report('hello', 'sent');
    expect(port.steps()).toEqual(['hello', 'public_reply', 'hide_comment']);
    expect(await readRunRow(run!.id)).toMatchObject({
      status: 'waiting',
      waiting_for: 'opening_message_button',
      direct_message_sent_at: expect.any(Date),
    });
    const [log] = await readCommentLogRows(organization.id);
    expect(log).toMatchObject({
      opening_dm_status: 'sent',
      public_reply_status: 'waiting',
      hide_status: 'waiting',
      automation_run_id: run!.id,
    });

    // Her tap: the follow check (a read), not following → the ask; her "I'm following" tap → read.
    await tap(run!.public_id, automation.public_id);
    expect(port.steps().at(-1)).toBe('follow_check');
    // The first answer to her tap waits its delay (with the PRO extra delay), R44.
    expect(port.last('follow_check')).toMatchObject({ answerDelay: 'answer' });
    await report('follow_check', 'sent', 'not_following');
    expect(port.steps().at(-1)).toBe('follow');
    await report('follow', 'sent');
    expect((await readRunRow(run!.id))?.waiting_for).toBe('follow');
    await tap(run!.public_id, automation.public_id);
    await report('follow_check', 'sent', 'following');

    // Email: a wrong answer asks again with the other wording; a right one moves on. After the
    // check the next step goes at once — the check sent her nothing (§30.2 step 13, R44).
    expect(port.last('email')).toMatchObject({ wordingNumber: 1, answerDelay: 'none' });
    await report('email', 'sent');
    expect((await directMessage('not an email')).outcome).toBe('answer_invalid');
    expect(port.last('email')).toMatchObject({ wordingNumber: 2 });
    await report('email', 'sent');
    expect((await directMessage('jordan@example.com')).outcome).toBe('run_continued');
    expect((await freshContact()).email).toBe('jordan@example.com');

    // The list: message 1, then the tags and `completed`; its open key goes in that commit.
    expect(port.last('messages')).toMatchObject({ messageNumber: 1, messageKind: 'text' });
    await report('messages', 'sent');
    expect(await readRunRow(run!.id)).toMatchObject({
      status: 'completed',
      last_message_number: 1,
    });
    expect(await readOpenRunKeys(organization.id)).toEqual([]);
    expect((await freshContact()).tags).toEqual(['lead']);
    expect(await readRunEventTrail(run!.id)).toEqual([
      'status_changed:running',
      'status_changed:waiting',
      'hello_tapped:-',
      'status_changed:running',
      'status_changed:waiting',
      'follow_tapped:-',
      'status_changed:running',
      'status_changed:waiting',
      'status_changed:running',
      'status_changed:waiting',
      'email_received:-',
      'status_changed:running',
      'status_changed:completed',
    ]);
  });

  it('counts runs, hello taps and typed answers per hello version in the event commit, and keeps them after the run is gone (AC-6.22)', async () => {
    const automation = await liveAutomation({
      steps: stepsWith({
        hello: {
          on: true,
          versions: [
            { text: 'A', buttons: [{ title: 'Go', action: 'next' }] },
            { text: 'B', buttons: [{ title: 'Go', action: 'next' }] },
          ],
        },
      }),
    });
    draws.push(1);
    await comment();
    const [run] = await readRunRows(organization.id);
    expect(run?.version_numbers).toMatchObject({ hello: 2 });
    await report('hello', 'sent');
    // Her first text while the run waits for the hello's tap is a typed answer.
    await directMessage('yes please');
    await report('messages', 'sent');
    expect(await countsOf(automation.id)).toMatchObject({
      runsStarted: 1,
      typedAnswers: 1,
      taps: 0,
      runsByVersion: { 'hello.2': 1 },
      typedByVersion: { 'hello.2': 1 },
    });
    // A second person taps the button: counted once, as a tap.
    contact = await insertContact({
      organizationId: organization.id,
      instagramAccountId: account.id,
      username: 'riya',
    });
    draws.push(0);
    await comment();
    const second = (await readRunRows(organization.id)).find(
      (row) => row.contact_id === contact.id,
    );
    await report('hello', 'sent');
    await tap(second!.public_id, automation.public_id);
    await tap(second!.public_id, automation.public_id);
    const counts = await countsOf(automation.id);
    expect(counts).toMatchObject({ runsStarted: 2, taps: 1, tapsByVersion: { 'hello.1': 1 } });
    // The counts have no key to the runs: a part drop (here a delete) leaves them.
    await getOperatorDatabase().execute(
      sql`DELETE FROM app.automation_runs WHERE organization_id = ${organization.id}`,
    );
    expect(await countsOf(automation.id)).toEqual(counts);
  });

  it('the once key: a second comment on the same post is ignored once_per_post, open or done (AU22)', async () => {
    await liveAutomation({ keywords: ['guide'] });
    await comment();
    const { result: whileOpen } = await comment();
    expect(whileOpen.outcome).toBe('comment_logged');
    await report('hello', 'sent');
    const { result: afterDm } = await comment();
    expect(afterDm.outcome).toBe('comment_logged');
    const logs = await readCommentLogRows(organization.id);
    expect(logs.map((log) => log.ignored_reason)).toEqual([null, 'once_per_post', 'once_per_post']);
    expect(await readRunRows(organization.id)).toHaveLength(1);
  });

  it('a comment on another post replaces her open run in one commit (P35, AU23, AU37)', async () => {
    const automation = await liveAutomation({ keywords: ['guide'] });
    await comment({ mediaId: POST });
    const [first] = await readRunRows(organization.id);
    const { result } = await comment({ mediaId: OTHER_POST });
    expect(result.outcome).toBe('run_replaced');
    const [old, replacement] = await readRunRows(organization.id);
    expect(old).toMatchObject({ id: first!.id, status: 'cancelled', cancel_reason: 'replaced' });
    expect(replacement).toMatchObject({ status: 'running', once_key: OTHER_POST });
    expect(port.skipped).toEqual([
      { organizationId: organization.id, by: 'run', id: first!.id, reason: 'replaced' },
    ]);
    expect(await readOpenRunKeys(organization.id)).toEqual([
      `${automation.id}:${contact.id}:${replacement!.id}`,
    ]);
    expect((await readCommentLogRows(organization.id)).map((log) => log.overall_status)).toEqual([
      'cancelled',
      'started',
    ]);
  });

  it('any other start while her run is open is ignored run_in_progress (AU23)', async () => {
    await liveAutomation({ trigger_type: 'story_reply', keywords: [] });
    expect((await directMessage('love it', 'story_reply', '17910000000000001')).outcome).toBe(
      'run_started',
    );
    expect((await directMessage('and this', 'story_reply', '17910000000000002')).outcome).toBe(
      'ignored',
    );
    expect(await readRunRows(organization.id)).toHaveLength(1);
  });

  it('an unknown result is never sent again by itself: the run waits for any message of hers (D17, AU25)', async () => {
    await liveAutomation({ trigger_type: 'dm_keyword', keywords: ['price'] });
    await directMessage('price?');
    const [run] = await readRunRows(organization.id);
    await report('hello', 'unknown');
    expect(await readRunRow(run!.id)).toMatchObject({
      status: 'waiting',
      waiting_for: 'any',
      direct_message_sent_at: expect.any(Date),
    });
    expect(port.steps()).toEqual(['hello']);
    expect((await directMessage('hello?')).outcome).toBe('run_continued');
    expect(port.steps()).toEqual(['hello', 'hello']);
    expect((await readRunRow(run!.id))?.status).toBe('running');
  });

  it('a move down skips the email and phone asks, and a waiting email run moves on (AU26, D57)', async () => {
    planSwitches = {};
    await liveAutomation({
      trigger_type: 'dm_keyword',
      keywords: ['price'],
      steps: stepsWith({
        hello: { on: false, versions: [] },
        email: { on: true, wordings: ['Email?'] },
        phone: { on: true, wordings: ['Phone?'] },
      }),
    });
    await directMessage('price');
    expect(port.steps()).toEqual(['messages#1']);
  });

  it('a run waiting for her email when the move down takes effect moves on to its next step at her next message (AC-23.4)', async () => {
    await liveAutomation({
      trigger_type: 'dm_keyword',
      keywords: ['price'],
      steps: stepsWith({
        hello: { on: false, versions: [] },
        email: { on: true, wordings: ['Email?'] },
      }),
    });
    await directMessage('price');
    expect(port.steps()).toEqual(['email']);
    // The ask is sent: the run now waits for her email.
    await report('email', 'sent');
    const [waiting] = await readRunRows(organization.id);
    expect(waiting).toMatchObject({ waiting_for: 'email' });

    // The move down takes effect: the plan's email ask is off; her next message moves the run on.
    planSwitches = {};
    const answered = await directMessage('hi again');
    expect(answered.outcome).toBe('run_continued');
    expect(port.steps()).toEqual(['email', 'messages#1']);
  });

  it('a list message whose window closed cancels the run window_closed; a failed one fails it (D29)', async () => {
    const automation = await liveAutomation({
      trigger_type: 'dm_keyword',
      keywords: ['price'],
      steps: stepsWith({ hello: { on: false, versions: [] } }),
    });
    port.nextSkips.push('window_closed');
    await directMessage('price');
    const [closed] = await readRunRows(organization.id);
    expect(closed).toMatchObject({ status: 'cancelled', cancel_reason: 'window_closed' });
    expect(await readOpenRunKeys(organization.id)).toEqual([]);

    await getOperatorDatabase()
      .update(automation_runs)
      .set({ once_key: 'dm:elsewhere' })
      .where(eq(automation_runs.id, closed!.id));
    await directMessage('price');
    await report('messages', 'failed', 'user_not_found');
    const failed = (await readRunRows(organization.id)).at(-1);
    expect(failed).toMatchObject({ status: 'failed', automation_id: automation.id });
    expect(failed?.error_message).toContain('user_not_found');
  });

  it('a tag start needs her window open and stops at chain 3; its tags go one chain further (D45)', async () => {
    const source = await liveAutomation({
      trigger_type: 'tag_added',
      trigger_tag: 'vip',
      steps: stepsWith({
        hello: { on: false, versions: [] },
        tags: { on: true, list: ['nurtured'] },
      }),
    });
    const tagInput = async (chainNumber: number) => ({
      scope: scope(),
      channelAccountPublicId: account.public_id,
      contact: await freshContact(),
      event: event(`tag:${chainNumber}`),
      change: 'added' as const,
      tag: 'vip',
      tagEventId: 100 + chainNumber,
      chainNumber,
      sourceAutomationId: null,
    });
    expect((await service.startTagRun(await tagInput(0))).outcome).toBe('ignored');
    await updateContactActivity({
      contactId: contact.id,
      values: { last_direct_message_received_at: new Date() },
    });
    expect((await service.startTagRun(await tagInput(3))).outcome).toBe('ignored');
    expect((await service.startTagRun(await tagInput(1))).outcome).toBe('run_started');
    const [run] = await readRunRows(organization.id);
    expect(run).toMatchObject({ once_key: 'tag:vip:101', version_numbers: { tag_chain: 1 } });
    await report('messages', 'sent');
    expect(await readRunRow(run!.id)).toMatchObject({ status: 'completed' });
    expect((await freshContact()).tags).toContain('nurtured');
    expect(source.id).toBe(run!.automation_id);
  });

  it('the pause cancels her open runs and deletes their keys in its commit (AU29, AU37)', async () => {
    const automation = await liveAutomation({ keywords: ['guide'] });
    await comment();
    await withAppDatabaseContext({
      scope: scope(),
      callback: (databaseHandle) =>
        service.cancelContactOpenRuns({
          organizationId: organization.id,
          contactId: contact.id,
          reason: 'contact_excluded',
          databaseHandle,
        }),
    });
    expect(await readRunRows(organization.id)).toMatchObject([
      { status: 'cancelled', cancel_reason: 'contact_excluded', automation_id: automation.id },
    ]);
    expect(await readOpenRunKeys(organization.id)).toEqual([]);
    expect((await readCommentLogRows(organization.id))[0]?.overall_status).toBe('cancelled');
  });

  it('a run event lands in its run’s month part, the run in its own (AU36)', async () => {
    const run = await insertAutomationRun({
      organizationId: organization.id,
      automationId: (await liveAutomation({})).id,
      contactId: contact.id,
      started_at: new Date('2026-10-31T23:59:00Z'),
    });
    await getOperatorDatabase().execute(sql`
      INSERT INTO app.automation_run_events (organization_id, automation_run_id, automation_run_started_at, event_type, status, created_at)
      VALUES (${organization.id}, ${run.id}, ${run.started_at.toISOString()}, 'status_changed', 'waiting', '2026-11-02T00:00:00Z')`);
    const rows = (await getOperatorDatabase().execute(sql`
      SELECT (SELECT tableoid::regclass::text FROM app.automation_runs WHERE id = ${run.id}) AS run_part,
             (SELECT tableoid::regclass::text FROM app.automation_run_events WHERE automation_run_id = ${run.id}) AS event_part`)) as unknown as
      | Array<{ run_part: string; event_part: string }>
      | { rows: Array<{ run_part: string; event_part: string }> };
    const [parts] = Array.isArray(rows) ? rows : rows.rows;
    expect(parts?.run_part).toMatch(/automation_runs_(p202610|default)$/);
    expect(parts?.event_part).toBe(
      parts?.run_part.replace('automation_runs', 'automation_run_events'),
    );
  });

  it('one open key per automation and person, whatever month the runs started in (AU37, P100)', async () => {
    const automation = await liveAutomation({});
    const october = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
      started_at: new Date('2026-10-31T23:59:59Z'),
    });
    const november = await insertAutomationRun({
      organizationId: organization.id,
      automationId: automation.id,
      contactId: contact.id,
      started_at: new Date('2026-11-01T00:00:01Z'),
      isOpenKeyLeftOut: true,
    });
    await expect(
      getOperatorDatabase().execute(sql`
        INSERT INTO app.automation_run_open_keys (organization_id, automation_id, contact_id, automation_run_id, automation_run_started_at)
        VALUES (${organization.id}, ${automation.id}, ${contact.id}, ${november.id}, ${november.started_at.toISOString()})`),
    ).rejects.toThrow();
    expect(await readOpenRunKeys(organization.id)).toEqual([
      `${automation.id}:${contact.id}:${october.id}`,
    ]);
  });

  it('two starts racing for one person leave one key and one open run (AU37)', async () => {
    await liveAutomation({ trigger_type: 'story_reply', keywords: [] });
    const results = await Promise.all([
      directMessage('one', 'story_reply', '17910000000000001'),
      directMessage('two', 'story_reply', '17910000000000002'),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['ignored', 'run_started']);
    expect(await readRunRows(organization.id)).toHaveLength(1);
    expect(await readOpenRunKeys(organization.id)).toHaveLength(1);
  });
});
