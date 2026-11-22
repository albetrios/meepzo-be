import { describe, expect, it } from 'vitest';
import type { AutomationRow } from '@/domains/app/sub-domains/automation/automation.repository.js';
import { serializeAutomation } from '@/domains/app/sub-domains/automation/automation.serializer.js';

/**
 * The automation object (routes-final § 3.A.6): every key named, the account's and the users'
 * public ids from the caller, timestamps as ISO 8601, the final message never null (D19) and its
 * links always an array — never an internal id or a soft-delete column.
 */

const createdAt = new Date('2026-11-21T08:00:00.000Z');

function automationRow(overrides: Partial<AutomationRow> = {}): AutomationRow {
  return {
    id: 17,
    public_id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
    organization_id: 7,
    instagram_account_id: 3,
    name: 'Comment for the link',
    status: 'live',
    trigger_type: 'comment',
    target_scope: 'next',
    target_instagram_media_id: '18030000000000004',
    target_instagram_story_id: null,
    next_post_starts_at: new Date('2026-11-20T00:00:00.000Z'),
    next_post_ends_at: new Date('2026-11-27T00:00:00.000Z'),
    next_post_status: 'linked',
    next_post_linked_at: new Date('2026-11-21T07:00:00.000Z'),
    is_dm_keyword_trigger_enabled: true,
    keywords: ['link', 'shop'],
    tags: ['launch'],
    is_public_reply_enabled: true,
    public_reply_texts: ['Check your DMs!'],
    is_opening_message_enabled: true,
    opening_message: { text: 'Thanks!', button_title: 'Send it' },
    is_follow_required: true,
    follow_request_message: {
      text: 'Follow first',
      following_button_title: "I'm following",
      profile_button_title: 'Open profile',
    },
    is_email_collection_enabled: true,
    email_request_message: null,
    is_phone_collection_enabled: false,
    phone_request_message: { text: 'Your number?' },
    final_message: {
      text: 'Here you go',
      links: [{ title: 'Shop', url: 'https://shop.example.com' }],
    },
    completed_run_count: 42,
    last_triggered_at: new Date('2026-11-21T09:00:00.000Z'),
    created_by_user_id: 5,
    updated_by_user_id: null,
    deleted_at: null,
    delete_reason: null,
    delete_note: null,
    created_at: createdAt,
    updated_at: new Date('2026-11-21T08:30:00.000Z'),
    ...overrides,
  };
}

describe('serializeAutomation', () => {
  it('maps every field of 3.A.6 with the resolved public ids', () => {
    expect(
      serializeAutomation({
        automation: automationRow(),
        instagram_account_public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
        created_by_user_public_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
        updated_by_user_public_id: null,
      }),
    ).toEqual({
      id: 'aut_m4q8x2k7p9r3t1v5a1b2c',
      instagram_account_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
      name: 'Comment for the link',
      status: 'live',
      trigger_type: 'comment',
      target_scope: 'next',
      target_instagram_media_id: '18030000000000004',
      target_instagram_story_id: null,
      next_post_starts_at: '2026-11-20T00:00:00.000Z',
      next_post_ends_at: '2026-11-27T00:00:00.000Z',
      next_post_status: 'linked',
      next_post_linked_at: '2026-11-21T07:00:00.000Z',
      is_dm_keyword_trigger_enabled: true,
      keywords: ['link', 'shop'],
      tags: ['launch'],
      is_public_reply_enabled: true,
      public_reply_texts: ['Check your DMs!'],
      is_opening_message_enabled: true,
      opening_message: { text: 'Thanks!', button_title: 'Send it' },
      is_follow_required: true,
      follow_request_message: {
        text: 'Follow first',
        following_button_title: "I'm following",
        profile_button_title: 'Open profile',
      },
      is_email_collection_enabled: true,
      email_request_message: null,
      is_phone_collection_enabled: false,
      phone_request_message: { text: 'Your number?' },
      final_message: {
        text: 'Here you go',
        links: [{ title: 'Shop', url: 'https://shop.example.com' }],
      },
      completed_run_count: 42,
      last_triggered_at: '2026-11-21T09:00:00.000Z',
      created_by_user_id: 'usr_a1b2c3d4e5f6g7h8i9j0k',
      updated_by_user_id: null,
      created_at: '2026-11-21T08:00:00.000Z',
      updated_at: '2026-11-21T08:30:00.000Z',
    });
  });

  it('never returns the internal ids or the soft-delete columns', () => {
    const output = serializeAutomation({
      automation: automationRow({
        deleted_at: createdAt,
        delete_reason: 'other',
        delete_note: 'x',
      }),
      instagram_account_public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
      created_by_user_public_id: null,
      updated_by_user_public_id: null,
    });
    for (const key of [
      'organization_id',
      'deleted_at',
      'delete_reason',
      'delete_note',
      'public_id',
    ]) {
      expect(output).not.toHaveProperty(key);
    }
    expect(output.instagram_account_id).toBe('iga_k7x9m2pqr4w8n1v3a1b2c');
  });

  it('shows empty messages and dates as null, and an opening message or links stored without their key in full', () => {
    const output = serializeAutomation({
      automation: automationRow({
        next_post_starts_at: null,
        next_post_ends_at: null,
        next_post_status: null,
        next_post_linked_at: null,
        last_triggered_at: null,
        opening_message: { text: 'Hi' } as never,
        follow_request_message: null,
        final_message: { text: 'Bye' } as never,
      }),
      instagram_account_public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
      created_by_user_public_id: null,
      updated_by_user_public_id: null,
    });
    expect(output.next_post_status).toBeNull();
    expect(output.last_triggered_at).toBeNull();
    expect(output.follow_request_message).toBeNull();
    expect(output.opening_message).toEqual({ text: 'Hi', button_title: null });
    expect(output.final_message).toEqual({ text: 'Bye', links: [] });
  });

  it('copies the arrays so the caller cannot change the row through them', () => {
    const row = automationRow();
    const output = serializeAutomation({
      automation: row,
      instagram_account_public_id: 'iga_k7x9m2pqr4w8n1v3a1b2c',
      created_by_user_public_id: null,
      updated_by_user_public_id: null,
    });
    output.keywords.push('changed');
    expect(row.keywords).toEqual(['link', 'shop']);
  });
});
