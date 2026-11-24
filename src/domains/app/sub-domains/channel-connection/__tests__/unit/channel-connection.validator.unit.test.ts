import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import {
  validateChannelAccountPick,
  validateChannelConnectCallback,
  validateChannelConnectionIdParam,
  validateChannelConnectionProvider,
  validateEmptyChannelConnectionBody,
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

  it('takes no body on start and reconnect: none or an empty object', () => {
    expect(() => validateEmptyChannelConnectionBody(undefined)).not.toThrow();
    expect(() => validateEmptyChannelConnectionBody({})).not.toThrow();
    expect(() => validateEmptyChannelConnectionBody({ extra: 1 })).toThrow(ValidationError);
  });

  it('strips a trailing #_ from the callback code and checks the state', () => {
    expect(validateChannelConnectCallback({ code: ' AQB-code#_ ', state: STATE })).toEqual({
      code: 'AQB-code',
      state: STATE,
    });
    expect(
      validateChannelConnectCallback({ code: 'a'.repeat(2000), state: STATE }).code,
    ).toHaveLength(2000);
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
});
