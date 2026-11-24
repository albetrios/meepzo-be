import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, RateLimitedError, ValidationError } from '@/shared/errors/index.js';
import { eventBus } from '@/core/events/event-bus.js';
import { EmailConfirmationService } from '@/domains/auth/sub-domains/auth-method/email-confirmation.service.js';
import { AUTH_EVENT } from '@/domains/auth/sub-domains/auth-method/events/auth.events.js';
import type { UserService } from '@/domains/user/user.service.js';
import type { VerificationTokenRepository } from '@/domains/auth/sub-domains/auth-method/verification-token/verification-token.repository.js';

// The service wraps its writes in withTransaction + runWithPinnedDatabaseHandle; run the callbacks
// directly so the unit test exercises the flow without a database.
vi.mock('@/infrastructure/database/transaction.js', () => ({
  withTransaction: vi.fn(({ callback }: { callback: (transaction: unknown) => unknown }) =>
    callback({}),
  ),
}));

vi.mock(
  '@/infrastructure/database/contexts/database-context-runtime.js',
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      runWithPinnedDatabaseHandle: vi.fn(({ callback }: { callback: () => unknown }) => callback()),
    };
  },
);

vi.mock('@/core/events/event-bus.js', () => ({
  eventBus: { emitStrict: vi.fn().mockResolvedValue(undefined) },
}));

const person = {
  id: 7,
  public_id: 'usr_aaaaaaaaaaaaaaaaaaaaa',
  email: 'person@example.com',
  is_email_verified: false,
  deleted_at: null as Date | null,
};

function buildService() {
  const userService = {
    requireUserRecordByPublicId: vi.fn().mockResolvedValue({ ...person }),
    findById: vi.fn().mockResolvedValue({ ...person }),
    updateEmailVerified: vi.fn().mockResolvedValue({ ...person, is_email_verified: true }),
  };
  const repository = {
    findNewestForUser: vi.fn().mockResolvedValue(null),
    invalidateAllForUser: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({}),
    consumeIfValid: vi.fn().mockResolvedValue({ user_id: person.id, email: person.email }),
  };
  const service = new EmailConfirmationService(
    userService as unknown as UserService,
    repository as unknown as VerificationTokenRepository,
  );
  return { service, userService, repository };
}

describe('EmailConfirmationService.requestLink (route 133, UN6)', () => {
  beforeEach(() => vi.mocked(eventBus.emitStrict).mockClear());

  it('ends the live links, stores only the hash for 24 hours and emits the link event', async () => {
    const { service, repository } = buildService();
    const result = await service.requestLink({
      userPublicId: person.public_id,
      body: undefined,
      locale: 'es',
    });

    expect(result.resend_after_seconds).toBe(60);
    expect(repository.invalidateAllForUser).toHaveBeenCalledWith(person.id, 'EMAIL_CONFIRM');
    const [tokenType, userId, email, tokenHash, expiresAt] = repository.create.mock.calls[0]!;
    expect([tokenType, userId, email]).toEqual(['EMAIL_CONFIRM', person.id, person.email]);
    expect(expiresAt).toEqual(result.expires_at);
    expect((result.expires_at.getTime() - Date.now()) / 3_600_000).toBeCloseTo(24, 1);

    const event = vi.mocked(eventBus.emitStrict).mock.calls[0]![0] as {
      type: string;
      payload: { token: string; expires_in_hours: number; locale: string };
    };
    expect(event.type).toBe(AUTH_EVENT.EMAIL_CONFIRM_LINK_REQUESTED);
    expect(event.payload.expires_in_hours).toBe(24);
    expect(event.payload.locale).toBe('es');
    expect(Buffer.from(event.payload.token, 'base64url')).toHaveLength(32);
    expect(tokenHash).toBe(createHash('sha256').update(event.payload.token).digest('hex'));
  });

  it('409 email_already_confirmed when the email is confirmed', async () => {
    const { service, userService, repository } = buildService();
    userService.requireUserRecordByPublicId.mockResolvedValue({
      ...person,
      is_email_verified: true,
    });

    await expect(
      service.requestLink({ userPublicId: person.public_id, body: {} }),
    ).rejects.toMatchObject({ statusCode: 409, reason: 'email_already_confirmed' });
    await expect(
      service.requestLink({ userPublicId: person.public_id, body: {} }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('429 email_confirmation_resend_too_soon with the seconds left of the 60 s wait', async () => {
    const { service, repository } = buildService();
    repository.findNewestForUser.mockResolvedValue({
      created_at: new Date(Date.now() - 20_000),
      expires_at: new Date(),
      used_at: null,
    });

    const error = await service
      .requestLink({ userPublicId: person.public_id, body: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ reason: 'email_confirmation_resend_too_soon' });
    const seconds = (error as RateLimitedError).fields?.retry_after_seconds;
    expect(seconds).toBeGreaterThanOrEqual(39);
    expect(seconds).toBeLessThanOrEqual(40);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('a link older than 60 s does not hold the next one', async () => {
    const { service, repository } = buildService();
    repository.findNewestForUser.mockResolvedValue({
      created_at: new Date(Date.now() - 60_000),
      expires_at: new Date(),
      used_at: null,
    });
    await service.requestLink({ userPublicId: person.public_id, body: {} });
    expect(repository.create).toHaveBeenCalledTimes(1);
  });

  it('400 on any body field', async () => {
    const { service } = buildService();
    await expect(
      service.requestLink({ userPublicId: person.public_id, body: { email: 'x@example.com' } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('EmailConfirmationService.confirm (route 134, UN7)', () => {
  it('consumes the hashed token and confirms the email', async () => {
    const { service, repository, userService } = buildService();
    const result = await service.confirm({ body: { token: 'raw-token' } });

    expect(repository.consumeIfValid).toHaveBeenCalledWith(
      createHash('sha256').update('raw-token').digest('hex'),
      'EMAIL_CONFIRM',
    );
    expect(userService.updateEmailVerified).toHaveBeenCalledWith(person.public_id);
    expect(result).toEqual({ is_email_verified: true, user_public_id: person.public_id });
  });

  it('an already confirmed email is the same success with nothing written', async () => {
    const { service, userService } = buildService();
    userService.findById.mockResolvedValue({ ...person, is_email_verified: true });
    await expect(service.confirm({ body: { token: 'raw-token' } })).resolves.toMatchObject({
      is_email_verified: true,
    });
    expect(userService.updateEmailVerified).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown, spent or expired', { consumed: null, user: person }],
    [
      'person deleted',
      {
        consumed: { user_id: 7, email: person.email },
        user: { ...person, deleted_at: new Date() },
      },
    ],
    ['person gone', { consumed: { user_id: 7, email: person.email }, user: null }],
    [
      'sent to an address the person no longer has',
      { consumed: { user_id: 7, email: 'old@example.com' }, user: person },
    ],
  ])('400 email_confirm_token_invalid — %s', async (_case, { consumed, user }) => {
    const { service, repository, userService } = buildService();
    repository.consumeIfValid.mockResolvedValue(consumed);
    userService.findById.mockResolvedValue(user);

    await expect(service.confirm({ body: { token: 'raw-token' } })).rejects.toMatchObject({
      statusCode: 400,
      reason: 'email_confirm_token_invalid',
    });
    expect(userService.updateEmailVerified).not.toHaveBeenCalled();
  });
});
