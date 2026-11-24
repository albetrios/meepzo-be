import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { createHmac, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import type {
  InstagramMessageRecipient,
  InstagramOutgoingMessage,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
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
import { AutomationPublicReplySafetyService } from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import {
  type AutomationInstagramClient,
  AutomationRunMessageService,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { contacts } from '@/domains/app/sub-domains/contact/contact.schema.js';
import { instagram_accounts } from '@/domains/app/sub-domains/instagram-account/instagram-account.schema.js';
import { channel_accounts } from '@/domains/app/sub-domains/channel-account/channel-account.schema.js';
import { instagram_media } from '@/domains/app/sub-domains/instagram-account/instagram-media/instagram-media.schema.js';
import { instagram_webhook_events } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.schema.js';
import {
  type InstagramWebhookAccountJobResult,
  type InstagramWebhookProcessingInstagramClient,
  type InstagramWebhookProcessingServices,
  processInstagramWebhookAccountJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js';
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
  AUTOMATIONS_PATH,
  type AutomationFixtureRow,
  automationPath,
  commentAutomationBody,
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
const INSTAGRAM_WEBHOOK_PATH = testApiPath('/app/social/instagram/webhook');

/** An Instagram user who comments, clicks and answers. */
export interface TestInstagramPerson {
  instagramUserId: string;
  username: string;
}

/** The account the team connected through route 1. */
export interface TestConnectedAccount {
  id: number;
  publicId: string;
  /** The webhook's `entry.id`. */
  instagramUserId: string;
  /** The app-scoped id the sends go from. */
  instagramAppUserId: string;
  username: string;
}

/** The two kinds of send a test can make Instagram fail. */
export type FakeInstagramSendKind = 'direct_message' | 'public_reply';

/** One thing the flow asked Instagram for (or the pause before it), in the order it happened. */
export type FakeInstagramCall =
  | { kind: 'pause'; milliseconds: number }
  | {
      kind: 'direct_message';
      recipient: InstagramMessageRecipient;
      message: InstagramOutgoingMessage;
      isDelivered: boolean;
    }
  | { kind: 'public_reply'; instagramCommentId: string; text: string; isDelivered: boolean }
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
    for (const { message } of [...this.directMessages].reverse()) {
      const buttons = message.attachment?.payload.buttons;
      if (!Array.isArray(buttons)) continue;
      const postback = (buttons as Array<{ type: string; payload?: string }>).find(
        (button) => button.type === 'postback',
      );
      if (postback?.payload !== undefined) return postback.payload;
    }
    throw new Error('no button message was sent');
  }

  /** The run engine's client: its sends and the follow read. */
  readonly engineClient: AutomationInstagramClient = {
    sendInstagramMessage: async ({ recipient, message }) => {
      const failure = this.failures.direct_message.shift();
      this.calls.push({
        kind: 'direct_message',
        recipient,
        message,
        isDelivered: failure === undefined,
      });
      if (failure !== undefined) throw failure;
      return { messageId: `m_${randomUUID()}`, recipientId: null };
    },
    replyToInstagramComment: async ({ instagramCommentId, text }) => {
      const failure = this.failures.public_reply.shift();
      this.calls.push({
        kind: 'public_reply',
        instagramCommentId,
        text,
        isDelivered: failure === undefined,
      });
      if (failure !== undefined) throw failure;
      return { instagramCommentReplyId: nextInstagramObjectId() };
    },
    readInstagramUserProfile: async ({ instagramScopedUserId }) => {
      this.calls.push({ kind: 'follow_read', instagramUserId: instagramScopedUserId });
      return {
        ...this.profileOf(instagramScopedUserId),
        isUserFollowingBusiness: this.followAnswers.shift() ?? null,
      };
    },
  };

  /** Event processing's client: a new contact's profile and a post seen for the first time. */
  readonly processingClient: InstagramWebhookProcessingInstagramClient = {
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
  /** The next reply-safety draws; `0` once empty (a reply goes, the smallest gap, the first text). */
  readonly safetyDraws: number[] = [];
  private readonly services: InstagramWebhookProcessingServices;
  private connectedAccount: TestConnectedAccount | null = null;

  private constructor(
    private readonly app: FastifyInstance,
    readonly team: InstagramTeamFixture,
  ) {
    const { appDomain } = app;
    this.services = {
      ...appDomain,
      automationRunService: new AutomationRunService(
        appDomain.instagramAccountService,
        appDomain.contactService,
        // The pause is recorded, not waited for; its length is the service's own random draw.
        new AutomationRunMessageService(this.instagram.engineClient, async (milliseconds) => {
          this.instagram.calls.push({ kind: 'pause', milliseconds });
        }),
        new AutomationPublicReplySafetyService((maxExclusive) =>
          Math.min(this.safetyDraws.shift() ?? 0, maxExclusive - 1),
        ),
      ),
    };
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
      .select({ id: instagram_accounts.id, public_id: channel_accounts.public_id })
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

  /** Creates a live comment automation (route 12); any field may be overridden. */
  async createAutomation(body: AutomationBody): Promise<AutomationFixtureRow> {
    const response = await this.request({
      method: 'POST',
      url: AUTOMATIONS_PATH,
      payload: commentAutomationBody({ status: 'live', ...body }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return this.readAutomation((response.json() as { data: { id: string } }).data.id);
  }

  /** Creates a live comment automation that sends its final message and nothing before it. */
  async createFinalMessageAutomation(body: AutomationBody): Promise<AutomationFixtureRow> {
    return this.createAutomation({
      is_opening_message_enabled: false,
      opening_message: null,
      ...body,
    });
  }

  /** Changes an automation (route 14). */
  async editAutomation({
    automation,
    body,
  }: {
    automation: AutomationFixtureRow;
    body: AutomationBody;
  }): Promise<void> {
    const response = await this.request({
      method: 'PATCH',
      url: automationPath(automation.public_id),
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  /** Deletes an automation (route 15). */
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

  /** Runs the account's processing job once (R14's processor), with the fake Instagram. */
  async processEvents(): Promise<InstagramWebhookAccountJobResult> {
    return processInstagramWebhookAccountJob({
      jobData: {
        organizationPublicId: this.team.organization.public_id,
        instagramAccountPublicId: this.account.publicId,
      },
      services: this.services,
      jobId: `job-${randomUUID()}`,
      instagramClient: this.instagram.processingClient,
      enqueueFollowUp: async () => undefined,
    });
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

  /** Removes one stored event, as the 30-day clean-up does. */
  async removeEvent(eventKey: string): Promise<void> {
    await getOperatorDatabase()
      .delete(instagram_webhook_events)
      .where(
        and(
          eq(instagram_webhook_events.organization_id, this.team.organization.id),
          eq(instagram_webhook_events.event_key, eventKey),
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
          eq(instagram_media.instagram_account_id, this.account.id),
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
