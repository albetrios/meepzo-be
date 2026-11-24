import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '@/infrastructure/outbound/outbound-error.js';
import { CircuitBreakerOpenError } from '@/infrastructure/resilience/circuit-breaker.js';
import {
  MetaGraphApiError,
  toMetaGraphApiError,
} from '@/domains/app/sub-domains/channel-connection/channel-connection-meta/meta-graph-error.util.js';
import { initializeI18nextForBackgroundWork } from '@/shared/middlewares/core/i18n.middleware.js';
import type { InstagramAutomationAccountAccess } from '@/domains/app/sub-domains/instagram-account/instagram-account.types.js';
import {
  type AutomationInstagramClient,
  AutomationRunMessageService,
  classifyAutomationSendFailure,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.service.js';

/**
 * Sending a run's messages (routes-final § 3.B AU19, AU22, K10) with a fake Instagram client: every
 * failure classified once (temporary, refused, token, unknown), the quick-reply refusal sent again
 * as plain text under the same claim, the pause before each send, and the English defaults.
 */

function instagramError({
  errorClass,
  category = 'http_4xx',
  httpStatus = category === 'http_5xx' ? 500 : 400,
  code = null,
  subcode = null,
  cause,
}: {
  errorClass: 'auth' | 'throttled' | 'refused' | 'outage';
  category?: ConstructorParameters<typeof MetaGraphApiError>[0]['category'];
  httpStatus?: number;
  code?: number | null;
  subcode?: number | null;
  cause?: unknown;
}): MetaGraphApiError {
  return new MetaGraphApiError({
    errorClass,
    category,
    connectionStatus: errorClass === 'auth' ? 'error' : null,
    httpStatus,
    details: { code, subcode, type: null, fbtraceId: 'trace-1' },
    ...(cause === undefined ? {} : { cause }),
    fallbackMessage: 'Instagram failed',
  });
}

const access: InstagramAutomationAccountAccess = {
  instagramAccount: { organizationId: 7, instagramAccountId: 3 },
  instagramAccountPublicId: 'iga_k7x9m2pqr4w8n1v3a1b2c',
  instagramAppUserId: '17841400000000999',
  username: 'acme.shop',
  connectionStatus: 'connected',
  encryptedAccessToken: 'v1:encrypted',
  settings: null,
};

describe('classifyAutomationSendFailure (AU19, 3.B.9)', () => {
  it.each([
    ['a dead token', instagramError({ errorClass: 'auth', code: 190 }), 'token'],
    ['a refusal', instagramError({ errorClass: 'refused', code: 10, subcode: 2534022 }), 'refused'],
    ['a throttle', instagramError({ errorClass: 'throttled', code: 4 }), 'temporary'],
    [
      'an HTTP 500',
      instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus: 500 }),
      'temporary',
    ],
    [
      'an HTTP 501',
      instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus: 501 }),
      'temporary',
    ],
    [
      'an HTTP 503',
      instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus: 503 }),
      'temporary',
    ],
    // D55: a gateway that lost Instagram's answer cannot say whether the message went.
    [
      'an HTTP 502',
      instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus: 502 }),
      'unknown',
    ],
    [
      'an HTTP 504',
      instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus: 504 }),
      'unknown',
    ],
    [
      'a throttle behind an HTTP 502 (Instagram answered)',
      instagramError({ errorClass: 'throttled', category: 'http_5xx', httpStatus: 502, code: 613 }),
      'temporary',
    ],
    [
      'an open circuit',
      instagramError({ errorClass: 'outage', category: 'circuit_open' }),
      'temporary',
    ],
    ['a raw open circuit', new CircuitBreakerOpenError('meta', 1000, 'open'), 'temporary'],
    [
      'a connection refused before sending',
      instagramError({
        errorClass: 'outage',
        category: 'network',
        cause: new ExternalServiceError({
          integration: 'meta-graph',
          category: 'network',
          cause: Object.assign(new Error('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
          }),
        }),
      }),
      'temporary',
    ],
    ['a timeout', instagramError({ errorClass: 'outage', category: 'timeout' }), 'unknown'],
    [
      'a reset connection',
      instagramError({ errorClass: 'outage', category: 'network' }),
      'unknown',
    ],
    ['an error of our own', new Error('boom'), 'unknown'],
  ])('%s → %s', (_label, error, outcome) => {
    expect(classifyAutomationSendFailure(error).outcome).toBe(outcome);
  });

  it('an error of our own is a `code` failure, a timeout a `network` one', () => {
    expect(classifyAutomationSendFailure(new Error('boom'))).toMatchObject({ errorType: 'code' });
    expect(
      classifyAutomationSendFailure(instagramError({ errorClass: 'outage', category: 'timeout' })),
    ).toMatchObject({ errorType: 'network' });
  });

  it.each([502, 504])(
    'an HTTP %s is a `network` failure, as a timeout (D55, AQ5)',
    (httpStatus) => {
      const error = instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus });
      expect(classifyAutomationSendFailure(error)).toEqual({
        outcome: 'unknown',
        error,
        errorType: 'network',
      });
    },
  );

  it('a bare 502 from the outbound layer is unknown too', () => {
    const error = toMetaGraphApiError(
      new ExternalServiceError({ integration: 'meta-graph', category: 'http_5xx', status: 502 }),
    );
    expect(classifyAutomationSendFailure(error).outcome).toBe('unknown');
  });
});

describe('AutomationRunMessageService', () => {
  let client: {
    sendInstagramMessage: ReturnType<typeof vi.fn>;
    replyToInstagramComment: ReturnType<typeof vi.fn>;
    readInstagramUserProfile: ReturnType<typeof vi.fn>;
  };
  let pauses: number[];
  let service: AutomationRunMessageService;

  beforeAll(async () => {
    await initializeI18nextForBackgroundWork();
  });

  beforeEach(() => {
    client = {
      sendInstagramMessage: vi.fn(async () => ({ messageId: 'm1', recipientId: 'r1' })),
      replyToInstagramComment: vi.fn(async () => ({ instagramCommentReplyId: 'c1' })),
      readInstagramUserProfile: vi.fn(),
    };
    pauses = [];
    service = new AutomationRunMessageService(
      client as unknown as AutomationInstagramClient,
      async (milliseconds) => {
        pauses.push(milliseconds);
      },
      () => 300,
    );
  });

  it('pauses 200–1000 ms before each send (K10), then sends with the ciphertext token', async () => {
    const composed = service.composeMessage({
      messageKind: 'final_message',
      automation: {
        opening_message: null,
        follow_request_message: null,
        email_request_message: null,
        phone_request_message: null,
        final_message: { text: 'Here you go', links: [] },
      },
      automationPublicId: 'aut_k7x9m2pqr4w8n1v3a1b2c',
      runPublicId: 'run_p3k8w2m9x4r7n1v5a1b2c',
      accountUsername: 'acme.shop',
    });

    const result = await service.sendDirectMessage({
      access,
      recipient: { id: '17841400000000001' },
      composed,
      requestId: 'job-1',
    });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(pauses).toEqual([500]);
    expect(client.sendInstagramMessage).toHaveBeenCalledWith({
      encryptedAccessToken: 'v1:encrypted',
      instagramAppUserId: '17841400000000999',
      recipient: { id: '17841400000000001' },
      message: { text: 'Here you go' },
      requestId: 'job-1',
    });
  });

  it('sends the question again as plain text when Instagram refuses the quick reply (AU22)', async () => {
    client.sendInstagramMessage.mockRejectedValueOnce(
      instagramError({ errorClass: 'refused', code: 100, subcode: 2534015 }),
    );
    const composed = service.composeMessage({
      messageKind: 'email_question',
      automation: {
        opening_message: null,
        follow_request_message: null,
        email_request_message: null,
        phone_request_message: null,
        final_message: { text: 'x', links: [] },
      },
      automationPublicId: 'aut_k7x9m2pqr4w8n1v3a1b2c',
      runPublicId: 'run_p3k8w2m9x4r7n1v5a1b2c',
      accountUsername: 'acme.shop',
    });

    const result = await service.sendDirectMessage({
      access,
      recipient: { id: '17841400000000001' },
      composed,
      requestId: undefined,
    });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(client.sendInstagramMessage).toHaveBeenCalledTimes(2);
    expect(client.sendInstagramMessage.mock.calls[0]?.[0].message).toEqual({
      text: 'Please share your email to continue!',
      quick_replies: [{ content_type: 'user_email' }],
    });
    expect(client.sendInstagramMessage.mock.calls[1]?.[0].message).toEqual({
      text: 'Please share your email to continue!',
    });
  });

  it('returns a refusal as is, without a second send', async () => {
    const refusal = instagramError({ errorClass: 'refused', code: 10, subcode: 2534022 });
    client.sendInstagramMessage.mockRejectedValueOnce(refusal);

    const result = await service.sendDirectMessage({
      access,
      recipient: { id: '17841400000000001' },
      composed: { message: { text: 'Hi' }, plainTextFallback: null },
      requestId: undefined,
    });

    expect(result).toEqual({ outcome: 'refused', error: refusal });
    expect(client.sendInstagramMessage).toHaveBeenCalledTimes(1);
  });

  it('sends the public reply under the comment', async () => {
    const result = await service.sendPublicReply({
      access,
      instagramCommentId: '17950000000000001',
      text: 'Check your DMs!',
      requestId: undefined,
    });

    expect(result).toEqual({ outcome: 'delivered' });
    expect(client.replyToInstagramComment).toHaveBeenCalledWith({
      encryptedAccessToken: 'v1:encrypted',
      instagramCommentId: '17950000000000001',
      text: 'Check your DMs!',
      requestId: undefined,
    });
  });

  it('reads the follow status; a refusal reads as unknown, a dead token as token', async () => {
    client.readInstagramUserProfile.mockResolvedValueOnce({
      name: null,
      username: 'jordan',
      profilePictureUrl: null,
      followerCount: null,
      isUserFollowingBusiness: true,
    });
    await expect(
      service.readFollowStatus({
        access,
        instagramUserId: '17841400000000001',
        requestId: undefined,
      }),
    ).resolves.toMatchObject({ outcome: 'read', isFollowing: true });

    client.readInstagramUserProfile.mockRejectedValueOnce(
      instagramError({ errorClass: 'refused' }),
    );
    await expect(
      service.readFollowStatus({
        access,
        instagramUserId: '17841400000000001',
        requestId: undefined,
      }),
    ).resolves.toEqual({ outcome: 'read', isFollowing: null, profile: null });

    client.readInstagramUserProfile.mockRejectedValueOnce(
      instagramError({ errorClass: 'auth', code: 190 }),
    );
    await expect(
      service.readFollowStatus({
        access,
        instagramUserId: '17841400000000001',
        requestId: undefined,
      }),
    ).resolves.toMatchObject({ outcome: 'token' });

    client.readInstagramUserProfile.mockRejectedValueOnce(
      instagramError({ errorClass: 'outage', category: 'timeout' }),
    );
    await expect(
      service.readFollowStatus({
        access,
        instagramUserId: '17841400000000001',
        requestId: undefined,
      }),
    ).resolves.toMatchObject({ outcome: 'temporary', errorType: 'network' });
  });

  it('a follow read is safe to repeat: an HTTP 502 is temporary there (D55 is about sends)', async () => {
    client.readInstagramUserProfile.mockRejectedValueOnce(
      instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus: 502 }),
    );
    await expect(
      service.readFollowStatus({
        access,
        instagramUserId: '17841400000000001',
        requestId: undefined,
      }),
    ).resolves.toMatchObject({ outcome: 'temporary', errorType: 'instagram_api' });
  });

  it.each([502, 504])(
    'never sends a message or a reply again after an HTTP %s (D55)',
    async (httpStatus) => {
      const error = instagramError({ errorClass: 'outage', category: 'http_5xx', httpStatus });
      client.sendInstagramMessage.mockRejectedValueOnce(error);
      client.replyToInstagramComment.mockRejectedValueOnce(error);

      await expect(
        service.sendDirectMessage({
          access,
          recipient: { id: '17841400000000001' },
          composed: { message: { text: 'Hi' }, plainTextFallback: { text: 'Hi' } },
          requestId: undefined,
        }),
      ).resolves.toEqual({ outcome: 'unknown', error, errorType: 'network' });
      await expect(
        service.sendPublicReply({
          access,
          instagramCommentId: '17950000000000001',
          text: 'Check your DMs!',
          requestId: undefined,
        }),
      ).resolves.toEqual({ outcome: 'unknown', error, errorType: 'network' });

      expect(client.sendInstagramMessage).toHaveBeenCalledTimes(1);
      expect(client.replyToInstagramComment).toHaveBeenCalledTimes(1);
    },
  );

  it('reads the English default texts (AU22)', () => {
    expect(service.readDefaultTexts()).toEqual({
      emailQuestion: 'Please share your email to continue!',
      phoneQuestion: 'Please share your phone number to continue!',
      invalidEmail:
        'Please provide a valid email address. Use the button below to share your email.',
      buttonTemplateText: 'What do you want to do next?',
      linkButtonTitle: 'Visit Link',
    });
  });
});
