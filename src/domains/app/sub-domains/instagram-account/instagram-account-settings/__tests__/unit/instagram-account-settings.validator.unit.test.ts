import { describe, expect, it } from 'vitest';
import {
  assertPublicReplyGapOrder,
  validateUpdateInstagramAccountSettings,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.validator.js';
import { ValidationError } from '@/shared/errors/index.js';

/** The field names a refused body's `ValidationError` reports. */
function refusedFields(body: unknown): string[] {
  try {
    validateUpdateInstagramAccountSettings(body);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).errors?.map((item) => item.field) ?? [];
  }
  throw new Error('a ValidationError was expected');
}

/** The settings as connect saves them (1.B.3 defaults). */
const DEFAULT_GAPS = { public_reply_gap_min_seconds: 20, public_reply_gap_max_seconds: 60 };

/**
 * Route 3's body (routes-final § 1.B.8–1.B.9, IA15): every range edge, whole numbers only, at
 * least one setting, unknown fields refused, `expected_updated_at` optional — and the merged
 * minimum ≤ maximum gap check.
 */
describe('validateUpdateInstagramAccountSettings', () => {
  it('accepts all six settings with an expected_updated_at', () => {
    const body = {
      is_automation_enabled: false,
      is_public_reply_safety_enabled: true,
      public_reply_chance_percent: 50,
      public_reply_hour_limit: 30,
      public_reply_gap_min_seconds: 10,
      public_reply_gap_max_seconds: 120,
      expected_updated_at: '2026-11-21T09:00:00.000Z',
    };
    expect(validateUpdateInstagramAccountSettings(body)).toEqual(body);
  });

  it('accepts one setting alone and leaves the others out', () => {
    expect(validateUpdateInstagramAccountSettings({ is_automation_enabled: false })).toEqual({
      is_automation_enabled: false,
    });
  });

  it.each([
    ['public_reply_chance_percent', 0],
    ['public_reply_chance_percent', 100],
    ['public_reply_hour_limit', 1],
    ['public_reply_hour_limit', 1000],
    ['public_reply_gap_min_seconds', 5],
    ['public_reply_gap_min_seconds', 3600],
    ['public_reply_gap_max_seconds', 5],
    ['public_reply_gap_max_seconds', 3600],
  ])('accepts %s at its edge %d', (field, value) => {
    expect(validateUpdateInstagramAccountSettings({ [field]: value })).toEqual({ [field]: value });
  });

  it.each([
    ['public_reply_chance_percent', -1],
    ['public_reply_chance_percent', 101],
    ['public_reply_hour_limit', 0],
    ['public_reply_hour_limit', 1001],
    ['public_reply_gap_min_seconds', 4],
    ['public_reply_gap_min_seconds', 3601],
    ['public_reply_gap_max_seconds', 4],
    ['public_reply_gap_max_seconds', 3601],
  ])('refuses %s just past its edge (%d) on that field', (field, value) => {
    expect(refusedFields({ [field]: value })).toEqual([field]);
  });

  it.each([
    ['public_reply_chance_percent', 80.5],
    ['public_reply_hour_limit', '60'],
    ['public_reply_gap_min_seconds', null],
    ['is_automation_enabled', 'false'],
    ['is_public_reply_safety_enabled', 1],
  ])('refuses %s that is not the right type (%s)', (field, value) => {
    expect(refusedFields({ [field]: value })).toEqual([field]);
  });

  it('refuses an empty body', () => {
    expect(() => validateUpdateInstagramAccountSettings({})).toThrow(ValidationError);
  });

  it('refuses expected_updated_at alone — it is not a change', () => {
    expect(() =>
      validateUpdateInstagramAccountSettings({ expected_updated_at: '2026-11-21T09:00:00.000Z' }),
    ).toThrow(ValidationError);
  });

  it('refuses an expected_updated_at that is not an ISO 8601 instant', () => {
    expect(
      refusedFields({ is_automation_enabled: true, expected_updated_at: 'yesterday' }),
    ).toEqual(['expected_updated_at']);
  });

  it('refuses an unknown field, even beside a valid setting', () => {
    expect(() =>
      validateUpdateInstagramAccountSettings({ is_automation_enabled: true, reply_text: 'Hi' }),
    ).toThrow(ValidationError);
  });

  it('refuses a body that is not an object', () => {
    expect(() => validateUpdateInstagramAccountSettings(null)).toThrow(ValidationError);
  });
});

describe('assertPublicReplyGapOrder', () => {
  function refusedGapField(changes: Parameters<typeof assertPublicReplyGapOrder>[0]['changes']) {
    try {
      assertPublicReplyGapOrder({ saved: DEFAULT_GAPS, changes });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as ValidationError).errors?.map((item) => item.field);
    }
    return undefined;
  }

  it('passes a minimum equal to the maximum', () => {
    expect(refusedGapField({ public_reply_gap_min_seconds: 60 })).toBeUndefined();
    expect(
      refusedGapField({ public_reply_gap_min_seconds: 30, public_reply_gap_max_seconds: 30 }),
    ).toBeUndefined();
  });

  it('passes a change that sends neither end', () => {
    expect(refusedGapField({})).toBeUndefined();
  });

  it('refuses min > max sent together, on public_reply_gap_max_seconds', () => {
    expect(
      refusedGapField({ public_reply_gap_min_seconds: 100, public_reply_gap_max_seconds: 50 }),
    ).toEqual(['body.public_reply_gap_max_seconds']);
  });

  it('refuses a minimum above the saved maximum, on public_reply_gap_max_seconds', () => {
    expect(refusedGapField({ public_reply_gap_min_seconds: 61 })).toEqual([
      'body.public_reply_gap_max_seconds',
    ]);
  });

  it('refuses a maximum below the saved minimum', () => {
    expect(refusedGapField({ public_reply_gap_max_seconds: 19 })).toEqual([
      'body.public_reply_gap_max_seconds',
    ]);
  });

  it('judges the merged result: a wider pair passes even when one end alone would not', () => {
    expect(
      refusedGapField({ public_reply_gap_min_seconds: 300, public_reply_gap_max_seconds: 600 }),
    ).toBeUndefined();
  });
});
