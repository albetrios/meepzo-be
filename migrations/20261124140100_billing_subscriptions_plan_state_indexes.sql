-- migration-transaction: none reason="CREATE INDEX CONCURRENTLY cannot run in a transaction"
-- Migration: billing_subscriptions_plan_state_indexes
-- Created: 2026-11-24T14:01:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- The indexes of routes-final § 8.B.3 on billing.subscriptions (iteration
-- feat-instagram-dm-sending-2026-11-23-oxak, BL7, BL17, BLQ1):
--
--   idx_subscriptions_org_trialled       (organization_id) WHERE trial_end IS NOT NULL — "the organization
--                                         had a trial" (route 102's `trial_already_used`, BL7)
--   idx_subscriptions_trialing_trial_end (trial_end) WHERE status = 'TRIALING' — the plan-state check's
--                                         trial notices (WC-59, ROUTE row R52)
--   idx_subscriptions_dunning_period_end (current_period_end) WHERE status IN ('PAST_DUE', 'UNPAID') —
--                                         the plan-state check's grace sweep (WC-59, R52)
--   idx_subscriptions_scheduled_plan     (scheduled_plan_id) WHERE scheduled_plan_id IS NOT NULL — the
--                                         foreign key of `billing_subscriptions_downgrade_keep`
--
-- Built CONCURRENTLY (no write lock on a live table); idempotent through IF NOT EXISTS.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_org_trialled
  ON billing.subscriptions (organization_id)
  WHERE trial_end IS NOT NULL;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_trialing_trial_end
  ON billing.subscriptions (trial_end)
  WHERE status = 'TRIALING';
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_dunning_period_end
  ON billing.subscriptions (current_period_end)
  WHERE status IN ('PAST_DUE', 'UNPAID');
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_scheduled_plan
  ON billing.subscriptions (scheduled_plan_id)
  WHERE scheduled_plan_id IS NOT NULL;
