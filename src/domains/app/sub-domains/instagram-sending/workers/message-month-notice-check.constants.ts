/** The every-minute backup check of the month notices (WC-56), on the intake queue (no payload). */
export const MESSAGE_MONTH_NOTICE_CHECK_JOB_NAME = 'check-month-limit-notices';

/** The check looks at the organizations whose month count moved in the last this many minutes. */
export const MESSAGE_MONTH_NOTICE_CHECK_LOOKBACK_MINUTES = 5;

/** The check's time budget per run, in milliseconds (P94: 40 s of the minute). */
export const MESSAGE_MONTH_NOTICE_CHECK_BUDGET_MILLISECONDS = 40_000;
