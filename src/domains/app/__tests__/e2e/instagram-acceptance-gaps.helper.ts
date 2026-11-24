import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { getEnv } from '@/shared/config/env.config.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import {
  type AutomationCommentLogFixtureRow,
  type AutomationRunFixtureRow,
  readCommentLogRows,
  readRunEventsOfOrganization,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import type { AutomationFixtureRow } from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  FORM_CONTENT_TYPE,
  INSTAGRAM_DEAUTHORIZE_PATH,
  buildMetaSignedRequest,
  metaCallbackFormBody,
  metaIssuedAtAfterConnections,
  metaSignedRequestPayload,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/__tests__/factories/instagram-account-meta-callback.factory.js';
import {
  INSTAGRAM_ACCOUNT_PATH,
  INSTAGRAM_CONNECT_PATH,
  buildInstagramProfile,
  mockInstagramConnect,
  mockInstagramUnsubscribe,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { getOperatorDatabase, operatorQuery } from '@/tests/helpers/operator-database.js';
import { injectAuthenticated, injectRoute } from '@/tests/helpers/test-http-inject.helper.js';
import type { InstagramCommentFlow, TestInstagramPerson } from './instagram-comment-flow.helper.js';

/** One team's flow and the app it runs over. */
interface FlowOfApp {
  app: FastifyInstance;
  flow: InstagramCommentFlow;
}

/** Disconnects the team's account (route 4); the flow keeps naming it, for the reconnect. */
export async function disconnectOverRoute({ app, flow }: FlowOfApp): Promise<void> {
  mockInstagramUnsubscribe({ instagramAppUserId: flow.account.instagramAppUserId });
  const response = await injectAuthenticated(app, {
    method: 'DELETE',
    url: INSTAGRAM_ACCOUNT_PATH,
    token: flow.team.ownerToken,
  });
  expect(response.statusCode, response.body).toBe(204);
}

/** The person removes the app on Instagram: Meta's signed deauthorize callback (route 7). */
export async function deauthorizeOnInstagram({ app, flow }: FlowOfApp): Promise<void> {
  const response = await injectRoute(app, {
    method: 'POST',
    url: INSTAGRAM_DEAUTHORIZE_PATH,
    headers: { 'content-type': FORM_CONTENT_TYPE },
    payload: metaCallbackFormBody(
      buildMetaSignedRequest({
        payload: metaSignedRequestPayload({
          userId: flow.account.instagramAppUserId,
          issuedAt: metaIssuedAtAfterConnections(),
        }),
        appSecret: getEnv().META_APP_SECRET ?? '',
      }),
    ),
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Connects the very same Instagram account again (route 1) — both its ids and its username. */
export async function reconnectSameAccount({ app, flow }: FlowOfApp): Promise<{
  is_new_connection: boolean;
  instagram_account: { id: string; connection_status: string };
}> {
  const { instagramUserId, instagramAppUserId, username } = flow.account;
  mockInstagramConnect({
    profile: buildInstagramProfile({ user_id: instagramUserId, id: instagramAppUserId, username }),
  });
  const response = await injectAuthenticated(app, {
    method: 'POST',
    url: INSTAGRAM_CONNECT_PATH,
    token: flow.team.ownerToken,
    payload: { code: `AQB-${randomUUID()}#_` },
    headers: { 'x-idempotency-key': `acceptance-gaps-${randomUUID()}` },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (
    response.json() as {
      data: {
        is_new_connection: boolean;
        instagram_account: { id: string; connection_status: string };
      };
    }
  ).data;
}

/** Everything of the team that a disconnect must leave exactly as it was. */
export interface AutomationState {
  automations: AutomationFixtureRow[];
  runs: AutomationRunFixtureRow[];
  runEvents: string[];
  commentLogs: AutomationCommentLogFixtureRow[];
}

/** Reads the team's automations, runs, run history and comment logs, every column. */
export async function readAutomationState(flow: InstagramCommentFlow): Promise<AutomationState> {
  const organizationId = flow.team.organization.id;
  return {
    automations: await getOperatorDatabase()
      .select()
      .from(automations)
      .where(eq(automations.organization_id, organizationId))
      .orderBy(asc(automations.id)),
    runs: await readRunRows(organizationId),
    runEvents: await readRunEventsOfOrganization(organizationId),
    commentLogs: await readCommentLogRows(organizationId),
  };
}

/** How many webhook events of the team are stored. */
export async function countStoredEvents(flow: InstagramCommentFlow): Promise<number> {
  const rows = await operatorQuery<Array<{ event_count: number }>>`
    SELECT count(*)::int AS event_count FROM app.instagram_webhook_events
    WHERE organization_id = ${flow.team.organization.id}`;
  return rows[0]?.event_count ?? 0;
}

/** The person's only run of an automation. */
export async function runOfPerson({
  flow,
  automation,
  person,
}: {
  flow: InstagramCommentFlow;
  automation: AutomationFixtureRow;
  person: TestInstagramPerson;
}): Promise<AutomationRunFixtureRow> {
  const contact = await flow.contactOf(person);
  const runs = (await flow.runsOf(automation)).filter((run) => run.contact_id === contact.id);
  expect(runs).toHaveLength(1);
  return runs[0] as AutomationRunFixtureRow;
}

/** The person clicks the button of one run's message: Meta delivers the click (route 17). */
export async function deliverButtonClick({
  flow,
  automation,
  run,
  person,
}: {
  flow: InstagramCommentFlow;
  automation: AutomationFixtureRow;
  run: AutomationRunFixtureRow;
  person: TestInstagramPerson;
}): Promise<void> {
  await flow.deliver({
    messaging: [
      {
        sender: { id: person.instagramUserId },
        recipient: { id: flow.account.instagramUserId },
        timestamp: Date.now(),
        postback: {
          mid: `m_${randomUUID()}`,
          title: 'the button',
          payload: `${automation.public_id}::${run.public_id}`,
        },
      },
    ],
  });
}

/**
 * The team writes to a person by hand, in the Instagram app: Meta delivers the message back as an
 * echo — the account is the sender, the person the recipient (route 17). Answers its event key.
 */
export async function deliverHandSentEcho({
  flow,
  person,
  text,
}: {
  flow: InstagramCommentFlow;
  person: TestInstagramPerson;
  text: string;
}): Promise<string> {
  const messageId = `m_${randomUUID()}`;
  await flow.deliver({
    messaging: [
      {
        sender: { id: flow.account.instagramUserId },
        recipient: { id: person.instagramUserId },
        timestamp: Date.now(),
        message: { mid: messageId, text, is_echo: true },
      },
    ],
  });
  return `echo:${messageId}`;
}
