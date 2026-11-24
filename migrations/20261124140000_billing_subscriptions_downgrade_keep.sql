-- Migration: billing_subscriptions_downgrade_keep
-- Created: 2026-11-24T14:00:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- The move down at the period end (iteration feat-instagram-dm-sending-2026-11-23-oxak, routes-final
-- § 8.B BL5, BL6, BL15, BLC8; P77). A new billing migration — no merged migration is edited.
--
--   scheduled_plan_id    → billing.plans (RESTRICT): the plan a move down goes to at the period end —
--                          the mirror of the Stripe subscription schedule's next phase (BLQ1 → P77)
--   scheduled_change_at  when it applies (the current period end); set exactly with scheduled_plan_id
--   downgrade_keep       the owner's pick of the channel accounts kept active after it: a JSON list of
--                          0–10 `cha_…` public ids (no key — the app's rows, P25 form); set only with a
--                          scheduled change
--
-- Three nullable columns with no default — metadata-only, no rewrite. Every existing row is NULL, so the
-- checks and the foreign key are added NOT VALID and validated at once (a no-op scan). The tenant policy
-- is unchanged: the new columns are not key columns. The indexes are the follow-up non-transactional
-- migration `billing_subscriptions_plan_state_indexes` (CREATE INDEX CONCURRENTLY).

ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_plan_id BIGINT;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_change_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  ADD COLUMN IF NOT EXISTS downgrade_keep JSONB;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  ADD CONSTRAINT subscriptions_scheduled_plan_id_plans_id_fk
  FOREIGN KEY (scheduled_plan_id) REFERENCES billing.plans (id) ON DELETE RESTRICT
  NOT VALID;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  VALIDATE CONSTRAINT subscriptions_scheduled_plan_id_plans_id_fk;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  ADD CONSTRAINT chk_subs_scheduled_change
  CHECK ((scheduled_plan_id IS NULL) = (scheduled_change_at IS NULL))
  NOT VALID;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  VALIDATE CONSTRAINT chk_subs_scheduled_change;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  ADD CONSTRAINT chk_subs_downgrade_keep
  CHECK (
    downgrade_keep IS NULL
    OR (
      scheduled_plan_id IS NOT NULL
      AND jsonb_typeof(downgrade_keep) = 'array'
      AND jsonb_array_length(downgrade_keep) <= 10
    )
  )
  NOT VALID;
--> statement-breakpoint

ALTER TABLE billing.subscriptions
  VALIDATE CONSTRAINT chk_subs_downgrade_keep;
