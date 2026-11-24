import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { validatePutUserNotificationPreferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.validator.js';
import { NOTIFICATION_KINDS } from '@/shared/constants/index.js';

describe('user-notification-preferences.validator (route 136, UN10)', () => {
  it('accepts kind × channel items', () => {
    const input = {
      kinds: [
        { kind: 'contact_details_left', channel: 'EMAIL', is_enabled: true },
        { kind: 'weekly_summary', channel: 'WEB_PUSH', is_enabled: false },
      ],
    };
    expect(validatePutUserNotificationPreferences(input)).toEqual(input);
  });

  it('accepts all 21 items (7 kinds × 3 channels)', () => {
    const kinds = NOTIFICATION_KINDS.flatMap((definition) =>
      (['EMAIL', 'IN_APP', 'WEB_PUSH'] as const).map((channel) => ({
        kind: definition.kind,
        channel,
        is_enabled: true,
      })),
    );
    expect(kinds).toHaveLength(21);
    expect(validatePutUserNotificationPreferences({ kinds }).kinds).toHaveLength(21);
  });

  it.each([
    ['an empty list', { kinds: [] }],
    [
      'over 21 items',
      {
        kinds: Array.from({ length: 22 }, () => ({
          kind: 'billing',
          channel: 'IN_APP',
          is_enabled: true,
        })),
      },
    ],
    [
      'a repeated kind × channel',
      {
        kinds: [
          { kind: 'billing', channel: 'IN_APP', is_enabled: true },
          { kind: 'billing', channel: 'IN_APP', is_enabled: false },
        ],
      },
    ],
    ['an unknown kind', { kinds: [{ kind: 'security', channel: 'EMAIL', is_enabled: false }] }],
    ['the SMS channel', { kinds: [{ kind: 'billing', channel: 'SMS', is_enabled: true }] }],
    [
      'the old per-type body',
      {
        preferences: [{ notification_type: 'broadcast.done', channel: 'EMAIL', is_enabled: true }],
      },
    ],
  ])('refuses %s with a ValidationError (400)', (_label, body) => {
    expect(() => validatePutUserNotificationPreferences(body)).toThrow(ValidationError);
  });
});
