import { organizationChannelAccountPath } from '@/domains/app/sub-domains/channel-account/__tests__/factories/channel-account.factory.js';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import nock from 'nock';
import { expect } from 'vitest';
import type {
  InstagramMessageRecipient,
  InstagramOutgoingMessage,
  InstagramUserProfile,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import { MetaGraphApiError } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { getEnv } from '@/shared/config/env.config.js';
import { MILLISECONDS_PER_DAY } from '@/shared/constants/ttl.constants.js';
import { AutomationPublicReplySafetyService } from '@/domains/app/sub-domains/automation/automation-run/automation-public-reply-safety.service.js';
import {
  type AutomationInstagramClient,
  AutomationRunMessageService,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';
import { AutomationRunService } from '@/domains/app/sub-domains/automation/automation-run/automation-run.service.js';
import { runAutomationRunWaitExpiryJob } from '@/domains/app/sub-domains/automation/automation-run/workers/automation-run-wait-expiry.processor.js';
import {
  type InstagramWebhookAccountJobResult,
  type InstagramWebhookProcessingInstagramClient,
  processInstagramWebhookAccountJob,
} from '@/domains/app/sub-domains/instagram-webhook/workers/instagram-webhook.processor.js';
import {
  AUTOMATIONS_PATH,
  type AutomationFixtureRow,
  automationPath,
  readAutomationRow,
} from '@/domains/app/sub-domains/automation/__tests__/factories/automation.factory.js';
import {
  type AutomationRunFixtureRow,
  nextInstagramObjectId,
  readCommentLogRows,
  readRunEventTrail,
  readRunRows,
} from '@/domains/app/sub-domains/automation/automation-run/__tests__/factories/automation-run.factory.js';
import {
  type ContactFixtureRow,
  readAccountContactRows,
} from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import {
  INSTAGRAM_ACCOUNT_SETTINGS_PATH,
  type InstagramTeamFixture,
  buildInstagramProfile,
  createInstagramTeam,
  connectInstagramAccount,
  mockInstagramUnsubscribe,
  readInstagramAccountRows,
} from '@/domains/app/sub-domains/instagram-account/__tests__/factories/instagram-account.factory.js';
import { TEST_CONTACT_INSTAGRAM_USER_ID } from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook-event/__tests__/factories/instagram-webhook-event.factory.js';
import { operatorQuery } from '@/tests/helpers/operator-database.js';
import { testApiPath } from '@/tests/helpers/test-api-prefix.helper.js';
import {
  type InjectHttpResult,
  injectAuthenticated,
  injectRoute,
} from '@/tests/helpers/test-http-inject.helper.js';

/** `POST /app/social/instagram/webhook` (route 17). */
const INSTAGRAM_WEBHOOK_PATH = testApiPath('/app/social/instagram/webhook');

/** The person on the other side of a conversation, unless a test names another one. */
export const PERSON = TEST_CONTACT_INSTAGRAM_USER_ID;

/** One DM as Instagram received it, read for the assertions. */
export interface SentDirectMessage {
  recipient: InstagramMessageRecipient;
  text: string;
  /** The titles of its buttons, in order — a plain text has none. */
  buttonTitles: string[];
  /** The payloads of its postback buttons — what a click sends back. */
  postbackPayloads: string[];
  /** The addresses of its link buttons. */
  linkUrls: string[];
  /** The kinds of its quick replies (`user_email`, `user_phone_number`). */
  quickReplyTypes: string[];
}

/** One call to Instagram, in order: what was called and for whom — failed sends included. */
export interface RecordedInstagramCall {
  name: 'send_message' | 'reply_to_comment' | 'read_follow' | 'read_profile' | 'read_media';
  /** The recipient, the commented comment, the person or the post the call names. */
  target: string;
}

/** The fake Instagram client of one flow: every call recorded, the answers queued by the test. */
export interface RecordingInstagramClient {
  calls: RecordedInstagramCall[];
  /** The DMs Instagram took, in order. */
  sentMessages: SentDirectMessage[];
  /** Errors the next sends answer, first first; none left — the send is taken. */
  sendFailures: unknown[];
  /** What the next follow reads answer, first first; none left — Instagram does not say. */
  followAnswers: boolean[];
  /** The run engine's client (sends, the public reply, the follow read). */
  engineClient: AutomationInstagramClient;
  /** Event processing's own reads (a new contact's profile, a commented post). */
  processingClient: InstagramWebhookProcessingInstagramClient;
}

/** A button of Instagram's button template, as the engine sends it. */
interface SentButton {
  type: string;
  title: string;
  payload?: string;
  url?: string;
}

/** Reads a DM in Instagram's wire shape — a plain text or a button template. */
function readSentMessage({
  recipient,
  message,
}: {
  recipient: InstagramMessageRecipient;
  message: InstagramOutgoingMessage;
}): SentDirectMessage {
  const template = message.attachment?.payload as
    | { text?: string; buttons?: SentButton[] }
    | undefined;
  const buttons = template?.buttons ?? [];
  return {
    recipient,
    text: template?.text ?? message.text ?? '',
    buttonTitles: buttons.map((button) => button.title),
    postbackPayloads: buttons.flatMap((button) => button.payload ?? []),
    linkUrls: buttons.flatMap((button) => button.url ?? []),
    quickReplyTypes: (message.quick_replies ?? []).map((quickReply) => quickReply.content_type),
  };
}

/** The profile Instagram shows of a person who messaged the account. */
function personProfile(isUserFollowingBusiness: boolean | null): InstagramUserProfile {
  return {
    name: 'Jordan Lee',
    username: 'jordan.lee',
    profilePictureUrl: 'https://scontent.cdninstagram.com/v/jordan.jpg',
    followerCount: 42,
    isUserFollowingBusiness,
  };
}

/** A fake Instagram client that records every call and never reaches the network. */
export function createRecordingInstagramClient(): RecordingInstagramClient {
  const calls: RecordedInstagramCall[] = [];
  const sentMessages: SentDirectMessage[] = [];
  const sendFailures: unknown[] = [];
  const followAnswers: boolean[] = [];
  return {
    calls,
    sentMessages,
    sendFailures,
    followAnswers,
    engineClient: {
      sendInstagramMessage: async ({ recipient, message }) => {
        calls.push({
          name: 'send_message',
          target: 'id' in recipient ? recipient.id : recipient.comment_id,
        });
        const failure = sendFailures.shift();
        if (failure !== undefined) throw failure;
        sentMessages.push(readSentMessage({ recipient, message }));
        return { messageId: `m_${sentMessages.length}`, recipientId: null };
      },
      replyToInstagramComment: async ({ instagramCommentId }) => {
        calls.push({ name: 'reply_to_comment', target: instagramCommentId });
        return { instagramCommentReplyId: '1' };
      },
      readInstagramUserProfile: async ({ instagramScopedUserId }) => {
        calls.push({ name: 'read_follow', target: instagramScopedUserId });
        return personProfile(followAnswers.shift() ?? null);
      },
    },
    processingClient: {
      readInstagramUserProfile: async ({ instagramScopedUserId }) => {
        calls.push({ name: 'read_profile', target: instagramScopedUserId });
        return personProfile(null);
      },
      readInstagramMediaItem: async ({ instagramMediaId }) => {
        calls.push({ name: 'read_media', target: instagramMediaId });
        return { id: instagramMediaId };
      },
    },
  };
}

/** Instagram refusing one DM for good — the person is outside the messaging window (D32). */
export function refusedSend(): MetaGraphApiError {
  return new MetaGraphApiError({
    errorClass: 'refused',
    category: 'http_4xx',
    httpStatus: 400,
    details: {
      code: 10,
      subcode: 2534022,
      type: 'OAuthException',
      fbtraceId: 'trace',
    },
    fallbackMessage: 'Instagram refused the message',
  });
}

/** Instagram asking to slow down — a temporary failure: nothing was sent. */
export function throttledSend(): MetaGraphApiError {
  return new MetaGraphApiError({
    errorClass: 'throttled',
    category: 'http_4xx',
    httpStatus: 429,
    details: { code: 4, subcode: null, type: 'OAuthException', fbtraceId: 'trace' },
    fallbackMessage: 'Instagram throttled the message',
  });
}

/** A live DM automation on the keyword `catalog` whose flow is the final message only (route 12). */
export function directMessageAutomation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Catalog by DM',
    status: 'live',
    trigger_type: 'dm',
    keywords: ['catalog'],
    is_opening_message_enabled: false,
    final_message: {
      text: 'Here is the catalog',
      links: [{ title: 'Open', url: 'https://shop.example.com/catalog' }],
    },
    ...overrides,
  };
}

/** A live story-reply automation on any story and any text, its flow the final message only. */
export function storyReplyAutomation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'Story answer',
    status: 'live',
    trigger_type: 'story_reply',
    keywords: [],
    is_dm_keyword_trigger_enabled: false,
    is_opening_message_enabled: false,
    final_message: { text: 'Thanks for your story reply' },
    ...overrides,
  };
}

/** One item of a delivery entry, and the list it sits in. */
interface DeliveredItem {
  source: 'messaging' | 'changes';
  item: Record<string, unknown>;
}

/** What a DM carries: a typed text, Instagram's own quick reply, attachments. */
interface DirectMessageContent {
  text?: string;
  /** `message.quick_reply.payload` — the email or phone Instagram's quick reply shares. */
  quickReplyPayload?: string;
  /** `message.attachments[].payload.email`. */
  attachmentEmail?: string;
  from?: string;
}

/** The connected Instagram account of a flow. */
interface FlowInstagramAccount {
  id: number;
  publicId: string;
  /** The webhook's id of the account — every delivery entry names it. */
  instagramUserId: string;
  /** The app-scoped id sends and the unsubscribe use. */
  instagramAppUserId: string;
}

/** A stored webhook event as the assertions read it. */
export interface FlowWebhookEvent {
  event_kind: string;
  status: string;
  attempt_count: number;
  error_message: string | null;
  processed_at: Date | null;
}

/**
 * One team's DM / story / button-click flow, driven the way production runs it: the Instagram
 * account connected (route 1), its automation switch saved (route 3), the automations created and
 * deleted (routes 12, 15) and Meta's events delivered signed (route 17) over HTTP, then the
 * account's processing job run through the real processor with the app's own services — only the
 * run engine's Instagram client is the fake of {@link createRecordingInstagramClient}, so every
 * call is recorded and nothing reaches the network.
 */
export class InstagramMessageFlow {
  readonly instagram = createRecordingInstagramClient();
  private readonly app: FastifyInstance;
  readonly team: InstagramTeamFixture;
  private connectedAccount: FlowInstagramAccount | null = null;
  private jobCount = 0;

  private constructor({ app, team }: { app: FastifyInstance; team: InstagramTeamFixture }) {
    this.app = app;
    this.team = team;
  }

  /** A team with its Instagram account connected and its automation switch on. */
  static async start(app: FastifyInstance): Promise<InstagramMessageFlow> {
    const flow = new InstagramMessageFlow({ app, team: await createInstagramTeam() });
    await flow.connect();
    await flow.saveSettings({ is_automation_enabled: true });
    return flow;
  }

  /** The account connected now. */
  get account(): FlowInstagramAccount {
    if (this.connectedAccount === null) throw new Error('no Instagram account is connected');
    return this.connectedAccount;
  }

  /** Connects a new Instagram account (route 1; Instagram's connect calls are nocked). */
  async connect(): Promise<void> {
    const profile = buildInstagramProfile();
    const { account } = await connectInstagramAccount({
      app: this.app,
      token: this.team.ownerToken,
      profile,
    });
    expect(nock.pendingMocks()).toEqual([]);
    // The Instagram row of the connected channel account (route 7 answers the `cha_` id, R5).
    const rows = await readInstagramAccountRows(this.team.organization.id);
    const row = rows.find(
      (candidate) => candidate.instagram_user_id === account.instagram.instagram_user_id,
    );
    this.connectedAccount = {
      id: Number(row?.id),
      publicId: row?.public_id ?? '',
      instagramUserId: profile.user_id,
      instagramAppUserId: profile.id,
    };
  }

  /** Disconnects the account (route 4). */
  async disconnect(): Promise<void> {
    mockInstagramUnsubscribe({ instagramAppUserId: this.account.instagramAppUserId });
    const response = await this.asOwner({
      method: 'DELETE',
      url: await organizationChannelAccountPath(this.team.organization.id),
    });
    expect(response.statusCode).toBe(204);
  }

  /** Changes the account's settings (route 3). */
  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    const response = await this.asOwner({
      method: 'PATCH',
      url: INSTAGRAM_ACCOUNT_SETTINGS_PATH,
      payload: settings,
    });
    expect(response.statusCode).toBe(200);
  }

  /** Creates an automation (route 12) and answers its public id — the later, the younger. */
  async createAutomation(body: Record<string, unknown>): Promise<string> {
    const response = await this.asOwner({
      method: 'POST',
      url: AUTOMATIONS_PATH,
      payload: body,
      headers: { 'x-idempotency-key': `message-flow-${randomUUID()}` },
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { data: { id: string } }).data.id;
  }

  /** Deletes an automation (route 15) — its open runs are cancelled with it (AU12). */
  async deleteAutomation(automationPublicId: string): Promise<void> {
    const response = await this.asOwner({
      method: 'DELETE',
      url: `${automationPath(automationPublicId)}?reason=not_needed`,
    });
    expect(response.statusCode).toBe(204);
  }

  /** A DM from a person (`messaging[]`). */
  directMessage({
    text,
    quickReplyPayload,
    attachmentEmail,
    from = PERSON,
  }: DirectMessageContent): DeliveredItem {
    return {
      source: 'messaging',
      item: {
        ...this.messagingItem(from),
        message: {
          mid: `m_${nextInstagramObjectId()}`,
          ...(text === undefined ? {} : { text }),
          ...(quickReplyPayload === undefined
            ? {}
            : { quick_reply: { payload: quickReplyPayload } }),
          ...(attachmentEmail === undefined
            ? {}
            : { attachments: [{ type: 'template', payload: { email: attachmentEmail } }] }),
        },
      },
    };
  }

  /** The same DM as Meta's `messages` change (`changes[]`, D18). */
  messagesChange(content: DirectMessageContent): DeliveredItem {
    return {
      source: 'changes',
      item: { field: 'messages', value: this.directMessage(content).item },
    };
  }

  /** A person's reply to one of the account's stories. */
  storyReply({
    storyId,
    text,
    from = PERSON,
  }: {
    storyId: string;
    text: string;
    from?: string;
  }): DeliveredItem {
    return {
      source: 'messaging',
      item: {
        ...this.messagingItem(from),
        message: {
          mid: `m_${nextInstagramObjectId()}`,
          text,
          reply_to: { story: { id: storyId, url: 'https://cdn.example.com/story.jpg' } },
        },
      },
    };
  }

  /** A person clicking a button of a DM they got: its payload comes back as a postback. */
  buttonClick({
    payload,
    from = PERSON,
  }: {
    payload: string | undefined;
    from?: string;
  }): DeliveredItem {
    return {
      source: 'messaging',
      item: {
        ...this.messagingItem(from),
        postback: { mid: `m_${nextInstagramObjectId()}`, title: 'Button', payload },
      },
    };
  }

  /** Delivers one event signed as Meta would (route 17): stored and queued before Meta's `OK`. */
  async deliver({ source, item }: DeliveredItem): Promise<void> {
    const rawBody = JSON.stringify({
      object: 'instagram',
      entry: [{ id: this.account.instagramUserId, time: Date.now(), [source]: [item] }],
    });
    const secret = getEnv().META_APP_SECRET ?? '';
    const response = await injectRoute(this.app, {
      method: 'POST',
      url: INSTAGRAM_WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
      },
      payload: Buffer.from(rawBody),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('OK');
    expect((await this.latestEvent()).status).toBe('queued');
  }

  /** Runs the account's processing job, as the `instagram-webhook` worker does (WH12–WH14). */
  runJob(): Promise<InstagramWebhookAccountJobResult> {
    this.jobCount += 1;
    const { appDomain } = this.app;
    return processInstagramWebhookAccountJob({
      jobData: {
        organizationPublicId: this.team.organization.public_id,
        instagramAccountPublicId: this.account.publicId,
      },
      services: {
        ...appDomain,
        automationRunService: new AutomationRunService(
          appDomain.instagramAccountService,
          appDomain.contactService,
          new AutomationRunMessageService(
            this.instagram.engineClient,
            async () => {},
            () => 0,
          ),
          new AutomationPublicReplySafetyService(() => 0),
        ),
      },
      jobId: `message-flow-job-${this.jobCount}`,
      instagramClient: this.instagram.processingClient,
      enqueueFollowUp: async () => undefined,
    });
  }

  /**
   * One event from delivery to its end: delivered (route 17), the account's job run, the event
   * `processed` in one attempt. Answers the DMs Instagram took because of it, in order.
   */
  async receive(delivered: DeliveredItem): Promise<SentDirectMessage[]> {
    const sentBefore = this.instagram.sentMessages.length;
    await this.deliver(delivered);
    expect(await this.runJob()).toMatchObject({
      outcome: 'drained',
      processedEventCount: 1,
      skippedEventCount: 0,
      failedEventCount: 0,
    });
    expect(await this.latestEvent()).toMatchObject({
      status: 'processed',
      attempt_count: 1,
      error_message: null,
    });
    return this.instagram.sentMessages.slice(sentBefore);
  }

  /** The hourly 7-day check, eight days from now: every waiting run is cancelled (`wait_expired`). */
  async cancelExpiredWaits(): Promise<number> {
    const { cancelled } = await runAutomationRunWaitExpiryJob({
      runService: this.app.appDomain.automationRunService,
      now: new Date(Date.now() + 8 * MILLISECONDS_PER_DAY),
    });
    return cancelled;
  }

  /** Moves the contact's last DM from the account 25 hours back — past the opening message's 24. */
  async ageLastSentMessage(): Promise<void> {
    await operatorQuery`
      UPDATE app.contacts SET last_message_sent_at = last_message_sent_at - interval '25 hours'
      WHERE organization_id = ${this.team.organization.id}
        AND instagram_account_id = ${this.account.id}`;
  }

  /** Every run of the organization, oldest first. */
  runs(): Promise<AutomationRunFixtureRow[]> {
    return readRunRows(this.team.organization.id);
  }

  /** The runs of one automation, oldest first. */
  async runsOf(automationPublicId: string): Promise<AutomationRunFixtureRow[]> {
    const automation = await this.automation(automationPublicId);
    return (await this.runs()).filter((run) => run.automation_id === automation.id);
  }

  /** The automation's only run. */
  async runOf(automationPublicId: string): Promise<AutomationRunFixtureRow> {
    const runs = await this.runsOf(automationPublicId);
    const [run] = runs;
    if (run === undefined || runs.length !== 1) {
      throw new Error(`expected one run of ${automationPublicId}, found ${runs.length}`);
    }
    return run;
  }

  /** A run's history, oldest first, as `<event_type>:<status>`. */
  trailOf(run: AutomationRunFixtureRow): Promise<string[]> {
    return readRunEventTrail(run.id);
  }

  /** The automation as it is stored. */
  async automation(automationPublicId: string): Promise<AutomationFixtureRow> {
    const automation = await readAutomationRow(automationPublicId);
    if (automation === undefined) throw new Error(`no automation ${automationPublicId}`);
    return automation;
  }

  /** The connected account's contact of a person. */
  async contact(instagramUserId: string = PERSON): Promise<ContactFixtureRow> {
    const rows = await readAccountContactRows({
      organizationId: this.team.organization.id,
      instagramAccountId: this.account.id,
    });
    const contact = rows.find((row) => row.instagram_user_id === instagramUserId);
    if (contact === undefined) throw new Error(`no contact ${instagramUserId}`);
    return contact;
  }

  /** The account's stored webhook events, oldest first. */
  events(): Promise<FlowWebhookEvent[]> {
    return operatorQuery<FlowWebhookEvent[]>`
      SELECT event_kind, status, attempt_count, error_message, processed_at
      FROM app.instagram_webhook_events
      WHERE organization_id = ${this.team.organization.id}
      ORDER BY created_at, id`;
  }

  /** The event stored last. */
  async latestEvent(): Promise<FlowWebhookEvent> {
    const event = (await this.events()).at(-1);
    if (event === undefined) throw new Error('no webhook event is stored');
    return event;
  }

  /** The organization's comment logs — a DM or a story reply never writes one. */
  async commentLogCount(): Promise<number> {
    return (await readCommentLogRows(this.team.organization.id)).length;
  }

  /** The account's `connection_status`. */
  async connectionStatus(): Promise<string | undefined> {
    const rows = await readInstagramAccountRows(this.team.organization.id);
    return rows.find((row) => row.public_id === this.account.publicId)?.connection_status;
  }

  /** The `sender`, `recipient` and time every `messaging[]` item carries. */
  private messagingItem(from: string): Record<string, unknown> {
    return {
      sender: { id: from },
      recipient: { id: this.account.instagramUserId },
      timestamp: Date.now(),
    };
  }

  /** A signed-in call of the team's Owner. */
  private asOwner(options: {
    method: 'POST' | 'PATCH' | 'DELETE';
    url: string;
    payload?: unknown;
    headers?: Record<string, string>;
  }): Promise<InjectHttpResult> {
    return injectAuthenticated(this.app, { ...options, token: this.team.ownerToken });
  }
}
