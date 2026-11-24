import { describe, expect, it } from 'vitest';
import {
  serializeContact,
  serializeContactDetail,
  serializeContactTagCount,
} from '@/domains/app/sub-domains/contact/contact.serializer.js';
import type { ContactViewRow } from '@/domains/app/sub-domains/contact/contact.repository.js';

/** The Contact and Contact detail objects (routes-final § 3.A.6): every key named, never an internal id. */

const ACCOUNT_PUBLIC_ID = 'cha_k7x9m2pqr4w8n1v3a1b2c';
const AUTOMATION_PUBLIC_ID = 'aut_k7x9m2pqr4w8n1v3a1b2c';
const firstSeen = new Date('2026-11-20T08:00:00.000Z');
const lastMessage = new Date('2026-11-21T09:06:20.000Z');
/** One hour after her last DM — her chat is open. */
const now = new Date('2026-11-21T10:06:20.000Z');

function buildRow(overrides: Partial<ContactViewRow> = {}): ContactViewRow {
  return {
    id: 41,
    public_id: 'con_p3k8w2m9x4r7n1v5a1b2c',
    organization_id: 7,
    channel_account_id: 3,
    channel: 'instagram',
    instagram_user_id: '17841455500000001',
    username: 'jordan.lee',
    full_name: 'Jordan Lee',
    profile_picture_url: 'https://scontent.cdninstagram.com/v/jordan.jpg',
    followers_count: 812,
    is_following_account: true,
    follow_checked_at: lastMessage,
    email: 'jordan.lee+shop@example.com',
    email_collected_at: lastMessage,
    phone: '+15550100123',
    phone_collected_at: lastMessage,
    tags: ['giveaway', 'vip'],
    note: 'Asked about sizes',
    opted_out_at: null,
    automations_off_at: lastMessage,
    automations_off_by_user_id: 12,
    first_automation_id: 17,
    came_in_via: 'comment',
    came_in_ref: null,
    first_seen_at: firstSeen,
    last_message_received_at: lastMessage,
    last_direct_message_received_at: lastMessage,
    last_message_sent_at: lastMessage,
    last_opening_message_at: lastMessage,
    first_message_at: firstSeen,
    last_comment_at: lastMessage,
    comment_count: 3,
    last_story_activity_at: null,
    last_broadcast_at: null,
    deleted_at: null,
    created_at: firstSeen,
    updated_at: lastMessage,
    channel_account_public_id: ACCOUNT_PUBLIC_ID,
    first_automation_public_id: AUTOMATION_PUBLIC_ID,
    ...overrides,
  };
}

describe('serializeContact', () => {
  it('maps every column to the Contact object, the account and automation by their public ids', () => {
    expect(serializeContact({ contact: buildRow(), now })).toEqual({
      id: 'con_p3k8w2m9x4r7n1v5a1b2c',
      channel_account_id: ACCOUNT_PUBLIC_ID,
      channel: 'instagram',
      instagram_user_id: '17841455500000001',
      username: 'jordan.lee',
      full_name: 'Jordan Lee',
      profile_picture_url: 'https://scontent.cdninstagram.com/v/jordan.jpg',
      followers_count: 812,
      is_following_account: true,
      follow_checked_at: '2026-11-21T09:06:20.000Z',
      email: 'jordan.lee+shop@example.com',
      email_collected_at: '2026-11-21T09:06:20.000Z',
      phone: '+15550100123',
      phone_collected_at: '2026-11-21T09:06:20.000Z',
      tags: ['giveaway', 'vip'],
      is_opted_out: false,
      opted_out_at: null,
      is_automations_paused: true,
      automations_paused_at: '2026-11-21T09:06:20.000Z',
      came_in_via: 'comment',
      came_in_ref: null,
      first_automation_id: AUTOMATION_PUBLIC_ID,
      first_seen_at: '2026-11-20T08:00:00.000Z',
      last_message_received_at: '2026-11-21T09:06:20.000Z',
      last_direct_message_received_at: '2026-11-21T09:06:20.000Z',
      last_message_sent_at: '2026-11-21T09:06:20.000Z',
      first_message_at: '2026-11-20T08:00:00.000Z',
      last_comment_at: '2026-11-21T09:06:20.000Z',
      comment_count: 3,
      last_story_activity_at: null,
      last_broadcast_at: null,
      is_chat_open: true,
      created_at: '2026-11-20T08:00:00.000Z',
      updated_at: '2026-11-21T09:06:20.000Z',
    });
  });

  it('closes the chat 15 minutes before 24 hours, and when she never wrote a DM', () => {
    const justBefore = new Date(lastMessage.getTime() + (24 * 60 - 16) * 60 * 1000);
    const justAfter = new Date(lastMessage.getTime() + (24 * 60 - 15) * 60 * 1000);
    expect(serializeContact({ contact: buildRow(), now: justBefore }).is_chat_open).toBe(true);
    expect(serializeContact({ contact: buildRow(), now: justAfter }).is_chat_open).toBe(false);
    expect(
      serializeContact({
        contact: buildRow({ last_direct_message_received_at: null }),
        now,
      }).is_chat_open,
    ).toBe(false);
  });

  it('never returns the internal ids, the note or deleted_at, and copies the tags', () => {
    const row = buildRow();
    const output = serializeContact({ contact: row, now });
    expect(output).not.toHaveProperty('organization_id');
    expect(output).not.toHaveProperty('deleted_at');
    expect(output).not.toHaveProperty('note');
    expect(output).not.toHaveProperty('automations_off_by_user_id');
    expect(Object.values(output)).not.toContain(row.id);
    expect(Object.values(output)).not.toContain(row.first_automation_id);
    expect(output.tags).not.toBe(row.tags);
  });
});

describe('serializeContactDetail', () => {
  it('adds the note, who paused her, the opening message, her first automation and open runs', () => {
    const output = serializeContactDetail({
      contact: { ...buildRow(), first_automation_name: 'Price reply', open_run_count: 2 },
      automations_paused_by_user_public_id: 'usr_k7x9m2pqr4w8n1v3a1b2c',
      now,
    });
    expect(output).toMatchObject({
      note: 'Asked about sizes',
      automations_paused_by_user_id: 'usr_k7x9m2pqr4w8n1v3a1b2c',
      last_opening_message_at: '2026-11-21T09:06:20.000Z',
      first_automation: { id: AUTOMATION_PUBLIC_ID, name: 'Price reply' },
      open_run_count: 2,
    });
  });

  it('shows no first automation once it is gone', () => {
    const output = serializeContactDetail({
      contact: {
        ...buildRow({ first_automation_public_id: null }),
        first_automation_name: null,
        open_run_count: 0,
      },
      automations_paused_by_user_public_id: null,
      now,
    });
    expect(output.first_automation).toBeNull();
    expect(output.automations_paused_by_user_id).toBeNull();
  });
});

describe('serializeContactTagCount', () => {
  it('names the tag and its count', () => {
    expect(serializeContactTagCount({ tag: 'vip', contact_count: 4 })).toEqual({
      tag: 'vip',
      contact_count: 4,
    });
  });
});
