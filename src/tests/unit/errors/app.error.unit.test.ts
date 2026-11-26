import { describe, expect, it } from 'vitest';
import {
  AppError,
  APP_ERROR_FIELD_KINDS,
  APP_ERROR_FIELD_NAMES,
  ERROR_CODE_TO_SNAKE,
} from '@/shared/errors/app.error.js';

describe('AppError', () => {
  it('maps error codes to snake_case API codes', () => {
    expect(ERROR_CODE_TO_SNAKE.NOT_FOUND).toBe('not_found');
    expect(ERROR_CODE_TO_SNAKE.VALIDATION_ERROR).toBe('invalid_field');
    expect(ERROR_CODE_TO_SNAKE.RATE_LIMITED).toBe('rate_limited');
  });

  it('stores code, status, messageKey, and messageParams', () => {
    const error = new AppError(
      'FORBIDDEN',
      403,
      'errors:forbidden',
      { action: 'delete' },
      'Forbidden',
    );
    expect(error.code).toBe('FORBIDDEN');
    expect(error.statusCode).toBe(403);
    expect(error.messageKey).toBe('errors:forbidden');
    expect(error.messageParams).toEqual({ action: 'delete' });
    expect(error.message).toBe('Forbidden');
    expect(error.name).toBe('AppError');
  });

  it('uses messageKey as fallback message when fallback omitted', () => {
    const error = new AppError('INTERNAL_ERROR', 500, 'errors:internal');
    expect(error.message).toBe('errors:internal');
  });

  it('AT3 + P269: the extra error-body fields and their kinds are pinned', () => {
    // A new field is an API contract change (docs/reference/api/response-codes.md › Error body shape).
    expect(APP_ERROR_FIELD_KINDS).toEqual({
      tries_left: 'integer',
      retry_after_seconds: 'integer',
      feature: 'string',
      limit: 'integer',
      used: 'integer',
      grace_ends_at: 'timestamp_or_null',
      upgrade_required: 'boolean',
      resets_on: 'date',
    });
    expect([...APP_ERROR_FIELD_NAMES]).toEqual(Object.keys(APP_ERROR_FIELD_KINDS));
  });

  it('P269: withFields carries the plan refusal fields', () => {
    const error = new AppError('CONFLICT', 409, 'errors:planAccountLimit')
      .withFields({ limit: 3, used: 3 })
      .withFields({ upgrade_required: true, feature: 'broadcasts', grace_ends_at: null });
    expect(error.fields).toEqual({
      limit: 3,
      used: 3,
      upgrade_required: true,
      feature: 'broadcasts',
      grace_ends_at: null,
    });
  });

  it('withFields merges the fields fluently', () => {
    const error = new AppError('UNAUTHORIZED', 401, 'errors:emailCodeWrong')
      .withFields({ tries_left: 3 })
      .withFields({ retry_after_seconds: 9 });
    expect(error.fields).toEqual({ tries_left: 3, retry_after_seconds: 9 });
  });
});
