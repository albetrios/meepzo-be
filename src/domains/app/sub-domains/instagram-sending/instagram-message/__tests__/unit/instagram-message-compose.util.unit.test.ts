import { describe, expect, it } from 'vitest';
import type { AutomationSteps } from '@/domains/app/sub-domains/automation/automation-steps.dto.js';
import {
  composeInstagramMessage,
  fillInstagramName,
} from '@/domains/app/sub-domains/instagram-sending/instagram-message/instagram-message-compose.util.js';

const steps: AutomationSteps = {
  hello: {
    on: true,
    versions: [
      { text: 'Hey {name}!', buttons: [] },
      {
        text: 'Hi {name}, tap below.',
        buttons: [
          { title: 'Send me the guide', action: 'next' },
          { title: 'Shop', action: 'link', url: 'https://shop.example' },
        ],
      },
    ],
  },
  follow: {
    on: true,
    versions: [
      { text: 'Follow first', profile_button_title: 'Profile', following_button_title: 'Done' },
    ],
  },
  phone: { on: true, wordings: ['Your number, {name}?'] },
  messages: [
    {
      kind: 'text',
      wait_minutes: 0,
      text: 'The link',
      buttons: [{ title: '', url: 'https://x.example' }],
    },
    { kind: 'image', wait_minutes: 0, upload_id: 'upl_aaaaaaaaaaaaaaaaaaaaa' },
    { kind: 'post', wait_minutes: 0, media_id: 'newest' },
  ],
};

function compose(overrides: Partial<Parameters<typeof composeInstagramMessage>[0]['message']>) {
  return composeInstagramMessage({
    message: {
      message_type: 'opening_message',
      message_number: null,
      message_kind: 'text',
      version_number: null,
      wording_number: null,
      ...overrides,
    },
    steps,
    contactName: 'Riya',
    accountUsername: 'shop.account',
    buttonPayload: 'aut_x::run_y',
    newestMediaId: '17800000000000777',
    translate: (key) => `t:${key}`,
  });
}

function built(result: ReturnType<typeof compose>, attachmentId: string | null = null) {
  if (result.kind !== 'send') throw new Error(`expected a send, got ${result.reason}`);
  return result.build(attachmentId);
}

/**
 * The text a lane sends, read at the last moment (feat-instagram-dm-sending routes-final § 6.B.10;
 * plan §5.6, §18.5; ROUTE row R43; P133's default texts and plain-text fallback).
 */
describe('composeInstagramMessage', () => {
  it('fills {name}, and leaves it out tidily when she has neither name nor username', () => {
    expect(fillInstagramName({ text: 'Hi {name}, tap below.', name: 'Riya' })).toBe(
      'Hi Riya, tap below.',
    );
    expect(fillInstagramName({ text: 'Hi {name}, tap below.', name: null })).toBe('Hi, tap below.');
    expect(fillInstagramName({ text: 'Hey {name}!', name: null })).toBe('Hey!');
  });

  it('cuts a long {name} at a grapheme boundary so a text near the 1,000-byte limit stays within it (plan §5.6, §18.5)', () => {
    // A saved text of 998 bytes: the go-live check counts `{name}` as its 6 written bytes.
    const saved = `${'😀'.repeat(248)}{name}`;
    expect(Buffer.byteLength(saved, 'utf8')).toBe(998);
    const name = 'Riya 🌸✨'; // 4 letters + a space + 4 + 3 bytes = 12 bytes
    const filled = fillInstagramName({ text: saved, name, limit: { maxBytes: 1000 } });
    // 992 bytes of text leave 8 for her name: "Riya " then the 4-byte flower would be 9 — cut
    // before it, the trailing space dropped; no emoji is split.
    expect(filled).toBe(`${'😀'.repeat(248)}Riya`);
    expect(Buffer.byteLength(filled, 'utf8')).toBeLessThanOrEqual(1000);
    const result = composeInstagramMessage({
      message: {
        message_type: 'message',
        message_number: 1,
        message_kind: 'text',
        version_number: null,
        wording_number: null,
      },
      steps: { messages: [{ kind: 'text', wait_minutes: 0, text: saved }] },
      contactName: name,
      accountUsername: 'shop.account',
      buttonPayload: 'aut_x::run_y',
      newestMediaId: null,
      translate: (key) => `t:${key}`,
    });
    expect(built(result)).toEqual({ text: filled });
    // Without a limit the name goes in whole; a short name under the limit is never cut.
    expect(fillInstagramName({ text: saved, name })).toBe(`${'😀'.repeat(248)}${name}`);
    expect(fillInstagramName({ text: 'Hey {name}!', name, limit: { maxBytes: 1000 } })).toBe(
      `Hey ${name}!`,
    );
  });

  it('shares the room between two {name}s, and leaves her name out when no whole grapheme fits', () => {
    // 990 bytes besides two placeholders: 5 bytes each.
    const twice = `${'a'.repeat(990)}{name}{name}`;
    expect(fillInstagramName({ text: twice, name: 'Riyaaaa', limit: { maxBytes: 1000 } })).toBe(
      `${'a'.repeat(990)}RiyaaRiyaa`,
    );
    // A family emoji is one 25-byte grapheme: it never fits the 6 bytes, so the name is left out.
    const family = '👨‍👩‍👧‍👦';
    const tight = `${'a'.repeat(994)}{name}`;
    expect(fillInstagramName({ text: tight, name: family, limit: { maxBytes: 1000 } })).toBe(
      'a'.repeat(994),
    );
  });

  it('cuts {name} by characters in a button template (640) and a card (80)', () => {
    const cardTitle = `${'b'.repeat(74)}{name}`;
    const result = composeInstagramMessage({
      message: {
        message_type: 'message',
        message_number: 1,
        message_kind: 'cards',
        version_number: null,
        wording_number: null,
      },
      steps: { messages: [{ kind: 'cards', wait_minutes: 0, cards: [{ title: cardTitle }] }] },
      contactName: 'Krishnamurthy',
      accountUsername: 'shop.account',
      buttonPayload: 'aut_x::run_y',
      newestMediaId: null,
      translate: (key) => `t:${key}`,
    });
    expect(built(result)).toMatchObject({
      attachment: { payload: { elements: [{ title: `${'b'.repeat(74)}Krishn` }] } },
    });
    const hello = `${'c'.repeat(630)}{name}`;
    expect(
      fillInstagramName({ text: hello, name: 'Krishnamurthy', limit: { maxLength: 640 } }),
    ).toBe(`${'c'.repeat(630)}Krishnamur`);
  });

  it('sends the hello version she got: plain text, or a button template with next and link buttons', () => {
    expect(built(compose({}))).toEqual({ text: 'Hey Riya!' });
    expect(built(compose({ version_number: 2 }))).toEqual({
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'Hi Riya, tap below.',
          buttons: [
            { type: 'postback', title: 'Send me the guide', payload: 'aut_x::run_y' },
            { type: 'web_url', title: 'Shop', url: 'https://shop.example' },
          ],
        },
      },
    });
  });

  it('sends the follow ask with the account profile and the "done" postback', () => {
    expect(built(compose({ message_type: 'follow_request' }))).toMatchObject({
      attachment: {
        payload: {
          buttons: [
            { type: 'web_url', title: 'Profile', url: 'https://www.instagram.com/shop.account' },
            { type: 'postback', title: 'Done', payload: 'aut_x::run_y' },
          ],
        },
      },
    });
  });

  it("asks for the phone with Instagram's button and keeps a plain-text fallback; email falls back to the default text", () => {
    const phone = compose({ message_type: 'phone_question' });
    expect(built(phone)).toEqual({
      text: 'Your number, Riya?',
      quick_replies: [{ content_type: 'user_phone_number' }],
    });
    expect(phone.kind === 'send' && phone.plainTextFallback).toEqual({
      text: 'Your number, Riya?',
    });
    expect(built(compose({ message_type: 'email_question' }))).toEqual({
      text: 't:common:automationMessages.emailQuestion',
      quick_replies: [{ content_type: 'user_email' }],
    });
    expect(built(compose({ message_type: 'invalid_email' }))).toMatchObject({
      text: 't:common:automationMessages.invalidEmail',
    });
  });

  it('sends list messages: a text with a default link title, a file by its Meta id, the newest post', () => {
    expect(built(compose({ message_type: 'message', message_number: 1 }))).toMatchObject({
      attachment: {
        payload: {
          text: 'The link',
          buttons: [{ type: 'web_url', title: 't:common:automationMessages.linkButtonTitle' }],
        },
      },
    });
    const image = compose({ message_type: 'message', message_number: 2, message_kind: 'image' });
    expect(image.kind === 'send' && image.uploadPublicId).toBe('upl_aaaaaaaaaaaaaaaaaaaaa');
    expect(built(image, '9988')).toEqual({
      attachment: { type: 'image', payload: { attachment_id: '9988' } },
    });
    expect(
      built(compose({ message_type: 'message', message_number: 3, message_kind: 'post' })),
    ).toEqual({
      attachment: { type: 'MEDIA_SHARE', payload: { id: '17800000000000777' } },
    });
  });

  it('skips a message whose step is gone from the automation (a live edit raced the claim)', () => {
    expect(compose({ version_number: 3 })).toEqual({ kind: 'skip', reason: 'cancelled_by_owner' });
    expect(compose({ message_type: 'message', message_number: 9 })).toEqual({
      kind: 'skip',
      reason: 'cancelled_by_owner',
    });
  });
});
