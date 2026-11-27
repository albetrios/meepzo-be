import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import nock from 'nock';
import type { FastifyInstance } from 'fastify';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { env } from '@/shared/config/env.config.js';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { instagram_outgoing_messages } from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.schema.js';
import { instagram_send_lanes } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.schema.js';
import {
  type InstagramOutgoingMessageFixtureRow,
  readInstagramOutgoingMessages,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/__tests__/factories/instagram-outgoing-message.factory.js';
import type { InstagramSendTicketContext } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { automation_reply_states } from '@/domains/app/sub-domains/automation/automation-reply-state.schema.js';
import { AUTOMATION_PUBLIC_REPLY_HOUR_LIMIT_DEFAULT } from '@/domains/app/sub-domains/automation/automation.constants.js';
import {
  replyBoxMilliseconds,
  replyBoxOffsetMilliseconds,
} from '@/domains/app/sub-domains/instagram-sending/instagram-send-pace.util.js';
import type { InstagramCommentFlow, TestInstagramPerson } from './instagram-comment-flow.helper.js';

/** How far time passes by default: the answer delays and boxes, not a nudge's hour (5 minutes). */
const DEFAULT_TIME_HORIZON_MILLISECONDS = 5 * 60_000;

/** One call the send core made to Instagram, read off the nocked Graph API. */
export interface MetaSendCall {
  kind: 'direct_message' | 'public_reply' | 'hide_comment';
  /** The Graph path after the version (`<ig user>/messages`, `<comment>/replies`, `<comment>`). */
  path: string;
  /** The JSON (or form) body Instagram got. */
  body: Record<string, unknown>;
}

/** A returned ticket (BullMQ's `DelayedError` in a real worker). */
class TicketReturned extends Error {
  constructor(readonly delayMilliseconds: number) {
    super('ticket returned');
  }
}

/**
 * Sub-domain 6 for real (feat-instagram-dm-sending ROUTE rows R54–R55): the app's own send core
 * — the lanes, the gates, the counts, the one result save telling the engine — worked ticket by
 * ticket as the slow, reply and fast workers would, every Meta call answered by nock and recorded
 * in order. Time passing is the database's: a message or a lane waiting for later is moved to now.
 */
export class InstagramSendDriver {
  /** Everything sent to Instagram, in order. */
  readonly calls: MetaSendCall[] = [];
  /** The refusals the next calls of a kind answer (queued, one per call). */
  private readonly refusals: Record<MetaSendCall['kind'], Array<{ status: number; body: object }>> =
    { direct_message: [], public_reply: [], hide_comment: [] };
  private readonly scope;
  private nextMessageId = 1;
  private readonly isSendingEnabledBefore = env.SENDING_ENABLED;

  constructor(
    private readonly app: FastifyInstance,
    private readonly flow: InstagramCommentFlow,
  ) {
    this.scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: flow.team.organization.public_id });
    env.SENDING_ENABLED = true;
  }

  /** Puts the sending switch back (call in `afterEach`). */
  restore(): void {
    env.SENDING_ENABLED = this.isSendingEnabledBefore;
  }

  /**
   * Answers every Graph send (persisted until `nock.cleanAll()`), recorded in order: DMs and private
   * replies, public replies, hides. nock hands a `fetch` call over as its `Request`.
   */
  mockInstagram(): void {
    const version = `/${META_GRAPH_VERSION}/`;
    const graphPath = (pattern: RegExp) => (pathname: string) =>
      pattern.test((pathname.split('?')[0] ?? '').slice(version.length));
    const record = async (kind: MetaSendCall['kind'], request: unknown): Promise<void> => {
      const url = new URL((request as Request).url);
      const text = await (request as Request).text();
      let body: Record<string, unknown> = Object.fromEntries(url.searchParams);
      if (text !== '') {
        try {
          body = { ...body, ...(JSON.parse(text) as Record<string, unknown>) };
        } catch {
          body = { ...body, ...Object.fromEntries(new URLSearchParams(text)) };
        }
      }
      this.calls.push({ kind, path: url.pathname.slice(version.length), body });
    };
    nock(META_GRAPH_BASE_URL)
      .persist()
      .post(graphPath(/^[^/]+\/messages$/))
      .query(true)
      .reply(async (request: unknown) => {
        await record('direct_message', request);
        const refusal = this.refusals.direct_message.shift();
        if (refusal !== undefined) return [refusal.status, refusal.body];
        return [200, { recipient_id: 'recipient', message_id: `mid.flow-${this.nextMessageId++}` }];
      })
      .post(graphPath(/^\d+\/replies$/))
      .query(true)
      .reply(async (request: unknown) => {
        await record('public_reply', request);
        const refusal = this.refusals.public_reply.shift();
        if (refusal !== undefined) return [refusal.status, refusal.body];
        return [200, { id: `1799${this.nextMessageId++}` }];
      })
      .post(graphPath(/^\d+$/))
      .query(true)
      .reply(async (request: unknown) => {
        await record('hide_comment', request);
        const refusal = this.refusals.hide_comment.shift();
        if (refusal !== undefined) return [refusal.status, refusal.body];
        return [200, { success: true }];
      });
  }

  /** Makes the next call of `kind` answer Graph's error `code` (400; queued, one per call). */
  refuseNext({
    kind,
    code,
    subcode,
  }: {
    kind: MetaSendCall['kind'];
    code: number;
    subcode?: number;
  }): void {
    this.refusals[kind].push({
      status: 400,
      body: {
        error: {
          message: 'Instagram refused the call',
          type: 'OAuthException',
          code,
          ...(subcode === undefined ? {} : { error_subcode: subcode }),
          fbtrace_id: 'trace-flow',
        },
      },
    });
  }

  /** Delivers one `messaging[]` item from the person to route 17, then runs intake (not the lanes). */
  async deliverMessaging({
    person,
    item,
  }: {
    person: TestInstagramPerson;
    item: Record<string, unknown>;
  }): Promise<void> {
    await this.flow.deliver({
      messaging: [
        {
          sender: { id: person.instagramUserId },
          recipient: { id: this.flow.account.instagramUserId },
          timestamp: Date.now(),
          ...item,
        },
      ],
    });
    await this.flow.processEvents();
  }

  /** The DMs Instagram took (private replies included), in order. */
  get directMessages(): MetaSendCall[] {
    return this.calls.filter((call) => call.kind === 'direct_message');
  }

  /** The postback payload of the last button message Instagram took — what her tap sends back. */
  lastButtonPayload(): string {
    for (const call of [...this.directMessages].reverse()) {
      const payload = (
        call.body.message as
          | { attachment?: { payload?: { buttons?: Array<{ payload?: string }> } } }
          | undefined
      )?.attachment?.payload?.buttons?.find((button) => button.payload !== undefined)?.payload;
      if (payload !== undefined) return payload;
    }
    throw new Error('no button message was sent');
  }

  /** The text of a call Instagram took (a DM's text, a button template's text, a reply's message). */
  static textOf(call: MetaSendCall): string | undefined {
    const message = call.body.message as
      | string
      | { text?: string; attachment?: { payload?: { text?: string } } }
      | undefined;
    if (typeof message === 'string') return message;
    return message?.text ?? message?.attachment?.payload?.text;
  }

  /** The person taps the button of the last button message, then intake runs (the lanes not yet). */
  async tapLastButton(person: TestInstagramPerson): Promise<void> {
    await this.deliverMessaging({
      person,
      item: {
        postback: {
          mid: `m_${randomUUID()}`,
          title: 'the button',
          payload: this.lastButtonPayload(),
        },
      },
    });
  }

  /** The organization's messages, oldest first. */
  messages(): Promise<InstagramOutgoingMessageFixtureRow[]> {
    return readInstagramOutgoingMessages(this.flow.team.organization.id);
  }

  /**
   * Works every message that may go now: the fast tickets one by one, then a turn of each paced
   * lane — until a pass sends nothing. `passTime` first moves every waiting message's and lane's
   * "not before" to now (time passing, seen from the database; a nudge or a list wait comes due).
   */
  async drain({
    passTime = false,
    horizonMilliseconds = DEFAULT_TIME_HORIZON_MILLISECONDS,
  }: {
    passTime?: boolean;
    /** How far time passes: only what is due within it comes due (a nudge's hour does not). */
    horizonMilliseconds?: number;
  } = {}): Promise<void> {
    // A paced lane's first turn may only set its box (`next_run_at`): with time passing, a second
    // quiet pass is the end.
    let quietPasses = 0;
    for (let pass = 0; pass < 30; pass += 1) {
      if (passTime) await this.passTime({ horizonMilliseconds });
      const before = await this.fingerprint();
      await this.workFastTickets();
      for (const lane of ['reply', 'slow'] as const) await this.workLaneTurn(lane);
      quietPasses = (await this.fingerprint()) === before ? quietPasses + 1 : 0;
      if (quietPasses >= (passTime ? 2 : 1)) return;
    }
    throw new Error('the lanes never settled');
  }

  /** Moves the waiting messages due within the horizon, and every lane's time, to now (time passing). */
  async passTime({
    horizonMilliseconds = DEFAULT_TIME_HORIZON_MILLISECONDS,
  }: {
    horizonMilliseconds?: number;
  } = {}): Promise<void> {
    const database = getOperatorDatabase();
    const organizationId = this.flow.team.organization.id;
    await database
      .update(instagram_outgoing_messages)
      .set({
        not_before: sql`LEAST(${instagram_outgoing_messages.not_before}, now() - interval '1 second')`,
      })
      .where(
        and(
          eq(instagram_outgoing_messages.organization_id, organizationId),
          eq(instagram_outgoing_messages.status, 'waiting'),
          sql`${instagram_outgoing_messages.not_before} <= now() + make_interval(secs => ${horizonMilliseconds / 1_000})`,
        ),
      );
    await database
      .update(instagram_send_lanes)
      .set({
        next_run_at: sql`LEAST(${instagram_send_lanes.next_run_at}, now() - interval '1 second')`,
        last_sent_at: sql`${instagram_send_lanes.last_sent_at} - interval '1 hour'`,
      })
      .where(eq(instagram_send_lanes.organization_id, organizationId));
    await this.passReplyBoxes();
  }

  /**
   * Each "Reply like a person" box (plan §29.3) moved back so its automation's random second has
   * just passed while the box still runs — the clock reaching that second.
   */
  private async passReplyBoxes(): Promise<void> {
    const states = await getOperatorDatabase()
      .select({
        id: automation_reply_states.id,
        automationId: automation_reply_states.automation_id,
        hourLimit: automations.public_reply_hour_limit,
      })
      .from(automation_reply_states)
      .innerJoin(automations, eq(automations.id, automation_reply_states.automation_id))
      .where(eq(automation_reply_states.organization_id, this.flow.team.organization.id));
    const now = Date.now();
    for (const state of states) {
      const box = replyBoxMilliseconds({
        hourLimit: state.hourLimit ?? AUTOMATION_PUBLIC_REPLY_HOUR_LIMIT_DEFAULT,
        isSlowed: false,
      });
      for (let elapsed = box - 1_000; elapsed > 0; elapsed -= 997) {
        const boxStart = new Date(now - elapsed);
        const offset = replyBoxOffsetMilliseconds({
          automationId: state.automationId,
          boxStart,
          boxMilliseconds: box,
        });
        if (offset <= elapsed) {
          await getOperatorDatabase()
            .update(automation_reply_states)
            .set({ box_start: boxStart })
            .where(eq(automation_reply_states.id, state.id));
          break;
        }
      }
    }
  }

  /** A signature of the messages' states, to see a pass that moved nothing. */
  private async fingerprint(): Promise<string> {
    const rows = await this.messages();
    return JSON.stringify(rows.map((row) => [row.id, row.status, row.lane, row.tries]));
  }

  private context(): InstagramSendTicketContext {
    return {
      jobId: `flow-ticket-${this.nextMessageId++}`,
      runInDatabaseSlot: (callback) => callback(),
      returnTicket: async (delayMilliseconds) => {
        throw new TicketReturned(delayMilliseconds);
      },
    };
  }

  private async workFastTickets(): Promise<void> {
    const work = this.app.appDomain.instagramSendWork.fastMessage;
    if (work === null) throw new Error('no fast send work');
    const due = (await this.messages()).filter(
      (row) =>
        row.lane === 'fast' &&
        row.status === 'waiting' &&
        (row.not_before === null || row.not_before.getTime() <= Date.now()),
    );
    for (const message of due) {
      await this.ignoringReturnedTicket(() =>
        work.sendFastMessage({
          ticket: {
            organizationPublicId: this.flow.team.organization.public_id,
            channelAccountPublicId: this.flow.account.publicId,
            instagramMessagePublicId: message.public_id,
            automationRunStartedAt: message.automation_run_started_at!.toISOString(),
            tries: message.tries,
          },
          scope: this.scope,
          context: this.context(),
        }),
      );
    }
  }

  /** Works one ticket of a paced lane with its current turn number (a returned ticket is no error). */
  async workLaneTurn(lane: 'slow' | 'reply'): Promise<void> {
    const work = this.app.appDomain.instagramSendWork.laneTurn;
    if (work === null) throw new Error('no lane send work');
    const [row] = await getOperatorDatabase()
      .select({ turnNumber: instagram_send_lanes.turn_number })
      .from(instagram_send_lanes)
      .where(
        and(
          eq(instagram_send_lanes.organization_id, this.flow.team.organization.id),
          eq(instagram_send_lanes.channel_account_id, this.flow.account.channelAccountId),
          inArray(instagram_send_lanes.lane, [lane]),
        ),
      );
    if (row === undefined) return;
    await this.ignoringReturnedTicket(() =>
      work.workLaneTurn({
        ticket: {
          organizationPublicId: this.flow.team.organization.public_id,
          channelAccountPublicId: this.flow.account.publicId,
          lane,
          turnNumber: row.turnNumber,
        },
        scope: this.scope,
        context: this.context(),
      }),
    );
  }

  private async ignoringReturnedTicket(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof TicketReturned)) throw error;
    }
  }
}
