import { describe, expect, it } from 'vitest';
import { ValidationError } from '@/shared/errors/index.js';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import type { AutomationSteps } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import type { AutomationWritableFields } from '@/domains/app/sub-domains/automation/automation.types.js';
import {
  assertNoContentProblems,
  assertTriggerTypeGroupUnchanged,
  generateAutomationRefCode,
  listAutomationContentProblems,
  listAutomationFeatureParts,
  listAutomationProFeatures,
  listAutomationUploads,
  mergeAutomationForCreate,
  validateCreateAutomation,
  validateDeleteAutomationQuery,
  validateListAutomationsQuery,
  validatePauseAutomation,
  validateUpdateAutomation,
} from '@/domains/app/sub-domains/automation/automation.validator.js';

const CHANNEL_ACCOUNT_ID = generatePublicId('channelAccount');

/** A comment automation that passes every content check: a hello with its next button, one text. */
function completeFields(
  overrides: Partial<AutomationWritableFields> = {},
): AutomationWritableFields {
  return {
    ...mergeAutomationForCreate({
      changes: { name: 'Guide', trigger_type: 'comment', channel_account_id: CHANNEL_ACCOUNT_ID },
      isReplyLikePersonDefault: false,
    }),
    steps: {
      hello: {
        on: true,
        versions: [{ text: 'Hi {name}!', buttons: [{ title: 'Send it', action: 'next' }] }],
      },
      messages: [{ kind: 'text', wait_minutes: 0, text: 'Here is your guide' }],
    },
    ...overrides,
  };
}

/** The `field: reason` pairs of a content check. */
function problemsOf(fields: AutomationWritableFields): string[] {
  return listAutomationContentProblems(fields).map((item) => `${item.field}: ${item.reason}`);
}

describe('automation validator (feat-instagram-dm-sending § 4.A)', () => {
  describe('route 28 body — a draft needs a name, an account and a way to start (AU11, P70)', () => {
    it('accepts the three required fields and lowercases and deduplicates keywords', () => {
      const changes = validateCreateAutomation({
        name: ' Guide ',
        channel_account_id: CHANNEL_ACCOUNT_ID,
        trigger_type: 'dm_keyword',
        keywords: ['Guide', 'guide', 'Price'],
      });
      expect(changes).toMatchObject({
        name: 'Guide',
        trigger_type: 'dm_keyword',
        channel_account_id: CHANNEL_ACCOUNT_ID,
        keywords: ['guide', 'price'],
      });
    });

    it.each([
      ['no way to start', { name: 'Guide', channel_account_id: CHANNEL_ACCOUNT_ID }],
      ['no account', { name: 'Guide', trigger_type: 'comment' }],
      [
        'status (actions only)',
        {
          name: 'G',
          channel_account_id: CHANNEL_ACCOUNT_ID,
          trigger_type: 'comment',
          status: 'live',
        },
      ],
      [
        'a launch way to start',
        { name: 'G', channel_account_id: CHANNEL_ACCOUNT_ID, trigger_type: 'dm' },
      ],
      [
        'a ref code with other signs (AC-6.12)',
        {
          name: 'G',
          channel_account_id: CHANNEL_ACCOUNT_ID,
          trigger_type: 'ref_link',
          ref_code: 'spring sale!',
        },
      ],
      [
        'a ref code over 64 (AC-6.12)',
        {
          name: 'G',
          channel_account_id: CHANNEL_ACCOUNT_ID,
          trigger_type: 'ref_link',
          ref_code: 'a'.repeat(65),
        },
      ],
      [
        'an unknown step part',
        {
          name: 'G',
          channel_account_id: CHANNEL_ACCOUNT_ID,
          trigger_type: 'comment',
          steps: { greeting: {} },
        },
      ],
      [
        'an hour limit outside the list',
        {
          name: 'G',
          channel_account_id: CHANNEL_ACCOUNT_ID,
          trigger_type: 'comment',
          public_reply_hour_limit: 50,
        },
      ],
    ])('refuses %s with a 400', (_label, body) => {
      expect(() => validateCreateAutomation(body)).toThrow(ValidationError);
    });

    it('keeps a draft incomplete: empty texts and eleven messages pass the every-save level', () => {
      const steps: AutomationSteps = {
        hello: { on: true, versions: [{ text: '', buttons: [] }] },
        messages: Array.from({ length: 11 }, () => ({
          kind: 'text' as const,
          wait_minutes: 5000,
          text: '',
        })),
      };
      expect(() =>
        validateCreateAutomation({
          name: 'Draft',
          channel_account_id: CHANNEL_ACCOUNT_ID,
          trigger_type: 'comment',
          steps,
        }),
      ).not.toThrow();
    });
  });

  it('route 30 body needs one field besides expected_updated_at and never takes the account', () => {
    expect(() =>
      validateUpdateAutomation({ expected_updated_at: new Date().toISOString() }),
    ).toThrow(ValidationError);
    expect(() => validateUpdateAutomation({ channel_account_id: CHANNEL_ACCOUNT_ID })).toThrow(
      ValidationError,
    );
    expect(validateUpdateAutomation({ name: 'New' }).changes).toEqual({ name: 'New' });
  });

  it('route 27 needs the account and splits the comma lists (AU10, AC-6.2)', () => {
    expect(() => validateListAutomationsQuery({})).toThrow(ValidationError);
    expect(
      validateListAutomationsQuery({
        channel_account_id: CHANNEL_ACCOUNT_ID,
        status: 'live,paused',
        trigger_type: 'comment',
      }),
    ).toMatchObject({ statuses: ['live', 'paused'], triggerTypes: ['comment'] });
  });

  it('route 31 takes no reason, but other needs a note (AU16, P11, AC-6.18)', () => {
    expect(validateDeleteAutomationQuery({})).toEqual({ reason: null, note: null });
    expect(() => validateDeleteAutomationQuery({ reason: 'other' })).toThrow(ValidationError);
  });

  it('route 33 needs keep or cancel', () => {
    expect(validatePauseAutomation({ mode: 'cancel' })).toBe('cancel');
    expect(() => validatePauseAutomation({})).toThrow(ValidationError);
  });

  it('a way to start changes only within its group (AU12)', () => {
    expect(() =>
      assertTriggerTypeGroupUnchanged({ stored: 'comment', next: 'live_comment' }),
    ).not.toThrow();
    expect(() =>
      assertTriggerTypeGroupUnchanged({ stored: 'comment', next: 'dm_keyword' }),
    ).toThrow(ValidationError);
  });

  describe('the go-live content checks (AU13, AC-6.3, AC-6.4, AC-6.13, AC-6.14)', () => {
    it('passes a complete comment automation', () => {
      expect(problemsOf(completeFields())).toEqual([]);
    });

    it('refuses a hello without a "sends your next step" button (P2, AC-6.4)', () => {
      const fields = completeFields({
        steps: {
          hello: {
            on: true,
            versions: [
              {
                text: 'Hi',
                buttons: [{ title: 'Shop', action: 'link', url: 'https://shop.example' }],
              },
            ],
          },
          messages: [{ kind: 'text', wait_minutes: 0, text: 'Here' }],
        },
      });
      expect(problemsOf(fields)).toEqual(['steps.hello.versions.0.buttons: next_button_missing']);
    });

    it('lists every problem with its step (AC-6.3)', () => {
      const fields = completeFields({
        name: ' ',
        trigger_type: 'ref_link',
        also_start_from: ['dm'],
        steps: {
          follow: {
            on: true,
            versions: [{ text: '', profile_button_title: 'P', following_button_title: 'F' }],
          },
          email: { on: true, wordings: [] },
          messages: [],
          tags: { on: true, list: [] },
        },
      });
      expect(problemsOf(fields)).toEqual([
        'name: missing',
        'ref_code: missing',
        'also_start_from: not_allowed',
        'keywords: missing',
        'steps.follow.versions.0.text: text_invalid',
        'steps.email.wordings: count',
        'steps.messages: count',
        'steps.tags.list: count',
      ]);
    });

    it('refuses 0 or 11 messages, a wait over 23 hours and a text over 1,000 bytes (AC-6.14)', () => {
      const text = { kind: 'text' as const, wait_minutes: 0, text: 'Hi' };
      expect(
        problemsOf(completeFields({ steps: { ...completeFields().steps, messages: [] } })),
      ).toContain('steps.messages: count');
      expect(
        problemsOf(
          completeFields({ steps: { ...completeFields().steps, messages: Array(11).fill(text) } }),
        ),
      ).toContain('steps.messages: count');
      expect(
        problemsOf(
          completeFields({
            steps: { ...completeFields().steps, messages: [{ ...text, wait_minutes: 1381 }] },
          }),
        ),
      ).toEqual(['steps.messages.0.wait_minutes: wait_too_long']);
      expect(
        problemsOf(
          completeFields({
            steps: { ...completeFields().steps, messages: [{ ...text, text: 'ગ'.repeat(334) }] },
          }),
        ),
      ).toEqual(['steps.messages.0.text: text_invalid']);
    });

    it('counts the 1,000 in UTF-8 bytes: exactly 1,000 passes, 1,001 fails — emoji and ZWJ sequences included (plan §18.5)', () => {
      const emoji = '😀'; // 4 bytes, 2 UTF-16 units
      const family = '👨‍👩‍👧'; // 3 emoji + 2 zero-width joiners: 18 bytes, one picture
      expect(Buffer.byteLength(emoji, 'utf8')).toBe(4);
      expect(Buffer.byteLength(family, 'utf8')).toBe(18);
      const textProblems = (text: string) =>
        problemsOf(
          completeFields({
            steps: {
              ...completeFields().steps,
              messages: [{ kind: 'text', wait_minutes: 0, text }],
            },
          }),
        );
      // 250 emoji = 1,000 bytes (only 500 UTF-16 units — a `.length` check would pass 1,001 too).
      expect(textProblems(emoji.repeat(250))).toEqual([]);
      expect(textProblems(`a${emoji.repeat(250)}`)).toEqual([
        'steps.messages.0.text: text_invalid',
      ]);
      // 55 families (990 bytes) + 10 letters = 1,000; one letter more is over.
      expect(textProblems(`${family.repeat(55)}${'a'.repeat(10)}`)).toEqual([]);
      expect(textProblems(`${family.repeat(55)}${'a'.repeat(11)}`)).toEqual([
        'steps.messages.0.text: text_invalid',
      ]);
      // A ZWJ sequence that would cross the limit is not cut short to fit: the whole text fails.
      expect(textProblems(`${'a'.repeat(983)}${family}`)).toEqual([
        'steps.messages.0.text: text_invalid',
      ]);
      expect(textProblems(`${'a'.repeat(982)}${family}`)).toEqual([]);

      // The same byte count for a quick-replies text and an email wording.
      const withQuickReplies = (text: string) =>
        problemsOf(
          completeFields({
            steps: {
              ...completeFields().steps,
              messages: [{ kind: 'quick_replies', wait_minutes: 0, text, replies: ['Yes'] }],
            },
          }),
        );
      expect(withQuickReplies(emoji.repeat(250))).toEqual([]);
      expect(withQuickReplies(`${emoji.repeat(250)}a`)).toEqual([
        'steps.messages.0.text: text_invalid',
      ]);
      const withEmailWording = (wording: string) =>
        problemsOf(
          completeFields({
            steps: { ...completeFields().steps, email: { on: true, wordings: [wording] } },
          }),
        );
      expect(withEmailWording(`${family.repeat(55)}${'a'.repeat(10)}`)).toEqual([]);
      expect(withEmailWording(`${family.repeat(55)}${'a'.repeat(11)}`)).toEqual([
        'steps.email.wordings.0: text_invalid',
      ]);
    });

    it('a comment start without a hello sends one plain text only (check 12)', () => {
      const withoutHello = completeFields({
        steps: {
          messages: [
            { kind: 'text', wait_minutes: 0, text: 'One' },
            { kind: 'text', wait_minutes: 0, text: 'Two' },
          ],
        },
      });
      expect(problemsOf(withoutHello)).toEqual(['steps.hello.on: comment_needs_hello']);
      expect(
        problemsOf(
          completeFields({ steps: { messages: [{ kind: 'text', wait_minutes: 0, text: 'One' }] } }),
        ),
      ).toEqual([]);
    });

    it('"Reply like a person" needs 3 lines (AC-6.13)', () => {
      const fields = completeFields({
        is_public_reply_enabled: true,
        is_reply_like_person_enabled: true,
        public_reply_texts: ['One', 'Two'],
      });
      expect(problemsOf(fields)).toEqual(['public_reply_texts: reply_lines_too_few']);
      expect(problemsOf({ ...fields, public_reply_texts: ['One', 'Two', 'Three'] })).toEqual([]);
    });

    it('the way to start needs its own field and listens only where it may (check 6)', () => {
      expect(
        problemsOf(
          completeFields({
            trigger_type: 'tag_added',
            steps: { messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }] },
          }),
        ),
      ).toEqual(['trigger_tag: missing']);
      expect(problemsOf(completeFields({ target_scope: 'specific' }))).toContain(
        'target_instagram_media_id: missing',
      );
      expect(
        problemsOf(completeFields({ trigger_type: 'live_comment', target_scope: 'next' })),
      ).toContain('target_scope: target_scope_not_allowed');
      expect(
        problemsOf(
          completeFields({
            trigger_type: 'tag_added',
            trigger_tag: 'vip',
            steps: {
              messages: [{ kind: 'text', wait_minutes: 0, text: 'Hi' }],
              tags: { on: true, list: ['vip'] },
            },
          }),
        ),
      ).toEqual(['steps.tags.list: trigger_tag_in_tags']);
    });

    it('throws a 400 with the body path of each problem (AU12)', () => {
      const problems = listAutomationContentProblems(completeFields({ name: ' ' }));
      try {
        assertNoContentProblems(problems);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).errors?.[0]).toMatchObject({
          field: 'body.name',
          reason: 'missing',
        });
      }
    });
  });

  it('names the PRO parts and every feature-check part (AU4, AU34, AC-6.7)', () => {
    const fields = completeFields({
      is_public_reply_enabled: true,
      is_reply_like_person_enabled: true,
      public_reply_texts: ['A', 'B', 'C'],
      steps: {
        ...completeFields().steps,
        email: { on: true, wordings: ['Your email?'] },
        messages: [
          { kind: 'cards', wait_minutes: 0, cards: [{ title: 'T', subtitle: 'S' }] },
          { kind: 'file', wait_minutes: 0, upload_id: generatePublicId('upload') },
        ],
      },
    });
    expect(listAutomationProFeatures(fields)).toEqual([
      'email_ask',
      'reply_like_person',
      'multiple_public_reply_lines',
    ]);
    expect(listAutomationFeatureParts(fields)).toMatchObject({
      triggerType: 'comment',
      steps: ['messages', 'hello', 'email', 'public_reply'],
      messageKinds: ['cards', 'file'],
    });
    expect(listAutomationUploads(fields.steps)).toHaveLength(1);
  });

  it('a free ref code keeps its base and adds a tail within 64 characters (AU15)', () => {
    const code = generateAutomationRefCode('x'.repeat(64));
    expect(code).toMatch(/^x{59}-[A-Za-z0-9]{4}$/);
    expect(generateAutomationRefCode(null)).toMatch(/^link-[A-Za-z0-9]{4}$/);
  });
});
