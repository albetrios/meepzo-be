import { PRINCIPAL_SCOPE } from '@/infrastructure/database/contexts/database-context.js';
import { encryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';
import type { ChannelMessageResultInput } from '@/domains/app/app.channel-ports.js';
import type { MetaUsageDecision } from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-usage.util.js';
import type { insertInstagramAccount } from '@/domains/app/sub-domains/contact/__tests__/factories/contact.factory.js';
import { InstagramMessageService } from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message.service.js';
import { InstagramSendCoreService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-core.service.js';
import { InstagramSendGateService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-gate.service.js';
import { InstagramSendLaneRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.repository.js';
import { InstagramSendLaneService } from '@/domains/app/sub-domains/instagram-sending/instagram-send-lane.service.js';
import { InstagramSendStopRepository } from '@/domains/app/sub-domains/instagram-sending/instagram-send-stop.repository.js';
import { SendingStateService } from '@/domains/app/sub-domains/instagram-sending/sending-state.service.js';
import type { InstagramSendLane } from '@/domains/app/sub-domains/instagram-sending/instagram-sending.constants.js';
import type {
  InstagramSendAccess,
  InstagramSendLaneRules,
  InstagramSendTicketContext,
} from '@/domains/app/sub-domains/instagram-sending/instagram-sending.types.js';

/** One test account (the contact factory's Instagram account). */
export type LaneHarnessAccount = Awaited<ReturnType<typeof insertInstagramAccount>>;

/** A ticket the core put back (BullMQ's `DelayedError` in a real worker). */
export class LaneHarnessTicketReturned extends Error {
  constructor(readonly delayMilliseconds: number) {
    super('ticket returned');
  }
}

/** What a lane test reads back from its send core. */
export interface LaneHarness {
  core: InstagramSendCoreService;
  /** The engine's results, in order. */
  recorded: ChannelMessageResultInput[];
  /** The lane tickets the core added. */
  enqueued: Array<{ lane: string; turnNumber: number; delayMilliseconds?: number | undefined }>;
  /** Meta's usage pace each send reads (tests change it). */
  pace: { value: MetaUsageDecision };
  messageService: InstagramMessageService;
  /** Works one turn of the account's lane with its current turn number. */
  turn(lane: 'slow' | 'reply'): Promise<void>;
  /** The fast tickets the core added (a used try's next ticket). */
  fastTickets: Array<{
    instagramMessagePublicId: string;
    tries: number;
    delayMilliseconds?: number | undefined;
  }>;
  /** Works one fast message's ticket (its current tries); a returned ticket throws {@link LaneHarnessTicketReturned}. */
  fast(message: {
    public_id: string;
    automation_run_started_at: Date;
    tries: number;
  }): Promise<void>;
}

/**
 * The real send core over the real lanes, gates, counts and result save, with one account's send
 * access, a recording engine and recording tickets — the lane rules under test plugged in (ROUTE
 * row R43). The Meta wire is the caller's nock.
 */
export function buildLaneHarness({
  organization,
  account,
  laneRules,
}: {
  organization: { id: number; public_id: string };
  account: LaneHarnessAccount;
  laneRules: (
    messageService: InstagramMessageService,
  ) => Partial<Record<InstagramSendLane, InstagramSendLaneRules>>;
}): LaneHarness {
  const recorded: ChannelMessageResultInput[] = [];
  const enqueued: LaneHarness['enqueued'] = [];
  const fastTickets: LaneHarness['fastTickets'] = [];
  const pace = { value: { pace: 'normal', waitUntil: null } as MetaUsageDecision };
  const laneService = new InstagramSendLaneService(
    new InstagramSendLaneRepository(),
    new InstagramSendStopRepository(),
  );
  const messageService = new InstagramMessageService({
    recordRunMessageResult: async (input) => {
      recorded.push(input);
    },
    recordBroadcastMessageResult: async () => undefined,
  });
  const access: InstagramSendAccess = {
    channelAccount: {
      organizationId: organization.id,
      channelAccountId: account.channel_account_id,
    },
    channelAccountPublicId: account.public_id,
    channelConnection: { organizationId: organization.id, channelConnectionId: 7 },
    channelConnectionPublicId: 'chc_ccccccccccccccccccccc',
    clientBusinessId: '5550001',
    instagramUserId: `1784${account.channel_account_id}`,
    encryptedAccessToken: encryptFieldSecret('EAAG-lane-test'),
    isSendable: true,
  };
  const core = new InstagramSendCoreService({
    laneService,
    messageService,
    gateService: new InstagramSendGateService({ laneService, redis: null }),
    accessService: {
      readSendAccess: async () => access,
      readSendPace: async () => pace.value,
      buildUsageRecorder: () => undefined,
    },
    attachmentService: {
      findOrUploadAttachment: async () => ({ status: 'unusable' }),
      forgetAttachment: async () => true,
    },
    sendingStateService: new SendingStateService(),
    readMonthLimit: async () => 1000,
    breakPort: {
      markConnectionBroken: async () => true,
      markAccountBroken: async () => true,
    },
    laneRules: laneRules(messageService),
    producers: {
      enqueueLaneTurn: async (input) => {
        enqueued.push(input);
      },
      enqueueFastMessage: async (input) => {
        fastTickets.push(input);
      },
    },
    sleep: async () => {},
  });
  const context: InstagramSendTicketContext = {
    jobId: 'lane-test-ticket',
    runInDatabaseSlot: (callback) => callback(),
    returnTicket: async (delayMilliseconds) => {
      throw new LaneHarnessTicketReturned(delayMilliseconds);
    },
  };
  const scope = PRINCIPAL_SCOPE.JOB({ organizationPublicId: organization.public_id });
  return {
    core,
    recorded,
    enqueued,
    pace,
    messageService,
    fastTickets,
    fast: async (message) => {
      await core.sendFastMessage({
        ticket: {
          organizationPublicId: organization.public_id,
          channelAccountPublicId: account.public_id,
          instagramMessagePublicId: message.public_id,
          automationRunStartedAt: message.automation_run_started_at.toISOString(),
          tries: message.tries,
        },
        scope,
        context,
      });
    },
    turn: async (lane) => {
      const rows = await new InstagramSendLaneRepository().listByAccount({
        organizationId: organization.id,
        channelAccountId: account.channel_account_id,
      });
      const row = rows.find((candidate) => candidate.lane === lane)!;
      await core.workLaneTurn({
        ticket: {
          organizationPublicId: organization.public_id,
          channelAccountPublicId: account.public_id,
          lane,
          turnNumber: row.turn_number,
        },
        scope,
        context,
      });
    },
  };
}

/** The account's lane row of `lane`, read through the lane repository. */
export async function readLaneRow({
  organizationId,
  account,
  lane,
}: {
  organizationId: number;
  account: LaneHarnessAccount;
  lane: InstagramSendLane;
}) {
  const rows = await new InstagramSendLaneRepository().listByAccount({
    organizationId,
    channelAccountId: account.channel_account_id,
  });
  return rows.find((row) => row.lane === lane)!;
}
