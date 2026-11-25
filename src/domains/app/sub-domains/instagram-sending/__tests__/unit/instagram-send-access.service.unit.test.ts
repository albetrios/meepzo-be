import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelConnectionUsageEntry,
  ChannelConnectionUsageStore,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-usage.types.js';
import type { InstagramAccountReadAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import type { InstagramAccountRow } from '@/domains/app/sub-domains/instagram-account/instagram-account.repository.js';
import type { OrganizationPrincipalDatabaseScope } from '@/infrastructure/database/contexts/database-context.js';

/** An in-memory Redis honouring `NX`, as the usage service's own unit test keeps it. */
const redisValues = new Map<string, string>();
vi.mock('@/infrastructure/cache/redis.client.js', () => ({
  redisConnection: {
    get: async (key: string) => redisValues.get(key) ?? null,
    set: async (key: string, value: string, ...flags: unknown[]) => {
      if (flags.includes('NX') && redisValues.has(key)) return null;
      redisValues.set(key, value);
      return 'OK';
    },
  },
}));
vi.mock('@/infrastructure/observability/metrics/prometheus-metrics.js', () => ({
  recordReadCacheRequest: () => undefined,
}));

const { createChannelConnectionUsageService } = await import(
  '@/domains/app/sub-domains/channel-connection/channel-connection-usage.service.js'
);
const { InstagramSendAccessService } = await import(
  '@/domains/app/sub-domains/instagram-sending/instagram-send-access.service.js'
);

const NOW = new Date('2026-11-25T10:00:00.000Z');
const ORGANIZATION = 'org_aaaaaaaaaaaaaaaaaaaaa';
const CONNECTION = 'chc_ccccccccccccccccccccc';
const OTHER_CONNECTION = 'chc_ddddddddddddddddddddd';
const BUSINESS_ID = '5550001';
const scope = { organizationPublicId: ORGANIZATION } as OrganizationPrincipalDatabaseScope;

/** Three accounts: A and B on one connection (one business), C on another. */
const ACCOUNTS: Record<string, { instagramUserId: string; connection: string; business: string }> =
  {
    cha_aaaaaaaaaaaaaaaaaaaaa: {
      instagramUserId: '1784001',
      connection: CONNECTION,
      business: BUSINESS_ID,
    },
    cha_bbbbbbbbbbbbbbbbbbbbb: {
      instagramUserId: '1784002',
      connection: CONNECTION,
      business: BUSINESS_ID,
    },
    cha_ccccccccccccccccccccc: {
      instagramUserId: '1784003',
      connection: OTHER_CONNECTION,
      business: '5550002',
    },
  };

function accessOf(channelAccountPublicId: string): InstagramAccountReadAccess {
  const account = ACCOUNTS[channelAccountPublicId]!;
  return {
    account: {
      instagram_user_id: account.instagramUserId,
      connection_status: 'connected',
    } as InstagramAccountRow,
    channelAccount: { organizationId: 1, channelAccountId: 10 },
    channelConnection: { organizationId: 1, channelConnectionId: 20 },
    connectionStatus: 'connected',
    channelConnectionPublicId: account.connection,
    clientBusinessId: account.business,
    encryptedAccessToken: 'ciphertext',
  };
}

function entry(overrides: Partial<ChannelConnectionUsageEntry>): ChannelConnectionUsageEntry {
  return {
    assetId: BUSINESS_ID,
    type: 'instagram',
    usagePercent: 10,
    waitUntil: null,
    readAt: new Date(NOW.getTime() - 1000),
    ...overrides,
  };
}

/**
 * The sender's one read before a Meta call (feat-instagram-dm-sending § 6 SN23, SNC16; P51, S13,
 * AC-17.16): the pace comes from the connection's usage, never from the lanes — a business-wide
 * 95 % holds every account of that connection, one account's own reading only that account.
 */
describe('InstagramSendAccessService — the pace from the connection (SN23)', () => {
  const rows = new Map<string, ChannelConnectionUsageEntry[]>();
  const store: ChannelConnectionUsageStore = {
    readConnectionUsageEntries: async (target) => rows.get(target.channelConnectionPublicId) ?? [],
    writeConnectionUsageEntries: async ({ entries, channelConnectionPublicId }) => {
      rows.set(channelConnectionPublicId, [...entries]);
    },
  };
  const service = new InstagramSendAccessService({
    accountService: {
      findAccountReadAccess: async ({ channelAccountPublicId }) => accessOf(channelAccountPublicId),
    },
    usageService: createChannelConnectionUsageService({ usageStore: store }),
  });

  async function paceOf(channelAccountPublicId: string) {
    const access = await service.readSendAccess({ scope, channelAccountPublicId });
    return service.readSendPace({ scope, access, now: NOW });
  }

  beforeEach(() => {
    redisValues.clear();
    rows.clear();
  });

  it('reads the account, its connection and token as one send access', async () => {
    const access = await service.readSendAccess({
      scope,
      channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
    });
    expect(access).toMatchObject({
      channelAccountPublicId: 'cha_aaaaaaaaaaaaaaaaaaaaa',
      channelConnectionPublicId: CONNECTION,
      clientBusinessId: BUSINESS_ID,
      instagramUserId: '1784001',
      isSendable: true,
    });
  });

  it("holds every account of the connection at 95 % of the business's usage, until Meta's time", async () => {
    const waitUntil = new Date(NOW.getTime() + 20 * 60 * 1000);
    rows.set(CONNECTION, [entry({ usagePercent: 96, waitUntil })]);

    expect(await paceOf('cha_aaaaaaaaaaaaaaaaaaaaa')).toEqual({ pace: 'wait', waitUntil });
    expect(await paceOf('cha_bbbbbbbbbbbbbbbbbbbbb')).toEqual({ pace: 'wait', waitUntil });
    // Another connection's accounts keep sending.
    expect(await paceOf('cha_ccccccccccccccccccccc')).toEqual({ pace: 'normal', waitUntil: null });
  });

  it('holds only the account whose own asset is at 95 % (S13), and slows at 80 %', async () => {
    const waitUntil = new Date(NOW.getTime() + 15 * 60 * 1000);
    rows.set(CONNECTION, [
      entry({ assetId: '1784001', usagePercent: 97, waitUntil }),
      entry({ assetId: '1784002', usagePercent: 82 }),
    ]);

    expect(await paceOf('cha_aaaaaaaaaaaaaaaaaaaaa')).toEqual({ pace: 'wait', waitUntil });
    expect(await paceOf('cha_bbbbbbbbbbbbbbbbbbbbb')).toEqual({ pace: 'slow', waitUntil: null });
  });

  it('records the answer of a Meta call on the connection, so the next read of every account sees it', async () => {
    const access = await service.readSendAccess({
      scope,
      channelAccountPublicId: 'cha_bbbbbbbbbbbbbbbbbbbbb',
    });
    const recordUsage = service.buildUsageRecorder({ scope, access });
    expect(recordUsage).toBeDefined();
    await recordUsage!({
      readAt: NOW,
      appUsagePercent: null,
      businessUseCases: [
        {
          assetId: BUSINESS_ID,
          type: 'instagram',
          usagePercent: 99,
          waitUntil: new Date(NOW.getTime() + 15 * 60 * 1000),
        },
      ],
    });

    expect((await paceOf('cha_aaaaaaaaaaaaaaaaaaaaa')).pace).toBe('wait');
  });
});
