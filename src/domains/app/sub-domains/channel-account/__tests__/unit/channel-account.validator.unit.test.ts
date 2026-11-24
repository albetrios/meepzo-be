import { describe, expect, it } from 'vitest';
import {
  validateActivateChannelAccount,
  validateChannelAccountIdParam,
  validateListChannelAccountsQuery,
} from '@/domains/app/sub-domains/channel-account/channel-account.validator.js';

const CHANNEL_ACCOUNT_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';

describe('channel account validators (1B.8, 1B.9)', () => {
  it('reads every channel by default and a comma-separated filter without repeats', () => {
    expect(validateListChannelAccountsQuery(undefined)).toEqual({ channels: ['instagram'] });
    expect(validateListChannelAccountsQuery({ channel: 'instagram, instagram' })).toEqual({
      channels: ['instagram'],
    });
  });

  it('refuses an unknown channel or field with 400', () => {
    expect(() => validateListChannelAccountsQuery({ channel: 'whatsapp' })).toThrow();
    expect(() => validateListChannelAccountsQuery({ page: '2' })).toThrow();
  });

  it('checks the path id as a public id', () => {
    expect(validateChannelAccountIdParam(CHANNEL_ACCOUNT_ID)).toBe(CHANNEL_ACCOUNT_ID);
    expect(() => validateChannelAccountIdParam('cha_1')).toThrow();
  });

  it('reads the optional stop_channel_account_id as a cha_ id only', () => {
    expect(validateActivateChannelAccount(undefined)).toEqual({ stopChannelAccountPublicId: null });
    expect(validateActivateChannelAccount({})).toEqual({ stopChannelAccountPublicId: null });
    expect(validateActivateChannelAccount({ stop_channel_account_id: CHANNEL_ACCOUNT_ID })).toEqual(
      { stopChannelAccountPublicId: CHANNEL_ACCOUNT_ID },
    );
    expect(() =>
      validateActivateChannelAccount({ stop_channel_account_id: 'chc_k7x9m2pqr4w8n1v3a1b2c' }),
    ).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(() => validateActivateChannelAccount({ other: 1 })).toThrow();
  });
});
