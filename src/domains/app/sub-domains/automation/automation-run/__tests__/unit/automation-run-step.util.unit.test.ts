import { describe, expect, it } from 'vitest';
import {
  type AutomationStepContact,
  type AutomationStepSource,
  planAutomationRunStep,
  planWaitedStepNowOff,
  toCommentLogStep,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-step.util.js';
import type { AutomationRunStep } from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';

/**
 * The step machine's planner (routes-final § 3.B AU18, AU14, D14): for each step, what a `running`
 * run does next — move on with nothing sent, the public reply, a send (and what it waits for), the
 * follow read — reading the automation as it is now; and where a `waiting` run goes when the step it
 * waits for is now off (D48).
 */

const now = new Date('2026-11-21T12:00:00.000Z');

function automation(overrides: Partial<AutomationStepSource> = {}): AutomationStepSource {
  return {
    is_public_reply_enabled: false,
    is_opening_message_enabled: true,
    opening_message: { text: 'Hi', button_title: 'Send it' },
    is_follow_required: false,
    follow_request_message: null,
    is_email_collection_enabled: false,
    is_phone_collection_enabled: false,
    ...overrides,
  };
}

function contact(overrides: Partial<AutomationStepContact> = {}): AutomationStepContact {
  return { email: null, phone: null, last_message_sent_at: null, ...overrides };
}

function plan({
  currentStep,
  isCommentTrigger = true,
  isPublicReplyPending = true,
  source = automation(),
  person = contact(),
}: {
  currentStep: AutomationRunStep;
  isCommentTrigger?: boolean;
  isPublicReplyPending?: boolean;
  source?: AutomationStepSource;
  person?: AutomationStepContact;
}) {
  return planAutomationRunStep({
    currentStep,
    isCommentTrigger,
    isPublicReplyPending,
    automation: source,
    contact: person,
    now,
  });
}

describe('planAutomationRunStep (AU18)', () => {
  it('keyword_match moves to comment_reply', () => {
    expect(plan({ currentStep: 'keyword_match' })).toEqual({
      action: 'move',
      toStep: 'comment_reply',
      commentLogChanges: {},
    });
  });

  it('the public reply first, on a comment with it on and not handled yet', () => {
    expect(
      plan({ currentStep: 'comment_reply', source: automation({ is_public_reply_enabled: true }) }),
    ).toEqual({ action: 'public_reply' });
  });

  it('no public reply on a DM trigger, nor once it was handled', () => {
    const source = automation({ is_public_reply_enabled: true });
    expect(plan({ currentStep: 'comment_reply', source, isCommentTrigger: false }).action).toBe(
      'send',
    );
    expect(plan({ currentStep: 'comment_reply', source, isPublicReplyPending: false }).action).toBe(
      'send',
    );
  });

  it('the opening message with a button waits for the click; without one it goes on (AQ3)', () => {
    expect(plan({ currentStep: 'comment_reply' })).toEqual({
      action: 'send',
      messageKind: 'opening_message',
      waitFor: 'opening_message_button',
      nextStep: 'follow_check',
    });
    expect(
      plan({
        currentStep: 'comment_reply',
        isCommentTrigger: false,
        source: automation({ opening_message: { text: 'Hi', button_title: null } }),
      }),
    ).toEqual({
      action: 'send',
      messageKind: 'opening_message',
      waitFor: null,
      nextStep: 'follow_check',
    });
  });

  it('skips the opening message when the contact got a DM in the last 24 hours (D14)', () => {
    const recently = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    const longAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    expect(
      plan({ currentStep: 'comment_reply', person: contact({ last_message_sent_at: recently }) }),
    ).toEqual({
      action: 'move',
      toStep: 'follow_check',
      commentLogChanges: { opening_dm_status: 'skipped' },
    });
    expect(
      plan({ currentStep: 'comment_reply', person: contact({ last_message_sent_at: longAgo }) })
        .action,
    ).toBe('send');
  });

  it('a step turned off is skipped (AU14)', () => {
    expect(
      plan({
        currentStep: 'comment_reply',
        source: automation({ is_opening_message_enabled: false }),
      }),
    ).toEqual({ action: 'move', toStep: 'follow_check', commentLogChanges: {} });
    expect(plan({ currentStep: 'follow_check' })).toEqual({
      action: 'move',
      toStep: 'email_collect',
      commentLogChanges: {},
    });
    expect(plan({ currentStep: 'email_collect' }).action).toBe('move');
    expect(plan({ currentStep: 'phone_collect' }).action).toBe('move');
  });

  it('the follow check reads the follow status when on', () => {
    expect(
      plan({
        currentStep: 'follow_check',
        source: automation({
          is_follow_required: true,
          follow_request_message: {
            text: 'Follow us',
            following_button_title: "I'm following",
            profile_button_title: 'Profile',
          },
        }),
      }),
    ).toEqual({ action: 'read_follow' });
  });

  it('asks for the email, or skips it when the contact has one', () => {
    const source = automation({ is_email_collection_enabled: true });
    expect(plan({ currentStep: 'email_collect', source })).toEqual({
      action: 'send',
      messageKind: 'email_question',
      waitFor: 'email',
      nextStep: 'phone_collect',
    });
    expect(
      plan({ currentStep: 'email_collect', source, person: contact({ email: 'a@example.com' }) }),
    ).toEqual({
      action: 'move',
      toStep: 'phone_collect',
      commentLogChanges: { email_status: 'skipped' },
    });
  });

  it('asks for the phone, or skips it when the contact has one', () => {
    const source = automation({ is_phone_collection_enabled: true });
    expect(plan({ currentStep: 'phone_collect', source })).toEqual({
      action: 'send',
      messageKind: 'phone_question',
      waitFor: 'phone',
      nextStep: 'final_dm',
    });
    expect(
      plan({ currentStep: 'phone_collect', source, person: contact({ phone: '+15550100123' }) })
        .action,
    ).toBe('move');
  });

  it('the final DM completes the run', () => {
    expect(plan({ currentStep: 'final_dm' })).toEqual({
      action: 'send',
      messageKind: 'final_message',
      waitFor: null,
      nextStep: null,
    });
  });
});

describe('planWaitedStepNowOff (AU14, D48)', () => {
  const everyStepOn = automation({
    is_follow_required: true,
    follow_request_message: {
      text: 'Follow us',
      following_button_title: "I'm following",
      profile_button_title: 'Profile',
    },
    is_email_collection_enabled: true,
    is_phone_collection_enabled: true,
  });

  it.each([
    [
      'opening_message_button',
      { is_opening_message_enabled: false },
      'follow_check',
      { opening_dm_status: 'sent' },
    ],
    [
      'opening_message_button',
      { opening_message: null },
      'follow_check',
      { opening_dm_status: 'sent' },
    ],
    ['follow', { is_follow_required: false }, 'email_collect', { follow_status: 'skipped' }],
    ['follow', { follow_request_message: null }, 'email_collect', { follow_status: 'skipped' }],
    ['email', { is_email_collection_enabled: false }, 'phone_collect', { email_status: 'skipped' }],
    ['phone', { is_phone_collection_enabled: false }, 'final_dm', { phone_status: 'skipped' }],
  ] as const)(
    'a wait for the %s with %o goes on to %s',
    (waitingFor, off, toStep, commentLogChanges) => {
      expect(planWaitedStepNowOff({ waitingFor, automation: { ...everyStepOn, ...off } })).toEqual({
        toStep,
        commentLogChanges,
      });
      expect(planWaitedStepNowOff({ waitingFor, automation: everyStepOn })).toBeNull();
    },
  );

  it('another step turned off does not move it', () => {
    const emailOnly = automation({
      is_opening_message_enabled: false,
      opening_message: null,
      is_email_collection_enabled: true,
    });
    expect(planWaitedStepNowOff({ waitingFor: 'email', automation: emailOnly })).toBeNull();
  });
});

describe('toCommentLogStep (D19)', () => {
  it.each([
    ['keyword_match', true, null],
    ['comment_reply', true, 'public_reply'],
    ['comment_reply', false, 'opening_dm'],
    ['follow_check', false, 'follow_check'],
    ['final_dm', false, 'final_dm'],
  ] as const)('%s (public reply pending %s) → %s', (runStep, isPublicReplyPending, expected) => {
    expect(toCommentLogStep({ runStep, isPublicReplyPending })).toBe(expected);
  });
});
