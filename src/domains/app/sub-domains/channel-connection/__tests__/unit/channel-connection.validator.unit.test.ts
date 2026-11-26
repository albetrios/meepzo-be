import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  validateChannelAccountPick,
  validateChannelConnectCallback,
  validateChannelConnectionIdParam,
  validateChannelConnectionProvider,
  validateChannelConnectStartBody,
  validateListChannelConnectionAdAccountsQuery,
  validateListChannelConnectionAdsQuery,
  validateListChannelConnectionsQuery,
} from '@/domains/app/sub-domains/channel-connection/channel-connection.validator.js';

/** The channel connection's validators (routes-final § 1.8, 1.9) — what each route accepts. */

const STATE = 'A'.repeat(43);

describe('channel connection validators', () => {
  it('accepts meta as the provider and refuses any other with the provider field', () => {
    expect(validateChannelConnectionProvider('meta')).toBe('meta');
    try {
      validateChannelConnectionProvider('tiktok');
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(JSON.stringify(error)).toContain('provider');
    }
  });

  it('accepts a public id path parameter and refuses a malformed one', () => {
    expect(validateChannelConnectionIdParam('chc_abcdefghij0123456789k')).toBe(
      'chc_abcdefghij0123456789k',
    );
    expect(() => validateChannelConnectionIdParam('not-an-id')).toThrow(ValidationError);
  });

  it('takes none, an empty object or with_page on start and reconnect (P358)', () => {
    expect(validateChannelConnectStartBody(undefined)).toEqual({ withPage: false });
    expect(validateChannelConnectStartBody(null)).toEqual({ withPage: false });
    expect(validateChannelConnectStartBody({})).toEqual({ withPage: false });
    expect(validateChannelConnectStartBody({ with_page: false })).toEqual({ withPage: false });
    expect(validateChannelConnectStartBody({ with_page: true })).toEqual({ withPage: true });
    expect(() => validateChannelConnectStartBody({ extra: 1 })).toThrow(ValidationError);
    expect(() => validateChannelConnectStartBody({ with_page: 'yes' })).toThrow(ValidationError);
    expect(() => validateChannelConnectStartBody({ withPage: true })).toThrow(ValidationError);
  });

  it('strips a trailing #_ from the callback code and checks the state', () => {
    expect(validateChannelConnectCallback({ code: ' AQB-code#_ ', state: STATE })).toEqual({
      code: 'AQB-code',
      state: STATE,
    });
    const longest = validateChannelConnectCallback({ code: 'a'.repeat(2000), state: STATE });
    expect('code' in longest && longest.code).toHaveLength(2000);
  });

  it("reads Meta's cancel instead of a code, and refuses both or an unknown field (CN1)", () => {
    expect(
      validateChannelConnectCallback({
        state: STATE,
        error: 'access_denied',
        error_reason: 'user_denied',
        error_description: 'Permissions error',
      }),
    ).toEqual({
      state: STATE,
      error: 'access_denied',
      error_reason: 'user_denied',
      error_description: 'Permissions error',
    });
    expect(() =>
      validateChannelConnectCallback({ code: 'AQB', state: STATE, error: 'access_denied' }),
    ).toThrow(ValidationError);
    expect(() => validateChannelConnectCallback({ state: STATE, error: 'x'.repeat(101) })).toThrow(
      ValidationError,
    );
  });

  it.each([
    ['no code', { state: STATE }],
    ['an empty code', { code: ' ', state: STATE }],
    ['a code over 2000 characters', { code: 'a'.repeat(2001), state: STATE }],
    ['a short state', { code: 'AQB', state: 'short' }],
    ['a state that is not base64url', { code: 'AQB', state: `${'A'.repeat(42)}=` }],
    ['an unknown field', { code: 'AQB', state: STATE, extra: true }],
  ])('refuses a callback body with %s', (_case, body) => {
    expect(() => validateChannelConnectCallback(body)).toThrow(ValidationError);
  });

  it('accepts 1–10 distinct digit ids on the pick', () => {
    expect(
      validateChannelAccountPick({
        channel: 'instagram',
        provider_account_ids: ['178414', '178415'],
      }),
    ).toEqual({ channel: 'instagram', provider_account_ids: ['178414', '178415'] });
  });

  it.each([
    ['no ids', { channel: 'instagram', provider_account_ids: [] }],
    [
      'more than 10 ids',
      {
        channel: 'instagram',
        provider_account_ids: Array.from({ length: 11 }, (_, index) => `${index + 1}`),
      },
    ],
    ['a repeat', { channel: 'instagram', provider_account_ids: ['1', '1'] }],
    ['an id that is not digits', { channel: 'instagram', provider_account_ids: ['abc'] }],
    ['an unknown channel', { channel: 'facebook', provider_account_ids: ['1'] }],
    ['an unknown field', { channel: 'instagram', provider_account_ids: ['1'], extra: 1 }],
  ])('refuses a pick with %s', (_case, body) => {
    expect(() => validateChannelAccountPick(body)).toThrow(ValidationError);
  });

  it('reads include_revoked as a boolean, false by default', () => {
    expect(validateListChannelConnectionsQuery(undefined)).toEqual({ includeRevoked: false });
    expect(validateListChannelConnectionsQuery({ include_revoked: 'true' })).toEqual({
      includeRevoked: true,
    });
    expect(() => validateListChannelConnectionsQuery({ include_revoked: 'yes' })).toThrow(
      ValidationError,
    );
  });

  it("reads the ads query: one ad account, limit 1–50 (default 25), Meta's cursor (route 15, P57)", () => {
    expect(validateListChannelConnectionAdsQuery({ ad_account_id: '42' })).toEqual({
      ad_account_id: '42',
      limit: 25,
    });
    expect(
      validateListChannelConnectionAdsQuery({ ad_account_id: '42', limit: '50', after: 'c' }),
    ).toEqual({ ad_account_id: '42', limit: 50, after: 'c' });
  });

  it.each([
    ['no ad account', {}],
    ['an act_ prefix', { ad_account_id: 'act_42' }],
    ['limit 0', { ad_account_id: '42', limit: '0' }],
    ['limit 51', { ad_account_id: '42', limit: '51' }],
    ['an empty cursor', { ad_account_id: '42', after: '' }],
    ['a cursor over 1000', { ad_account_id: '42', after: 'a'.repeat(1001) }],
    ['an unknown field', { ad_account_id: '42', extra: '1' }],
  ])('refuses an ads query with %s', (_case, query) => {
    expect(() => validateListChannelConnectionAdsQuery(query)).toThrow(ValidationError);
  });

  it('takes no query on the ad accounts read', () => {
    expect(() => validateListChannelConnectionAdAccountsQuery(undefined)).not.toThrow();
    expect(() => validateListChannelConnectionAdAccountsQuery({ limit: '1' })).toThrow(
      ValidationError,
    );
  });
});
