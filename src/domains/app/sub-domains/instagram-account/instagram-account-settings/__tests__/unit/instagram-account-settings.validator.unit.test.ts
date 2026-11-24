import { describe, expect, it } from 'vitest';
import {
  assertMergedSettingsValid,
  type InstagramAccountSettingsMergeable,
  validateUpdateInstagramAccountSettings,
} from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.validator.js';
import type { InstagramAccountSettingsChanges } from '@/domains/app/sub-domains/instagram-account/instagram-account-settings/instagram-account-settings.types.js';
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

/** The merged columns of a row as the pick leaves it — everything empty. */
const EMPTY_SAVED: InstagramAccountSettingsMergeable = {
  opening_hour_limit: null,
  opening_day_limit: null,
  extra_delay_seconds_min: null,
  extra_delay_seconds_max: null,
};

/**
 * Route 12's body (feat-instagram-dm-sending routes-final § 2.B.8–2.B.9, IA12, IA13): every range
 * edge, null clears, whole numbers only, the stop words' rules, at least one field, unknown fields
 * (the five public-reply ones included) refused — and the merged extra-delay and day-limit checks.
 */
describe('validateUpdateInstagramAccountSettings', () => {
  it('accepts every field with an expected_updated_at, and lower-cases and trims the stop words', () => {
    const body = {
      is_automation_enabled: false,
      opening_hour_limit: 700,
      opening_day_limit: 1400,
      fast_hour_limit: 20_000,
      person_hour_limit: 5,
      broadcast_hour_limit: 2000,
      is_automatic_notice_enabled: true,
      extra_stop_words: [' Band Karo ', 'PARAR'],
      is_comment_reply_trigger_enabled: false,
      is_once_per_person_per_post_enabled: false,
      is_mark_seen_after_reply_enabled: true,
      extra_delay_seconds_min: 1,
      extra_delay_seconds_max: 20,
      expected_updated_at: '2026-11-21T09:00:00.000Z',
    };
    expect(validateUpdateInstagramAccountSettings(body)).toEqual({
      ...body,
      extra_stop_words: ['band karo', 'parar'],
    });
  });

  it('accepts null for every limit — back to the settings file', () => {
    const body = {
      opening_hour_limit: null,
      opening_day_limit: null,
      fast_hour_limit: null,
      person_hour_limit: null,
      broadcast_hour_limit: null,
      extra_delay_seconds_min: null,
      extra_delay_seconds_max: null,
    };
    expect(validateUpdateInstagramAccountSettings(body)).toEqual(body);
  });

  it.each([
    ['opening_hour_limit', 0],
    ['opening_hour_limit', 701],
    ['opening_day_limit', 0],
    ['fast_hour_limit', 0],
    ['fast_hour_limit', 20_001],
    ['person_hour_limit', 4],
    ['person_hour_limit', 101],
    ['broadcast_hour_limit', 0],
    ['broadcast_hour_limit', 2001],
    ['extra_delay_seconds_min', 0],
    ['extra_delay_seconds_max', 21],
  ])('refuses %s just past its edge (%d) on that field', (field, value) => {
    expect(refusedFields({ [field]: value })).toEqual([field]);
  });

  it.each([
    ['opening_hour_limit', 80.5],
    ['fast_hour_limit', '60'],
    ['is_automation_enabled', 'false'],
    ['is_mark_seen_after_reply_enabled', 1],
    ['extra_stop_words', 'stop'],
  ])('refuses %s that is not the right type (%s)', (field, value) => {
    expect(refusedFields({ [field]: value })).toEqual([field]);
  });

  it.each([
    'is_public_reply_safety_enabled',
    'public_reply_chance_percent',
    'public_reply_hour_limit',
    'public_reply_gap_min_seconds',
    'public_reply_gap_max_seconds',
  ])('refuses the removed public-reply field %s (AC-3.9)', (field) => {
    expect(() => validateUpdateInstagramAccountSettings({ [field]: 1 })).toThrow(ValidationError);
  });

  it.each([
    ['an empty word', ['  ']],
    ['a word over 50 characters', ['a'.repeat(51)]],
    ['a repeat once lower-cased', ['Stop', ' stop']],
    ['more than 50 words', Array.from({ length: 51 }, (_, index) => `word ${index}`)],
  ])('refuses extra_stop_words with %s', (_case, words) => {
    expect(() => validateUpdateInstagramAccountSettings({ extra_stop_words: words })).toThrow(
      ValidationError,
    );
  });

  it('accepts an empty stop-word list (clears them) and 50 words', () => {
    expect(validateUpdateInstagramAccountSettings({ extra_stop_words: [] })).toEqual({
      extra_stop_words: [],
    });
    const fifty = Array.from({ length: 50 }, (_, index) => `word ${index}`);
    expect(validateUpdateInstagramAccountSettings({ extra_stop_words: fifty })).toEqual({
      extra_stop_words: fifty,
    });
  });

  it('refuses an empty body, expected_updated_at alone, and a body that is not an object', () => {
    expect(() => validateUpdateInstagramAccountSettings({})).toThrow(ValidationError);
    expect(() =>
      validateUpdateInstagramAccountSettings({ expected_updated_at: '2026-11-21T09:00:00.000Z' }),
    ).toThrow(ValidationError);
    expect(() => validateUpdateInstagramAccountSettings(null)).toThrow(ValidationError);
  });
});

describe('assertMergedSettingsValid', () => {
  function refusedMergedField({
    saved = EMPTY_SAVED,
    changes,
  }: {
    saved?: InstagramAccountSettingsMergeable;
    changes: InstagramAccountSettingsChanges;
  }): string[] | undefined {
    try {
      assertMergedSettingsValid({ saved, changes });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      return (error as ValidationError).errors?.map((item) => item.field);
    }
    return undefined;
  }

  it('passes both delay ends together, equal ends, and a change that sends neither', () => {
    expect(
      refusedMergedField({ changes: { extra_delay_seconds_min: 3, extra_delay_seconds_max: 3 } }),
    ).toBeUndefined();
    expect(refusedMergedField({ changes: {} })).toBeUndefined();
  });

  it('refuses one delay end alone, on the missing end', () => {
    expect(refusedMergedField({ changes: { extra_delay_seconds_min: 3 } })).toEqual([
      'body.extra_delay_seconds_max',
    ]);
    expect(
      refusedMergedField({
        saved: { ...EMPTY_SAVED, extra_delay_seconds_min: 2, extra_delay_seconds_max: 5 },
        changes: { extra_delay_seconds_min: null },
      }),
    ).toEqual(['body.extra_delay_seconds_min']);
  });

  it('refuses the merged minimum above the maximum, on extra_delay_seconds_max', () => {
    expect(
      refusedMergedField({
        saved: { ...EMPTY_SAVED, extra_delay_seconds_min: 2, extra_delay_seconds_max: 5 },
        changes: { extra_delay_seconds_min: 6 },
      }),
    ).toEqual(['body.extra_delay_seconds_max']);
  });

  it('passes clearing both delay ends', () => {
    expect(
      refusedMergedField({
        saved: { ...EMPTY_SAVED, extra_delay_seconds_min: 2, extra_delay_seconds_max: 5 },
        changes: { extra_delay_seconds_min: null, extra_delay_seconds_max: null },
      }),
    ).toBeUndefined();
  });

  it('checks the day limit against the merged hour limit (the default 600 when empty)', () => {
    expect(refusedMergedField({ changes: { opening_day_limit: 600 } })).toBeUndefined();
    expect(refusedMergedField({ changes: { opening_day_limit: 14_400 } })).toBeUndefined();
    expect(refusedMergedField({ changes: { opening_day_limit: 599 } })).toEqual([
      'body.opening_day_limit',
    ]);
    expect(
      refusedMergedField({
        saved: { ...EMPTY_SAVED, opening_day_limit: 1000 },
        changes: { opening_hour_limit: 41 },
      }),
    ).toEqual(['body.opening_day_limit']);
    expect(
      refusedMergedField({
        saved: { ...EMPTY_SAVED, opening_day_limit: 1000 },
        changes: { opening_day_limit: null, opening_hour_limit: 1 },
      }),
    ).toBeUndefined();
  });
});
