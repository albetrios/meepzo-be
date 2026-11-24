import { describe, expect, it } from 'vitest';
import { serializeNotificationPreferences } from '@/domains/user/sub-domains/user-notification-preferences/user-notification-preferences.serializer.js';

function channelOf(
  output: ReturnType<typeof serializeNotificationPreferences>,
  kind: string,
  channel: string,
) {
  return output.kinds
    .find((entry) => entry.kind === kind)
    ?.channels.find((entry) => entry.channel === channel);
}

describe('serializeNotificationPreferences (route 135, UN9, UN10)', () => {
  it('answers the seven kinds in the screen order, each with EMAIL, IN_APP, WEB_PUSH', () => {
    const output = serializeNotificationPreferences([]);
    expect(output.kinds.map((entry) => entry.kind)).toEqual([
      'automation_problem',
      'direct_message_limit',
      'contact_details_left',
      'team_change',
      'billing',
      'weekly_summary',
      'broadcast_or_past_comments_done',
    ]);
    for (const entry of output.kinds) {
      expect(entry.channels.map((channel) => channel.channel)).toEqual([
        'EMAIL',
        'IN_APP',
        'WEB_PUSH',
      ]);
    }
  });

  it('with no rows answers the defaults (AC-14.5): email off for contact details and broadcast/past comments, in-app off for the weekly summary, push off', () => {
    const output = serializeNotificationPreferences([]);
    expect(channelOf(output, 'contact_details_left', 'EMAIL')).toEqual({
      channel: 'EMAIL',
      is_enabled: false,
      is_default: true,
      is_locked: false,
    });
    expect(channelOf(output, 'broadcast_or_past_comments_done', 'EMAIL')?.is_enabled).toBe(false);
    expect(channelOf(output, 'weekly_summary', 'IN_APP')?.is_enabled).toBe(false);
    expect(channelOf(output, 'automation_problem', 'EMAIL')?.is_enabled).toBe(true);
    expect(channelOf(output, 'team_change', 'WEB_PUSH')?.is_enabled).toBe(false);
    expect(channelOf(output, 'billing', 'EMAIL')).toEqual({
      channel: 'EMAIL',
      is_enabled: true,
      is_default: true,
      is_locked: true,
    });
  });

  it('a stored row replaces the default; billing email stays on whatever a row says', () => {
    const output = serializeNotificationPreferences([
      { notification_type: 'contact.details_left', channel: 'EMAIL', is_enabled: true },
      { notification_type: 'billing.payment_failed', channel: 'EMAIL', is_enabled: false },
    ]);
    expect(channelOf(output, 'contact_details_left', 'EMAIL')).toMatchObject({
      is_enabled: true,
      is_default: false,
    });
    expect(channelOf(output, 'billing', 'EMAIL')).toMatchObject({
      is_enabled: true,
      is_locked: true,
    });
  });

  it('a kind is on only while every stored row of its types is on', () => {
    const output = serializeNotificationPreferences([
      { notification_type: 'broadcast.done', channel: 'IN_APP', is_enabled: true },
      { notification_type: 'automation.backfill_done', channel: 'IN_APP', is_enabled: false },
    ]);
    expect(channelOf(output, 'broadcast_or_past_comments_done', 'IN_APP')?.is_enabled).toBe(false);
  });

  it('ignores rows of a type in no kind and of SMS, and never exposes a row id', () => {
    const output = serializeNotificationPreferences([
      { notification_type: 'security.alert', channel: 'EMAIL', is_enabled: false },
      { notification_type: 'broadcast.done', channel: 'SMS', is_enabled: true },
    ]);
    expect(JSON.stringify(output)).not.toContain('security.alert');
    expect(JSON.stringify(output)).not.toContain('"id"');
  });
});
