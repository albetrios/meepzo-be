import { PLAN_STATE_CHECK_MINUTES } from '@/domains/billing/sub-domains/subscription/subscription.constants.js';

/**
 * Job name of the plan-state sweep — a repeatable job on the plan-state check queue
 * (`src/infrastructure/queue/scheduler.ts`), run by its worker. It lists the due subscriptions and
 * adds one check per subscription (routes-final § 8.B BL17, BLC10).
 */
export const SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_JOB_NAME = 'sweep-subscription-plan-states';

/** The sweep's cron: every {@link PLAN_STATE_CHECK_MINUTES} minutes (BL17). */
export const SUBSCRIPTION_PLAN_STATE_CHECK_CRON = `*/${PLAN_STATE_CHECK_MINUTES} * * * *`;

/** Subscriptions one sweep page reads (one short retention read per page, the adds after it). */
export const SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_PAGE_SIZE = 500;

/**
 * Most pages one sweep reads — 50 000 due subscriptions, the bound that keeps one sweep finite. A
 * sweep that reaches it logs `billing.plan_state_check.sweep_capped` at error; the rest are still
 * due at the next sweep.
 */
export const SUBSCRIPTION_PLAN_STATE_CHECK_SWEEP_MAX_PAGES = 100;

/** Where the billing notices link: the frontend's billing page. */
export const BILLING_FRONTEND_PATH = '/billing';
