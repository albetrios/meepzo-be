/**
 * BullMQ worker queue families for split worker services and Postgres pool budgeting.
 * Comma-separated `WORKER_QUEUE_FAMILIES` selects which families a process runs.
 */
export const WORKER_QUEUE_FAMILY_NAMES = [
  'mail',
  'notify',
  'webhook',
  'stripe',
  'instagram',
  // feat-instagram-dm-sending SN2, SN24 (P91): the two send queues, run by the send service.
  'instagram-send',
  'retention',
  'observability',
] as const;

/** Union of the family tokens accepted in `WORKER_QUEUE_FAMILIES` env entries. */
export type WorkerQueueFamily = (typeof WORKER_QUEUE_FAMILY_NAMES)[number];

/** Special token in `WORKER_QUEUE_FAMILIES` that selects every family (monolithic worker). */
export const WORKER_QUEUE_FAMILIES_ALL_TOKEN = 'all';
