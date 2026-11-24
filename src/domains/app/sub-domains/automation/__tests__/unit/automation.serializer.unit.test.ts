import { describe, expect, it } from 'vitest';
import { generatePublicId } from '@/shared/utils/identity/public-id.util.js';
import {
  buildAutomationLinkUrl,
  serializeAutomation,
  serializeAutomationListRow,
} from '@/domains/app/sub-domains/automation/automation.serializer.js';
import { sumAutomationCounts } from '@/domains/app/sub-domains/automation/automation-count.service.js';
import type { AutomationCountRow } from '@/domains/app/sub-domains/automation/automation-count.repository.js';

const CREATED_AT = new Date('2026-11-24T08:00:00.000Z');

/** One stored automation row as the serializer reads it. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    public_id: generatePublicId('automation'),
    channel: 'instagram',
    name: 'Guide',
    status: 'live',
    trigger_type: 'ref_link',
    also_start_from: [],
    target_scope: 'any',
    target_instagram_media_id: null,
    target_instagram_story_id: null,
    target_starts_at: null,
    target_ends_at: null,
    next_post_status: null,
    next_post_linked_at: null,
    keywords: [],
    ref_code: 'spring-event',
    starter_questions: [],
    ad_id: null,
    trigger_tag: null,
    default_reply_mode: null,
    is_public_reply_enabled: false,
    public_reply_texts: [],
    is_public_reply_mention_enabled: true,
    is_reply_like_person_enabled: false,
    public_reply_hour_limit: null,
    is_hide_comment_after_direct_message_enabled: false,
    steps: { messages: [{ kind: 'text' as const, wait_minutes: 0, text: 'Hi' }] },
    stopped_reason: null,
    stopped_at: null,
    cancelled_before_at: null,
    last_triggered_at: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

/** One slot row of `app.automation_counts`. */
function slot(overrides: Partial<AutomationCountRow>): AutomationCountRow {
  return {
    id: 1,
    organization_id: 1,
    automation_id: 7,
    slot: 0,
    runs_started: 0,
    taps: 0,
    typed_answers: 0,
    runs_by_version: {},
    taps_by_version: {},
    typed_by_version: {},
    updated_at: CREATED_AT,
    ...overrides,
  };
}

describe('automation serializer and counts (feat-instagram-dm-sending § 4.A.6, AU19)', () => {
  it('sums the 16 slots into totals, % tapped and per-version numbers (D61, AC-6.2)', () => {
    const counts = sumAutomationCounts([
      slot({ slot: 0, runs_started: 600, taps: 250, runs_by_version: { 'hello.1': 600 } }),
      slot({
        slot: 9,
        runs_started: 400,
        taps: 200,
        typed_answers: 60,
        taps_by_version: { 'hello.1': 200 },
      }),
      slot({ automation_id: 8, runs_started: 3 }),
    ]).get(7);
    expect(counts).toEqual({
      runs_started: 1000,
      taps: 450,
      typed_answers: 60,
      tapped_percent: 51,
      by_version: { 'hello.1': { runs_started: 600, taps: 200, typed_answers: 0 } },
    });
  });

  it('shapes the Automation: public ids, the ref link, zero counts before a run, the PRO parts off', () => {
    const output = serializeAutomation({
      automation: row(),
      channel_account_public_id: 'cha_x',
      created_by_user_public_id: null,
      updated_by_user_public_id: null,
      counts: undefined,
      pro_parts_off: ['email_ask'],
      username: 'acme.shop',
    });
    expect(output).toMatchObject({
      channel_account_id: 'cha_x',
      link_url: 'https://ig.me/m/acme.shop?ref=spring-event',
      counts: { runs_started: 0, tapped_percent: null, by_version: {} },
      pro_parts_off: ['email_ask'],
      open_backfill: null,
      created_at: CREATED_AT.toISOString(),
    });
    expect(Object.keys(output)).not.toContain('organization_id');
  });

  it('gives no ref link to another way to start or without a username', () => {
    expect(
      buildAutomationLinkUrl({ triggerType: 'comment', refCode: 'x', username: 'a' }),
    ).toBeNull();
    expect(
      buildAutomationLinkUrl({ triggerType: 'ref_link', refCode: 'x', username: null }),
    ).toBeNull();
  });

  it('shapes the list row with its runs and % tapped (AU10)', () => {
    expect(
      serializeAutomationListRow({
        automation: row({ status: 'draft' }),
        channel_account_public_id: 'cha_x',
        counts: { runs_started: 10, taps: 4, typed_answers: 1, tapped_percent: 50, by_version: {} },
      }),
    ).toMatchObject({
      status: 'draft',
      runs_started: 10,
      tapped_percent: 50,
      updated_at: CREATED_AT.toISOString(),
    });
  });
});
