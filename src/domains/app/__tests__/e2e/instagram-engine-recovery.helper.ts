import type { FastifyInstance } from 'fastify';
import {
  automationPath,
  commentAutomationBody,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import { nextInstagramObjectId } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
} from '@/tests/helpers/test-http-inject.helper.js';
import { type InstagramMessageFlow, PERSON } from './instagram-message-flow.helper.js';

/** The follow request every fixture with a follow step uses. */
export const FOLLOW_REQUEST_MESSAGE = {
  text: 'Follow us first',
  following_button_title: "I'm following",
  profile_button_title: 'Profile',
};

/** An event of a delivery entry and the list it sits in — what `InstagramMessageFlow.deliver` takes. */
export type DeliveredEvent = Parameters<InstagramMessageFlow['deliver']>[0];

/** A comment of the person on one of the account's posts, as Meta delivers it (`changes[]`). */
export function commentEvent({
  text,
  commentId = nextInstagramObjectId(),
}: {
  text: string;
  commentId?: string;
}): DeliveredEvent {
  return {
    source: 'changes',
    item: {
      field: 'comments',
      value: {
        id: commentId,
        text,
        from: { id: PERSON, username: 'jordan.lee' },
        media: { id: nextInstagramObjectId() },
      },
    },
  };
}

/** A live comment automation on the keyword `guide` that sends its final message and nothing before it (route 12). */
export function commentAutomation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return commentAutomationBody({
    name: 'Guide by comment',
    status: 'live',
    keywords: ['guide'],
    is_opening_message_enabled: false,
    opening_message: null,
    final_message: { text: 'Here is the guide', links: [] },
    ...overrides,
  });
}

/** Changes an automation over route 14 as the team's Owner. */
export async function editAutomation({
  app,
  flow,
  automationPublicId,
  changes,
}: {
  app: FastifyInstance;
  flow: InstagramMessageFlow;
  automationPublicId: string;
  changes: Record<string, unknown>;
}): Promise<void> {
  const response = await injectAuthenticated(app, {
    method: 'PATCH',
    url: automationPath(automationPublicId),
    token: flow.team.ownerToken,
    payload: changes,
  });
  if (response.statusCode !== 200) {
    throw new Error(`automation edit fixture failed with ${response.statusCode}: ${response.body}`);
  }
}

/** Deletes an automation over route 15 as the team's Owner and answers the response. */
export function deleteAutomation({
  app,
  flow,
  automationPublicId,
}: {
  app: FastifyInstance;
  flow: InstagramMessageFlow;
  automationPublicId: string;
}): Promise<InjectHttpResult> {
  return injectAuthenticated(app, {
    method: 'DELETE',
    url: `${automationPath(automationPublicId)}?reason=not_needed`,
    token: flow.team.ownerToken,
  });
}

/**
 * The team's latest stored event after crashes used up every attempt: five counted, its lease over
 * (the stuck-event pick-up's 5 minutes).
 */
export async function useUpAttemptsOfLatestEvent(flow: InstagramMessageFlow): Promise<void> {
  await operatorQuery`
    UPDATE app.instagram_webhook_events
    SET attempt_count = 5, last_attempted_at = now() - interval '6 minutes'
    WHERE id = (
      SELECT id FROM app.instagram_webhook_events
      WHERE organization_id = ${flow.team.organization.id}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )`;
}

/** The last DM the person sent is more than a day old: the messaging window is closed (3.B.10). */
export async function closeMessagingWindow(flow: InstagramMessageFlow): Promise<void> {
  await operatorQuery`
    UPDATE app.contacts
    SET last_direct_message_received_at = now() - interval '25 hours'
    WHERE organization_id = ${flow.team.organization.id}
      AND instagram_account_id = ${flow.account.id}`;
}
