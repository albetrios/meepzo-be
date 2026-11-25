import nock from 'nock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  META_GRAPH_BASE_URL,
  META_GRAPH_VERSION,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph.client.js';
import {
  buildMetaLoginUrl,
  exchangeMetaLoginCode,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-login.js';
import { getEnv, resetEnvCacheForTests } from '@/shared/config/env.config.js';
import { decryptFieldSecret } from '@/shared/utils/security/field-secret-encryption.util.js';

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});

describe('buildMetaLoginUrl (MC4)', () => {
  it('answers the Unified Login address with the state, never the secret', () => {
    const environment = getEnv();
    const url = new URL(buildMetaLoginUrl({ state: 'state-one' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://www.facebook.com/dialog/oauth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: environment.META_APP_ID,
      config_id: environment.META_CONFIG_ID,
      redirect_uri: environment.META_REDIRECT_URI,
      response_type: 'code',
      state: 'state-one',
      prompt: 'login',
    });
    expect(url.toString()).not.toContain(environment.META_APP_SECRET ?? '');
  });

  it('answers 503 instagram_not_configured without the login configuration', () => {
    const saved = process.env.META_CONFIG_ID;
    delete process.env.META_CONFIG_ID;
    resetEnvCacheForTests();
    try {
      expect(() => buildMetaLoginUrl({ state: 's' })).toThrow(
        expect.objectContaining({ statusCode: 503, reason: 'instagram_not_configured' }),
      );
    } finally {
      process.env.META_CONFIG_ID = saved;
      resetEnvCacheForTests();
    }
  });
});

describe('exchangeMetaLoginCode (MC5 step 2)', () => {
  it('exchanges the code on graph.facebook.com and returns the token encrypted', async () => {
    const environment = getEnv();
    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
      .query({
        client_id: environment.META_APP_ID ?? '',
        client_secret: environment.META_APP_SECRET ?? '',
        redirect_uri: environment.META_REDIRECT_URI ?? '',
        code: 'the-code',
      })
      .reply(200, { access_token: 'system-user-token', token_type: 'bearer' });

    const token = await exchangeMetaLoginCode({ code: 'the-code' });
    expect(token.encryptedAccessToken).not.toContain('system-user-token');
    expect(decryptFieldSecret(token.encryptedAccessToken)).toBe('system-user-token');
  });

  it("keeps the token's end from Meta's expires_in, and no end when Meta names none (P355)", async () => {
    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
      .query(true)
      .reply(200, { access_token: 'dated-token', token_type: 'bearer', expires_in: 5_184_000 })
      .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
      .query(true)
      .reply(200, { access_token: 'lasting-token', token_type: 'bearer', expires_in: 0 });

    const before = Date.now();
    const dated = await exchangeMetaLoginCode({ code: 'dated-code' });
    expect(dated.expiresAt?.getTime()).toBeGreaterThanOrEqual(before + 5_184_000_000);
    expect(dated.expiresAt?.getTime()).toBeLessThanOrEqual(Date.now() + 5_184_000_000);
    await expect(exchangeMetaLoginCode({ code: 'lasting-code' })).resolves.toMatchObject({
      expiresAt: null,
    });
  });

  it('a refused code is a refusal; an answer without a token is an outage', async () => {
    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
      .query(true)
      .reply(400, { error: { type: 'OAuthException', code: 100, fbtrace_id: 't' } });
    await expect(exchangeMetaLoginCode({ code: 'used' })).rejects.toMatchObject({
      errorClass: 'refused',
    });

    nock(META_GRAPH_BASE_URL)
      .get(`/${META_GRAPH_VERSION}/oauth/access_token`)
      .query(true)
      .reply(200, {});
    await expect(exchangeMetaLoginCode({ code: 'x' })).rejects.toMatchObject({
      errorClass: 'outage',
    });
  });
});
