import {
  AUTOMATION_RUN_KEEP_DAYS,
  AUTOMATION_RUN_PART_DROP_AFTER_DAYS,
} from '@/domains/app/sub-domains/automation/automation-run/automation-run.constants.js';
import {
  INSTAGRAM_MESSAGE_KEEP_DAYS,
  INSTAGRAM_SEND_ATTEMPT_KEEP_DAYS,
} from '@/domains/app/sub-domains/instagram-sending/instagram-outgoing-message/instagram-outgoing-message.constants.js';
import { INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS } from '@/shared/constants/instagram.constants.js';
import { INSTAGRAM_CONVERSATION_MESSAGE_KEEP_DAYS } from '@/domains/app/sub-domains/instagram-conversation/instagram-conversation-message/instagram-conversation-message.constants.js';

/**
 * BullMQ queue name of the shared partition upkeep (feat-instagram-dm-sending WC-55, WHC13) —
 * repeatable schedules: `src/infrastructure/queue/scheduler.ts`.
 */
export const APP_PARTITION_UPKEEP_QUEUE_NAME = 'app-partition-upkeep';

/** Job name of the daily (and at-worker-start) run that makes the coming parts (WC-55). */
export const APP_PARTITION_UPKEEP_MAKE_JOB_NAME = 'make-app-partitions';

/** Job name of the hourly run that makes the coming parts and drops the expired ones (WC-48–WC-52, P92). */
export const APP_PARTITION_UPKEEP_DROP_JOB_NAME = 'drop-expired-app-partitions';

/**
 * Days ahead whose parts are made (S17, P97): at least 14 — the database function refuses fewer.
 */
export const APP_PARTITION_MAKE_AHEAD_DAYS = 14;

/** Fewer ready days ahead than this alerts the team (S17: "alert below 7"). */
export const APP_PARTITION_READY_ALERT_DAYS = 7;

/**
 * The oldest kept part past its drop time by more than this alerts the team (P92: "alerts after 1
 * day"), in seconds.
 */
export const APP_PARTITION_OVERDUE_ALERT_SECONDS = 24 * 60 * 60;

/** One time-split table the upkeep keeps: its parent and how many days after a part ends it goes. */
export type AppPartitionUpkeepSpec = {
  /** The `app` parent, schema-qualified — one of the eight the database function accepts. */
  readonly table: string;
  /** Days after the end of a part's range that the part is dropped. */
  readonly keepDays: number;
};

/**
 * The eight time-split tables (P33, P96; the conversation messages since feat-instagram-inbox R3) in the order the upkeep visits them. The order matters
 * for the drops: the rows that point into a runs part (messages, run events) are gone before it is
 * detached, so their foreign keys never block a drop (AU36 (5): "the messages' parts always go
 * first").
 *
 * @remarks
 * Keep times: webhook events and their keys 8 days (WC-48, D15), send attempts 8 days (WC-49),
 * messages 30 days after their week (WC-50, P13), comment logs 90 days after their month (WC-52),
 * conversation messages 365 days after their month (I-D5),
 * run events and runs 98 days after their month — 90 days after the last run in it can have ended
 * (WC-51, AU36). The part unit (day, week, month) is the table's own, fixed in the function.
 */
export const APP_PARTITION_UPKEEP_SPECS: readonly AppPartitionUpkeepSpec[] = [
  { table: 'app.instagram_webhook_events', keepDays: INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS },
  { table: 'app.instagram_webhook_event_keys', keepDays: INSTAGRAM_WEBHOOK_EVENT_KEEP_DAYS },
  { table: 'app.instagram_send_attempts', keepDays: INSTAGRAM_SEND_ATTEMPT_KEEP_DAYS },
  { table: 'app.instagram_outgoing_messages', keepDays: INSTAGRAM_MESSAGE_KEEP_DAYS },
  { table: 'app.automation_comment_logs', keepDays: AUTOMATION_RUN_KEEP_DAYS },
  {
    table: 'app.instagram_conversation_messages',
    keepDays: INSTAGRAM_CONVERSATION_MESSAGE_KEEP_DAYS,
  },
  { table: 'app.automation_run_events', keepDays: AUTOMATION_RUN_PART_DROP_AFTER_DAYS },
  { table: 'app.automation_runs', keepDays: AUTOMATION_RUN_PART_DROP_AFTER_DAYS },
];
