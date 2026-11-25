import { createHmac } from 'node:crypto';
import { readChannelAccountPublicIdOfInstagramAccount } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { createTestSubscription } from '@/domains/billing/__tests__/factories/subscription.factory.js';
import { CREATOR_PLAN_FEATURES } from '@/domains/billing/sub-domains/plan/seed/plan.reference.seed.js';
import { createTestPlan } from '@/tests/factories/plan.factory.js';
import { RecordingSendingPort } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import pino from 'pino';
import {
  META_GRAPH_VERSION,
  META_GRAPH_BASE_URL,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { logger } from '@/shared/utils/infrastructure/logger.util.js';
import {
  type InstagramTeamFixture,
  type TestInstagramProfile,
  buildInstagramProfile,
  createInstagramTeam,
  connectInstagramAccount,
  readInstagramAccountRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type ContactFixtureRow,
  contactPath,
  readAccountContactRows,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureOverrides,
  type AutomationFixtureRow,
  insertAutomation,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  insertAutomationCommentLog,
  insertAutomationRun,
  nextInstagramObjectId,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  type InstagramWebhookAccountJobResult,
  processInstagramWebhookAccountJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
  injectRoute,
} from '@/tests/helpers/test-http-inject.helper.js';

/** `POST /app/social/channel-connections/meta/webhooks/instagram` (route 17). */
const INSTAGRAM_WEBHOOK_PATH = testApiPath(
  '/app/social/channel-connections/meta/webhooks/instagram',
);

/** `days` whole days before `from`. */
export function daysBefore({ from, days }: { from: Date; days: number }): Date {
  return new Date(from.getTime() - days * MILLISECONDS_PER_DAY);
}

/** A team with its Owner, Admin, Editor and Viewer, and the Instagram account it connected over route 1. */
export interface ConnectedInstagramTeam extends InstagramTeamFixture {
  profile: TestInstagramProfile;
  account: { id: number; public_id: string };
}

/**
 * Provisions a team the real way and connects an Instagram account through route 1 (Instagram
 * mocked) — so the account, its encrypted token and its default settings are the real rows the
 * processing job and the run engine read.
 */
export async function connectInstagramTeam(app: FastifyInstance): Promise<ConnectedInstagramTeam> {
  const team = await createInstagramTeam();
  // Creator's features: the email and phone asks are PRO, read by the run engine at run time (AU26).
  const plan = await createTestPlan({
    features: CREATOR_PLAN_FEATURES,
    priceMonthly: '29.00',
    priceYearly: '276.00',
  });
  await createTestSubscription({
    organizationId: team.organization.id,
    planId: plan.id,
    status: 'ACTIVE',
  });
  const profile = buildInstagramProfile();
  await connectInstagramAccount({ app, token: team.ownerToken, profile });
  const [account] = await readInstagramAccountRows(team.organization.id);
  if (account === undefined) throw new Error('connect fixture stored no account');
  return { ...team, profile, account: { id: Number(account.id), public_id: account.public_id } };
}

/** A person who writes to the connected account — every value is one a team must be able to erase. */
export interface TestInstagramPerson {
  instagramUserId: string;
  username: string;
  fullName: string;
  pictureUrl: string;
  email: string;
  phone: string;
}

/** The person most tests write and erase. */
export const JORDAN: TestInstagramPerson = {
  instagramUserId: '17841455512340001',
  username: 'jordan.private',
  fullName: 'Jordan Privateperson',
  pictureUrl: 'https://scontent.cdninstagram.com/v/jordan-picture.jpg',
  email: 'jordan.mail@example.com',
  phone: '+15550123987',
};

/** Someone else, whose data must stay as it was. */
export const MORGAN: TestInstagramPerson = {
  instagramUserId: '17841455512340002',
  username: 'morgan.bystander',
  fullName: 'Morgan Bystander',
  pictureUrl: 'https://scontent.cdninstagram.com/v/morgan-picture.jpg',
  email: 'morgan.mail@example.com',
  phone: '+15550456321',
};

/** What each ended status stamps (the table's pairing CHECKs). */
const ENDED_RUN_COLUMNS = {
  completed: (at: Date) => ({ completed_at: at }),
  failed: (at: Date) => ({ failed_at: at, error_message: 'instagram_api:refused' }),
  cancelled: (at: Date) => ({ cancelled_at: at, cancel_reason: 'wait_expired' }),
} as const;

type EndedRunStatus = keyof typeof ENDED_RUN_COLUMNS;

type AutomationOverrides = AutomationFixtureOverrides;

/** Every value that names or reaches the person — none may outlive an erase or reach a log line. */
export function personalValuesOf(person: TestInstagramPerson): string[] {
  return [person.username, person.fullName, person.pictureUrl, person.email, person.phone];
}

/** What the test Instagram received: a DM or private reply, or a public reply under a comment. */
export interface InstagramSend {
  kind: 'message' | 'public_reply';
  body: Record<string, unknown>;
}

/** What Instagram answers a send with instead of taking it: a status and its error body. */
export type InstagramRefusal = [status: number, body: Record<string, unknown>];

/** The Instagram reads the processing job and the follow check make. */
export type InstagramReadKind = 'profile' | 'post';

/**
 * Answers every Instagram call of one connected account until `nock.cleanAll()` — messages, public
 * replies, profile and post reads — and records the sends. The profile read answers the person its
 * id names (of `people`). `onSend` / `onRead` run before the answer, so a test can act (erase the
 * contact, say) while the call is in flight; a refusal `onSend` returns is answered instead.
 */
export function mockInstagramConversation({
  instagramAppUserId,
  people,
  onSend,
  onRead,
}: {
  instagramAppUserId: string;
  people: readonly TestInstagramPerson[];
  onSend?: (send: InstagramSend) => Promise<InstagramRefusal | undefined>;
  onRead?: (read: InstagramReadKind) => Promise<void>;
}): { sends: InstagramSend[] } {
  const sends: InstagramSend[] = [];
  const answerSend = async ({
    kind,
    request,
    taken,
  }: {
    kind: InstagramSend['kind'];
    request: unknown;
    taken: Record<string, unknown>;
  }): Promise<InstagramRefusal> => {
    const send = { kind, body: (await (request as Request).json()) as Record<string, unknown> };
    sends.push(send);
    return (await onSend?.(send)) ?? [200, taken];
  };
  // nock hands a `fetch` call over as its `Request`; a path function reads the pathname only.
  const graphPath = (pattern: RegExp) => (pathname: string) =>
    pattern.test(pathname.slice(`/${META_GRAPH_VERSION}`.length));
  nock(META_GRAPH_BASE_URL)
    .persist()
    .post(`/${META_GRAPH_VERSION}/${instagramAppUserId}/messages`)
    .query(true)
    .reply((request: unknown) =>
      answerSend({
        kind: 'message',
        request,
        taken: { message_id: 'mid.retention', recipient_id: '1' },
      }),
    )
    .post(graphPath(/^\/\d+\/replies$/))
    .query(true)
    .reply((request: unknown) =>
      answerSend({ kind: 'public_reply', request, taken: { id: '17990000000000001' } }),
    )
    .get(graphPath(/^\/\d+$/))
    .query(true)
    .reply(async (request: unknown) => {
      const url = new URL((request as Request).url);
      const id = url.pathname.split('/').at(-1);
      if (url.searchParams.get('fields')?.includes('follower_count')) {
        await onRead?.('profile');
        const person = people.find((candidate) => candidate.instagramUserId === id);
        return [
          200,
          {
            name: person?.fullName,
            username: person?.username,
            profile_pic: person?.pictureUrl,
            follower_count: 321,
            is_user_follow_business: true,
          },
        ];
      }
      await onRead?.('post');
      return [
        200,
        {
          id,
          media_type: 'IMAGE',
          media_product_type: 'FEED',
          permalink: 'https://www.instagram.com/p/AcmePost/',
          timestamp: '2026-11-20T10:00:00+0000',
        },
      ];
    });
  return { sends };
}

/** A comment as Meta delivers it (`changes[]`), on a post of its own. */
export function commentChange({
  person,
  text,
}: {
  person: TestInstagramPerson;
  text: string;
}): Record<string, unknown> {
  return {
    field: 'comments',
    value: {
      id: nextInstagramObjectId(),
      text,
      from: { id: person.instagramUserId, username: person.username },
      media: { id: nextInstagramObjectId() },
    },
  };
}

/** A DM as Meta delivers it (`messaging[]`) — a reply to a story when it names one. */
export function directMessageItem({
  person,
  text,
  storyId,
}: {
  person: TestInstagramPerson;
  text: string;
  storyId?: string;
}): Record<string, unknown> {
  return {
    sender: { id: person.instagramUserId },
    timestamp: Date.now(),
    message: {
      mid: `m_${nextInstagramObjectId()}`,
      text,
      ...(storyId === undefined ? {} : { reply_to: { story: { id: storyId } } }),
    },
  };
}

/** Delivers items to the connected account over route 17, signed as Meta signs them. */
export async function deliverInstagramEvents({
  app,
  team,
  changes = [],
  messaging = [],
}: {
  app: FastifyInstance;
  team: ConnectedInstagramTeam;
  changes?: readonly Record<string, unknown>[];
  messaging?: readonly Record<string, unknown>[];
}): Promise<void> {
  const rawBody = JSON.stringify({
    object: 'instagram',
    entry: [{ id: team.profile.user_id, time: Date.now(), changes, messaging }],
  });
  const signature = createHmac('sha256', getEnv().META_APP_SECRET ?? '')
    .update(rawBody)
    .digest('hex');
  const response = await injectRoute(app, {
    method: 'POST',
    url: INSTAGRAM_WEBHOOK_PATH,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    payload: Buffer.from(rawBody),
  });
  if (response.statusCode !== 200) {
    throw new Error(`webhook delivery fixture failed with ${response.statusCode}`);
  }
}

/**
 * Runs the account's real processing job over the app's own services (routes-final WH12–WH14) — the
 * events stored and not yet processed, with the real Instagram client (mocked at the network).
 */
export async function processInstagramEvents({
  app,
  team,
}: {
  app: FastifyInstance;
  team: ConnectedInstagramTeam;
}): Promise<InstagramWebhookAccountJobResult> {
  const result = await processInstagramWebhookAccountJob({
    jobData: {
      organizationPublicId: team.organization.public_id,
      channelAccountPublicId: await readChannelAccountPublicIdOfInstagramAccount(team.account.id),
    },
    services: app.appDomain,
    jobId: 'job-retention-erasure',
    enqueueFollowUp: async () => undefined,
  });
  // The run engine saves waiting messages (R14); the suite's recording port "sends" them as the
  // channel's sending sub-domain will (R19–R20).
  const port = app.appDomain.channelSendingPorts.instagram;
  if (port instanceof RecordingSendingPort) {
    await port.sendAll({
      service: app.appDomain.automationRunService,
      scope: { organizationPublicId: team.organization.public_id, source: 'job' } as never,
      organizationId: team.organization.id,
    });
  }
  return result;
}

/** Deletes a contact over route 10 as the team's Owner. */
export function deleteContactAsOwner({
  app,
  team,
  contactPublicId,
}: {
  app: FastifyInstance;
  team: InstagramTeamFixture;
  contactPublicId: string;
}): Promise<InjectHttpResult> {
  return injectAuthenticated(app, {
    method: 'DELETE',
    url: contactPath(contactPublicId),
    token: team.ownerToken,
  });
}

/** A live automation of the team's account without an opening message, unless overridden. */
export function liveAutomation({
  team,
  ...overrides
}: { team: ConnectedInstagramTeam } & AutomationOverrides): Promise<AutomationFixtureRow> {
  return insertAutomation({
    organizationId: team.organization.id,
    instagramAccountId: team.account.id,
    status: 'live',
    is_opening_message_enabled: false,
    opening_message: null,
    ...overrides,
  });
}

/** Someone writes to the account: Meta delivers it, and the processing job handles it. */
export async function say({
  app,
  team,
  ...items
}: {
  app: FastifyInstance;
  team: ConnectedInstagramTeam;
  changes?: readonly Record<string, unknown>[];
  messaging?: readonly Record<string, unknown>[];
}): Promise<void> {
  await deliverInstagramEvents({ app, team, ...items });
  await processInstagramEvents({ app, team });
}

/** The team's live contact of one person. */
export async function contactOf({
  team,
  person,
}: {
  team: ConnectedInstagramTeam;
  person: TestInstagramPerson;
}): Promise<ContactFixtureRow> {
  const contact = (
    await readAccountContactRows({
      organizationId: team.organization.id,
      instagramAccountId: team.account.id,
    })
  ).find((row) => row.instagram_user_id === person.instagramUserId);
  if (contact === undefined) throw new Error(`no contact of ${person.username}`);
  return contact;
}

/** An automation's first run — of one contact, when given. */
export async function runOf({
  automation,
  contact,
}: {
  automation: AutomationFixtureRow;
  contact?: ContactFixtureRow;
}): Promise<AutomationRunFixtureRow> {
  const run = (await readRunRows(automation.organization_id)).find(
    (row) =>
      row.automation_id === automation.id &&
      (contact === undefined || row.contact_id === contact.id),
  );
  if (run === undefined) throw new Error(`no run of ${automation.name}`);
  return run;
}

/** The automations of a history: two on comments, one on DMs, one on story replies. */
export interface HistoryAutomations {
  price: AutomationFixtureRow;
  giveaway: AutomationFixtureRow;
  catalog: AutomationFixtureRow;
  story: AutomationFixtureRow;
}

/** The automations a history runs on; the price list takes the given overrides. */
export async function historyAutomations({
  team,
  price = {},
}: {
  team: ConnectedInstagramTeam;
  price?: AutomationOverrides;
}): Promise<HistoryAutomations> {
  return {
    price: await liveAutomation({
      team,
      name: 'Price list',
      keywords: ['price'],
      is_email_collection_enabled: true,
      ...price,
    }),
    giveaway: await liveAutomation({ team, name: 'Giveaway', keywords: ['giveaway'] }),
    catalog: await liveAutomation({
      team,
      name: 'Catalog',
      trigger_type: 'dm',
      keywords: ['catalog'],
    }),
    story: await liveAutomation({ team, name: 'Story', trigger_type: 'story_reply' }),
  };
}

/** A person's whole history with a team: every status of run, logs, and a stored, unread DM. */
export interface PersonHistory {
  contact: ContactFixtureRow;
  waitingRun: AutomationRunFixtureRow;
  runningRun: AutomationRunFixtureRow;
  endedRuns: AutomationRunFixtureRow[];
  /** Everything the person wrote — none may outlive the erase. */
  texts: string[];
}

/**
 * Two comments over the webhook (a run waiting for the email with the second one saved on it), the
 * contact's collected data, a run of every other status with logs, and a DM the processing has not
 * read yet.
 */
export async function writeHistory({
  app,
  team,
  person,
  automations,
}: {
  app: FastifyInstance;
  team: ConnectedInstagramTeam;
  person: TestInstagramPerson;
  automations: HistoryAutomations;
}): Promise<PersonHistory> {
  const name = person.username.split('.')[0];
  const texts = {
    price: `price for ${name} my-private-comment`,
    giveaway: `giveaway for ${name} my-private-saved-comment`,
    catalog: `catalog for ${name} my-private-message`,
    story: `${name} my-private-story-reply`,
    unread: `${name} unread: write to ${person.email} or call ${person.phone} any time of day`,
  };
  for (const text of [texts.price, texts.giveaway]) {
    await say({ app, team, changes: [commentChange({ person, text })] });
  }
  const contact = await contactOf({ team, person });
  const now = new Date();
  await operatorQuery`
    UPDATE app.contacts
    SET email = ${person.email}, email_collected_at = ${now},
        phone = ${person.phone}, phone_collected_at = ${now},
        is_following_account = true, follow_checked_at = ${now}, tags = ${[`Tag of ${name}`]}
    WHERE id = ${contact.id}`;
  // The account's tag count the tag commit keeps (S7, ROUTE R10).
  await operatorQuery`
    INSERT INTO app.contact_tag_counts (organization_id, channel_account_id, tag, contact_count)
    SELECT organization_id, channel_account_id, ${`Tag of ${name}`}, 1 FROM app.contacts
    WHERE id = ${contact.id}
    ON CONFLICT (organization_id, channel_account_id, tag)
    DO UPDATE SET contact_count = app.contact_tag_counts.contact_count + 1`;
  // The tag change's event, written in the same commit (3.B, ROUTE R11).
  await operatorQuery`
    INSERT INTO app.contact_tag_events (organization_id, channel_account_id, contact_id, tag, kind, source)
    SELECT organization_id, channel_account_id, id, ${`Tag of ${name}`}, 'added', 'owner'
    FROM app.contacts WHERE id = ${contact.id}`;
  const owner = { organizationId: team.organization.id, contactId: contact.id };
  const runningRun = await insertAutomationRun({
    ...owner,
    automationId: automations.catalog.id,
    status: 'running',
    current_step: 'messages',
    waiting_for: null,
    waiting_since_at: null,
  });
  const endedRuns: AutomationRunFixtureRow[] = [];
  for (const status of Object.keys(ENDED_RUN_COLUMNS) as EndedRunStatus[]) {
    const run = await insertAutomationRun({
      ...owner,
      automationId: automations.story.id,
      trigger_type: 'story_reply',
      trigger_instagram_story_id: nextInstagramObjectId(),
      status,
      waiting_for: null,
      waiting_since_at: null,
      ...ENDED_RUN_COLUMNS[status](now),
    });
    endedRuns.push(run);
    await insertAutomationCommentLog({
      ...owner,
      automationId: automations.story.id,
      run,
      overall_status: 'completed',
      comment_text: texts.story,
      commenter_username: person.username,
      commenter_instagram_user_id: person.instagramUserId,
      email_received: person.email,
      phone_received: person.phone,
    });
  }
  await deliverInstagramEvents({
    app,
    team,
    messaging: [directMessageItem({ person, text: texts.unread })],
  });
  return {
    contact: await contactOf({ team, person }),
    waitingRun: await runOf({ automation: automations.price, contact }),
    runningRun,
    endedRuns,
    texts: Object.values(texts),
  };
}

/** The rows of one contact: itself, its runs, their events and its comment logs. */
export async function readRowsOfContact({
  team,
  contact,
}: {
  team: ConnectedInstagramTeam;
  contact: ContactFixtureRow;
}) {
  const rows = await readAppRowsOfOrganization(team.organization.id);
  const runs = (rows.automation_runs ?? []).filter((row) => row.contact_id === contact.id);
  const runIds = new Set(runs.map((row) => row.id));
  return {
    contact: (rows.contacts ?? []).filter((row) => row.id === contact.id),
    runs,
    runEvents: (rows.automation_run_events ?? []).filter((row) =>
      runIds.has(row.automation_run_id),
    ),
    commentLogs: (rows.automation_comment_logs ?? []).filter(
      (row) => row.contact_id === contact.id,
    ),
  };
}

/**
 * The tables of the `app` schema that hold an organization's rows — read from the catalog. A
 * partitioned table counts once, through its parent (its day parts are skipped, R16).
 */
async function listAppTenantTables(): Promise<Array<{ tableName: string; hasId: boolean }>> {
  const rows = await operatorQuery<Array<{ table_name: string; has_id: boolean }>>`
    SELECT c.table_name,
           EXISTS (SELECT 1 FROM information_schema.columns id_column
                    WHERE id_column.table_schema = 'app' AND id_column.table_name = c.table_name
                      AND id_column.column_name = 'id') AS has_id
      FROM information_schema.columns c
      JOIN information_schema.tables t USING (table_schema, table_name)
      JOIN pg_class class ON class.oid = format('app.%I', c.table_name)::regclass
     WHERE c.table_schema = 'app' AND c.column_name = 'organization_id'
       AND t.table_type = 'BASE TABLE' AND NOT class.relispartition
     ORDER BY c.table_name`;
  return rows.map((row) => ({ tableName: row.table_name, hasId: row.has_id }));
}

/**
 * Every row an organization holds in the `app` schema, per table, as the operator reads it — the
 * tables come from the catalog, so a table added later is covered without touching the test.
 */
export async function readAppRowsOfOrganization(
  organizationId: number,
): Promise<Record<string, Record<string, unknown>[]>> {
  const rowsOfTable: Record<string, Record<string, unknown>[]> = {};
  for (const { tableName, hasId } of await listAppTenantTables()) {
    const rows = await operatorQuery.unsafe<Array<{ row: Record<string, unknown> }>>(
      `SELECT to_jsonb(t) AS row FROM app.${tableName} t WHERE t.organization_id = $1
        ORDER BY ${hasId ? 't.id' : 'to_jsonb(t)::text'}`,
      [organizationId],
    );
    rowsOfTable[tableName] = rows.map(({ row }) => row);
  }
  return rowsOfTable;
}

/** How many rows an organization holds per `app` table. */
export async function countAppRowsOfOrganization(
  organizationId: number,
): Promise<Record<string, number>> {
  const rowsOfTable = await readAppRowsOfOrganization(organizationId);
  return Object.fromEntries(
    Object.entries(rowsOfTable).map(([table, rows]) => [table, rows.length]),
  );
}

/** The pino internals a capture swaps on one logger. */
interface CapturableLogger {
  level: string;
  [symbol: symbol]: unknown;
}

/**
 * One row in each of the sending sub-domain's per-organization tables (feat-instagram-dm-sending
 * § 6.A, R18) for every channel account of the organization: a stop, a minute count, a day count,
 * the organization's month count, and the automations' counts, reply states and past-comments
 * reads — so the organization delete is seen erasing them too.
 */
export async function writeSendingHistory(organizationId: number): Promise<void> {
  await operatorQuery`
    INSERT INTO app.instagram_send_stops (organization_id, channel_account_id, lane, reason)
    SELECT organization_id, id, 'all', 'login_expired' FROM app.channel_accounts
    WHERE organization_id = ${organizationId}`;
  await operatorQuery`
    INSERT INTO app.instagram_send_minute_counts
      (organization_id, channel_account_id, count_group, minute_start, count)
    SELECT organization_id, id, 'open', date_trunc('minute', now()), 1 FROM app.channel_accounts
    WHERE organization_id = ${organizationId}`;
  await operatorQuery`
    INSERT INTO app.instagram_send_day_counts (organization_id, channel_account_id, day_date, sent_count)
    SELECT organization_id, id, current_date, 1 FROM app.channel_accounts
    WHERE organization_id = ${organizationId}`;
  await operatorQuery`
    INSERT INTO app.message_month_counts (organization_id, month_start, slot, count)
    VALUES (${organizationId}, date_trunc('month', now())::date, 0, 1)`;
  // The automations' counts and reply pacing (feat-instagram-dm-sending R13, AU19).
  await operatorQuery`
    INSERT INTO app.automation_counts (organization_id, automation_id, slot, runs_started)
    SELECT organization_id, id, 0, 1 FROM app.automations WHERE organization_id = ${organizationId}`;
  await operatorQuery`
    INSERT INTO app.automation_reply_states (organization_id, automation_id, channel_account_id)
    SELECT organization_id, id, channel_account_id FROM app.automations
    WHERE organization_id = ${organizationId}`;
  // A finished past-comments read of each automation (feat-instagram-dm-sending R15, AU1).
  await operatorQuery`
    INSERT INTO app.automation_backfills
      (public_id, organization_id, channel_account_id, automation_id, days, status, done_at)
    SELECT 'abf_' || lpad(id::text, 21, '0'), organization_id, channel_account_id, id, 7, 'done', now()
    FROM app.automations WHERE organization_id = ${organizationId}`;
}

/**
 * Captures what the process logger and the app's Fastify logger actually write — after their
 * redaction, formatters and serializers, at every level — until `restore()`.
 */
export function captureLogLines(app: FastifyInstance): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const sink = {
    write: (line: string) => {
      lines.push(line);
    },
  };
  const { streamSym } = pino.symbols;
  const restores = [logger, app.log].map((target) => {
    const capturable = target as unknown as CapturableLogger;
    const stream = capturable[streamSym];
    const { level } = capturable;
    capturable[streamSym] = sink;
    capturable.level = 'trace';
    return () => {
      capturable[streamSym] = stream;
      capturable.level = level;
    };
  });
  return {
    lines,
    restore: () => {
      for (const restore of restores) restore();
    },
  };
}

/**
 * One saved segment (feat-instagram-dm-sending § 7.B, R21) for every channel account of the
 * organization — so the organization delete is seen erasing `app.segments` too.
 */
export async function writeSegmentHistory(organizationId: number): Promise<void> {
  await operatorQuery`
    INSERT INTO app.segments (public_id, organization_id, channel_account_id, name, conditions)
    SELECT 'seg_' || lpad(id::text, 21, '0'), organization_id, id, 'Has an email',
           '{"op":"and","items":[{"field":"details","has":"email"}]}'::jsonb
      FROM app.channel_accounts WHERE organization_id = ${organizationId}`;
}
