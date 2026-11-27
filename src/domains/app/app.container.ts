import type { FastifyInstance } from 'fastify';
import { redisConnection } from '@/infrastructure/cache/redis.client.js';
import {
  InstagramSendingWatchService,
  probeInstagramAccountReadOnly,
} from './sub-domains/instagram-sending/instagram-sending-watch.service.js';
import { measurePostgresClockSkewMilliseconds } from '@/infrastructure/queue/worker-runtime/worker-clock-watch.js';
import { readWorkerQueueHeartbeats } from '@/infrastructure/queue/worker-runtime/worker-queue-heartbeat.js';
import { INSTAGRAM_SENDING_REPAIR_QUEUE_NAME } from './sub-domains/instagram-sending/workers/instagram-sending-repair.constants.js';
import { readInstagramLateLaneGauge } from './sub-domains/instagram-sending/workers/instagram-sending-watch.processor.js';
import { registerHealthSendingProbe } from '@/shared/utils/infrastructure/health-operational-metrics.util.js';
import type { OrganizationService } from '@/domains/tenancy/sub-domains/organization/organization.service.js';
import { ChannelAccountRepository } from './sub-domains/channel-account/channel-account.repository.js';
import { ChannelAccountService } from './sub-domains/channel-account/channel-account.service.js';
import { ChannelAccountPlanStopService } from './sub-domains/channel-account/channel-account-plan-stop.service.js';
import type {
  ChannelConnectionLanePort,
  ChannelConnectionTrialPort,
} from './sub-domains/channel-connection/channel-connection.types.js';
import { ChannelConnectionRepository } from './sub-domains/channel-connection/channel-connection.repository.js';
import {
  type ChannelConnectionPlanAccessService,
  ChannelConnectionService,
} from './sub-domains/channel-connection/channel-connection.service.js';
import { ChannelConnectionTokenRepository } from './sub-domains/channel-connection/channel-connection-token.repository.js';
import { ChannelConnectionTokenService } from './sub-domains/channel-connection/channel-connection-token.service.js';
import { ChannelConnectionUsageRepository } from './sub-domains/channel-connection/channel-connection-usage.repository.js';
import {
  type ChannelConnectionUsageService,
  createChannelConnectionUsagePostgresStore,
  createChannelConnectionUsageService,
} from './sub-domains/channel-connection/channel-connection-usage.service.js';
import { InstagramAccountRepository } from './sub-domains/instagram-account/instagram-account.repository.js';
import { InstagramAccountService } from './sub-domains/instagram-account/instagram-account.service.js';
import { InstagramAccountExtensionService } from './sub-domains/instagram-account/instagram-account-extension.service.js';
import { InstagramAccountSettingsRepository } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.repository.js';
import { InstagramAccountSettingsService } from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.service.js';
import type {
  InstagramAccountSettingsChannelAccountPort,
  InstagramAccountSettingsLanePort,
} from './sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
import { InstagramAccountErasureService } from './sub-domains/instagram-account/instagram-account-erasure.service.js';
import { InstagramMediaRepository } from './sub-domains/instagram-account/instagram-media/instagram-media.repository.js';
import { InstagramMediaService } from './sub-domains/instagram-account/instagram-media/instagram-media.service.js';
import {
  ChannelConnectionMetaCallbackService,
  channelConnectionMetaCallbackTeamAlert,
} from './sub-domains/channel-connection/channel-connection-meta-callback.service.js';
import { InstagramWebhookEventRepository } from './sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.repository.js';
import { InstagramWebhookEventService } from './sub-domains/instagram-webhook/instagram-webhook-event/instagram-webhook-event.service.js';
import { InstagramWebhookService } from './sub-domains/instagram-webhook/instagram-webhook.service.js';
import {
  enqueueInstagramTagEventIntake,
  enqueueInstagramWebhookIntake,
} from './sub-domains/instagram-webhook/queues/instagram-webhook.queue.js';
import {
  INSTAGRAM_CONTACT_PROFILE_READ_JOB_NAME,
  createInstagramContactProfileReadTaskHandler,
} from './sub-domains/instagram-webhook/workers/instagram-contact-profile-read.processor.js';
import { INSTAGRAM_MISSED_COMMENT_CHECK_JOB_NAME } from './sub-domains/instagram-webhook/workers/instagram-missed-comment-check.constants.js';
import {
  createInstagramMissedCommentCheckTaskHandler,
  lookForMissedComments,
} from './sub-domains/instagram-webhook/workers/instagram-missed-comment-check.processor.js';
import {
  createInstagramNextPostLinkingTaskHandler,
  INSTAGRAM_NEXT_POST_LINKING_JOB_NAME,
} from './sub-domains/instagram-webhook/workers/instagram-next-post-linking.processor.js';
import {
  createInstagramPastCommentReadTaskHandler,
  INSTAGRAM_PAST_COMMENT_READ_JOB_NAME,
  INSTAGRAM_PAST_COMMENT_READ_QUEUE,
} from './sub-domains/instagram-webhook/workers/instagram-past-comment-read.processor.js';
import { ContactTagEventRepository } from './sub-domains/contact/contact-tag-event/contact-tag-event.repository.js';
import { ContactTagEventService } from './sub-domains/contact/contact-tag-event/contact-tag-event.service.js';
import { ContactRepository } from './sub-domains/contact/contact.repository.js';
import { ContactService } from './sub-domains/contact/contact.service.js';
import type {
  ContactErasureStep,
  ContactPauseStep,
  ContactRunEventReader,
} from './sub-domains/contact/contact.types.js';
import { AutomationRepository } from './sub-domains/automation/automation.repository.js';
import { AutomationCountRepository } from './sub-domains/automation/automation-count.repository.js';
import { AutomationCountService } from './sub-domains/automation/automation-count.service.js';
import { AutomationReplyStateRepository } from './sub-domains/automation/automation-reply-state.repository.js';
import { AutomationReplyStateService } from './sub-domains/automation/automation-reply-state.service.js';
import type {
  AutomationAttachmentUploadPort,
  AutomationMessageFilePort,
  AutomationOpenRunCancelStep,
} from './sub-domains/automation/automation.types.js';
import { AutomationService } from './sub-domains/automation/automation.service.js';
import { AutomationBackfillRepository } from './sub-domains/automation/automation-backfill/automation-backfill.repository.js';
import { AutomationBackfillService } from './sub-domains/automation/automation-backfill/automation-backfill.service.js';
import { AutomationRunService } from './sub-domains/automation/automation-run/automation-run.service.js';
import { BroadcastSegmentRepository } from './sub-domains/broadcast/broadcast-segment/broadcast-segment.repository.js';
import { BroadcastSegmentService } from './sub-domains/broadcast/broadcast-segment/broadcast-segment.service.js';
import { BroadcastRepository } from './sub-domains/broadcast/broadcast.repository.js';
import { BroadcastService } from './sub-domains/broadcast/broadcast.service.js';
import { BroadcastRecipientService } from './sub-domains/broadcast/broadcast-recipient/broadcast-recipient.service.js';
import type { BroadcastFeatureCheck } from './sub-domains/broadcast/broadcast.types.js';
import type { ChannelSendingPorts } from './app.channel-ports.js';
import { InstagramSendLaneRepository } from './sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from './sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from './sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { InstagramSendDayCountRepository } from './sub-domains/instagram-sending/instagram-send-day-count.repository.js';
import { MessageMonthCountRepository } from './sub-domains/instagram-sending/message-month-count.repository.js';
import { MessageMonthNoticeService } from './sub-domains/instagram-sending/message-month-notice.service.js';
import { MessageMonthCountService } from './sub-domains/instagram-sending/message-month-count.service.js';
import { SendingStateService } from './sub-domains/instagram-sending/sending-state.service.js';
import { InstagramSendingService } from './sub-domains/instagram-sending/instagram-sending.service.js';
import { InstagramOutgoingMessageService } from './sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.service.js';
import { InstagramSendAccessService } from './sub-domains/instagram-sending/instagram-send-access.service.js';
import { InstagramAttachmentService } from './sub-domains/instagram-sending/instagram-attachment/instagram-attachment.service.js';
import type { InstagramAttachmentFilePort } from './sub-domains/instagram-sending/instagram-attachment/instagram-attachment.types.js';
import type { InstagramSendWork } from './sub-domains/instagram-sending/instagram-sending.types.js';
import { InstagramSendComposeService } from './sub-domains/instagram-sending/instagram-send-compose.service.js';
import { InstagramReplyLaneRules } from './sub-domains/instagram-sending/instagram-reply-lane.service.js';
import { InstagramSlowLaneRules } from './sub-domains/instagram-sending/instagram-slow-lane.service.js';
import { InstagramFastLaneRules } from './sub-domains/instagram-sending/instagram-fast-lane.service.js';
import { InstagramBroadcastLaneRules } from './sub-domains/instagram-sending/instagram-broadcast-lane.service.js';
import { enqueueInstagramSendFastMessage } from './sub-domains/instagram-sending/queues/instagram-send-fast.queue.js';
import { InstagramSendCoreService } from './sub-domains/instagram-sending/instagram-send-core.service.js';
import { InstagramSendGateService } from './sub-domains/instagram-sending/instagram-send-gate.service.js';
import {
  broadcastSendQueue,
  contactBulkActionQueue,
  createAppTaskHandlers,
  instagramAttachmentUploadQueue,
  instagramOutgoingMessageRetryQueue,
  segmentBackgroundCountPort,
} from './app.tasks.js';
import { registerInstagramPlanChangeEventHandlers } from './sub-domains/instagram-sending/events/instagram-plan-change.event-handlers.js';
import {
  INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
  startInstagramAccountChainBestEffort,
} from './sub-domains/instagram-account/queues/instagram-account-tasks.queue.js';
import {
  type InstagramMissedCommentPort,
  buildInstagramAccountTaskHandlers,
} from './sub-domains/instagram-account/workers/instagram-account-tasks.processor.js';
import type { InstagramReconnectNoticeServices } from './sub-domains/instagram-account/workers/instagram-reconnect-notice.processor.js';
import { InstagramAccountMessageAccessService } from '@/domains/app/sub-domains/instagram-account/instagram-account-message-access.service.js';

/**
 * Services exposed by the app domain container (mounted on `app.appDomain`): the channel connection
 * sub-domain — the connection service (routes 1–5, 40, 42 of feat-instagram-dm-sending § 1), the
 * token service (the one token path, MC9) and the usage service (Meta's usage per connection, MC19)
 * — the channel account sub-domain (routes 6–11, the one feature check, ROUTE row R5) — the
 * Instagram account sub-domain — the account service (the guarded status change, the webhook
 * subscription steps), the settings
 * service (route 3), the media service (the post and story pickers, routes 5–6, and the stored
 * posts sub-domains 3–4 write through it, IA17), the erasure service (the one erase of an account's
 * data, which tenancy's organization delete calls through its offboarding port, D54) and the Meta
 * callback service (Meta's deauthorize and data deletion, routes 7–8, IA19, IA20) — the contact service (routes 9–10 and the
 * operations event processing writes contacts through), the Instagram webhook events service
 * (route 18; the one write path for the events table the receiver and processing use), the
 * Instagram webhook receiver (Meta's routes 16–17), the automation service (routes 11–15 and
 * "next post" linking for event processing), the run engine (sub-domain 3.B — the entry points
 * event processing calls per comment, DM, story reply and button click), and the segment service
 * (routes 77–82 of feat-instagram-dm-sending § 7.B, ROUTE row R21), and the sending
 * sub-domain's root (feat-instagram-dm-sending § 6.A, ROUTE row R18) — the lane service (the lane
 * port of the connection, the channel account and route 12), the month count (the plan-stop port,
 * route 64's meter), the global sending state (`SENDING_ENABLED` and the environment id, the app-level
 * Meta usage) and the read service of routes 63–64.
 *
 * @remarks
 * The connection's token service is exposed for the Instagram workers that call Meta with an
 * account's connection token; the connection's token check and the account jobs read it through
 * the worker token repository (MC9). The connection reaches accounts through its account port — the channel
 * account service (`ChannelAccountService`, ROUTE row R5), which also serves routes 6–11 and the one
 * feature check the go-live, settings, broadcasts and the engine call (CA11). The worker process builds
 * this container too (`createDomainContainers` → `appDomain`), for the account jobs' guarded status
 * change (IA9) and for Instagram webhook event processing (WH12–WH14), which drives the
 * account, events, contact, media, automation and run-engine services from it.
 */
export type AppContainer = {
  channelConnectionService: ChannelConnectionService;
  channelConnectionTokenService: ChannelConnectionTokenService;
  channelConnectionUsageService: ChannelConnectionUsageService;
  channelAccountService: ChannelAccountService;
  instagramAccountService: InstagramAccountService;
  instagramAccountSettingsService: InstagramAccountSettingsService;
  instagramMediaService: InstagramMediaService;
  /** Route 154 — the owner's message-access re-check (feat-meta-connect-flow IG2). */
  instagramAccountMessageAccessService: InstagramAccountMessageAccessService;
  instagramAccountErasureService: InstagramAccountErasureService;
  channelConnectionMetaCallbackService: ChannelConnectionMetaCallbackService;
  contactService: ContactService;
  /** The contact tag events (3.B): the tag-event recorder and the erase step; intake reads at R38. */
  contactTagEventService: ContactTagEventService;
  instagramWebhookEventService: InstagramWebhookEventService;
  instagramWebhookService: InstagramWebhookService;
  automationService: AutomationService;
  /** The past-comments reads (4.C, routes 38–39 — R15); the read job joins at R41. */
  automationBackfillService: AutomationBackfillService;
  /** The automations' all-time counts (AU19) — the run engine writes through it from R14. */
  automationCountService: AutomationCountService;
  /** The "Reply like a person" pacing (AU19) — sub-domain 6's reply lane reads and writes it. */
  automationReplyStateService: AutomationReplyStateService;
  automationRunService: AutomationRunService;
  broadcastSegmentService: BroadcastSegmentService;
  /** Broadcasts (§ 7.A, ROUTE row R22): routes 70–76, the send, the segment delete's draft step. */
  broadcastService: BroadcastService;
  /**
   * Broadcast recipients (§ 7.C, ROUTE row R23): the audience piece (R46's task), the "when her chat
   * opens" row (R47), each broadcast message's result (6's result save), the skips and her reply.
   */
  broadcastRecipientService: BroadcastRecipientService;
  /**
   * The channels' sending ports (AU35), one record shared by the automations and the run engine —
   * Instagram's is its message service (ROUTE row R19); tests may put a recording one.
   */
  channelSendingPorts: ChannelSendingPorts;
  instagramSendLaneService: InstagramSendLaneService;
  messageMonthCountService: MessageMonthCountService;
  /** The month at 80 % and 100 % (WC-56, ROUTE row R53): the claim's after-commit notice and the backup check. */
  messageMonthNoticeService: MessageMonthNoticeService;
  sendingStateService: SendingStateService;
  instagramSendingService: InstagramSendingService;
  /**
   * Instagram's messages (§ 6.B, ROUTE row R19): Instagram's `ChannelSendingPort` (the value of
   * `channelSendingPorts.instagram`), the claim and the one result save the lanes call (R42), the
   * webhook's own-echo lookup and route 63's waiting counts.
   */
  instagramOutgoingMessageService: InstagramOutgoingMessageService;
  /**
   * The one read before every Instagram Meta call (§ 6, SN22, SN23; ROUTE row R20): the account's
   * send access, the pace from the connection's Meta usage and the usage recorder — the attachment
   * upload now, every lane and the fast lane from R42.
   */
  instagramSendAccessService: InstagramSendAccessService;
  /**
   * Instagram's message files (§ 6.C, ROUTE row R20): one Meta upload per account and file
   * (AC-15.4); the `attachment-upload` task's body for R46.
   */
  instagramAttachmentService: InstagramAttachmentService;
  /**
   * The work the Instagram send and task workers hand their tickets to (SN2, SN24, ROUTE row R37):
   * the account jobs' task handlers (set-up, subscription check, starter-question sync — R40); the
   * lane turn is ROUTE rows R42–R45's, the fast send R42 / R44's, the other task handlers R41 / R46's;
   * until then such a ticket is logged and finished without touching a row.
   */
  instagramSendWork: InstagramSendWork;
  /** Gate 1 and the claim's commit (SN3, ROUTE row R42) — shared by the send core and the Redis rebuild (R48). */
  instagramSendGateService: InstagramSendGateService;
  /**
   * The watches' work (§ 6 SN6, SNC5; WC-16, WC-22, WC-24 — ROUTE row R48): the all-accounts outage
   * stop, the Live check and the waiting estimate, run by the repair worker's watch duties.
   */
  instagramSendingWatchService: InstagramSendingWatchService;
  /**
   * The account jobs' late-wired parts (R40): the set-up failure email's services (tenancy's and
   * notify's — the worker composition root sets them) and the missed-comment look (WC-26, ROUTE row
   * R39). `null` until set; the jobs log what they skipped.
   */
  instagramAccountTaskSlots: InstagramAccountTaskSlots;
};

/** The account jobs' late-wired parts (see {@link AppContainer.instagramAccountTaskSlots}). */
export interface InstagramAccountTaskSlots {
  noticeServices: InstagramReconnectNoticeServices | null;
  missedCommentPort: InstagramMissedCommentPort | null;
}

/**
 * The channel connection service (routes 1–5, 40, 42): its accounts through the channel account
 * (P111 → R5), its lanes through sub-domain 6's lane service (R18) and a trial pick through billing's
 * trial port (R24).
 */
function createChannelConnectionService(options: {
  channelConnectionRepository: ChannelConnectionRepository;
  channelConnectionTokenService: ChannelConnectionTokenService;
  channelConnectionUsageService: ChannelConnectionUsageService;
  channelAccountService: ChannelAccountService;
  organizationService: OrganizationService;
  planAccessService: ChannelConnectionPlanAccessService;
  lanePort: ChannelConnectionLanePort;
  trialPort: ChannelConnectionTrialPort;
}): ChannelConnectionService {
  return new ChannelConnectionService(
    options.channelConnectionRepository,
    options.channelConnectionTokenService,
    options.channelConnectionUsageService,
    options.channelAccountService,
    options.organizationService,
    options.planAccessService,
    redisConnection,
    options.lanePort,
    options.trialPort,
  );
}

/**
 * The Instagram account sub-domain's services (routes-final § 2): the extension's one writer
 * (2.A.10, ROUTE row R6), the settings and the account service, over the channel account repository
 * that moves the account's status (CA4, CA8).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, no side effects.
 */
function createInstagramAccountServices({
  organizationService,
  channelConnectionTokenService,
  settingsChannelAccountPort,
  settingsLanePort,
}: {
  organizationService: OrganizationService;
  channelConnectionTokenService: ChannelConnectionTokenService;
  /** Route 12's channel account steps (P42, CA11) — the channel account service, built after. */
  settingsChannelAccountPort: InstagramAccountSettingsChannelAccountPort;
  /** Route 12's lane wake after a limit change (IA14) — sub-domain 6's lane service (R18). */
  settingsLanePort: InstagramAccountSettingsLanePort;
}) {
  const instagramAccountRepository = new InstagramAccountRepository();
  const channelAccountRepository = new ChannelAccountRepository();
  const instagramAccountExtensionService = new InstagramAccountExtensionService(
    instagramAccountRepository,
  );
  // The lane wake after a limit change (IA14) is sub-domain 6's lane service (ROUTE row R18).
  const instagramAccountSettingsService = new InstagramAccountSettingsService(
    new InstagramAccountSettingsRepository(),
    settingsChannelAccountPort,
    organizationService,
    settingsLanePort,
  );
  const instagramAccountService = new InstagramAccountService(
    instagramAccountRepository,
    instagramAccountExtensionService,
    channelAccountRepository,
    channelConnectionTokenService,
    instagramAccountSettingsService,
    organizationService,
  );
  return {
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountSettingsService,
    instagramAccountService,
  };
}

/** No ticket work is built yet (ROUTE row R37): every ticket is logged and finished. */
const NO_INSTAGRAM_SEND_WORK: InstagramSendWork = {
  laneTurn: null,
  fastMessage: null,
  taskHandlers: {},
};

/**
 * The broadcast sub-domain's services (feat-instagram-dm-sending routes-final § 7): segments
 * (7.B, ROUTE row R21 — the `segments` switch through the channel account's one feature check, BC19)
 * and broadcasts (7.A, ROUTE row R22 — the `broadcasts` switch, the account read, the month count
 * and the usable-file read). The segment delete runs the broadcasts' draft step (BC17).
 *
 * @remarks
 * Notes: the segments' background count and the broadcasts' send queue are ROUTE row R46's
 * (`app.tasks.ts`); wiring only, no side effects.
 */
function createBroadcastServices({
  organizationService,
  channelAccountService,
  messageMonthCountService,
  messageFilePort,
}: {
  organizationService: OrganizationService;
  channelAccountService: ChannelAccountService;
  messageMonthCountService: MessageMonthCountService;
  messageFilePort: AutomationMessageFilePort | undefined;
}): { broadcastSegmentService: BroadcastSegmentService; broadcastService: BroadcastService } {
  const segmentRepository = new BroadcastSegmentRepository();
  const featureCheck: BroadcastFeatureCheck = (input) =>
    channelAccountService.canChannelAccountUseFeature(input);
  const broadcastService = new BroadcastService(
    new BroadcastRepository(),
    segmentRepository,
    organizationService,
    (input) => channelAccountService.readAutomationAccount(input),
    featureCheck,
    // Route 75's background work — the audience build and the matched count (R46).
    { monthLimit: messageMonthCountService, messageFilePort, sendQueue: broadcastSendQueue },
  );
  const broadcastSegmentService = new BroadcastSegmentService(
    segmentRepository,
    organizationService,
    featureCheck,
    {
      deleteSteps: [(input) => broadcastService.clearDraftSegment(input)],
      // Route 82's background count and its 60 s copy (BC14, WC-39 — R46).
      backgroundCount: segmentBackgroundCountPort,
    },
  );
  return { broadcastSegmentService, broadcastService };
}

/**
 * The sending sub-domain's root services (routes-final § 6.A, ROUTE row R18): the lanes and their
 * stops, the global sending row (registered as the readiness body's sending check, SNC9), the
 * month count (the channel account's plan-stop port, route 64's meter) — and the connection's usage
 * service, whose app-level usage that row holds (S13, P107).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, plus the health
 * probe's registration.
 */
function createInstagramSendingServices({
  planAccessService,
  organizationService,
}: {
  planAccessService: ChannelConnectionPlanAccessService;
  organizationService: OrganizationService;
}) {
  const instagramSendLaneService = new InstagramSendLaneService(
    new InstagramSendLaneRepository(),
    new InstagramSendStopRepository(),
  );
  const sendingStateService = new SendingStateService();
  // The readiness body's sending part (SNC9): may this deployment send, and why not.
  // R48 adds the clock skew, the repair age and the late lanes (SNC9, plan §40.1).
  registerHealthSendingProbe(async () => {
    const [check, clockSkewMilliseconds, heartbeats, lateLanes] = await Promise.all([
      sendingStateService.checkSending(),
      measurePostgresClockSkewMilliseconds().catch(() => null),
      readWorkerQueueHeartbeats([INSTAGRAM_SENDING_REPAIR_QUEUE_NAME]).catch(() => []),
      readInstagramLateLaneGauge(),
    ]);
    return {
      may_send: check.maySend,
      reason: check.reason,
      settings_version: check.settingsVersion,
      minimum_compatible_settings_version: check.minimumCompatibleSettingsVersion,
      server_settings_version: check.serverSettingsVersion,
      clock_skew_milliseconds: clockSkewMilliseconds,
      repair_last_round_at: heartbeats[0]?.last_job_at ?? null,
      late_lane_count: lateLanes?.count ?? null,
    };
  });
  const messageMonthCountService = new MessageMonthCountService(
    new MessageMonthCountRepository(),
    planAccessService,
  );
  // The month at 80 % and 100 % (WC-56, R53): told after the claim that crossed a line.
  const messageMonthNoticeService = new MessageMonthNoticeService(
    new MessageMonthCountRepository(),
    messageMonthCountService,
    organizationService,
  );
  // Meta's usage per connection (MC19, S13): the Postgres store; the app-level usage once, on the
  // global sending row (P107).
  const channelConnectionUsageService = createChannelConnectionUsageService({
    usageStore: createChannelConnectionUsagePostgresStore(new ChannelConnectionUsageRepository()),
    appUsageStore: sendingStateService,
  });
  return {
    instagramSendLaneService,
    sendingStateService,
    messageMonthCountService,
    messageMonthNoticeService,
    channelConnectionUsageService,
    // The tickets' work (SN2, SN24, R37): the account jobs' task handlers (R40) are added and the
    // send core (R42) replaces the lane turn and the fast send in `createAppContainer`; R41 / R46
    // add their task handlers.
    instagramSendWork: NO_INSTAGRAM_SEND_WORK,
  };
}

/**
 * Routes 63–64's read service (routes-final § 6.A): the sending root's services, the day counts and
 * route 63's sources from the messages (6.B — the waiting counts per lane and the last retry, R19).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only.
 */
function createInstagramSendingStatusService({
  organizationService,
  channelAccountService,
  planAccessService,
  sending,
  instagramOutgoingMessageService,
}: {
  organizationService: OrganizationService;
  channelAccountService: ChannelAccountService;
  planAccessService: ChannelConnectionPlanAccessService;
  sending: ReturnType<typeof createInstagramSendingServices>;
  instagramOutgoingMessageService: InstagramOutgoingMessageService;
}): InstagramSendingService {
  return new InstagramSendingService({
    organizationService,
    channelAccountService,
    planAccessService,
    ...sending,
    dayCountRepository: new InstagramSendDayCountRepository(),
    sources: {
      countWaitingByLane: (target) => instagramOutgoingMessageService.countWaitingByLane(target),
      listWindowClosedByAutomation: (target) =>
        instagramOutgoingMessageService.listWindowClosedByAutomation(target),
      findLastRetry: (target) => instagramOutgoingMessageService.findLastRetry(target),
    },
  });
}

/**
 * The Instagram account's media and erasure services and Meta's callbacks (routes-final § 2, § 1):
 * the post and story pickers (routes 13–14, R8), the one erase of an account's data (which the
 * organization's delete and Meta's callbacks call, IAC5) and the connection's deauthorize /
 * data-deletion callbacks (routes 16–17, R9).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only. Meta's 190 on a media
 * read breaks the account's connection through the connection (MC11, R4's `markConnectionBroken`).
 * The callback service's lane port is 6's lane service (R18), so Meta's callbacks stop the reached
 * accounts' lanes as route 8 does; the sixth is the callbacks' team-alert path (R53).
 */
function createInstagramMediaAndErasureServices(options: {
  instagramAccountService: InstagramAccountService;
  channelConnectionService: ChannelConnectionService;
  channelConnectionRepository: ChannelConnectionRepository;
  channelConnectionTokenService: ChannelConnectionTokenService;
  channelAccountService: ChannelAccountService;
  lanePort: ChannelConnectionLanePort;
}) {
  const instagramMediaService = new InstagramMediaService(
    new InstagramMediaRepository(),
    options.instagramAccountService,
    options.channelConnectionService,
  );
  const instagramAccountErasureService = new InstagramAccountErasureService(
    options.instagramAccountService,
    instagramMediaService,
    // An organization delete stops the revoked accounts' lanes (CA8, R61).
    options.lanePort,
  );
  const channelConnectionMetaCallbackService = new ChannelConnectionMetaCallbackService(
    options.channelConnectionRepository,
    options.channelConnectionTokenService,
    options.channelAccountService,
    instagramAccountErasureService,
    options.lanePort,
    // The unmatched id's team email (MC16, R53).
    channelConnectionMetaCallbackTeamAlert,
  );
  return {
    instagramMediaService,
    instagramAccountErasureService,
    channelConnectionMetaCallbackService,
  };
}

/**
 * The Instagram webhook's services (routes-final § 5): the events service (route 62, the one write
 * path of the events table) and the receiver (Meta's routes 60–61).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only.
 */
function createInstagramWebhookServices({
  instagramAccountService,
  organizationService,
  instagramOutgoingMessageService,
}: {
  instagramAccountService: InstagramAccountService;
  organizationService: OrganizationService;
  /** The own-echo lookup (WHQ1, P62) — sub-domain 6's message service (R19). */
  instagramOutgoingMessageService: InstagramOutgoingMessageService;
}) {
  const instagramWebhookEventService = new InstagramWebhookEventService(
    new InstagramWebhookEventRepository(),
    organizationService,
  );
  // The receiver stores through the events service (WH1), then adds one intake job per kind group
  // that got events after each entry's commit — the rows stay `received` (WH5, S25). Our own
  // echoes are dropped by the message table's lookup (WHQ1, R19).
  const instagramWebhookService = new InstagramWebhookService(
    instagramAccountService,
    instagramWebhookEventService,
    enqueueInstagramWebhookIntake,
    instagramOutgoingMessageService.findOwnSentMessageIds,
  );
  return { instagramWebhookEventService, instagramWebhookService };
}

/**
 * The contact sub-domain's services (routes-final § 3): the contact service and its tag events
 * (3.B, ROUTE row R11), with the erase and pause steps of § 3.10 — 3.B's tag-event delete first,
 * the run engine's erase pushed by the caller, 6's at its row; the bulk queue (R46) and intake's
 * queue (R38) join later. The automation filters resolve through the automation service, so
 * contacts never import it.
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, no side effects.
 * `cancelContactOpenRuns` is a closure because the run engine is built after the contact service.
 */
function createContactServices({
  organizationService,
  automationService,
  cancelContactOpenRuns,
  channelSendingPorts,
  runEventReader,
  broadcastRecipientService,
}: {
  organizationService: OrganizationService;
  automationService: AutomationService;
  cancelContactOpenRuns: ContactPauseStep;
  /** Broadcast recipients (7.C, R23): her waiting ones skipped at her erase and pause. */
  broadcastRecipientService: BroadcastRecipientService;
  /** The channels' sending ports (AU35): her messages' erase / pause steps and routes 24–26. */
  channelSendingPorts: ChannelSendingPorts;
  /** Her runs' history for route 24 (4.B) — a closure, the engine is built after. */
  runEventReader: ContactRunEventReader;
}): {
  contactService: ContactService;
  contactTagEventService: ContactTagEventService;
  contactErasureSteps: ContactErasureStep[];
} {
  // Tag events hand over to Instagram intake's `intake-tag-events` jobs after the tag commit (WC-4,
  // ROUTE row R38): `queued_at` is stamped in that commit.
  const contactTagEventService = new ContactTagEventService(new ContactTagEventRepository(), {
    intakeQueue: { enqueueContactTagEventIntake: enqueueInstagramTagEventIntake },
  });
  const contactErasureSteps: ContactErasureStep[] = [
    (input) => contactTagEventService.deleteContactTagEvents(input),
    // Her waiting messages cancelled in the erase's commit (CT11, AC-5.12) — every channel's.
    async ({ organizationId, contactId }) => {
      for (const port of Object.values(channelSendingPorts)) {
        await port.cancelWaitingMessages({
          organizationId,
          by: 'contact',
          id: contactId,
          reason: 'contact_deleted',
        });
      }
    },
    // Her waiting broadcast recipients `skipped` · `contact_deleted` (7.C BCC9, plan §20.10).
    ({ organizationId, contactId }) =>
      broadcastRecipientService
        .skipContactWaitingRecipients({ organizationId, contactId, reason: 'contact_deleted' })
        .then(() => undefined),
  ];
  // Her waiting messages skipped with the pause's reason (`contact_excluded`, `opted_out`) in its
  // commit (CTC4, AC-5.8).
  const skipContactWaitingMessages: ContactPauseStep = async ({
    organizationId,
    contactId,
    reason,
    databaseHandle,
  }) => {
    for (const port of Object.values(channelSendingPorts)) {
      await port.skipWaitingMessages({
        databaseHandle,
        organizationId,
        by: 'contact',
        id: contactId,
        reason,
      });
    }
  };
  const contactService = new ContactService(
    new ContactRepository(),
    organizationService,
    contactErasureSteps,
    (input) => automationService.findAutomationIdForFilter(input),
    {
      pauseSteps: [
        cancelContactOpenRuns,
        skipContactWaitingMessages,
        // Her waiting broadcast recipients `skipped` with the pause's reason (plan §20.10).
        (input) =>
          broadcastRecipientService.skipContactWaitingRecipients(input).then(() => undefined),
      ],
      tagEventRecorder: contactTagEventService,
      // Route 21's job (WC-36, S19 — R46).
      bulkActionQueue: contactBulkActionQueue,
      sendingPorts: channelSendingPorts,
      runEventReader,
    },
  );
  return { contactService, contactTagEventService, contactErasureSteps };
}

/**
 * The automation, contact and run-engine services (feat-instagram-dm-sending routes-final § 3, § 4):
 * automations (routes 27–35, shared by every channel — R13) with their counts and reply pacing,
 * contacts (routes 18–23) and the run engine (4.B), with the two hooks that join them — the
 * automation delete's open-run cancel (AU16) and the contact erase's run copies (CT8).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only. The automations read
 * accounts and the one feature check through the channel account (AU34), the month limit through
 * 6's month count, files through the upload domain's usable-file read (R12); the starter-question
 * sync (R40) enqueues the account's starter-question task; the channels' sending ports (R19–R20).
 */
function createAutomationServices({
  organizationService,
  channelAccountService,
  planAccessService,
  messageMonthCountService,
  messageFilePort,
  channelSendingPorts,
  broadcastRecipientService,
  attachmentUploads,
}: {
  organizationService: OrganizationService;
  channelAccountService: ChannelAccountService;
  planAccessService: ChannelConnectionPlanAccessService;
  messageMonthCountService: MessageMonthCountService;
  messageFilePort: AutomationMessageFilePort | undefined;
  /** The message files' upload ahead of their sends (WC-32, R46). */
  attachmentUploads: AutomationAttachmentUploadPort;
  /** The channels' sending ports (AU35) — one record shared by the automations and the run engine. */
  channelSendingPorts: ChannelSendingPorts;
  /** Broadcast recipients (7.C, R23) — the contact erase and pause steps. */
  broadcastRecipientService: BroadcastRecipientService;
}) {
  // The automation delete's hook (AU16): every step registered here runs inside route 31's
  // transaction, after the soft delete, and answers how many open runs it cancelled. Sub-domain 4.B
  // registers `cancelAutomationOpenRuns` below, once the run engine is built.
  const automationOpenRunCancelSteps: AutomationOpenRunCancelStep[] = [];
  const automationCountService = new AutomationCountService(new AutomationCountRepository());
  const automationReplyStateService = new AutomationReplyStateService(
    new AutomationReplyStateRepository(),
  );
  const automationRepository = new AutomationRepository();
  // Past comments (4.C, R15): routes 38–39 and the automation object's open read; route 38 wakes
  // the account's read job (WC-41, R41 — Instagram's `automation-backfill-read` task) after commit.
  const automationBackfillService = new AutomationBackfillService(
    new AutomationBackfillRepository(),
    automationRepository,
    channelAccountService,
    organizationService,
    INSTAGRAM_PAST_COMMENT_READ_QUEUE,
  );
  const automationService = new AutomationService(
    automationRepository,
    automationCountService,
    automationReplyStateService,
    channelAccountService,
    planAccessService,
    organizationService,
    automationOpenRunCancelSteps,
    {
      monthLimit: messageMonthCountService,
      messageFiles: messageFilePort,
      openBackfills: automationBackfillService,
      sendingPorts: channelSendingPorts,
      // WC-32's upload ahead of the sends (R46) — the channel's attachment service.
      attachmentUploads,
      // IA6, WC-31 (R40): the account's ice breakers rewritten after a starter automation's change.
      starterQuestionSync: {
        enqueueStarterQuestionSync: ({ organizationPublicId, channelAccountPublicId }) =>
          startInstagramAccountChainBestEffort({
            jobName: INSTAGRAM_STARTER_QUESTION_SYNC_JOB_NAME,
            organizationPublicId,
            channelAccountPublicId,
          }),
      },
    },
  );
  const { contactService, contactTagEventService, contactErasureSteps } = createContactServices({
    organizationService,
    automationService,
    cancelContactOpenRuns: (input) => automationRunService.cancelContactOpenRuns(input),
    channelSendingPorts,
    runEventReader: (input) => automationRunService.listContactRunEvents(input),
    broadcastRecipientService,
  });
  // The run engine (sub-domain 4.B, R14): the intake calls its entry points; it saves every step
  // as a waiting message through the channel's sending port (AU35 — the shared record, filled per
  // channel by its sending sub-domain, Instagram's at R19–R20) and writes contacts through 3.
  const automationRunService = new AutomationRunService({
    channelAccountService,
    contactService,
    planAccessService,
    countService: automationCountService,
    replyStateService: automationReplyStateService,
    sendingPorts: channelSendingPorts,
    // Plan §27.15 rule 1 (R56): her run's end makes her "when her chat opens" recipient row.
    runEndedHook: (input) =>
      broadcastRecipientService.handleChatOpened({ ...input, isOwnerChatting: false }),
  });
  automationOpenRunCancelSteps.push((input) =>
    automationRunService.cancelAutomationOpenRuns(input),
  );
  contactErasureSteps.push((input) => automationRunService.eraseContactRunCopies(input));
  return {
    automationService,
    automationBackfillService,
    automationCountService,
    automationReplyStateService,
    contactService,
    contactTagEventService,
    automationRunService,
  };
}

/**
 * The sender's one read before a Meta call (§ 6, SN22, SN23) and Instagram's message files (§ 6.C,
 * SN20) — ROUTE row R20. Without the upload domain's file read (a unit test) every file reads as not
 * usable, so nothing is uploaded.
 */
function createSendAccessServices({
  instagramAccountService,
  sending,
  messageFilePort,
}: {
  instagramAccountService: InstagramAccountService;
  sending: ReturnType<typeof createInstagramSendingServices>;
  messageFilePort: InstagramAttachmentFilePort | undefined;
}) {
  const instagramSendAccessService = new InstagramSendAccessService({
    accountService: instagramAccountService,
    usageService: sending.channelConnectionUsageService,
  });
  const instagramAttachmentService = new InstagramAttachmentService({
    sendAccessService: instagramSendAccessService,
    filePort: messageFilePort ?? { findUsableMessageFile: async () => null },
    // WC-32's `attachment-upload` task (R46): go-live and a live file change upload ahead.
    uploadQueue: instagramAttachmentUploadQueue,
  });
  return {
    instagramSendAccessService,
    instagramAttachmentService,
    // Gate 1 and the claim (R42), shared by the send core and the Redis rebuild (R48).
    instagramSendGateService: new InstagramSendGateService({
      laneService: sending.instagramSendLaneService,
      // The month at 80 % and 100 % told after the claim that crossed a line (WC-56, R53).
      monthNotice: sending.messageMonthNoticeService,
    }),
  };
}

/**
 * One port per channel (AU35): Instagram's message service (R19) with its fast tickets after commit
 * (R44), her `last_broadcast_at` in the result's commit (R45) and the failed-message retry (R46), and the broadcast recipients behind
 * the ports (§ 7.C, R23). The engine is built after, so
 * its calls are late-bound.
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, no side effects.
 */
function createChannelSendingServices(late: {
  automation: () => Pick<
    ReturnType<typeof createAutomationServices>,
    'automationRunService' | 'contactService'
  >;
}): {
  instagramOutgoingMessageService: InstagramOutgoingMessageService;
  channelSendingPorts: ChannelSendingPorts;
  broadcastRecipientService: BroadcastRecipientService;
} {
  const instagramOutgoingMessageService = new InstagramOutgoingMessageService({
    recordRunMessageResult: (input) =>
      late.automation().automationRunService.recordMessageResult(input),
    recordBroadcastMessageResult: (input) => broadcastRecipientService.recordMessageResult(input),
    recordContactOpeningMessage: (input) =>
      late.automation().contactService.recordContactOpeningMessage(input),
    recordContactBroadcastSent: (input) =>
      late.automation().contactService.recordContactBroadcastSent(input),
    enqueueFastMessage: enqueueInstagramSendFastMessage,
    // WC-42's `retry-failed` task (R46) and the retried runs reopened in its commit.
    retryQueue: instagramOutgoingMessageRetryQueue,
    reopenRetriedRuns: (input) => late.automation().automationRunService.reopenRetriedRuns(input),
  });
  const channelSendingPorts: ChannelSendingPorts = { instagram: instagramOutgoingMessageService };
  const broadcastRecipientService = new BroadcastRecipientService({
    sendingPorts: channelSendingPorts,
  });
  return { instagramOutgoingMessageService, channelSendingPorts, broadcastRecipientService };
}

/**
 * The send work of the Instagram tickets (§ 6 SNC3, SNC4, SNC7 — ROUTE row R42): the send core over
 * the gates, the message's result save, the send access, the attachments and the breaks, with the
 * slow, reply (R43), fast (R44) and broadcast (R45) lanes' rules and the down-stop probe (R48); the
 * task handlers already registered (the account jobs', R40) are kept and R46 / R52's
 * (`createAppTaskHandlers`) and intake's (R38's profile read, R39's missed-comment look, R41's
 * past-comments read and "next post" linking — {@link createInstagramIntakeTaskHandlers}) join them.
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only.
 */
function createInstagramSendWork(
  container: Omit<AppContainer, 'instagramSendWork' | 'instagramSendingWatchService'> & {
    instagramSendWork: InstagramSendWork;
  },
): InstagramSendWork {
  const lanes = container.instagramSendLaneService;
  const messageService = container.instagramOutgoingMessageService;
  const sendCore = new InstagramSendCoreService({
    laneService: lanes,
    messageService: container.instagramOutgoingMessageService,
    gateService: container.instagramSendGateService,
    accessService: container.instagramSendAccessService,
    attachmentService: container.instagramAttachmentService,
    sendingStateService: container.sendingStateService,
    readMonthLimit: (scope) => container.messageMonthCountService.readMonthLimit(scope),
    breakPort: {
      markConnectionBroken: (input) =>
        container.channelConnectionService.markConnectionBroken(input),
      markAccountBroken: (input) => container.channelAccountService.markAccountBroken(input),
    },
    // A send's own access_off answer also stores `off` (feat-meta-connect-flow 3.10).
    messageAccessPort: new InstagramAccountExtensionService(new InstagramAccountRepository()),
    // The slow and reply lanes' own rules (R43), the fast lane's (R44) and the broadcast lane's (R45).
    laneRules: {
      broadcast: new InstagramBroadcastLaneRules({
        messageService,
        composeService: new InstagramSendComposeService(),
      }),
      slow: new InstagramSlowLaneRules({
        messageService,
        composeService: new InstagramSendComposeService(),
      }),
      fast: new InstagramFastLaneRules({
        messageService,
        composeService: new InstagramSendComposeService(),
      }),
      reply: new InstagramReplyLaneRules({
        messageService,
        replyStateService: container.automationReplyStateService,
        canUseReplyLikePerson: async (target) =>
          (
            await container.channelAccountService.canChannelAccountUseFeature({
              ...target,
              feature: 'reply_like_person',
            })
          ).isAllowed,
      }),
    },
    // R54 (plan §33.1): 5 refused texts in a row on one automation stop it and tell its owners.
    automationStopPort: {
      stopForRefusedText: (input) => container.automationService.stopForRefusedText(input),
    },
    // R48 (plan §33.5 rule 2): a down stop is tested by reading the account's own profile first.
    probeAccount: (input) =>
      probeInstagramAccountReadOnly({
        ...input,
        accessService: container.instagramSendAccessService,
      }),
  });
  const baseWork = container.instagramSendWork;
  return {
    ...baseWork,
    laneTurn: sendCore,
    fastMessage: sendCore,
    // The account jobs (R40) already in `baseWork`; ROUTE row R46's tasks (S19): the upload on
    // `instagram-tasks`, the database-heavy four on `instagram-database-tasks`; R52's plan change.
    taskHandlers: {
      ...baseWork.taskHandlers,
      ...createAppTaskHandlers(container),
      ...createInstagramIntakeTaskHandlers(container),
    },
  };
}

/**
 * Intake's tasks on the Meta-calling `instagram-tasks` (§ 5, S11, P93; WC-26, WC-41, WC-43): the
 * new contact's profile read (R38), one account's missed-comment look (R39), its past-comments read
 * and its "my next post" linking (R41) — by job name.
 *
 * @remarks
 * Notes: split out of {@link createInstagramSendWork} to keep it short; wiring only.
 */
function createInstagramIntakeTaskHandlers(
  container: Omit<AppContainer, 'instagramSendWork' | 'instagramSendingWatchService'>,
): InstagramSendWork['taskHandlers'] {
  return {
    [INSTAGRAM_CONTACT_PROFILE_READ_JOB_NAME]: createInstagramContactProfileReadTaskHandler({
      services: {
        instagramAccountService: container.instagramAccountService,
        contactService: container.contactService,
      },
    }),
    // One account's missed-comment look, the round or the full pass after an outage (WC-26, R39).
    [INSTAGRAM_MISSED_COMMENT_CHECK_JOB_NAME]: createInstagramMissedCommentCheckTaskHandler({
      services: {
        instagramAccountService: container.instagramAccountService,
        instagramSendAccessService: container.instagramSendAccessService,
        instagramAccountSettingsService: container.instagramAccountSettingsService,
        automationService: container.automationService,
        instagramMediaService: container.instagramMediaService,
        instagramWebhookEventService: container.instagramWebhookEventService,
      },
    }),
    // One account's past-comments read (WC-41, R41) — the automation's read row, Instagram's reads.
    [INSTAGRAM_PAST_COMMENT_READ_JOB_NAME]: createInstagramPastCommentReadTaskHandler({
      services: {
        instagramSendAccessService: container.instagramSendAccessService,
        instagramAccountSettingsService: container.instagramAccountSettingsService,
        automationBackfillService: container.automationBackfillService,
        instagramWebhookEventService: container.instagramWebhookEventService,
      },
    }),
    // One account's "my next post" linking (WC-43, R41).
    [INSTAGRAM_NEXT_POST_LINKING_JOB_NAME]: createInstagramNextPostLinkingTaskHandler({
      services: {
        instagramSendAccessService: container.instagramSendAccessService,
        instagramMediaService: container.instagramMediaService,
        automationService: container.automationService,
      },
    }),
  };
}

/**
 * The container with its send work (R42) and the watches' service (§ 6 SN6, SNC5; WC-16, WC-22,
 * WC-24 — ROUTE row R48: the outage stop, the Live check and the waiting estimate).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only.
 */
function withSendWorkAndWatches(
  container: Omit<AppContainer, 'instagramSendWork' | 'instagramSendingWatchService'> & {
    instagramSendWork: InstagramSendWork;
  },
): AppContainer {
  return {
    ...container,
    instagramSendWork: createInstagramSendWork(container),
    instagramSendingWatchService: new InstagramSendingWatchService({
      sendingStateService: container.sendingStateService,
      accessService: container.instagramSendAccessService,
      messageService: container.instagramOutgoingMessageService,
      mediaService: container.instagramMediaService,
    }),
  };
}

/**
 * Route 12's channel account port (P42, CA11). The channel account service depends on the settings
 * service, so route 12 reaches it through this port; each call reads the service at request time,
 * after both are built.
 */
function createSettingsChannelAccountPort(
  readChannelAccountService: () => ChannelAccountService,
): InstagramAccountSettingsChannelAccountPort {
  return {
    requireLiveInstagramAccount: (input) =>
      readChannelAccountService().requireLiveInstagramAccount(input),
    setAutomationEnabled: (input) => readChannelAccountService().setAutomationEnabled(input),
    canChannelAccountUseFeature: (input) =>
      readChannelAccountService().canChannelAccountUseFeature(input),
  };
}

/** The connection's repository and its one token path (MC9) — shared by the account and connection services. */
function createConnectionToken() {
  const channelConnectionRepository = new ChannelConnectionRepository();
  const channelConnectionTokenService = new ChannelConnectionTokenService(
    new ChannelConnectionTokenRepository(),
    channelConnectionRepository,
  );
  return { channelConnectionRepository, channelConnectionTokenService };
}

/**
 * The account jobs on `instagram-tasks` (IA6, IAC3, ROUTE row R40): their late-wired parts, then their
 * handlers registered by job name beside the base work's (R37's `taskHandlers[jobName]`).
 *
 * @remarks
 * Notes: split out of {@link createAppContainer} to keep it short; wiring only, no side effects.
 */
function createInstagramAccountTaskWork({
  sending,
  channelAccountService,
  automationService,
}: {
  sending: {
    instagramSendWork: InstagramSendWork;
    instagramSendLaneService: InstagramSendLaneService;
  };
  channelAccountService: ChannelAccountService;
  automationService: AutomationService;
}): { instagramSendWork: InstagramSendWork; instagramAccountTaskSlots: InstagramAccountTaskSlots } {
  const baseWork = sending.instagramSendWork;
  const instagramAccountTaskSlots: InstagramAccountTaskSlots = {
    noticeServices: null,
    // The full pass after a lost subscription field (WC-25 → WC-26): R39's look, on `instagram-tasks`.
    missedCommentPort: { lookForMissedComments },
  };
  const instagramSendWork: InstagramSendWork = {
    ...baseWork,
    taskHandlers: {
      ...baseWork.taskHandlers,
      ...buildInstagramAccountTaskHandlers({
        // The guarded break that also stops the account's lanes (CA4, SN5 — intake's path, P142).
        channelAccountService,
        // The extension's one writer (2.A.10) — stateless, so the jobs hold their own instance.
        extensionService: new InstagramAccountExtensionService(new InstagramAccountRepository()),
        starterQuestionSource: automationService,
        // The set-up probe's `access_off` stop (SN5, P354).
        sendLaneService: sending.instagramSendLaneService,
        readMissedCommentPort: () => instagramAccountTaskSlots.missedCommentPort,
        readNoticeServices: () => instagramAccountTaskSlots.noticeServices,
      }),
    },
  };
  return { instagramSendWork, instagramAccountTaskSlots };
}

/** The cross-domain services {@link createAppContainer} is given (its parameters). */
export interface AppContainerDependencies {
  organizationService: OrganizationService;
  /** Billing's plan read — the channel account limit (feat-instagram-dm-sending MC7). */
  planAccessService: ChannelConnectionPlanAccessService;
  /** Billing's trial port — a pick during a trial (MC7, BL7, ROUTE row R24). */
  trialPort: ChannelConnectionTrialPort;
  /**
   * The upload domain's usable-file read (`UploadService.findUsableMessageFile`, R12) — go-live's
   * file check (AU13 check 15) and the Instagram attachment (6.C, R20); absent in a unit test.
   */
  messageFilePort?: (AutomationMessageFilePort & InstagramAttachmentFilePort) | undefined;
}

/**
 * Builds the app domain container — the one place its sub-domains' repositories and services
 * are wired, with cross-domain services passed in as parameters (the organization service: the
 * team check, user id resolution; billing's plan read: the channel account limit; billing's trial
 * port: a pick during a trial).
 *
 * @remarks
 * The channel account (1B, R5) is also billing's accounts port (R24); its plan-stop port answers
 * `plan_ended` (R24), then the month count's `plan_limit` (R18). The connection reaches accounts
 * through the channel account (P111 → R5), records a trial pick through billing's trial port (R24),
 * and both reach lanes through sub-domain 6's lane service (R18).
 */
export function createAppContainer({
  organizationService,
  planAccessService,
  trialPort,
  messageFilePort,
}: AppContainerDependencies): AppContainer {
  const { instagramOutgoingMessageService, channelSendingPorts, broadcastRecipientService } =
    createChannelSendingServices({ automation: () => automation });
  const { channelConnectionRepository, channelConnectionTokenService } = createConnectionToken();
  // The sending sub-domain's root (§ 6.A, ROUTE row R18).
  const sending = createInstagramSendingServices({ planAccessService, organizationService });
  const {
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountSettingsService,
    instagramAccountService,
  } = createInstagramAccountServices({
    organizationService,
    channelConnectionTokenService,
    // The channel account service depends on the settings service, so route 12 reaches it through
    // this port; each call runs at request time, after both are built.
    settingsChannelAccountPort: createSettingsChannelAccountPort(() => channelAccountService),
    settingsLanePort: sending.instagramSendLaneService,
  });
  // The channel account (1B, R5): routes 6–11, the feature check, the connection's account port —
  // lanes through 6 (R18), plan stops `plan_ended` (R24) then the month's `plan_limit` (R18).
  const channelAccountService = new ChannelAccountService(
    channelAccountRepository,
    instagramAccountExtensionService,
    instagramAccountService,
    instagramAccountSettingsService,
    channelConnectionRepository,
    channelConnectionTokenService,
    organizationService,
    planAccessService,
    sending.instagramSendLaneService,
    new ChannelAccountPlanStopService(planAccessService, sending.messageMonthCountService),
  );
  // The connection: accounts via 1B (R5), lanes via 6 (R18), a trial pick via billing (R24).
  const channelConnectionService = createChannelConnectionService({
    channelConnectionRepository,
    channelConnectionTokenService,
    channelConnectionUsageService: sending.channelConnectionUsageService,
    channelAccountService,
    organizationService,
    planAccessService,
    lanePort: sending.instagramSendLaneService,
    trialPort,
  });
  // Routes 63–64 (§ 6.A); route 63's waiting counts and last retry from the messages (R19).
  const instagramSendingService = createInstagramSendingStatusService({
    organizationService,
    channelAccountService,
    planAccessService,
    sending,
    instagramOutgoingMessageService,
  });
  const mediaAndErasure = createInstagramMediaAndErasureServices({
    instagramAccountService,
    channelConnectionService,
    channelConnectionRepository,
    channelConnectionTokenService,
    channelAccountService,
    lanePort: sending.instagramSendLaneService,
  });
  const sendAccess = createSendAccessServices({
    instagramAccountService,
    sending,
    messageFilePort,
  });
  // The automations, their runs and the contacts (§ 3, § 5).
  const automation = createAutomationServices({
    attachmentUploads: sendAccess.instagramAttachmentService,
    organizationService,
    channelAccountService,
    planAccessService,
    messageMonthCountService: sending.messageMonthCountService,
    messageFilePort,
    channelSendingPorts,
    broadcastRecipientService,
  });
  const { instagramWebhookEventService, instagramWebhookService } = createInstagramWebhookServices({
    instagramAccountService,
    organizationService,
    instagramOutgoingMessageService,
  });
  const container = {
    ...sending,
    ...createInstagramAccountTaskWork({
      sending,
      channelAccountService,
      automationService: automation.automationService,
    }),
    channelConnectionService,
    channelConnectionTokenService,
    channelAccountService,
    instagramAccountService,
    instagramAccountSettingsService,
    ...mediaAndErasure,
    // Route 154 (feat-meta-connect-flow IG2): the probe now, its answer stored, the stop moved.
    instagramAccountMessageAccessService: new InstagramAccountMessageAccessService(
      instagramAccountService,
      instagramAccountExtensionService,
      sending.instagramSendLaneService,
      channelConnectionService,
      organizationService,
    ),
    ...automation,
    instagramWebhookEventService,
    instagramWebhookService,
    channelSendingPorts,
    instagramSendingService,
    ...createBroadcastServices({
      organizationService,
      channelAccountService,
      messageMonthCountService: sending.messageMonthCountService,
      messageFilePort,
    }),
    broadcastRecipientService,
    instagramOutgoingMessageService,
    ...sendAccess,
  };
  // WC-38 (ROUTE row R52): billing's plan-state change → the plan-change task, in both processes.
  registerInstagramPlanChangeEventHandlers();
  return withSendWorkAndWatches(container);
}

/**
 * Fastify plugin step that decorates the application with the app domain container. Called by
 * `domainContainersPlugin` after the domains it reads (tenancy, and audit through the request).
 */
export function registerAppContainer(application: FastifyInstance): void {
  const { organizationService } = application.tenancyDomain;
  application.decorate(
    'appDomain',
    createAppContainer({
      organizationService,
      planAccessService: application.billingDomain.subscriptionService,
      trialPort: application.billingDomain.subscriptionTrialService,
      messageFilePort: application.uploadDomain.uploadService,
    }),
  );
}
