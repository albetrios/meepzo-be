import { describe, expect, it } from 'vitest';
import { serializeContact } from '@/domains/app/sub-domains/contact/contact.serializer.js';
import type { ContactRow } from '@/domains/app/sub-domains/contact/contact.repository.js';

/** The contact object (routes-final § 2.6): every key named, never an internal id or `deleted_at`. */

const ACCOUNT_PUBLIC_ID = 'iga_k7x9m2pqr4w8n1v3a1b2c';
const firstSeen = new Date('2026-11-20T08:00:00.000Z');
const lastMessage = new Date('2026-11-21T09:06:20.000Z');

function buildRow(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: 41,
    public_id: 'con_p3k8w2m9x4r7n1v5a1b2c',
    organization_id: 7,
    instagram_account_id: 3,
    instagram_user_id: '17841455500000001',
    username: 'jordan.lee',
    full_name: 'Jordan Lee',
    profile_picture_url: 'https://scontent.cdninstagram.com/v/jordan.jpg',
    followers_count: 812,
    is_following_account: true,
    follow_checked_at: lastMessage,
    email: 'jordan.lee@example.com',
    email_collected_at: lastMessage,
    phone: '+15550100123',
    phone_collected_at: lastMessage,
    tags: ['giveaway', 'vip'],
    first_seen_at: firstSeen,
    last_message_received_at: lastMessage,
    last_direct_message_received_at: lastMessage,
    last_message_sent_at: lastMessage,
    deleted_at: null,
    created_at: firstSeen,
    updated_at: lastMessage,
    ...overrides,
  };
}

describe('serializeContact', () => {
  it('maps every column to the contact object, the account by its public id', () => {
    expect(
      serializeContact({ contact: buildRow(), instagram_account_public_id: ACCOUNT_PUBLIC_ID }),
    ).toEqual({
      id: 'con_p3k8w2m9x4r7n1v5a1b2c',
      instagram_account_id: ACCOUNT_PUBLIC_ID,
      instagram_user_id: '17841455500000001',
      username: 'jordan.lee',
      full_name: 'Jordan Lee',
      profile_picture_url: 'https://scontent.cdninstagram.com/v/jordan.jpg',
      followers_count: 812,
      is_following_account: true,
      follow_checked_at: '2026-11-21T09:06:20.000Z',
      email: 'jordan.lee@example.com',
      email_collected_at: '2026-11-21T09:06:20.000Z',
      phone: '+15550100123',
      phone_collected_at: '2026-11-21T09:06:20.000Z',
      tags: ['giveaway', 'vip'],
      first_seen_at: '2026-11-20T08:00:00.000Z',
      last_message_received_at: '2026-11-21T09:06:20.000Z',
      last_direct_message_received_at: '2026-11-21T09:06:20.000Z',
      last_message_sent_at: '2026-11-21T09:06:20.000Z',
      created_at: '2026-11-20T08:00:00.000Z',
      updated_at: '2026-11-21T09:06:20.000Z',
    });
  });

  it('keeps every unknown as null — a never-checked, never-read contact without email or phone', () => {
    const output = serializeContact({
      contact: buildRow({
        username: null,
        full_name: null,
        profile_picture_url: null,
        followers_count: null,
        is_following_account: null,
        follow_checked_at: null,
        email: null,
        email_collected_at: null,
        phone: null,
        phone_collected_at: null,
        tags: [],
        last_direct_message_received_at: null,
        last_message_sent_at: null,
      }),
      instagram_account_public_id: ACCOUNT_PUBLIC_ID,
    });
    expect(output).toMatchObject({
      username: null,
      full_name: null,
      profile_picture_url: null,
      followers_count: null,
      is_following_account: null,
      follow_checked_at: null,
      email: null,
      email_collected_at: null,
      phone: null,
      phone_collected_at: null,
      tags: [],
      last_direct_message_received_at: null,
      last_message_sent_at: null,
    });
    // Never null (CT10).
    expect(output.last_message_received_at).toBe('2026-11-21T09:06:20.000Z');
  });

  it('never returns the internal ids or deleted_at, and copies the tags', () => {
    const row = buildRow();
    const output = serializeContact({
      contact: row,
      instagram_account_public_id: ACCOUNT_PUBLIC_ID,
    });
    expect(output).not.toHaveProperty('organization_id');
    expect(output).not.toHaveProperty('deleted_at');
    expect(output).not.toHaveProperty('public_id');
    expect(Object.values(output)).not.toContain(row.id);
    expect(Object.values(output)).not.toContain(row.instagram_account_id);
    expect(output.tags).not.toBe(row.tags);
  });
});
