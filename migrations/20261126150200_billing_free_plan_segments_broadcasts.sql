-- Migration: billing_free_plan_segments_broadcasts
-- Created: 2026-11-26T15:02:00.000Z
-- Reference: docs/reference/data/migrations.md
--
-- Free turns its `broadcasts` and `segments` switches on (iteration change-plan-gates-2026-11-26-mfku,
-- routes-final § 2 PL1, PL2; decisions P13, P27), which closes oxak pending #12 in favour of "on Free".
-- The catalog rows were written once by 20261124060244_billing_flowdm_plans.sql and the seed inserts
-- with ON CONFLICT DO NOTHING, so the seed constant alone never reaches an existing database: this file
-- sets the two switches in the stored rows, and `FREE_PLAN_FEATURES` in the reference seed says the same.
--
-- The rows changed are Free and the three switched-off rows that carry Free's features (Starter, Growth,
-- Pro — P27, P80); Creator and Studio already have both switches on and are not touched. Every other
-- switch, the limits and `included_seats` stay. Forward-only and idempotent: a row that already has both
-- switches on is skipped, so a re-run changes nothing (not even `updated_at`). No event is emitted
-- (PL3): turning a switch on stops nothing, and the next plan read sees the new values.
--
-- billing.plans is FORCE RLS, so the update sits between NO FORCE and FORCE in this transactional file.

ALTER TABLE billing.plans NO FORCE ROW LEVEL SECURITY;

UPDATE billing.plans
SET
  features = jsonb_set(
    features,
    '{feature_switches}',
    (features -> 'feature_switches') || '{"broadcasts": true, "segments": true}'::jsonb
  ),
  updated_at = GREATEST(now(), created_at)
WHERE name IN ('Free', 'Starter', 'Growth', 'Pro')
  AND NOT (features -> 'feature_switches') @> '{"broadcasts": true, "segments": true}'::jsonb;

ALTER TABLE billing.plans FORCE ROW LEVEL SECURITY;
