import { describe, expect, it } from 'vitest';
import { deriveMetaDataDeletionConfirmationCode } from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback-confirmation-code.util.js';
import { serializeMetaDataDeletionAnswer } from '@/domains/app/sub-domains/instagram-account/instagram-account-meta-callback/instagram-account-meta-callback.serializer.js';

const APP_SECRET = 'meta-callback-unit-test-app-secret';
const CONFIRMATION_CODE_PATTERN = /^[a-z0-9]{21}$/;

describe('deriveMetaDataDeletionConfirmationCode — the data-deletion code (IA20)', () => {
  const signedRequest = { userId: '17841400000000001', issuedAt: 1_763_740_000 };

  it('is 21 characters [a-z0-9]', () => {
    expect(
      deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: APP_SECRET }),
    ).toMatch(CONFIRMATION_CODE_PATTERN);
  });

  it('is the same for the same signed request — Meta repeating a request gets the same code', () => {
    const first = deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: APP_SECRET });
    const repeat = deriveMetaDataDeletionConfirmationCode({
      signedRequest: { ...signedRequest },
      appSecret: APP_SECRET,
    });
    expect(repeat).toBe(first);
  });

  it('differs for another person, another request time, or another app secret', () => {
    const base = deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: APP_SECRET });
    const variants = [
      deriveMetaDataDeletionConfirmationCode({
        signedRequest: { ...signedRequest, userId: '17841400000000002' },
        appSecret: APP_SECRET,
      }),
      deriveMetaDataDeletionConfirmationCode({
        signedRequest: { ...signedRequest, issuedAt: signedRequest.issuedAt + 1 },
        appSecret: APP_SECRET,
      }),
      deriveMetaDataDeletionConfirmationCode({ signedRequest, appSecret: 'another-app-secret' }),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('is stable for a request Meta sent without issued_at, and never contains the user id', () => {
    const withoutIssuedAt = { userId: '17841400000000001', issuedAt: null };
    const code = deriveMetaDataDeletionConfirmationCode({
      signedRequest: withoutIssuedAt,
      appSecret: APP_SECRET,
    });
    expect(code).toMatch(CONFIRMATION_CODE_PATTERN);
    expect(
      deriveMetaDataDeletionConfirmationCode({
        signedRequest: withoutIssuedAt,
        appSecret: APP_SECRET,
      }),
    ).toBe(code);
    expect(code).not.toContain(withoutIssuedAt.userId);
  });
});

describe('serializeMetaDataDeletionAnswer — Meta’s data-deletion answer (1.D.6)', () => {
  const confirmationCode = 'k3v9q2x7m1p8z4w6t0r5a';

  it('answers exactly Meta’s two keys: the frontend status page with the code, and the code', () => {
    const answer = serializeMetaDataDeletionAnswer({
      confirmation_code: confirmationCode,
      frontend_url: 'https://app.example.com',
    });

    expect(answer).toEqual({
      url: `https://app.example.com/instagram/data-deletion?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    });
    expect(Object.keys(answer).sort()).toEqual(['confirmation_code', 'url']);
  });

  it('never doubles the slash when FRONTEND_URL ends with one', () => {
    expect(
      serializeMetaDataDeletionAnswer({
        confirmation_code: confirmationCode,
        frontend_url: 'http://localhost:5173//',
      }).url,
    ).toBe(`http://localhost:5173/instagram/data-deletion?code=${confirmationCode}`);
  });

  it('keeps a FRONTEND_URL path prefix', () => {
    expect(
      serializeMetaDataDeletionAnswer({
        confirmation_code: confirmationCode,
        frontend_url: 'https://example.com/app/',
      }).url,
    ).toBe(`https://example.com/app/instagram/data-deletion?code=${confirmationCode}`);
  });
});
