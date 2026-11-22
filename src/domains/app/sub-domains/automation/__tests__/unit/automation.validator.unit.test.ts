import { describe, expect, it } from 'vitest';
import { ConflictError, ValidationError } from '@/shared/errors/index.js';
import {
  assertNextPostLinkUnchanged,
  mergeAutomationForCreate,
  mergeAutomationForUpdate,
  resolveNextPostState,
  validateAutomationFlow,
  validateCreateAutomation,
  validateDeleteAutomationQuery,
  validateListAutomationsQuery,
  validateUpdateAutomation,
} from '@/domains/app/sub-domains/automation/automation.validator.js';
import type {
  AutomationStoredNextPost,
  AutomationWritableFields,
} from '@/domains/app/sub-domains/automation/automation.types.js';

/**
 * The automation's body and query parsers and the one flow rule set (routes-final § 3.A — AU7–AU9,
 * AU11, AU12, AU27, AQ2, AQ6): every shape rule of the DTOs, every cross-field rule of
 * `validateAutomationFlow` on the merged automation, the "next post" window rules against a fixed
 * clock, the linked-window lock and the next-post state a save gives.
 */

const NOW = new Date('2026-11-21T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR);

const FINAL_MESSAGE = { text: 'Here you go', links: [] };

/** A complete comment automation (the opening message with its button). */
function commentAutomation(
  overrides: Partial<AutomationWritableFields> = {},
): AutomationWritableFields {
  return mergeAutomationForCreate({
    name: 'Comment for the link',
    trigger_type: 'comment',
    opening_message: { text: 'Thanks!', button_title: 'Send it' },
    final_message: FINAL_MESSAGE,
    ...overrides,
  });
}

/** The `errors[]` of a ValidationError thrown by `run`, as `field → messageKey`. */
function flowErrors(run: () => void): Record<string, string | undefined> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return Object.fromEntries(
      ((error as ValidationError).errors ?? []).map((item) => [item.field, item.messageKey]),
    );
  }
  throw new Error('expected a ValidationError');
}

/** Runs the flow rules on a create (no stored row). */
function checkCreate(automation: AutomationWritableFields, isMediaIdSent = false): void {
  validateAutomationFlow({ automation, stored: null, isMediaIdSent, now: NOW });
}

/** The fields of a ValidationError thrown by a parser. */
function parserFields(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return ((error as ValidationError).errors ?? []).map((item) => item.field);
  }
  throw new Error('expected a ValidationError');
}

describe('validateCreateAutomation (route 12 body)', () => {
  const minimal = { name: 'Price reply', trigger_type: 'dm', final_message: FINAL_MESSAGE };

  it('accepts the three required fields and normalises keywords, tags and messages (AU7)', () => {
    const changes = validateCreateAutomation({
      ...minimal,
      keywords: ['  Price ', 'PRICE', 'cost'],
      tags: [' vip ', 'vip', 'launch'],
      opening_message: { text: ' Hi! ' },
      final_message: { text: 'Bye' },
      next_post_starts_at: '2026-11-22T00:00:00+05:30',
    });
    expect(changes.keywords).toEqual(['price', 'cost']);
    expect(changes.tags).toEqual(['vip', 'launch']);
    expect(changes.opening_message).toEqual({ text: 'Hi!', button_title: null });
    expect(changes.final_message).toEqual({ text: 'Bye', links: [] });
    expect(changes.next_post_starts_at).toEqual(new Date('2026-11-21T18:30:00.000Z'));
    expect(changes).not.toHaveProperty('status');
  });

  it('requires name, trigger_type and final_message — final_message never null (D19)', () => {
    expect(parserFields(() => validateCreateAutomation({}))).toEqual(
      expect.arrayContaining(['name', 'trigger_type', 'final_message']),
    );
    expect(
      parserFields(() => validateCreateAutomation({ ...minimal, final_message: null })),
    ).toEqual(['final_message']);
  });

  it('refuses the read-only fields as unknown keys — the account included (AU7, AU27)', () => {
    for (const readOnlyField of [
      'instagram_account_id',
      'completed_run_count',
      'last_triggered_at',
      'next_post_status',
      'next_post_linked_at',
      'created_by_user_id',
      'id',
    ]) {
      expect(() => validateCreateAutomation({ ...minimal, [readOnlyField]: 'x' })).toThrow(
        ValidationError,
      );
    }
  });

  it('refuses an unknown key inside a message object (strict, schema-routes § 10)', () => {
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          opening_message: { text: 'Hi', button_title: 'Go', color: 'red' },
        }),
      ),
    ).toEqual(['opening_message']);
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          final_message: {
            text: 'Bye',
            links: [{ title: 'Shop', url: 'https://a.example', x: 1 }],
          },
        }),
      ),
    ).toEqual(['final_message']);
  });

  it('checks the message lengths, the link count and https links', () => {
    const tooLong = 'a'.repeat(1001);
    expect(
      parserFields(() =>
        validateCreateAutomation({ ...minimal, final_message: { text: tooLong } }),
      ),
    ).toEqual(['final_message']);
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          opening_message: { text: 'Hi', button_title: 'b'.repeat(21) },
        }),
      ),
    ).toEqual(['opening_message']);
    const link = { title: 'Shop', url: 'https://shop.example.com' };
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          final_message: { text: 'Bye', links: [link, link, link, link] },
        }),
      ),
    ).toEqual(['final_message']);
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          final_message: {
            text: 'Bye',
            links: [{ title: 'Shop', url: 'http://shop.example.com' }],
          },
        }),
      ),
    ).toEqual(['final_message']);
  });

  it('checks the keyword, tag and public reply limits and the Instagram id digits', () => {
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          keywords: Array.from({ length: 51 }, (_, i) => `k${i}`),
        }),
      ),
    ).toEqual(['keywords']);
    expect(
      parserFields(() => validateCreateAutomation({ ...minimal, keywords: ['k'.repeat(101)] })),
    ).toEqual(['keywords']);
    expect(
      parserFields(() =>
        validateCreateAutomation({
          ...minimal,
          tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
        }),
      ),
    ).toEqual(['tags']);
    expect(
      parserFields(() => validateCreateAutomation({ ...minimal, tags: ['t'.repeat(51)] })),
    ).toEqual(['tags']);
    expect(
      parserFields(() =>
        validateCreateAutomation({ ...minimal, public_reply_texts: ['r'.repeat(301)] }),
      ),
    ).toEqual(['public_reply_texts']);
    expect(
      parserFields(() =>
        validateCreateAutomation({ ...minimal, target_instagram_media_id: '12ab' }),
      ),
    ).toEqual(['target_instagram_media_id']);
  });

  it('refuses an invalid "next post" date', () => {
    expect(
      parserFields(() => validateCreateAutomation({ ...minimal, next_post_starts_at: 'tomorrow' })),
    ).toEqual(['next_post_starts_at']);
  });
});

describe('validateUpdateAutomation (route 14 body)', () => {
  it('takes any field and expected_updated_at, null clearing a nullable one', () => {
    const { changes, expectedUpdatedAt } = validateUpdateAutomation({
      status: 'live',
      email_request_message: null,
      expected_updated_at: '2026-11-21T09:00:00.000Z',
    });
    expect(changes).toEqual({ status: 'live', email_request_message: null });
    expect(expectedUpdatedAt).toBe('2026-11-21T09:00:00.000Z');
  });

  it('refuses an empty body and expected_updated_at alone (sendAtLeastOneField)', () => {
    expect(() => validateUpdateAutomation({})).toThrow(ValidationError);
    expect(() => validateUpdateAutomation({ expected_updated_at: '2026-11-21T09:00:00Z' })).toThrow(
      ValidationError,
    );
  });

  it('refuses a null final_message and every read-only field (D19, AU27)', () => {
    expect(() => validateUpdateAutomation({ final_message: null })).toThrow(ValidationError);
    expect(() => validateUpdateAutomation({ instagram_account_id: 'iga_x' })).toThrow(
      ValidationError,
    );
    expect(() => validateUpdateAutomation({ completed_run_count: 3 })).toThrow(ValidationError);
  });
});

describe('validateListAutomationsQuery (route 11)', () => {
  it('reads the filters, sort and order (AU13)', () => {
    expect(
      validateListAutomationsQuery({
        status: 'live',
        trigger_type: 'comment',
        target_scope: 'next',
        next_post_status: 'waiting',
        instagram_account_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
        sort: 'last_triggered_at',
        order: 'asc',
        q: 'link',
        limit: '10',
      }),
    ).toEqual({
      limit: 10,
      after: undefined,
      q: 'link',
      sort: 'last_triggered_at',
      order: 'asc',
      status: 'live',
      triggerType: 'comment',
      targetScope: 'next',
      nextPostStatus: 'waiting',
      instagramAccountPublicId: 'iga_k7x9m2pqr4w8n1v3a1b2c',
    });
  });

  it('refuses a bad value, a malformed account id and an unknown parameter', () => {
    expect(parserFields(() => validateListAutomationsQuery({ sort: '-created_at' }))).toEqual([
      'sort',
    ]);
    expect(
      parserFields(() => validateListAutomationsQuery({ instagram_account_id: 'con_abc' })),
    ).toEqual(['instagram_account_id']);
    // An unknown parameter: the route's schema names it (`querystring.search`); here it still throws.
    expect(() => validateListAutomationsQuery({ search: 'x' })).toThrow(ValidationError);
    expect(parserFields(() => validateListAutomationsQuery({ limit: '101' }))).toEqual(['limit']);
  });
});

describe('validateDeleteAutomationQuery (route 15, AQ6)', () => {
  it('requires a reason, and a note for other', () => {
    expect(validateDeleteAutomationQuery({ reason: 'duplicate' })).toEqual({
      reason: 'duplicate',
      note: null,
    });
    expect(validateDeleteAutomationQuery({ reason: 'other', note: 'Season over' })).toEqual({
      reason: 'other',
      note: 'Season over',
    });
    expect(parserFields(() => validateDeleteAutomationQuery({}))).toEqual(['reason']);
    expect(parserFields(() => validateDeleteAutomationQuery({ reason: 'other' }))).toEqual([
      'note',
    ]);
    expect(
      parserFields(() => validateDeleteAutomationQuery({ reason: 'other', note: 'n'.repeat(281) })),
    ).toEqual(['note']);
  });
});

describe('merging a body (AU8)', () => {
  it('a create lays the body over the defaults: inactive, any, DM keyword trigger and opening on', () => {
    const merged = mergeAutomationForCreate({
      name: 'X',
      trigger_type: 'story_reply',
      final_message: FINAL_MESSAGE,
    });
    expect(merged).toMatchObject({
      status: 'inactive',
      target_scope: 'any',
      is_dm_keyword_trigger_enabled: true,
      is_opening_message_enabled: true,
      is_public_reply_enabled: false,
      keywords: [],
      tags: [],
    });
  });

  it('an edit keeps every field the body left out and replaces a message whole', () => {
    const stored = commentAutomation({ keywords: ['price'] });
    const merged = mergeAutomationForUpdate({
      stored,
      changes: { opening_message: { text: 'New', button_title: 'Go' } },
    });
    expect(merged.keywords).toEqual(['price']);
    expect(merged.name).toBe(stored.name);
    expect(merged.opening_message).toEqual({ text: 'New', button_title: 'Go' });
  });
});

describe('validateAutomationFlow — the cross-field rules (AU8, 3.A.9)', () => {
  it('passes a complete comment, DM and story-reply automation', () => {
    expect(() => checkCreate(commentAutomation())).not.toThrow();
    expect(() =>
      checkCreate(
        mergeAutomationForCreate({
          name: 'DM',
          trigger_type: 'dm',
          keywords: ['price'],
          opening_message: { text: 'Hi', button_title: null },
          final_message: FINAL_MESSAGE,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      checkCreate(
        mergeAutomationForCreate({
          name: 'Story',
          trigger_type: 'story_reply',
          is_opening_message_enabled: false,
          final_message: FINAL_MESSAGE,
        }),
      ),
    ).not.toThrow();
  });

  it('next only on comments; dm only any (target_scope)', () => {
    expect(
      flowErrors(() =>
        checkCreate(
          mergeAutomationForCreate({
            name: 'S',
            trigger_type: 'story_reply',
            target_scope: 'next',
            is_opening_message_enabled: false,
            final_message: FINAL_MESSAGE,
          }),
        ),
      ),
    ).toEqual({ 'body.target_scope': 'errors:validation.nextScopeOnlyForComments' });
    expect(
      flowErrors(() =>
        checkCreate(
          mergeAutomationForCreate({
            name: 'D',
            trigger_type: 'dm',
            target_scope: 'specific',
            keywords: ['k'],
            is_opening_message_enabled: false,
            final_message: FINAL_MESSAGE,
          }),
        ),
      )['body.target_scope'],
    ).toBe('errors:validation.dmScopeOnlyAny');
  });

  it('specific needs exactly its own id, any takes none, next takes no sent media id', () => {
    const rule = 'errors:validation.specificNeedsTarget';
    expect(flowErrors(() => checkCreate(commentAutomation({ target_scope: 'specific' })))).toEqual({
      'body.target_instagram_media_id': rule,
    });
    expect(
      flowErrors(() =>
        checkCreate(
          commentAutomation({
            target_scope: 'specific',
            target_instagram_media_id: '1801',
            target_instagram_story_id: '1799',
          }),
        ),
      ),
    ).toEqual({ 'body.target_instagram_story_id': rule });
    expect(
      flowErrors(() =>
        checkCreate(
          mergeAutomationForCreate({
            name: 'S',
            trigger_type: 'story_reply',
            target_scope: 'specific',
            target_instagram_media_id: '1801',
            is_opening_message_enabled: false,
            final_message: FINAL_MESSAGE,
          }),
        ),
      ),
    ).toEqual({
      'body.target_instagram_story_id': rule,
      'body.target_instagram_media_id': rule,
    });
    expect(
      flowErrors(() => checkCreate(commentAutomation({ target_instagram_media_id: '1801' }))),
    ).toEqual({ 'body.target_instagram_media_id': rule });
    expect(
      flowErrors(() =>
        checkCreate(
          commentAutomation({
            target_scope: 'next',
            target_instagram_media_id: '1801',
            next_post_starts_at: at(1),
            next_post_ends_at: at(48),
          }),
          true,
        ),
      ),
    ).toEqual({ 'body.target_instagram_media_id': rule });
  });

  it('a DM automation needs a keyword and the DM keyword trigger on (AU8)', () => {
    expect(
      flowErrors(() =>
        checkCreate(
          mergeAutomationForCreate({
            name: 'D',
            trigger_type: 'dm',
            is_dm_keyword_trigger_enabled: false,
            is_opening_message_enabled: false,
            final_message: FINAL_MESSAGE,
          }),
        ),
      ),
    ).toEqual({
      'body.keywords': 'errors:validation.dmNeedsKeyword',
      'body.is_dm_keyword_trigger_enabled': 'errors:validation.dmKeywordTriggerRequired',
    });
  });

  it('public replies only on comments, with at least one text', () => {
    expect(
      flowErrors(() =>
        checkCreate(
          mergeAutomationForCreate({
            name: 'S',
            trigger_type: 'story_reply',
            is_public_reply_enabled: true,
            public_reply_texts: ['Thanks!'],
            is_opening_message_enabled: false,
            final_message: FINAL_MESSAGE,
          }),
        ),
      ),
    ).toEqual({ 'body.is_public_reply_enabled': 'errors:validation.publicReplyOnlyForComments' });
    expect(
      flowErrors(() => checkCreate(commentAutomation({ is_public_reply_enabled: true }))),
    ).toEqual({ 'body.public_reply_texts': 'errors:validation.publicReplyOnlyForComments' });
    // Texts kept while the step is off are allowed (a step turned on again restores them).
    expect(() =>
      checkCreate(
        commentAutomation({ public_reply_texts: ['kept'], is_public_reply_enabled: false }),
      ),
    ).not.toThrow();
  });

  it('a step that is on needs its message — one errors[] item per missing object', () => {
    expect(
      flowErrors(() =>
        checkCreate(
          commentAutomation({
            opening_message: null,
            is_follow_required: true,
          }),
        ),
      ),
    ).toEqual({
      'body.opening_message': 'errors:validation.messageObjectRequired',
      'body.follow_request_message': 'errors:validation.messageObjectRequired',
    });
    // The email and phone questions may stay null — the default question (schema-routes § 10).
    expect(() =>
      checkCreate(
        commentAutomation({ is_email_collection_enabled: true, is_phone_collection_enabled: true }),
      ),
    ).not.toThrow();
  });

  it('a comment automation with the opening message on needs its button (AQ2, D26)', () => {
    expect(
      flowErrors(() =>
        checkCreate(commentAutomation({ opening_message: { text: 'Hi', button_title: null } })),
      ),
    ).toEqual({ 'body.opening_message.button_title': 'errors:validation.openingButtonRequired' });
    // With the opening message off the button is not needed.
    expect(() =>
      checkCreate(
        commentAutomation({
          is_opening_message_enabled: false,
          opening_message: { text: 'Hi', button_title: null },
        }),
      ),
    ).not.toThrow();
  });

  it('checks every save whatever its status — live needs the same complete flow', () => {
    for (const status of ['inactive', 'live'] as const) {
      expect(() => checkCreate(commentAutomation({ status, opening_message: null }))).toThrow(
        ValidationError,
      );
    }
  });
});

describe('validateAutomationFlow — the "next post" window (AU9, fixed clock)', () => {
  function nextAutomation(
    window: { startsAt: Date | null; endsAt: Date | null },
    overrides: Partial<AutomationWritableFields> = {},
  ) {
    return commentAutomation({
      target_scope: 'next',
      next_post_starts_at: window.startsAt,
      next_post_ends_at: window.endsAt,
      ...overrides,
    });
  }
  function storedWindow(startsAt: Date, endsAt: Date): AutomationStoredNextPost {
    return {
      target_scope: 'next',
      next_post_starts_at: startsAt,
      next_post_ends_at: endsAt,
      next_post_status: 'waiting',
    };
  }
  const check = (
    automation: AutomationWritableFields,
    stored: AutomationStoredNextPost | null = null,
  ) => validateAutomationFlow({ automation, stored, isMediaIdSent: false, now: NOW });

  it('needs both dates', () => {
    expect(flowErrors(() => check(nextAutomation({ startsAt: null, endsAt: null })))).toEqual({
      'body.next_post_starts_at': 'errors:validation.nextPostDatesRequired',
      'body.next_post_ends_at': 'errors:validation.nextPostDatesRequired',
    });
    expect(flowErrors(() => check(nextAutomation({ startsAt: at(1), endsAt: null })))).toEqual({
      'body.next_post_ends_at': 'errors:validation.nextPostDatesRequired',
    });
  });

  it('needs the end after the start', () => {
    expect(flowErrors(() => check(nextAutomation({ startsAt: at(5), endsAt: at(5) })))).toEqual({
      'body.next_post_ends_at': 'errors:validation.nextPostEndBeforeStart',
    });
  });

  it('a new start may go back 24 hours, not further; a new end may not be in the past', () => {
    expect(() => check(nextAutomation({ startsAt: at(-23), endsAt: at(24) }))).not.toThrow();
    expect(flowErrors(() => check(nextAutomation({ startsAt: at(-25), endsAt: at(24) })))).toEqual({
      'body.next_post_starts_at': 'errors:validation.nextPostStartInPast',
    });
    expect(flowErrors(() => check(nextAutomation({ startsAt: at(-23), endsAt: at(-1) })))).toEqual({
      'body.next_post_ends_at': 'errors:validation.nextPostEndInPast',
    });
  });

  it('an unchanged date is not checked again (an old window kept on an edit)', () => {
    const stored = storedWindow(at(-72), at(-1));
    // Neither date changed: an edit of something else passes.
    expect(() =>
      check(nextAutomation({ startsAt: at(-72), endsAt: at(-1) }), stored),
    ).not.toThrow();
    // Only the end moved, into the future: the old start is not checked.
    expect(() =>
      check(nextAutomation({ startsAt: at(-72), endsAt: at(24) }), stored),
    ).not.toThrow();
  });

  it('a started window may move later, never earlier', () => {
    const stored = storedWindow(at(-10), at(24));
    expect(() => check(nextAutomation({ startsAt: at(-5), endsAt: at(24) }), stored)).not.toThrow();
    expect(
      flowErrors(() => check(nextAutomation({ startsAt: at(-12), endsAt: at(24) }), stored)),
    ).toEqual({ 'body.next_post_starts_at': 'errors:validation.nextPostStartMovedEarlier' });
    // A window that has not started yet may move earlier (within the 24-hour rule).
    const future = storedWindow(at(10), at(48));
    expect(() => check(nextAutomation({ startsAt: at(2), endsAt: at(48) }), future)).not.toThrow();
  });

  it('a stored window of another scope counts as new', () => {
    const stored: AutomationStoredNextPost = {
      target_scope: 'any',
      next_post_starts_at: null,
      next_post_ends_at: null,
      next_post_status: null,
    };
    expect(
      flowErrors(() => check(nextAutomation({ startsAt: at(-30), endsAt: at(24) }), stored)),
    ).toEqual({ 'body.next_post_starts_at': 'errors:validation.nextPostStartInPast' });
  });
});

describe('assertNextPostLinkUnchanged (AU9)', () => {
  const linked = {
    next_post_status: 'linked' as const,
    target_scope: 'next' as const,
    target_instagram_media_id: '1801',
    target_instagram_story_id: null,
    next_post_starts_at: at(-48),
    next_post_ends_at: at(-24),
  };

  it('refuses a changed window, scope or target id on a linked automation', () => {
    for (const changes of [
      { next_post_starts_at: at(-47) },
      { next_post_ends_at: at(1) },
      { target_scope: 'any' as const },
      { target_instagram_media_id: '1802' },
      { target_instagram_media_id: null },
      { target_instagram_story_id: '1799' },
    ]) {
      let thrown: unknown;
      try {
        assertNextPostLinkUnchanged({ stored: linked, changes });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConflictError);
      expect((thrown as ConflictError).reason).toBe('next_post_already_linked');
    }
  });

  it('lets the same values and every other field through; a waiting one is never locked', () => {
    expect(() =>
      assertNextPostLinkUnchanged({
        stored: linked,
        changes: {
          next_post_starts_at: at(-48),
          target_scope: 'next',
          name: 'Renamed',
          status: 'inactive',
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertNextPostLinkUnchanged({
        stored: { ...linked, next_post_status: 'waiting' },
        changes: { next_post_ends_at: at(48) },
      }),
    ).not.toThrow();
  });
});

describe('resolveNextPostState (AU9)', () => {
  const next = (startsAt: Date, endsAt: Date) =>
    commentAutomation({
      target_scope: 'next',
      next_post_starts_at: startsAt,
      next_post_ends_at: endsAt,
    });
  const stored = (status: 'waiting' | 'linked' | 'expired') => ({
    target_scope: 'next' as const,
    next_post_starts_at: at(-48),
    next_post_ends_at: at(-24),
    next_post_status: status,
    next_post_linked_at: status === 'linked' ? at(-30) : null,
    target_instagram_media_id: status === 'linked' ? '1801' : null,
  });

  it('a new next automation waits', () => {
    expect(resolveNextPostState({ automation: next(at(1), at(24)), stored: null })).toMatchObject({
      next_post_status: 'waiting',
      next_post_linked_at: null,
      target_instagram_media_id: null,
    });
  });

  it('an expired one waits again only when its window changed', () => {
    expect(
      resolveNextPostState({ automation: next(at(-48), at(-24)), stored: stored('expired') })
        .next_post_status,
    ).toBe('expired');
    expect(
      resolveNextPostState({ automation: next(at(-48), at(24)), stored: stored('expired') })
        .next_post_status,
    ).toBe('waiting');
  });

  it('a linked one keeps its link and post', () => {
    expect(
      resolveNextPostState({ automation: next(at(-48), at(-24)), stored: stored('linked') }),
    ).toMatchObject({
      next_post_status: 'linked',
      next_post_linked_at: at(-30),
      target_instagram_media_id: '1801',
    });
  });

  it('leaving next clears every next-post field', () => {
    expect(
      resolveNextPostState({
        automation: commentAutomation({ next_post_starts_at: at(1), next_post_ends_at: at(2) }),
        stored: stored('waiting'),
      }),
    ).toMatchObject({
      target_scope: 'any',
      next_post_starts_at: null,
      next_post_ends_at: null,
      next_post_status: null,
      next_post_linked_at: null,
    });
  });
});
