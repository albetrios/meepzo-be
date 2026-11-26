import { describe, expect, it } from 'vitest';
import {
  buildOnceKey,
  helloHasNextButton,
  organizationDayOf,
  pickVersionNumber,
  pickWordingNumber,
  questionStepOf,
  uploadPublicIdsOf,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-step.util.js';
import {
  entitlementSnapshotOf,
  planFeaturesWithSwitches,
} from '@/domains/app/__tests__/factories/entitlement.factory.js';

/** A job's entitlement snapshot holding exactly these switches (change-plan-gates AP3: `can()`). */
function entitlementWith(switches: Parameters<typeof planFeaturesWithSwitches>[0]) {
  return entitlementSnapshotOf({ features: planFeaturesWithSwitches(switches) });
}

/**
 * The run engine's step rules as pure functions (feat-instagram-dm-sending routes-final § 4.B —
 * AU22 the once key of each way to start, AU26 PRO at run time, AU27 versions and wordings).
 */

const DAY = '2026-11-24';

/** The once key of one way to start, the account's "once per person per post" switch on or off. */
function keyOf(
  triggerType: Parameters<typeof buildOnceKey>[0]['triggerType'],
  overrides: Partial<Parameters<typeof buildOnceKey>[0]> = {},
): string {
  return buildOnceKey({
    triggerType,
    isOncePerPersonPerPost: true,
    defaultReplyMode: null,
    day: DAY,
    eventId: 'E1',
    mediaId: '111',
    storyId: '222',
    adId: '333',
    tag: 'vip',
    ...overrides,
  });
}

describe('buildOnceKey (AU22, D13, D65)', () => {
  it.each([
    ['comment', '111'],
    ['ad_comment', '111'],
    ['live_comment', 'live:111'],
    ['story_reply', 'story:222'],
    ['story_mention', 'mention:222'],
    ['dm_keyword', `dm:${DAY}`],
    ['first_message', 'first'],
    ['shared_post', 'share:111'],
    ['starter_question', `starter:${DAY}`],
    ['ref_link', `ref:${DAY}`],
    ['default_reply', `default:${DAY}`],
    ['ad_message', 'ad:333'],
    ['tag_added', 'tag:vip:E1'],
    ['tag_removed', 'untag:vip:E1'],
  ] as const)('%s → %s', (triggerType, expected) => {
    expect(keyOf(triggerType)).toBe(expected);
  });

  it('"every time" (the switch off) keys by the event; first message stays once ever', () => {
    const off = { isOncePerPersonPerPost: false };
    expect(keyOf('comment', off)).toBe('111:E1');
    expect(keyOf('dm_keyword', off)).toBe('dm:E1');
    expect(keyOf('story_reply', off)).toBe('story:222:E1');
    expect(keyOf('first_message', off)).toBe('first');
  });

  it('"no other automation answered" keeps its own choice', () => {
    expect(keyOf('default_reply', { defaultReplyMode: 'every_time' })).toBe('default:E1');
  });

  it('is at most 255 characters', () => {
    expect(keyOf('tag_added', { tag: 'x'.repeat(400) })).toHaveLength(255);
  });
});

describe('the step parts (AU26, AU27)', () => {
  it('the organization day is its time zone’s', () => {
    expect(
      organizationDayOf({ at: new Date('2026-11-24T23:30:00Z'), timeZone: 'Asia/Kolkata' }),
    ).toBe('2026-11-25');
  });

  it('a version beyond 1 needs the plan’s message_versions switch', () => {
    const drawInteger = () => 1;
    expect(pickVersionNumber({ count: 3, entitlement: entitlementSnapshotOf(), drawInteger })).toBe(
      1,
    );
    expect(
      pickVersionNumber({
        count: 3,
        entitlement: entitlementWith({ message_versions: true }),
        drawInteger,
      }),
    ).toBe(2);
  });

  it('a wording is never the last one sent when there are two or more', () => {
    expect(pickWordingNumber({ count: 2, lastWordingNumber: 1, drawInteger: () => 0 })).toBe(2);
    expect(pickWordingNumber({ count: 1, lastWordingNumber: 1, drawInteger: () => 0 })).toBe(1);
  });

  it('the email ask needs its PRO switch (a move down skips it)', () => {
    const steps = { email: { on: true, wordings: ['Your email?'] } };
    expect(
      questionStepOf({ steps, part: 'email', entitlement: entitlementWith({ email_ask: false }) }),
    ).toBeNull();
    expect(
      questionStepOf({ steps, part: 'email', entitlement: entitlementWith({ email_ask: true }) }),
    ).not.toBeNull();
  });

  it('only a "sends your next step" button makes the run wait for a tap', () => {
    const link = { title: 'Open', action: 'link' as const, url: 'https://example.com' };
    expect(
      helloHasNextButton({
        steps: { hello: { on: true, versions: [{ text: 'Hi', buttons: [link] }] } },
        versionNumber: 1,
      }),
    ).toBe(false);
    expect(
      helloHasNextButton({
        steps: {
          hello: {
            on: true,
            versions: [{ text: 'Hi', buttons: [{ title: 'Go', action: 'next' }] }],
          },
        },
        versionNumber: 1,
      }),
    ).toBe(true);
  });

  it('a list message names its files by upload public id (content by reference)', () => {
    expect(uploadPublicIdsOf({ kind: 'image', wait_minutes: 0, upload_id: 'upl_abc' })).toEqual([
      'upl_abc',
    ]);
    expect(uploadPublicIdsOf({ kind: 'text', wait_minutes: 0, text: 'Hi' })).toEqual([]);
  });
});
