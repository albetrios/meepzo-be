import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { readChannelAccountPublicIdOfInstagramAccount } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import { createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import type {
  InstagramMessageRecipient,
  readInstagramUserProfile,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import type {
  ChannelSendingPort,
  ChannelWaitingMessageSelection,
  SaveWaitingMessageInput,
  SaveWaitingMessageResult,
} from '@/domains/app/app.channel-ports.js';
import { EMPTY_MESSAGE_HISTORY_PORT_PARTS } from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/recording-sending-port.factory.js';
import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { buildAutomationButtonPayload } from '@/domains/app/sub-domains/automation/automation-run/automation-run-button-payload.util.js';
import { automations } from '@/domains/app/sub-domains/automation/automation.schema.js';
import { AUTOMATION_RUN_CHAT_WINDOW_MILLISECONDS } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import {
  readMetaGraphErrorResponse,
  toMetaGraphApiError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { getEnv } from '@/shared/config/env.config.js';
import {
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
} from '@/shared/constants/ttl.constants.js';
import { automation_comment_logs } from '@/domains/app/sub-domains/automation/automation-run/automation-comment-log.schema.js';
import { automation_runs } from '@/domains/app/sub-domains/automation/automation-run/automation-run.schema.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { instagram_webhook_events } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.js';
import { instagram_webhook_event_keys } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event-key.schema.js';
import type {
  InstagramWebhookIntakeInstagramClient,
  InstagramWebhookIntakeJobResult,
  InstagramWebhookIntakeServices,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook-intake.processor.js';
import { createInstagramContactProfileReadTaskHandler } from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-contact-profile-read.processor.js';
import { runInstagramIntakeOfAccount } from './instagram-intake-run.helper.js';
import {
  type InstagramTeamFixture,
  buildInstagramProfile,
  createInstagramTeam,
  connectInstagramAccount,
  mockInstagramUnsubscribe,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import {
  type ContactFixtureRow,
  nextInstagramUserId,
  readAccountContactRows,
  updateContactActivity,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  type AutomationFixtureRow,
  automationActionPath,
  automationPath,
  insertAutomation,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationCommentLogFixtureRow,
  type AutomationRunFixtureRow,
  nextInstagramObjectId,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import { getOperatorDatabase } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
  injectRoute,
} from '@/tests/helpers/test-http-inject.helper.js';

/** Meta's delivery route (route 17). */
const INSTAGRAM_WEBHOOK_PATH = testApiPath(
  '/app/social/channel-connections/meta/webhooks/instagram',
);

/** An Instagram user who comments, clicks and answers. */
export interface TestInstagramPerson {
  instagramUserId: string;
  username: string;
}

/** The account the team connected through route 1. */
export interface TestConnectedAccount {
  id: number;
  /** `app.channel_accounts.id` — the key of the stored posts (P47, R8). */
  channelAccountId: number;
  publicId: string;
  /** The webhook's `entry.id`. */
  instagramUserId: string;
  /** The app-scoped id the sends go from. */
  instagramAppUserId: string;
  username: string;
}

/** The two kinds of send a test can make Instagram fail. */
export type FakeInstagramSendKind = 'direct_message' | 'public_reply';

/**
 * One thing sent to Instagram, in the order it happened. Since R14 the run engine never sends: it
 * saves waiting messages through the channel's sending port (AU35); this fake port stands in for
 * sub-domain 6 (R19–R20) and "sends" each one at once, reporting its result to the engine.
 */
export type FakeInstagramCall =
  | {
      kind: 'direct_message';
      recipient: InstagramMessageRecipient;
      /** The run step the message is (`hello`, `follow`, `email`, `phone`, `messages`). */
      step: SaveWaitingMessageInput['step'];
      messageNumber: number | null;
      /** The step path its text is read from at send (content by reference). */
      stepPath: string;
      isDelivered: boolean;
    }
  | { kind: 'public_reply'; instagramCommentId: string; isDelivered: boolean }
  | { kind: 'hide_comment'; instagramCommentId: string }
  | { kind: 'follow_read'; instagramUserId: string }
  | { kind: 'profile_read'; instagramUserId: string }
  | { kind: 'post_read'; instagramMediaId: string };

/** A Graph API error answer, read by the real client's reader (class, codes, trace id). */
function instagramErrorAnswer({
  httpStatus,
  code,
  subcode,
}: {
  httpStatus: number;
  code: number;
  subcode?: number;
}): unknown {
  return readMetaGraphErrorResponse({
    httpStatus,
    body: JSON.stringify({
      error: {
        message: 'Instagram refused the call',
        type: 'OAuthException',
        code,
        ...(subcode === undefined ? {} : { error_subcode: subcode }),
        fbtrace_id: 'trace-fixture',
      },
    }),
    retryAfterHeader: null,
  });
}

/** The failures Instagram answers a send with, each as the real client would throw it. */
export const instagramFailure = {
  /** Code 4 — slow down; not delivered, worth a retry. */
  throttled: () => instagramErrorAnswer({ httpStatus: 400, code: 4 }),
  /** A 500 — not delivered, worth a retry. */
  serverError: () => instagramErrorAnswer({ httpStatus: 500, code: 2 }),
  /** Code 10 / 2534022 — outside the messaging window; never delivered. */
  outsideMessagingWindow: () =>
    instagramErrorAnswer({ httpStatus: 400, code: 10, subcode: 2_534_022 }),
  /** Code 100 / 2534015 — the email or phone quick reply is refused. */
  quickReplyRefused: () => instagramErrorAnswer({ httpStatus: 400, code: 100, subcode: 2_534_015 }),
  /** Code 190 — the access token is dead. */
  deadToken: () => instagramErrorAnswer({ httpStatus: 400, code: 190 }),
  /** The request left and no answer came back — it may have been delivered. */
  timeout: () =>
    toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'timeout' }),
    ),
};

/**
 * Instagram, faked: every call recorded in order, failures and follow answers queued by the test.
 * Never a network call.
 */
export class FakeInstagram {
  /** Everything the flow did to Instagram, pauses included, in order. */
  readonly calls: FakeInstagramCall[] = [];
  /** The answers of the next follow reads; `null` (Instagram does not say) once empty. */
  readonly followAnswers: Array<boolean | null> = [];
  /** When each post was published; a minute ago unless the test says otherwise. */
  readonly publishedAtByPost = new Map<string, Date>();

  private readonly people = new Map<string, TestInstagramPerson>();
  private readonly failures: Record<FakeInstagramSendKind, unknown[]> = {
    direct_message: [],
    public_reply: [],
  };

  /** A new person Instagram knows. */
  person(username: string): TestInstagramPerson {
    const person = { instagramUserId: nextInstagramUserId(), username };
    this.people.set(person.instagramUserId, person);
    return person;
  }

  /** Makes the next send of `kind` fail with `failure` (queued, one per send). */
  failNext({ kind, failure }: { kind: FakeInstagramSendKind; failure: unknown }): void {
    this.failures[kind].push(failure);
  }

  /** The DMs Instagram took (private replies included), in order. */
  get directMessages(): Array<Extract<FakeInstagramCall, { kind: 'direct_message' }>> {
    return this.calls.filter((call) => call.kind === 'direct_message' && call.isDelivered) as Array<
      Extract<FakeInstagramCall, { kind: 'direct_message' }>
    >;
  }

  /** The public replies Instagram took, in order. */
  get publicReplies(): Array<Extract<FakeInstagramCall, { kind: 'public_reply' }>> {
    return this.calls.filter((call) => call.kind === 'public_reply' && call.isDelivered) as Array<
      Extract<FakeInstagramCall, { kind: 'public_reply' }>
    >;
  }

  /** How many calls of `kind` were made, delivered or not. */
  countOf(kind: FakeInstagramCall['kind']): number {
    return this.calls.filter((call) => call.kind === kind).length;
  }

  /** The comments Instagram took more than one private reply for — it allows one, so: none. */
  commentsAnsweredPrivatelyTwice(): string[] {
    const commentIds = this.directMessages.flatMap(({ recipient }) =>
      'comment_id' in recipient ? [recipient.comment_id] : [],
    );
    return commentIds.filter((commentId, index) => commentIds.indexOf(commentId) !== index);
  }

  /** The postback payload of the last button message Instagram took — what a click sends back. */
  lastPostbackPayload(): string {
    const payload = this.postbackPayloads.at(-1);
    if (payload === undefined) throw new Error('no button message was sent');
    return payload;
  }

  /** The `<aut_…>::<run_…>` payloads of the hello and follow messages sent, in order. */
  readonly postbackPayloads: string[] = [];

  /** The waiting messages the engine saved through the port, in order (nudges included). */
  readonly waitingMessages: Array<Omit<SaveWaitingMessageInput, 'databaseHandle'>> = [];

  /** How many of {@link waitingMessages} were already sent. */
  sentCount = 0;

  /** Takes a queued failure of `kind`, when one is queued. */
  takeFailure(kind: FakeInstagramSendKind): unknown {
    return this.failures[kind].shift();
  }

  /**
   * The sending port (AU35): records each waiting message. A queued `direct_message` failure makes
   * the save throw, so the engine's unit rolls back and the event is retried — a send that failed
   * for now, as the launch suites knew it.
   */
  readonly sendingPort: ChannelSendingPort = {
    saveWaitingMessage: async (input): Promise<SaveWaitingMessageResult> => {
      if (input.step !== 'public_reply' && input.step !== 'hide_comment') {
        const failure = this.failures.direct_message.shift();
        if (failure !== undefined) throw failure;
      }
      const { databaseHandle: _databaseHandle, ...rest } = input;
      this.waitingMessages.push(rest);
      return {
        messagePublicId: `igm_${randomUUID().replaceAll('-', '').slice(0, 21)}`,
        status: 'waiting',
      };
    },
    cancelWaitingMessages: async (_input: ChannelWaitingMessageSelection) => 0,
    skipWaitingMessages: async (_input: ChannelWaitingMessageSelection) => 0,
    ...EMPTY_MESSAGE_HISTORY_PORT_PARTS,
  };

  /** Event processing's client: a new contact's profile and a post seen for the first time. */
  readonly processingClient: InstagramWebhookIntakeInstagramClient & {
    readInstagramUserProfile: typeof readInstagramUserProfile;
  } = {
    readInstagramUserProfile: async ({ instagramScopedUserId }) => {
      this.calls.push({ kind: 'profile_read', instagramUserId: instagramScopedUserId });
      return this.profileOf(instagramScopedUserId);
    },
    readInstagramMediaItem: async ({ instagramMediaId }) => {
      this.calls.push({ kind: 'post_read', instagramMediaId });
      const publishedAt =
        this.publishedAtByPost.get(instagramMediaId) ??
        new Date(Date.now() - MILLISECONDS_PER_MINUTE);
      return {
        id: instagramMediaId,
        media_type: 'IMAGE',
        media_product_type: 'FEED',
        timestamp: publishedAt.toISOString(),
      };
    },
  };

  private profileOf(instagramUserId: string) {
    return {
      name: 'Jordan Lee',
      username: this.people.get(instagramUserId)?.username ?? null,
      profilePictureUrl: null,
      followerCount: 42,
      isUserFollowingBusiness: null,
    };
  }
}

/** What a test may set on a comment automation beside route 12's own fields. */
type AutomationBody = Record<string, unknown>;

/**
 * One team's comment flow over the real app: the account connected through route 1 (Instagram
 * mocked with nock), the settings and the automations changed through routes 3 and 12–15, every
 * event delivered signed to route 17, and the account's processing job run with the app's own
 * services — only Instagram (and the reply-safety draws) is faked.
 */
export class InstagramCommentFlow {
  readonly instagram = new FakeInstagram();
  private readonly services: InstagramWebhookIntakeServices;
  private readonly engine: AutomationRunService;
  private connectedAccount: TestConnectedAccount | null = null;

  private constructor(
    private readonly app: FastifyInstance,
    readonly team: InstagramTeamFixture,
  ) {
    const { appDomain } = app;
    // The real engine of the app's own services, its channel's sending port faked (AU35, R14).
    this.engine = new AutomationRunService({
      channelAccountService: appDomain.channelAccountService,
      contactService: appDomain.contactService,
      planAccessService: app.billingDomain.subscriptionService,
      countService: appDomain.automationCountService,
      replyStateService: appDomain.automationReplyStateService,
      sendingPorts: { instagram: this.instagram.sendingPort },
      drawInteger: () => 0,
    });
    this.services = { ...appDomain, automationRunService: this.engine };
  }

  /** A fresh team with its Instagram account connected. Needs the permission catalog seeded. */
  static async open(app: FastifyInstance): Promise<InstagramCommentFlow> {
    const flow = new InstagramCommentFlow(app, await createInstagramTeam());
    await flow.connectAccount();
    return flow;
  }

  get account(): TestConnectedAccount {
    if (this.connectedAccount === null) throw new Error('no account is connected');
    return this.connectedAccount;
  }

  /** Connects a new Instagram account for the team (a channel connection's start, callback and pick). */
  async connectAccount(): Promise<TestConnectedAccount> {
    const profile = buildInstagramProfile();
    await connectInstagramAccount({ app: this.app, token: this.team.ownerToken, profile });
    const [account] = await getOperatorDatabase()
      .select({
        id: instagram_accounts.id,
        channelAccountId: channel_accounts.id,
        public_id: channel_accounts.public_id,
      })
      .from(instagram_accounts)
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, instagram_accounts.organization_id),
          eq(channel_accounts.id, instagram_accounts.channel_account_id),
        ),
      )
      .where(
        and(
          eq(instagram_accounts.organization_id, this.team.organization.id),
          eq(instagram_accounts.instagram_user_id, profile.user_id),
        ),
      );
    if (account === undefined) throw new Error('the connect stored no account');
    this.connectedAccount = {
      id: account.id,
      channelAccountId: account.channelAccountId,
      publicId: account.public_id,
      instagramUserId: profile.user_id,
      instagramAppUserId: profile.id,
      username: profile.username,
    };
    return this.connectedAccount;
  }

  /** Disconnects the team's account (route 4). */
  async disconnectAccount(): Promise<void> {
    mockInstagramUnsubscribe({ instagramUserId: this.account.instagramAppUserId });
    const response = await this.request({
      method: 'DELETE',
      url: await organizationChannelAccountPath(this.team.organization.id),
    });
    expect(response.statusCode, response.body).toBe(204);
    this.connectedAccount = null;
  }

  /**
   * A live comment automation on the connected account, written directly (the shared routes' own
   * checks are their suite's, ROUTE row R13): the fixture's shared shape — a hello with a "sends
   * your next step" button and one text message — with any column overridden; `status` defaults to
   * `live` (`inactive` is `paused`), a `next` automation waits from now.
   */
  async createAutomation(body: AutomationBody): Promise<AutomationFixtureRow> {
    const { status, next_post_starts_at: startsAt, ...rest } = body;
    // A launch-style window start (an ISO string) is the go-live time of a `next` automation (P12).
    const columns: AutomationBody =
      startsAt === undefined || startsAt === null
        ? rest
        : { ...rest, next_post_starts_at: new Date(startsAt as string) };
    const isNext = columns.target_scope === 'next';
    return insertAutomation({
      name: 'Comment for the link',
      ...(isNext
        ? {
            ...(columns.next_post_starts_at === undefined && columns.target_starts_at === undefined
              ? { target_starts_at: new Date() }
              : {}),
            next_post_status: 'waiting',
          }
        : {}),
      ...(columns as Omit<Parameters<typeof insertAutomation>[0], 'organizationId'>),
      organizationId: this.team.organization.id,
      channelAccountId: this.account.channelAccountId,
      status: status === undefined || status === 'live' ? 'live' : 'paused',
    });
  }

  /** Creates a live comment automation that sends its final message and nothing before it. */
  async createFinalMessageAutomation(body: AutomationBody): Promise<AutomationFixtureRow> {
    return this.createAutomation({
      is_opening_message_enabled: false,
      opening_message: null,
      ...body,
    });
  }

  /** Changes an automation: `status` through go-live (`live`) or pause, the rest through route 30. */
  async editAutomation({
    automation,
    body,
  }: {
    automation: AutomationFixtureRow;
    body: AutomationBody;
  }): Promise<void> {
    const { status, ...fields } = body;
    const patch = Object.keys(fields).length === 0 ? null : fields;
    const action = status === undefined ? null : status === 'live' ? 'go-live' : 'pause';
    if (patch !== null) {
      const response = await this.request({
        method: 'PATCH',
        url: automationPath(automation.public_id),
        payload: patch,
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    if (action !== null) {
      const response = await this.request({
        method: 'POST',
        url: automationActionPath({ automationPublicId: automation.public_id, action }),
        ...(action === 'pause' ? { payload: { mode: 'keep' } } : {}),
      });
      expect(response.statusCode, response.body).toBe(200);
    }
  }

  /** Deletes an automation (route 31). */
  async deleteAutomation(automation: AutomationFixtureRow): Promise<void> {
    const response = await this.request({
      method: 'DELETE',
      url: `${automationPath(automation.public_id)}?reason=not_needed`,
    });
    expect(response.statusCode, response.body).toBe(204);
  }

  /** An automation's row as it is now. */
  async readAutomation(automationPublicId: string): Promise<AutomationFixtureRow> {
    const automation = await readAutomationRow(automationPublicId);
    if (automation === undefined) throw new Error('automation vanished');
    return automation;
  }

  /** Delivers one signed body to route 17, as Meta sends it, and expects `200 OK`. */
  async deliver({
    changes = [],
    messaging = [],
    instagramUserId = this.account.instagramUserId,
  }: {
    changes?: unknown[];
    messaging?: unknown[];
    /** The account the entry is for — the connected one unless the test says otherwise. */
    instagramUserId?: string;
  }): Promise<void> {
    const rawBody = JSON.stringify({
      object: 'instagram',
      entry: [
        {
          id: instagramUserId,
          time: Math.floor(Date.now() / MILLISECONDS_PER_SECOND),
          changes,
          messaging,
        },
      ],
    });
    const signature = createHmac('sha256', getEnv().META_APP_SECRET ?? '')
      .update(rawBody)
      .digest('hex');
    const response = await injectRoute(this.app, {
      method: 'POST',
      url: INSTAGRAM_WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${signature}`,
      },
      payload: Buffer.from(rawBody),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toBe('OK');
  }

  /** The person comments on a post; the comment's id. */
  async comment({
    person,
    postId,
    text,
    commentId = nextInstagramObjectId(),
    instagramUserId,
  }: {
    person: TestInstagramPerson;
    postId: string;
    text: string;
    commentId?: string;
    instagramUserId?: string;
  }): Promise<string> {
    await this.deliver({
      changes: [
        {
          field: 'comments',
          value: {
            id: commentId,
            from: { id: person.instagramUserId, username: person.username },
            media: { id: postId, media_product_type: 'FEED' },
            text,
          },
        },
      ],
      ...(instagramUserId === undefined ? {} : { instagramUserId }),
    });
    return commentId;
  }

  /** The person comments and the account's job runs. */
  async commentAndProcess(input: {
    person: TestInstagramPerson;
    postId: string;
    text: string;
    commentId?: string;
  }): Promise<string> {
    const commentId = await this.comment(input);
    await this.processEvents();
    return commentId;
  }

  /** The person sends a DM — typed text, or an answer tapped on Instagram's own quick reply. */
  async directMessage({
    person,
    text,
    quickReplyPayload,
  }: {
    person: TestInstagramPerson;
    text: string;
    quickReplyPayload?: string;
  }): Promise<string> {
    const messageId = `m_${randomUUID()}`;
    await this.deliver({
      messaging: [
        {
          ...this.messagingParties(person),
          message: {
            mid: messageId,
            text,
            ...(quickReplyPayload === undefined
              ? {}
              : { quick_reply: { payload: quickReplyPayload } }),
          },
        },
      ],
    });
    return `message:${messageId}`;
  }

  /** The person sends a DM and the account's job runs. */
  async answer(input: {
    person: TestInstagramPerson;
    text: string;
    quickReplyPayload?: string;
  }): Promise<string> {
    const eventKey = await this.directMessage(input);
    await this.processEvents();
    return eventKey;
  }

  /** The person clicks the button of the last message they got, and the account's job runs. */
  async clickLastButton(person: TestInstagramPerson): Promise<void> {
    await this.deliver({
      messaging: [
        {
          ...this.messagingParties(person),
          postback: {
            mid: `m_${randomUUID()}`,
            title: 'the button',
            payload: this.instagram.lastPostbackPayload(),
          },
        },
      ],
    });
    await this.processEvents();
  }

  /**
   * Runs the account's intake jobs once (comments, Live, messages — R38), with the fake Instagram,
   * the new contacts' profile-read tasks (S11), then "sends" every waiting message the engine saved,
   * as sub-domain 6 would (R19–R20), until none is left.
   */
  async processEvents(): Promise<InstagramWebhookIntakeJobResult> {
    const result = await runInstagramIntakeOfAccount({
      organizationPublicId: this.team.organization.public_id,
      channelAccountPublicId: await readChannelAccountPublicIdOfInstagramAccount(this.account.id),
      services: this.services,
      instagramClient: this.instagram.processingClient,
      profileReadHandler: createInstagramContactProfileReadTaskHandler({
        services: this.app.appDomain,
        readProfile: this.instagram.processingClient.readInstagramUserProfile,
      }),
    });
    await this.sendWaitingMessages();
    return result;
  }

  /**
   * Sub-domain 6, faked (AU35): each waiting message is sent at once and its result reported to the
   * engine — a follow check answers the next queued follow answer (unknown = "following", D12); a
   * nudge waits its hour and is never sent here. A message saved by a result is sent in turn.
   */
  async sendWaitingMessages(): Promise<void> {
    const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: this.team.organization.public_id });
    while (this.instagram.sentCount < this.instagram.waitingMessages.length) {
      const message = this.instagram.waitingMessages[this.instagram.sentCount] as Omit<
        SaveWaitingMessageInput,
        'databaseHandle'
      >;
      this.instagram.sentCount += 1;
      if (message.step === 'nudge' || !('automationRunId' in message.source)) continue;
      const contact = await this.contactById(message.contactId);
      let result: 'sent' | 'failed' = 'sent';
      let reason: string | null = null;
      if (message.step === 'follow_check') {
        this.instagram.calls.push({
          kind: 'follow_read',
          instagramUserId: contact.instagramUserId,
        });
        reason = this.instagram.followAnswers.shift() === false ? 'not_following' : 'following';
      } else if (message.step === 'public_reply' || message.step === 'hide_comment') {
        const commentId = message.answersEventId ?? '';
        if (message.step === 'public_reply') {
          const failure = this.instagram.takeFailure('public_reply');
          result = failure === undefined ? 'sent' : 'failed';
          this.instagram.calls.push({
            kind: 'public_reply',
            instagramCommentId: commentId,
            isDelivered: failure === undefined,
          });
        } else {
          this.instagram.calls.push({ kind: 'hide_comment', instagramCommentId: commentId });
        }
      } else {
        const isWindowOpen =
          contact.lastDirectMessageReceivedAt !== null &&
          Date.now() - contact.lastDirectMessageReceivedAt.getTime() <
            AUTOMATION_RUN_CHAT_WINDOW_MILLISECONDS;
        this.instagram.calls.push({
          kind: 'direct_message',
          recipient:
            message.answersEventId !== null && !isWindowOpen
              ? { comment_id: message.answersEventId }
              : { id: contact.instagramUserId },
          step: message.step,
          messageNumber: message.messageNumber,
          stepPath: message.content.stepPath,
          isDelivered: true,
        });
        if (message.step === 'hello' || message.step === 'follow') {
          this.instagram.postbackPayloads.push(
            await this.postbackPayloadOf(message.source.automationRunId),
          );
        }
      }
      await this.engine.recordMessageResult({
        scope,
        databaseHandle: undefined as never,
        organizationId: this.team.organization.id,
        channelAccountId: message.channelAccountId,
        automationRunId: message.source.automationRunId,
        automationRunStartedAt: message.source.automationRunStartedAt,
        messagePublicId: `igm_${message.step}`,
        step: message.step,
        messageNumber: message.messageNumber,
        result,
        reason,
        occurredAt: new Date(),
      });
    }
  }

  /** A contact's Instagram id and last DM time, read as the operator. */
  private async contactById(
    contactId: number,
  ): Promise<{ instagramUserId: string; lastDirectMessageReceivedAt: Date | null }> {
    const [row] = await getOperatorDatabase()
      .select({ instagramUserId: contacts.instagram_user_id })
      .from(contacts)
      .where(eq(contacts.id, contactId));
    const contact = (
      await readAccountContactRows({
        organizationId: this.team.organization.id,
        instagramAccountId: this.account.id,
      })
    ).find((candidate) => candidate.id === contactId);
    return {
      instagramUserId: row?.instagramUserId ?? '',
      lastDirectMessageReceivedAt: contact?.last_direct_message_received_at ?? null,
    };
  }

  /** The `<aut_…>::<run_…>` payload a run's button carries back. */
  private async postbackPayloadOf(runId: number): Promise<string> {
    const [row] = await getOperatorDatabase()
      .select({ runPublicId: automation_runs.public_id, automationPublicId: automations.public_id })
      .from(automation_runs)
      .innerJoin(
        automations,
        and(
          eq(automations.organization_id, automation_runs.organization_id),
          eq(automations.id, automation_runs.automation_id),
        ),
      )
      .where(eq(automation_runs.id, runId));
    if (row === undefined) throw new Error('no such run');
    return buildAutomationButtonPayload(row);
  }

  /** The stored webhook event with this key, or `undefined`. */
  async eventOf(eventKey: string) {
    const [event] = await getOperatorDatabase()
      .select()
      .from(instagram_webhook_events)
      .where(
        and(
          eq(instagram_webhook_events.organization_id, this.team.organization.id),
          eq(instagram_webhook_events.event_key, eventKey),
        ),
      );
    return event;
  }

  /**
   * Removes one stored event and its key, as the clean-up does — since R16 the key goes with its
   * day part, at the same 8 days as the event.
   */
  async removeEvent(eventKey: string): Promise<void> {
    await getOperatorDatabase()
      .delete(instagram_webhook_events)
      .where(
        and(
          eq(instagram_webhook_events.organization_id, this.team.organization.id),
          eq(instagram_webhook_events.event_key, eventKey),
        ),
      );
    await getOperatorDatabase()
      .delete(instagram_webhook_event_keys)
      .where(
        and(
          eq(instagram_webhook_event_keys.organization_id, this.team.organization.id),
          eq(instagram_webhook_event_keys.event_key, eventKey),
        ),
      );
  }

  /** The person's contact of the connected account. */
  async contactOf(person: TestInstagramPerson): Promise<ContactFixtureRow> {
    const contact = (
      await readAccountContactRows({
        organizationId: this.team.organization.id,
        instagramAccountId: this.account.id,
      })
    ).find((row) => row.instagram_user_id === person.instagramUserId);
    if (contact === undefined) throw new Error('the person has no contact');
    return contact;
  }

  /** Changes columns of the person's contact — time passing, seen from the database. */
  async updateContact({
    person,
    values,
  }: {
    person: TestInstagramPerson;
    values: Partial<ContactFixtureRow>;
  }): Promise<void> {
    const contact = await this.contactOf(person);
    const activityKeys = new Set([
      'last_message_received_at',
      'last_direct_message_received_at',
      'last_message_sent_at',
      'last_opening_message_at',
      'first_message_at',
      'last_comment_at',
      'comment_count',
      'last_story_activity_at',
      'last_broadcast_at',
    ]);
    const entries = Object.entries(values);
    const activityValues = Object.fromEntries(entries.filter(([key]) => activityKeys.has(key)));
    const contactValues = Object.fromEntries(entries.filter(([key]) => !activityKeys.has(key)));
    if (Object.keys(contactValues).length > 0) {
      await getOperatorDatabase()
        .update(contacts)
        .set(contactValues)
        .where(eq(contacts.id, contact.id));
    }
    if (Object.keys(activityValues).length > 0) {
      await updateContactActivity({ contactId: contact.id, values: activityValues });
    }
  }

  /** The organization's runs, oldest first. */
  async runs(): Promise<AutomationRunFixtureRow[]> {
    return getOperatorDatabase()
      .select()
      .from(automation_runs)
      .where(eq(automation_runs.organization_id, this.team.organization.id))
      .orderBy(asc(automation_runs.id));
  }

  /** The runs of one automation, oldest first. */
  async runsOf(automation: AutomationFixtureRow): Promise<AutomationRunFixtureRow[]> {
    return (await this.runs()).filter((run) => run.automation_id === automation.id);
  }

  /** The one run of an automation. */
  async onlyRunOf(automation: AutomationFixtureRow): Promise<AutomationRunFixtureRow> {
    const runs = await this.runsOf(automation);
    expect(runs).toHaveLength(1);
    return runs[0] as AutomationRunFixtureRow;
  }

  /** The comment logs of one comment, oldest first. */
  async logsOf(commentId: string): Promise<AutomationCommentLogFixtureRow[]> {
    return getOperatorDatabase()
      .select()
      .from(automation_comment_logs)
      .where(
        and(
          eq(automation_comment_logs.organization_id, this.team.organization.id),
          eq(automation_comment_logs.instagram_comment_id, commentId),
        ),
      )
      .orderBy(asc(automation_comment_logs.id));
  }

  /** The comment log of one comment × automation, or `undefined`. */
  async logOf({
    commentId,
    automation,
  }: {
    commentId: string;
    automation: AutomationFixtureRow;
  }): Promise<AutomationCommentLogFixtureRow | undefined> {
    return (await this.logsOf(commentId)).find((log) => log.automation_id === automation.id);
  }

  /** The stored posts of the connected account. */
  async storedPosts() {
    return getOperatorDatabase()
      .select()
      .from(instagram_media)
      .where(
        and(
          eq(instagram_media.organization_id, this.team.organization.id),
          eq(instagram_media.channel_account_id, this.account.channelAccountId),
        ),
      )
      .orderBy(asc(instagram_media.id));
  }

  /** The connected account's connection status. */
  async connectionStatus(): Promise<string | undefined> {
    const [account] = await getOperatorDatabase()
      .select({ connection_status: channel_accounts.connection_status })
      .from(instagram_accounts)
      .innerJoin(
        channel_accounts,
        and(
          eq(channel_accounts.organization_id, instagram_accounts.organization_id),
          eq(channel_accounts.id, instagram_accounts.channel_account_id),
        ),
      )
      .where(eq(instagram_accounts.id, this.account.id));
    return account?.connection_status;
  }

  /** Both sides and the time of a messaging item. */
  private messagingParties(person: TestInstagramPerson) {
    return {
      sender: { id: person.instagramUserId },
      recipient: { id: this.account.instagramUserId },
      timestamp: Date.now(),
    };
  }

  /** A request as the team's Owner, with a fresh idempotency key. */
  private request({
    method,
    url,
    payload,
  }: {
    method: 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: unknown;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(this.app, {
      method,
      url,
      token: this.team.ownerToken,
      headers: { 'x-idempotency-key': `comment-flow-${randomUUID()}` },
      ...(payload === undefined ? {} : { payload }),
    });
  }
}
