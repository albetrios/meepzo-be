import { parseWithSchema } from '@/shared/utils/validation/parse-with-schema.util.js';
import { splitRecordIds } from '@/shared/utils/validation/record-fields.util.js';
import {
  assertNoContentProblems,
  listAutomationMessageProblems,
} from '@/domains/app/sub-domains/automation/automation.validator.js';
import {
  type BroadcastMessages,
  createBroadcastBodyDto,
  emptyBroadcastActionBodyDto,
  listBroadcastsQueryDto,
  sendBroadcastBodyDto,
  updateBroadcastBodyDto,
} from './broadcast.dto.js';
import type {
  BroadcastCreateInput,
  BroadcastListQuery,
  BroadcastSendInput,
  BroadcastUpdateInput,
} from './broadcast.types.js';

/**
 * Parses route 70's query (7.A.8) with the strict {@link listBroadcastsQueryDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`, `errors[].field` the parameter) on a missing or malformed
 * `channel_account_id`, a bad `status`, `mode`, `sort`, `order`, `limit` or `q`, or an unknown one.
 */
export function validateListBroadcastsQuery(data: unknown): BroadcastListQuery {
  const parsed = parseWithSchema({ schema: listBroadcastsQueryDto, data });
  return {
    channelAccountPublicId: parsed.channel_account_id,
    statuses: splitRecordIds(parsed.status),
    mode: parsed.mode,
    q: parsed.q,
    sort: parsed.sort,
    order: parsed.order,
    limit: parsed.limit,
    after: parsed.after,
  };
}

/**
 * Each message's own content checks (BC8 — the automation's, reused: kinds, lengths, links, counts,
 * waits), each item's `field` its body path (`body.messages.0.text`).
 *
 * @remarks
 * Failure modes: `ValidationError` (`errors:automationContentInvalid`, `400`) when any message has a
 * problem. Side effects: none.
 */
export function assertBroadcastMessagesValid(messages: BroadcastMessages | undefined): void {
  if (messages === undefined) return;
  assertNoContentProblems(
    messages.flatMap((message, index) =>
      listAutomationMessageProblems({ message, path: `messages.${index}` }),
    ),
  );
}

/**
 * Parses route 71's body (BC8) with the strict {@link createBroadcastBodyDto}, then each message's
 * content checks.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on a malformed id, a name empty or over 255 after trim,
 * both audiences, bad conditions, more than 3 messages or 64 KB, a message's own problem, or an
 * unknown field.
 */
export function validateCreateBroadcastBody(data: unknown): BroadcastCreateInput {
  const parsed = parseWithSchema({ schema: createBroadcastBodyDto, data });
  assertBroadcastMessagesValid(parsed.messages);
  return {
    channelAccountPublicId: parsed.channel_account_id,
    name: parsed.name,
    segmentPublicId: parsed.segment_id,
    conditions: parsed.conditions,
    messages: parsed.messages,
    startAutomationPublicId: parsed.start_automation_id,
  };
}

/**
 * Parses route 73's body (BC8) with the strict {@link updateBroadcastBodyDto}, then each message's
 * content checks.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on an empty body, both audiences, a bad field, a
 * message's own problem, a malformed `expected_updated_at` or an unknown field.
 */
export function validateUpdateBroadcastBody(data: unknown): BroadcastUpdateInput {
  const parsed = parseWithSchema({ schema: updateBroadcastBodyDto, data });
  assertBroadcastMessagesValid(parsed.messages);
  return {
    name: parsed.name,
    segmentPublicId: parsed.segment_id,
    conditions: parsed.conditions,
    messages: parsed.messages,
    startAutomationPublicId: parsed.start_automation_id,
    expectedUpdatedAt: parsed.expected_updated_at,
  };
}

/**
 * Parses route 75's body (BC10) with the strict {@link sendBroadcastBodyDto}.
 *
 * @remarks
 * Failure modes: `ValidationError` (`400` on `mode`, `scheduled_at` or `open_wait_days`) on an
 * unknown mode, a time in the past or over 30 days ahead, days out of 1–7, a field of another mode,
 * or an unknown field.
 */
export function validateSendBroadcastBody(data: unknown): BroadcastSendInput {
  const parsed = parseWithSchema({ schema: sendBroadcastBodyDto, data });
  if (parsed.mode === 'scheduled') {
    return { mode: 'scheduled', scheduledAt: new Date(parsed.scheduled_at as string) };
  }
  if (parsed.mode === 'when_chat_opens') {
    return { mode: 'when_chat_opens', openWaitDays: parsed.open_wait_days as number };
  }
  return { mode: 'now' };
}

/**
 * Parses route 76's body: strictly empty (7.A.8).
 *
 * @remarks
 * Failure modes: `ValidationError` (`400`) on any field.
 */
export function validateEmptyBroadcastAction(data: unknown): void {
  parseWithSchema({ schema: emptyBroadcastActionBodyDto, data });
}
