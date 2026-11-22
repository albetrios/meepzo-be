import { describe, expect, it } from 'vitest';
import {
  type AutomationDefaultTexts,
  type AutomationMessageSource,
  buildAutomationButtonPayload,
  buildInstagramProfileUrl,
  composeAutomationMessage,
  parseAutomationButtonPayload,
  resolveAutomationMessageRecipient,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run-message.util.js';

/**
 * How a run's DMs look on the wire (routes-final § 3.B AU18, AU22, schema-routes § 5.6, § 10): the
 * button payload, the channel a DM takes (3.B.10) and each message composed with its defaults.
 */

const AUTOMATION_PUBLIC_ID = 'aut_k7x9m2pqr4w8n1v3a1b2c';
const RUN_PUBLIC_ID = 'run_p3k8w2m9x4r7n1v5a1b2c';
const now = new Date('2026-11-21T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

const defaults: AutomationDefaultTexts = {
  emailQuestion: 'Default email question',
  phoneQuestion: 'Default phone question',
  invalidEmail: 'Default invalid email',
  buttonTemplateText: 'Default button text',
  linkButtonTitle: 'Default link',
};

const source: AutomationMessageSource = {
  opening_message: { text: 'Thanks!', button_title: 'Send it' },
  follow_request_message: {
    text: 'Follow us first',
    following_button_title: "I'm following",
    profile_button_title: 'Profile',
  },
  email_request_message: null,
  phone_request_message: { text: 'Your phone?' },
  final_message: {
    text: 'Here you go',
    links: [{ title: 'Shop', url: 'https://shop.example.com' }],
  },
};

function compose(
  messageKind: Parameters<typeof composeAutomationMessage>[0]['messageKind'],
  automation: AutomationMessageSource = source,
) {
  return composeAutomationMessage({
    messageKind,
    automation,
    buttonPayload: `${AUTOMATION_PUBLIC_ID}::${RUN_PUBLIC_ID}`,
    profileUrl: 'https://www.instagram.com/acme.shop',
    defaults,
  });
}

describe('the button payload (schema-routes § 5.6)', () => {
  it('builds and reads <aut_…>::<run_…>', () => {
    const payload = buildAutomationButtonPayload({
      automationPublicId: AUTOMATION_PUBLIC_ID,
      runPublicId: RUN_PUBLIC_ID,
    });
    expect(payload).toBe(`${AUTOMATION_PUBLIC_ID}::${RUN_PUBLIC_ID}`);
    expect(parseAutomationButtonPayload(payload)).toEqual({
      automationPublicId: AUTOMATION_PUBLIC_ID,
      runPublicId: RUN_PUBLIC_ID,
    });
  });

  it.each([
    'hello',
    `${AUTOMATION_PUBLIC_ID}::`,
    `${RUN_PUBLIC_ID}::${AUTOMATION_PUBLIC_ID}`,
    `${AUTOMATION_PUBLIC_ID}::${RUN_PUBLIC_ID}::x`,
  ])('refuses a payload it never sent: %s', (payload) => {
    expect(parseAutomationButtonPayload(payload)).toBeNull();
  });

  it("links the follow request's profile button to the account's page", () => {
    expect(buildInstagramProfileUrl('acme.shop')).toBe('https://www.instagram.com/acme.shop');
  });
});

describe('resolveAutomationMessageRecipient (3.B.10)', () => {
  const privateReply = { instagramCommentId: '17950000000000001', commentedAt: hoursAgo(30) };

  it('a normal DM inside the 24-hour messaging window', () => {
    expect(
      resolveAutomationMessageRecipient({
        instagramUserId: '17841400000000001',
        lastDirectMessageReceivedAt: hoursAgo(2),
        privateReply,
        now,
      }),
    ).toEqual({ id: '17841400000000001' });
  });

  it('otherwise a private reply to the comment, within 7 days', () => {
    expect(
      resolveAutomationMessageRecipient({
        instagramUserId: '17841400000000001',
        lastDirectMessageReceivedAt: hoursAgo(25),
        privateReply,
        now,
      }),
    ).toEqual({ comment_id: '17950000000000001' });
  });

  it('otherwise nothing: the step cannot be sent', () => {
    expect(
      resolveAutomationMessageRecipient({
        instagramUserId: '17841400000000001',
        lastDirectMessageReceivedAt: null,
        privateReply: null,
        now,
      }),
    ).toBeNull();
    expect(
      resolveAutomationMessageRecipient({
        instagramUserId: '17841400000000001',
        lastDirectMessageReceivedAt: null,
        privateReply: { ...privateReply, commentedAt: hoursAgo(8 * 24) },
        now,
      }),
    ).toBeNull();
  });
});

describe('composeAutomationMessage (AU18, AU22)', () => {
  it('the opening message with a button is a button template carrying the payload', () => {
    expect(compose('opening_message').message).toEqual({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'Thanks!',
          buttons: [
            {
              type: 'postback',
              title: 'Send it',
              payload: `${AUTOMATION_PUBLIC_ID}::${RUN_PUBLIC_ID}`,
            },
          ],
        },
      },
    });
  });

  it('the opening message without a button is plain text', () => {
    expect(
      compose('opening_message', {
        ...source,
        opening_message: { text: 'Thanks!', button_title: null },
      }).message,
    ).toEqual({ text: 'Thanks!' });
  });

  it("the follow request carries the I'm following postback and the profile link", () => {
    const { message } = compose('follow_request');
    expect(message.attachment?.payload).toEqual({
      template_type: 'button',
      text: 'Follow us first',
      buttons: [
        {
          type: 'postback',
          title: "I'm following",
          payload: `${AUTOMATION_PUBLIC_ID}::${RUN_PUBLIC_ID}`,
        },
        { type: 'web_url', title: 'Profile', url: 'https://www.instagram.com/acme.shop' },
      ],
    });
  });

  it('the email question falls back to the default text and carries the quick reply', () => {
    expect(compose('email_question')).toEqual({
      message: { text: 'Default email question', quick_replies: [{ content_type: 'user_email' }] },
      plainTextFallback: { text: 'Default email question' },
    });
  });

  it('the wrong-email text asks again with the quick reply', () => {
    expect(compose('invalid_email').message).toEqual({
      text: 'Default invalid email',
      quick_replies: [{ content_type: 'user_email' }],
    });
  });

  it("the phone question uses the automation's text and the phone quick reply", () => {
    expect(compose('phone_question').message).toEqual({
      text: 'Your phone?',
      quick_replies: [{ content_type: 'user_phone_number' }],
    });
  });

  it('the final message carries its link buttons, or is plain text without links', () => {
    expect(compose('final_message').message.attachment?.payload).toEqual({
      template_type: 'button',
      text: 'Here you go',
      buttons: [{ type: 'web_url', title: 'Shop', url: 'https://shop.example.com' }],
    });
    expect(
      compose('final_message', { ...source, final_message: { text: 'Done', links: [] } }).message,
    ).toEqual({ text: 'Done' });
  });

  it('refuses a public reply — not a DM', () => {
    expect(() => compose('public_reply')).toThrow();
  });
});
