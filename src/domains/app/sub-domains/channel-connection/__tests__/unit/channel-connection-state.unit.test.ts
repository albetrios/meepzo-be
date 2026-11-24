import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_CONNECT_STATE_KEY_PREFIX,
  type ChannelConnectStatePayload,
  consumeChannelConnectState,
  mintChannelConnectState,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-state.js';
import { ValidationError } from '@/shared/errors/index.js';

const values = new Map<string, string>();
const redis = {
  set: vi.fn(async (key: string, value: string) => {
    values.set(key, value);
    return 'OK';
  }),
  getdel: vi.fn(async (key: string) => {
    const value = values.get(key) ?? null;
    values.delete(key);
    return value;
  }),
} as unknown as Redis;

const PAYLOAD: ChannelConnectStatePayload = {
  provider: 'meta',
  organization_public_id: 'org_aaaaaaaaaaaaaaaaaaaaa',
  user_public_id: 'usr_aaaaaaaaaaaaaaaaaaaaa',
  channel_connection_public_id: null,
};
const CALLER = {
  provider: 'meta' as const,
  organizationPublicId: PAYLOAD.organization_public_id,
  userPublicId: PAYLOAD.user_public_id,
};

beforeEach(() => {
  values.clear();
  vi.clearAllMocks();
});

describe('channel connection login state (MC4, P26)', () => {
  it('mints a 32-byte base64url state kept 10 minutes', async () => {
    const state = await mintChannelConnectState({ redis, payload: PAYLOAD });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redis.set).toHaveBeenCalledWith(
      `${CHANNEL_CONNECT_STATE_KEY_PREFIX}${state}`,
      JSON.stringify(PAYLOAD),
      'EX',
      600,
    );
  });

  it('answers the payload once, then refuses the same state', async () => {
    const reconnect = { ...PAYLOAD, channel_connection_public_id: 'chc_ccccccccccccccccccccc' };
    const state = await mintChannelConnectState({ redis, payload: reconnect });
    await expect(consumeChannelConnectState({ redis, state, ...CALLER })).resolves.toEqual(
      reconnect,
    );
    await expect(consumeChannelConnectState({ redis, state, ...CALLER })).rejects.toMatchObject({
      statusCode: 400,
      reason: 'channel_connect_state_invalid',
    });
  });

  it.each([
    ['another organization', { organizationPublicId: 'org_bbbbbbbbbbbbbbbbbbbbb' }],
    ['another user', { userPublicId: 'usr_bbbbbbbbbbbbbbbbbbbbb' }],
  ])("refuses %s's state and spends it", async (_label, override) => {
    const state = await mintChannelConnectState({ redis, payload: PAYLOAD });
    await expect(
      consumeChannelConnectState({ redis, state, ...CALLER, ...override }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(values.size).toBe(0);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['unknown or expired', 'never-minted'],
  ])('refuses a %s state', async (_label, state) => {
    await expect(consumeChannelConnectState({ redis, state, ...CALLER })).rejects.toMatchObject({
      reason: 'channel_connect_state_invalid',
    });
  });

  it('refuses a malformed stored payload', async () => {
    values.set(`${CHANNEL_CONNECT_STATE_KEY_PREFIX}bad`, '{"provider":"tiktok"}');
    await expect(
      consumeChannelConnectState({ redis, state: 'bad', ...CALLER }),
    ).rejects.toMatchObject({ reason: 'channel_connect_state_invalid' });
  });
});
