import { describe, expect, it } from 'vitest';
import type { ChannelAccountRow } from '@/domains/app/sub-domains/channel-account/channel-account.repository.js';
import {
  serializeChannelAccount,
  serializeChannelAccountSummary,
} from '@/domains/app/sub-domains/channel-account/channel-account.serializer.js';

const CONNECTED_AT = new Date('2026-11-20T10:00:00.000Z');

function row(overrides: Partial<ChannelAccountRow> = {}): ChannelAccountRow {
  return {
    id: 5,
    public_id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
    organization_id: 7,
    channel: 'instagram',
    channel_connection_id: 9,
    provider_account_id: '17841400000000001',
    display_name: '@acme',
    connection_status: 'connected',
    is_automation_enabled: true,
    paused_at: null,
    paused_by_user_id: null,
    suspended_at: null,
    plan_stop_reason: null,
    plan_stopped_at: null,
    connected_by_user_id: 3,
    connected_at: CONNECTED_AT,
    disconnected_at: null,
    scopes: null,
    scopes_read_at: null,
    created_at: CONNECTED_AT,
    updated_at: CONNECTED_AT,
    ...overrides,
  };
}

describe('serializeChannelAccountSummary (1B.6)', () => {
  it('names each key, never an internal id', () => {
    const output = serializeChannelAccountSummary({
      account: row(),
      channel_connection_public_id: 'chc_k7x9m2pqr4w8n1v3a1b2c',
      profile_picture_url: null,
      has_lane_stop: false,
    });
    expect(output).toEqual({
      id: 'cha_k7x9m2pqr4w8n1v3a1b2c',
      channel: 'instagram',
      display_name: '@acme',
      profile_picture_url: null,
      connection_status: 'connected',
      channel_connection_id: 'chc_k7x9m2pqr4w8n1v3a1b2c',
      is_paused: false,
      is_suspended: false,
      is_in_plan: true,
      is_automation_enabled: true,
      has_sending_stop: false,
      connected_at: CONNECTED_AT.toISOString(),
    });
  });

  it('reads a plan_downgrade as "not in your plan" and any stop as a sending stop', () => {
    const output = serializeChannelAccountSummary({
      account: row({ plan_stop_reason: 'plan_downgrade', plan_stopped_at: CONNECTED_AT }),
      channel_connection_public_id: 'chc_x',
      profile_picture_url: null,
      has_lane_stop: false,
    });
    expect(output).toMatchObject({ is_in_plan: false, has_sending_stop: true });
  });
});

describe('serializeChannelAccount (1B.6)', () => {
  const base = {
    channel_connection: { id: 'chc_x', provider: 'meta', status: 'connected' },
    connected_by_user_public_id: 'usr_x',
    active_stop: null,
    instagram: null,
  };

  it('shows the new-account limit while it is ahead, and null once it passed (D5)', () => {
    const fresh = serializeChannelAccount({
      ...base,
      account: row(),
      now: new Date('2026-11-21T10:00:00.000Z'),
    });
    expect(fresh.new_account_limit_ends_at).toBe('2026-11-27T10:00:00.000Z');
    const old = serializeChannelAccount({
      ...base,
      account: row(),
      now: new Date('2026-12-01T10:00:00.000Z'),
    });
    expect(old.new_account_limit_ends_at).toBeNull();
  });

  it('carries the plan stop and the pause', () => {
    const output = serializeChannelAccount({
      ...base,
      account: row({
        plan_stop_reason: 'plan_limit',
        plan_stopped_at: CONNECTED_AT,
        paused_at: CONNECTED_AT,
      }),
      now: CONNECTED_AT,
    });
    expect(output).toMatchObject({
      is_paused: true,
      paused_at: CONNECTED_AT.toISOString(),
      is_in_plan: true,
      plan_stop_reason: 'plan_limit',
      connected_by_user_id: 'usr_x',
    });
    expect(output).not.toHaveProperty('scopes');
    expect(output).not.toHaveProperty('access_expires_at');
  });
});
