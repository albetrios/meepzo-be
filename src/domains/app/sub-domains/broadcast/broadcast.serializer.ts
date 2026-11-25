import type { SegmentConditions } from '@/domains/app/sub-domains/broadcast/broadcast-segment/broadcast-segment.dto.js';
import type { BroadcastMessages } from './broadcast.dto.js';
import type { BroadcastOutput } from './broadcast.types.js';

/** The columns the Broadcast object reads: the row and the public ids of what it names. */
export interface BroadcastSerializableRow {
  public_id: string;
  name: string;
  status: string;
  mode: string;
  conditions: SegmentConditions | null;
  messages: BroadcastMessages;
  scheduled_at: Date | null;
  ends_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  matched: number;
  sent: number;
  skipped: number;
  failed: number;
  replies: number;
  taps: number;
  created_at: Date;
  updated_at: Date;
  /** `cha_…` of its account. */
  channel_account_public_id: string;
  /** `seg_…` of its saved audience, or `null`. */
  segment_public_id: string | null;
  /** `aut_…` of the automation its button starts, or `null`. */
  start_automation_public_id: string | null;
}

/** An instant as ISO 8601, or `null`. */
function instantOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/**
 * The Broadcast object (routes-final § 7.A.6): public ids only — never the internal ids, the editor
 * or `deleted_at`; the six numbers grouped in `numbers`.
 */
export function serializeBroadcast({
  broadcast,
  created_by_user_public_id,
}: {
  broadcast: BroadcastSerializableRow;
  /** `usr_…` of who made it, or `null`. */
  created_by_user_public_id: string | null;
}): BroadcastOutput {
  return {
    id: broadcast.public_id,
    channel_account_id: broadcast.channel_account_public_id,
    name: broadcast.name,
    status: broadcast.status,
    mode: broadcast.mode,
    segment_id: broadcast.segment_public_id,
    conditions: broadcast.conditions,
    messages: broadcast.messages,
    start_automation_id: broadcast.start_automation_public_id,
    scheduled_at: instantOrNull(broadcast.scheduled_at),
    ends_at: instantOrNull(broadcast.ends_at),
    started_at: instantOrNull(broadcast.started_at),
    finished_at: instantOrNull(broadcast.finished_at),
    cancelled_at: instantOrNull(broadcast.cancelled_at),
    cancel_reason: broadcast.cancel_reason,
    numbers: {
      matched: broadcast.matched,
      sent: broadcast.sent,
      skipped: broadcast.skipped,
      failed: broadcast.failed,
      replies: broadcast.replies,
      taps: broadcast.taps,
    },
    created_by_user_id: created_by_user_public_id,
    created_at: broadcast.created_at.toISOString(),
    updated_at: broadcast.updated_at.toISOString(),
  };
}
