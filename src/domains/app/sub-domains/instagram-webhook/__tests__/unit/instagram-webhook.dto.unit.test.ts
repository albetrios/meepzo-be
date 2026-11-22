import { describe, expect, it } from 'vitest';
import {
  InstagramWebhookDeliveryDto,
  InstagramWebhookEntryDto,
  InstagramWebhookSubscriptionQueryDto,
} from '@/domains/app/sub-domains/instagram-webhook/instagram-webhook.dto.js';

/**
 * The Instagram webhook's DTOs (routes-final § 4.A.8): route 16's `hub.*` query, and the delivery
 * and entry shapes the receiver parses only after the signature passed (WH8, WH10).
 */

const VALID_QUERY = {
  'hub.mode': 'subscribe',
  'hub.verify_token': 'a-verify-token',
  'hub.challenge': '1158201444',
};

describe('InstagramWebhookSubscriptionQueryDto (route 16)', () => {
  it('accepts the three hub.* parameters', () => {
    expect(InstagramWebhookSubscriptionQueryDto.parse(VALID_QUERY)).toEqual(VALID_QUERY);
  });

  it('ignores other parameters Meta adds — not strict', () => {
    const parsed = InstagramWebhookSubscriptionQueryDto.safeParse({
      ...VALID_QUERY,
      'hub.topic': 'instagram',
    });
    expect(parsed.success).toBe(true);
  });

  it.each(['hub.mode', 'hub.verify_token', 'hub.challenge'])('refuses a missing %s', (key) => {
    const query: Record<string, string> = { ...VALID_QUERY };
    delete query[key];
    expect(InstagramWebhookSubscriptionQueryDto.safeParse(query).success).toBe(false);
  });

  it('accepts a 256-character challenge and refuses 257', () => {
    expect(
      InstagramWebhookSubscriptionQueryDto.safeParse({
        ...VALID_QUERY,
        'hub.challenge': 'c'.repeat(256),
      }).success,
    ).toBe(true);
    expect(
      InstagramWebhookSubscriptionQueryDto.safeParse({
        ...VALID_QUERY,
        'hub.challenge': 'c'.repeat(257),
      }).success,
    ).toBe(false);
  });

  it.each(['', 'has space', 'tab\there'])(
    'refuses the challenge %j (empty or with spaces)',
    (challenge) => {
      expect(
        InstagramWebhookSubscriptionQueryDto.safeParse({
          ...VALID_QUERY,
          'hub.challenge': challenge,
        }).success,
      ).toBe(false);
    },
  );

  it('leaves the mode and the token to the service — any non-empty value parses', () => {
    expect(
      InstagramWebhookSubscriptionQueryDto.safeParse({
        ...VALID_QUERY,
        'hub.mode': 'unsubscribe',
        'hub.verify_token': 'wrong',
      }).success,
    ).toBe(true);
  });
});

describe('InstagramWebhookDeliveryDto (route 17 body, parsed after the signature)', () => {
  it('reads object and entry[], keeping unknown Meta fields', () => {
    const body = { object: 'instagram', entry: [{ id: '1', time: 1 }], extra: true };
    expect(InstagramWebhookDeliveryDto.parse(body)).toEqual(body);
  });

  it.each([
    ['no object', { entry: [] }],
    ['entry not a list', { object: 'instagram', entry: {} }],
    ['no entry', { object: 'instagram' }],
    ['not an object', 'OK'],
    ['nothing (a signed body that was not JSON)', undefined],
  ])('does not read %s', (_label, body) => {
    expect(InstagramWebhookDeliveryDto.safeParse(body).success).toBe(false);
  });
});

describe('InstagramWebhookEntryDto (one entry[] item)', () => {
  it('reads id, time, changes[] and messaging[], keeping unknown Meta fields', () => {
    const entry = {
      id: '17841400000000001',
      time: 1_763_726_400,
      changes: [{ field: 'comments', value: {} }],
      messaging: [{ message: { mid: 'm' } }],
      unknown_field: 'kept',
    };
    expect(InstagramWebhookEntryDto.parse(entry)).toEqual(entry);
  });

  it('accepts an entry without id — the receiver drops it with a log line, not the delivery', () => {
    expect(InstagramWebhookEntryDto.safeParse({ changes: [] }).success).toBe(true);
  });

  it('does not read an entry whose changes or messaging is not a list', () => {
    expect(InstagramWebhookEntryDto.safeParse({ id: '1', changes: {} }).success).toBe(false);
    expect(InstagramWebhookEntryDto.safeParse({ id: '1', messaging: 'x' }).success).toBe(false);
    expect(InstagramWebhookEntryDto.safeParse('entry').success).toBe(false);
  });
});
